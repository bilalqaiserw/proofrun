import { randomUUID } from "node:crypto";
import {
  mkdir,
  writeFile,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { ingest, connect, reasoningContext, inventory } from "./projects.ts";
import {
  validatePlan,
  validateTests,
  browserInputTypes,
  browserRequiredInputs,
  IMAGES,
  type Plan,
  type Command,
  type TestPlan,
} from "./contracts.ts";
import { BobReasoner, PLAN_SCHEMA, TEST_SCHEMA, type Reasoner } from "./bob.ts";
import {
  DockerExecutor,
  type Executor,
  type Session,
  type PreparedEnvironment,
} from "./docker.ts";
import { hash, redact, inside } from "./safety.ts";
import { propose, applyBatch, type Fix } from "./fixes.ts";
import { sourceLanguages } from "../../public/languages.js";
import { PROJECT_LIMITS } from "../../public/project-limits.js";
import {
  commandIssue,
  operationIssue,
  issueFromResult,
  enrich,
  finalReport,
} from "./reports.ts";

export class QAEngine {
  jobs = new Map<string, any>();
  active = new Map<string, AbortController>();
  locks = new Set<string>();
  writes = new Map<string, Promise<void>>();
  root: string;
  ai: Reasoner;
  executor: Executor;
  constructor(
    root = process.env.PROOFRUN_DATA_DIR || ".proofrun-data",
    dependencies?: { ai?: Reasoner; executor?: Executor },
  ) {
    this.root = resolve(root);
    this.ai = dependencies?.ai ?? new BobReasoner(this.root);
    this.executor = dependencies?.executor ?? new DockerExecutor();
  }
  async init() {
    await mkdir(this.root, { recursive: true });
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (entry.isDirectory() && /^[0-9a-f-]{36}$/.test(entry.name)) {
        try {
          const job = JSON.parse(
            await readFile(join(this.root, entry.name, "job.json"), "utf8"),
          );
          if (job.id !== entry.name) continue;
          job.root = join(this.root, job.id, "source");
          if (
            [
              "analyzing",
              "queued",
              "setup",
              "building",
              "generating-tests",
              "testing",
              "diagnosing",
              "fixing",
              "retesting",
              "cancelling",
            ].includes(job.phase)
          ) {
            job.phase = "interrupted";
            job.message =
              "ProofRun restarted during a run. Restart testing to continue.";
            job.currentTest = null;
            job.runningTests = [];
            job.reasoningProgress = null;
          }
          this.jobs.set(job.id, job);
        } catch {}
      }
    }
  }
  async status() {
    const [bob, docker] = await Promise.all([
      this.ai.status(),
      this.executor.status(),
    ]);
    return {
      protocolVersion: 4,
      bob,
      docker,
      ready: bob.installed && bob.keyConfigured && docker.available,
      limits: {
        files: PROJECT_LIMITS.maxFiles,
        projectMB: PROJECT_LIMITS.maxProjectBytes / 1_000_000,
      },
      execution: "Docker Linux containers",
      reasoning: "IBM Bob Shell, all tool groups disabled",
    };
  }
  public(job: any) {
    const { root, ...view } = job;
    return {
      ...view,
      busy: this.active.has(job.id) || this.locks.has(job.id),
      cancellable: this.active.has(job.id),
      canResume: this.canResume(job),
    };
  }
  get(id: string) {
    const job = this.jobs.get(id);
    if (!job) throw new Error("Project workspace not found");
    return job;
  }
  async save(job: any) {
    job.updatedAt = new Date().toISOString();
    const text = JSON.stringify(job, null, 2),
      report = JSON.stringify(finalReport(job), null, 2);
    const pending = (this.writes.get(job.id) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        for (const [name, data] of [
          ["job.json", text],
          ["report.json", report],
        ]) {
          const target = join(this.root, job.id, name);
          await writeFile(target + ".tmp", data);
          await rename(target + ".tmp", target);
        }
      });
    this.writes.set(job.id, pending);
    await pending;
    if (this.writes.get(job.id) === pending) this.writes.delete(job.id);
  }
  event(job: any, text: string, stream = "system") {
    const value = {
      time: new Date().toISOString(),
      phase: job.phase,
      stream,
      text: redact(text).slice(0, 10000),
    };
    job.events.push(value);
    if (job.events.length > 600) job.events.shift();
    job.updatedAt = value.time;
  }
  async phase(job: any, phase: string, message: string) {
    job.phase = phase;
    job.message = message;
    this.event(job, message);
    await this.save(job);
  }
  async create(input: any) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Provide a project folder, ZIP or source file list");
    if (this.jobs.size >= 50)
      throw new Error(
        "Workspace limit reached (50). Remove old workspace folders while ProofRun is stopped.",
      );
    const id = randomUUID(),
      root = join(this.root, id, "source");
    await mkdir(root, { recursive: true });
    try {
      const source = input.localPath
        ? await connect(root, input.localPath)
        : await ingest(root, input.files);
      const ctx = await reasoningContext(root);
      const job = {
        id,
        root,
        name:
          typeof input.name === "string"
            ? input.name.slice(0, 100)
            : "Uploaded project",
        phase: "ready",
        message: "Project copied. Start analysis and testing.",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        snapshot: ctx.snapshot,
        inventory: source.files,
        omitted: source.omitted,
        plan: null,
        tests: null,
        contractHash: null,
        results: [],
        issues: [],
        fixes: [],
        validations: [],
        events: [],
        coverage: [],
      };
      this.jobs.set(id, job);
      await this.save(job);
      return this.public(job);
    } catch (error) {
      this.jobs.delete(id);
      await rm(join(this.root, id), { recursive: true, force: true });
      throw error;
    }
  }
  async start(id: string) {
    const job = this.get(id);
    if (this.active.has(id) || this.locks.has(id))
      throw new Error("This workspace is already running");
    if (this.active.size >= 2)
      throw new Error("Two jobs are already running. Wait for a job to finish");
    const status = await this.status();
    if (!status.ready) {
      await this.phase(
        job,
        "blocked",
        "Setup required: " +
          [
            !status.bob.installed ? "install Bob Shell" : null,
            !status.bob.keyConfigured
              ? "configure BOBSHELL_API_KEY in .env"
              : null,
            !status.docker.available ? "start Docker Linux containers" : null,
          ]
            .filter(Boolean)
            .join("; "),
      );
      job.setup = status;
      await this.save(job);
      return this.public(job);
    }
    // Readiness checks await child processes; reserve a slot only after rechecking.
    if (this.active.has(id) || this.locks.has(id))
      throw new Error("This workspace is already running");
    if (this.active.size >= 2)
      throw new Error("Two jobs are already running. Wait for a job to finish");
    const controller = new AbortController();
    this.active.set(id, controller);
    const timer = setTimeout(() => controller.abort(), 30 * 60 * 1000);
    try {
      await this.phase(
        job,
        "queued",
        "Starting analysis and practical testing…",
      );
    } catch (error) {
      clearTimeout(timer);
      this.active.delete(id);
      throw error;
    }
    this.pipeline(job, controller.signal)
      .catch(async (error) => {
        if (!controller.signal.aborted)
          job.issues.push(operationIssue(job.phase, error));
        await this.phase(
          job,
          controller.signal.aborted ? "cancelled" : "error",
          controller.signal.aborted
            ? "Run cancelled. Partial evidence is preserved."
            : redact(error.message),
        );
      })
      .finally(async () => {
        clearTimeout(timer);
        try {
          await this.save(job);
        } finally {
          this.active.delete(id);
        }
      })
      .catch((error) => this.persistenceFailure(job, error));
    return this.public(job);
  }
  persistenceFailure(job: any, error: any) {
    this.active.delete(job.id);
    job.phase = "error";
    job.currentTest = null;
    job.message =
      "Workspace state could not be saved: " + redact(error.message);
    this.event(job, job.message, "error");
    console.error(job.message);
  }
  options(job: any, signal: AbortSignal) {
    return {
      signal,
      artifacts: join(this.root, job.id, "artifacts"),
      onLog: (stream: string, text: string) => this.event(job, text, stream),
      onEvent: (text: string) => this.event(job, text),
    };
  }
  async prepare(
    job: any,
    signal: AbortSignal,
    prepared?: PreparedEnvironment | null,
  ): Promise<Session> {
    if (prepared) return prepared.open(this.options(job, signal));
    const session = await this.executor.open(
      job.plan,
      job.root,
      this.options(job, signal),
    );
    try {
      if (session.bootstrap) {
        for (const result of await session.bootstrap()) {
          job.commandRuns ??= [];
          job.commandRuns.push({ phase: "environment setup", ...result });
          if (result.exitCode !== 0 || result.timedOut) {
            job.issues.push(commandIssue("environment setup", result));
            throw new Error(
              "Test environment tool provisioning failed; see captured logs",
            );
          }
        }
      }
      for (const [phase, commands] of [
        ["install", job.plan.install],
        ["build", job.plan.build],
      ] as const)
        for (const command of commands) {
          const result = await session.command(command, phase);
          job.commandRuns ??= [];
          job.commandRuns.push({ phase, ...result });
          if (result.exitCode !== 0 || result.timedOut) {
            const issue = commandIssue(phase, result);
            issue.id = randomUUID();
            job.issues.push(issue);
            throw new Error(
              `${phase} failed; command output is recorded in the report`,
            );
          }
        }
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }
  async pipeline(job: any, signal: AbortSignal) {
    const testCorrections = job.issues
      .filter((issue: any) => issue.category === "test-expectation")
      .map((issue: any) => ({
        title: issue.title,
        rootCause: issue.rootCause,
        recommendedFix: issue.recommendedFix,
      }));
    if (testCorrections.length && job.testProposal)
      job.testProposal.invalidOracle = true;
    const repairPreviousProposal =
      !!job.testProposal &&
      !!job.testProposal.validationError &&
      !job.testProposal.invalidOracle;
    job.results = [];
    job.issues = [];
    job.fixes = [];
    job.validations = [];
    job.commandRuns = [];
    job.plan = null;
    job.tests = null;
    job.contractHash = null;
    job.coverage = [];
    job.analysisWarnings = [];
    job.setup = null;
    const context = {
      ...(await reasoningContext(job.root)),
      availableRuntimeImages: IMAGES,
      previousTestCorrections: testCorrections,
    };
    (context as any).sourceLanguages = sourceLanguages(context.inventory);
    job.snapshot = context.snapshot;
    job.currentSnapshot = context.snapshot;
    job.inventory = context.inventory;
    await this.phase(
      job,
      "analyzing",
      "Bob is reading the project and determining setup, build and test commands.",
    );
    const planningTask =
      "Determine the actual purpose, user workflows, languages and supported setup for this project. Use only existing checked-in/documented commands for checks, and [] if there are none. Do not create inline smoke tests or duplicate the server. Keep purpose beginner-friendly and setup details in summary.";
    const proposal = await this.reason(
      job,
      "Determine the program's actual purpose and explain it to a beginner: who uses it, what they can do and the result they get. Keep setup/build/test details in summary, never in purpose. Report implementation languages with their roles; distinguish languages from frameworks and from languages the program merely parses. Then determine how to install, configure, build, start and test this project, matching runtime versions declared in CI or manifests. The runner provisions pinned pnpm/yarn and Python stdlib for Node images. Use python virtual environments under /workspace for pip dependencies. Identify unsupported requirements explicitly.",
      PLAN_SCHEMA,
      context,
      signal,
    );
    try {
      job.plan = validatePlan(proposal);
    } catch (error) {
      this.event(
        job,
        "Bob's plan needs a format correction: " + (error as Error).message,
      );
      job.plan = validatePlan(
        await this.reason(
          job,
          planningTask +
            " Correct this proposal to satisfy the schema and the validation error. Preserve the source-grounded commands; do not run anything.",
          PLAN_SCHEMA,
          {
            context,
            previousProposal: proposal,
            validationError: (error as Error).message,
          },
          signal,
        ),
      );
    }
    await this.phase(
      job,
      "setup",
      "Creating isolated environment and installing dependencies…",
    );
    let session: Session | null = null,
      prepared: PreparedEnvironment | null = null;
    const generationController = new AbortController();
    // Generation depends on source/plan, so overlap it with installation/build
    // as well as existing suites. Execution still waits for a validated contract.
    const generated = this.generateTests(
      job,
      context,
      AbortSignal.any([signal, generationController.signal]),
      repairPreviousProposal &&
        job.testProposal?.sourceSnapshot === context.snapshot,
    ).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    try {
      session = await this.prepare(job, signal);
      prepared = await this.capturePrepared(job, session);
      let startupError: any = null;
      if (
        job.plan.start &&
        job.plan.checks.some((command: Command) => command.requiresServer)
      ) {
        try {
          await session.start();
        } catch (error) {
          startupError = error;
          this.event(
            job,
            "Application startup failed; continuing existing command checks: " +
              (error as Error).message,
            "error",
          );
        }
      }
      await this.phase(
        job,
        "testing",
        "Checking the project’s existing test commands…",
      );
      for (const [index, command] of job.plan.checks.entries()) {
        const result = await session.command(command, "existing tests");
        job.commandRuns.push({ phase: "existing tests", ...result });
        job.results.push({
          id: "existing-" + index,
          title: command.label,
          category: "existing test suite",
          expected: "Command completes with exit code 0",
          outcome: result.timedOut
            ? "inconclusive"
            : result.exitCode === 0
              ? "passed"
              : "failed",
          contractHash: hash(JSON.stringify(command)),
          logs: result.stdout + "\n" + result.stderr,
          trace: [
            {
              label: command.label,
              request: { argv: command.argv },
              response: { exitCode: result.exitCode },
              error: result.exitCode === 0 ? null : "Command failed",
            },
          ],
        });
        if (result.exitCode !== 0 || result.timedOut) {
          const issue = commandIssue("existing tests", result);
          issue.testId = "existing-" + index;
          job.issues.push(issue);
        }
        if (signal.aborted) break;
        if (result.timedOut && index < job.plan.checks.length - 1) {
          this.event(
            job,
            "A timed-out command stopped its container. Restoring a fresh environment for remaining checks.",
          );
          await session.close();
          session = await this.prepare(job, signal, prepared);
          if (
            job.plan.start &&
            job.plan.checks.some((command: Command) => command.requiresServer)
          )
            await session.start();
        }
      }
      if (startupError) throw startupError;
      await this.phase(
        job,
        "generating-tests",
        "Bob is generating realistic and adversarial test cases from this project.",
      );
      const generatedResult = await generated;
      if ("error" in generatedResult) throw generatedResult.error;
      job.tests = generatedResult.value;
      job.tests.http.push(...mutations(job.tests.http));
      job.contractHash = hash(JSON.stringify(job.tests));
      await this.save(job);
      await session.close();
      session = null;
      await this.phase(
        job,
        "testing",
        "Executing generated tests and monitoring failures…",
      );
      await this.executeTests(job, signal, job.results, prepared);
    } catch (error) {
      generationController.abort();
      if (
        !signal.aborted &&
        (!job.issues.length || (error as any).code?.startsWith("APPLICATION_"))
      )
        job.issues.push(
          operationIssue(job.phase, error, session?.runtimeLogs()),
        );
      if (!signal.aborted) this.event(job, (error as Error).message, "error");
    } finally {
      generationController.abort();
      await generated;
      if (session) await session.close();
      if (prepared) await prepared.close();
    }
    if (signal.aborted) {
      await this.phase(
        job,
        "cancelled",
        "Run cancelled. Partial evidence is preserved.",
      );
      return;
    }
    await this.phase(
      job,
      "diagnosing",
      "Analyzing observed failures and generating concrete proposed repairs…",
    );
    const actionable = job.issues.filter(
      (issue: any) => !["environment", "reasoning"].includes(issue.category),
    );
    if (this.ai.batchFailures && actionable.length > 1) {
      try {
        await this.investigateBatch(job, actionable, signal);
      } catch (error) {
        this.event(
          job,
          "Repair analysis could not finish: " + (error as Error).message,
          "error",
        );
        job.analysisWarnings.push({
          message: redact((error as Error).message),
        });
        await this.save(job);
      }
    } else {
      for (const issue of job.issues) {
        if (signal.aborted) break;
        try {
          await this.investigate(job, issue, signal);
        } catch (error) {
          this.event(
            job,
            "Issue analysis: " + (error as Error).message,
            "error",
          );
          job.analysisWarnings.push({
            issueId: issue.id,
            message: redact((error as Error).message),
          });
          await this.save(job);
        }
      }
    }
    if (signal.aborted) {
      await this.phase(
        job,
        "cancelled",
        "Run cancelled. Partial evidence is preserved.",
      );
      return;
    }
    await this.phase(
      job,
      "complete",
      job.issues.length
        ? `Testing finished with ${job.issues.length} reported issue(s). Review the evidence and proposed repairs.`
        : job.results.length
          ? "The executed checks passed. Review coverage and limitations before shipping."
          : "No executable behavior checks ran. Review the setup and coverage gaps.",
    );
  }
  async capturePrepared(job: any, session: Session) {
    if (!session.snapshot) return null;
    if (job.plan.services.length) {
      this.event(
        job,
        "Database-backed workflows retain fresh setup: installation/build may initialize service data.",
      );
      return null;
    }
    try {
      return await session.snapshot();
    } catch (error) {
      this.event(
        job,
        "Prepared environment reuse unavailable; using fresh setup: " +
          (error as Error).message,
      );
      return null;
    }
  }
  async executeTests(
    job: any,
    signal: AbortSignal,
    target: any[],
    prepared?: PreparedEnvironment | null,
  ) {
    const groups = [
      ...job.tests.http.map((test: any) => ({ kind: "http", test })),
      ...job.tests.browser.map((test: any) => ({ kind: "browser", test })),
      ...job.tests.commands.map((test: any, i: number) => ({
        kind: "command",
        test: { ...test, id: "command-" + i, title: test.label },
      })),
    ];
    if (!groups.length && !job.plan.checks.length)
      job.coverage.push(
        "No executable tests were generated; no behavioral validation can be claimed.",
      );
    job.runningTests = [];
    const runGroup = async (group: any) => {
      if (signal.aborted) throw new Error("Run cancelled");
      job.runningTests.push(group.test.title);
      job.currentTest = job.runningTests.join(" · ");
      this.event(job, "Running " + group.test.title);
      await this.save(job);
      let session: Session | null = null,
        result: any;
      try {
        session = await this.prepare(job, signal, prepared);
        if (group.kind === "command") {
          if (job.plan.start && group.test.requiresServer)
            await session.start();
          const r = await session.command(group.test, "generated test");
          result = {
            id: group.test.id,
            title: group.test.title,
            outcome: r.timedOut
              ? "inconclusive"
              : r.exitCode === 0
                ? "passed"
                : "failed",
            category: "command",
            expected: "Command exits with status 0",
            logs: r.stdout + "\n" + r.stderr,
            trace: [
              {
                label: group.test.label,
                request: { argv: r.argv },
                error: r.exitCode === 0 ? null : "Command failed",
                response: { exitCode: r.exitCode },
              },
            ],
          };
        } else {
          if (!job.plan.start || !job.plan.port)
            throw new Error(
              "HTTP/browser test has no application start command and port",
            );
          await session.start();
          result =
            group.kind === "http"
              ? await session.probe(group.test)
              : await session.browser(group.test);
          result.logs = session.runtimeLogs();
        }
      } catch (error) {
        result = {
          id: group.test.id,
          title: group.test.title,
          intent: group.test.intent,
          expected: group.test.expected,
          basis: group.test.basis,
          category:
            (error as any).code === "APPLICATION_CRASH"
              ? "runtime-crash"
              : group.kind,
          outcome:
            (error as any).code === "APPLICATION_CRASH"
              ? "failed"
              : "inconclusive",
          logs: session?.runtimeLogs() ?? "",
          trace: [
            {
              label: "Test could not finish",
              error: redact((error as Error).message),
            },
          ],
        };
      } finally {
        if (session) await session.close();
      }
      result.contractHash = hash(JSON.stringify(group.test));
      job.runningTests = job.runningTests.filter(
        (title: string) => title !== group.test.title,
      );
      job.currentTest = job.runningTests.join(" · ") || null;
      target.push(result);
      if (target === job.results && result.outcome !== "passed")
        job.issues.push(
          issueFromResult(result, {
            runtime: job.plan.runtime,
            sourceSnapshot: job.snapshot,
            contractHash: result.contractHash,
          }),
        );
      await this.save(job);
    };
    let next = 0;
    // Prepared workspaces are immutable; each worker gets its own process, files and services.
    const parallelism = prepared ? 2 : 1;
    const workers = Array.from(
      { length: Math.min(parallelism, groups.length) },
      async () => {
        while (next < groups.length) {
          const group = groups[next++];
          await runGroup(group);
        }
      },
    );
    const completed = await Promise.allSettled(workers);
    job.runningTests = [];
    job.currentTest = null;
    const failed = completed.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
  async investigate(job: any, issue: any, signal?: AbortSignal) {
    if (["environment", "reasoning"].includes(issue.category)) {
      issue.fixExplanation =
        "This operation did not establish an application defect. Correct the reported execution or reasoning requirement, then rerun the unchanged checks.";
      issue.risks =
        "Increasing resource bounds requires sufficient Docker capacity. Application checks still need to execute after setup succeeds.";
      await this.save(job);
      return;
    }
    const context = await reasoningContext(job.root);
    const schema = `{classification:'application'|'test-expectation'|'environment'|'insufficient',severity:'critical'|'high'|'medium'|'low'|'info',description:string,rootCause:string,affected:[{path:string,line:number|null,symbol:string|null}],recommendedFix:string,fixExplanation:string,risks:string,patch:null|{explanation:string,risks:string,files:[{path:string,beforeHash:string|null,after:COMPLETE_NEW_FILE_CONTENTS}]}}. Reference only paths in the inventory; source hashes are supplied. A new config/source file uses beforeHash:null. Never edit or weaken tests, expected outcomes, dependency caches, credential files or the runner. Use patch:null when evidence is insufficient. Explain uncertainty, limitations and side effects. Do not claim a repair was applied or verified.`;
    const response = await this.reason(
      job,
      "Investigate this actual observed issue and propose a narrow source fix. Return complete replacement contents for every changed file, matching exact current hashes. Do not execute anything.",
      schema,
      {
        context,
        issue,
        assertionSemantics:
          "contains/notContains check response body, not headers. A wrong generated test expectation is not an application defect: use patch:null, classification:test-expectation and explain the invalid oracle. Never change production code merely to satisfy a mistaken oracle.",
      },
      signal,
    );
    await this.acceptAnalysis(job, issue, response, context);
  }
  async investigateBatch(job: any, issues: any[], signal: AbortSignal) {
    const context = await reasoningContext(job.root);
    const response = await this.reason(
      job,
      "Investigate every supplied observed failure. Distinguish application defects from mistaken test expectations. contains checks only response body, headers use header assertions, and HEAD has no body. A wrong oracle requires classification:test-expectation and patch:null, never an application source change. Propose narrow fixes for real defects using complete source replacement and exact hashes. Return exactly one analysis per supplied issue ID; do not omit any.",
      `{issues:[{id:exact input issue ID,analysis:{classification:'application'|'test-expectation'|'environment'|'insufficient',severity:'critical'|'high'|'medium'|'low'|'info',description:string,rootCause:string,affected:[{path:string,line:number|null,symbol:string|null}],recommendedFix:string,fixExplanation:string,risks:string,patch:null|{explanation:string,risks:string,files:[{path:string,beforeHash:string|null,after:COMPLETE_NEW_FILE_CONTENTS}]}}}]}. Never edit tests, expected outcomes, credentials, caches or the runner.`,
      { context, issues },
      signal,
    );
    if (
      !Array.isArray(response.issues) ||
      response.issues.length !== issues.length ||
      new Set(response.issues.map((r: any) => r.id)).size !== issues.length ||
      response.issues.some(
        (r: any) => !issues.some((i) => i.id === r.id) || !r.analysis,
      )
    )
      throw new Error(
        "Bob's grouped repair response did not cover every issue. Execution evidence is saved; retry a repair individually.",
      );
    for (const issue of issues) {
      if (signal.aborted) throw new Error("Repair analysis cancelled");
      await this.acceptAnalysis(
        job,
        issue,
        response.issues.find((r: any) => r.id === issue.id).analysis,
        context,
      );
    }
  }
  async acceptAnalysis(job: any, issue: any, response: any, context: any) {
    enrich(issue, response, new Set(context.inventory.map((f) => f.path)));
    for (const affected of issue.affected) {
      if (affected.line) {
        const lines = (
          await readFile(inside(job.root, affected.path), "utf8")
        ).split("\n").length;
        if (affected.line > lines) affected.line = null;
      }
    }
    if (
      ["test-expectation", "insufficient", "environment"].includes(
        response.classification,
      )
    ) {
      issue.category = response.classification;
      issue.status = "inconclusive";
      response.patch = null;
    }
    if (response.patch) {
      const fix = await propose(job.root, issue.id, response.patch);
      job.fixes = job.fixes.filter(
        (f: any) => f.issueId !== issue.id || f.status === "applied",
      );
      const duplicate = job.fixes.find(
        (other: any) =>
          other.status === "proposed" &&
          JSON.stringify(
            other.files.map((f: any) => ({
              path: f.path,
              beforeHash: f.beforeHash,
              after: f.after,
            })),
          ) ===
            JSON.stringify(
              fix.files.map((f: any) => ({
                path: f.path,
                beforeHash: f.beforeHash,
                after: f.after,
              })),
            ),
      );
      if (duplicate)
        duplicate.relatedIssueIds = [
          ...new Set([...(duplicate.relatedIssueIds ?? []), issue.id]),
        ];
      else job.fixes.push(fix);
    }
    await this.save(job);
  }
  async askTracked(
    job: any,
    task: string,
    schema: string,
    data: any,
    signal?: AbortSignal,
  ) {
    const started = Date.now(),
      token = randomUUID();
    const operation = /^Generate|^Correct generated/.test(task)
      ? "Generating practical tests"
      : /Determine/.test(task)
        ? "Understanding the project"
        : "Analyzing failure evidence";
    job.reasoningProgress = {
      token,
      operation,
      startedAt: new Date(started).toISOString(),
      elapsedSeconds: 0,
    };
    const timer = setInterval(() => {
      if (job.reasoningProgress?.token !== token) return;
      job.reasoningProgress.elapsedSeconds = Math.floor(
        (Date.now() - started) / 1000,
      );
      this.save(job).catch((error) => this.event(job, error.message, "error"));
    }, 5000);
    let status = "completed";
    try {
      return await this.ai.ask(task, schema, data, signal);
    } catch (error) {
      status = signal?.aborted ? "cancelled" : "failed";
      throw error;
    } finally {
      clearInterval(timer);
      if (job.reasoningProgress?.token === token) job.reasoningProgress = null;
      job.reasoningRuns ??= [];
      job.reasoningRuns.push({
        operation,
        startedAt: new Date(started).toISOString(),
        durationMs: Date.now() - started,
        requestBytes: Buffer.byteLength(JSON.stringify(data)),
        status,
      });
      await this.save(job);
    }
  }
  async generateTests(
    job: any,
    context: any,
    signal: AbortSignal,
    reuse = false,
  ): Promise<TestPlan> {
    const inputTypes = browserInputTypes(context.excerpts);
    const requiredInputs = browserRequiredInputs(context.excerpts);
    let proposal;
    if (
      reuse &&
      !job.testProposal?.invalidOracle &&
      job.testProposal?.sourceSnapshot === context.snapshot
    ) {
      proposal = job.testProposal.value;
      this.event(
        job,
        "Rechecking the saved proposal before requesting any new inference.",
      );
    } else {
      proposal = await this.reason(
        job,
        "Generate practical tests for this exact software. Prioritize up to six meaningful workflows across discovered components: normal use, boundaries and adversarial inputs. Group read-only variations as multiple steps, while independent stateful journeys get fresh instances. HTTP/browser workflows require the planned server and port; use command probes for non-web software. Ground assertions in source/docs and label assumptions. Use only the supported declarative actions. Keep text concise. Do not repeat existing suites or reread complete files already supplied. If previousTestCorrections is present, correct those faulty generated test designs rather than repeating them. Preserve meaningful behavior coverage; never change production source to accommodate an invalid test.",
        TEST_SCHEMA,
        {
          context,
          plan: job.plan,
          browserInputTypes: inputTypes,
          requiredInputs,
        },
        signal,
      );
    }
    job.testProposal = {
      sourceSnapshot: context.snapshot,
      generatedAt: new Date().toISOString(),
      value: proposal,
    };
    await this.save(job);
    try {
      return validateTests(proposal, inputTypes, requiredInputs);
    } catch (error) {
      if (signal.aborted) throw error;
      job.testProposal.validationError = (error as Error).message;
      this.event(job, "Correcting test format: " + (error as Error).message);
      // Format correction needs the proposal, not another entire source export
      // or extra read-file rounds. Preserve inputs, expectations and workflows.
      proposal = await this.askTracked(
        job,
        "Correct generated test JSON to match the schema and validation error. Preserve every workflow, triggering input and intended assertion. Only correct field names, supported declarative action shapes, or missing display metadata. Do not execute, modify source, request files, omit failed workflows or invent new behavior.",
        TEST_SCHEMA,
        {
          previousProposal: proposal,
          validationError: (error as Error).message,
          browserInputTypes: inputTypes,
          requiredInputs,
        },
        AbortSignal.any([signal, AbortSignal.timeout(60000)]),
      );
      job.testProposal.value = proposal;
      await this.save(job);
      return validateTests(proposal, inputTypes, requiredInputs);
    }
  }
  async reason(
    job: any,
    task: string,
    schema: string,
    data: any,
    signal?: AbortSignal,
  ) {
    const context = data.context ?? data;
    const known = new Map<string, any>(
      context.inventory.map((f: any) => [f.path, f]),
    );
    const additional = new Map<string, any>();
    let bytes = 0;
    const incomplete = context.inventory.filter(
      (f: any) =>
        !f.binary &&
        f.size <= 180000 &&
        !context.excerpts?.some((e: any) => e.path === f.path && !e.truncated),
    );
    let finish = incomplete.length === 0;
    for (let round = 0; round < 4; round++) {
      const response = await this.askTracked(
        job,
        task +
          (round === 3 || finish
            ? " Source retrieval is now complete. Return the requested final schema JSON using the supplied source; explain uncovered components in limitations. Do not request more files."
            : " You can ask for specific additional source files by returning {readFiles:[relative paths from the inventory]} instead of guessing. Tools remain disabled."),
        schema +
          (round === 3 || finish
            ? ""
            : " OR {readFiles:string[]} for a bounded, read-only source request."),
        {
          ...data,
          additionalSource: [...additional.values()],
          availableAdditionalFiles: finish
            ? []
            : incomplete
                .filter((f: any) => !additional.has(f.path))
                .map((f: any) => f.path),
        },
        signal,
      );
      let requested = Array.isArray(response.readFiles)
        ? response.readFiles
        : [];
      for (const analysis of [
        response,
        ...(Array.isArray(response.issues)
          ? response.issues.map((row: any) => row.analysis).filter(Boolean)
          : []),
      ]) {
        if (analysis.patch?.files) {
          for (const file of analysis.patch.files) {
            const original = known.get(file.path),
              excerpt = context.excerpts?.find(
                (f: any) => f.path === file.path,
              );
            if (
              original &&
              !additional.has(file.path) &&
              (!excerpt || excerpt.truncated)
            ) {
              if (original.size > 180000 || original.binary) {
                analysis.patch = null;
                analysis.risks =
                  (analysis.risks ?? "") +
                  " Complete source cannot fit a text patch. No automatic proposal is supplied.";
                break;
              }
              requested.push(file.path);
            }
          }
        }
      }
      if (!requested.length) return response;
      if (round === 3)
        throw new Error(
          "Bob could not finalize its analysis within the bounded source context. Execution evidence is preserved.",
        );
      const previousCount = additional.size;
      const selected = [...new Set(requested)].slice(0, 24);
      if (selected.length < requested.length)
        this.event(
          job,
          "Source request batched: providing up to 24 files within the 350 KB budget",
        );
      for (const path of selected) {
        const entry = known.get(path);
        if (!entry || entry.binary || entry.size > 180000)
          throw new Error("Bob requested unavailable or oversized text source");
        if (additional.has(path)) continue;
        const content = await readFile(inside(job.root, path), "utf8");
        const size = Buffer.byteLength(content);
        if (bytes + size > 350000) {
          this.event(job, "Source context budget reached; omitted " + path);
          continue;
        }
        bytes += size;
        additional.set(path, {
          path,
          hash: entry.hash,
          content,
          truncated: false,
        });
      }
      finish =
        additional.size === previousCount ||
        incomplete.every((f: any) => additional.has(f.path));
      this.event(
        job,
        "Bob requested additional source context (read-only): " +
          requested.join(", "),
      );
    }
    throw new Error("Additional source retrieval exhausted");
  }
  canResume(job: any) {
    return (
      !!job.plan &&
      !job.tests &&
      job.results?.length === job.plan.checks.length &&
      job.results.length > 0 &&
      job.results.every(
        (result: any, index: number) =>
          result.outcome === "passed" &&
          result.contractHash === hash(JSON.stringify(job.plan.checks[index])),
      )
    );
  }
  async resume(id: string) {
    const job = this.get(id);
    if (this.active.has(id) || this.locks.has(id))
      throw new Error("This workspace is already running");
    if (!this.canResume(job))
      throw new Error(
        "Start a new analysis: there are no complete unchanged passing suites to reuse",
      );
    const context = {
      ...(await reasoningContext(job.root)),
      availableRuntimeImages: IMAGES,
    };
    if (context.snapshot !== job.snapshot)
      throw new Error(
        "Source changed since the checks ran. Start a new analysis",
      );
    const status = await this.status();
    if (!status.ready)
      throw new Error("Bob and Docker must be ready to continue testing");
    if (this.active.size >= 2 || this.active.has(id) || this.locks.has(id))
      throw new Error("Wait until a running job finishes");
    const controller = new AbortController();
    this.active.set(id, controller);
    const timer = setTimeout(() => controller.abort(), 1800000);
    try {
      await this.phase(
        job,
        "generating-tests",
        "Continuing practical tests. Reusing passing suites verified against this exact source and command hashes.",
      );
    } catch (error) {
      clearTimeout(timer);
      this.active.delete(id);
      throw error;
    }
    (async () => {
      let session: Session | null = null,
        prepared: PreparedEnvironment | null = null;
      try {
        job.analysisWarnings = [];
        job.tests = await this.generateTests(
          job,
          context,
          controller.signal,
          true,
        );
        job.tests.http.push(...mutations(job.tests.http));
        job.contractHash = hash(JSON.stringify(job.tests));
        for (const issue of job.issues)
          if (issue.category === "reasoning") {
            issue.status = "resolved";
            issue.validation = {
              reasoningRecovered: true,
              time: new Date().toISOString(),
            };
          }
        await this.phase(
          job,
          "setup",
          "Preparing a fresh isolated environment for the generated workflows…",
        );
        session = await this.prepare(job, controller.signal);
        prepared = await this.capturePrepared(job, session);
        await session.close();
        session = null;
        await this.phase(
          job,
          "testing",
          "Executing generated tests; prior passing suites retain their original evidence.",
        );
        await this.executeTests(job, controller.signal, job.results, prepared);
      } catch (error) {
        if (!controller.signal.aborted)
          job.issues.push(
            operationIssue(job.phase, error, session?.runtimeLogs()),
          );
        this.event(job, (error as Error).message, "error");
      } finally {
        if (session) await session.close();
        if (prepared) await prepared.close();
      }
      if (controller.signal.aborted) {
        await this.phase(
          job,
          "cancelled",
          "Continued testing cancelled. Evidence is preserved.",
        );
        return;
      }
      await this.phase(
        job,
        "diagnosing",
        "Investigating the observed practical-test failures…",
      );
      const issues = job.issues.filter(
        (issue: any) =>
          issue.status !== "resolved" &&
          !["environment", "reasoning"].includes(issue.category),
      );
      try {
        if (this.ai.batchFailures && issues.length > 1)
          await this.investigateBatch(job, issues, controller.signal);
        else
          for (const issue of issues)
            await this.investigate(job, issue, controller.signal);
      } catch (error) {
        job.analysisWarnings.push({
          message: redact((error as Error).message),
        });
        this.event(job, (error as Error).message, "error");
      }
      await this.phase(
        job,
        "complete",
        "Continued testing finished. Review measured results, findings and coverage limits.",
      );
    })()
      .catch(async (error) => {
        job.analysisWarnings ??= [];
        job.analysisWarnings.push({ message: redact(error.message) });
        await this.phase(job, "error", redact(error.message));
      })
      .finally(async () => {
        clearTimeout(timer);
        try {
          await this.save(job);
        } finally {
          this.active.delete(id);
        }
      })
      .catch((error) => this.persistenceFailure(job, error));
    return this.public(job);
  }
  async generateFix(id: string, issueId?: string) {
    const job = this.get(id);
    if (this.active.has(id) || this.locks.has(id))
      throw new Error("Wait until the current operation finishes");
    const issues = issueId
      ? job.issues.filter((i: any) => i.id === issueId)
      : job.issues.filter((i: any) => i.status !== "resolved" &&
          !["environment", "reasoning", "test-expectation", "insufficient"].includes(i.category) &&
          !["proposed", "rejected"].includes([...job.fixes].reverse().find((f: any) => f.issueId === i.id || f.relatedIssueIds?.includes(i.id))?.status));
    if (!issues.length) throw new Error(issueId ? "Issue not found" : "No findings need new repair proposals");
    if (this.active.size >= 2)
      throw new Error("Two jobs are already running. Wait for one to finish");
    const controller = new AbortController();
    this.active.set(id, controller);
    const timer = setTimeout(() => controller.abort(), 180000);
    job.analysisWarnings ??= [];
    try {
      await this.phase(
        job,
        "diagnosing",
        "Bob is preparing " + issues.length + " repair proposal(s)…",
      );
    } catch (error) {
      clearTimeout(timer);
      this.active.delete(id);
      throw error;
    }
    (async () => {
      if (this.ai.batchFailures && issues.length > 1)
        await this.investigateBatch(job, issues, controller.signal);
      else for (const issue of issues)
        await this.investigate(job, issue, controller.signal);
    })()
      .then(async () => {
        job.analysisWarnings = job.analysisWarnings.filter(
          (w: any) => !issues.some((issue: any) => w.issueId === issue.id),
        );
        await this.phase(
          job,
          "complete",
          "Repair analysis finished. Inspect the proposed change before approving it.",
        );
      })
      .catch(async (error) => {
        const message = redact(error.message);
        for (const issue of issues) job.analysisWarnings.push({ issueId: issue.id, message });
        this.event(job, "Repair analysis: " + message, "error");
        await this.phase(
          job,
          controller.signal.aborted ? "cancelled" : "complete",
          "Repair analysis did not finish. Execution evidence and existing proposals are preserved.",
        );
      })
      .finally(async () => {
        clearTimeout(timer);
        try {
          await this.save(job);
        } finally {
          this.active.delete(id);
        }
      })
      .catch((error) => this.persistenceFailure(job, error));
    return this.public(job);
  }
  async editFix(id: string, fixId: string, input: any) {
    const job = this.get(id);
    if (this.active.has(id) || this.locks.has(id))
      throw new Error("Wait until the current operation finishes");
    this.locks.add(id);
    try {
      const fix = job.fixes.find((f: any) => f.id === fixId);
      if (!fix || fix.status !== "proposed")
        throw new Error("Only a proposed fix can be edited");
      const edited = await propose(job.root, fix.issueId, {
        explanation: fix.explanation,
        risks: fix.risks,
        files: input.files,
      });
      edited.id = fix.id;
      edited.revision = fix.revision + 1;
      Object.assign(fix, edited);
      await this.save(job);
    } finally {
      this.locks.delete(id);
    }
    return this.public(job);
  }
  async rejectFix(id: string, fixId: string) {
    const job = this.get(id);
    if (this.active.has(id) || this.locks.has(id))
      throw new Error("Wait until the current operation finishes");
    const fix = job.fixes.find((f: any) => f.id === fixId);
    if (!fix || fix.status !== "proposed")
      throw new Error("Proposed fix not found");
    fix.status = "rejected";
    await this.save(job);
    return this.public(job);
  }
  async approveFix(id: string, fixId: string, input: any) {
    return this.approveFixes(id, {
      approved: input?.approved,
      fixes: [{ id: fixId, revision: input?.revision }],
    }, false);
  }
  async approveFixes(id: string, input: any, requireAll = true) {
    const job = this.get(id);
    if (this.active.has(id) || this.locks.has(id))
      throw new Error("Wait until the current operation finishes");
    if (input?.approved !== true || !Array.isArray(input.fixes) || !input.fixes.length)
      throw new Error("Explicit approval of the current proposals is required");
    const pending = job.fixes.filter((f: any) => f.status === "proposed" &&
      job.issues.some((i: any) => i.status !== "resolved" &&
        (f.issueId === i.id || f.relatedIssueIds?.includes(i.id))));
    const ids = new Set(input.fixes.map((f: any) => f?.id));
    const fixes = pending.filter((f: any) => ids.has(f.id));
    if (fixes.length !== input.fixes.length || (requireAll && fixes.length !== pending.length))
      throw new Error("Repair proposals changed. Refresh and review the current diffs before approving");
    if (!job.plan) throw new Error("Analyze the application first");
    if (this.active.size >= 2)
      throw new Error("Two jobs are already running. Wait for one to finish before repairing");
    this.locks.add(id);
    try {
      if (!(await this.executor.status()).available)
        throw new Error("Start Docker before approving so the repair can be retested");
      await applyBatch(job.root, fixes, input);
      job.inventory = await inventory(job.root);
      job.currentSnapshot = hash(JSON.stringify(job.inventory));
      await this.save(job);
      try {
        return await this.retest(id, fixes[0], true, fixes);
      } catch (error) {
        for (const fix of fixes) fix.retest = {
          resolved: false, error: redact((error as Error).message),
        };
        await this.save(job);
        throw error;
      }
    } finally {
      this.locks.delete(id);
    }
  }
  async retest(id: string, fix?: Fix, approvalOwnsLock = false, appliedFixes: Fix[] = fix ? [fix] : []) {
    const job = this.get(id);
    if (this.active.has(id) || (this.locks.has(id) && !approvalOwnsLock))
      throw new Error("Wait until the current operation finishes");
    if (!job.plan) throw new Error("Analyze the application first");
    if (this.active.size >= 2)
      throw new Error("Two jobs are already running. Wait for a job to finish");
    const status = await this.status();
    if (!status.docker.available)
      throw new Error("Docker must be ready before retesting");
    if (this.active.has(id) || (this.locks.has(id) && !approvalOwnsLock))
      throw new Error("This workspace is already running");
    if (this.active.size >= 2)
      throw new Error("Two jobs are already running. Wait for a job to finish");
    const controller = new AbortController();
    this.active.set(id, controller);
    const timer = setTimeout(() => controller.abort(), 1800000);
    try {
      await this.phase(
        job,
        "retesting",
        "Rerunning setup, existing tests and unchanged generated tests…",
      );
    } catch (error) {
      clearTimeout(timer);
      this.active.delete(id);
      throw error;
    }
    (async () => {
      const results: any[] = [];
      const beforeHash = job.contractHash;
      let session: Session | null = null,
        prepared: PreparedEnvironment | null = null;
      const setup: any[] = [];
      let startupVerified = false;
      try {
        session = await this.prepare(job, controller.signal);
        prepared = await this.capturePrepared(job, session);
        if (
          job.plan.start &&
          (job.plan.checks.some((command: Command) => command.requiresServer) ||
            appliedFixes.some((f) =>
              !job.issues.find((issue: any) => issue.id === f.issueId)?.testId))
        ) {
          await session.start();
          startupVerified = true;
        }
        for (const [index, cmd] of job.plan.checks.entries()) {
          const r = await session.command(cmd, "regression");
          setup.push(r);
          results.push({
            id: "existing-" + index,
            title: cmd.label,
            category: "existing test suite",
            expected: "Command completes with exit code 0",
            outcome: r.timedOut
              ? "inconclusive"
              : r.exitCode === 0
                ? "passed"
                : "failed",
            contractHash: hash(JSON.stringify(cmd)),
            logs: r.stdout + "\n" + r.stderr,
            trace: [
              {
                label: cmd.label,
                request: { argv: cmd.argv },
                response: { exitCode: r.exitCode },
                error: r.exitCode === 0 ? null : "Command failed",
              },
            ],
          });
          if (controller.signal.aborted) break;
          if (r.timedOut && index < job.plan.checks.length - 1) {
            this.event(
              job,
              "Restoring a fresh environment after a command timeout before remaining regression checks.",
            );
            await session.close();
            session = await this.prepare(job, controller.signal, prepared);
            if (
              job.plan.start &&
              job.plan.checks.some((command: Command) => command.requiresServer)
            )
              await session.start();
          }
        }
        await session.close();
        session = null;
        if (job.tests)
          await this.executeTests(job, controller.signal, results, prepared);
        else if (
          !job.coverage.includes(
            "Behavioral tests were not generated before the setup/build failure. Start a new analysis to exercise application behavior.",
          )
        )
          job.coverage.push(
            "Behavioral tests were not generated before the setup/build failure. Start a new analysis to exercise application behavior.",
          );
        const unchanged =
          job.tests === null
            ? beforeHash === null
            : beforeHash === hash(JSON.stringify(job.tests));
        const original = job.issues.find((i: any) => i.id === fix?.issueId);
        const relevant = original?.testId
          ? results.find((r) => r.id === original.testId)
          : null;
        const resolved =
          unchanged &&
          (original?.testId
            ? relevant?.outcome === "passed"
            : fix
              ? (startupVerified ||
                  job.plan.install.length > 0 ||
                  job.plan.build.length > 0 ||
                  setup.length > 0) &&
                setup.every((r) => r.exitCode === 0 && !r.timedOut)
              : results.length > 0 &&
                results.every((r) => r.outcome === "passed"));
        const regressions = results.filter(
          (r) =>
            r.outcome !== "passed" &&
            job.results.find((b: any) => b.id === r.id)?.outcome === "passed",
        );
        const validation = {
          time: new Date().toISOString(),
          sourceSnapshot: (await reasoningContext(job.root)).snapshot,
          fixId: fix?.id ?? null,
          fixIds: appliedFixes.map(f => f.id),
          contractsUnchanged: unchanged,
          results,
          existingTests: setup,
          resolved,
          regressions,
        };
        job.validations.push(validation);
        if (fix) fix.retest = validation;
        if (original) {
          original.status = resolved
            ? "resolved"
            : relevant?.outcome === "inconclusive"
              ? "inconclusive"
              : "open";
          original.validation = {
            resolved,
            time: validation.time,
            contractsUnchanged: unchanged,
          };
        }
        for (const known of job.issues) {
          if (!known.testId) continue;
          const observed = results.find((r) => r.id === known.testId);
          if (observed && unchanged) {
            known.status =
              observed.outcome === "passed"
                ? "resolved"
                : ["test-expectation", "insufficient"].includes(
                      known.category,
                    ) || observed.outcome === "inconclusive"
                  ? "inconclusive"
                  : "open";
            known.validation = {
              resolved: observed.outcome === "passed",
              time: validation.time,
              contractsUnchanged: unchanged,
            };
          }
        }
        for (const appliedFix of appliedFixes) {
          const related = job.issues.filter((i: any) =>
            i.id === appliedFix.issueId || (appliedFix as any).relatedIssueIds?.includes(i.id));
          const fixed = unchanged && related.length > 0 && related.filter((i: any) => i.id === appliedFix.issueId).every((i: any) =>
            i.testId ? results.find((r) => r.id === i.testId)?.outcome === "passed" :
            (startupVerified || setup.length > 0 || job.plan.install.length > 0 || job.plan.build.length > 0) &&
            setup.every((r) => r.exitCode === 0 && !r.timedOut));
          appliedFix.retest = { ...validation, fixId: appliedFix.id, resolved: fixed };
          for (const issue of related) if (!issue.testId) {
            issue.status = fixed ? "resolved" : "open";
            issue.validation = { resolved: fixed, time: validation.time, contractsUnchanged: unchanged };
          }
        }
        if (appliedFixes.length) validation.resolved = appliedFixes.every(f => f.retest.resolved);
        for (const result of regressions) {
          const issue = issueFromResult(result, {
            phase: "regression",
            sourceSnapshot: validation.sourceSnapshot,
          });
          issue.status = "regression";
          job.issues.push(issue);
        }
        await this.phase(
          job,
          "complete",
          validation.resolved &&
            regressions.length === 0 &&
            results.length > 0 &&
            results.every((result: any) => result.outcome === "passed")
            ? `All ${results.length} checks passed. Test contracts unchanged; no regressions detected.`
            : fix && validation.resolved
              ? `Original failure resolved. ${results.filter((result: any) => result.outcome !== "passed").length} check(s) still failed or incomplete; ${regressions.length} regression(s) detected.`
              : "Re-test finished. Review unresolved or incomplete checks.",
        );
      } catch (error) {
        const failedValidation = {
          time: new Date().toISOString(),
          fixId: fix?.id ?? null,
          fixIds: appliedFixes.map(f => f.id),
          results,
          existingTests: setup,
          contractsUnchanged: beforeHash === job.contractHash,
          resolved: false,
          regressions: [],
          error: redact((error as Error).message),
        };
        job.validations.push(failedValidation);
        for (const appliedFix of appliedFixes)
          appliedFix.retest = {
            ...failedValidation,
            resolved: false,
            error: redact((error as Error).message),
          };
        await this.phase(
          job,
          controller.signal.aborted ? "cancelled" : "error",
          "Re-test did not finish: " + redact((error as Error).message),
        );
      } finally {
        if (session) await session.close();
        if (prepared) await prepared.close();
        clearTimeout(timer);
        try {
          await this.save(job);
        } finally {
          this.active.delete(id);
        }
      }
    })().catch((error) => this.persistenceFailure(job, error));
    return this.public(job);
  }
  async cancel(id: string) {
    const job = this.get(id);
    if (!this.active.has(id)) throw new Error("No active run to cancel");
    this.active.get(id)?.abort();
    await this.phase(
      job,
      "cancelling",
      "Stopping containers and preserving partial evidence…",
    );
    return this.public(job);
  }
  async deleteProject(id: string) {
    const job = this.get(id);
    if (this.active.has(id) || this.locks.has(id))
      throw new Error("Stop the running job before deleting this workspace");
    this.jobs.delete(id);
    await rm(join(this.root, id), { recursive: true, force: true });
  }
  async clearProjects() {
    const idle = [...this.jobs.values()].filter(
      (j) => !this.active.has(j.id) && !this.locks.has(j.id),
    );
    await Promise.all(idle.map((j) => this.deleteProject(j.id)));
    return { deleted: idle.length };
  }
  async generateMarkdownReport(id: string, signal?: AbortSignal) {
    const job = this.get(id);
    const report = finalReport(job);
    const task =
      "Produce a well-structured Markdown QA report from the supplied ProofRun job data. " +
      "Use the existing text verbatim wherever possible — do not rewrite, embellish, or invent content. " +
      "Structure the document with these sections in order: " +
      "1. Title (project name + 'QA Report'), generated date; " +
      "2. Summary (status, test counts as a small table: total/passed/failed/inconclusive, open issues count); " +
      "3. What this program does (from analysis.purpose, then analysis.capabilities as a bullet list); " +
      "4. Testing performed (languages/stack from analysis, types of tests run, limitations as a bullet list); " +
      "5. Issues found (each issue: severity badge, title, description, root cause, recommended fix — if status is resolved say so); " +
      "6. Proposed & applied fixes (each fix: explanation, files changed, risks); " +
      "7. Validation results (latest validation outcome if present). " +
      "Return ONLY valid JSON with a single key 'markdown' whose value is the complete Markdown string. " +
      "Keep the Markdown clean and readable. Do not add sections not listed above.";
    const schema =
      `{markdown:string (complete Markdown QA report, no commentary outside the JSON)}`;
    const slim = {
      project: report.project,
      status: report.status,
      generatedAt: report.generatedAt,
      counts: report.counts,
      message: report.message,
      analysis: report.analysis
        ? {
            purpose: (report.analysis as any).purpose,
            capabilities: (report.analysis as any).capabilities,
            languages: (report.analysis as any).languages,
            stack: (report.analysis as any).stack,
            summary: (report.analysis as any).summary,
            limitations: (report.analysis as any).limitations,
          }
        : null,
      issues: ((report.issues ?? []) as any[]).map((i: any) => ({
        id: i.id,
        severity: i.severity,
        category: i.category,
        title: i.title,
        description: i.description,
        rootCause: i.rootCause,
        recommendedFix: i.recommendedFix,
        fixExplanation: i.fixExplanation,
        risks: i.risks,
        status: i.status,
        affected: i.affected,
      })),
      fixes: ((report.fixes ?? []) as any[]).map((f: any) => ({
        id: f.id,
        issueId: f.issueId,
        status: f.status,
        explanation: f.explanation,
        risks: f.risks,
        files: f.files?.map((p: any) => p.path),
        approvedAt: f.approvedAt,
      })),
      limitations: report.limitations,
      latestValidation: report.latestValidation
        ? {
            time: (report.latestValidation as any).time,
            resolved: (report.latestValidation as any).resolved,
            regressions: (report.latestValidation as any).regressions,
            contractsUnchanged: (report.latestValidation as any)
              .contractsUnchanged,
            error: (report.latestValidation as any).error,
          }
        : null,
    };
    const result = await this.ai.ask(task, schema, slim, signal);
    if (typeof result?.markdown !== "string" || !result.markdown.trim())
      throw new Error("Bob did not return a valid Markdown report");
    return result.markdown;
  }

}
export function mutations(http: any[]) {
  const tests: any[] = [];
  const seen = new Set();
  for (const test of http)
    for (const step of test.steps) {
      if (
        !["POST", "PUT", "PATCH"].includes(step.method) ||
        !Object.hasOwn(step, "body") ||
        step.path.includes("{{") ||
        seen.has(step.method + step.path) ||
        tests.length >= 6
      )
        continue;
      seen.add(step.method + step.path);
      tests.push({
        id: "adversarial-" + tests.length,
        title:
          "Malformed and unexpected inputs: " + step.method + " " + step.path,
        intent:
          "Exercise malformed JSON, null, arrays, missing values, unexpected types and numeric boundaries. Detect unhandled HTTP 5xx responses.",
        expected:
          "Bad inputs are handled without an unhandled server error. Exact domain rejection status is not assumed.",
        basis: "assumption",
        category: "input-validation",
        steps: [
          {
            label: "Malformed JSON",
            method: step.method,
            path: step.path,
            headers: { "content-type": "application/json" },
            rawBody: '{"broken":',
            assertions: [{ kind: "not5xx" }],
          },
          ...[
            null,
            [],
            {},
            "unexpected",
            Object.fromEntries(
              Object.keys(step.body ?? {})
                .slice(0, 10)
                .map((k) => [k, -2147483649]),
            ),
          ].map((body, i) => ({
            label: "Unexpected input " + i,
            method: step.method,
            path: step.path,
            body,
            assertions: [{ kind: "not5xx" }],
          })),
        ],
      });
    }
  return tests;
}
