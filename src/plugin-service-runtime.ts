import { beginRegistration, type RegistrationLifecycle } from "./registration-lifecycle.js";
import type { WakeDisclosureSender } from "./wake-report-tool.js";
import type { ImajinDefaultRoutingStatus } from "./imajin-default-routing.js";

type HookHandler = (...args: any[]) => unknown;
export type RuntimeHookRegister = (
  hook: string, handler: HookHandler, options?: { name?: string; priority?: number },
) => void;

/**
 * The host may build several full-mode registries in one process (config hot
 * reload, scoped loads), but starts the plugin's services only once. Hooks and
 * tools from a registry that never started must still reach the runtime that
 * did, or every wake guard, the option-c decision router and the wake report
 * tool go blind (#92). Ownership lives on the process, like the registration
 * lifecycle, so a re-imported module sees the same owner.
 */
const ownerKey = Symbol.for("imajin.plugin.serviceRuntime");
const dispatchedKey = Symbol.for("imajin.plugin.dispatchedHookEvents");
type ProcessState = typeof globalThis & {
  [ownerKey]?: PluginServiceRuntime;
  [dispatchedKey]?: WeakMap<object, Set<string>>;
};

function processState(): ProcessState {
  return globalThis as ProcessState;
}

/** True when this hook event was already forwarded by another registration's proxy. */
function alreadyDispatched(event: unknown, name: string): boolean {
  if (!event || typeof event !== "object") return false;
  const state = processState();
  state[dispatchedKey] ??= new WeakMap();
  const seen = state[dispatchedKey].get(event);
  if (seen?.has(name)) return true;
  if (seen) seen.add(name);
  else state[dispatchedKey].set(event, new Set([name]));
  return false;
}

/** Registry construction is metadata only; only a full service start owns IO. */
export class PluginServiceRuntime {
  agentTools?: (ctx: { agentId?: string; sessionKey?: string; runId?: string }) => unknown;
  defaultRoutingStatus?: () => ImajinDefaultRoutingStatus;
  private lifecycle?: RegistrationLifecycle;
  private started?: Promise<void>;
  private readonly handlers = new Map<string, HookHandler>();
  private wakeSender?: WakeDisclosureSender;
  private readonly full: boolean;

  constructor(
    mode: string | undefined,
    private readonly setup: (lifecycle: RegistrationLifecycle, on: RuntimeHookRegister) => Promise<void>,
  ) {
    this.full = mode === undefined || mode === "full";
  }

  /** The started runtime that owns IO in this process, if any. */
  static owner(): PluginServiceRuntime | undefined {
    const owner = processState()[ownerKey];
    return owner?.lifecycle?.active ? owner : undefined;
  }

  registerHook(api: { on: RuntimeHookRegister; registerHook?: RuntimeHookRegister }, hook: string, name: string, priority?: number): void {
    if (!this.full) return;
    const register = hook.includes(":") ? api.registerHook?.bind(api) : api.on.bind(api);
    register?.(hook, (...args) => {
      const owner = PluginServiceRuntime.owner();
      if (!owner || alreadyDispatched(args[0], name)) return undefined;
      return owner.handlers.get(name)?.(...args);
    }, { name, ...(priority === undefined ? {} : { priority }) });
  }

  readonly start = (): Promise<void> => {
    if (!this.full || this.lifecycle) return this.started ?? Promise.resolve();
    const lifecycle = beginRegistration();
    this.lifecycle = lifecycle;
    const state = processState();
    state[ownerKey] = this;
    lifecycle.add(() => {
      this.handlers.clear();
      this.wakeSender = undefined;
      if (state[ownerKey] === this) delete state[ownerKey];
    });
    this.started = Promise.resolve().then(async () => {
      if (!lifecycle.active) return;
      await this.setup(lifecycle, (_hook, handler, options) => {
        if (lifecycle.active) this.handlers.set(options?.name ?? _hook, handler);
      });
    }).catch(async (err: unknown) => {
      await lifecycle.dispose();
      throw err;
    });
    return this.started;
  };

  readonly stop = async (): Promise<void> => {
    await this.lifecycle?.dispose();
  };

  setWakeSender(sender: WakeDisclosureSender): void {
    this.wakeSender = sender;
  }

  readonly reportWake: WakeDisclosureSender = async (ctx, disclosure) => {
    const sender = PluginServiceRuntime.owner()?.wakeSender;
    if (!sender) throw new Error("Imajin runtime is not started");
    await sender(ctx, disclosure);
  };
}
