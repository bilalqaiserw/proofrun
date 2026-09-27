import test from "node:test";
import assert from "node:assert/strict";
import { jsonObject } from "../src/qa/safety.ts";
import { BobReasoner } from "../src/qa/bob.ts";
import { operationIssue } from "../src/qa/reports.ts";
test("Bob prose and fenced JSON preserve escaped replacement source; ambiguous/invalid data is rejected", () => {
  const value = { patch: { after: 'const x = {quoted: "}"};\n// { source }' } };
  assert.deepEqual(
    jsonObject(
      "Looking at the failure.\n```json\n" +
        JSON.stringify(value) +
        "\n```\nReview this change.",
    ),
    value,
  );
  assert.throws(() => jsonObject('{"one":1} {"two":2}'), /ambiguous/);
  assert.throws(() => jsonObject('[{"one":1}]'), /object/);
  assert.throws(
    () => jsonObject("Looking at the code, I would fix it."),
    /complete/,
  );
  assert.throws(() => jsonObject('{"patch":{"after":"truncated'), /complete/);
});
test("Bob retries a prose-only response once, with tools still disabled", async () => {
  const previous = process.env.BOBSHELL_API_KEY;
  process.env.BOBSHELL_API_KEY = "proofrun-test-unit-key";
  try {
    const bob = new BobReasoner("work/response-verification");
    let calls = 0;
    bob.invoke = async (args, options) => {
      assert.ok(args.includes("--disable-mcp"));
      assert.ok(args.includes("--disable-tool-groups"));
      assert.ok(options.input.includes("SCHEMA:"));
      return {
        exitCode: 0,
        timedOut: false,
        stdout: JSON.stringify({
          status: "success",
          last_message:
            ++calls === 1
              ? "Looking at this program..."
              : '{"purpose":"A complete response"}',
        }),
      };
    };
    assert.deepEqual(await bob.ask("Explain", "{purpose:string}", {}), {
      purpose: "A complete response",
    });
    assert.equal(calls, 2);
    bob.invoke = async () => {
      calls++;
      return {
        exitCode: 0,
        timedOut: false,
        stdout: JSON.stringify({
          status: "success",
          last_message: "incomplete",
        }),
      };
    };
    await assert.rejects(
      bob.ask("Explain", "{purpose:string}", {}),
      /after one retry/,
    );
    assert.equal(calls, 4);
  } finally {
    if (previous === undefined) delete process.env.BOBSHELL_API_KEY;
    else process.env.BOBSHELL_API_KEY = previous;
  }
});
test("Startup and reasoning errors retain the actual cause instead of a fictitious null exit", () => {
  const startup = operationIssue(
    "setup",
    Object.assign(new Error("Port 5173 was not ready"), {
      code: "APPLICATION_NOT_READY",
      command: { argv: ["pnpm", "dev"], cwd: "." },
      logs: "VITE ready at 127.0.0.1:5173",
    }),
  );
  assert.equal(startup.category, "environment");
  assert.equal(startup.status, "inconclusive");
  assert.match(startup.description, /5173/);
  assert.match(startup.logs, /VITE/);
  assert.deepEqual(startup.triggeringInput, ["pnpm", "dev"]);
  const reasoning = operationIssue(
    "generating-tests",
    new Error("Bob response incomplete"),
  );
  assert.equal(reasoning.category, "reasoning");
  assert.match(reasoning.rootCause, /does not establish/);
});

import {
  validatePlan,
  validateTests,
  browserInputTypes,
  browserRequiredInputs,
} from "../src/qa/contracts.ts";
import { QAEngine } from "../src/qa/engine.ts";
import { reasoningContext } from "../src/qa/projects.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
test("Empty required controls use an actual native validation assertion instead of waiting for a blocked API request", () => {
  const excerpts = [
    {
      path: "index.html",
      content: '<input type="number" id="amount" required>',
    },
  ];
  const required = browserRequiredInputs(excerpts);
  assert.deepEqual(required, ["#amount"]);
  const workflow = {
    id: "missing",
    title: "Required field",
    intent: "Browser blocks missing input",
    expected: "Native validation rejects empty input",
    basis: "documented",
    steps: [
      { action: "goto", path: "/" },
      { action: "fill", selector: "#amount", value: "" },
      { action: "click", selector: "button" },
      { action: "visible", selector: "#error" },
    ],
  };
  const plan = { http: [], browser: [workflow], commands: [], limitations: [] };
  assert.throws(
    () => validateTests(plan, browserInputTypes(excerpts), required),
    /Native browser validation blocks/,
  );
  const valid = {
    ...workflow,
    steps: [
      ...workflow.steps.slice(0, 3),
      { action: "invalid", selector: "#amount" },
    ],
  };
  assert.doesNotThrow(() =>
    validateTests(
      { ...plan, browser: [valid] },
      browserInputTypes(excerpts),
      required,
    ),
  );
});
test("Source-aware numeric control preflight rejects impossible browser actions while HTTP malformed inputs remain testable", () => {
  const controls = browserInputTypes([
    {
      path: "index.html",
      content:
        '<input data-id="wrong" id="subtotal" type="number"><input id="query" type="text">',
    },
  ]);
  assert.deepEqual(controls, { "#subtotal": "number", "#query": "text" });
  const flow = {
    id: "input",
    title: "Validation",
    intent: "Test the error path",
    expected: "An error is displayed",
    basis: "documented",
    steps: [{ action: "fill", selector: "#subtotal", value: "abc" }],
  };
  const plan = { http: [], browser: [flow], commands: [], limitations: [] };
  assert.throws(() => validateTests(plan, controls), /numeric input/);
  for (const value of ["", "0", "-1", "10001", "1e3"])
    assert.doesNotThrow(() =>
      validateTests(
        {
          ...plan,
          browser: [{ ...flow, steps: [{ ...flow.steps[0], value }] }],
        },
        controls,
      ),
    );
  assert.doesNotThrow(() =>
    validateTests(
      {
        ...plan,
        browser: [],
        http: [
          {
            ...flow,
            steps: [
              {
                label: "Malformed input",
                method: "GET",
                path: "/quote?subtotal=abc",
                assertions: [{ kind: "status", equals: 400 }],
              },
            ],
          },
        ],
      },
      controls,
    ),
  );
});
test("Format correction sends only the failing proposal and saved valid proposals resume without another AI call", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofrun-format-recovery-"));
  const workflow = {
    id: "page",
    title: "Page behavior",
    intent: "Verify documented text",
    expected: "Show the supplied result",
    basis: "documented",
    steps: [{ action: "textContains", selector: "#result", value: "Ready" }],
  };
  let calls = 0;
  const ai = {
    status: async () => ({}),
    ask: async (task, schema, data) => {
      assert(schema.includes("Command={label:string,argv:string[]"));
      calls++;
      if (calls === 1)
        return { http: [], browser: [workflow], commands: [], limitations: [] };
      if (calls === 3) {
        assert.ok(
          data.context,
          "Invalid runtime expectations require fresh source-grounded generation",
        );
        return {
          http: [],
          browser: [
            {
              ...workflow,
              steps: [{ action: "text", selector: "#result", value: "Ready" }],
            },
          ],
          commands: [],
          limitations: [],
        };
      }
      assert.deepEqual(Object.keys(data).sort(), [
        "browserInputTypes",
        "previousProposal",
        "requiredInputs",
        "validationError",
      ]);
      assert.equal(data.previousProposal.browser[0].steps[0].value, "Ready");
      return {
        http: [],
        browser: [
          {
            ...workflow,
            steps: [{ action: "text", selector: "#result", value: "Ready" }],
          },
        ],
        commands: [],
        limitations: [],
      };
    },
  };
  const engine = new QAEngine(root, { ai });
  try {
    await engine.init();
    const created = await engine.create({
      name: "Owned response fixture",
      files: [
        {
          path: "README.md",
          base64: Buffer.from("A local page displays Ready.").toString(
            "base64",
          ),
        },
      ],
    });
    const job = engine.get(created.id),
      context = await reasoningContext(job.root);
    const tests = await engine.generateTests(
      job,
      context,
      new AbortController().signal,
    );
    assert.equal(tests.browser.length, 1);
    assert.equal(tests.browser[0].steps[0].value, "Ready");
    assert.equal(calls, 2);
    const reused = await engine.generateTests(
      job,
      context,
      new AbortController().signal,
      true,
    );
    assert.deepEqual(reused, tests);
    assert.equal(calls, 2, "Do not regenerate a saved valid proposal");
    job.testProposal.invalidOracle = true;
    await engine.generateTests(
      job,
      context,
      new AbortController().signal,
      true,
    );
    assert.equal(
      calls,
      3,
      "Never reuse a generated test already found to have a faulty runtime expectation",
    );
    assert.equal(job.reasoningProgress, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("Missing display labels and equivalent browser actions preserve tests without weakening command/navigation boundaries", () => {
  const base = {
    id: "checkout",
    title: "Checkout",
    intent: "Exercise real input",
    expected: "Reject missing values",
    basis: "documented",
  };
  const input = {
    http: [
      {
        ...base,
        id: "api",
        steps: [
          {
            method: "GET",
            path: "/quote",
            assertions: [{ kind: "status", equals: 400 }],
          },
        ],
      },
    ],
    browser: [
      {
        ...base,
        steps: [
          { action: "navigate", url: "/" },
          { action: "clear", selector: "#subtotal" },
          {
            action: "assertText",
            selector: "#result",
            text: "Invalid subtotal",
          },
        ],
      },
    ],
    commands: [{ argv: ["node", "probe.mjs"], cwd: ".", timeoutSeconds: 20 }],
    limitations: [],
  };
  const parsed = validateTests(input);
  assert.equal(parsed.commands[0].label, "Run node probe.mjs");
  assert.deepEqual(parsed.commands[0].argv, input.commands[0].argv);
  assert.equal(parsed.http[0].steps[0].label, "GET /quote");
  assert.deepEqual(
    parsed.http[0].steps[0].assertions,
    input.http[0].steps[0].assertions,
  );
  assert.deepEqual(
    parsed.browser[0].steps.map((s) => s.action),
    ["goto", "fill", "text"],
  );
  assert.equal(parsed.browser[0].steps[1].value, "");
  assert.equal(parsed.browser[0].steps[2].value, "Invalid subtotal");
  assert.equal(
    input.browser[0].steps[0].action,
    "navigate",
    "Do not rewrite the saved raw proposal",
  );
  assert.throws(
    () => validateTests({ ...input, commands: [{ argv: "node probe.mjs" }] }),
    /argv/,
  );
  assert.throws(() =>
    validateTests({ ...input, commands: [{ argv: ["node"], cwd: "../host" }] }),
  );
  assert.throws(
    () =>
      validateTests({
        ...input,
        browser: [
          { ...base, steps: [{ action: "goto", path: "//external.example" }] },
        ],
      }),
    /within the application/,
  );
  assert.throws(
    () =>
      validateTests({
        ...input,
        browser: [
          {
            ...base,
            steps: [{ action: "evaluate", script: "arbitrary code" }],
          },
        ],
      }),
    /Unsupported browser action/,
  );
});
test("HTTP contract rejects impossible HEAD bodies and distinguishes headers from body assertions", () => {
  const t = {
    id: "headers",
    title: "Headers",
    intent: "Check the response metadata",
    expected: "JSON response",
    basis: "documented",
    steps: [
      {
        label: "Content-Type header",
        method: "GET",
        path: "/",
        assertions: [
          { kind: "header", name: "content-type", equals: "application/json" },
        ],
      },
    ],
  };
  const contracts = { http: [t], browser: [], commands: [], limitations: [] };
  assert.doesNotThrow(() => validateTests(contracts));
  assert.throws(
    () =>
      validateTests({
        ...contracts,
        http: [
          {
            ...t,
            steps: [
              {
                ...t.steps[0],
                assertions: [{ kind: "contains", value: "application/json" }],
              },
            ],
          },
        ],
      }),
    /Content-Type/,
  );
  assert.throws(
    () =>
      validateTests({
        ...contracts,
        http: [
          {
            ...t,
            steps: [
              {
                ...t.steps[0],
                method: "HEAD",
                assertions: [{ kind: "contains", value: "body" }],
              },
            ],
          },
        ],
      }),
    /HEAD responses/,
  );
  const plan = validatePlan({
    summary: "A".repeat(1500),
    stack: [],
    runtime: "node",
    install: [],
    build: [],
    checks: [],
    start: null,
    port: null,
    services: [],
    env: {},
    limitations: [],
    assumptions: [],
  });
  assert.equal(plan.summary.length, 1500);
});
