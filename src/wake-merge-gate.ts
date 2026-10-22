import type { WakeToolEvent } from "./wake-decision.js";
import { gradingMarker, withGradingDeadline, type WakeGradingBlock, type WakeGradingSource } from "./wake-grading.js";
import { validatedWakePrUrl } from "./wake-live-state.js";

interface Policy { block?: boolean; blockReason?: string; params?: Record<string, unknown> }
interface Mutation {
  target?: string;
  nodeId?: string;
  approve: boolean;
  /** Only direct CLI/MCP approvals can safely have their bodies rewritten. */
  withBody?: (body: string) => Record<string, unknown>;
  body: string;
  expectedHeadSha?: string;
}

function directFlags(args: string[], approve: boolean): boolean {
  const booleans = new Set(approve ? ["--approve", "-a"] : ["--squash", "--merge", "--rebase", "--auto", "--delete-branch"]);
  const values = new Set(approve ? ["--repo", "-R", "--body", "-b"] : ["--repo", "-R", "--match-head-commit"]);
  for (let i = 4; i < args.length; i++) {
    const [name, ...value] = args[i].split("=");
    if (booleans.has(name) && !value.length) continue;
    if (!values.has(name)) return false;
    if (value.length) { if (!value.join("=")) return false; }
    else if (!args[++i] || args[i].startsWith("-")) return false;
  }
  return true;
}
const refuse = (reason: string): Policy => ({ block: true, blockReason: `Decision merge-side call blocked: ${reason}. Report blocked.` });
const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";

/** A single literal command, never a shell program or a body-file/editor indirection. */
function words(command: string): string[] | undefined {
  if (/[$`\\]/.test(command)) return;
  const result: string[] = [];
  let word = "";
  let delimiter = "";
  let started = false;
  for (const char of command) {
    if (delimiter) {
      if (char === delimiter) delimiter = "";
      else word += char;
    } else if (char === "'" || char === '"') {
      delimiter = char;
      started = true;
    } else if (/[\r\n]/.test(char)) {
      return;
    } else if (/\s/.test(char)) {
      if (started) result.push(word);
      word = "";
      started = false;
    } else {
      if (/[;&|<>()#]/.test(char)) return;
      word += char;
      started = true;
    }
  }
  if (delimiter) return;
  if (started) result.push(word);
  return result;
}

function flag(args: string[], names: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (names.includes(args[i])) return args[i + 1];
    const name = names.find((key) => args[i].startsWith(`${key}=`));
    if (name) return args[i].slice(name.length + 1);
  }
}

function url(repo: unknown, number: unknown): string | undefined {
  return validatedWakePrUrl(`https://github.com/${repo}/pull/${number}`);
}

function graphqlMutation(query: unknown): Mutation {
  // Deliberately bounded grammar: no aliases, extra mutations, fragments, variables,
  // opaque input files or unrelated node IDs used as supposed target evidence.
  const match = typeof query === "string" && /^\s*mutation\s*\{\s*(enqueuePullRequest|mergePullRequest)\s*\(\s*input\s*:\s*\{\s*pullRequestId\s*:\s*"(PR_[\w-]+)"\s*(?:,\s*expectedHeadOid\s*:\s*"([a-f0-9]{40,64})"\s*)?\}\s*\)\s*\{\s*(?:clientMutationId|pullRequest\s*\{\s*id\s*\})\s*\}\s*\}\s*$/i.exec(query);
  return { nodeId: match ? match[2] : undefined, expectedHeadSha: match ? match[3] : undefined,
    approve: false, body: "" };
}

function cliMutation(event: WakeToolEvent, cliPath: string): Mutation | undefined {
  const command = event.params.command;
  if (typeof command !== "string") return;
  const sensitive = (/\bgh\b/.test(command) || command.includes(cliPath)) && /\b(?:merge|review|api)\b/.test(command);
  if (!sensitive) return;
  const args = words(command);
  if (!args || !["gh", cliPath].includes(args[0]) || event.params.env !== undefined) {
    return { approve: false, body: "" };
  }
  const approve = args[1] === "pr" && args[2] === "review" && args.some((arg) => arg === "--approve" || arg === "-a");
  if (args[1] === "pr" && args[2] === "review" && !approve
    && args.some((arg) => ["--request-changes", "--comment", "-r", "-c"].includes(arg))
    && !args.some((arg) => /^-a/.test(arg))) return;
  if (args[1] === "pr" && (args[2] === "merge" || approve)) {
    const repository = flag(args, ["--repo", "-R"]);
    const directUrl = validatedWakePrUrl(args[3]);
    const target = directUrl ?? url(repository, args[3]);
    const body = flag(args, ["--body", "-b"]) ?? "";
    const ambiguous = !directFlags(args, approve)
      || (directUrl && repository && !directUrl.includes(`/${repository}/pull/`))
      || args.includes("--body-file") || args.some((arg) => arg.startsWith("--body-file="))
      || args.filter((arg) => arg === "--repo" || arg === "-R" || arg.startsWith("--repo=") || arg.startsWith("-R=")).length > 1
      || args.filter((arg) => arg === "--body" || arg === "-b" || arg.startsWith("--body=") || arg.startsWith("-b=")).length > 1;
    return {
      target: ambiguous ? undefined : target, approve, body, expectedHeadSha: flag(args, ["--match-head-commit"]),
      withBody: approve ? (value) => {
        const clean = [...args];
        const index = clean.findIndex((arg) => arg === "--body" || arg === "-b" || arg.startsWith("--body=") || arg.startsWith("-b="));
        if (index >= 0) clean.splice(index, clean[index].includes("=") ? 1 : 2);
        return { ...event.params, command: [...clean, "--body", value].map(quote).join(" ") };
      } : undefined,
    };
  }
  // Raw API approval bodies cannot be rewritten safely (stdin/files/GraphQL variables).
  if (args[1] === "api" && args[2] === "graphql" && args.length === 5 && ["-f", "--raw-field"].includes(args[3])) {
    return graphqlMutation(args[4].startsWith("query=") ? args[4].slice(6) : undefined);
  }
  return { approve: false, body: "" };
}

function mcpMutation(event: WakeToolEvent): Mutation | undefined {
  const name = event.toolName.toLowerCase();
  const params = event.params;
  const serialized = JSON.stringify(params);
  const approve = /approve.*pull.?request/.test(name)
    || (/review/.test(name) && String(params.event).toUpperCase() === "APPROVE");
  const merge = /merge.*pull.?request|enqueue/.test(name);
  const graph = /enqueuePullRequest|mergePullRequest|addPullRequestReview/.test(serialized);
  if (!approve && !merge && !graph) return;
  if (graph) return graphqlMutation(params.query);
  const target = validatedWakePrUrl(params.pullRequestUrl ?? params.url)
    ?? url(`${params.owner}/${params.repo}`, params.pullNumber ?? params.pull_number ?? params.number);
  return {
    target, approve, body: typeof params.body === "string" ? params.body : "",
    withBody: approve ? (body) => ({ ...params, body }) : undefined,
  };
}

/** Ticket context is server-owned; a task's self-declared grading marker is never authority. */
export function gateDecisionMutation(
  event: WakeToolEvent, blocks: readonly WakeGradingBlock[] | undefined,
  source: WakeGradingSource, cliPath: string,
): Policy | Promise<Policy | undefined> | undefined {
  const mutation = event.toolName === "exec" ? cliMutation(event, cliPath) : mcpMutation(event);
  if (!mutation) return;
  const block = blocks?.find((entry) => mutation.target
    ? entry.url.toLowerCase() === mutation.target.toLowerCase() : mutation.nodeId && entry.pr?.id === mutation.nodeId);
  if (!block?.resolved || !block.pr) return refuse("no resolved grading block on this child's ticket for the exact PR");
  if (mutation.expectedHeadSha && mutation.expectedHeadSha !== block.pr.headSha) return refuse("mutation head differs from ticket");
  if (mutation.approve && !mutation.withBody) return refuse("use a direct gh pr review --approve or GitHub MCP approval so the yardstick body can be supplied");
  return checkLiveReview(block, mutation, source);
}

async function checkLiveReview(block: WakeGradingBlock, mutation: Mutation, source: WakeGradingSource): Promise<Policy | undefined> {
  try {
    const current = await withGradingDeadline(source.pullRequest(block.url));
    if (current.id !== block.pr!.id || current.headSha !== block.pr!.headSha) {
      return refuse("head changed since grading; delegate a new decision ticket");
    }
    if (current.reviews.some((review) => review.reviewer.toLowerCase() === "imajin-jin"
      && review.state === "CHANGES_REQUESTED" && review.commitSha === current.headSha)) {
      return refuse("imajin-jin CHANGES_REQUESTED stands on the current head until a new head lands");
    }
    if (mutation.withBody) {
      return { params: mutation.withBody(`${gradingMarker(block)}\n\n${mutation.body}`) };
    }
  } catch {
    return refuse("live head/review history unavailable");
  }
}
