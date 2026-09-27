import { createHash } from "node:crypto";
import { resolve, relative, isAbsolute } from "node:path";

export const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export function safePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 400 ||
    value.includes("\\") ||
    value.includes(":") ||
    /[\x00-\x1f]/.test(value) ||
    value.startsWith("/") ||
    value
      .split("/")
      .some(
        (p) =>
          !p ||
          p === "." ||
          p === ".." ||
          /[. ]$/.test(p) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
      )
  )
    throw new Error("Use a safe relative project path");
  return value;
}
export function inside(root: string, path: string) {
  const target = resolve(root, safePath(path));
  const rel = relative(resolve(root), target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel))
    throw new Error("Path leaves the project");
  return target;
}
export const excluded =
  /(^|\/)(node_modules|\.git|\.bob|\.codex|\.tools|\.proofrun-data|\.ssh|\.aws|\.azure|\.kube|\.venv|venv|__pycache__|\.idea|\.vs|target|dist|build|coverage)(\/|$)/i;
export const sensitive =
  /(^|\/)(\.env(?!\.example$|\.sample$)[^/]*|.*\.(?:pem|key|p12|pfx)|id_rsa|id_ed25519|.*(?:credentials|secrets)[^/]*|\.npmrc|\.pypirc|\.netrc)(\/|$)/i;
export function maskServerSecrets(text: string): string {
  let result = text;
  for (const name of [
    "BOBSHELL_API_KEY",
    "BOB_API_KEY",
    "PROOFRUN_ACCESS_TOKEN",
  ]) {
    const value = process.env[name];
    if (value) result = result.split(value).join("[REDACTED]");
  }
  return result;
}
export function redact(text: string): string {
  return maskServerSecrets(text).replace(
    /((?:authorization|api[_-]?key|password|access[_-]?token)\s*[=:]\s*)[^\s,;]+/gi,
    "$1[REDACTED]",
  );
}
export function redactValue(value: any): any {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, redactValue(v)]),
    );
  return value;
}
export function jsonObject(text: string): any {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let direct;
  try {
    direct = JSON.parse(cleaned);
  } catch {}
  if (direct !== undefined) {
    if (!direct || typeof direct !== "object" || Array.isArray(direct))
      throw new Error("AI must return a JSON object");
    return direct;
  }
  {
    // Bob's CLI JSON envelope does not guarantee that last_message is JSON.
    // Extract a complete object from commentary without changing its contents.
    // Track quoted strings so braces/code in a proposed patch remain intact.
    const candidates: any[] = [];
    let start = -1,
      depth = 0,
      quoted = false,
      escaped = false;
    for (let index = 0; index < cleaned.length; index++) {
      const char = cleaned[index];
      if (start < 0) {
        if (char === "{") {
          start = index;
          depth = 1;
        }
        continue;
      }
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{") depth++;
      else if (char === "}" && --depth === 0) {
        try {
          candidates.push(JSON.parse(cleaned.slice(start, index + 1)));
        } catch {}
        start = -1;
      }
    }
    if (candidates.length !== 1)
      throw new Error(
        candidates.length > 1
          ? "Bob returned multiple JSON objects; the response is ambiguous"
          : "Bob did not return a complete JSON object",
      );
    return candidates[0];
  }
}
export function short(value: unknown, max = 500) {
  return typeof value === "string" ? value.slice(0, max) : "";
}
