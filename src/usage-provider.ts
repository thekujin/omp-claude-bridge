import type {
  Query,
  SDKControlGetUsageResponse,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { PROVIDER_ID } from "./convert.js";
import type { BridgeRuntime } from "./runtime.js";

// Host usage.ts contract, newer than the vendored @earendil-works typings.
export interface UsageReport {
  provider: string;
  fetchedAt: number;
  limits: {
    id: string;
    label: string;
    scope: { provider: string; accountId?: string; windowId: string };
    amount: { usedFraction: number; unit: "percent" };
    window: { id: string; label: string; durationMs: number; resetsAt?: number };
    status: "ok" | "warning" | "exhausted";
  }[];
}

export interface UsageProviderLike {
  id: string;
  validatesCredentials: false;
  fetchUsage(
    params: { signal?: AbortSignal; credential?: { accountId?: string } },
    ctx: unknown,
  ): Promise<UsageReport | null>;
}

interface UsageRefreshContext {
  model?: { provider: string };
  modelRegistry: {
    authStorage: {
      usage: {
        invalidate(provider: string): void;
        reports(): Promise<unknown>;
      };
    };
  };
}

export async function refreshUsageAfterTurn(
  _event: unknown,
  ctx: UsageRefreshContext,
): Promise<void> {
  if (ctx.model?.provider !== PROVIDER_ID) return;
  try {
    const usage = ctx.modelRegistry.authStorage.usage;
    usage.invalidate(PROVIDER_ID);
    await usage.reports();
  } catch {
    // Usage is best-effort, like fetchUsage; never fail a completed turn.
  }
}

export function toUsageReport(
  usage: SDKControlGetUsageResponse,
  accountId?: string,
): UsageReport | null {
  if (!usage.rate_limits_available || !usage.rate_limits) return null;
  const limits: UsageReport["limits"] = [];
  for (const [key, id, label, durationMs] of [
    ["five_hour", "5h", "5 Hour", 5 * 60 * 60 * 1000],
    ["seven_day", "7d", "7 Day", 7 * 24 * 60 * 60 * 1000],
  ] as const) {
    const source = usage.rate_limits[key];
    if (source?.utilization == null || !Number.isFinite(source.utilization)) continue;
    // The SDK reports percentages (0–100); the host stores fractions.
    const usedFraction = Math.max(0, source.utilization / 100);
    const resetsAt = source.resets_at ? Date.parse(source.resets_at) : NaN;
    limits.push({
      id: `${PROVIDER_ID}:${id}`,
      label,
      scope: { provider: PROVIDER_ID, ...(accountId ? { accountId } : {}), windowId: id },
      amount: { usedFraction, unit: "percent" },
      window: {
        id,
        label,
        durationMs,
        ...(Number.isFinite(resetsAt) ? { resetsAt } : {}),
      },
      status: usedFraction >= 1 ? "exhausted" : usedFraction >= 0.8 ? "warning" : "ok",
    });
  }
  return limits.length ? { provider: PROVIDER_ID, fetchedAt: Date.now(), limits } : null;
}

export function createUsageProvider(runtime: BridgeRuntime): UsageProviderLike {
  return {
    id: PROVIDER_ID,
    validatesCredentials: false,
    async fetchUsage(params, _ctx) {
      if (params.signal?.aborted) return null;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      async function* noInput(): AsyncGenerator<SDKUserMessage> { await gate; }
      let q: Query | undefined;
      const abortController = new AbortController();
      let cancel!: () => void;
      const aborted = new Promise<null>((resolve) => {
        cancel = () => { abortController.abort(); resolve(null); };
      });
      params.signal?.addEventListener("abort", cancel, { once: true });
      try {
        const executable = runtime.providerSettings.pathToClaudeCodeExecutable;
        // This flag also disables Claude Code's usage endpoint; only this query needs it.
        const env = { ...process.env };
        delete env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
        // An independent query avoids interfering with an active model stream.
        q = runtime.queryFn({
          prompt: noInput(),
          options: {
            cwd: process.cwd(),
            env,
            abortController,
            ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
          },
        });
        return await Promise.race([
          q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })
            .then((usage) => toUsageReport(usage, params.credential?.accountId)),
          aborted,
        ]);
      } catch {
        return null;
      } finally {
        params.signal?.removeEventListener("abort", cancel);
        release();
        try { q?.close(); } catch {}
      }
    },
  };
}
