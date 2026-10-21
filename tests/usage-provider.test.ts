import { describe, expect, test } from "bun:test";
import type { SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import { createRuntime, type QueryFn } from "../src/runtime.js";
import { createUsageProvider, toUsageReport } from "../src/usage-provider.js";

function payload(
  rate_limits: SDKControlGetUsageResponse["rate_limits"] = {
    five_hour: { utilization: 25, resets_at: "2026-10-21T12:00:00Z" },
    seven_day: { utilization: 85, resets_at: "2026-10-27T12:00:00Z" },
  },
): SDKControlGetUsageResponse {
  return { rate_limits_available: true, rate_limits } as SDKControlGetUsageResponse;
}

function mockProvider(
  getUsage: () => Promise<SDKControlGetUsageResponse> = async () => payload(),
) {
  const runtime = createRuntime();
  const calls: Parameters<QueryFn>[0][] = [];
  const usageCalls: unknown[] = [];
  const prompts: Promise<unknown[]>[] = [];
  let closeCalls = 0;
  runtime.queryFn = ((args: Parameters<QueryFn>[0]) => {
    calls.push(args);
    prompts.push((async () => {
      const messages: unknown[] = [];
      if (typeof args.prompt === "string") messages.push(args.prompt);
      else for await (const message of args.prompt) messages.push(message);
      return messages;
    })());
    return {
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(options: unknown) {
        usageCalls.push(options);
        return getUsage();
      },
      close() { closeCalls++; },
    } as unknown as ReturnType<QueryFn>;
  }) as QueryFn;
  return {
    runtime,
    provider: createUsageProvider(runtime),
    calls,
    usageCalls,
    prompts,
    get closeCalls() { return closeCalls; },
  };
}

describe("toUsageReport", () => {
  test("maps both percentage windows with stable provider, scope, and duration", () => {
    const before = Date.now();
    const report = toUsageReport(payload(), "account-123");
    expect(report).not.toBeNull();
    expect(report!.provider).toBe("claude-bridge");
    expect(report!.fetchedAt).toBeGreaterThanOrEqual(before);
    expect(report!.fetchedAt).toBeLessThanOrEqual(Date.now());
    expect(report!.limits).toEqual([
      {
        id: "claude-bridge:5h",
        label: "5 Hour",
        scope: { provider: "claude-bridge", accountId: "account-123", windowId: "5h" },
        amount: { usedFraction: 0.25, unit: "percent" },
        window: {
          id: "5h", label: "5 Hour", durationMs: 18_000_000,
          resetsAt: Date.parse("2026-10-21T12:00:00Z"),
        },
        status: "ok",
      },
      {
        id: "claude-bridge:7d",
        label: "7 Day",
        scope: { provider: "claude-bridge", accountId: "account-123", windowId: "7d" },
        amount: { usedFraction: 0.85, unit: "percent" },
        window: {
          id: "7d", label: "7 Day", durationMs: 604_800_000,
          resetsAt: Date.parse("2026-10-27T12:00:00Z"),
        },
        status: "warning",
      },
    ]);
  });

  test("omits an absent account and invalid or missing reset timestamps", () => {
    const report = toUsageReport(payload({
      five_hour: { utilization: 0, resets_at: "not a timestamp" },
      seven_day: { utilization: 0, resets_at: null },
    }))!;
    for (const limit of report.limits) {
      expect(limit.scope).not.toHaveProperty("accountId");
      expect(limit.window).not.toHaveProperty("resetsAt");
      expect(limit.amount.usedFraction).toBe(0);
    }
  });

  test("parses reset timestamps with timezone offsets", () => {
    const report = toUsageReport(payload({
      five_hour: { utilization: 1, resets_at: "2026-10-21T15:00:00+03:00" },
    }))!;
    expect(report.limits[0]!.window.resetsAt).toBe(Date.UTC(2026, 9, 21, 12));
  });

  test.each([
    [79, "ok"], [80, "warning"], [99, "warning"],
    [100, "exhausted"], [110, "exhausted"],
  ] as const)("maps %s percent to %s without capping usage", (utilization, status) => {
    const report = toUsageReport(payload({ five_hour: { utilization, resets_at: null } }))!;
    expect(report.limits[0]!.amount.usedFraction).toBe(utilization / 100);
    expect(report.limits[0]!.status).toBe(status);
  });

  test("returns null for unavailable, missing, or empty limits", () => {
    expect(toUsageReport({ ...payload(), rate_limits_available: false })).toBeNull();
    expect(toUsageReport(payload(null))).toBeNull();
    expect(toUsageReport({ rate_limits_available: true } as SDKControlGetUsageResponse)).toBeNull();
    expect(toUsageReport(payload({}))).toBeNull();
  });

  test.each([null, undefined, NaN, Infinity, -Infinity])(
    "skips a window with invalid utilization %s while preserving the other window",
    (utilization) => {
      const report = toUsageReport(payload({
        five_hour: { utilization, resets_at: null },
        seven_day: { utilization: 50, resets_at: null },
      } as SDKControlGetUsageResponse["rate_limits"]))!;
      expect(report.limits.map((limit) => limit.id)).toEqual(["claude-bridge:7d"]);
      expect(toUsageReport(payload({
        five_hour: { utilization, resets_at: null },
      } as SDKControlGetUsageResponse["rate_limits"]))).toBeNull();
    },
  );

  test("skips null windows", () => {
    expect(toUsageReport(payload({ five_hour: null, seven_day: null }))).toBeNull();
  });
});

describe("createUsageProvider", () => {
  test("uses a promptless query, configured executable, and skipBehaviors then closes it", async () => {
    const mock = mockProvider();
    mock.runtime.providerSettings.pathToClaudeCodeExecutable = "/configured/claude";
    expect(mock.provider.id).toBe("claude-bridge");
    expect(mock.provider.validatesCredentials).toBe(false);
    const report = await mock.provider.fetchUsage({ credential: { accountId: "account-123" } }, {});
    expect(report!.limits[0]!.scope.accountId).toBe("account-123");
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.options).toMatchObject({
      cwd: process.cwd(), pathToClaudeCodeExecutable: "/configured/claude",
    });
    expect(mock.calls[0]!.options!.abortController).toBeInstanceOf(AbortController);
    expect(typeof mock.calls[0]!.prompt).not.toBe("string");
    expect(mock.usageCalls).toEqual([{ skipBehaviors: true }]);
    expect(mock.closeCalls).toBe(1);
    expect(await mock.prompts[0]).toEqual([]);
  });

  test("enables the usage endpoint without changing the parent environment", async () => {
    const previousFlag = process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
    const previousMarker = process.env.CLAUDE_BRIDGE_USAGE_TEST;
    process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    process.env.CLAUDE_BRIDGE_USAGE_TEST = "preserved";
    try {
      const mock = mockProvider();
      await mock.provider.fetchUsage({}, {});
      const env = mock.calls[0]!.options!.env!;
      expect(env).not.toBe(process.env);
      expect(env).not.toHaveProperty("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC");
      expect(env.CLAUDE_BRIDGE_USAGE_TEST).toBe("preserved");
      expect(process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
    } finally {
      if (previousFlag === undefined) delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
      else process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = previousFlag;
      if (previousMarker === undefined) delete process.env.CLAUDE_BRIDGE_USAGE_TEST;
      else process.env.CLAUDE_BRIDGE_USAGE_TEST = previousMarker;
    }
  });

  test("returns null and releases the empty prompt after an SDK failure", async () => {
    const mock = mockProvider(async () => { throw new Error("usage unavailable"); });
    expect(await mock.provider.fetchUsage({}, {})).toBeNull();
    expect(mock.closeCalls).toBe(1);
    expect(await mock.prompts[0]).toEqual([]);
    expect(mock.calls[0]!.options).not.toHaveProperty("pathToClaudeCodeExecutable");
  });

  test("returns null when query creation fails", async () => {
    const runtime = createRuntime();
    runtime.queryFn = (() => { throw new Error("query unavailable"); }) as QueryFn;
    expect(await createUsageProvider(runtime).fetchUsage({}, {})).toBeNull();
  });

  test("does not create a query for a pre-aborted signal", async () => {
    const mock = mockProvider();
    const controller = new AbortController();
    controller.abort();
    expect(await mock.provider.fetchUsage({ signal: controller.signal }, {})).toBeNull();
    expect(mock.calls).toHaveLength(0);
    expect(mock.closeCalls).toBe(0);
  });

  test("keeps the prompt empty in flight and closes and releases it on abort", async () => {
    const mock = mockProvider(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = mock.provider.fetchUsage({ signal: controller.signal }, {});
    expect(mock.calls).toHaveLength(1);
    let promptFinished = false;
    const prompt = mock.prompts[0]!.then((messages) => {
      promptFinished = true;
      return messages;
    });
    await Promise.resolve();
    expect(promptFinished).toBe(false);
    controller.abort();
    expect(await pending).toBeNull();
    expect(mock.closeCalls).toBe(1);
    expect(mock.calls[0]!.options!.abortController!.signal.aborted).toBe(true);
    expect(await prompt).toEqual([]);
  });

  test("uses independent queries for concurrent requests", async () => {
    const responses = [
      Promise.withResolvers<SDKControlGetUsageResponse>(),
      Promise.withResolvers<SDKControlGetUsageResponse>(),
    ];
    let next = 0;
    const mock = mockProvider(() => responses[next++]!.promise);
    const first = mock.provider.fetchUsage({ credential: { accountId: "first" } }, {});
    const second = mock.provider.fetchUsage({ credential: { accountId: "second" } }, {});
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[0]!.options!.abortController).not.toBe(mock.calls[1]!.options!.abortController);
    responses[0]!.resolve(payload());
    expect((await first)!.limits[0]!.scope.accountId).toBe("first");
    expect(mock.closeCalls).toBe(1);
    responses[1]!.resolve(payload());
    expect((await second)!.limits[0]!.scope.accountId).toBe("second");
    expect(mock.closeCalls).toBe(2);
    expect(await Promise.all(mock.prompts)).toEqual([[], []]);
  });
});
