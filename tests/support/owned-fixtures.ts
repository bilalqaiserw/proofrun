import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createServer } from "node:net";
import { launch, run } from "../../src/qa/process.ts";
import { QAEngine } from "../../src/qa/engine.ts";
import { readFile } from "node:fs/promises";
export const original = `import http from 'node:http';
http.createServer((req,res)=>{const u=new URL(req.url,'http://app');if(u.pathname==='/double'){const n=Number(u.searchParams.get('n'));res.setHeader('content-type','application/json');res.end(JSON.stringify({value:n*3}));}else{res.end('ready')}}).listen(Number(process.env.PORT),'127.0.0.1');`;
const repaired = original.replace("n*3", "n*2");
export const cliOriginal = `const n=Number(process.argv[2]);if(n*3!==8)throw new Error('double(4) returned '+n*3);console.log('ok');`;
const cliFixed = cliOriginal.replaceAll("n*3", "n*2");
export const file = (path: string, text: string) => ({
  path,
  base64: Buffer.from(text).toString("base64"),
});
async function port() {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const p = (s.address() as any).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}
export class FixtureAI {
  cli: boolean;
  constructor(cli = false) {
    this.cli = cli;
  }
  async status() {
    return {
      installed: true,
      keyConfigured: true,
      version: "TEST HARNESS – not Bob inference",
    };
  }
  async ask(task: string, schema: string, data: any) {
    if (task.startsWith("Determine"))
      return {
        summary: "Owned arithmetic verification fixture",
        stack: ["JavaScript"],
        runtime: "node",
        install: [],
        build: [],
        checks: [],
        start: this.cli
          ? null
          : {
              label: "start fixture",
              argv: [process.execPath, "app.mjs"],
              cwd: ".",
              timeoutSeconds: 10,
            },
        port: this.cli ? null : 3100,
        env: {},
        services: [],
        assumptions: [],
        limitations: ["Deterministic test AI; does not validate Bob inference"],
      };
    if (task.startsWith("Generate"))
      return this.cli
        ? {
            http: [],
            browser: [],
            commands: [
              {
                label: "CLI arithmetic workflow",
                argv: [process.execPath, "app.mjs", "4"],
                cwd: ".",
                timeoutSeconds: 5,
              },
            ],
            limitations: [],
          }
        : {
            http: [
              {
                id: "double",
                title: "Double positive, zero and negative numbers",
                intent: "Documented doubling contract",
                expected: "Each result is twice its input",
                basis: "documented",
                category: "logic",
                steps: [4, 0, -2].map((n) => ({
                  label: "Double " + n,
                  method: "GET",
                  path: "/double?n=" + n,
                  assertions: [
                    { kind: "status", equals: 200 },
                    { kind: "json", path: "value", equals: n * 2 },
                  ],
                })),
              },
              {
                id: "health",
                title: "Application health",
                intent: "Existing healthy flow",
                expected: "Home responds successfully",
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
              },
            ],
            browser: [],
            commands: [],
            limitations: [],
          };
    const source = data.context.excerpts.find((f: any) => f.path === "app.mjs");
    return {
      severity: "medium",
      description: "Actual arithmetic mismatch",
      rootCause: "Multiplication by three contradicts documentation.",
      affected: [{ path: "app.mjs", line: 2, symbol: "request handler" }],
      recommendedFix: "Multiply by two",
      fixExplanation: "Matches the documented contract",
      risks: "Only observed arithmetic inputs are covered",
      patch: {
        explanation: "Replace wrong multiplier",
        risks: "Changes arithmetic results",
        files: [
          {
            path: "app.mjs",
            beforeHash: source.hash,
            after: this.cli ? cliFixed : repaired,
          },
        ],
      },
    };
  }
}
export class OwnedFixtureExecutor {
  async status() {
    return {
      available: true,
      detail: "TEST HARNESS ONLY – no container isolation",
    };
  }
  async open(plan: any, root: string, options: any) {
    const text = await readFile(resolve(root, "app.mjs"), "utf8");
    const known = new Set([
      original,
      original.replace(
        "res.end('ready')",
        "res.statusCode=500;res.end('broken')",
      ),
      repaired,
      cliOriginal,
      cliFixed,
      repaired + "\n// User reviewed repair\n",
      repaired.replace(
        "res.end('ready')",
        "res.statusCode=500;res.end('broken')",
      ),
    ]);
    if (!known.has(text))
      throw new Error(
        "Fixture executor refuses source outside its exact owned test fixtures",
      );
    let process: any = null,
      logs = "";
    const p = await port(),
      base = "http://127.0.0.1:" + p;
    return {
      async command(c: any) {
        if (
          c.argv[0] !== globalThis.process.execPath ||
          c.argv[1] !== "app.mjs" ||
          c.argv.length !== 3 ||
          c.argv[2] !== "4"
        )
          throw new Error("Fixture executor refuses arbitrary commands");
        return run(c.argv[0], c.argv.slice(1), {
          cwd: resolve(root, c.cwd),
          timeout: c.timeoutSeconds * 1000,
          signal: options.signal,
        });
      },
      async start() {
        if (
          plan.start.argv[0] !== globalThis.process.execPath ||
          plan.start.argv[1] !== "app.mjs" ||
          plan.start.argv.length !== 2
        )
          throw new Error("Fixture executor refuses arbitrary startup");
        process = launch(plan.start.argv[0], plan.start.argv.slice(1), {
          cwd: root,
          env: { ...globalThis.process.env, PORT: String(p) },
          timeout: 20000,
          signal: options.signal,
          onLog: (s, t) => (logs += t),
        });
        for (let i = 0; i < 100; i++) {
          try {
            await fetch(base);
            return;
          } catch {
            await new Promise((r) => setTimeout(r, 20));
          }
        }
        throw new Error("Owned fixture failed readiness");
      },
      async probe(test: any) {
        const r = await run(
          globalThis.process.execPath,
          [resolve("worker/http.mjs")],
          { input: JSON.stringify({ base, test }), timeout: 20000 },
        );
        assert.equal(r.exitCode, 0, r.stderr);
        return JSON.parse(r.stdout);
      },
      async browser() {
        throw new Error("Browser is not stubbed as passing");
      },
      async stopApp() {
        if (process) {
          process.kill();
          await process.done;
        }
      },
      async close() {
        if (process) {
          process.kill();
          await process.done;
        }
      },
      runtimeLogs() {
        return logs;
      },
    };
  }
}
export async function waitJob(engine: QAEngine, id: string) {
  const deadline = Date.now() + 30000;
  while (engine.active.has(id)) {
    assert.ok(Date.now() < deadline, "workflow timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
  return engine.get(id);
}
