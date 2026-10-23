import { describe, expect, test } from "bun:test";
import type {
  Api,
  AssistantMessageEventStream,
  Model,
} from "@earendil-works/pi-ai";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { QueryContext } from "../src/query-state.js";
import {
  claimCurrentPiStream,
  consumeQuery,
  finalizeCurrentStream,
  mapStopReason,
  markStreamComplete,
  parsePartialJson,
  processAssistantMessage,
  processStreamEvent,
  resetTimeMs,
  updateUsage,
} from "../src/stream-processing.js";

const MODEL = {
  id: "claude-test",
  name: "Test",
  api: "anthropic-messages",
  provider: "claude-bridge",
  reasoning: true,
  input: ["text"],
  cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  contextWindow: 200_000,
  maxTokens: 64_000,
} as unknown as Model<Api>;

interface CollectedEvent {
  type: string;
  [key: string]: unknown;
}

function fakeStream(): {
  stream: AssistantMessageEventStream;
  events: CollectedEvent[];
  ended: () => boolean;
} {
  const events: CollectedEvent[] = [];
  let done = false;
  const stream = {
    push: (e: CollectedEvent) => events.push(e),
    end: () => {
      done = true;
    },
  } as unknown as AssistantMessageEventStream;
  return { stream, events, ended: () => done };
}

function newContext() {
  const c = new QueryContext();
  const { stream, events, ended } = fakeStream();
  c.resetTurnState(MODEL);
  c.currentPiStream = stream;
  return { c, events, ended };
}

const sdk = (event: Record<string, unknown>): SDKMessage =>
  ({ type: "stream_event", event }) as unknown as SDKMessage;

describe("processStreamEvent", () => {
  test("text block lifecycle emits start/delta/end and accumulates text", () => {
    const { c, events } = newContext();
    const noMap = new Map<string, string>();
    processStreamEvent(sdk({ type: "message_start", message: {} }), noMap, MODEL, c);
    processStreamEvent(
      sdk({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
      noMap,
      MODEL,
      c,
    );
    processStreamEvent(
      sdk({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } }),
      noMap,
      MODEL,
      c,
    );
    processStreamEvent(
      sdk({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } }),
      noMap,
      MODEL,
      c,
    );
    processStreamEvent(sdk({ type: "content_block_stop", index: 0 }), noMap, MODEL, c);
    processStreamEvent(
      sdk({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
      noMap,
      MODEL,
      c,
    );

    expect(events.map((e) => e.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_delta",
      "text_end",
    ]);
    expect(c.turnBlocks).toEqual([{ type: "text", text: "Hello" }]);
    expect(c.turnOutput?.stopReason).toBe("stop");
    expect(c.turnSawStreamEvent).toBe(true);
  });

  test("tool_use lifecycle maps names/args and finishes the stream on message_stop", () => {
    const { c, events, ended } = newContext();
    const noMap = new Map<string, string>();
    processStreamEvent(sdk({ type: "message_start", message: {} }), noMap, MODEL, c);
    processStreamEvent(
      sdk({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tc1", name: "Edit", input: {} },
      }),
      noMap,
      MODEL,
      c,
    );
    processStreamEvent(
      sdk({
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: '{"file_path":"a.ts","old_string":"x","new_string":"y"}',
        },
      }),
      noMap,
      MODEL,
      c,
    );
    processStreamEvent(sdk({ type: "content_block_stop", index: 0 }), noMap, MODEL, c);
    processStreamEvent(sdk({ type: "message_stop" }), noMap, MODEL, c);

    expect(c.turnToolCallIds).toEqual(["tc1"]);
    expect(c.turnBlocks[0]).toEqual({
      type: "toolCall",
      id: "tc1",
      name: "edit",
      arguments: { path: "a.ts", oldText: "x", newText: "y" },
    });
    expect(c.turnOutput?.stopReason).toBe("toolUse");
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "toolUse" });
    expect(ended()).toBe(true);
    expect(c.currentPiStream).toBeNull();
  });

  test("thinking blocks collect deltas and signature", () => {
    const { c } = newContext();
    const noMap = new Map<string, string>();
    processStreamEvent(
      sdk({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }),
      noMap,
      MODEL,
      c,
    );
    processStreamEvent(
      sdk({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "mull" } }),
      noMap,
      MODEL,
      c,
    );
    processStreamEvent(
      sdk({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "s1" } }),
      noMap,
      MODEL,
      c,
    );
    processStreamEvent(sdk({ type: "content_block_stop", index: 0 }), noMap, MODEL, c);
    expect(c.turnBlocks[0]).toEqual({
      type: "thinking",
      thinking: "mull",
      thinkingSignature: "s1",
    });
  });

  test("does nothing without an active stream", () => {
    const c = new QueryContext();
    c.resetTurnState(MODEL);
    c.currentPiStream = null;
    processStreamEvent(sdk({ type: "message_start" }), new Map(), MODEL, c);
    expect(c.turnSawStreamEvent).toBe(false);
  });
});

describe("processAssistantMessage", () => {
  const assistantSdk = (content: unknown[], usage?: Record<string, number>) =>
    ({ type: "assistant", message: { content, usage } }) as unknown as SDKMessage;

  test("is skipped when stream events were already processed", () => {
    const { c, events } = newContext();
    c.turnSawStreamEvent = true;
    processAssistantMessage(assistantSdk([{ type: "text", text: "x" }]), MODEL, new Map(), c);
    expect(events).toEqual([]);
  });

  test("replays text and tool_use blocks as full event sequences", () => {
    const { c, events, ended } = newContext();
    processAssistantMessage(
      assistantSdk([
        { type: "text", text: "answer" },
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "f.ts" } },
      ]),
      MODEL,
      new Map(),
      c,
    );
    expect(events.map((e) => e.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "toolcall_start",
      "toolcall_end",
      "done",
    ]);
    expect(c.turnBlocks[1]).toEqual({
      type: "toolCall",
      id: "t1",
      name: "read",
      arguments: { path: "f.ts" },
    });
    expect(c.turnOutput?.stopReason).toBe("toolUse");
    expect(ended()).toBe(true);
  });

  test("text-only message leaves the stream open for the result", () => {
    const { c, ended } = newContext();
    processAssistantMessage(
      assistantSdk([{ type: "text", text: "plain answer" }]),
      MODEL,
      new Map(),
      c,
    );
    expect(ended()).toBe(false);
    expect(c.currentPiStream).not.toBeNull();
  });
});

describe("finalizeCurrentStream", () => {
  test("emits done with stop/length and clears the stream", () => {
    const { c, events, ended } = newContext();
    finalizeCurrentStream(c, "length");
    expect(events.map((e) => e.type)).toEqual(["start", "done"]);
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "length" });
    expect(ended()).toBe(true);
    expect(c.currentPiStream).toBeNull();
  });
});

describe("turn timing", () => {
  for (const type of ["text", "thinking", "tool_use"] as const) {
    test(`${type} stream records first content and terminal timing in milliseconds`, async () => {
      const { c, events } = newContext();
      let firstContentBefore = 0;
      let firstContentAfter = 0;
      const query = (async function* () {
        await Bun.sleep(5);
        if (type === "tool_use") firstContentBefore = Date.now();
        yield sdk({
          type: "content_block_start",
          index: 0,
          content_block: type === "tool_use"
            ? { type, id: "timed-tool", name: "Read", input: {} }
            : { type },
        });
        if (type === "tool_use") {
          firstContentAfter = Date.now();
        } else {
          // Empty starts are not tokens; text/thinking timing begins at the delta.
          expect(c.turnOutput?.ttft).toBeUndefined();
          await Bun.sleep(10);
          firstContentBefore = Date.now();
          yield sdk({
            type: "content_block_delta",
            index: 0,
            delta: type === "text"
              ? { type: "text_delta", text: "first" }
              : { type: "thinking_delta", thinking: "first" },
          });
          firstContentAfter = Date.now();
          await Bun.sleep(5);
          yield sdk({
            type: "content_block_delta",
            index: 0,
            delta: type === "text"
              ? { type: "text_delta", text: " second" }
              : { type: "thinking_delta", thinking: " second" },
          });
        }
        // Tool-only streams need timing even without any input_json_delta.
        await Bun.sleep(5);
        yield sdk({ type: "content_block_stop", index: 0 });
        yield sdk({ type: "message_stop" });
      })() as unknown as Query;

      await consumeQuery(query, new Map(), MODEL, () => false, c);
      finalizeCurrentStream(c);

      expect(events.at(-1)?.type).toBe("done");
      const message = events.at(-1)!.message as NonNullable<QueryContext["turnOutput"]>;
      expect(message.duration).toBeGreaterThan(0);
      expect(message.ttft).toBeGreaterThan(0);
      expect(message.ttft!).toBeLessThanOrEqual(message.duration!);
      expect(message.ttft!).toBeGreaterThanOrEqual(firstContentBefore - message.timestamp);
      expect(message.ttft!).toBeLessThanOrEqual(firstContentAfter - message.timestamp);
    });
  }

  for (const type of ["assistant", "result"] as const) {
    test(`${type} fallback records emitted content before completion`, async () => {
      const { c, events } = newContext();
      let firstContentBefore = 0;
      let firstContentAfter = 0;
      const query = (async function* () {
        await Bun.sleep(5);
        firstContentBefore = Date.now();
        yield (type === "assistant"
          ? { type, message: { content: [{ type: "text", text: "fallback" }] } }
          : { type, subtype: "success", result: "fallback" }) as unknown as SDKMessage;
        firstContentAfter = Date.now();
        await Bun.sleep(5);
      })() as unknown as Query;

      await consumeQuery(query, new Map(), MODEL, () => false, c);
      finalizeCurrentStream(c);

      expect(events.some((event) => event.type === "text_delta")).toBe(true);
      expect(events.at(-1)?.type).toBe("done");
      const message = events.at(-1)!.message as NonNullable<QueryContext["turnOutput"]>;
      expect(message.duration).toBeGreaterThan(0);
      expect(message.ttft).toBeGreaterThan(0);
      expect(message.ttft!).toBeLessThanOrEqual(message.duration!);
      expect(message.ttft!).toBeGreaterThanOrEqual(firstContentBefore - message.timestamp);
      expect(message.ttft!).toBeLessThanOrEqual(firstContentAfter - message.timestamp);
    });
  }
});

describe("claimCurrentPiStream / markStreamComplete", () => {
  test("claims replace the stream reference", () => {
    const { c } = newContext();
    const { stream: replacement } = fakeStream();
    markStreamComplete(c.currentPiStream);
    claimCurrentPiStream(replacement, "test", c);
    expect(c.currentPiStream).toBe(replacement);
  });
});

describe("updateUsage", () => {
  test("maps token fields, sums totals, and computes cost", () => {
    const c = new QueryContext();
    c.resetTurnState(MODEL);
    updateUsage(
      c.turnOutput!,
      {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 10,
      },
      MODEL,
    );
    const usage = c.turnOutput!.usage;
    expect(usage.input).toBe(100);
    expect(usage.output).toBe(50);
    expect(usage.cacheRead).toBe(1000);
    expect(usage.cacheWrite).toBe(10);
    expect(usage.totalTokens).toBe(1160);
    expect(usage.cost.total).toBeGreaterThan(0);
  });

  test("keeps previous values when fields are absent", () => {
    const c = new QueryContext();
    c.resetTurnState(MODEL);
    updateUsage(c.turnOutput!, { input_tokens: 7 }, MODEL);
    updateUsage(c.turnOutput!, { output_tokens: 3 }, MODEL);
    expect(c.turnOutput!.usage.input).toBe(7);
    expect(c.turnOutput!.usage.output).toBe(3);
  });
});

describe("mapStopReason", () => {
  test("maps SDK reasons to pi reasons", () => {
    expect(mapStopReason("tool_use")).toBe("toolUse");
    expect(mapStopReason("max_tokens")).toBe("length");
    expect(mapStopReason("end_turn")).toBe("stop");
    expect(mapStopReason(undefined)).toBe("stop");
  });
});

describe("parsePartialJson", () => {
  test("parses complete JSON and falls back otherwise", () => {
    expect(parsePartialJson('{"a":1}', {})).toEqual({ a: 1 });
    expect(parsePartialJson('{"a":', { keep: true })).toEqual({ keep: true });
    expect(parsePartialJson("", { keep: true })).toEqual({ keep: true });
  });
});

describe("rate-limit notifications", () => {
  async function notices(info?: Record<string, unknown>) {
    const { c } = newContext();
    const notifications: Array<{ message: string; level: string }> = [];
    const query = (async function* () {
      yield { type: "rate_limit_event", rate_limit_info: info } as unknown as SDKMessage;
    })() as unknown as Query;
    await consumeQuery(query, new Map(), MODEL, () => false, c, {
      notify: (message, level) => notifications.push({ message, level }),
    });
    return notifications;
  }

  test("warning status rounds utilization and includes the limit type", async () => {
    expect(await notices({
      status: "allowed_warning", rateLimitType: "seven_day", utilization: 87.4,
    })).toEqual([{
      message: "Claude rate limit warning: 87% used (seven_day)",
      level: "warning",
    }]);
  });

  test("warning status remains visible at low or missing utilization", async () => {
    for (const utilization of [1, undefined]) {
      expect(await notices({ status: "allowed_warning", utilization })).toEqual([{
        message: `Claude rate limit warning: ${utilization ?? 0}% used ()`,
        level: "warning",
      }]);
    }
  });

  test("rejected status normalizes reset timestamps and always warns", async () => {
    const seconds = 1_791_600_000;
    for (const resetsAt of [seconds, seconds * 1000, new Date(seconds * 1000).toISOString()]) {
      expect(await notices({ status: "rejected", rateLimitType: "seven_day", resetsAt }))
        .toEqual([{
          message: `Claude rate limited (seven_day) — resets at ${new Date(seconds * 1000).toLocaleTimeString()}`,
          level: "warning",
        }]);
    }
  });

  test("missing or invalid rejection fields fall back to unknown", async () => {
    for (const resetsAt of [undefined, "invalid-date"]) {
      expect(await notices({ status: "rejected", resetsAt })).toEqual([{
        message: "Claude rate limited (unknown) — resets at unknown",
        level: "warning",
      }]);
    }
  });

  test("allowed, empty and missing statuses stay silent", async () => {
    for (const info of [{ status: "allowed", utilization: 99 }, {}, undefined]) {
      expect(await notices(info)).toEqual([]);
    }
  });
});

describe("resetTimeMs", () => {
  test("normalizes seconds, milliseconds and ISO strings", () => {
    const seconds = 1_791_600_000;
    expect(resetTimeMs(seconds)).toBe(seconds * 1000);
    expect(resetTimeMs(seconds * 1000)).toBe(seconds * 1000);
    const iso = "2026-10-10T12:00:00.000Z";
    expect(resetTimeMs(iso)).toBe(Date.parse(iso));
  });

  test("returns null for missing and unparseable values", () => {
    expect(resetTimeMs(null)).toBeNull();
    expect(resetTimeMs(undefined)).toBeNull();
    expect(resetTimeMs("not-a-date")).toBeNull();
  });
});
