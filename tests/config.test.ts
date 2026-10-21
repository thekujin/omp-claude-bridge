import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadConfig, tryParseJson } from "../src/config.js";

let fakeHome: string;
let projectDir: string;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "cb-home-"));
  projectDir = mkdtempSync(join(tmpdir(), "cb-proj-"));
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

function writeGlobalConfig(config: unknown) {
  const dir = join(fakeHome, ".omp", "agent");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "claude-bridge.json"), JSON.stringify(config));
}

function writeProjectConfig(config: unknown) {
  const dir = join(projectDir, ".omp");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "claude-bridge.json"), JSON.stringify(config));
}

describe("loadConfig", () => {
  test("returns empty sections when no files exist", () => {
    expect(loadConfig(projectDir, fakeHome)).toEqual({ provider: {} });
  });

  test("reads the global config", () => {
    writeGlobalConfig({
      provider: { plan: "max" },
    });
    const config = loadConfig(projectDir, fakeHome);
    expect(config.provider?.plan).toBe("max");
  });

  test("project config overrides global per key, keeping the rest", () => {
    writeGlobalConfig({
      provider: { plan: "max", longContextExtraUsage: true },
    });
    writeProjectConfig({ provider: { plan: "pro" } });
    const config = loadConfig(projectDir, fakeHome);
    expect(config.provider?.plan).toBe("pro");
    expect(config.provider?.longContextExtraUsage).toBe(true);
  });
});

describe("tryParseJson", () => {
  test("returns {} for missing or malformed files", () => {
    expect(tryParseJson(join(projectDir, "nope.json"))).toEqual({});
    const bad = join(projectDir, "bad.json");
    writeFileSync(bad, "{not json");
    expect(tryParseJson(bad)).toEqual({});
  });
});
