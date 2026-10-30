import type { WakeToolEvent } from "./wake-decision.js";
import { gradingMarker, withGradingDeadline, type WakeGradingBlock, type WakeGradingSource } from "./wake-grading.js";
import { validatedWakePrUrl } from "./wake-live-state.js";

interface Policy { block?: boolean; blockReason?: string; params?: Record<string, unknown> }
interface Mutation {
  parseError?: string;
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

function negativeReview(args: string[]): boolean {
  return args.some((arg) => ["--request-changes", "--comment", "-r", "-c"].includes(arg))
    && !args.some((arg) => arg.startsWith("-a"));
}

const unparseable = (): Mutation => ({
  approve: false, body: "", parseError: "use one literal gh command with an exact PR URL or --repo; single-quote Markdown bodies",
});

function apiMutation(args: string[]): Mutation | undefined {
  const method = flag(args, ["--method", "-X"]) ?? args.find((arg) => /^-X./.test(arg))?.slice(2);
  const fields = args.some((arg) => /^(?:--(?:raw-)?field|--input|-f|-F)/.test(arg));
  const methods = args.filter((arg) => /^(?:--method(?:=|$)|-X)/.test(arg));
  if (args[1] === "api" && args[2] !== "graphql" && methods.length <= 1
    && (method === "GET" || (!method && !fields))) return;
  if (args[1] === "api" && args[2] === "graphql" && args.length === 5 && ["-f", "--raw-field"].includes(args[3])) {
    const query = args[4].startsWith("query=") ? args[4].slice(6) : undefined;
    if (query && /^\s*(?:query\b|\{)/.test(query)) return;
    return graphqlMutation(query);
  }
  return unparseable();
}

function cliMutation(event: WakeToolEvent, cliPath: string): Mutation | undefined {
  const args = mutationWords(event, cliPath);
  if (args === undefined) return;
  if (args === null) return unparseable();
  if ((args[1] === "pr" && ["view", "diff", "checks"].includes(args[2]))
    || (args[1] === "issue" && args[2] === "view")) return;
  if (args[1] !== "api" && !(args[1] === "pr" && ["merge", "review"].includes(args[2]))) return unparseable();
  const review = args[1] === "pr" && args[2] === "review";
  const approve = review && args.some((arg) => arg === "--approve" || arg === "-a");
  if (review && !approve && negativeReview(args)) return;
  if (args[1] === "pr" && (args[2] === "merge" || approve)) return directMutation(event, args, approve);
  return apiMutation(args);
}

function mutationWords(event: WakeToolEvent, cliPath: string): string[] | null | undefined {
  const command = event.params.command;
  if (typeof command !== "string") return;
  const sensitive = (/\bgh\b/.test(command) || command.includes(cliPath)) && /\b(?:merge|review|api)\b/.test(command);
  if (!sensitive) return;
  const args = words(command);
  if (!args || !["gh", cliPath].includes(args[0]) || event.params.env !== undefined) {
    return null;
  }
  return args;
}
const refuse = (reason: string): Policy => ({ block: true, blockReason: `Decision merge-side call blocked: ${reason}. Report blocked.` });
const quote = (text: string) => "'" + text.replaceAll("'", String.raw`'\''`) + "'";

/** Literal shell words only. Single quotes may contain arbitrary Markdown. */
function words(command: string): string[] | undefined {
  const result: string[] = [];
  const token = /'[^']*'|"[^"$`\\]*"|\\'|[^\s'";&|<>()#$`\\*?~{}]+/y;
  let value = "";
  let started = false;
  let offset = 0;
  while (offset < command.length) {
    if (/[\r\n]/.test(command[offset])) return;
    if (/\s/.test(command[offset])) {
      if (started) result.push(value);
      value = "";
      started = false;
      offset++;
      continue;
    }
    token.lastIndex = offset;
    const match = token.exec(command);
    if (!match) return;
    offset = token.lastIndex;
    value += literalToken(match[0]);
    started = true;
  }
  if (started) result.push(value);
  return result;
}

function literalToken(value: string): string {
  if (value === "\\'") return "'";
  return value.startsWith("'") || value.startsWith('"') ? value.slice(1, -1) : value;
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
  const invalid = unparseable();
  if (typeof query !== "string" || /\\/.test(query)) return invalid;
  const compact = query.split(/("[^"]*")/).map((part, index) => index % 2 ? part : part.replaceAll(/\s/g, "")).join("");
  const prefix = /^mutation\{(enqueuePullRequest|mergePullRequest)\(input:\{pullRequestId:"(PR_[\w-]+)"/.exec(compact);
  if (!prefix) return invalid;
  let suffix = compact.slice(prefix[0].length);
  const head = /^,expectedHeadOid:"([a-f0-9]{40,64})"/.exec(suffix);
  if (head) suffix = suffix.slice(head[0].length);
  if (!["}){clientMutationId}}", "}){pullRequest{id}}}"].includes(suffix)) return invalid;
  return { nodeId: prefix[2], expectedHeadSha: head?.[1], approve: false, body: "" };
}

function duplicateFlag(args: string[], names: string[]): boolean {
  return args.filter((arg) => names.includes(arg.split("=")[0])).length > 1;
}

function approvalBody(event: WakeToolEvent, args: string[], value: string): Record<string, unknown> {
  const clean = [...args];
  const index = clean.findIndex((arg) => ["--body", "-b"].includes(arg.split("=")[0]));
  if (index >= 0) clean.splice(index, clean[index].includes("=") ? 1 : 2);
  return { ...event.params, command: [...clean, "--body", value].map(quote).join(" ") };
}

function directMutation(event: WakeToolEvent, args: string[], approve: boolean): Mutation {
  const repository = flag(args, ["--repo", "-R"]);
  const directUrl = validatedWakePrUrl(args[3]);
  const target = directUrl ?? url(repository, args[3]);
  const body = flag(args, ["--body", "-b"]) ?? "";
  const ambiguous = !directFlags(args, approve)
    || (directUrl && repository && !directUrl.includes(`/${repository}/pull/`))
    || duplicateFlag(args, ["--repo", "-R"]) || duplicateFlag(args, ["--body", "-b"]);
  if (ambiguous || !target) return unparseable();
  return {
    target, approve, body, expectedHeadSha: flag(args, ["--match-head-commit"]),
    withBody: approve ? (value) => approvalBody(event, args, value) : undefined,
  };
}

function mcpMutation(event: WakeToolEvent): Mutation | undefined {
  const name = event.toolName.toLowerCase();
  const params = event.params;
  const serialized = JSON.stringify(params);
  const approve = /approve.*pull.?request/.test(name)
    || (/review/.test(name) && String(params.event).toUpperCase() === "APPROVE");
  const merge = /merge.*pull.?request|enqueue/.test(name)
    || (/pull.?request/.test(name) && /^(?:merge|enqueue)$/i.test(String(params.method ?? params.action)));
  const graph = /enqueuePullRequest|mergePullRequest|addPullRequestReview/.test(serialized);
  if (!approve && !merge && !graph) return;
  if (merge) return { approve: false, body: "" };
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
  if (mutation.parseError) return refuse(`command not parseable for the merge gate: ${mutation.parseError}`);
  if (!mutation.approve) return refuse("wake paths never merge or enqueue; report the verdict instead");
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
