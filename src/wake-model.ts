/** Model selection only; never writes gateway config or changes default models. */
export interface WakeModelSelection {
  model?: string;
  source: "wakeModel" | "model" | "default";
}

/**
 * The empty/unset path does not load the SDK or inspect config, preserving the
 * existing hook payload (including the legacy coordinator `model` option).
 * SDK contracts verified against published openclaw@2026.10.4 agent-runtime.
 * Callers bound this read and warn/fall back on any resolution failure.
 */
export async function resolveWakeModel(
  wakeModel: string | undefined,
  legacyModel: string | undefined,
  agentId: string,
  getConfig: () => unknown,
): Promise<WakeModelSelection> {
  if (wakeModel === undefined || (typeof wakeModel === "string" && !wakeModel.trim())) {
    const model = legacyModel?.trim();
    return { model, source: model ? "model" : "default" };
  }
  if (typeof wakeModel !== "string") throw new Error("wakeModel must be a string");
  const { loadModelCatalog, resolveDefaultModelForAgent, resolveAllowedModelRef } =
    await import("openclaw/plugin-sdk/agent-runtime");
  const cfg = getConfig();
  const defaultModel = resolveDefaultModelForAgent({ cfg, agentId });
  const catalog = await loadModelCatalog({ config: cfg, agentId, readOnly: true });
  const resolved = resolveAllowedModelRef({
    cfg, agentId, catalog, raw: wakeModel.trim(),
    defaultProvider: defaultModel.provider, defaultModel,
  });
  if ("error" in resolved || !catalog.some(
    (entry) => entry.provider === resolved.ref.provider && entry.id === resolved.ref.model,
  )) throw new Error("wakeModel unavailable");
  return { model: resolved.key, source: "wakeModel" };
}
