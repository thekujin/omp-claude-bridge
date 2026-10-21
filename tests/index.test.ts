import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import registerExtension from "../src/index.js";
import { PROVIDER_ID } from "../src/convert.js";
import type { BridgeRuntime } from "../src/runtime.js";

interface FakePi {
  providers: Array<{ id: string; config: Record<string, unknown> }>;
  tools: Array<{ name: string; [k: string]: unknown }>;
  commands: Array<{ name: string; [k: string]: unknown }>;
  handlers: Record<string, (...args: unknown[]) => unknown>;
  api: unknown;
}

function makeFakePi(): FakePi {
  const providers: FakePi["providers"] = [];
  const tools: FakePi["tools"] = [];
  const commands: FakePi["commands"] = [];
  const handlers: FakePi["handlers"] = {};
  const api = {
    registerProvider: (id: string, config: Record<string, unknown>) =>
      providers.push({ id, config }),
    registerTool: (def: { name: string }) => tools.push(def),
    registerCommand: (name: string, def: Record<string, unknown>) =>
      commands.push({ name, ...def }),
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      handlers[event] = handler;
    },
  };
  return { providers, tools, commands, handlers, api };
}

function load(pi: FakePi): BridgeRuntime {
  // The extension entry casts its own fake-tolerant boundary; cast here too.
  return registerExtension(pi.api as never) as unknown as BridgeRuntime;
}

let home: string;
let cwd: string;
let prevHome: string | undefined;
let prevCwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cb-home-"));
  cwd = mkdtempSync(join(tmpdir(), "cb-cwd-"));
  prevHome = process.env.HOME;
  process.env.HOME = home;
  prevCwd = process.cwd();
  process.chdir(cwd);
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  process.chdir(prevCwd);
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("extension registration", () => {
  test("registers the provider on every load (clear-then-flush safe)", () => {
    const pi1 = makeFakePi();
    load(pi1);
    const pi2 = makeFakePi();
    load(pi2);

    expect(pi1.providers).toHaveLength(1);
    expect(pi2.providers).toHaveLength(1);

    for (const pi of [pi1, pi2]) {
      const entry = pi.providers[0];
      expect(entry.id).toBe(PROVIDER_ID);
      expect(entry.config.api).toBe("claude-bridge");
      expect(typeof entry.config.streamSimple).toBe("function");
      const usage = entry.config.usage as {
        id: string;
        validatesCredentials: boolean;
        fetchUsage: unknown;
      };
      expect(usage.id).toBe(PROVIDER_ID);
      expect(usage.validatesCredentials).toBe(false);
      expect(typeof usage.fetchUsage).toBe("function");
      expect(Array.isArray(entry.config.models)).toBe(true);
      expect((entry.config.models as unknown[]).length).toBeGreaterThan(0);
    }
  });

  test("wires the session lifecycle handlers", () => {
    const pi = makeFakePi();
    load(pi);
    expect(typeof pi.handlers.session_start).toBe("function");
    expect(typeof pi.handlers.session_shutdown).toBe("function");
    expect(typeof pi.handlers.session_compact).toBe("function");
    expect(typeof pi.handlers.session_tree).toBe("function");
    expect(typeof pi.handlers.session_stop).toBe("function");
  });

  test.each(["print", "json", "tui"])(
    "session_stop invalidates bridge usage and awaits reports in %s mode",
    async (mode) => {
      const pi = makeFakePi();
      load(pi);
      const calls: string[] = [];
      const report = Promise.withResolvers<void>();
      const pending = Promise.resolve(pi.handlers.session_stop({}, {
        mode,
        model: { provider: PROVIDER_ID },
        modelRegistry: { authStorage: { usage: {
          invalidate(provider: string) { calls.push(`invalidate:${provider}`); },
          reports() { calls.push("reports"); return report.promise; },
        } } },
      }));
      let finished = false;
      void pending.then(() => { finished = true; });
      await Promise.resolve();
      expect(calls).toEqual([`invalidate:${PROVIDER_ID}`, "reports"]);
      expect(finished).toBe(false);
      report.resolve();
      await pending;
      expect(finished).toBe(true);
    },
  );

  test.each([{ provider: "anthropic" }, undefined])(
    "session_stop skips usage refresh for a non-bridge or absent model",
    async (model) => {
      const pi = makeFakePi();
      load(pi);
      // No registry is needed when the selected model is not the bridge.
      await pi.handlers.session_stop({}, { model });
    },
  );

  test.each(["invalidate", "reports"])(
    "session_stop contains a usage %s failure",
    async (failingMethod) => {
      const pi = makeFakePi();
      load(pi);
      const pending = pi.handlers.session_stop({}, {
        model: { provider: PROVIDER_ID },
        modelRegistry: { authStorage: { usage: {
          invalidate() {
            if (failingMethod === "invalidate") throw new Error("usage unavailable");
          },
          async reports() { throw new Error("usage unavailable"); },
        } } },
      });
      expect(await pending).toBeUndefined();
    },
  );

  test("session_start caches the system prompt, sets ui, clears the store", () => {
    const pi = makeFakePi();
    const runtime = load(pi);
    const ui = { notify: () => {} } as unknown as BridgeRuntime["ui"];
    const ctx = {
      ui,
      getSystemPrompt: () => ["part one", "part two"],
    };
    pi.handlers.session_start({}, ctx);

    expect(runtime.ui).toBe(ui);
    expect(runtime.cachedSystemPrompt).toEqual(["part one", "part two"]);
    expect(runtime.sessions.current).toBeNull();
  });

  test("session_compact / session_tree mark the active session for rebuild", () => {
    const pi = makeFakePi();
    const runtime = load(pi);
    runtime.sessions.commit("sess-1234", 3, cwd);
    expect(runtime.sessions.current?.needsRebuild).toBeFalsy();

    pi.handlers.session_compact({});
    expect(runtime.sessions.current?.needsRebuild).toBe(true);

    runtime.sessions.commit("sess-1234", 3, cwd);
    pi.handlers.session_tree({});
    expect(runtime.sessions.current?.needsRebuild).toBe(true);
  });

  test("registers only the provider, with no tools or commands", () => {
    const pi = makeFakePi();
    load(pi);
    expect(pi.providers).toHaveLength(1);
    expect(pi.tools).toHaveLength(0);
    expect(pi.commands).toHaveLength(0);
  });
});
