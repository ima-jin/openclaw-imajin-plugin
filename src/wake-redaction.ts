export const SECRET_KEY = /token|secret|passw|authorization|api[_-]?key|cookie|credential|private[_-]?key|claim[_-]?code|hookToken/i;
const REDACTED = "[redacted]";

/** Mask before clipping: a truncated credential must never escape as a prefix. */
export function redactWakeText(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED)
    .replace(/\b(?:gh[pos]_|github_pat_)[A-Za-z0-9_]+/g, REDACTED)
    .replace(/\bsk-[A-Za-z0-9_-]+/g, REDACTED)
    .replace(/\bxox[abp]-[A-Za-z0-9-]+/g, REDACTED)
    .replace(/\bBearer[ \t]+[^\s"'<>;,}]+/gi, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, REDACTED)
    .replace(/(^|[{\s,;])(["']?)([\w-]+)\2([ \t]*[:=][ \t]*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/g,
      (whole, prefix: string, quote: string, key: string, separator: string) =>
        SECRET_KEY.test(key) ? `${prefix}${quote}${key}${quote}${separator}${REDACTED}` : whole);
}
