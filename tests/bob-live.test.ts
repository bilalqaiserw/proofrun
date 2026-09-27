// Uses the real Bob account and production Docker executor when configured.
// No fallback AI, no host execution. This may consume Bob Coins.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QAEngine } from "../src/qa/engine.ts";
test("Real Bob + Docker: discover arithmetic failure, propose repair, approve and retest", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "proofrun-live-"));
  const engine = new QAEngine(root);
  const status = await engine.status();
  if (!status.ready) {
    t.skip(
      [
        !status.bob.installed ? "Bob Shell missing" : null,
        !status.bob.keyConfigured ? "BOBSHELL_API_KEY not configured" : null,
        !status.docker.available ? "Docker engine unavailable" : null,
      ]
        .filter(Boolean)
        .join("; "),
    );
    await rm(root, { recursive: true, force: true });
    return;
  }
  const file = (path: string, text: string) => ({
    path,
    base64: Buffer.from(text).toString("base64"),
  });
  async function finish(id: string) {
    const deadline = Date.now() + 1800000;
    while (engine.active.has(id)) {
      if (Date.now() > deadline) {
        await engine.cancel(id);
        throw new Error("Live workflow timed out");
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return engine.get(id);
  }
  let id: string | undefined;
  try {
    await engine.init();
    const made = await engine.create({
      name: "Owned real inference verification",
      files: [
        file(
          "package.json",
          JSON.stringify({
            name: "arithmetic-verification",
            type: "module",
            scripts: { start: "node app.mjs" },
            engines: { node: ">=24" },
          }),
        ),
        file(
          "README.md",
          "No dependencies. npm start runs the Node HTTP server. GET /double?n=<integer> must return JSON {value: twice the number}. Verify positive, negative and zero inputs. The home route returns HTTP 200. The implementation intentionally contains one arithmetic bug for this verification.",
        ),
        file(
          "app.mjs",
          `import http from 'node:http';http.createServer((q,r)=>{const u=new URL(q.url,'http://app');r.setHeader('content-type','application/json');if(u.pathname==='/double')r.end(JSON.stringify({value:Number(u.searchParams.get('n'))*3}));else r.end(JSON.stringify({ready:true}))}).listen(Number(process.env.PORT||3100),'0.0.0.0');`,
        ),
      ],
    });
    id = made.id;
    await engine.start(id);
    let job = await finish(id);
    const evidence = process.env.PROOFRUN_LIVE_EVIDENCE_DIR;
    if (evidence) {
      await mkdir(evidence, { recursive: true });
      await writeFile(
        join(evidence, "before.json"),
        JSON.stringify(job, null, 2),
      );
    }
    assert.equal(job.phase, "complete", job.message);
    assert.ok(
      job.results.some((r: any) => r.outcome === "failed"),
      "Bob must generate a practical test that detects the documented mismatch",
    );
    const fix = job.fixes.find((f: any) => f.status === "proposed");
    assert.ok(fix, "Bob must produce a concrete diff");
    const beforeHash = job.contractHash;
    await engine.approveFix(id, fix.id, {
      approved: true,
      revision: fix.revision,
    });
    job = await finish(id);
    if (evidence)
      await writeFile(
        join(evidence, "after.json"),
        JSON.stringify(job, null, 2),
      );
    assert.equal(job.contractHash, beforeHash);
    assert.equal(
      job.validations.at(-1)?.resolved,
      true,
      JSON.stringify(job.validations.at(-1)),
    );
    assert.equal(job.validations.at(-1).regressions.length, 0);
  } finally {
    if (id && engine.active.has(id)) {
      await engine.cancel(id);
      await finish(id);
    }
    await rm(root, { recursive: true, force: true });
  }
});
