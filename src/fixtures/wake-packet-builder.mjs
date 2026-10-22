import { readFileSync } from "node:fs";

// Offline stand-in for the operator's read-only builder: no network or writes.
const [mode, ...runIds] = process.argv.slice(2);
if (mode === "fail") {
  process.stderr.write("fixture-private-diagnostic");
  process.exitCode = 1;
} else if (mode === "timeout") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else if (mode === "overflow") {
  process.stdout.write("界".repeat(8000));
} else if (mode === "empty") {
  process.stdout.write(" \n");
} else if (mode === "invalid-utf8") {
  process.stdout.write(Buffer.from([0xff]));
} else if (mode === "inherited-pipe") {
  const { spawn } = await import("node:child_process");
  spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", 1, "ignore"] });
} else {
  const fixture = JSON.parse(readFileSync(new URL("./wake-packet-state.json", import.meta.url), "utf8"));
  process.stdout.write([
    "# Wake packet",
    `Runs: ${runIds.join(", ")}`,
    ...Object.entries(fixture).map(([section, state]) => `${section}: ${JSON.stringify(state)}`),
  ].join("\n"));
}
