/**
 * Registers the OpenClaw hooks that feed the kernel loops rail (#46).
 *
 * Config-gated, on by default once `nodeUrl` + `did` + `keypairPath` are all
 * configured (`loops.enabled: false` opts out). When any of the three is
 * missing the feature is a one-line-logged no-op: nothing is registered, so an
 * install without it behaves exactly as before.
 *
 * Every hook is an Observe hook (fire-and-forget): handlers return nothing,
 * never block, and cannot fail the hooked operation — `createLoopTracker`
 * wraps each handler and `createLoopSender` drops failed publishes.
 */

import { createLoopSender, type LoopSender, type LoopSenderOptions } from "./loop-publisher.js";
import {
  createLoopTracker,
  type CronJobSnapshot,
  type LoopTracker,
} from "./loop-tracker.js";

/** `plugins.entries.imajin.config.loops` (openclaw.json). */
export interface LoopsConfig {
  /** Explicit opt-out. Defaults to true when nodeUrl + did + keypairPath are set. */
  enabled?: boolean;
  /**
   * Cron jobs to publish as `openclaw.keeper` instead of `openclaw.automation`:
   * matched against the job id, name, or declarationKey. Jobs named
   * `keeper`, `keeper:*`, `keeper-*`, `keeper_*` or `keeper/*` are keepers too.
   */
  keeperJobs?: string[];
}

export interface LoopHooksDeps {
  nodeUrl?: string;
  did?: string;
  keypairPath?: string;
  /** Principal the loops belong to (the plugin's `actAs`); defaults to `did`. */
  actAs?: string;
  config?: LoopsConfig;
  /** Test seams. */
  fetchImpl?: NonNullable<LoopSenderOptions["fetchImpl"]>;
  now?: NonNullable<LoopSenderOptions["now"]>;
  logger?: NonNullable<LoopSenderOptions["logger"]>;
}

interface HookApi {
  on: (name: string, handler: (...args: any[]) => unknown, opts?: { name?: string }) => void;
}

interface CronReconciledContext {
  getCron?: () => { list: (opts?: { includeDisabled?: boolean }) => Promise<CronJobSnapshot[]> } | undefined;
  abortSignal?: AbortSignal;
}

export interface LoopLifecycle {
  tracker: LoopTracker;
  sender: LoopSender;
}

export function registerLoopLifecycle(api: HookApi, deps: LoopHooksDeps): LoopLifecycle | undefined {
  if (deps.config?.enabled === false) return undefined;
  const log = deps.logger ?? { info: console.log, warn: console.warn };

  if (!deps.nodeUrl || !deps.did || !deps.keypairPath) {
    log.info("[imajin-loops] disabled — needs nodeUrl, did and keypairPath to sign loop events");
    return undefined;
  }

  const sender = createLoopSender({
    nodeUrl: deps.nodeUrl,
    did: deps.did,
    principal: deps.actAs,
    keypairPath: deps.keypairPath,
    logger: deps.logger,
    fetchImpl: deps.fetchImpl,
    now: deps.now,
  });
  const tracker = createLoopTracker({
    did: deps.did,
    emit: (transition) => sender.publish(transition),
    keeperJobs: deps.config?.keeperJobs,
    logger: deps.logger,
  });

  const register = (hook: string, handler: (...args: any[]) => unknown): void => {
    try {
      api.on(hook, handler, { name: `imajin-loops:${hook}` });
    } catch {
      log.warn(`[imajin-loops] could not register ${hook} hook`);
    }
  };

  register("session_start", (event, ctx) =>
    tracker.onSessionStart({ ...event, sessionKey: event?.sessionKey ?? ctx?.sessionKey }),
  );
  register("session_end", (event, ctx) =>
    tracker.onSessionEnd({ ...event, sessionKey: event?.sessionKey ?? ctx?.sessionKey }),
  );
  register("agent_end", (event, ctx) => tracker.onAgentEnd(event ?? {}, ctx));
  register("subagent_spawned", (event, ctx) => tracker.onSubagentSpawned(event ?? {}, ctx));
  register("subagent_progress", (event, ctx) => tracker.onSubagentProgress(event ?? {}, ctx));
  register("subagent_ended", (event) => tracker.onSubagentEnded(event ?? {}));
  register("cron_changed", (event) => tracker.onCronChanged(event ?? {}));
  register("cron_reconciled", async (event, ctx: CronReconciledContext | undefined) => {
    let jobs: CronJobSnapshot[] | undefined;
    try {
      jobs = await ctx?.getCron?.()?.list({ includeDisabled: true });
    } catch {
      log.warn("[imajin-loops] cron_reconciled: could not list cron jobs");
    }
    if (ctx?.abortSignal?.aborted) return;
    tracker.onCronReconciled(event ?? {}, jobs);
  });

  log.info("[imajin-loops] publishing loop lifecycle events to the kernel loops rail");
  return { tracker, sender };
}
