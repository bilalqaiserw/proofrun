import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  lstat,
  realpath,
} from "node:fs/promises";
import { join, resolve, relative, parse } from "node:path";
import { hash, safePath, inside, excluded, sensitive } from "./safety.ts";
import { PROJECT_LIMITS, formatBytes } from "../../public/project-limits.js";

export type FileEntry = {
  path: string;
  size: number;
  hash: string;
  binary: boolean;
};
export const MAX_PROJECT_BYTES = PROJECT_LIMITS.maxProjectBytes;
export async function ingest(root: string, files: any[]) {
  if (!Array.isArray(files) || !files.length || files.length > 2000)
    throw new Error("Upload 1–2000 files, up to 128 MB total");
  const seen = new Set<string>();
  let bytes = 0;
  const omitted: string[] = [];
  // Validate the complete submission before writing any source.
  const accepted = files
    .map((file) => {
      const path = safePath(file?.path);
      const folded = path.toLowerCase();
      if (seen.has(folded))
        throw new Error("Duplicate or case-colliding project path");
      seen.add(folded);
      if (excluded.test(path) || sensitive.test(path)) {
        omitted.push(path);
        return null;
      }
      if (
        typeof file.base64 === "string" &&
        file.base64.length > Math.ceil(PROJECT_LIMITS.maxFileBytes / 3) * 4
      )
        throw new Error(`${path} exceeds the 32 MB per-file limit`);
      if (
        typeof file.base64 !== "string" ||
        file.base64.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(file.base64)
      )
        throw new Error("File data must be base64");
      const data = Buffer.from(file.base64, "base64");
      bytes += data.length;
      if (
        process.env.BOBSHELL_API_KEY &&
        data.includes(Buffer.from(process.env.BOBSHELL_API_KEY))
      )
        throw new Error("Remove the server Bob API key from submitted source");
      if (data.length > PROJECT_LIMITS.maxFileBytes)
        throw new Error(
          `${path} is ${formatBytes(data.length)}; each file can be up to 32 MB`,
        );
      if (bytes > MAX_PROJECT_BYTES)
        throw new Error(
          `Project is larger than 128 MB after excluding dependencies and credentials`,
        );
      return { path, data };
    })
    .filter(Boolean) as { path: string; data: Buffer }[];
  if (!accepted.length)
    throw new Error(
      "No project files remain after excluding dependencies and credentials",
    );
  await mkdir(root, { recursive: true });
  for (const file of accepted) {
    const target = inside(root, file.path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, file.data);
  }
  return { files: await inventory(root), omitted };
}
export async function connect(root: string, input: string) {
  if (typeof input !== "string" || !input.trim())
    throw new Error("Provide the absolute path to a source folder");
  const base = await realpath(resolve(input));
  if (base === parse(base).root || !(await lstat(base)).isDirectory())
    throw new Error("Choose a project directory, not a filesystem root");
  if (
    root.toLowerCase().startsWith(base.toLowerCase() + "\\") ||
    root.startsWith(base + "/")
  )
    throw new Error(
      "Choose the application folder, not ProofRun’s data parent",
    );
  const files: any[] = [];
  let total = 0;
  const omitted: string[] = [];
  async function visit(dir: string, depth: number) {
    if (depth > 20)
      throw new Error("Project directory nesting exceeds 20 levels");
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const source = join(dir, entry.name);
      const path = relative(base, source).replaceAll("\\", "/");
      if (
        entry.isSymbolicLink() ||
        excluded.test(path) ||
        sensitive.test(path)
      ) {
        omitted.push(path);
        continue;
      }
      if (entry.isDirectory()) await visit(source, depth + 1);
      else if (entry.isFile()) {
        const stat = await lstat(source);
        total += stat.size;
        if (
          stat.size > PROJECT_LIMITS.maxFileBytes ||
          total > MAX_PROJECT_BYTES ||
          files.length >= 2000
        )
          throw new Error(
            `Project exceeds 2000 files / 128 MB, or ${path} exceeds 32 MB per file`,
          );
        const data = await readFile(source);
        files.push({ path, base64: data.toString("base64") });
      }
    }
  }
  await visit(base, 0);
  const result = await ingest(root, files);
  result.omitted.push(...omitted);
  return result;
}
export async function inventory(root: string): Promise<FileEntry[]> {
  const files: FileEntry[] = [];
  async function visit(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const target = join(dir, entry.name);
      const path = relative(root, target).replaceAll("\\", "/");
      if (entry.isSymbolicLink())
        throw new Error("Symlinks are not supported in a managed project");
      if (entry.isDirectory()) await visit(target);
      else {
        const data = await readFile(target);
        files.push({
          path,
          size: data.length,
          hash: hash(data),
          binary: data.includes(0),
        });
      }
    }
  }
  await visit(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
export async function reasoningContext(root: string) {
  const files = await inventory(root);
  let size = 0;
  const selected = [...files].sort((a, b) => {
    const score = (p: string) =>
      /(^|\/)(README[^/]*|package\.json|pyproject\.toml|requirements[^/]*|go\.mod|Cargo\.toml|pom\.xml|build\.gradle|.*\.csproj|Gemfile|composer\.json|Makefile|Dockerfile|.*\.ya?ml)$/i.test(
        p,
      )
        ? 0
        : /test|spec|lock/i.test(p)
          ? 2
          : 1;
    return score(a.path) - score(b.path) || a.path.localeCompare(b.path);
  });
  const excerpts: {
    path: string;
    content: string;
    hash: string;
    truncated: boolean;
  }[] = [];
  for (const file of selected) {
    if (
      file.binary ||
      size >= 260_000 ||
      excerpts.length >= 140 ||
      /lock\.(json|yaml)$|package-lock\.json$/.test(file.path)
    )
      continue;
    const text = (await readFile(inside(root, file.path), "utf8")).slice(
      0,
      Math.min(25_000, 260_000 - size),
    );
    size += text.length;
    excerpts.push({
      path: file.path,
      content: text,
      hash: file.hash,
      truncated: Buffer.byteLength(text) < file.size,
    });
  }
  return {
    snapshot: hash(JSON.stringify(files)),
    inventory: files,
    excerpts,
    limits:
      "All submitted files are available to execution; AI context is bounded to 140 files / 260 KB. Missing context must be reported.",
  };
}
