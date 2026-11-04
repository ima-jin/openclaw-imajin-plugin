import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createIdentityCardTool } from "./identity-card.js";
import { channelRows, githubRow, inferenceRow, publicText } from "./identity-card-facts.js";
import { ImajinClient } from "./client.js";
import { publicKeyDid, type AgentIdentity } from "./agent-identities.js";
import { verifyMessage } from "./approval-bridge.js";
import { InferenceAuthError } from "./inference-auth.js";

const proxy = "http://127.0.0.1:8787/openai/v1";
function agent(actAs?: string): AgentIdentity {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const did = publicKeyDid(publicKey);
  return {
    config: { did, actAs, keypair: { source: "store", provider: "sealed", id: randomUUID() } },
    signer: { did, publicKey, signChallenge: async (value) => sign(null, Buffer.from(value), keys.privateKey).toString("hex") },
    client: new ImajinClient({ nodeUrl: "https://unused.invalid" }),
  };
}

function discovery(identity: AgentIdentity) {
  return {
    identity: { did: identity.config.did, handle: "artifact-jin", kind: "agent", tier: "established",
      actAs: identity.config.actAs ?? null },
    usableModels: [{ id: "claude-test", connector: "anthropic", credentialDid: identity.config.actAs ?? identity.config.did, picked: true }],
    connectors: [{
      provider: "anthropic", family: "anthropic", configured: true, authority: identity.config.actAs ? "org-held" : "own-key",
      billedPrincipal: { did: identity.config.actAs ?? identity.config.did, handle: "artifact" },
      grantStatus: "not-required", selectedModels: ["claude-test"], usableModels: ["claude-test"], usable: true,
    }, {
      provider: "warp", family: "http", configured: true, ownerDid: identity.config.did,
      authority: null, grantStatus: "not-evaluated", usable: null, usableModels: [],
    }],
  };
}

function setup(identity = agent("did:imajin:artifact-org")) {
  const config = {
    agents: { entries: { artifact: { model: { primary: "imajin/default" } } } },
    models: { providers: { imajin: { baseUrl: proxy } } },
    mcp: { servers: { imajin: { url: "http://127.0.0.1:8787/mcp", enabled: true } } },
    bindings: [
      { agentId: "artifact", match: { channel: "telegram", accountId: "artifact-bot" } },
      { agentId: "other", match: { channel: "discord", accountId: "other-account" } },
    ],
  };
  const options = {
    context: { agentId: "artifact", sessionKey: "agent:artifact:telegram:direct:example",
      activeModel: { provider: "imajin", modelId: "default" } },
    getIdentity: vi.fn((): AgentIdentity | undefined => identity),
    discoverSelf: vi.fn(async (): Promise<unknown> => discovery(identity)),
    getConfig: () => config,
    proxyBaseUrl: proxy,
    githubStatus: vi.fn(async (): Promise<unknown> => undefined),
  };
  const call = async (params?: unknown): Promise<any> => (await createIdentityCardTool(options).execute("call", params)).details;
  return { identity, config, options, call };
}

describe("imajin_identity_card", () => {
  it.each([undefined, "did:imajin:artifact-org"])("is a no-args agent-signed card in personal/org context %s", async (actAs) => {
    const { identity, options, call } = setup(agent(actAs));
    const card = await call();
    expect(options.discoverSelf).toHaveBeenCalledWith("artifact");
    expect(card).toMatchObject({ from: identity.config.did, type: "agent", payload: {
      kind: "imajin.identity-card", agentId: "artifact",
      identity: { ...discovery(identity).identity, grade: "Observed live" },
    } });
    expect(publicKeyDid(identity.signer.publicKey!)).toBe(card.from);
    expect(await verifyMessage(card, identity.signer.publicKey!)).toBe(true);
    card.payload.identity.handle = "tampered";
    expect(await verifyMessage(card, identity.signer.publicKey!)).toBe(false);
  });

  it("merges every connector and exposes authority, model, route, binding and conservative grades", async () => {
    const { identity, call } = setup();
    const { rows } = (await call()).payload;
    expect(rows.map((entry: any) => entry.connector.toLowerCase())).toEqual([
      "imajin kernel", "inference", "mcp", "github", "channels", "anthropic", "warp",
    ]);
    for (const entry of rows) {
      for (const field of ["configured", "configScope", "owner", "outboundIdentity", "selectedScope", "effective", "provider", "route", "grade", "reason"]) {
        expect(entry).toHaveProperty(field);
      }
    }
    expect(rows.find((entry: any) => entry.connector === "Imajin kernel")).toMatchObject({
      outboundIdentity: identity.config.did, owner: identity.config.actAs, flagged: false, grade: "Observed live",
    });
    expect(rows.find((entry: any) => entry.connector === "anthropic")).toMatchObject({
      configured: true, configScope: "org", owner: identity.config.actAs, outboundIdentity: null,
      provider: "imajin", route: "passthrough", grade: "Unverified",
      details: { authority: "org-held", grantStatus: "not-required", usableModels: ["claude-test"] },
    });
    expect(rows.find((entry: any) => entry.connector === "inference")).toMatchObject({
      provider: "imajin", route: "passthrough", grade: "From config",
      details: { model: "default", kernelPick: { model: "claude-test", connector: "anthropic", owner: identity.config.actAs } },
    });
    expect(rows.find((entry: any) => entry.connector === "GitHub")).toMatchObject({
      configScope: "host fallback", flagged: true, grade: "Unverified",
      reason: expect.stringContaining("host fallback — not own identity"),
    });
    expect(rows.find((entry: any) => entry.connector === "channels")).toMatchObject({
      outboundIdentity: "artifact-bot", flagged: true, grade: "From config",
    });
    expect(JSON.stringify(rows)).not.toContain("other-account");
    expect(rows.find((entry: any) => entry.connector === "warp")).toMatchObject({
      grade: "Unverified", owner: identity.config.did, details: { usable: null },
    });
  });

  it.each([401, 403, 404, 429, 503])("retains signed gateway rows when kernel returns HTTP %s", async (status) => {
    const { identity, options, call } = setup();
    options.discoverSelf.mockRejectedValue(new InferenceAuthError("artifact", randomUUID(), status));
    const card = await call();
    expect(card.payload.identity).toMatchObject({ did: null, grade: "Unverified" });
    for (const name of ["Imajin kernel", "Warp", "Anthropic"]) {
      expect(card.payload.rows.find((entry: any) => entry.connector === name)).toMatchObject({
        grade: "Unverified", reason: expect.stringContaining(`HTTP ${status}`), details: { status },
      });
    }
    expect(card.payload.rows.find((entry: any) => entry.connector === "channels").configured).toBe(true);
    expect(card.payload.rows.find((entry: any) => entry.connector === "inference").route).toBe("passthrough");
    expect(await verifyMessage(card, identity.signer.publicKey!)).toBe(true);
  });

  it.each([null, [], {}, { identity: {}, connectors: [], usableModels: [] }])("degrades malformed kernel response %# without raw exceptions", async (body) => {
    const { options, call } = setup();
    options.discoverSelf.mockResolvedValue(body);
    const card = await call();
    expect(card.payload.identity.grade).toBe("Unverified");
    expect(card.payload.identity.did).toBeNull();
  });

  it.each(["did", "actAs"])("rejects another agent's kernel %s even under a signed request", async (field) => {
    const { identity, options, call } = setup();
    const body = discovery(identity);
    body.identity = { ...body.identity, [field]: "did:imajin:other" };
    options.discoverSelf.mockResolvedValue(body);
    const card = await call();
    expect(card.payload.identity.grade).toBe("Unverified");
    expect(JSON.stringify(card)).not.toContain("did:imajin:other");
  });

  it.each([null, [], "bad", { agentId: "other" }, { onBehalfOf: "did:imajin:other" }])("rejects arguments %# before auth or reads", async (params) => {
    const { call, options } = setup();
    expect(await call(params)).toEqual({ error: "This tool accepts no arguments" });
    expect(options.discoverSelf).not.toHaveBeenCalled();
  });

  it("rejects missing/wrong signer, absent caller, and a cross-agent session without requests", async () => {
    for (const kind of ["missing", "wrong", "caller", "session"]) {
      const { identity, options, call } = setup();
      if (kind === "missing") options.getIdentity.mockReturnValue(undefined);
      if (kind === "wrong") identity.signer.did = "did:imajin:other";
      if (kind === "caller") options.context.agentId = "";
      if (kind === "session") options.context.sessionKey = "agent:other:main";
      expect(await call()).toEqual({ error: "Calling-agent signing identity unavailable" });
      expect(options.discoverSelf).not.toHaveBeenCalled();
    }
  });

  it("fences a replaced identity and safely contains signer/config/SDK/transport failures", async () => {
    const { options, call } = setup();
    options.getIdentity.mockReturnValueOnce(options.getIdentity()).mockReturnValue(undefined);
    expect(await call()).toEqual({ error: "Calling-agent signing identity changed" });
    const secret = randomUUID();
    for (const failure of ["config", "sign", "sdk", "transport"]) {
      const test = setup();
      if (failure === "config") test.options.getConfig = () => { throw new Error(secret); };
      if (failure === "sign") test.identity.signer.signChallenge = async () => { throw new Error(secret); };
      if (failure === "sdk") test.options.githubStatus.mockRejectedValue(new Error(secret));
      if (failure === "transport") test.options.discoverSelf.mockRejectedValue(new Error(secret));
      expect(JSON.stringify(await test.call())).not.toContain(secret);
    }
  });

  it("never serializes secret values or credential paths from config, kernel, errors or GitHub RPC", async () => {
    const { identity, config, options, call } = setup();
    const secret = randomUUID();
    const path = `/private/${randomUUID()}/credentials.json`;
    Object.assign(config, { token: secret, keypairPath: path, authorization: secret });
    Object.assign(config.models.providers.imajin, { apiKey: secret, headers: { Authorization: secret } });
    Object.assign(config.mcp.servers.imajin, { headers: { Authorization: secret }, credentialPath: path });
    const body = discovery(identity);
    Object.assign(body, { privateKey: secret, token: secret, credentialPath: path });
    Object.assign(body.connectors[0], { token: secret, credential: { path }, headers: { Authorization: secret } });
    options.discoverSelf.mockResolvedValue(body);
    options.githubStatus.mockResolvedValue({
      ...githubStatus(), token: secret, credentialPath: path,
      effective: { ...githubStatus().effective, token: secret, credentialPath: path, account: { login: "org-bot", token: secret } },
    });
    const text = JSON.stringify(await call());
    expect(text).not.toContain(secret);
    expect(text).not.toContain(path);
    expect(text).not.toContain("Authorization");
  });
});

function githubStatus() {
  return { agentId: "artifact", selectedScope: "agent", selected: { scope: "agent", configured: false, identity: null },
    effective: {
      source: "system-detected", credentialKind: "native", credentialState: "available", evidence: "github-api",
      account: { login: "host-user" }, gitAuthor: { name: "Host", email: "host@example.invalid" },
      accessExpiresAtMs: null, refreshState: "not_applicable", oauthScopes: ["repo"], repositoryGrants: "unknown",
    } };
}

describe("gateway fact grades", () => {
  it("uses live GitHub selected/effective facts, flags fallback and retains public health fields", () => {
    expect(githubRow({}, { agentId: "artifact" }, githubStatus())).toMatchObject({
      configScope: "host fallback", selectedScope: "agent", effective: "host fallback",
      outboundIdentity: "host-user", flagged: true, grade: "Observed live",
      details: { selected: { configured: false, identity: null }, effective: {
        account: { login: "host-user" }, gitAuthor: { name: "Host" }, oauthScopes: ["repo"], credentialState: "available",
      } },
    });
  });

  it.each(["stale", "no-api", "unavailable", "other-agent", "wrong-scope"])("never upgrades unsupported GitHub evidence: %s", (kind) => {
    const status = githubStatus();
    if (kind === "stale") Object.assign(status.effective, { stale: true });
    if (kind === "no-api") status.effective.evidence = "none";
    if (kind === "unavailable") status.effective.credentialState = "unavailable";
    if (kind === "other-agent") status.agentId = "other";
    if (kind === "wrong-scope") status.selectedScope = "system";
    const github = githubRow({}, { agentId: "artifact" }, status);
    expect(github.grade).toBe("Unverified");
    if (kind === "other-agent" || kind === "wrong-scope") expect(github.outboundIdentity).toBeNull();
  });

  it("reports agent GitHub config without probing and recognizes a verified agent override", () => {
    const config = { agents: { entries: { artifact: { tools: { github: { profileId: randomUUID() } } } } } };
    expect(githubRow(config, { agentId: "artifact" })).toMatchObject({ configured: true, configScope: "agent", grade: "Unverified" });
    const status = githubStatus();
    status.effective.source = "agent-override";
    status.effective.credentialKind = "managed-oauth";
    expect(githubRow(config, { agentId: "artifact" }, status)).toMatchObject({
      configured: true, configScope: "agent", grade: "Observed live",
    });
  });

  it.each([
    ["http://127.0.0.1:8787/openai/v1", "passthrough"],
    ["http://127.0.0.1:8787/anthropic", "passthrough"],
    ["https://api.anthropic.com", "direct"],
    ["https://direct.invalid/openai/v1", "direct"],
    ["not a URL", null], ["file:///credentials", null],
  ])("derives %s as %s only from resolved URL", (baseUrl, route) => {
    const config = { models: { providers: { custom: { baseUrl } } } };
    const result = inferenceRow(config, { agentId: "artifact", activeModel: { provider: "custom", modelId: "test-model" } }, proxy);
    expect(result.route).toBe(route);
    expect(result.grade).toBe(route ? "From config" : "Unverified");
    expect(JSON.stringify(result)).not.toContain(baseUrl);
  });

  it("uses inherited defaults but leaves absent config and provider URLs unverified", () => {
    expect(inferenceRow({ agents: { defaults: { model: "anthropic/model" } } }, { agentId: "artifact" }, proxy))
      .toMatchObject({ provider: "anthropic", route: null, grade: "Unverified", configScope: "host fallback" });
    expect(inferenceRow(undefined, {}, proxy).grade).toBe("Unverified");
    expect(channelRows({}, { agentId: "artifact", messageChannel: "telegram" })[0])
      .toMatchObject({ configured: false, grade: "Unverified", details: { currentChannel: "telegram" } });
  });

  it("drops malformed/path public fields and masks recognized credential-shaped strings", () => {
    for (const value of [undefined, null, {}, 1, "", "x".repeat(257), "/private/key", "C:\\private\\key", "bad\nvalue"]) {
      expect(publicText(value)).toBeNull();
    }
    const marker = `ghp_${randomUUID().replaceAll("-", "")}`;
    expect(publicText(marker)).not.toContain(marker);
  });
});
