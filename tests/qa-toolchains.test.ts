import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeToolchains } from "../src/qa/toolchains.ts";
import { validatePlan } from "../src/qa/contracts.ts";
import { commandIssue } from "../src/qa/reports.ts";
import { sourceLanguages } from "../public/languages.js";
const plan = () =>
  validatePlan({
    summary: "Owned toolchain fixture",
    purpose: "Users inspect a graph of their code.",
    capabilities: ["Explore dependencies"],
    languages: [{ name: "TypeScript", role: "Implements graph analysis." }],
    stack: ["Node"],
    runtime: "node22",
    install: [
      {
        label: "Install",
        argv: ["pnpm", "install", "--frozen-lockfile"],
        cwd: ".",
        timeoutSeconds: 300,
      },
    ],
    build: [
      {
        label: "Workspace build",
        argv: ["pnpm", "build"],
        cwd: ".",
        timeoutSeconds: 60,
      },
    ],
    checks: [],
    start: null,
    port: null,
    env: {},
    services: [],
  });
test("Pinned package managers cannot inject a package URL, version command or conflicting workspace pin", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofrun-toolchains-"));
  try {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ packageManager: "pnpm@10.6.2+sha512.abcdef" }),
    );
    assert.deepEqual(await nodeToolchains(plan(), root), [
      { name: "pnpm", version: "10.6.2", packageName: "pnpm" },
    ]);
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        packageManager: "pnpm@https://untrusted.invalid/tool.tgz",
      }),
    );
    assert.deepEqual(await nodeToolchains(plan(), root), [
      { name: "pnpm", version: "10.6.2", packageName: "pnpm" },
    ]);
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ packageManager: "pnpm@10.6.2" }),
    );
    await mkdir(join(root, "nested"));
    await writeFile(
      join(root, "nested/package.json"),
      JSON.stringify({ packageManager: "pnpm@9.1.0" }),
    );
    const nested = plan();
    nested.checks = [
      {
        label: "Nested test",
        argv: ["pnpm", "test"],
        cwd: "nested",
        timeoutSeconds: 120,
      },
    ];
    await assert.rejects(
      () => nodeToolchains(nested, root),
      /Conflicting pnpm/,
    );
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ packageManager: "yarn@4.9.2" }),
    );
    const yarn = plan();
    yarn.install = [];
    yarn.build = [];
    assert.deepEqual(await nodeToolchains(yarn, root), [
      { name: "yarn", version: "4.9.2", packageName: "@yarnpkg/cli-dist" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("Build deadlines allow real compilation; environment failures retain diagnostic evidence", () => {
  assert.equal(plan().build[0].timeoutSeconds, 300);
  assert.equal(plan().install[0].timeoutSeconds, 300);
  assert.equal(
    validatePlan({
      ...plan(),
      checks: [
        {
          label: "Existing suite",
          argv: ["pnpm", "test"],
          cwd: ".",
          timeoutSeconds: 60,
        },
      ],
    }).checks[0].timeoutSeconds,
    600,
  );
  const result = {
    argv: ["pnpm", "install"],
    exitCode: 127,
    timedOut: false,
    durationMs: 20,
    stdout: "",
    stderr: 'exec: "pnpm": executable file not found in $PATH',
  };
  const missing = commandIssue("install", result);
  assert.equal(missing.category, "environment");
  assert.match(missing.title, /pnpm is missing/);
  assert.equal(missing.executionContext.exitCode, 127);
  assert.match(missing.logs, /executable/);
  const storage = commandIssue("install", {
    ...result,
    exitCode: 1,
    stderr: "ERR_PNPM_ENOSPC: no space left on device",
  });
  assert.equal(storage.category, "environment");
  assert.match(storage.title, /storage limit/);
});
test("Language inventory counts implementation files without calling libraries, docs or binaries languages", () => {
  assert.deepEqual(
    sourceLanguages([
      { path: "core/app.ts", binary: false },
      { path: "ui/view.tsx", binary: false },
      { path: "tools/merge.py", binary: false },
      { path: "README.md", binary: false },
      { path: "binary.py", binary: true },
      { path: "assets/image.gif", binary: true },
    ]).map(({ name, files }) => ({ name, files })),
    [
      { name: "TypeScript", files: 2 },
      { name: "Python", files: 1 },
    ],
  );
});
