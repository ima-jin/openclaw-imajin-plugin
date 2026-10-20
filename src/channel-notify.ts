/** Shared deterministic in-process channel delivery. No model or subprocess. */

export interface DirectSendConfig {
  /** Channel id, default `telegram`. */
  channel?: string;
  /** Chat/recipient target, e.g. `8321865723`. */
  target?: string;
  /** @deprecated Accepted for compatibility, ignored. Delivery is in-process. */
  cliPath?: string;
}

/**
 * Narrow subset verified from published openclaw@2026.10.4:
 * agent-harness-runtime-DZjstJNb.d.ts, PluginRuntimeChannel.outbound.loadAdapter;
 * outbound.types-B8D3jrzb.d.ts, ChannelOutboundAdapter.sendText;
 * types-DemD-QhX.d.ts, ChannelMessageSendTextContext (cfg/to/text/signal).
 * The gateway injects these methods; no SDK runtime import is necessary.
 */
export interface DirectChannelApi {
  config?: Record<string, unknown>;
  runtime?: {
    config?: { current?: () => Record<string, unknown> };
    channel?: {
      outbound?: {
        loadAdapter?: (channel: string) => Promise<{
          sendText?: (ctx: {
            cfg: Record<string, unknown>;
            to: string;
            text: string;
            signal?: AbortSignal;
          }) => Promise<{ outcome?: string } | undefined>;
        } | undefined>;
      };
    };
  };
}

export const DIRECT_SEND_TIMEOUT_MS = 20_000;

/** Rejects on missing configuration/adapter, refused delivery, or timeout. */
export async function sendDirectChannelMessage(
  ds: DirectSendConfig | undefined,
  text: string,
  api?: DirectChannelApi,
): Promise<void> {
  if (!ds?.target) {
    throw new Error("directSend not configured");
  }
  const outbound = api?.runtime?.channel?.outbound;
  if (!outbound?.loadAdapter) throw new Error("OpenClaw channel outbound runtime unavailable");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        const adapter = await outbound.loadAdapter!(ds.channel ?? "telegram");
        if (controller.signal.aborted) throw new Error("directSend timed out");
        if (!adapter?.sendText) throw new Error("OpenClaw channel text adapter unavailable");
        const result = await adapter.sendText({
          cfg: api?.runtime?.config?.current?.() ?? api?.config ?? {},
          to: ds.target!,
          text,
          signal: controller.signal,
        });
        if (result?.outcome === "not_sent") throw new Error("OpenClaw channel delivery refused");
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("directSend timed out"));
        }, DIRECT_SEND_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
