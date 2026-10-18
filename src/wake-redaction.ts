export const SECRET_KEY = /token|secret|passw|authorization|api[_-]?key|cookie|credential|private[_-]?key|claim[_-]?code|hookToken/i;
const REDACTED = "[redacted]";
const ASSIGNMENT = /(^|[{\s,;])(["']?)([\w-]+)\2([ \t]*[:=][ \t]*)/g;

function quotedValueEnd(text: string, start: number, quote: string): number {
  for (let end = start + 1; end < text.length; end++) {
    if (text[end] === "\\") end++;
    else if (text[end] === quote) return end + 1;
  }
  return text.length;
}

function assignmentValueEnd(text: string, start: number): number {
  const quote = text[start];
  if (quote === '"' || quote === "'") return quotedValueEnd(text, start, quote);
  let end = start;
  while (end < text.length && !/[\s,;}\]]/.test(text[end])) end++;
  return end;
}

function redactAssignments(text: string): string {
  let output = "";
  let end = 0;
  for (const match of text.matchAll(ASSIGNMENT)) {
    if (match.index < end || !SECRET_KEY.test(match[3])) continue;
    output += text.slice(end, match.index) + match[0] + REDACTED;
    end = assignmentValueEnd(text, match.index + match[0].length);
  }
  return output + text.slice(end);
}

/** Mask before clipping: a truncated credential must never escape as a prefix. */
export function redactWakeText(text: string): string {
  return redactAssignments(text)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED)
    .replace(/\b(?:gh[pos]_|github_pat_)\w+/g, REDACTED)
    .replace(/\bsk-[\w-]+/g, REDACTED)
    .replace(/\bxox[abp]-[A-Za-z0-9-]+/g, REDACTED)
    .replace(/\bBearer[ \t]+[^\s"'<>;,}]+/gi, REDACTED)
    .replace(/\beyJ[\w-]*\.[\w-]+\.[\w-]+/g, REDACTED);
}
