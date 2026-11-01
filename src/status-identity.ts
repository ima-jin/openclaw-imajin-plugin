import type { ImajinClient } from "./client.js";

/** Explicit projection: no signer, config object, cookie, or provider diagnostics. */
export function buildStatusIdentity(options: {
  agentId?: string;
  mode: "map" | "legacy";
  did?: string;
  actAs?: string;
  isGatewayAgent: boolean;
  keypairSource?: string;
  client?: ImajinClient;
  ws?: { state: string };
  warnings?: string[];
}) {
  const held = options.client?.identityStatus();
  return {
    agentId: options.agentId ?? null,
    mode: options.mode,
    did: held?.did ?? options.did ?? null,
    ...(options.actAs === undefined ? {} : { actAs: options.actAs }),
    isGatewayAgent: options.isGatewayAgent,
    keypairSource: options.keypairSource ?? null,
    publicKey: held?.publicKey ?? null,
    auth: held?.auth ?? null,
    ws: options.ws ?? { state: "not-started" },
    warnings: [...(options.warnings ?? [])],
  };
}

export type StatusIdentity = ReturnType<typeof buildStatusIdentity>;
