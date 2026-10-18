/**
 * Read-only wake sizing through the published OpenClaw 2026.10.4 SDK.
 * Session rows are SQLite-backed: never parse sessions.json or transcript paths.
 * Missing rows (including an unavailable store) are not proof of an empty session.
 * Retention is deliberately not managed here; callers must not delete shared sessions.
 */
export interface WakeSessionMetadataRequest {
  agentId: string;
  sessionKey: string;
  config?: unknown;
  /** Fence terminal observations against a session reset/replacement. */
  expectedSessionId?: string;
}

export type WakeSessionMetadata =
  | { status: "known"; sessionId: string; tokens: number; contextTokens?: number }
  | { status: "missing" }
  | {
      status: "unknown";
      reason: "invalid-identity" | "session-changed" | "stale-tokens" | "invalid-tokens" | "read-failed";
    };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * No throw and no logging: SDK/config failures may contain private session data.
 * `known` means a fresh persisted context snapshot, not an atomic size guarantee
 * or a promise that agent_end's outer result accounting has already completed.
 */
export async function readWakeSessionMetadata(
  request: WakeSessionMetadataRequest,
): Promise<WakeSessionMetadata> {
  const { agentId, sessionKey } = request;
  if (!agentId.trim() || agentId !== agentId.trim() || !sessionKey.trim() || sessionKey !== sessionKey.trim()) {
    return { status: "unknown", reason: "invalid-identity" };
  }
  if (sessionKey.startsWith("agent:") && !sessionKey.startsWith(`agent:${agentId}:`)) {
    return { status: "unknown", reason: "invalid-identity" };
  }
  try {
    const { getSessionEntry, resolveStorePath } = await import("openclaw/plugin-sdk/session-store-runtime");
    const session = record(record(request.config)?.session);
    const configuredStore = session?.store;
    if (configuredStore !== undefined && typeof configuredStore !== "string") {
      return { status: "unknown", reason: "read-failed" };
    }
    const storePath = resolveStorePath(configuredStore, { agentId });
    const entry = getSessionEntry({
      agentId,
      sessionKey,
      storePath,
      readConsistency: "latest",
      hydrateSkillPromptRefs: false,
    });
    if (!entry) return { status: "missing" };
    if (typeof entry.sessionId !== "string" || !entry.sessionId) {
      return { status: "unknown", reason: "invalid-identity" };
    }
    if (request.expectedSessionId !== undefined && entry.sessionId !== request.expectedSessionId) {
      return { status: "unknown", reason: "session-changed" };
    }
    if (entry.totalTokensFresh !== true || entry.totalTokensVersion !== 1) {
      return { status: "unknown", reason: "stale-tokens" };
    }
    if (!nonNegativeFinite(entry.totalTokens)) {
      return { status: "unknown", reason: "invalid-tokens" };
    }
    return {
      status: "known",
      sessionId: entry.sessionId,
      tokens: entry.totalTokens,
      ...(nonNegativeFinite(entry.contextTokens) && entry.contextTokens > 0
        ? { contextTokens: entry.contextTokens }
        : {}),
    };
  } catch {
    return { status: "unknown", reason: "read-failed" };
  }
}

/**
 * Integration wrapper for freshly allocated wake keys. Missing metadata maps to
 * zero only under that caller-owned freshness assumption; SDK failures never do.
 */
export async function readWakeSessionTokens(
  api: any,
  sessionKey: string,
): Promise<number | undefined> {
  try {
    let config: unknown;
    try {
      config = api?.runtime?.config?.current?.();
    } catch {
      // The registration-time config is the supported fallback.
    }
    config ??= api?.config;
    const keyAgent = /^agent:([^:]+):/.exec(sessionKey)?.[1];
    const configuredAgent = api?.pluginConfig?.wsNotifications?.hookAgentId;
    const agentId = keyAgent ?? (
      typeof configuredAgent === "string" && configuredAgent.trim()
        ? configuredAgent.trim()
        : "main"
    );
    const metadata = await readWakeSessionMetadata({ agentId, sessionKey, config });
    return metadata.status === "known" ? metadata.tokens : metadata.status === "missing" ? 0 : undefined;
  } catch {
    return undefined;
  }
}
