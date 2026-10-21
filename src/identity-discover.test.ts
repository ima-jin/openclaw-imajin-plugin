import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImajinClient, validateDid } from "./client.js";
import { createDiscoverTool, createIdentityTool } from "./tools.js";

const BASE_URL = "https://kernel.example";
const DID = "did:imajin:Fp5QtWo9vsmS7G5AcbuEUrPT6oGbKxj5gke6T4voH7xE";
const AGENT = "did:imajin:agent";
const identity = {
  did: DID, handle: "artifact", name: "Artifact", scope: "business", subtype: "inc",
  tier: "preliminary",
};
const normalizedIdentity = { ...identity, displayName: "Artifact" };
const lookupUrl = `${BASE_URL}/auth/api/lookup/${encodeURIComponent(DID)}`;
const connection = {
  did: "did:imajin:friend", podId: "pod_1", podName: "Friends",
  joinedAt: "2026-08-07T19:46:20.010Z", handle: "friend", name: "Friend",
};

describe("identity and discovery kernel contracts (#74)", () => {
  const fetcher = vi.fn<typeof fetch>();
  let client: ImajinClient;

  function respond(body: unknown, status = 200) {
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify(body), {
      status, headers: { "Content-Type": "application/json" },
    }));
  }

  beforeEach(() => {
    fetcher.mockReset();
    vi.stubGlobal("fetch", fetcher);
    client = new ImajinClient({ nodeUrl: BASE_URL, did: AGENT });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("accepts the reported DID and returns the top-level Artifact identity", async () => {
    expect(validateDid(DID)).toBe(true);
    respond(identity);
    const result = await createIdentityTool(client).execute("1", { action: "lookup", query: DID });
    expect(JSON.parse(result.content[0].text)).toEqual(normalizedIdentity);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(lookupUrl, expect.objectContaining({ method: "GET" }));
  });

  it("prefers an exact handle over a fuzzy match and returns the same identity", async () => {
    respond({ results: [
      { ...identity, did: "did:imajin:fuzzy", handle: "artifacteric", name: "artifacteric" },
      identity,
    ] });
    respond(identity);
    const result = await createIdentityTool(client).execute("1", { action: "lookup", query: "artifact" });
    expect(JSON.parse(result.content[0].text)).toEqual(normalizedIdentity);
    expect(fetcher.mock.calls[0][0]).toBe(`${BASE_URL}/auth/api/search?q=artifact&limit=20`);
    expect(fetcher.mock.calls[1][0]).toBe(lookupUrl);
  });

  it("matches names case-insensitively before falling back to the first fuzzy result", async () => {
    respond({ results: [
      { ...identity, did: "did:imajin:fuzzy", handle: null, name: null },
      { ...identity, handle: "different-handle" },
    ] });
    respond(identity);
    expect(await client.lookupIdentity(" ARTIFACT ")).toEqual(normalizedIdentity);
    expect(fetcher.mock.calls[1][0]).toBe(lookupUrl);
  });

  it("resolves a fuzzy name to its DID", async () => {
    respond({ results: [identity] });
    respond(identity);
    expect(await client.lookupIdentity("Artif")).toEqual(normalizedIdentity);
  });

  it("reports no handle match without making a DID request", async () => {
    respond({ results: [] });
    const result = await createIdentityTool(client).execute("1", { action: "lookup", query: "missing" });
    expect(result.content[0].text).toBe("No identity found for: missing");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("treats only an actual lookup 404 as not found", async () => {
    respond({ error: "Identity not found" }, 404);
    expect(await client.lookupIdentity(DID)).toBeNull();
  });

  it.each([400, 401, 403, 500])("surfaces lookup HTTP %i rather than hiding it", async (status) => {
    respond({ error: "refused" }, status);
    const result = await createIdentityTool(client).execute("1", { action: "lookup", query: DID });
    expect(result.details).toMatchObject({ error: true });
    expect(result.content[0].text).toContain(`Imajin API ${status}`);
  });

  it("rejects malformed DIDs without sending them to handle search", async () => {
    await expect(client.lookupIdentity("did:imajin:")).rejects.toThrow("Invalid DID format");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("lists trust-graph connections via GET for the target principal", async () => {
    respond({ connections: [connection] });
    const result = await createIdentityTool(client).execute("1", { action: "connections", query: DID });
    expect(JSON.parse(result.content[0].text)).toEqual([connection]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(`${BASE_URL}/connections/api/connections`, {
      headers: { Accept: "application/json", "X-Agent-DID": AGENT, "X-Acting-For": DID },
    });
  });

  it("preserves a configured principal and explicit delegation", async () => {
    client = new ImajinClient({ nodeUrl: BASE_URL, did: AGENT, actAs: DID });
    respond({ connections: [connection] });
    expect(await client.getConnections(DID, DID)).toEqual([connection]);
    expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({ "X-Acting-For": DID });
  });

  it("self reads the agent's own graph without the configured delegation", async () => {
    client = new ImajinClient({ nodeUrl: BASE_URL, did: AGENT, actAs: DID });
    respond({ connections: [] });
    expect(await client.getConnections(AGENT, "self")).toEqual([]);
    expect(fetcher.mock.calls[0][1]?.headers).not.toHaveProperty("X-Acting-For");
  });

  it("an own-DID read needs no delegation header", async () => {
    respond({ connections: [] });
    const result = await createIdentityTool(client).execute("1", { action: "connections", query: AGENT });
    expect(result.content[0].text).toContain("No connections found");
    expect(fetcher.mock.calls[0][1]?.headers).not.toHaveProperty("X-Acting-For");
  });

  it("refuses inconsistent principals and invalid connection DIDs before HTTP", async () => {
    await expect(client.getConnections(DID, "self")).rejects.toThrow("must match");
    await expect(client.getConnections(DID, AGENT)).rejects.toThrow("must match");
    await expect(client.getConnections("artifact")).rejects.toThrow("Invalid DID format");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([401, 403])("preserves connections HTTP %i authorization refusals", async (status) => {
    respond({ error: "Not authorized" }, status);
    const result = await createIdentityTool(client).execute("1", { action: "connections", query: DID });
    expect(result.details).toMatchObject({ error: true });
    expect(result.content[0].text).toContain(`Imajin API ${status}`);
  });

  it("discovery calls the live identity search route and preserves its fields", async () => {
    respond({ results: [identity] });
    const tool = createDiscoverTool(client);
    const result = await tool.execute("1", { query: "Artifact & Co" });
    expect(JSON.parse(result.content[0].text)).toEqual([identity]);
    expect(fetcher.mock.calls[0][0]).toBe(`${BASE_URL}/auth/api/search?q=Artifact+%26+Co&limit=20`);
    expect(tool.description).toContain("Does not search events, market items, or soft/stub identities");
  });

  it.each(["business", "inc"])("filters the returned page locally by scope/subtype %s", async (type) => {
    respond({ results: [identity, { ...identity, did: AGENT, scope: "actor", subtype: "agent" }] });
    const result = await createDiscoverTool(client).execute("1", { query: "artifact", type });
    expect(JSON.parse(result.content[0].text)).toEqual([identity]);
    expect(fetcher.mock.calls[0][0]).toBe(`${BASE_URL}/auth/api/search?q=artifact&limit=20`);
  });

  it("reports empty search results", async () => {
    respond({});
    const result = await createDiscoverTool(client).execute("1", { query: "missing" });
    expect(result.content[0].text).toBe("No results found for: missing");
  });

  it("surfaces discovery and handle-search errors", async () => {
    respond({ error: "unavailable" }, 500);
    const result = await createDiscoverTool(client).execute("1", { query: "artifact" });
    expect(result.details).toMatchObject({ error: true });
    respond({ error: "unavailable" }, 500);
    await expect(client.lookupIdentity("artifact")).rejects.toThrow("Imajin API 500");
  });
});
