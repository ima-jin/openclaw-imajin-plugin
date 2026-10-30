import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { ImajinClient, validateDid } from "./client.js";
import { signerFromValue } from "./agent-identities.js";

const FAILURE = "imajin-vault: resolution unavailable";
const MAX_BYTES = 262144;
const MAX_IDS = 64;
type RecordValue = Record<string, unknown>;

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$/.test(value)
    && !value.split("/").some((part) => part === "." || part === "..");
}

function absolutePath(value: unknown): value is string {
  return typeof value === "string" && isAbsolute(value);
}

export interface VaultExecConfig {
  gatewayConfigPath: string;
  consumerDid: string;
  grants: Record<string, string>;
}

export function parseVaultExecConfig(value: unknown): VaultExecConfig {
  if (!record(value) || !absolutePath(value.gatewayConfigPath)
    || typeof value.consumerDid !== "string" || !validateDid(value.consumerDid)
    || !record(value.grants)
    || Object.keys(value).some((key) => !["gatewayConfigPath", "consumerDid", "grants"].includes(key))) {
    throw new Error(FAILURE);
  }
  const entries = Object.entries(value.grants);
  if (!entries.length || entries.length > MAX_IDS
    || entries.some(([id, grant]) => !validId(id) || typeof grant !== "string"
      || !/^[A-Za-z0-9_-]{1,256}$/.test(grant))) throw new Error(FAILURE);
  return value as unknown as VaultExecConfig;
}

function parseRequest(raw: string): string[] {
  if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error(FAILURE);
  const request: unknown = JSON.parse(raw);
  if (!record(request) || request.protocolVersion !== 1 || request.provider !== "imajin-vault"
    || Object.keys(request).some((key) => !["protocolVersion", "provider", "ids"].includes(key))
    || !Array.isArray(request.ids) || !request.ids.length || request.ids.length > MAX_IDS
    || !request.ids.every(validId) || new Set(request.ids).size !== request.ids.length) {
    throw new Error(FAILURE);
  }
  return request.ids;
}

/** No redirects, ambient cookies, disk cache, or unbounded network requests. */
const transport: typeof fetch = async (url, init) => {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  const response = await fetch(url, {
    ...init, headers, redirect: "error", credentials: "omit",
    signal: AbortSignal.timeout(5000),
  });
  return new Response(await readBounded(response), { status: response.status, headers: response.headers });
};

async function readBounded(response: Response): Promise<string> {
  if (!response.body) throw new Error(FAILURE);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error(FAILURE);
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function loadBootstrap(config: VaultExecConfig) {
  const gateway = JSON.parse(await readFile(config.gatewayConfigPath, "utf8"));
  const entry = gateway?.plugins?.entries?.imajin;
  const main = entry?.config;
  if (entry?.enabled !== true || main?.did !== config.consumerDid
    || !absolutePath(main?.keypairPath) || typeof main?.nodeUrl !== "string") throw new Error(FAILURE);
  const url = new URL(main.nodeUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || url.pathname !== "/") throw new Error(FAILURE);
  // Reuse ONLY the already-configured bootstrap identity, never the target ref.
  const signer = await signerFromValue(await readFile(main.keypairPath, "utf8"), config.consumerDid);
  const client = new ImajinClient({ nodeUrl: url.origin, did: config.consumerDid, signer, transport });
  return { client, origin: url.origin };
}

function grantValue(raw: string): string {
  const body: unknown = JSON.parse(raw);
  if (!record(body) || body.ok !== true || typeof body.value !== "string" || !body.value.length
    || typeof body.field !== "string" || !body.field.length
    || (body.purpose !== null && typeof body.purpose !== "string")
    || body.oneTime !== false
    || (body.expiresAt !== null && (typeof body.expiresAt !== "string"
      || !Number.isFinite(Date.parse(body.expiresAt)) || Date.parse(body.expiresAt) <= Date.now()))) {
    throw new Error(FAILURE);
  }
  return body.value;
}

/** Called only by the gateway's exec resolver; values go to its private pipe. */
export async function resolveVaultExec(raw: string, input: unknown): Promise<string> {
  try {
    const ids = parseRequest(raw);
    const config = parseVaultExecConfig(input);
    const values: Record<string, string> = Object.create(null);
    const errors: Record<string, { code: string }> = Object.create(null);
    // Lazy bootstrap: an unmapped ref never authenticates or guesses a grant.
    let bootstrap: Awaited<ReturnType<typeof loadBootstrap>> | undefined;
    for (const id of ids) {
      try {
        if (!Object.hasOwn(config.grants, id)) throw new Error(FAILURE);
        bootstrap ??= await loadBootstrap(config);
        const cookie = await bootstrap.client.authenticatedCookie();
        const response = await transport(
          `${bootstrap.origin}/auth/api/vault/delegation/grants/${encodeURIComponent(config.grants[id])}/fetch`,
          { method: "POST", headers: {
            Cookie: cookie, "X-Agent-DID": config.consumerDid,
            "Content-Type": "application/json", Accept: "application/json",
          }, body: "{}" },
        );
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(FAILURE);
        }
        values[id] = grantValue(await readBounded(response));
      } catch {
        // Never return upstream messages, status text, cookies, or parser excerpts.
        errors[id] = { code: "UNAVAILABLE" };
      }
    }
    const output = JSON.stringify({ protocolVersion: 1, values, errors });
    if (Buffer.byteLength(output) > MAX_BYTES) throw new Error(FAILURE);
    return output;
  } catch {
    throw new Error(FAILURE);
  }
}

/** Single request per process. No resolved value or cookie survives a refresh. */
export async function runVaultExec(
  args: string[], stdin: AsyncIterable<string | Buffer>,
  stdout: (value: string) => void, stderr: (value: string) => void,
): Promise<number> {
  try {
    if (args.length !== 2 || args[0] !== "--config" || !absolutePath(args[1])) throw new Error(FAILURE);
    let raw = "";
    for await (const chunk of stdin) {
      raw += chunk.toString();
      if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error(FAILURE);
    }
    const config: unknown = JSON.parse(await readFile(args[1], "utf8"));
    stdout(`${await resolveVaultExec(raw, config)}\n`);
    return 0;
  } catch {
    stderr(`${FAILURE}\n`);
    return 1;
  }
}
