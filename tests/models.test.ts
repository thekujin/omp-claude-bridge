import { describe, expect, test } from "bun:test";
import {
  MODELS,
  applyLongContext,
  claudeCodeModelId,
  resolveClaudeCodeRuntimeModel,
  resolveModel,
} from "../src/models.js";

const PRO = { plan: "pro" as const, longContextExtraUsage: false };
const MAX = { plan: "max" as const, longContextExtraUsage: false };
const PRO_EXTRA = { plan: "pro" as const, longContextExtraUsage: true };

describe("resolveModel", () => {
  test("matches exact ids", () => {
    expect(resolveModel(MODELS, "claude-haiku-4-5")?.id).toBe("claude-haiku-4-5");
  });

  test("partial match returns the first model in display order", () => {
    expect(resolveModel(MODELS, "opus")?.id).toBe("claude-opus-5-5");
    expect(resolveModel(MODELS, "sonnet")?.id).toBe("claude-sonnet-5-5");
  });

  test("is case-insensitive and returns undefined on miss", () => {
    expect(resolveModel(MODELS, "HAIKU")?.id).toBe("claude-haiku-5-5");
    expect(resolveModel(MODELS, "gpt-4")).toBeUndefined();
  });
});

describe("Claude 5.5 models", () => {
  const models55 = [
    {
      id: "claude-haiku-5-5",
      name: "Claude Haiku 5.5",
      reasoning: false,
      cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.2 },
    },
    {
      id: "claude-sonnet-5-5",
      name: "Claude Sonnet 5.5",
      reasoning: true,
      cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    },
    {
      id: "claude-opus-5-5",
      name: "Claude Opus 5.5",
      reasoning: true,
      cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
    },
  ];

  test("registers the exact IDs and catalog metadata", () => {
    for (const model of models55) {
      expect(MODELS.filter((m) => m.id === model.id)).toHaveLength(1);
      expect(resolveModel(MODELS, model.id)).toMatchObject({
        ...model,
        input: ["text", "image"],
        contextWindow: 1_000_000,
        maxTokens: 65_536,
      });
    }
  });

  test("uses bare CLI IDs and registers 1M context regardless of plan", () => {
    for (const settings of [PRO, MAX, PRO_EXTRA]) {
      const registered = applyLongContext(MODELS, settings);
      for (const model of models55) {
        expect(resolveClaudeCodeRuntimeModel(model.id, settings)).toEqual({
          cliModelId: model.id,
          contextWindow: 1_000_000,
        });
        expect(claudeCodeModelId(model, settings)).toBe(model.id);
        expect(registered.find((m) => m.id === model.id)).toMatchObject({
          name: `${model.name} 1M`,
          contextWindow: 1_000_000,
        });
      }
    }
  });
});

// Pins the runtime context policy, including measured behavior for older models
// that differs from the catalog's advertised contextWindow (see models.ts).
describe("resolveClaudeCodeRuntimeModel", () => {
  test("bare opus-4-7 serves 1M; opus-5 and opus-4-8 need the [1m] suffix", () => {
    expect(resolveClaudeCodeRuntimeModel("claude-opus-5", PRO)).toEqual({
      cliModelId: "claude-opus-5[1m]",
      contextWindow: 1_000_000,
    });
    expect(resolveClaudeCodeRuntimeModel("claude-opus-4-7", PRO)).toEqual({
      cliModelId: "claude-opus-4-7",
      contextWindow: 1_000_000,
    });
    expect(resolveClaudeCodeRuntimeModel("claude-opus-4-8", PRO)).toEqual({
      cliModelId: "claude-opus-4-8[1m]",
      contextWindow: 1_000_000,
    });
  });

  test("opus-4-6 1M is gated by plan or extra usage", () => {
    expect(resolveClaudeCodeRuntimeModel("claude-opus-4-6", PRO)).toEqual({
      cliModelId: "claude-opus-4-6",
      contextWindow: 200_000,
    });
    expect(resolveClaudeCodeRuntimeModel("claude-opus-4-6", MAX).cliModelId).toBe(
      "claude-opus-4-6[1m]",
    );
    expect(
      resolveClaudeCodeRuntimeModel("claude-opus-4-6", PRO_EXTRA).cliModelId,
    ).toBe("claude-opus-4-6[1m]");
  });

  test("sonnet-4-6 1M is gated by extra usage only", () => {
    expect(
      resolveClaudeCodeRuntimeModel("claude-sonnet-4-6", MAX).contextWindow,
    ).toBe(200_000);
    expect(
      resolveClaudeCodeRuntimeModel("claude-sonnet-4-6", PRO_EXTRA).cliModelId,
    ).toBe("claude-sonnet-4-6[1m]");
  });

  test("haiku-4-5 stays at 200K; unknown models default to 200K passthrough", () => {
    expect(resolveClaudeCodeRuntimeModel("claude-haiku-4-5", MAX)).toEqual({
      cliModelId: "claude-haiku-4-5",
      contextWindow: 200_000,
    });
    expect(resolveClaudeCodeRuntimeModel("mystery-model", PRO)).toEqual({
      cliModelId: "mystery-model",
      contextWindow: 200_000,
    });
  });
});

describe("claudeCodeModelId", () => {
  test("returns the CLI model id for the settings", () => {
    expect(claudeCodeModelId({ id: "claude-sonnet-5" }, PRO)).toBe(
      "claude-sonnet-5[1m]",
    );
    expect(claudeCodeModelId({ id: "claude-opus-4-6" }, PRO)).toBe(
      "claude-opus-4-6",
    );
  });
});

describe("applyLongContext", () => {
  test("registered contextWindow matches the served window and 1M names are suffixed", () => {
    const models = applyLongContext(MODELS, PRO);
    const opus46 = models.find((m) => m.id === "claude-opus-4-6")!;
    expect(opus46.contextWindow).toBe(200_000);
    expect(opus46.name).toBe("Claude Opus 4.6");

    const sonnet5 = models.find((m) => m.id === "claude-sonnet-5")!;
    expect(sonnet5.contextWindow).toBe(1_000_000);
    expect(sonnet5.name).toMatch(/1M$/);
  });

  test("returns the same object when nothing changes", () => {
    const haiku = MODELS.find((m) => m.id === "claude-haiku-4-5")!;
    const mapped = applyLongContext(MODELS, PRO).find(
      (m) => m.id === "claude-haiku-4-5",
    )!;
    expect(mapped).toBe(haiku);
  });

  test("does not double-suffix 1M names", () => {
    const once = applyLongContext(MODELS, PRO);
    const twice = applyLongContext(once, PRO);
    const sonnet5 = twice.find((m) => m.id === "claude-sonnet-5")!;
    expect(sonnet5.name.match(/1M/g)).toHaveLength(1);
  });
});
