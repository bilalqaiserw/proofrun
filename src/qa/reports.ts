import { randomUUID } from "node:crypto";
import { short } from "./safety.ts";
export type Issue = {
  id: string;
  testId: string | null;
  severity: string;
  category: string;
  title: string;
  description: string;
  reproduction: any[];
  triggeringInput: any;
  executionContext: any;
  logs: string;
  stackTrace: string;
  expected: string;
  actual: any;
  rootCause: string;
  affected: { path: string; line: number | null; symbol: string | null }[];
  recommendedFix: string;
  fixExplanation: string;
  risks: string;
  basis: string;
  status: "open" | "resolved" | "regression" | "inconclusive";
  validation?: any;
};
export function issueFromResult(result: any, context: any): Issue {
  const failures =
    result.trace?.filter(
      (s: any) => s.error || s.assertions?.some((a: any) => !a.passed),
    ) ?? [];
  const crash =
    result.category === "runtime-crash" ||
    result.trace?.some((s: any) => s.response?.status >= 500);
  return {
    id: randomUUID(),
    testId: result.id,
    severity: crash ? "high" : "medium",
    category: result.category ?? "runtime",
    title: result.title,
    description:
      result.intent ?? "Execution did not match the test expectation.",
    reproduction:
      result.trace?.map((s: any, i: number) => ({
        step: i + 1,
        action: s.label ?? s.action,
        request: s.request ?? null,
        response: s.response ?? null,
        error: s.error ?? null,
      })) ?? [],
    triggeringInput: failures.map((s: any) => s.request ?? s.action),
    executionContext: context,
    logs: short(result.logs, 30000),
    stackTrace: short(
      result.errors?.map((e: any) => e.stack ?? e.message).join("\n"),
      20000,
    ),
    expected:
      result.expected ?? "Execution completes without an unhandled failure",
    actual: failures.length ? failures : (result.errors ?? result),
    rootCause:
      "Not yet established. Bob can investigate the captured evidence.",
    affected: [],
    recommendedFix: "Generate a proposed repair from the evidence.",
    fixExplanation: "Pending evidence-based analysis.",
    risks:
      "A passing test covers its observed behavior only; other defects may remain.",
    basis: result.basis ?? "observed execution",
    status: result.outcome === "inconclusive" ? "inconclusive" : "open",
  };
}
export function commandIssue(phase: string, result: any): Issue {
  const logs = (result.stdout + "\n" + result.stderr).slice(-30000);
  const missing =
    /exec: "([^"]+)": executable file not found|(?:^|\n)([a-z0-9_-]+): (?:command )?not found/i.exec(
      logs,
    );
  const diskFull = /ENOSPC|no space left on device/i.test(logs);
  const environment = missing || diskFull || phase === "environment setup";
  return {
    id: randomUUID(),
    testId: null,
    severity: "high",
    category: environment ? "environment" : phase,
    title: missing
      ? `${missing[1] || missing[2]} is missing from the test environment`
      : diskFull
        ? "Test environment storage limit reached"
        : `${result.label || phase} ${result.timedOut ? "did not finish" : "failed"}`,
    description: missing
      ? "The required executable could not be started in the isolated environment."
      : diskFull
        ? "Dependency installation or execution exceeded the isolated environment's storage capacity."
        : result.timedOut
          ? `The command exceeded its ${result.timeoutSeconds || Math.round(result.durationMs / 1000)}-second limit. This check is incomplete; a timeout alone does not prove a source-code defect.`
          : result.exitCode === null
            ? "The command stopped without an exit status. Inspect the execution logs."
            : `Command exited with status ${result.exitCode}.`,
    reproduction: [{ argv: result.argv, phase }],
    triggeringInput: result.argv,
    executionContext: {
      phase,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      cwd: result.cwd ?? ".",
      timeoutSeconds: result.timeoutSeconds ?? null,
    },
    logs,
    stackTrace: logs,
    expected: "Command exits with status 0 within its time limit",
    actual: { exitCode: result.exitCode, timedOut: result.timedOut },
    rootCause: missing
      ? `The runtime reported that ${missing[1] || missing[2]} is absent from PATH.`
      : diskFull
        ? "The operating system reported no space left on device in the sandbox."
        : "Inspect the captured command output and relevant source.",
    affected: [],
    recommendedFix: environment
      ? "Provision the required tool or sufficient bounded storage, then rerun the unchanged checks."
      : "Generate a proposed repair.",
    fixExplanation: "Pending investigation.",
    risks: "Dependency or configuration changes can affect other components.",
    basis: "observed execution",
    status: result.timedOut ? "inconclusive" : "open",
  };
}
export function operationIssue(phase: string, error: any, logs = ""): Issue {
  const message = short(error.message, 12000);
  const startup = ["APPLICATION_NOT_READY", "APPLICATION_CRASH"].includes(
    error.code,
  );
  const reasoning = ["analyzing", "generating-tests", "diagnosing"].includes(
    phase,
  );
  const issue = commandIssue(phase, {
    ...error.command,
    argv: error.command?.argv ?? [],
    stdout: logs || error.logs || "",
    stderr: message,
    exitCode: error.exitCode ?? null,
    timedOut: false,
    durationMs: 0,
    timeoutSeconds: error.timeoutSeconds,
  });
  issue.title = reasoning
    ? "Bob analysis could not finish"
    : error.code === "APPLICATION_CRASH"
      ? "Application exited before it was ready"
      : startup
        ? "Application did not become reachable"
        : "Test environment could not be prepared";
  issue.category = reasoning
    ? "reasoning"
    : error.code === "APPLICATION_CRASH"
      ? "runtime-crash"
      : "environment";
  issue.status = error.code === "APPLICATION_CRASH" ? "open" : "inconclusive";
  issue.description = message;
  issue.expected = reasoning
    ? "Bob returns a complete, validated analysis"
    : startup
      ? "The application listens on its planned port before tests run"
      : "An isolated test environment is ready for execution";
  issue.actual = { error: message, exitCode: error.exitCode ?? null };
  issue.rootCause = reasoning
    ? "The reasoning response could not be completed or validated. This does not establish an application defect."
    : startup
      ? "The configured start command did not produce a reachable application. The captured output below contains the startup evidence."
      : "Environment preparation failed. The captured Docker/tool output identifies the failing operation.";
  issue.recommendedFix = reasoning
    ? "Retry Bob analysis; the captured execution evidence is preserved."
    : startup
      ? "Check the start command and port against the application's logs, then rerun testing."
      : "Correct the reported environment requirement and rerun the unchanged checks.";
  issue.fixExplanation =
    "No source change has been applied. Checks that did not execute remain incomplete.";
  return issue;
}
export function enrich(issue: Issue, value: any, knownPaths: Set<string>) {
  if (!value || typeof value !== "object") return;
  if (["critical", "high", "medium", "low", "info"].includes(value.severity))
    issue.severity = value.severity;
  for (const key of [
    "rootCause",
    "recommendedFix",
    "fixExplanation",
    "risks",
    "description",
  ] as const)
    if (typeof value[key] === "string" && value[key].length < 12000)
      issue[key] = value[key];
  if (Array.isArray(value.affected))
    issue.affected = value.affected
      .filter((x: any) => knownPaths.has(x.path))
      .slice(0, 12)
      .map((x: any) => ({
        path: x.path,
        line: Number.isInteger(x.line) && x.line > 0 ? x.line : null,
        symbol: typeof x.symbol === "string" ? x.symbol.slice(0, 200) : null,
      }));
}
export function finalReport(job: any) {
  const latest = job.validations?.at(-1),
    current = latest?.results ?? job.results ?? [];
  return {
    version: 1,
    project: {
      id: job.id,
      name: job.name,
      snapshot: job.snapshot,
      currentSnapshot:
        job.currentSnapshot ?? latest?.sourceSnapshot ?? job.snapshot,
    },
    status: job.phase,
    generatedAt: new Date().toISOString(),
    analysis: job.plan ?? null,
    message: job.message,
    setup: job.setup ?? null,
    commands: job.commandRuns ?? [],
    tests: job.tests ?? null,
    results: job.results ?? [],
    issues: job.issues ?? [],
    analysisWarnings: job.analysisWarnings ?? [],
    reasoningRuns: job.reasoningRuns ?? [],
    fixes: job.fixes ?? [],
    validations: job.validations ?? [],
    limitations: [
      ...(job.plan?.limitations ?? []),
      ...(job.tests?.limitations ?? []),
      ...(job.coverage ?? []),
      "AI-inferred expectations can be wrong; assumptions are labelled. This is measured coverage, not a guarantee of all defects.",
      "Linux containers do not emulate proprietary hardware, native Windows/macOS UI or unavailable external services.",
    ],
    counts: {
      tests: current.length,
      passed: current.filter((r: any) => r.outcome === "passed").length,
      failed: current.filter((r: any) => r.outcome === "failed").length,
      inconclusive: current.filter((r: any) => r.outcome === "inconclusive")
        .length,
      openIssues:
        job.issues?.filter((i: any) => i.status !== "resolved").length ?? 0,
    },
    latestValidation: latest ?? null,
  };
}
