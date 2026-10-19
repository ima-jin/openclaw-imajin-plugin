/**
 * Registry reloads may re-import the entry module. Keep ownership on the
 * process, not in a module-local variable, and retire resources before the
 * replacement service can start any work. Call beginRegistration only from
 * a full-mode service start, never while constructing a registry.
 */
const registrationKey = Symbol.for("imajin.plugin.registration");
type Dispose = () => void;

export class RegistrationLifecycle {
  private readonly controller = new AbortController();
  private readonly disposers: Dispose[] = [];

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

  dispose(): void {
    if (!this.active) return;
    this.controller.abort();
    for (const dispose of this.disposers.splice(0).reverse()) this.cleanup(dispose);
  }

  private cleanup(dispose: Dispose): void {
    try {
      dispose();
    } catch (err) {
      console.error("[imajin-plugin] resource cleanup failed:", err);
    }
  }
}

export function beginRegistration(): RegistrationLifecycle {
  const processState = globalThis as typeof globalThis & {
    [registrationKey]?: RegistrationLifecycle;
  };
  processState[registrationKey]?.dispose();
  const lifecycle = new RegistrationLifecycle();
  processState[registrationKey] = lifecycle;
  return lifecycle;
}
