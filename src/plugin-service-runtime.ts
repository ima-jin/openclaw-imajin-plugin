import { beginRegistration, type RegistrationLifecycle } from "./registration-lifecycle.js";
import type { WakeDisclosureSender } from "./wake-report-tool.js";

type HookHandler = (...args: any[]) => unknown;
export type RuntimeHookRegister = (
  hook: string, handler: HookHandler, options?: { name?: string },
) => void;

/** Registry construction is metadata only; only a full service start owns IO. */
export class PluginServiceRuntime {
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

  registerHook(api: { on: RuntimeHookRegister }, hook: string, name: string): void {
    if (!this.full) return;
    api.on(hook, (...args) => {
      if (this.lifecycle?.active) return this.handlers.get(name)?.(...args);
      return undefined;
    }, { name });
  }

  readonly start = (): Promise<void> => {
    if (!this.full || this.lifecycle) return this.started ?? Promise.resolve();
    const lifecycle = beginRegistration();
    this.lifecycle = lifecycle;
    lifecycle.add(() => {
      this.handlers.clear();
      this.wakeSender = undefined;
    });
    this.started = Promise.resolve().then(async () => {
      if (!lifecycle.active) return;
      await this.setup(lifecycle, (_hook, handler, options) => {
        if (lifecycle.active) this.handlers.set(options?.name ?? _hook, handler);
      });
    }).catch((err: unknown) => {
      lifecycle.dispose();
      throw err;
    });
    return this.started;
  };

  readonly stop = (): void => {
    this.lifecycle?.dispose();
  };

  setWakeSender(sender: WakeDisclosureSender): void {
    this.wakeSender = sender;
  }

  readonly reportWake: WakeDisclosureSender = async (ctx, disclosure) => {
    if (!this.lifecycle?.active || !this.wakeSender) throw new Error("Imajin runtime is not started");
    await this.wakeSender(ctx, disclosure);
  };
}
