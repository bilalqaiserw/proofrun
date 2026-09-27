import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { connect } from "node:net";
import { resolve } from "node:path";
import { QAEngine } from "../src/qa/engine.ts";
import { createApp } from "../src/server.ts";
import { ownWorkspaceStore } from "../src/qa/service-lock.ts";
import { finalReport } from "../src/qa/reports.ts";
import { propose } from "../src/qa/fixes.ts";
import { hash } from "../src/qa/safety.ts";
import {
  FixtureAI,
  OwnedFixtureExecutor,
  waitJob,
  original,
  cliOriginal,
  file,
} from "./support/owned-fixtures.ts";

async function harness(prefix: string, ai = new FixtureAI()) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const engine = new QAEngine(root, {
    ai,
    executor: new OwnedFixtureExecutor(),
  });
  await engine.init();
  return {
    root,
    engine,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("Malformed URL and JSON return errors without killing the service; binary preview is explicit", async () => {
  const h = await harness("proofrun-api-audit-");
  const { server } = await createApp(h.engine);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  try {
    const response: any = await new Promise((resolve, reject) => {
      const req = request(
        { hostname: "127.0.0.1", port, path: "//[" },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode, body }));
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(response.status, 400);
    assert.ok(JSON.parse(response.body).error);
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(base + "/healthz")).status, 200);
    const bad = await fetch(base + "/api/qa/projects", {
      method: "POST",
      headers: { "x-proofrun": "1" },
      body: '{"files":',
    });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /not valid JSON/);
    const job = await h.engine.create({
      files: [
        {
          path: "asset.bin",
          base64: Buffer.from([0, 255, 1]).toString("base64"),
        },
      ],
    });
    const binary = await fetch(
      base + `/api/qa/projects/${job.id}/source?path=asset.bin`,
      { headers: { "x-proofrun": "1" } },
    );
    assert.equal(binary.status, 400);
    assert.match((await binary.json()).error, /Binary assets/);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await h.cleanup();
  }
});

test("Failed intake removes only its own partial workspace and preserves existing source", async () => {
  const h = await harness("proofrun-intake-audit-");
  try {
    const job = await h.engine.create({ files: [file("app.mjs", original)] });
    const before = await readdir(h.root);
    await assert.rejects(h.engine.create(null), /Provide a project/);
    await assert.rejects(
      h.engine.create({
        files: [file("first.txt", "copied"), file("../escape.txt", "bad")],
      }),
    );
    await assert.rejects(
      h.engine.create({ localPath: join(h.root, "missing") }),
    );
    assert.deepEqual(await readdir(h.root), before);
    assert.equal(
      await readFile(join(h.engine.get(job.id).root, "app.mjs"), "utf8"),
      original,
    );
    assert.equal(h.engine.jobs.size, 1);
  } finally {
    await h.cleanup();
  }
});

test("A partial repair cannot claim all checks passed when another existing failure remains", async () => {
  const ai = new FixtureAI(),
    ask = ai.ask.bind(ai);
  const broken = original.replace(
    "res.end('ready')",
    "res.statusCode=500;res.end('broken')",
  );
  ai.ask = async (task, schema, data) => {
    const response = await ask(task, schema, data);
    if (response.patch) {
      response.patch.files[0].after = broken.replace("n*3", "n*2");
    }
    return response;
  };
  const h = await harness("proofrun-partial-audit-", ai);
  try {
    const made = await h.engine.create({ files: [file("app.mjs", broken)] });
    await h.engine.start(made.id);
    let job = await waitJob(h.engine, made.id);
    assert.equal(
      job.results.filter((r: any) => r.outcome === "failed").length,
      2,
    );
    const fix = job.fixes.find(
      (f: any) =>
        f.issueId === job.issues.find((i: any) => i.testId === "double").id,
    );
    await h.engine.approveFix(job.id, fix.id, {
      approved: true,
      revision: fix.revision,
    });
    job = await waitJob(h.engine, made.id);
    assert.equal(job.validations.at(-1).resolved, true);
    assert.equal(job.validations.at(-1).regressions.length, 0);
    assert.equal(finalReport(job).counts.failed, 1);
    assert.equal(
      job.issues.find((i: any) => i.testId === "health").status,
      "open",
    );
    assert.match(job.message, /1 check\(s\) still failed/);
    assert.doesNotMatch(job.message, /All .*passed/);
  } finally {
    await h.cleanup();
  }
});

test("Cancelling during project analysis does not invent an application defect", async () => {
  const ai = new FixtureAI();
  let entered: () => void;
  const ready = new Promise<void>((r) => (entered = r));
  ai.ask = async (_task, _schema, _data, signal: any) => {
    entered();
    return new Promise((_resolve, reject) => {
      const abort = () => reject(new Error("Cancelled reasoning"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  };
  const h = await harness("proofrun-cancel-audit-", ai);
  try {
    const made = await h.engine.create({ files: [file("app.mjs", original)] });
    await h.engine.start(made.id);
    await ready;
    await h.engine.cancel(made.id);
    const job = await waitJob(h.engine, made.id);
    assert.equal(job.phase, "cancelled");
    assert.equal(job.issues.length, 0);
    assert.equal(job.results.length, 0);
    assert.equal(job.reasoningProgress, null);
  } finally {
    await h.cleanup();
  }
});

test("Recovered interrupted runs clear stale current-test and reasoning activity", async () => {
  const h = await harness("proofrun-recovery-audit-");
  try {
    const made = await h.engine.create({ files: [file("app.mjs", original)] });
    const job = h.engine.get(made.id);
    Object.assign(job, {
      phase: "testing",
      currentTest: "Old test",
      runningTests: ["old"],
      reasoningProgress: { label: "Old reasoning", startedAt: Date.now() },
    });
    await h.engine.save(job);
    const recovered = new QAEngine(h.root);
    await recovered.init();
    const view = recovered.public(recovered.get(job.id));
    assert.equal(view.phase, "interrupted");
    assert.equal(view.busy, false);
    assert.equal(view.currentTest, null);
    assert.deepEqual(view.runningTests, []);
    assert.equal(view.reasoningProgress, null);
  } finally {
    await h.cleanup();
  }
});

test("A repair with zero executed verification cannot resolve a setup issue", async () => {
  const ai = new FixtureAI(true);
  const h = await harness("proofrun-empty-audit-", ai);
  try {
    const made = await h.engine.create({
      files: [file("app.mjs", cliOriginal)],
    });
    const job = h.engine.get(made.id);
    job.plan = await ai.ask("Determine", "", {});
    job.tests = null;
    job.issues = [{ id: "owned-issue", testId: null, status: "open" }];
    await h.engine.retest(job.id, {
      id: "owned-fix",
      issueId: "owned-issue",
    } as any);
    await waitJob(h.engine, job.id);
    assert.equal(job.validations.at(-1).resolved, false);
    assert.equal(job.issues[0].status, "open");
  } finally {
    await h.cleanup();
  }
});

test("A second server cannot own the same store, and closing releases ownership", async () => {
  const h = await harness("proofrun-owner-audit-");
  let lock: any;
  try {
    lock = await ownWorkspaceStore(h.root, 3017);
    const normalized = resolve(h.root).replaceAll("\\", "/");
    const identity = hash(
      process.platform === "win32" ? normalized.toLowerCase() : normalized,
    );
    const ownershipPort = 40000 + (parseInt(identity.slice(0, 8), 16) % 16000);
    for (let i = 0; i < 4; i++) {
      await new Promise<void>((resolve, reject) => {
        const socket = connect(ownershipPort, "127.0.0.1");
        socket.on("error", reject);
        socket.once("connect", () => {
          socket.resetAndDestroy();
          resolve();
        });
      });
    }
    await new Promise((r) => setTimeout(r, 50));
    await assert.rejects(
      ownWorkspaceStore(h.root, 3018),
      /already open at http:\/\/localhost:3017/,
    );
    await lock.close();
    lock = null;
    lock = await ownWorkspaceStore(h.root, 3018);
  } finally {
    if (lock) await lock.close();
    await h.cleanup();
  }
});

test("Editing a narrow Windows-source repair preserves line endings and a readable diff", async () => {
  const h = await harness("proofrun-diff-audit-");
  try {
    const before = "export function double(n) {\r\n  return n * 3;\r\n}\r\n";
    const made = await h.engine.create({ files: [file("source.mjs", before)] });
    const fix = await propose(h.engine.get(made.id).root, "owned", {
      explanation: "Correct documented arithmetic",
      risks: "Changes results",
      files: [
        {
          path: "source.mjs",
          beforeHash: hash(before),
          after: before.replaceAll("\r\n", "\n").replace("n * 3", "n * 2"),
        },
      ],
    });
    assert.equal(fix.files[0].after, before.replace("n * 3", "n * 2"));
    assert.ok(
      !fix.files[0].diff.includes("-export function"),
      "Unchanged lines must remain context",
    );
    assert.ok(fix.files[0].diff.includes("+  return n * 2;"));
    assert.equal(
      await readFile(join(h.engine.get(made.id).root, "source.mjs"), "utf8"),
      before,
    );
  } finally {
    await h.cleanup();
  }
});

test("Approval keeps the workspace locked until retesting reserves its execution slot", async () => {
  const h = await harness("proofrun-handoff-audit-");
  let release: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let entered: () => void;
  const ready = new Promise<void>((r) => (entered = r));
  try {
    const made = await h.engine.create({ files: [file("app.mjs", original)] });
    await h.engine.start(made.id);
    let job = await waitJob(h.engine, made.id);
    const fix = job.fixes[0],
      status = h.engine.executor.status.bind(h.engine.executor);
    let calls = 0;
    h.engine.executor.status = async () => {
      if (++calls === 2) {
        entered();
        await gate;
      }
      return status();
    };
    const approval = h.engine.approveFix(job.id, fix.id, {
      approved: true,
      revision: fix.revision,
    });
    await ready;
    assert.equal(h.engine.locks.has(job.id), true);
    await assert.rejects(
      h.engine.start(job.id),
      /already running|current operation/,
    );
    assert.notEqual(
      finalReport(job).project.currentSnapshot,
      job.snapshot,
      "Report identifies approved source even before retesting completes",
    );
    release();
    await approval;
    job = await waitJob(h.engine, job.id);
    assert.equal(job.validations.at(-1).resolved, true);
    assert.equal(h.engine.locks.has(job.id), false);
  } finally {
    release?.();
    await h.cleanup();
  }
});
