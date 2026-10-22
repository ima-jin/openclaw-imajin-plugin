/**
 * Registry reloads may re-import the entry module. Keep ownership on the
 * process, not in a module-local variable, and retire resources before the
 * replacement service can start any work. Call beginRegistration only from
 * a full-mode service start, never while constructing a registry.
 */
const registrationKey = Symbol.for("imajin.plugin.registration");
type Dispose = () => unknown;

export class RegistrationLifecycle {
  private readonly controller = new AbortController();
  private readonly disposers: Dispose[] = [];
  private readonly pending = new Set<Promise<void>>();
  private cleaning = false;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get active(): boolean {
    return !this.signal.aborted;
  }

  add(dispose: Dispose): void {
    if (this.active) this.disposers.push(dispose);
    else this.cleanup(dispose);
  }

  async dispose(): Promise<void> {
    // The outer disposal owns the drain when a synchronous disposer re-enters.
    if (this.cleaning) return;
    if (this.active) {
      this.cleaning = true;
      try {
        this.controller.abort();
        for (const dispose of this.disposers.splice(0).reverse()) this.cleanup(dispose);
      } finally {
        this.cleaning = false;
      }
    }
    await this.drain();
  }

  private async drain(): Promise<void> {
    if (!this.pending.size) return;
    await Promise.all(this.pending);
    if (this.pending.size) await this.drain();
  }

  private cleanup(dispose: Dispose): void {
    try {
      const result = dispose();
      if (result instanceof Promise) {
        const pending = result.catch((err: unknown) => {
          console.error("[imajin-plugin] resource cleanup failed:", err);
        }).finally(() => this.pending.delete(pending));
        this.pending.add(pending);
      }
    } catch (err) {
      console.error("[imajin-plugin] resource cleanup failed:", err);
    }
  }
}

export function beginRegistration(): RegistrationLifecycle {
  const processState = globalThis as typeof globalThis & {
    [registrationKey]?: RegistrationLifecycle;
  };
  void processState[registrationKey]?.dispose();
  const lifecycle = new RegistrationLifecycle();
  processState[registrationKey] = lifecycle;
  return lifecycle;
}
