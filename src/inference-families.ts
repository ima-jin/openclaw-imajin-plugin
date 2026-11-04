export type InferenceApi = "openai-completions" | "anthropic-messages";

/** Connector metadata is authoritative; never infer a wire protocol from a model name. */
export const INFERENCE_FAMILIES = [
  { connectors: ["openai", "xai", "zai", "deepseek", "groq", "together", "mistral", "fireworks", "openrouter"],
    family: "openai", api: "openai-completions", path: "/openai/v1" },
  { connectors: ["anthropic"], family: "anthropic", api: "anthropic-messages", path: "/anthropic" },
] as const;

export function inferenceFamily(connector: string) {
  return INFERENCE_FAMILIES.find((entry) => (entry.connectors as readonly string[]).includes(connector));
}

export function familyBaseUrl(baseUrl: string, api: InferenceApi): string {
  const family = INFERENCE_FAMILIES.find((entry) => entry.api === api)!;
  return `${baseUrl.replaceAll(/\/(?:openai\/v1|anthropic)\/?$/g, "")}${family.path}`;
}
