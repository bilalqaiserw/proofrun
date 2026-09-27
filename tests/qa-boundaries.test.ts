import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingest } from "../src/qa/projects.ts";
import { safePath, hash, redactValue } from "../src/qa/safety.ts";
import { exportZip, importZip } from "../src/qa/zip.ts";
import { propose, apply } from "../src/qa/fixes.ts";
import { validatePlan, validateTests } from "../src/qa/contracts.ts";
import { run } from "../src/qa/process.ts";
import { QAEngine } from "../src/qa/engine.ts";
import { createServer } from "node:http";
import { PROJECT_LIMITS } from "../public/project-limits.js";
import { BobReasoner, bobEnvironment } from "../src/qa/bob.ts";
import { resolve } from "node:path";
const file = (path: string, value: string) => ({
  path,
  base64: Buffer.from(value).toString("base64"),
});
test("Bob presence checks local installation without launching a slow CLI", async () => {
  const originalEnv = { BOBSHELL_API_KEY: "proofrun-test-auth", BOB_API_KEY: "old-test-auth", PORT: "3000" };
  const mapped = bobEnvironment(originalEnv);
  assert.equal(mapped.BOB_API_KEY, "proofrun-test-auth");
  assert.equal(mapped.BOBSHELL_API_KEY, "proofrun-test-auth");
  assert.equal(originalEnv.BOB_API_KEY, "old-test-auth", "Mapping cannot mutate the caller's environment");
  assert.equal(bobEnvironment({ BOB_API_KEY: "standalone-test-auth" }).BOB_API_KEY, "standalone-test-auth");
  const root = await mkdtemp(join(tmpdir(), "proofrun-bob-status-"));
  try {
    await mkdir(join(root, "dist"));
    await writeFile(
      join(root, "dist/bob.js"),
      "throw new Error('status must not execute this entrypoint')",
    );
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "bobshell", version: "2.0.5" }),
    );
    const bob = new BobReasoner(root);
    bob.entry = join(root, "dist/bob.js");
    bob.invoke = async () => {
      throw new Error("A CLI timeout must not mark installed files missing");
    };
    const status = await bob.status();
    assert.equal(status.installed, true);
    assert.equal(status.version, "2.0.5");
    bob.entry = join(root, "missing.js");
    assert.equal((await bob.status()).installed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("Large assets retain byte integrity while per-file and ZIP expansion limits remain enforced", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofrun-large-"));
  try {
    const binary = Buffer.alloc(6_000_000, 31);
    binary[0] = 0;
    const result = await ingest(root, [
      { path: "image.bin", base64: binary.toString("base64") },
    ]);
    assert.equal(result.files[0].size, binary.length);
    assert.equal(result.files[0].hash, hash(binary));
    const tooLarge = "A".repeat(
      Math.ceil(PROJECT_LIMITS.maxFileBytes / 3) * 4 + 4,
    );
    await assert.rejects(
      () => ingest(root, [{ path: "too-large.bin", base64: tooLarge }]),
      /too-large.bin.*32 MB/,
    );
    const zip = await exportZip(root);
    const central = zip.readUInt32LE(zip.length - 22 + 16);
    zip.writeUInt32LE(PROJECT_LIMITS.maxFileBytes + 1, central + 24);
    assert.throws(() => importZip(zip), /safe extraction limits/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("Upload paths, credential exclusion, binary ZIP roundtrip and corrupted archives", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofrun-bounds-"));
  try {
    for (const path of [
      "../escape",
      "/etc/passwd",
      "C:/test",
      "a\\b",
      "con",
      "a/../b",
      "a:ads",
    ])
      assert.throws(() => safePath(path));
    await assert.rejects(
      () => ingest(root, [file("a.ts", "x"), file("A.ts", "y")]),
      /colliding/,
    );
    const result = await ingest(root, [
      file("app.ts", "code"),
      file(".env", "SECRET=do-not-copy"),
      {
        path: "image.bin",
        base64: Buffer.from([0, 1, 255]).toString("base64"),
      },
    ]);
    assert.equal(result.omitted.length, 1);
    assert.equal(result.files.length, 2);
    const zip = await exportZip(root),
      copy = importZip(zip);
    assert.deepEqual(
      Buffer.from(copy.find((f) => f.path === "image.bin")!.base64, "base64"),
      Buffer.from([0, 1, 255]),
    );
    const corrupt = Buffer.from(zip);
    corrupt[40] ^= 255;
    assert.throws(() => importZip(corrupt));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("Approval requires exact source snapshot and rejects modifying test contracts", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofrun-approval-"));
  try {
    await ingest(root, [
      file("app.py", "print(3)"),
      file("test_app.py", "assert True"),
    ]);
    const input = {
      explanation: "Arithmetic repair",
      risks: "Behavior changes",
      files: [
        { path: "app.py", beforeHash: hash("print(3)"), after: "print(2)" },
      ],
    };
    const fix = await propose(root, "issue", input);
    await assert.rejects(
      () => apply(root, fix, { approved: true, revision: 0 }),
      /approval/,
    );
    await assert.rejects(
      () =>
        propose(root, "issue", {
          ...input,
          files: [
            {
              path: "test_app.py",
              beforeHash: hash("assert True"),
              after: "pass",
            },
          ],
        }),
      /test contracts/,
    );
    await writeFile(join(root, "another.txt"), "changed");
    await assert.rejects(
      () => apply(root, fix, { approved: true, revision: 1 }),
      /Project changed/,
    );
    assert.equal(await readFile(join(root, "app.py"), "utf8"), "print(3)");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("Generated contracts cannot select arbitrary images, host paths or external URLs", () => {
  const plan = {
    summary: "fixture",
    stack: ["node"],
    runtime: "evil/image",
    install: [],
    build: [],
    checks: [],
    start: null,
    port: null,
    env: {},
    services: [],
  };
  assert.throws(() => validatePlan(plan), /runtime/);
  assert.throws(
    () =>
      validatePlan({
        ...plan,
        runtime: "node",
        install: [{ label: "bad", argv: ["echo", "x"], cwd: "../host" }],
      }),
    /relative/,
  );
  assert.throws(
    () =>
      validateTests({
        http: [
          {
            id: "bad",
            title: "Bad",
            intent: "x",
            expected: "x",
            basis: "assumption",
            steps: [
              {
                label: "external",
                method: "GET",
                path: "https://example.com",
                assertions: [{ kind: "not5xx" }],
              },
            ],
          },
        ],
        browser: [],
        commands: [],
      }),
    /relative/,
  );
});
test("Real processes: timeout termination, nonzero exit, stdout/stderr capture", async () => {
  const timeout = await run(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    { timeout: 80 },
  );
  assert.equal(timeout.timedOut, true);
  assert.notEqual(timeout.exitCode, 0);
  const failed = await run(process.execPath, [
    "-e",
    "console.log('action started');throw new Error('owned fixture crash')",
  ]);
  assert.notEqual(failed.exitCode, 0);
  assert.match(failed.stdout, /action started/);
  assert.match(failed.stderr, /owned fixture crash/);
});
test("Missing prerequisites produce a blocked report with zero executed tests", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofrun-blocked-"));
  const engine = new QAEngine(root, {
    ai: {
      async status() {
        return { installed: true, keyConfigured: false };
      },
      async ask() {
        throw new Error("Must not call AI without setup");
      },
    },
    executor: {
      async status() {
        return { available: false };
      },
      async open() {
        throw new Error("Must not execute without Docker");
      },
    },
  });
  try {
    await engine.init();
    const job = await engine.create({
      files: [file("main.rs", "fn main() {}")],
    });
    const started = await engine.start(job.id);
    assert.equal(started.phase, "blocked");
    assert.equal(started.results.length, 0);
    assert.match(started.message, /BOBSHELL_API_KEY/);
    assert.match(started.message, /Docker/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("Server secret redaction preserves valid JSON", () => {
  const old = process.env.BOBSHELL_API_KEY;
  process.env.BOBSHELL_API_KEY = "owned-secret-test";
  try {
    const json = JSON.stringify(
      redactValue({
        logs: "password=hello",
        trace: "owned-secret-test",
        nested: ["api_key=hello"],
      }),
    );
    assert.ok(!json.includes("owned-secret-test"));
    assert.doesNotThrow(() => JSON.parse(json));
  } finally {
    if (old === undefined) delete process.env.BOBSHELL_API_KEY;
    else process.env.BOBSHELL_API_KEY = old;
  }
});
test("HTTP worker: malformed JSON, null expectations and typed captured input are actually executed", async () => {
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    res.setHeader("content-type", "application/json");
    try {
      const value = JSON.parse(text || "{}");
      res.end(JSON.stringify({ id: 7, nullable: null, input: value }));
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "malformed JSON" }));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const base = "http://127.0.0.1:" + (server.address() as any).port;
    const r = await run(process.execPath, [resolve("worker/http.mjs")], {
      input: JSON.stringify({
        base,
        test: {
          id: "typed",
          steps: [
            {
              label: "Capture ID",
              method: "POST",
              path: "/",
              body: { value: 0 },
              capture: { identifier: "id" },
              assertions: [{ kind: "json", path: "nullable", equals: null }],
            },
            {
              label: "Use ID as number",
              method: "POST",
              path: "/",
              body: { id: "{{identifier}}" },
              assertions: [{ kind: "json", path: "input.id", equals: 7 }],
            },
            {
              label: "Malformed JSON",
              method: "POST",
              path: "/",
              rawBody: '{"broken":',
              headers: { "content-type": "application/json" },
              assertions: [{ kind: "status", equals: 400 }],
            },
          ],
        },
      }),
    });
    assert.equal(r.exitCode, 0, r.stderr);
    const result = JSON.parse(r.stdout);
    assert.equal(result.outcome, "passed");
    assert.equal(result.trace[2].request.body, '{"broken":');
    assert.equal(result.trace[2].response.status, 400);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
