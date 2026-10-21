import { CloudflareRequestError, validateDid, type CloudflareResource, type ImajinClient } from "./client.js";

interface Schema {
  type: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: Schema;
  enum?: readonly string[];
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  description?: string;
  default?: boolean;
}
function rejectDnsProxyField(params: CloudflareToolParams): void {
  if (["dns_create", "dns_update"].includes(params?.action) &&
    params.record && Object.hasOwn(params.record, "proxied")) {
    throw new CloudflareRequestError(409, "proxy_approval_required");
  }
}

const string = (description: string): Schema => ({ type: "string", minLength: 1, description });
const object = (properties: Record<string, Schema>, required: string[] = []): Schema =>
  ({ type: "object", properties, required, additionalProperties: false });
const id: Schema = { type: "string", pattern: "^[a-f0-9]{32}$" };
const boolean: Schema = { type: "boolean" };
const record = object({
  type: string("DNS type, e.g. A, AAAA, CNAME or TXT"),
  name: string("DNS record name"),
  content: string("DNS record content"),
  ttl: { type: "integer", minimum: 1 },
});
const ttl = object({
  mode: { type: "string", enum: ["respect_origin", "bypass_by_default", "override_origin"] },
  default: { type: "integer", minimum: 1 },
}, ["mode"]);
const cacheRule = object({
  ref: { type: "string", maxLength: 64 },
  description: { type: "string" },
  expression: string("Cloudflare cache expression"),
  action: { type: "string", enum: ["set_cache_settings"] },
  enabled: boolean,
  action_parameters: object({ cache: boolean, edge_ttl: ttl }),
}, ["expression", "action", "action_parameters", "enabled"]);

const actions = [
  "dns_list", "dns_create", "dns_update", "dns_delete", "proxy_set", "bulk_proxy",
  "settings", "ssl", "cache_rules_list", "cache_rules_replace", "hostnames_list",
  "hostname_create", "hostname_status", "hostname_delete", "history", "classification",
] as const;

const parameters = object({
  action: { type: "string", enum: actions },
  zoneId: id,
  domain: {
    ...string("Exact lowercase verified zone domain, not a subdomain"),
    maxLength: 253,
    pattern: String.raw`^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`,
  },
  recordId: id,
  record,
  proxied: boolean,
  changes: {
    type: "array", minItems: 1, maxItems: 20,
    items: object({ recordId: id, proxied: boolean }, ["recordId", "proxied"]),
  },
  rules: { type: "array", maxItems: 20, items: cacheRule },
  dryRun: { type: "boolean", default: true, description: "proxy_set/bulk_proxy/cache_rules_replace: preview by default; false stages human approval only" },
  hostnameId: { type: "string", pattern: "^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$" },
  hostname: string("Custom hostname to create"),
  ssl: object({
    method: { type: "string", enum: ["txt", "http"] },
    type: { type: "string", enum: ["dv"] },
  }, ["method", "type"]),
  onBehalfOf: string('Optional delegation DID; defaults to actAs. "self" suppresses delegation, never changes the authenticated agent DID.'),
}, ["action", "zoneId", "domain"]);

export interface CloudflareToolParams {
  action: string;
  zoneId: string;
  domain: string;
  onBehalfOf?: string;
  recordId?: string;
  record?: { type?: string; name?: string; content?: string; ttl?: number };
  proxied?: boolean;
  dryRun?: boolean;
  changes?: Array<{ recordId: string; proxied: boolean }>;
  rules?: Array<{
    ref?: string; description?: string; expression: string; action: "set_cache_settings"; enabled: boolean;
    action_parameters: { cache?: boolean; edge_ttl?: { mode: string; default?: number } };
  }>;
  hostnameId?: string;
  hostname?: string;
  ssl?: { method: "txt" | "http"; type: "dv" };
}

function invalid(field: string): never {
  throw new CloudflareRequestError(400, `invalid_${field}`);
}

// Match the published schema even when execute is called without host validation.
// Unknown properties are rejected rather than forwarding arbitrary credential fields.
function validate(value: unknown, schema: Schema, field: string): void {
  if (schema.type === "object") return validateObject(value, schema, field);
  if (schema.type === "array") return validateArray(value, schema, field);
  if (schema.type === "string") return validateString(value, schema, field);
  if (schema.type === "boolean") {
    if (typeof value !== "boolean") invalid(field);
    return;
  }
  if (typeof value !== "number" || !Number.isInteger(value) ||
    value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) invalid(field);
}

function validateString(value: unknown, schema: Schema, field: string): void {
  if (typeof value !== "string") invalid(field);
  if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)) invalid(field);
  if (schema.enum && !schema.enum.includes(value)) invalid(field);
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) invalid(field);
}

function validateArray(value: unknown, schema: Schema, field: string): void {
  if (!Array.isArray(value)) invalid(field);
  if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) invalid(field);
  for (const item of value) validate(item, schema.items!, field);
}

function validateObject(value: unknown, schema: Schema, field: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(field);
  const values = value as Record<string, unknown>;
  for (const key of schema.required ?? []) {
    if (values[key] === undefined) invalid(key);
  }
  for (const [key, entry] of Object.entries(values)) {
    const properties = schema.properties ?? {};
    if (!Object.hasOwn(properties, key)) invalid(field);
    if (entry !== undefined) validate(entry, properties[key], key);
  }
}

interface Operation {
  resource: CloudflareResource;
  method?: "POST" | "PUT" | "PATCH" | "DELETE";
  required?: Array<keyof CloudflareToolParams>;
}
const operations: Record<string, Operation> = {
  dns_list: { resource: "dns" },
  dns_create: { resource: "dns", method: "POST", required: ["record"] },
  dns_update: { resource: "dns", method: "PATCH", required: ["recordId", "record"] },
  dns_delete: { resource: "dns", method: "DELETE", required: ["recordId"] },
  proxy_set: { resource: "bulk", method: "POST", required: ["recordId", "proxied"] },
  bulk_proxy: { resource: "bulk", method: "POST", required: ["changes"] },
  settings: { resource: "settings" },
  ssl: { resource: "ssl" },
  cache_rules_list: { resource: "cache-rules" },
  cache_rules_replace: { resource: "cache-rules", method: "PUT", required: ["rules"] },
  hostnames_list: { resource: "custom-hostnames" },
  hostname_create: { resource: "custom-hostnames", method: "POST", required: ["hostname", "ssl"] },
  hostname_status: { resource: "custom-hostnames", required: ["hostnameId"] },
  hostname_delete: { resource: "custom-hostnames", method: "DELETE", required: ["hostnameId"] },
  history: { resource: "history" },
  classification: { resource: "classification" },
};

function operationBody(params: CloudflareToolParams): unknown {
  if (params.dryRun !== undefined && !["proxy_set", "bulk_proxy", "cache_rules_replace"].includes(params.action)) {
    invalid("dryRun");
  }
  switch (params.action) {
    case "dns_create":
      validate(params.record, { ...record, required: ["type", "name", "content", "ttl"] }, "record");
      return params.record;
    case "dns_update":
      if (Object.values(params.record!).every(value => value === undefined)) invalid("record");
      return params.record;
    case "proxy_set": return {
      domain: params.domain,
      changes: [{ recordId: params.recordId, proxied: params.proxied }],
      dryRun: params.dryRun ?? true,
    };
    case "bulk_proxy": return { domain: params.domain, changes: params.changes, dryRun: params.dryRun ?? true };
    case "cache_rules_replace": return { domain: params.domain, rules: params.rules, dryRun: params.dryRun ?? true };
    case "hostname_create": return { hostname: params.hostname, ssl: params.ssl };
    default: return undefined;
  }
}

export function createCloudflareTool(client: ImajinClient) {
  return {
    name: "imajin_cloudflare",
    label: "Imajin Cloudflare",
    description:
      "Operate verified Cloudflare zones through Imajin kernel routes only. " +
      "The kernel attributes every change to the agent DID, on behalf of the zone owner from the grant; " +
      "onBehalfOf never substitutes for that attribution. Seal the zone token on /jin, then grant the agent DID " +
      "the zone capabilities on the zone card. Never supply or fetch a token here. " +
      "Actions: DNS list/create/update/delete (creation is DNS-only; never include proxied in create/update); " +
      "single-record proxy_set via the bulk approval rail; bulk_proxy; read-only classification; settings; ssl; " +
      "cache_rules_list/replace; hostnames_list, hostname_create/status/delete; signed history. " +
      "Every action requires zoneId and the exact verified domain. proxy_set, bulk_proxy and cache_rules_replace " +
      "default dryRun=true and return the before/after preview unchanged; false only stages a proposal. " +
      "Pending — approve on /jin (proposal id): a human must countersign in Operator approvals. " +
      "Proxy changes require kernel classification and a human countersignature on /jin; " +
      "classification only reads the kernel's per-host decisions, blocking routes and remedies. " +
      "Nothing changes until then. This tool cannot approve, seal, import, or override classification.",
    parameters,
    async execute(_id: string, params: CloudflareToolParams) {
      try {
        rejectDnsProxyField(params);
        validate(params, parameters, "request");
        if (params.onBehalfOf && params.onBehalfOf !== "self" && !validateDid(params.onBehalfOf)) {
          invalid("onBehalfOf");
        }
        const operation = operations[params.action];
        for (const field of operation.required ?? []) {
          if (params[field] === undefined) invalid(field);
        }
        const idField = operation.required?.find(field =>
          field === "hostnameId" || (field === "recordId" && operation.resource === "dns"));
        const result = await client.cloudflareRequest(params.zoneId, params.domain, operation.resource, {
          method: operation.method,
          id: idField ? String(params[idField]) : undefined,
          body: operationBody(params),
          onBehalfOf: params.onBehalfOf,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        const known = error instanceof CloudflareRequestError;
        return {
          content: [{ type: "text" as const, text: `Error: ${known ? error.message : "Cloudflare request unavailable"}` }],
          details: { error: true, status: known ? error.status : 503, code: known ? error.code : "cloudflare_request_failed" },
        };
      }
    },
  };
}
