import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The optional OpenClaw peer is absent in CI. Static entrypoint imports need
// resolvable paths before Vitest can replace them with per-suite mocks.
const sdkStub = fileURLToPath(new URL("./src/test-fixtures/plugin-sdk.ts", import.meta.url));
export default defineConfig({
  test: {
    alias: {
      "openclaw/plugin-sdk/plugin-entry": sdkStub,
      "openclaw/plugin-sdk/approval-gateway-runtime": sdkStub,
    },
  },
});
