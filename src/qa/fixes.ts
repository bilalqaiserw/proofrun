import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, lstat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { hash, inside, safePath, sensitive, excluded } from "./safety.ts";
import { reasoningContext } from "./projects.ts";

export type PatchFile = {
  path: string;
  beforeHash: string | null;
  after: string;
  before: string;
  diff: string;
};
export type Fix = {
  id: string;
  issueId: string;
  revision: number;
  snapshot: string;
  status: "proposed" | "rejected" | "applied";
  explanation: string;
  risks: string;
  files: PatchFile[];
  approvedAt?: string;
  retest?: any;
};
export function makeDiff(path: string, before: string, after: string) {
  const a = before.split("\n"),
    b = after.split("\n");
  let start = 0,
    tail = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (
    tail < a.length - start &&
    tail < b.length - start &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const from = Math.max(0, start - 3),
    end = Math.min(3, tail);
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${from + 1},${a.length - tail + end - from} +${from + 1},${b.length - tail + end - from} @@`,
    ...a.slice(from, start).map((s) => " " + s),
    ...a.slice(start, a.length - tail).map((s) => "-" + s),
    ...b.slice(start, b.length - tail).map((s) => "+" + s),
    ...a.slice(a.length - tail, a.length - tail + end).map((s) => " " + s),
  ].join("\n");
}
export async function propose(
  root: string,
  issueId: string,
  input: any,
): Promise<Fix> {
  if (
    !input ||
    typeof input.explanation !== "string" ||
    !input.explanation.trim() ||
    typeof input.risks !== "string" ||
    !Array.isArray(input.files) ||
    !input.files.length ||
    input.files.length > 8
  )
    throw new Error("A fix needs an explanation, risks and 1–8 source changes");
  const context = await reasoningContext(root);
  const files: PatchFile[] = [];
  const seen = new Set();
  let total = 0;
  for (const file of input.files) {
    const path = safePath(file.path);
    if (
      seen.has(path.toLowerCase()) ||
      sensitive.test(path) ||
      excluded.test(path) ||
      /(^|\/)(tests?|specs?|scenarios|evidence)(\/|$)|\.(test|spec)\.|(^|\/)test[^/]*\.(py|go|rb)$|_test\.(go|py|rb)$/i.test(
        path,
      )
    )
      throw new Error(
        "Fixes cannot edit credentials, generated dependencies or test contracts",
      );
    seen.add(path.toLowerCase());
    if (typeof file.after !== "string" || file.after.length > 180000)
      throw new Error("Proposed file exceeds 180 KB");
    if (
      process.env.BOBSHELL_API_KEY &&
      file.after.includes(process.env.BOBSHELL_API_KEY)
    )
      throw new Error("Proposed source cannot contain the server API key");
    total += file.after.length;
    if (total > 350000) throw new Error("Proposed patch exceeds 350 KB");
    let before = "";
    let currentHash: string | null = null;
    try {
      const stat = await lstat(inside(root, path));
      if (stat.isSymbolicLink() || !stat.isFile())
        throw new Error("Only regular files can be patched");
      before = await readFile(inside(root, path), "utf8");
      currentHash = hash(before);
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
    if (file.beforeHash !== currentHash)
      throw new Error("The proposed patch has stale source hashes: " + path);
    if (before === file.after)
      throw new Error("The proposed patch makes no change: " + path);
    // Textareas and model output use LF. Retain a file's consistent Windows
    // line endings so a small approved change does not rewrite every line.
    const after =
      before.includes("\r\n") && !/(?<!\r)\n/.test(before)
        ? file.after.replace(/\r?\n/g, "\r\n")
        : file.after;
    files.push({
      path,
      beforeHash: currentHash,
      before,
      after,
      diff: makeDiff(path, before, after),
    });
  }
  return {
    id: randomUUID(),
    issueId,
    revision: 1,
    snapshot: context.snapshot,
    status: "proposed",
    explanation: input.explanation.slice(0, 6000),
    risks: input.risks.slice(0, 3000),
    files,
  };
}
export async function apply(root: string, fix: Fix, approval: any) {
  if (
    approval?.approved !== true ||
    approval.revision !== fix.revision ||
    fix.status !== "proposed"
  )
    throw new Error(
      "Explicit approval of the current diff revision is required",
    );
  if ((await reasoningContext(root)).snapshot !== fix.snapshot)
    throw new Error(
      "Project changed after this proposal. Generate a fresh fix before approving",
    );
  for (const file of fix.files) {
    let currentHash: string | null = null;
    try {
      currentHash = hash(await readFile(inside(root, file.path)));
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
    if (currentHash !== file.beforeHash)
      throw new Error("Source precondition changed: " + file.path);
  }
  const written: PatchFile[] = [];
  try {
    for (const file of fix.files) {
      const path = inside(root, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.after);
      written.push(file);
    }
  } catch (error) {
    for (const file of written) {
      if (file.beforeHash === null) await unlink(inside(root, file.path));
      else await writeFile(inside(root, file.path), file.before);
    }
    throw error;
  }
  fix.status = "applied";
  fix.approvedAt = new Date().toISOString();
  return fix;
}

// Approve the displayed revisions as one transaction. All preconditions are
// checked before any writes; shared identical patches are applied only once.
export async function applyBatch(root: string, fixes: Fix[], approval: any) {
  if (approval?.approved !== true || !Array.isArray(approval.fixes) ||
      !fixes.length || approval.fixes.length !== fixes.length)
    throw new Error("Explicit approval of every current diff revision is required");
  const revisions = new Map(approval.fixes.map((f: any) => [f.id, f.revision]));
  if (revisions.size !== fixes.length || fixes.some(f =>
      f.status !== "proposed" || revisions.get(f.id) !== f.revision))
    throw new Error("Explicit approval of every current diff revision is required");
  const snapshot = fixes[0].snapshot;
  if (fixes.some(f => f.snapshot !== snapshot))
    throw new Error("Proposals refer to different source versions. Generate fresh proposals before repairing");
  const files = new Map<string, PatchFile>();
  for (const fix of fixes) for (const file of fix.files) {
    const key = file.path.toLowerCase(), previous = files.get(key);
    if (previous && (previous.path !== file.path || previous.beforeHash !== file.beforeHash || previous.after !== file.after))
      throw new Error("Proposals conflict in " + file.path + ". Edit or reject a conflicting proposal before repairing. No changes were applied");
    files.set(key, file);
  }
  const combined: Fix = { ...fixes[0], files: [...files.values()] };
  await apply(root, combined, { approved: true, revision: combined.revision });
  for (const fix of fixes) {
    fix.status = "applied";
    fix.approvedAt = combined.approvedAt;
  }
  return fixes;
}
