// Real production executor gate. A skip is an unmet prerequisite, NEVER a pass.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerExecutor } from "../src/qa/docker.ts";
import { validatePlan } from "../src/qa/contracts.ts";
test("Production Docker: Python CLI, isolation and actual HTTP/browser evidence", async (t) => {
  const executor = new DockerExecutor(),
    status = await executor.status();
  if (!status.available) {
    t.skip(status.detail);
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "proofrun-docker-"));
  let session: any;
  const signal = new AbortController().signal;
  try {
    await writeFile(join(root, "main.py"), 'print("PYTHON_EXECUTED")');
    const common = {
      summary: "owned fixture",
      stack: [],
      install: [],
      build: [],
      checks: [],
      start: null,
      port: null,
      env: {},
      services: [],
      limitations: [],
      assumptions: [],
    };
    session = await executor.open(
      validatePlan({ ...common, runtime: "python" }),
      root,
      { signal, artifacts: join(root, "artifacts") },
    );
    const result = await session.command(
      {
        label: "Python CLI",
        argv: ["python", "main.py"],
        cwd: ".",
        timeoutSeconds: 10,
      },
      "test",
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /PYTHON_EXECUTED/);
    const secrets = await session.command(
      {
        label: "Server credentials absent",
        argv: [
          "python",
          "-c",
          'import os; assert "BOBSHELL_API_KEY" not in os.environ',
        ],
        cwd: ".",
        timeoutSeconds: 10,
      },
      "isolation",
    );
    assert.equal(secrets.exitCode, 0);
    await session.close();
    session = null;
    await writeFile(
      join(root, "app.mjs"),
      `import http from 'node:http';http.createServer((q,r)=>{if(q.url==='/invalid'){r.writeHead(400,{'content-type':'application/json'});return r.end(JSON.stringify({error:'Handled invalid input'}));}if(q.url==='/missing.js'){r.writeHead(404);return r.end();}r.setHeader('content-type','text/html');if(q.url==='/broken')return r.end('<h1>Broken asset</h1><script src="/missing.js"></script>');r.end('<h1>Working fixture</h1><button id="invalid" onclick="fetch(\\'/invalid\\').then(r=>r.json()).then(q=>document.querySelector(\\'output\\').textContent=q.error)">Try invalid input</button><output></output>')}).listen(3100,'127.0.0.1')`,
    );
    session = await executor.open(
      validatePlan({
        ...common,
        runtime: "node",
        port: 3100,
        start: {
          label: "server",
          argv: ["node", "app.mjs"],
          cwd: ".",
          timeoutSeconds: 30,
        },
      }),
      root,
      { signal, artifacts: join(root, "artifacts") },
    );
    await session.start();
    const contract = {
      id: "live",
      title: "HTTP fixture",
      intent: "Observed live execution",
      expected: "HTTP 200",
      basis: "documented",
      category: "smoke",
      steps: [
        {
          label: "Home",
          method: "GET",
          path: "/",
          assertions: [{ kind: "status", equals: 200 }],
        },
      ],
    };
    assert.equal((await session.probe(contract)).outcome, "passed");
    const browser = await session.browser({
      ...contract,
      steps: [
        { action: "goto", path: "/" },
        { action: "text", selector: "h1", value: "Working fixture" },
      ],
    });
    assert.equal(browser.outcome, "passed");
    assert.ok(browser.screenshot);
    const screenshot = await readFile(
      join(root, "artifacts", browser.screenshot),
    );
    assert.ok(
      screenshot.length > 1000,
      "The reported screenshot must exist on the host",
    );
    assert.deepEqual(
      [...screenshot.subarray(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
    );
    assert.equal(
      browser.screenshotBase64,
      undefined,
      "Internal binary transport must not leak into reports",
    );
    const negative = await session.browser({
      ...contract,
      id: "negative",
      steps: [
        { action: "goto", path: "/" },
        { action: "click", selector: "#invalid" },
        { action: "text", selector: "output", value: "Handled invalid input" },
      ],
    });
    assert.equal(negative.outcome, "passed", JSON.stringify(negative));
    assert.ok(negative.observations.some((o) => o.status === 400));
    const missing = await session.browser({
      ...contract,
      id: "missing-asset",
      steps: [
        { action: "goto", path: "/broken" },
        { action: "text", selector: "h1", value: "Broken asset" },
      ],
    });
    assert.equal(missing.outcome, "failed");
    assert.ok(missing.errors.some((e) => e.kind === "missing-resource"));
  } finally {
    if (session) await session.close();
    await rm(root, { recursive: true, force: true });
  }
});
