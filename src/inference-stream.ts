import type { StreamFn, AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { AgentInferenceAuth, InferenceAuthError } from "./inference-auth.js";
import type { AgentIdentity } from "./agent-identities.js";

const CREDENTIAL_HEADERS = new Set(["authorization", "x-api-key", "api-key", "x-acting-as", "x-acting-for", "cookie"]);

function cleanHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(headers ?? {}).filter(([key]) => !CREDENTIAL_HEADERS.has(key.toLowerCase())));
}

function redact(message: string, token: string): string {
  return message.replaceAll(token, "[redacted]")
    .replaceAll(/[A-Za-z0-9_.-]+/g, (part) => part.split(".").length >= 3 ? "[redacted]" : part);
}

function isCredentialRefusal(error: { errorMessage?: string; status?: number }, status?: number): boolean {
  return (status ?? error.status ?? (/^401\b/.test(error.errorMessage ?? "") ? 401 : undefined)) === 401
    && error.errorMessage?.includes("invalid_agent_credential") === true;
}

export function createAgentInferenceWrapper(auth: AgentInferenceAuth) {
  return (ctx: { agentId?: string; streamFn?: StreamFn }): StreamFn => {
    // Fail before any synthetic/static credential could reach a transport.
    auth.identity(ctx.agentId);
    if (!ctx.streamFn) throw new InferenceAuthError(ctx.agentId!, "provider streamFn is required");
    const agentId = ctx.agentId!;
    const inner = ctx.streamFn;
    return async (model, context, options) => {
      const identity = auth.identity(agentId);
      if (options?.client !== undefined) {
        throw new InferenceAuthError(agentId, "preconfigured provider clients are not permitted");
      }
      options?.signal?.throwIfAborted();
      let credential = await auth.credential(agentId);
      options?.signal?.throwIfAborted();
      const { createAssistantMessageEventStream } = await import("openclaw/plugin-sdk/llm");
      const output = createAssistantMessageEventStream();
      const safeModel = { ...model, headers: cleanHeaders(model.headers) };
      const call = new SignedStreamCall(auth, agentId, identity, inner, safeModel, context, options, output);
      const run = async () => {
        if (await call.attempt(credential.token, true)) {
          credential = await auth.credential(agentId, credential.token);
          await call.attempt(credential.token, false);
        }
      };
      void run().catch((error) => call.fail(error)).finally(() => output.end());
      return output;
    };
  };
}

interface AttemptState {
  emitted: boolean;
  start?: AssistantMessageEvent;
  status?: number;
}

class SignedStreamCall {
  constructor(
    private readonly auth: AgentInferenceAuth,
    private readonly agentId: string,
    private readonly identity: AgentIdentity,
    private readonly inner: StreamFn,
    private readonly model: Parameters<StreamFn>[0],
    private readonly context: unknown,
    private readonly options: Parameters<StreamFn>[2],
    private readonly output: AssistantMessageEventStream,
  ) {}

  private canRetry(state: AttemptState, allowed: boolean): boolean {
    return allowed && !state.emitted && !this.options?.signal?.aborted;
  }

  async attempt(token: string, retryAllowed: boolean): Promise<boolean> {
    if (this.auth.identity(this.agentId) !== this.identity) {
      throw new InferenceAuthError(this.agentId, "identity runtime changed");
    }
    this.options?.signal?.throwIfAborted();
    const state: AttemptState = { emitted: false };
    try {
      const stream = await this.inner(this.model, this.context, {
        ...this.options, apiKey: token,
        headers: {
          ...cleanHeaders(this.options?.headers), Authorization: `Bearer ${token}`,
          ...(this.identity.config.actAs ? { "x-acting-as": this.identity.config.actAs } : {}),
        },
        onResponse: async (response, model) => {
          state.status = response.status;
          await this.options?.onResponse?.(response, model);
        },
      });
      return await this.forward(stream, token, state, retryAllowed);
    } catch (error) {
      const failure = error as { status?: number; message?: string };
      const refused = isCredentialRefusal({ status: failure?.status, errorMessage: failure?.message }, state.status);
      if (refused) this.auth.invalidate(this.agentId, token);
      if (refused && this.canRetry(state, retryAllowed)) return true;
      // Exceptions may retain request credentials in their causes. Preserve only safe metadata.
      throw new InferenceAuthError(this.agentId, "provider request failed", state.status ?? failure?.status);
    }
  }

  private async forward(
    stream: AsyncIterable<AssistantMessageEvent>, token: string, state: AttemptState, retryAllowed: boolean,
  ): Promise<boolean> {
    for await (const event of stream) {
      if (event.type === "start" && !state.emitted) { state.start = event; continue; }
      if (event.type === "error") {
        const refused = isCredentialRefusal(event.error, state.status);
        if (refused) this.auth.invalidate(this.agentId, token);
        if (refused && this.canRetry(state, retryAllowed)) return true;
        this.output.push({ ...event, error: redactError(event.error, token) });
        return false;
      }
      if (state.start) { this.output.push(state.start); state.start = undefined; }
      state.emitted = true;
      this.output.push(event);
    }
    return false;
  }

  fail(error: unknown): void {
    const reason = this.options?.signal?.aborted ? "aborted" : "error";
    const message: AssistantMessage = {
      role: "assistant", content: [], api: this.model.api, provider: this.model.provider, model: this.model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: reason, timestamp: Date.now(),
      errorMessage: error instanceof InferenceAuthError ? error.message : `Imajin inference agents.${this.agentId}: request unavailable`,
      ...(error instanceof InferenceAuthError && error.status ? { status: error.status } : {}),
    };
    this.output.push({ type: "error", reason, error: message });
  }
}

function redactError(error: AssistantMessage, token: string): AssistantMessage {
  // SDK diagnostics include errorBody/errorCode in addition to errorMessage.
  return JSON.parse(JSON.stringify(error, (_key, value) =>
    typeof value === "string" ? redact(value, token) : value)) as AssistantMessage;
}
