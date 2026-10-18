import type { WakeToolEvent } from "./wake-decision.js";

export const WAKE_LOOKUP_TOOLS = ["read", "imajin_status", "imajin_warp", "process", "exec"] as const;
const SIMPLE_READS = new Set(["read", "imajin_status"]);
const WARP_READS = new Set(["get_run", "get_transcript", "list_runs"]);
const GH_READS = new Set(["pr view", "pr list", "pr checks", "run view", "run list", "issue view", "issue list"]);
const VALUE_FLAGS = new Set(["--json", "--repo", "-R", "--limit", "-L", "--branch", "--status", "--workflow", "--job", "-j"]);
const BOOLEAN_FLAGS = new Set(["--log", "--log-failed", "--exit-status", "--required", "--comments"]);
const SAFE_VALUE = /^[\w./,:@-]+$/;

function readArguments(args: string[]): boolean {
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (!argument.startsWith("-") || BOOLEAN_FLAGS.has(argument)) continue;
    const equals = argument.indexOf("=");
    if (equals > 0) {
      if (!VALUE_FLAGS.has(argument.slice(0, equals)) || !SAFE_VALUE.test(argument.slice(equals + 1))) return false;
      continue;
    }
    if (!VALUE_FLAGS.has(argument) || !args[index + 1] || args[index + 1].startsWith("-")) return false;
    index++;
  }
  return true;
}

/** No shell syntax, aliases, API mutations, jq/templates, env overrides or arbitrary executables. */
function githubRead(params: Record<string, unknown>, cliPath: string): Record<string, unknown> | undefined {
  const command = params.command;
  if (typeof command !== "string" || command.length > 8_192 || /[\r\n]/.test(command) || params.env !== undefined) return;
  if (!/^\/[\w./-]+$/.test(cliPath)) return;
  const words = command.trim().split(/\s+/);
  if (words[0] !== "gh" && words[0] !== cliPath) return;
  if (!words.every((word) => /^[\w./,:=@-]+$/.test(word))) return;
  if (!GH_READS.has(`${words[1]} ${words[2]}`) || !readArguments(words.slice(3))) return;
  return { ...params, command: [cliPath, ...words.slice(1)].join(" ") };
}

/** Returning params is proof of an allowlisted read, never a generic tool-name exemption. */
export function wakeReadOnlyLookup(event: WakeToolEvent, cliPath: string): Record<string, unknown> | undefined {
  if (SIMPLE_READS.has(event.toolName)) return event.params;
  if (event.toolName === "imajin_warp" && typeof event.params.action === "string" && WARP_READS.has(event.params.action)) {
    return event.params;
  }
  if (event.toolName === "process" && (event.params.action === "poll" || event.params.action === "log")) {
    return event.params;
  }
  if (event.toolName === "exec") return githubRead(event.params, cliPath);
}
