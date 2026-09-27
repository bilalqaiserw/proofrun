import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { applyBatch, propose } from "../src/qa/fixes.ts";
import { hash } from "../src/qa/safety.ts";
import { QAEngine } from "../src/qa/engine.ts";
import { createApp } from "../src/server.ts";
import { run } from "../src/qa/process.ts";
import { FixtureAI, OwnedFixtureExecutor, original, file, waitJob } from "./support/owned-fixtures.ts";

test("Main repair approves every pending revision without scrolling; issue cards keep only edit/reject", async () => {
  const source = await readFile(new URL("../public/workbench.js", import.meta.url), "utf8");
  const nodes = new Map<string, any>();
  const $ = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: "", textContent: "", hidden: false });
    return nodes.get(id);
  };
  const calls: any[] = [];
  const issue = (id: string) => ({ id, title: id, status: "open", category: "logic", affected: [] });
  const fix = (id: string, issueId: string, status = "proposed") => ({ id, issueId, status, revision: 2, files: [] });
  const job = { issues: [issue("a"), issue("b"), issue("c")], fixes: [fix("f1", "a"), fix("f2", "b"), fix("f3", "c", "rejected")], validations: [], results: [{}], busy: false };
  runInNewContext(source.slice(source.indexOf("function pendingRepairs()"), source.indexOf("function renderTests()")) + `
    renderNextStep(); renderIssues(); $("repair-action").onclick();`, {
    $, job, loading: false, navigating: false, uploading: false,
    connection: { protocolVersion: 4 }, document: { querySelectorAll: () => [] },
    esc: (s: any) => String(s ?? ""), pretty: JSON.stringify,
    action: (...args: any[]) => calls.push(args), setView: () => assert.fail("Must not just navigate"),
  });
  assert.equal($("repair-action").textContent, "Approve & repair all");
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [["fixes/approve", { approved: true, fixes: [{ id: "f1", revision: 2 }, { id: "f2", revision: 2 }] }, "validation"]]);
  assert.doesNotMatch($("issues").innerHTML, /data-approve|data-generate/);
  assert.match($("issues").innerHTML, /data-edit="f1"/);
  assert.match($("issues").innerHTML, /data-reject="f2"/);
  job.fixes = [];
  calls.length = 0;
  runInNewContext(source.slice(source.indexOf("function pendingRepairs()"), source.indexOf("function renderTests()")) + `
    renderNextStep(); $("repair-action").onclick();`, {
    $, job, loading: false, navigating: false, uploading: false,
    connection: { protocolVersion: 4 }, action: (...args: any[]) => calls.push(args),
  });
  assert.equal($("repair-action").textContent, "Generate all proposals");
  assert.equal(calls[0][0], "fixes/generate");
});

test("Batch checks every revision and source precondition before writing, and refuses conflicting replacements", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofrun-batch-preconditions-"));
  try {
    await writeFile(join(root, "one.mjs"), "export const one = 1;\n");
    await writeFile(join(root, "two.mjs"), "export const two = 2;\n");
    const make = (path: string, before: string, after: string) => propose(root, path, { explanation: "Fix value", risks: "Changed value", files: [{ path, beforeHash: hash(before), after }] });
    const a = await make("one.mjs", "export const one = 1;\n", "export const one = 10;\n");
    const b = await make("two.mjs", "export const two = 2;\n", "export const two = 20;\n");
    const approval = { approved: true, fixes: [{ id: a.id, revision: a.revision }, { id: b.id, revision: b.revision }] };
    await assert.rejects(applyBatch(root, [a, b], { ...approval, approved: false }), /Explicit approval/);
    await assert.rejects(applyBatch(root, [a, b], { ...approval, fixes: [approval.fixes[0], { id: b.id, revision: 99 }] }), /current diff revision/);
    const conflict = await make("one.mjs", "export const one = 1;\n", "export const one = 100;\n");
    await assert.rejects(applyBatch(root, [a, conflict], { approved: true, fixes: [{ id: a.id, revision: 1 }, { id: conflict.id, revision: 1 }] }), /conflict/);
    assert.equal(await readFile(join(root, "one.mjs"), "utf8"), a.files[0].before);
    assert.equal(await readFile(join(root, "two.mjs"), "utf8"), b.files[0].before);
    await writeFile(join(root, "two.mjs"), "external change\n");
    await assert.rejects(applyBatch(root, [a, b], approval), /Project changed/);
    assert.equal(await readFile(join(root, "one.mjs"), "utf8"), a.files[0].before);
    await writeFile(join(root, "two.mjs"), b.files[0].before);
    const identical = await make("one.mjs", "export const one = 1;\n", "export const one = 10;\n");
    await applyBatch(root, [a, b, identical], { ...approval, fixes: [...approval.fixes, { id: identical.id, revision: identical.revision }] });
    assert.equal(await readFile(join(root, "one.mjs"), "utf8"), a.files[0].after);
    assert.equal(await readFile(join(root, "two.mjs"), "utf8"), b.files[0].after);
    assert.equal(a.status, "applied");
    assert.equal(b.approvedAt, a.approvedAt);
    assert.equal(identical.status, "applied");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("One API approval repairs independent HTTP and module defects, excludes rejection, and retests once", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofrun-batch-workflow-"));
  const ai = new FixtureAI(), ask = ai.ask.bind(ai);
  const library = "export const double = n => n * 3;\n";
  const probe = "import assert from 'node:assert/strict'; import {double} from './math.mjs'; assert.equal(double(4), 8); assert.equal(double(-2), -4); console.log('module contract passed');\n";
  ai.ask = async (task, schema, data) => {
    if (task.startsWith("Generate")) {
      const tests = await ask(task, schema, data);
      tests.commands = [{ label: "Module arithmetic", argv: [process.execPath, "probe.mjs"], cwd: ".", timeoutSeconds: 5 }] as any;
      return tests;
    }
    if (task.startsWith("Investigate") && data.issue.testId === "command-0") {
      const source = data.context.excerpts.find((f: any) => f.path === "math.mjs");
      return { classification: "application", severity: "medium", description: "Module triples instead of doubling", rootCause: "Incorrect multiplier", affected: [{ path: "math.mjs", line: 1 }], recommendedFix: "Multiply by two", fixExplanation: "Preserves documented arithmetic", risks: "Arithmetic output changes", patch: { explanation: "Fix module", risks: "Changed output", files: [{ path: "math.mjs", beforeHash: source.hash, after: library.replace("* 3", "* 2") }] } };
    }
    return ask(task, schema, data);
  };
  class Executor extends OwnedFixtureExecutor {
    async open(plan: any, path: string, options: any) {
      const session = await super.open(plan, path, options), command = session.command;
      session.command = async (c: any) => {
        if (c.argv.length !== 2 || c.argv[0] !== process.execPath || c.argv[1] !== "probe.mjs") return command(c);
        assert.equal(await readFile(join(path, "probe.mjs"), "utf8"), probe, "Only the exact owned test is executable");
        const text = await readFile(join(path, "math.mjs"), "utf8");
        assert.ok([library, library.replace("* 3", "* 2")].includes(text));
        return run(process.execPath, ["probe.mjs"], { cwd: path, timeout: 5000, signal: options.signal });
      };
      return session;
    }
  }
  const engine = new QAEngine(root, { ai, executor: new Executor() });
  const { server } = await createApp(engine);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/qa/`;
  const post = async (path: string, body: any) => {
    const response = await fetch(base + path, { method: "POST", headers: { "x-proofrun": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  try {
    const made = await engine.create({ files: [file("app.mjs", original), file("math.mjs", library), file("probe.mjs", probe), file("notes.md", "original\n")] });
    await engine.start(made.id);
    let job = await waitJob(engine, made.id);
    assert.equal(job.results.filter((r: any) => r.outcome === "failed").length, 2);
    assert.equal(job.fixes.length, 2);
    job.fixes = [];
    await engine.save(job);
    assert.equal((await post(`projects/${job.id}/fixes/generate`, {})).status, 200);
    job = await waitJob(engine, made.id);
    assert.equal(job.fixes.length, 2, "Main generation prepares every missing proposal");
    assert.equal(await readFile(join(job.root, "app.mjs"), "utf8"), original);
    assert.equal(await readFile(join(job.root, "math.mjs"), "utf8"), library);
    const rejected = await propose(job.root, job.issues[0].id, { explanation: "Optional notes", risks: "Documentation", files: [{ path: "notes.md", beforeHash: hash("original\n"), after: "modified\n" }] });
    job.fixes.push(rejected);
    await engine.rejectFix(job.id, rejected.id);
    const before = job.contractHash;
    const fixes = job.fixes.filter((f: any) => f.status === "proposed").map((f: any) => ({ id: f.id, revision: f.revision }));
    assert.equal((await post(`projects/${job.id}/fixes/approve`, { approved: true, fixes: [fixes[0]] })).status, 400);
    assert.equal(await readFile(join(job.root, "app.mjs"), "utf8"), original);
    const approved = await post(`projects/${job.id}/fixes/approve`, { approved: true, fixes });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal((await post(`projects/${job.id}/fixes/approve`, { approved: true, fixes })).status, 400, "Double-click cannot repeat approval");
    job = await waitJob(engine, made.id);
    assert.equal(job.validations.length, 1);
    assert.deepEqual(job.validations[0].fixIds.sort(), fixes.map((f: any) => f.id).sort());
    assert.equal(job.contractHash, before);
    assert.ok(job.validations[0].results.every((r: any) => r.outcome === "passed"));
    assert.ok(job.issues.every((i: any) => i.status === "resolved"));
    assert.ok(job.fixes.filter((f: any) => f.status === "applied").every((f: any) => f.retest.resolved));
    assert.equal(await readFile(join(job.root, "notes.md"), "utf8"), "original\n");
    assert.equal(await readFile(join(job.root, "probe.mjs"), "utf8"), probe);
    assert.equal(job.validations[0].regressions.length, 0);
  } finally {
    await new Promise<void>(r => server.close(() => r()));
    await rm(root, { recursive: true, force: true });
  }
});
