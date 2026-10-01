/**
 * The plugin's one deterministic, no-model-in-the-loop human-facing delivery
 * mechanism: a plain `openclaw message send` CLI call (Telegram by default),
 * configured via `wsNotifications.directSend`.
 *
 * Extracted from `notification-injector.ts` (#53) so the approvals bridge can
 * reuse the exact same path to warn the operator, instead of growing a second
 * one. Behavior is unchanged: same CLI, same args, same 20s timeout.
 */

export interface DirectSendConfig {
  /** Channel id, default `telegram`. */
  channel?: string;
  /** Chat/recipient target, e.g. `8321865723`. */
  target?: string;
  /** Absolute path to the openclaw CLI binary; default `openclaw` (PATH). */
  cliPath?: string;
}

/** Rejects when `directSend` is not configured or the CLI call fails. */
export async function sendDirectChannelMessage(
  ds: DirectSendConfig | undefined,
  text: string,
): Promise<void> {
  if (!ds?.target) {
    throw new Error("directSend not configured");
  }
  const { execFile } = await import("node:child_process");
  const cli = ds.cliPath ?? "openclaw";
  const args = ["message", "send", "--channel", ds.channel ?? "telegram", "--target", ds.target, "-m", text];
  await new Promise<void>((resolve, reject) => {
    execFile(cli, args, { timeout: 20_000 }, (err) => (err ? reject(err) : resolve()));
  });
}
