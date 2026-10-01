import { describe, it, expect, vi } from "vitest";
import {
  GATEWAY_EXEC_NOT_ENABLED_MESSAGE,
  diagnoseExecApprovalConfig,
  logExecApprovalPreflight,
} from "./exec-approval-preflight.js";

const GOOD_CONFIG = { tools: { exec: { host: "gateway", mode: "ask" } } };

function runPreflight(sources: string[], gatewayConfig: unknown): string[] {
  const warn = vi.fn();
  logExecApprovalPreflight(new Set(sources), gatewayConfig, { warn });
  return warn.mock.calls.map((call) => String(call[0]));
}

describe("diagnoseExecApprovalConfig", () => {
  it("reports nothing for host=gateway + mode=ask", () => {
    expect(diagnoseExecApprovalConfig(GOOD_CONFIG)).toEqual([]);
  });

  it("accepts the legacy ask:always pair without mode", () => {
    expect(diagnoseExecApprovalConfig({ tools: { exec: { host: "node", security: "full", ask: "always" } } })).toEqual([]);
  });

  it("flags the issue's config: no tools.exec block at all (ask baseline is off)", () => {
    const problems = diagnoseExecApprovalConfig({});
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/no ask-capable baseline/);
  });

  it.each([["full"], ["allowlist"], ["deny"]])("flags mode=%s as having no ask-capable baseline", (mode) => {
    expect(diagnoseExecApprovalConfig({ tools: { exec: { host: "gateway", mode } } })).toHaveLength(1);
  });

  it('flags host="sandbox" even with an ask-capable mode', () => {
    const problems = diagnoseExecApprovalConfig({ tools: { exec: { host: "sandbox", mode: "ask" } } });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/sandbox/);
  });

  it.each([
    ["defaults, host unset", { agents: { defaults: { sandbox: { mode: "all" } } }, tools: { exec: { mode: "ask" } } }],
    [
      "per-agent entry, host auto",
      {
        agents: { entries: { main: { sandbox: { mode: "non-main" } } } },
        tools: { exec: { host: "auto", mode: "ask" } },
      },
    ],
  ])("flags an active sandbox with host auto/unset (%s)", (_name, config) => {
    const problems = diagnoseExecApprovalConfig(config);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/exec resolves to the sandbox/);
  });

  it("does not flag an active sandbox when host is pinned to gateway", () => {
    const config = { agents: { defaults: { sandbox: { mode: "all" } } }, ...GOOD_CONFIG };
    expect(diagnoseExecApprovalConfig(config)).toEqual([]);
  });

  it("tolerates a missing/garbage config", () => {
    expect(() => diagnoseExecApprovalConfig(undefined)).not.toThrow();
    expect(() => diagnoseExecApprovalConfig({ agents: { entries: { broken: undefined } } })).not.toThrow();
  });
});

describe("logExecApprovalPreflight (fail loud, never silent)", () => {
  it("logs ONE loud warning when gateway-exec is not in approvals.sources", () => {
    const logs = runPreflight(["system-agent", "skill-workshop"], GOOD_CONFIG);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(GATEWAY_EXEC_NOT_ENABLED_MESSAGE);
    expect(logs[0]).toContain('tools.exec.host: "gateway"');
  });

  it("logs ONE warning listing every gateway-config problem when gateway-exec is enabled", () => {
    const logs = runPreflight(["gateway-exec"], { tools: { exec: { host: "sandbox" } } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/sandbox/);
    expect(logs[0]).toMatch(/no ask-capable baseline/);
  });

  it("is silent when gateway-exec is enabled and the gateway config can raise approvals", () => {
    expect(runPreflight(["gateway-exec"], GOOD_CONFIG)).toEqual([]);
  });
});
