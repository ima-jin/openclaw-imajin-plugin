import { resolveApprovalOverGateway } from "openclaw/plugin-sdk/approval-gateway-runtime";
import { ApprovalBridge, isApprovalDecisionFrame, type GatewayApprovalDecision, type GatewayApprovalKind } from "./approval-bridge.js";
import { startGatewayApprovalsBridge, type ApprovalsBridgePluginConfig, type StartGatewayApprovalsBridgeDeps } from "./gateway-approvals-bridge.js";
import type { ImajinClient, ImajinSigner } from "./client.js";
import type { ImajinWsService } from "./ws-service.js";
import type { WsNotificationsConfig } from "./notification-injector.js";
import type { LoopLifecycle } from "./loop-hooks.js";
import { createIdentityClientOperatorKeyResolver } from "./operator-signature.js";
import { createSessionCommandAttester, createSessionCommandExecutor, isSessionCommandFrame, type SessionCommandExecutor } from "./session-commands.js";
import { createLoopbackSessionGateway, type LoopbackSessionGateway } from "./session-command-gateway.js";
import type { SessionInventory } from "./session-inventory.js";
import { ApprovalExecutionRegistry } from "./approval-execution.js";
import type { RegistrationLifecycle } from "./registration-lifecycle.js";

/** `plugins.entries.imajin.config.approvalBridge` (openclaw.json, #1816). */
export interface ApprovalBridgeSettings {
  /**
   * Ed25519 public key (hex) pinned as the sole trusted approver for
   * `approval.decision` attestations. Channel-trust (the authenticated WS
   * session) is never sufficient on its own — every decision must carry a
   * valid signature from exactly this key.
   */
  pinnedApproverPublicKeyHex?: string;
}

/**
 * `plugins.entries.imajin.config.sessionCommands` (openclaw.json, #51).
 * Opt-in: a signed command can steer sessions and resolve approvals, so it is
 * never on by default.
 */
export interface SessionCommandsSettings {
  enabled?: boolean;
  /** Ed25519 public key (hex) pinned as the only trusted kernel command signer. Required. */
  kernelPublicKeyHex?: string;
  /** When set, a command's `issuer` must equal this DID. */
  kernelDid?: string;
  /** Default true. false skips the principal countersignature (the kernel grant is always required). */
  requirePrincipalCountersignature?: boolean;
}

export interface GatewayFeaturesConfig {
  nodeUrl: string;
  did?: string;
  actAs?: string;
  keypairPath?: string;
  signer?: ImajinSigner;
  localAgentId?: string;
  approvalBridge?: ApprovalBridgeSettings;
  approvals?: ApprovalsBridgePluginConfig;
  sessionCommands?: SessionCommandsSettings;
  wsNotifications?: WsNotificationsConfig;
}

function toGatewayDecision(decision: GatewayApprovalDecision): "allow-once" | "deny" {
  return decision === "approve" ? "allow-once" : "deny";
}

function createApprovalBridge(
  api: any,
  config: GatewayFeaturesConfig,
  wsService: ImajinWsService,
  approvalExecutions: ApprovalExecutionRegistry,
): ApprovalBridge | undefined {
  const keypairPath = config.keypairPath;
  if (!keypairPath && !config.signer) return undefined;
  let approvalBridge: ApprovalBridge | undefined;
  if (config.did && config.approvalBridge?.pinnedApproverPublicKeyHex) {
    approvalBridge = new ApprovalBridge(
      {
        did: config.did,
        keypairPath,
        signer: config.signer,
        pinnedApproverPublicKeyHex: config.approvalBridge.pinnedApproverPublicKeyHex,
      },
      (frame) => wsService.send(frame),
    );

    // Decision leg: only a signature-verified `approve`/`reject` ever
    // reaches here (ApprovalBridge.handleFrame already rejected + logged
    // anything expired, mismatched, or unsigned) — this is the one place
    // that actually resolves the OpenClaw gateway's pending approval.
    // No `reviewer` identity is passed: this bridge is not a registered
    // channel route for the request (see the channel integration notes in index.ts),
    // so custody checks that key off a channel/accountId/senderId triple
    // don't apply here; omitting all three is the documented no-reviewer form.
    approvalBridge.onResolved(async (requestId, decision, kind: GatewayApprovalKind) => {
      if (!approvalExecutions.claim(requestId)) return;
      try {
        const result = await resolveApprovalOverGateway({
          cfg: api.config,
          approvalId: requestId,
          approvalKind: kind,
          decision: toGatewayDecision(decision),
          clientDisplayName: "Imajin /jin approval",
        });
        console.log(
          `[imajin-approval] gateway resolve ${requestId} -> applied=${result.applied}, status=${result.approval.status}`,
        );
      } catch (err) {
        console.error(`[imajin-approval] gateway resolve failed for ${requestId}:`, err);
      }
    });
  } else if (config.approvalBridge?.pinnedApproverPublicKeyHex) {
    console.warn(
      "[imajin-plugin] approvalBridge.pinnedApproverPublicKeyHex is set but no agent `did` " +
        "is configured — the approval bridge will not be registered",
    );
  }

  return approvalBridge;
}

function createSessionCommands(
  config: GatewayFeaturesConfig,
  client: ImajinClient,
  loopLifecycle: LoopLifecycle | undefined,
  wsService: ImajinWsService,
  approvalExecutions: ApprovalExecutionRegistry,
  sessionGateway: LoopbackSessionGateway | undefined,
  inventory: SessionInventory | undefined,
): SessionCommandExecutor | undefined {
  const keypairPath = config.keypairPath;
  if (!keypairPath && !config.signer) return undefined;
  let sessionCommandExecutor: SessionCommandExecutor | undefined;
  if (config.sessionCommands?.enabled === true) {
    const settings = config.sessionCommands;
    if (!config.did || !settings.kernelPublicKeyHex || (!loopLifecycle && !config.localAgentId) || !sessionGateway) {
      console.warn(
        "[imajin-plugin] sessionCommands.enabled needs an agent `did` and " +
          "sessionCommands.kernelPublicKeyHex with loop lifecycle tracking enabled — session commands will not be accepted",
      );
    } else {
      const keyResolver = createIdentityClientOperatorKeyResolver(client);
      sessionCommandExecutor = createSessionCommandExecutor(
        {
          agentDid: config.did,
          localAgentId: config.localAgentId,
          kernelPublicKeyHex: settings.kernelPublicKeyHex,
          kernelDid: settings.kernelDid,
          allowedPrincipal: config.actAs,
          requirePrincipalCountersignature: settings.requirePrincipalCountersignature,
        },
        {
          gateway: sessionGateway.gateway,
          publishHistory: inventory?.history,
          refreshInventory: inventory?.refresh,
          loopTracker: loopLifecycle?.tracker,
          executionRegistry: approvalExecutions,
          attest: createSessionCommandAttester({
            did: config.did,
            keypairPath,
            signer: config.signer,
            send: (frame) => wsService.send(frame),
          }),
          resolveServiceOf: (agentDid) => client.getServiceOf(agentDid),
          resolvePublicKey: (did) => keyResolver.resolveOperatorPublicKey(did),
        },
      );
      console.log("[imajin-plugin] session command executor enabled");
    }
  }

  return sessionCommandExecutor;
}

/** One gateway authority path, supplied either a legacy file identity or a sealed agent identity. */
export function registerGatewayFeatures(
  api: any, config: GatewayFeaturesConfig, client: ImajinClient, wsService: ImajinWsService,
  lifecycle: RegistrationLifecycle,
  options: {
    loopLifecycle?: LoopLifecycle;
    sessionGateway?: LoopbackSessionGateway;
    inventory?: SessionInventory;
    imajinCatalog?: NonNullable<StartGatewayApprovalsBridgeDeps["imajinCatalog"]>;
  } = {},
): { approvalBridge?: ApprovalBridge; handleFrame: (frame: unknown) => boolean } {
  const { loopLifecycle, inventory, imajinCatalog } = options;
  let sessionGateway = options.sessionGateway;
  if (config.localAgentId && !sessionGateway && config.sessionCommands?.enabled && config.sessionCommands.kernelPublicKeyHex) {
    sessionGateway = createLoopbackSessionGateway({
      getConfig: () => api.runtime?.config?.current?.() ?? api.config ?? {},
    });
    const owned = sessionGateway;
    lifecycle.add(() => owned.dispose());
    void owned.start().catch(() => console.warn("[imajin-sessions] command gateway unavailable"));
  }
  const approvalExecutions = new ApprovalExecutionRegistry();
  const approvalBridge = createApprovalBridge(api, config, wsService, approvalExecutions);

  // Session command executor (#51): signed, DID-addressed session commands
  // arrive over this same outbound WS, are verified, executed against the
  // local gateway, and attested back as signed `loop.session.*` frames.
  // Opt-in; needs the agent DID + a pinned kernel command-signing key.
  const sessionCommandExecutor = createSessionCommands(
    config, client, loopLifecycle, wsService, approvalExecutions,
    sessionGateway, inventory,
  );

  // Gateway approvals bridge (#24): publishes staged Gateway system-agent
  // proposals to the kernel and applies signed operator decisions back to
  // the Gateway. Off unless `approvals.enabled` + `approvals.operatorDid`
  // (+ the token/secret it needs) are configured — see
  // `src/gateway-approvals-bridge.ts` for the full trust chain. Started
  // fire-and-forget so a slow/unavailable Gateway loopback connection can
  // never delay the kernel WebSocket service start.
  let approvalsBridgeFrameHandler: ((frame: unknown) => void) | undefined;
  const approvalsBridgeReady = startGatewayApprovalsBridge(api, config.approvals, {
    signal: lifecycle.signal,
    did: config.did,
    keypairPath: config.keypairPath,
    signer: config.signer,
    nodeUrl: config.nodeUrl,
    // Reuses this plugin's EXISTING DID resolver (#44) to verify an
    // operator's countersignature on `operator.approval.decided`
    // against their registered public key — never a second resolver.
    identityClient: client,
    // #53: the same challenge-response session, reused for the
    // `operator:approvals` entitlement preflight + decided-event catch-up.
    kernelHttp: client,
    stateDir: config.wsNotifications?.stateDir,
    directSend: config.wsNotifications?.directSend,
    // #64: a pending approval blocks its owning loop on the loops rail.
    loopTracker: loopLifecycle?.tracker,
    executionRegistry: approvalExecutions,
    publishApprovalBinding: (attestation) => {
      wsService.send({ type: "loop.approval.bound", attestation });
      return Promise.resolve();
    },
    // Wires the opt-in "imajin-catalog" source (#36 item 3) so it can be
    // enabled via `approvals.sources` alongside system-agent/skill-
    // workshop. The source reads live policy through config RPCs and
    // only a successful discovery may propose changes.
    imajinCatalog,
  })
    .then((started) => {
      if (!lifecycle.active) {
        started?.dispose();
        return undefined;
      }
      if (started) lifecycle.add(() => started.dispose());
      approvalsBridgeFrameHandler = started?.onKernelFrame;
      return started;
    })
    .catch(() => {
      console.error("[imajin-approvals-bridge] failed to start");
      return undefined;
    });

  // #53: on EVERY (re)connect, after the kernel's auth-ok, re-verify the
  // agent still holds `operator:approvals` and replay any
  // `operator.approval.decided` the socket missed. Awaits bridge startup so
  // a connect that races registration is not dropped.
  wsService.onConnected(async () => {
    void inventory?.refresh().catch(() => console.warn("[imajin-sessions] kernel reconnect inventory unavailable"));
    const started = await approvalsBridgeReady;
    if (lifecycle.active) await started?.onKernelConnected();
  });

  return {
    approvalBridge,
    handleFrame(frame) {
      if (!lifecycle.active) return false;
      if (!frame || typeof frame !== "object" || !("type" in frame)) return false;
      if (approvalBridge && isApprovalDecisionFrame(frame)) {
        void approvalBridge.handleFrame(frame).catch(() => console.error("[imajin-approval] frame handling failed"));
      } else if (sessionCommandExecutor && isSessionCommandFrame(frame)) {
        void sessionCommandExecutor.handleFrame(frame).catch(() => console.error("[imajin-session-commands] frame handling failed"));
      } else if (frame.type === "bus_event") {
        approvalsBridgeFrameHandler?.(frame);
      } else {
        return false;
      }
      return true;
    },
  };
}
