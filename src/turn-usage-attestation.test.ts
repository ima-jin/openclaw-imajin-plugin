import { describe, it, expect, vi, afterEach } from "vitest";
import {
  findFinalAssistantMessage,
  extractTurnUsage,
  buildTurnUsagePayload,
  buildTurnUsageClaim,
  postTurnUsageAttestation,
  createTurnUsageAttestationHandler,
  type AgentMessage,
  type AgentEndEvent,
} from "./turn-usage-attestation.js";

const DID = "did:imajin:agent123";

function mockFetch(response: unknown, status = 201) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(response),
    json: async () => response,
  } as unknown as Response);
}

describe("findFinalAssistantMessage", () => {
  it("returns the last assistant-role message", () => {
    const messages: AgentMessage[] = [
      { role: "user" },
      { role: "assistant", model: "a" },
      { role: "tool" },
      { role: "assistant", model: "b" },
    ];
    expect(findFinalAssistantMessage(messages)?.model).toBe("b");
  });

  it("falls back to the last message when no assistant message is present", () => {
    const messages: AgentMessage[] = [{ role: "user" }, { role: "tool" }];
    expect(findFinalAssistantMessage(messages)).toBe(messages[1]);
  });

  it("returns undefined for empty/undefined messages", () => {
    expect(findFinalAssistantMessage([])).toBeUndefined();
    expect(findFinalAssistantMessage(undefined)).toBeUndefined();
  });
});

describe("extractTurnUsage", () => {
  it("normalizes usage/cost fields from the message", () => {
    const message: AgentMessage = {
      role: "assistant",
      usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, totalTokens: 150 },
      cost: { input: 0.01, output: 0.02, total: 0.03 },
      contextUsage: { tokens: 4096 },
    };
    expect(extractTurnUsage(message)).toEqual({
      usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, totalTokens: 150 },
      cost: { input: 0.01, output: 0.02, total: 0.03 },
      contextUsage: { tokens: 4096 },
    });
  });

  it("defaults every numeric field to 0 for a $0 local-model turn — never omitted (#1843: no filtering)", () => {
    const message: AgentMessage = { role: "assistant" };
    expect(extractTurnUsage(message)).toEqual({
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      cost: { input: 0, output: 0, total: 0 },
      contextUsage: null,
    });
  });

  it("defaults to 0 for a missing message entirely", () => {
    expect(extractTurnUsage(undefined).cost).toEqual({ input: 0, output: 0, total: 0 });
  });

  it("ignores non-numeric usage/cost values rather than throwing", () => {
    const message = {
      role: "assistant",
      usage: { input: "not-a-number", totalTokens: NaN },
      cost: { total: null },
    } as unknown as AgentMessage;
    expect(extractTurnUsage(message).usage.input).toBe(0);
    expect(extractTurnUsage(message).usage.totalTokens).toBe(0);
    expect(extractTurnUsage(message).cost.total).toBe(0);
  });
});

describe("buildTurnUsagePayload", () => {
  it("assembles the payload from event metadata + the final assistant message", () => {
    const event: AgentEndEvent = {
      type: "agent_end",
      sessionKey: "agent:main:telegram:direct:123",
      runId: "run_abc",
      model: "anthropic/claude-opus-4-6",
      provider: "anthropic",
      channel: "telegram",
      durationMs: 4200,
      messages: [{ role: "assistant", usage: { totalTokens: 10 }, cost: { total: 0 } }],
    };
    const finalMessage = findFinalAssistantMessage(event.messages);
    const payload = buildTurnUsagePayload(event, finalMessage);

    expect(payload.sessionKey).toBe(event.sessionKey);
    expect(payload.runId).toBe("run_abc");
    expect(payload.model).toBe("anthropic/claude-opus-4-6");
    expect(payload.provider).toBe("anthropic");
    expect(payload.channel).toBe("telegram");
    expect(payload.durationMs).toBe(4200);
    expect(payload.usage.totalTokens).toBe(10);
    expect(typeof payload.ts).toBe("number");
  });

  it("falls back to the message's own model/provider when the event omits them", () => {
    const event: AgentEndEvent = {
      messages: [{ role: "assistant", model: "local/llama", provider: "ollama" }],
    };
    const payload = buildTurnUsagePayload(event, event.messages?.[0]);
    expect(payload.model).toBe("local/llama");
    expect(payload.provider).toBe("ollama");
  });

  it("leaves metadata undefined rather than throwing when the event carries none", () => {
    const payload = buildTurnUsagePayload({}, undefined);
    expect(payload.sessionKey).toBeUndefined();
    expect(payload.runId).toBeUndefined();
    expect(payload.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });
  });
});

describe("buildTurnUsageClaim", () => {
  it("is unilateral — issuer_did and subject_did are both the agent's own DID", () => {
    const payload = buildTurnUsagePayload({ sessionKey: "s1" }, undefined);
    const claim = buildTurnUsageClaim(DID, payload);
    expect(claim.issuer_did).toBe(DID);
    expect(claim.subject_did).toBe(DID);
    expect(claim.type).toBe("agent.turn.usage");
    expect(claim.context_type).toBe("agent_run");
    expect(claim.context_id).toBe("s1");
  });

  it("falls back to runId then 'unknown' for context_id when sessionKey is absent", () => {
    const withRunId = buildTurnUsageClaim(DID, buildTurnUsagePayload({ runId: "run_1" }, undefined));
    expect(withRunId.context_id).toBe("run_1");

    const withNeither = buildTurnUsageClaim(DID, buildTurnUsagePayload({}, undefined));
    expect(withNeither.context_id).toBe("unknown");
  });

  it("sets expires_at ~90 days in the future (rolling retention opt-in)", () => {
    const payload = buildTurnUsagePayload({}, undefined);
    const claim = buildTurnUsageClaim(DID, payload);
    const expiresInMs = new Date(claim.expires_at).getTime() - Date.now();
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
    expect(expiresInMs).toBeGreaterThan(ninetyDaysMs - 5_000);
    expect(expiresInMs).toBeLessThan(ninetyDaysMs + 5_000);
  });
});

describe("postTurnUsageAttestation", () => {
  const SERVICE_URL = "https://jin.imajin.ai";
  const API_KEY = "internal-key";

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs the claim to /auth/api/attestations/internal with the Bearer key", async () => {
    const fetchMock = mockFetch({ id: "att_1" });
    global.fetch = fetchMock as unknown as typeof fetch;

    const payload = buildTurnUsagePayload({ sessionKey: "s1" }, undefined);
    const claim = buildTurnUsageClaim(DID, payload);
    await postTurnUsageAttestation(SERVICE_URL, API_KEY, claim);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${SERVICE_URL}/auth/api/attestations/internal`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
    expect(JSON.parse(init.body as string)).toEqual(claim);
  });

  it("strips a trailing slash from the service URL", async () => {
    const fetchMock = mockFetch({ id: "att_1" });
    global.fetch = fetchMock as unknown as typeof fetch;

    await postTurnUsageAttestation(
      `${SERVICE_URL}/`,
      API_KEY,
      buildTurnUsageClaim(DID, buildTurnUsagePayload({}, undefined)),
    );

    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(`${SERVICE_URL}/auth/api/attestations/internal`);
  });

  it("logs and drops (does not throw) on a non-2xx response", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = mockFetch({ error: "bad" }, 400) as unknown as typeof fetch;

    await expect(
      postTurnUsageAttestation(SERVICE_URL, API_KEY, buildTurnUsageClaim(DID, buildTurnUsagePayload({}, undefined))),
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("logs and drops (does not throw/reject) on a network error", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;

    await expect(
      postTurnUsageAttestation(SERVICE_URL, API_KEY, buildTurnUsageClaim(DID, buildTurnUsagePayload({}, undefined))),
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe("createTurnUsageAttestationHandler", () => {
  const SERVICE_URL = "https://jin.imajin.ai";
  const API_KEY = "internal-key";

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ATTESTATION_INTERNAL_API_KEY;
  });

  it("returns undefined (does not register) when no DID is configured", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = createTurnUsageAttestationHandler(undefined, {
      serviceUrl: SERVICE_URL,
      internalApiKey: API_KEY,
    });
    expect(handler).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("returns undefined when serviceUrl/internalApiKey cannot be resolved", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(createTurnUsageAttestationHandler(DID, {})).toBeUndefined();
  });

  it("returns undefined when explicitly disabled, even with full config", () => {
    const handler = createTurnUsageAttestationHandler(DID, {
      serviceUrl: SERVICE_URL,
      internalApiKey: API_KEY,
      enabled: false,
    });
    expect(handler).toBeUndefined();
  });

  it("falls back to the ATTESTATION_INTERNAL_API_KEY env var when internalApiKey is omitted", () => {
    process.env.ATTESTATION_INTERNAL_API_KEY = "env-key";
    const handler = createTurnUsageAttestationHandler(DID, { serviceUrl: SERVICE_URL });
    expect(handler).toBeDefined();
  });

  it("fires a POST without the handler itself awaiting it (fire-and-forget)", async () => {
    const fetchMock = mockFetch({ id: "att_1" });
    global.fetch = fetchMock as unknown as typeof fetch;

    const handler = createTurnUsageAttestationHandler(DID, {
      serviceUrl: SERVICE_URL,
      internalApiKey: API_KEY,
    });
    expect(handler).toBeDefined();

    const event: AgentEndEvent = {
      type: "agent_end",
      sessionKey: "s1",
      messages: [{ role: "assistant", usage: { totalTokens: 5 }, cost: { total: 0 } }],
    };

    // The handler returns synchronously — it must not return a Promise the
    // turn would need to await.
    const result = handler!(event);
    expect(result).toBeUndefined();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.issuer_did).toBe(DID);
    expect(body.subject_did).toBe(DID);
    expect(body.type).toBe("agent.turn.usage");
    expect(body.payload.usage.totalTokens).toBe(5);
  });

  it("attests $0-cost turns too — no filtering (#1843)", async () => {
    const fetchMock = mockFetch({ id: "att_1" });
    global.fetch = fetchMock as unknown as typeof fetch;

    const handler = createTurnUsageAttestationHandler(DID, {
      serviceUrl: SERVICE_URL,
      internalApiKey: API_KEY,
    });

    handler!({
      type: "agent_end",
      sessionKey: "s-local",
      model: "local/llama",
      provider: "ollama",
      messages: [{ role: "assistant" }],
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.payload.cost).toEqual({ input: 0, output: 0, total: 0 });
  });

  it("never throws even when the event is malformed", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = createTurnUsageAttestationHandler(DID, {
      serviceUrl: SERVICE_URL,
      internalApiKey: API_KEY,
    });

    expect(() => handler!(null as unknown as AgentEndEvent)).not.toThrow();
    expect(() => handler!(undefined as unknown as AgentEndEvent)).not.toThrow();
    // Errors from malformed input are swallowed, not silently ignored.
    expect(errorSpy).not.toHaveBeenCalled(); // null/undefined events are handled gracefully, not errors
  });

  it("never throws or rejects the turn even when fetch itself throws synchronously", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = vi.fn(() => {
      throw new Error("boom");
    }) as unknown as typeof fetch;

    const handler = createTurnUsageAttestationHandler(DID, {
      serviceUrl: SERVICE_URL,
      internalApiKey: API_KEY,
    });

    expect(() => handler!({ type: "agent_end", messages: [] })).not.toThrow();
  });
});
