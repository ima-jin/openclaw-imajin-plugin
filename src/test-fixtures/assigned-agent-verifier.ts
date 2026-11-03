import { verify, type KeyObject } from "node:crypto";

interface VerifiedAppContext {
  appDid: string;
  userDid: string;
  scopes: string[];
  attestationId: string;
}

interface Controller {
  valid: boolean;
  role?: string;
  allowedServices?: string[] | null;
}

/**
 * Test-only contract model of imajin-ai PR #3236 at 0d85c381:
 * token/verify maps azp -> appDid and sub -> userDid; requireAppAuth then
 * calls validateActingAs(userDid, selector, "infer") against live controllers.
 * No sub=azp shortcut, selector-to-sub rewrite or group-self authority.
 * The kernel itself is not imported or changed by these plugin tests.
 */
export function verifyAssignedAgentRequest(
  headers: Headers,
  kernelPublicKey: KeyObject,
  controller: (principalDid: string, callerDid: string) => Controller,
): { status: number; appAuth?: VerifiedAppContext & { actingAs?: string } } {
  const token = headers.get("authorization")?.slice(7) ?? "";
  const appAuth = verifyToken(token, kernelPublicKey);
  if (!headers.get("authorization")?.startsWith("Bearer ") || !appAuth) return { status: 401 };
  if (!appAuth.scopes.includes("infer:completions")) return { status: 403 };
  const actingAs = headers.get("x-acting-as");
  if (!actingAs) return { status: 200, appAuth };
  const authority = controller(actingAs, appAuth.userDid);
  if (!authority.valid || !["owner", "admin", "maintainer", "agent"].includes(authority.role ?? "")) {
    return { status: 403 };
  }
  if (authority.allowedServices?.includes("infer") === false) return { status: 403 };
  return { status: 200, appAuth: { ...appAuth, actingAs } };
}

function verifyToken(token: string, publicKey: KeyObject): VerifiedAppContext | undefined {
  try {
    const [head, body, signature] = token.split(".");
    if (!verify(null, Buffer.from(`${head}.${body}`), publicKey, Buffer.from(signature, "base64url"))) return;
    const header = JSON.parse(Buffer.from(head, "base64url").toString("utf8"));
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (header.typ !== "app+jwt" || header.alg !== "EdDSA" || claims.iss !== "auth.imajin.ai"
      || claims.aud !== "imajin:apps" || claims.exp <= Date.now() / 1000) return;
    return {
      appDid: claims.azp, userDid: claims.sub,
      scopes: claims.scope.split(" ").filter(Boolean), attestationId: claims.attestationId,
    };
  } catch {
    return undefined;
  }
}
