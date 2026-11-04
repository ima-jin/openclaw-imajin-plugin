import { AgentInferenceAuth, InferenceAuthError } from "./inference-auth.js";
import { ImajinDiscoveryError, type ImajinCatalogFetcher } from "./imajin-provider.js";

/** Only explicit kernel error fields are logged; never serialize arbitrary response objects. */
function kernelErrorDetail(text: string, token: string): string {
  try {
    const body = JSON.parse(text);
    const error = typeof body?.error === "object" ? body.error : body;
    const fields = [error?.code, typeof body?.error === "string" ? body.error : undefined, error?.message]
      .filter((value): value is string => typeof value === "string");
    return fields.join(": ").replaceAll(token, "[redacted]")
      .split(" ").map((part) => part.includes(".") || part.startsWith("sk-") ? "[redacted]" : part).join(" ")
      .replaceAll(/[\r\n]/g, " ").slice(0, 300);
  } catch {
    return "non-JSON error response (body withheld)";
  }
}

/** Discovery uses exactly the same app+jwt and configured selector as inference. */
export function createAgentModelsFetcher(
  auth: AgentInferenceAuth, agentId: string, nodeUrl: string | undefined, modelsPath: string,
  fetcher: typeof fetch = (...args) => fetch(...args),
): ImajinCatalogFetcher {
  return async () => {
    const identity = auth.identity(agentId);
    if (!nodeUrl) throw new InferenceAuthError(agentId, "nodeUrl is required");
    let token: string;
    try { ({ token } = await auth.credential(agentId)); }
    catch (error) {
      const status = error instanceof InferenceAuthError ? error.status : undefined;
      throw new ImajinDiscoveryError("auth-error", `agents.${agentId} app-token discovery authentication unavailable`, status);
    }
    const selector = identity.config.actAs;
    let response: Response;
    try {
      response = await fetcher(`${nodeUrl.replaceAll(/\/$/g, "")}${modelsPath}`, {
        method: "GET", redirect: "error", signal: AbortSignal.timeout(5_000),
        headers: { Authorization: `Bearer ${token}`,
          ...(selector ? { "x-acting-as": selector } : {}) },
      });
    } catch {
      throw new ImajinDiscoveryError("unreachable", "kernel model discovery transport unavailable");
    }
    if (auth.identity(agentId) !== identity || identity.config.actAs !== selector) {
      throw new InferenceAuthError(agentId, "identity runtime changed during discovery");
    }
    let text: string;
    try { text = await response.text(); }
    catch { throw new ImajinDiscoveryError("unreachable", "kernel model discovery body unavailable"); }
    if (!response.ok) {
      const detail = kernelErrorDetail(text, token);
      const kind = response.status === 401 || response.status === 403 ? "auth-error" : "route-error";
      if (response.status === 401) auth.invalidate(agentId, token);
      throw new ImajinDiscoveryError(kind, `agents.${agentId} GET ${modelsPath}: ${detail}`, response.status);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ImajinDiscoveryError("malformed", "kernel models response is not JSON");
    }
  };
}
