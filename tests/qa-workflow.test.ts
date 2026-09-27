// Integration harness: explicit deterministic AI substitute, owned local fixtures only.
// This is NEVER reachable through the production API. Production uses DockerExecutor.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createServer } from "node:net";
import { QAEngine } from "../src/qa/engine.ts";
import { createApp } from "../src/server.ts";
import { launch, run } from "../src/qa/process.ts";
import { importZip } from "../src/qa/zip.ts";
import { hash } from "../src/qa/safety.ts";

import {
  FixtureAI,
  OwnedFixtureExecutor,
  waitJob,
  original,
  cliOriginal,
  file,
} from "./support/owned-fixtures.ts";
test("API intake → actual HTTP failure → diff/edit/reject → approval → unchanged retest → export", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofrun-qa-"));
  const engine = new QAEngine(root, {
    ai: new FixtureAI(),
    executor: new OwnedFixtureExecutor(),
  });
  const { server } = await createApp(engine);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + (server.address() as any).port;
  const api = async (path: string, body?: any) => {
    const r = await fetch(base + "/api/qa/" + path, {
      headers: { "x-proofrun": "1", "content-type": "application/json" },
      ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, data: await r.json() };
  };
  try {
    assert.equal((await fetch(base + "/api/qa/projects")).status, 400);
    assert.equal(
      (
        await fetch(base + "/api/qa/projects", {
          headers: { "x-proofrun": "1", origin: "https://other.example" },
        })
      ).status,
      400,
    );
    const made = await api("projects", {
      name: "Actual HTTP fixture",
      files: [
        file("app.mjs", original),
        file("README.md", "The double endpoint returns n times two."),
      ],
    });
    assert.equal(made.status, 201);
    const id = made.data.id;
    await api("projects/" + id + "/start", {});
    let job = await waitJob(engine, id);
    assert.equal(job.phase, "complete");
    assert.equal(job.results[0].outcome, "failed");
    assert.equal(job.results[0].trace[0].response.status, 200);
    assert.ok(job.issues[0].reproduction.length);
    assert.equal(job.issues[0].triggeringInput[0].path, "/double?n=4");
    assert.equal(
      await readFile(join(job.root, "app.mjs"), "utf8"),
      original,
      "proposal must not modify source",
    );
    let fix = job.fixes[0];
    assert.ok(fix.files[0].diff.includes("+"));
    assert.equal(
      (
        await api(`projects/${id}/fixes/${fix.id}/approve`, {
          approved: false,
          revision: 1,
        })
      ).status,
      400,
    );
    await api(`projects/${id}/fixes/${fix.id}/reject`, {});
    assert.equal(fix.status, "rejected");
    assert.equal(await readFile(join(job.root, "app.mjs"), "utf8"), original);
    await api(`projects/${id}/issues/${job.issues[0].id}/fix`, {});
    job = await waitJob(engine, id);
    fix = job.fixes.at(-1);
    const edited = await api(`projects/${id}/fixes/${fix.id}/edit`, {
      files: fix.files.map((f: any) => ({
        path: f.path,
        beforeHash: f.beforeHash,
        after: f.after + "\n// User reviewed repair\n",
      })),
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.data));
    assert.equal(fix.revision, 2);
    assert.equal(
      (
        await api(`projects/${id}/fixes/${fix.id}/approve`, {
          approved: true,
          revision: 1,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await api(`projects/${id}/fixes/${fix.id}/approve`, {
          approved: true,
          revision: 2,
        })
      ).status,
      200,
    );
    job = await waitJob(engine, id);
    assert.equal(fix.status, "applied");
    assert.equal(job.validations[0].resolved, true);
    assert.equal(job.validations[0].contractsUnchanged, true);
    assert.equal(job.validations[0].regressions.length, 0);
    assert.equal(job.validations[0].results[0].outcome, "passed");
    assert.equal(job.issues[0].status, "resolved");
    const report = await api(`projects/${id}/report`);
    assert.equal(report.data.latestValidation.resolved, true);
    assert.equal(report.data.counts.openIssues, 0);
    const zip = await fetch(base + `/api/qa/projects/${id}/download`, {
      headers: { "x-proofrun": "1" },
    });
    const files = importZip(Buffer.from(await zip.arrayBuffer()));
    assert.ok(
      Buffer.from(files.find((f) => f.path === "app.mjs").base64, "base64")
        .toString()
        .includes("n*2"),
    );
    const recovered = new QAEngine(root, {
      ai: new FixtureAI(),
      executor: new OwnedFixtureExecutor(),
    });
    await recovered.init();
    assert.equal(recovered.get(id).fixes[0].status, "applied");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await rm(root, { recursive: true, force: true });
  }
});
test("Non-web CLI: capture genuine exception, approve source fix and rerun identical command", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofrun-cli-"));
  const engine = new QAEngine(root, {
    ai: new FixtureAI(true),
    executor: new OwnedFixtureExecutor(),
  });
  await engine.init();
  try {
    const made = await engine.create({ files: [file("app.mjs", cliOriginal)] });
    const starts = await Promise.allSettled([
      engine.start(made.id),
      engine.start(made.id),
    ]);
    assert.equal(
      starts.filter((r) => r.status === "fulfilled").length,
      1,
      "Concurrent starts must reserve only one execution slot",
    );
    let job = await waitJob(engine, made.id);
    assert.equal(job.results[0].outcome, "failed");
    assert.match(job.issues[0].logs, /Error: double/);
    const fix = job.fixes[0];
    await engine.approveFix(job.id, fix.id, { approved: true, revision: 1 });
    job = await waitJob(engine, made.id);
    assert.equal(job.validations[0].resolved, true);
    assert.equal(job.validations[0].results[0].outcome, "passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("A repair that resolves one failure but breaks a healthy flow creates a regression issue", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofrun-regression-"));
  const engine = new QAEngine(root, {
    ai: new FixtureAI(),
    executor: new OwnedFixtureExecutor(),
  });
  await engine.init();
  try {
    const made = await engine.create({ files: [file("app.mjs", original)] });
    await engine.start(made.id);
    let job = await waitJob(engine, made.id);
    assert.equal(
      job.results.find((r: any) => r.id === "health").outcome,
      "passed",
    );
    const fix = job.fixes[0];
    const bad = original
      .replace("n*3", "n*2")
      .replace("res.end('ready')", "res.statusCode=500;res.end('broken')");
    await engine.editFix(job.id, fix.id, {
      files: [{ path: "app.mjs", beforeHash: hash(original), after: bad }],
    });
    await engine.approveFix(job.id, fix.id, { approved: true, revision: 2 });
    job = await waitJob(engine, job.id);
    assert.equal(job.validations[0].resolved, true);
    assert.equal(job.validations[0].regressions.length, 1);
    assert.ok(
      job.issues.some(
        (i: any) => i.status === "regression" && i.testId === "health",
      ),
    );
    assert.equal(job.validations[0].contractsUnchanged, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Prepared execution installs once per run and rebuilds after approved source changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofrun-prepared-"));
  const ai = new FixtureAI();
  const ask = ai.ask.bind(ai);
  const preparation = {
    label: "Owned preparation",
    argv: [process.execPath, "-e", "console.log('owned preparation')"],
    cwd: ".",
    timeoutSeconds: 10,
  };
  ai.ask = async (...args: Parameters<typeof ask>) => {
    const response = await ask(...args);
    if (args[0].startsWith("Determine")) response.install = [preparation];
    return response;
  };
  let installations = 0,
    snapshots = 0,
    forks = 0,
    releases = 0;
  const owned = new OwnedFixtureExecutor();
  const executor = {
    status: () => owned.status(),
    async open(plan: any, source: string, options: any) {
      const session: any = await owned.open(plan, source, options);
      const command = session.command;
      session.command = async (c: any, phase: string) => {
        if (JSON.stringify(c.argv) !== JSON.stringify(preparation.argv))
          return command(c, phase);
        installations++;
        return run(c.argv[0], c.argv.slice(1), {
          timeout: 10000,
          signal: options.signal,
        });
      };
      session.snapshot = async () => {
        snapshots++;
        const snapshotHash = hash(await readFile(join(source, "app.mjs")));
        return {
          async open(forkOptions: any) {
            assert.equal(
              hash(await readFile(join(source, "app.mjs"))),
              snapshotHash,
              "a prior run's preparation cannot survive a source change",
            );
            forks++;
            return owned.open(plan, source, forkOptions);
          },
          async close() {
            releases++;
          },
        };
      };
      return session;
    },
  };
  const engine = new QAEngine(root, { ai, executor });
  await engine.init();
  try {
    const made = await engine.create({ files: [file("app.mjs", original)] });
    await engine.start(made.id);
    let job = await waitJob(engine, made.id);
    assert.equal(installations, 1);
    assert.equal(snapshots, 1);
    assert.equal(forks, 2);
    assert.equal(releases, 1);
    assert.equal(
      job.results.filter((r: any) => r.outcome === "failed").length,
      1,
    );
    const fix = job.fixes[0];
    await engine.approveFix(job.id, fix.id, {
      approved: true,
      revision: fix.revision,
    });
    job = await waitJob(engine, job.id);
    assert.equal(installations, 2);
    assert.equal(snapshots, 2);
    assert.equal(forks, 4);
    assert.equal(releases, 2);
    assert.equal(job.validations[0].resolved, true);
    assert.equal(job.validations[0].contractsUnchanged, true);
    assert.equal(job.validations[0].regressions.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("A real command timeout remains incomplete and later checks use a fresh session", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofrun-timeout-recovery-"));
  const ai = new FixtureAI(true),
    ask = ai.ask.bind(ai);
  const hanging = {
    label: "Owned hanging command",
    argv: [process.execPath, "-e", "setInterval(()=>{},1000)"],
    cwd: ".",
    timeoutSeconds: 5,
  };
  const healthy = {
    label: "Owned healthy command",
    argv: [process.execPath, "-e", "console.log('healthy')"],
    cwd: ".",
    timeoutSeconds: 5,
  };
  ai.ask = async (...args: Parameters<typeof ask>) => {
    if (args[0].startsWith("Generate"))
      return {
        http: [],
        browser: [],
        commands: [],
        limitations: ["Owned timeout recovery test; no AI inference"],
      };
    const response = await ask(...args);
    if (args[0].startsWith("Determine")) response.checks = [hanging, healthy];
    return response;
  };
  const owned = new OwnedFixtureExecutor();
  let opens = 0;
  const open = async (plan: any, source: string, options: any) => {
    opens++;
    const session: any = await owned.open(plan, source, options);
    let stopped = false;
    session.command = async (c: any) => {
      assert.equal(
        stopped,
        false,
        "A timed-out container cannot execute another check",
      );
      assert.ok(
        JSON.stringify(c.argv) === JSON.stringify(hanging.argv) ||
          JSON.stringify(c.argv) === JSON.stringify(healthy.argv),
      );
      const r = await run(c.argv[0], c.argv.slice(1), {
        timeout: c.label === hanging.label ? 80 : 5000,
      });
      stopped = r.timedOut;
      return r;
    };
    session.snapshot = async () => ({
      open: (options: any) => open(plan, source, options),
      close: async () => {},
    });
    return session;
  };
  const engine = new QAEngine(root, {
    ai,
    executor: { status: () => owned.status(), open },
  });
  await engine.init();
  try {
    const made = await engine.create({ files: [file("app.mjs", cliOriginal)] });
    await engine.start(made.id);
    let job = await waitJob(engine, made.id);
    assert.equal(opens, 2);
    assert.equal(job.results[0].outcome, "inconclusive");
    assert.equal(job.results[1].outcome, "passed");
    assert.equal(job.issues[0].status, "inconclusive");
    await engine.retest(made.id);
    job = await waitJob(engine, made.id);
    assert.equal(opens, 4);
    assert.equal(job.validations[0].results[0].outcome, "inconclusive");
    assert.equal(job.validations[0].results[1].outcome, "passed");
    assert.equal(job.validations[0].resolved, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Grouped failure analysis creates one approval for identical repairs and preserves every test", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofrun-grouped-"));
  const ai = new FixtureAI();
  ai.batchFailures = true;
  const ask = ai.ask.bind(ai);
  let groupedCalls = 0;
  ai.ask = async (task, schema, data) => {
    if (task.startsWith("Generate")) {
      const proposed = await ask(task, schema, data);
      const base = proposed.http[0];
      proposed.http = [
        { ...base, id: "positive", steps: [base.steps[0]] },
        { ...base, id: "negative", steps: [base.steps[2]] },
        proposed.http[1],
      ];
      return proposed;
    }
    if (data.issues) {
      groupedCalls++;
      return {
        issues: await Promise.all(
          data.issues.map(async (issue) => ({
            id: issue.id,
            analysis: await ask("Investigate", schema, { ...data, issue }),
          })),
        ),
      };
    }
    return ask(task, schema, data);
  };
  const engine = new QAEngine(root, {
    ai,
    executor: new OwnedFixtureExecutor(),
  });
  await engine.init();
  try {
    const made = await engine.create({
      name: "Owned grouped fixture",
      files: [file("app.mjs", original), file("README.md", "Double integers")],
    });
    await engine.start(made.id);
    let job = await waitJob(engine, made.id);
    assert.equal(groupedCalls, 1);
    assert.equal(job.issues.length, 2);
    assert.equal(job.fixes.length, 1);
    assert.equal(job.fixes[0].relatedIssueIds.length, 1);
    const contracts = job.contractHash;
    await engine.approveFix(job.id, job.fixes[0].id, {
      approved: true,
      revision: job.fixes[0].revision,
    });
    job = await waitJob(engine, job.id);
    assert.equal(job.contractHash, contracts);
    assert.equal(job.validations.at(-1).results.length, 3);
    assert.ok(
      job.validations.at(-1).results.every((r) => r.outcome === "passed"),
    );
    assert.ok(job.issues.every((i) => i.status === "resolved"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Manual repair returns immediately, can be cancelled, and never applies an unapproved patch", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofrun-repair-cancel-"));
  const ai = new FixtureAI();
  const engine = new QAEngine(root, {
    ai,
    executor: new OwnedFixtureExecutor(),
  });
  await engine.init();
  try {
    const made = await engine.create({
      name: "Owned cancel fixture",
      files: [file("app.mjs", original)],
    });
    await engine.start(made.id);
    let job = await waitJob(engine, made.id);
    const before = await readFile(join(job.root, "app.mjs"), "utf8");
    ai.ask = async (task, schema, data, signal) =>
      new Promise((resolve, reject) => {
        if (signal.aborted)
          return reject(new Error("Cancelled reasoning request"));
        signal.addEventListener(
          "abort",
          () => reject(new Error("Cancelled reasoning request")),
          { once: true },
        );
      });
    const pending = await engine.generateFix(job.id, job.issues[0].id);
    assert.equal(pending.busy, true);
    assert.equal(pending.cancellable, true);
    await assert.rejects(
      engine.approveFix(job.id, job.fixes[0].id, {
        approved: true,
        revision: 1,
      }),
      /Wait until/,
    );
    await engine.cancel(job.id);
    job = await waitJob(engine, job.id);
    assert.equal(job.phase, "cancelled");
    assert.equal(await readFile(join(job.root, "app.mjs"), "utf8"), before);
    assert.equal(job.fixes[0].status, "proposed");
    assert.ok(job.analysisWarnings.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Continue reuses verified passing suites only for unchanged source and still executes practical tests", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofrun-resume-"));
  const ai = new FixtureAI();
  const ask = ai.ask.bind(ai);
  let failGeneration = true,
    versionRuns = 0;
  ai.ask = async (task, schema, data) => {
    if (task.startsWith("Determine"))
      return {
        ...(await ask(task, schema, data)),
        checks: [
          {
            label: "Existing runtime check",
            argv: [process.execPath, "--version"],
            cwd: ".",
            timeoutSeconds: 5,
          },
        ],
      };
    if (task.startsWith("Generate") && failGeneration)
      throw new Error("Reasoning format interruption");
    return ask(task, schema, data);
  };
  const executor = new OwnedFixtureExecutor();
  const open = executor.open.bind(executor);
  executor.open = async (plan, source, options) => {
    const session = await open(plan, source, options),
      command = session.command.bind(session);
    session.command = async (c) => {
      if (
        c.argv.length === 2 &&
        c.argv[0] === process.execPath &&
        c.argv[1] === "--version"
      ) {
        versionRuns++;
        return {
          ...(await run(process.execPath, ["--version"], { timeout: 5000 })),
          ...c,
        };
      }
      return command(c);
    };
    return session;
  };
  const engine = new QAEngine(root, { ai, executor });
  await engine.init();
  try {
    const made = await engine.create({
      name: "Owned continuation fixture",
      files: [file("app.mjs", original)],
    });
    await engine.start(made.id);
    let job = await waitJob(engine, made.id);
    assert.equal(engine.canResume(job), true);
    assert.equal(versionRuns, 1);
    await writeFile(
      join(job.root, "app.mjs"),
      original + "\n// Changed source",
    );
    await assert.rejects(engine.resume(job.id), /Source changed/);
    assert.equal(engine.active.has(job.id), false);
    await writeFile(join(job.root, "app.mjs"), original);
    failGeneration = false;
    await engine.resume(job.id);
    job = await waitJob(engine, job.id);
    assert.equal(versionRuns, 1, "Passing existing check must not be repeated");
    assert.equal(job.results.length, 3);
    assert.equal(job.results.find((r) => r.id === "double").outcome, "failed");
    assert.ok(
      job.issues.find((i) => i.category === "reasoning").status === "resolved",
    );
    assert.equal(engine.canResume(job), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
