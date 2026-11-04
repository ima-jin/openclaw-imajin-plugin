import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfigFromFile } from "vite";
import { defineConfig, mergeConfig } from "vitest/config";

// Run against an installed, read-only checkout of imajin-ai PR #3265.
export default defineConfig(async () => {
  const kernel = process.env.IMAJIN_KERNEL_ROOT;
  if (!kernel) throw new Error("IMAJIN_KERNEL_ROOT must name the kernel checkout");
  const base = await loadConfigFromFile({ command: "serve", mode: "test" }, resolve(kernel, "vitest.config.ts"));
  if (!base) throw new Error("Kernel Vitest configuration unavailable");
  const fixture = fileURLToPath(new URL("./publisher-command-boundary.compat.ts", import.meta.url));
  return mergeConfig({ ...base.config, test: { ...base.config.test, include: [] } }, {
    root: kernel,
    resolve: { alias: [{ find: /^kernel\//, replacement: `${resolve(kernel, "apps/kernel/src/lib")}/` }] },
    test: {
      include: [
        fixture.replaceAll("\\", "/"),
        "apps/kernel/src/lib/loops/__tests__/publisher-command-boundary.test.ts",
      ],
      maxWorkers: 2, minWorkers: 1,
    },
  });
});
