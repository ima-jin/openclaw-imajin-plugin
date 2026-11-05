import { randomBytes } from "node:crypto";
import type { AgentIdentity } from "./agent-identities.js";
import type { ImajinClient } from "./client.js";

export class SelfAuthorizeError extends Error {}

interface Registration {
  id: string;
  appDid: string;
  status: string;
  requestedScopes: string[];
}

const SETUP = "App registration missing or inaccessible; register this agent's DID at /auth/developer/apps";
const PAGE_SIZE = 100;
const MAX_PAGES = 100;

function registration(value: unknown, did: string): Registration {
  const app = value as Partial<Registration> | null;
  if (app?.appDid !== did || typeof app.id !== "string" || !/^app_[\w-]+$/.test(app.id)
    || app.status !== "active" || !Array.isArray(app.requestedScopes)
    || !app.requestedScopes.every((scope) => typeof scope === "string" && /^[a-z][a-z0-9_-]*:[a-z][a-z0-9:_-]*$/.test(scope))) {
    throw new SelfAuthorizeError("Invalid or inactive app registration; check /auth/developer/apps");
  }
  return app as Registration;
}

function checkStatus(status: number, operation: string): void {
  if (status === 404) throw new SelfAuthorizeError(SETUP);
  if (status < 200 || status >= 300) {
    throw new SelfAuthorizeError(`Kernel ${operation} refused (HTTP ${status}); check this agent's session and app at /auth/developer/apps`);
  }
}

async function registrationPage(client: ImajinClient, did: string, owner: boolean, page: number) {
  const response = await client.requestRaw(
    `/api/registry/apps?${owner ? "owner=me&" : ""}limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`,
    { redirect: "error", signal: AbortSignal.timeout(20_000) },
  );
  checkStatus(response.status, "app lookup");
  const body = JSON.parse(response.text) as { apps?: unknown };
  if (!body || !Array.isArray(body.apps)) throw new SelfAuthorizeError("Invalid kernel app list response");
  const matches = body.apps.filter((app) => app?.appDid === did);
  if (matches.length > 1) throw new SelfAuthorizeError("Ambiguous app registration; check /auth/developer/apps");
  return { app: matches.length === 1 ? registration(matches[0], did) : undefined,
    hasMore: body.apps.length >= PAGE_SIZE };
}

async function scanRegistrations(client: ImajinClient, did: string, owner: boolean) {
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await registrationPage(client, did, owner, page);
    if (result.app) return result.app;
    if (!result.hasMore) return undefined;
  }
  throw new SelfAuthorizeError("App lookup limit reached; check /auth/developer/apps");
}

/** No appDid read filter exists in the registry spec. Never guess an app id. */
async function findRegistration(client: ImajinClient, did: string): Promise<Registration> {
  // Owner reads use configured actAs (including org owners), not the raw session DID.
  // Public reads cover apps registered by another owner; internal apps require owner access.
  for (const owner of [true, false]) {
    const app = await scanRegistrations(client, did, owner);
    if (app) return app;
  }
  throw new SelfAuthorizeError(SETUP);
}

export interface SelfAuthorizeOptions {
  callerId?: string;
  sessionKey?: string;
  operatorAgentId: string;
  getIdentity: (agentId: string) => AgentIdentity | undefined;
  assertCurrent: () => void;
  rediscover: (agentId: string) => Promise<string[]>;
}

/** Only explicit tool invocation reaches this function; never a startup hook. */
export function createSelfAuthorizer(options: SelfAuthorizeOptions) {
  return async (target?: string) => {
    const caller = options.callerId;
    if (!caller || (options.sessionKey !== undefined && !options.sessionKey.startsWith(`agent:${caller}:`))) {
      throw new SelfAuthorizeError("Trusted calling-agent context required");
    }
    const agentId = target ?? caller;
    if (typeof agentId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(agentId)) {
      throw new SelfAuthorizeError("Invalid agent id");
    }
    if (agentId !== caller && caller !== options.operatorAgentId) {
      throw new SelfAuthorizeError("Only the operator/main agent may target another agent");
    }
    const identity = options.getIdentity(agentId);
    if (!identity || identity.signer.did !== identity.config.did
      || identity.client.identityStatus().did !== identity.config.did) {
      throw new SelfAuthorizeError("Target agent's sealed signing identity unavailable");
    }
    const assertCurrent = () => {
      options.assertCurrent();
      if (options.getIdentity(agentId) !== identity) throw new SelfAuthorizeError("Agent identity runtime changed");
    };
    try {
      assertCurrent();
      const app = await findRegistration(identity.client, identity.config.did);
      assertCurrent();
      // Self-consent is never acting-as the owner/org or another agent.
      // Kernel upsertAppAuthorization owns scope-set idempotence and signed history.
      const response = await identity.client.requestRaw("/api/auth/authorize", {
        method: "POST", onBehalfOf: "self", redirect: "error", signal: AbortSignal.timeout(20_000),
        body: { appId: app.id, scopes: app.requestedScopes, state: randomBytes(32).toString("hex") },
      });
      checkStatus(response.status, "consent");
      // Discard the response completely: redirect/code is not a credential for this tool.
      assertCurrent();
    } catch (error) {
      if (error instanceof SelfAuthorizeError) throw error;
      throw new SelfAuthorizeError("Agent self-authorization unavailable; check kernel/session and /auth/developer/apps");
    }
    try {
      const models = await options.rediscover(agentId);
      assertCurrent();
      return { authorized: true, agentId, did: identity.config.did, discovery: "ok", models };
    } catch {
      // Consent already persisted. Never report it as failed or automatically repeat it.
      return { authorized: true, agentId, did: identity.config.did, discovery: "retry-required",
        next: "Consent succeeded; model discovery unavailable. Retry self_authorize to refresh discovery." };
    }
  };
}
