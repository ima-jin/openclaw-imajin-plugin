#!/usr/bin/env node
// The only successful stdout is the gateway's private exec-provider response.
try {
  const { runVaultExec } = await import("../dist/src/vault-exec.js");
  process.exitCode = await runVaultExec(
    process.argv.slice(2), process.stdin,
    (value) => process.stdout.write(value), (value) => process.stderr.write(value),
  );
} catch {
  process.stderr.write("imajin-vault: resolution unavailable\n");
  process.exitCode = 1;
}
