import { createHash } from "node:crypto";
import { mkdir, writeFile, rm, access } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const project = fileURLToPath(new URL("../", import.meta.url));
const prefix = resolve(project, ".tools/bob"),
  temp = resolve(project, ".tools/download");
const base =
  "https://s3.us-south.cloud-object-storage.appdomain.cloud/bob-shell/";
if (process.argv.includes("--help")) {
  console.log(
    "npm run setup:bob — download, SHA-256 verify and install IBM Bob Shell locally. No API key is requested. See SETUP.md.",
  );
  process.exit(0);
}
async function download(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error("Vendor download failed: " + r.status);
  return Buffer.from(await r.arrayBuffer());
}
async function execute(bin, args) {
  await new Promise((resolve, reject) => {
    const p = spawn(bin, args, {
      cwd: project,
      shell: false,
      windowsHide: true,
      stdio: "inherit",
    });
    p.once("error", reject);
    p.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error("Installer exited " + code)),
    );
  });
}
try {
  const version = (await download(base + "bobshell2-version.txt"))
    .toString()
    .trim();
  if (!/^\d+\.\d+\.\d+(?:-[a-z]+\.\d+)?$/i.test(version))
    throw new Error("Invalid vendor version");
  const expected = (await download(base + `bobshell-${version}.tgz.sha256`))
    .toString()
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected))
    throw new Error("Invalid vendor checksum");
  console.log("Downloading IBM Bob Shell " + version);
  const bytes = await download(
    base + `bobshell-${version}.tgz?Signature=${expected}`,
  );
  if (
    bytes.length > 40_000_000 ||
    createHash("sha256").update(bytes).digest("hex") !== expected
  )
    throw new Error("Bob package checksum mismatch");
  await mkdir(temp, { recursive: true });
  const archive = join(temp, "bob.tgz");
  await writeFile(archive, bytes);
  const npmCandidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
    join(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
  ].filter(Boolean);
  let npm;
  for (const path of npmCandidates)
    try {
      await access(path);
      npm = path;
      break;
    } catch {}
  if (npm)
    await execute(process.execPath, [
      npm,
      "install",
      "--prefix",
      prefix,
      archive,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--registry=https://registry.npmjs.org/",
    ]);
  else if (process.platform !== "win32")
    await execute("npm", [
      "install",
      "--prefix",
      prefix,
      archive,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ]);
  else
    throw new Error(
      "Run this installer using npm run setup:bob so npm’s JavaScript entrypoint is available",
    );
  await rm(archive);
  await execute(process.execPath, [
    join(prefix, "node_modules/bobshell/dist/bob.js"),
    "--version",
  ]);
  console.log(
    "Installed locally. No API key was requested or stored. See SETUP.md for first-use account/license setup.",
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
