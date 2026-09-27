import { safePath } from "./safety.ts";
export const IMAGES: Record<string, string> = {
  node: "node:24-bookworm",
  node22: "node:22-bookworm",
  python: "python:3.12-bookworm",
  go: "golang:1.24-bookworm",
  rust: "rust:1-bookworm",
  java: "maven:3.9-eclipse-temurin-21",
  dotnet: "mcr.microsoft.com/dotnet/sdk:8.0",
  ruby: "ruby:3.3-bookworm",
  php: "composer:2",
  cpp: "gcc:14-bookworm",
  linux: "debian:bookworm",
};
if (process.env.PROOFRUN_RUNTIME_IMAGES) {
  const custom = JSON.parse(process.env.PROOFRUN_RUNTIME_IMAGES);
  if (
    !custom ||
    typeof custom !== "object" ||
    Array.isArray(custom) ||
    Object.keys(custom).length > 20
  )
    throw new Error(
      "PROOFRUN_RUNTIME_IMAGES must map at most 20 trusted runtime names to images",
    );
  for (const [name, image] of Object.entries(custom)) {
    if (
      !/^[a-z][a-z0-9-]{0,30}$/.test(name) ||
      typeof image !== "string" ||
      image.length > 200 ||
      !/^[a-z0-9][a-z0-9./:_@-]+$/.test(image)
    )
      throw new Error("Invalid trusted runtime image");
    IMAGES[name] = image;
  }
}
export type Command = {
  label: string;
  argv: string[];
  cwd: string;
  timeoutSeconds: number;
  requiresServer?: boolean;
};
export type Plan = {
  summary: string;
  purpose?: string;
  capabilities?: string[];
  languages?: { name: string; role: string }[];
  stack: string[];
  runtime: string;
  install: Command[];
  build: Command[];
  checks: Command[];
  start: Command | null;
  port: number | null;
  env: Record<string, string>;
  services: { kind: "postgres" | "mysql" | "redis"; name: string }[];
  limitations: string[];
  assumptions: string[];
};
function text(value: any, max = 1000) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(
      `Invalid plan text: expected a nonempty string of at most ${max} characters; received ${typeof value === "string" ? value.length + " characters" : typeof value}`,
    );
  return value;
}
export function command(value: any): Command {
  if (
    !value ||
    !Array.isArray(value.argv) ||
    value.argv.length < 1 ||
    value.argv.length > 80 ||
    value.argv.some(
      (v: any) =>
        typeof v !== "string" || v.length > 6000 || /[\x00\r\n]/.test(v),
    )
  )
    throw new Error("Commands require a bounded argv array");
  const cwd = value.cwd ?? ".";
  if (cwd !== ".") safePath(cwd);
  if (value.argv[0].startsWith("-")) throw new Error("Invalid executable");
  return {
    // A missing display label must not invalidate an otherwise safe command.
    // Executable argv, cwd and resource limits still undergo strict validation.
    label:
      value.label == null || value.label === ""
        ? ("Run " + value.argv.slice(0, 3).join(" ")).slice(0, 150)
        : text(value.label, 150),
    argv: value.argv,
    cwd,
    requiresServer: value.requiresServer === true,
    timeoutSeconds: Math.min(
      600,
      Math.max(5, Number(value.timeoutSeconds) || 120),
    ),
  };
}
export function validatePlan(value: any): Plan {
  if (
    !value ||
    !Object.hasOwn(IMAGES, value.runtime) ||
    !Array.isArray(value.stack) ||
    value.stack.some((s: any) => typeof s !== "string")
  )
    throw new Error(
      "Choose an available runtime; do not invent container images",
    );
  const list = (name: string) => {
    if (!Array.isArray(value[name]) || value[name].length > 12)
      throw new Error("Use at most 12 commands per phase");
    return value[name].map((value: any) => {
      const parsed = command(value);
      // Container builds can include native compilation and nested workspace builds.
      // A larger deadline never delays a command that finishes sooner.
      if (name === "checks") parsed.timeoutSeconds = 600;
      if (name === "build")
        parsed.timeoutSeconds = Math.max(300, parsed.timeoutSeconds);
      return parsed;
    });
  };
  const port = value.port == null ? null : Number(value.port);
  if (port !== null && (!Number.isInteger(port) || port < 1024 || port > 65535))
    throw new Error("Application port must be 1024–65535");
  const env = value.env ?? {};
  if (
    !env ||
    typeof env !== "object" ||
    Array.isArray(env) ||
    Object.keys(env).length > 30 ||
    Object.entries(env).some(
      ([k, v]) =>
        !/^[A-Z][A-Z0-9_]{0,60}$/.test(k) ||
        typeof v !== "string" ||
        v.length > 2000 ||
        /DOCKER|PROXY|^BOB|^PROOFRUN/i.test(k) ||
        (/KEY|TOKEN|SECRET/i.test(k) &&
          !/^(proofrun-test-|qa$)/.test(v as string)) ||
        (!!process.env.BOBSHELL_API_KEY &&
          (v as string).includes(process.env.BOBSHELL_API_KEY)),
    )
  )
    throw new Error("Only bounded synthetic environment values are allowed");
  if (
    !Array.isArray(value.services) ||
    value.services.length > 3 ||
    value.services.some(
      (s: any) =>
        !["postgres", "mysql", "redis"].includes(s.kind) ||
        !/^[a-z][a-z0-9-]{0,25}$/.test(s.name) ||
        ["app", "proxy"].includes(s.name),
    ) ||
    new Set(value.services.map((s: any) => s.name)).size !==
      value.services.length
  )
    throw new Error(
      "Use at most three distinct disposable PostgreSQL, MySQL or Redis services",
    );
  return {
    summary: text(value.summary, 6000),
    ...(typeof value.purpose === "string"
      ? { purpose: text(value.purpose, 2000) }
      : {}),
    ...(Array.isArray(value.capabilities)
      ? {
          capabilities: value.capabilities
            .slice(0, 6)
            .map((s: any) => text(s, 300)),
        }
      : {}),
    ...(Array.isArray(value.languages)
      ? {
          languages: value.languages
            .slice(0, 20)
            .filter(
              (s: any) => s && typeof (s.name ?? s.language ?? s) === "string",
            )
            .map((s: any) => ({
              name: text(s.name ?? s.language ?? s, 120),
              role:
                typeof (s.role ?? s.description) === "string" &&
                (s.role ?? s.description).trim()
                  ? text(s.role ?? s.description, 1000)
                  : "Role not established from the current source context.",
            })),
        }
      : {}),
    stack: value.stack,
    runtime: value.runtime,
    install: list("install"),
    build: list("build"),
    checks: list("checks"),
    start: value.start ? command(value.start) : null,
    port,
    env,
    services: value.services,
    limitations: Array.isArray(value.limitations)
      ? value.limitations.map((s: any) => text(s, 4000))
      : [],
    assumptions: Array.isArray(value.assumptions)
      ? value.assumptions.map((s: any) => text(s, 4000))
      : [],
  };
}
export type HttpTest = {
  id: string;
  title: string;
  intent: string;
  expected: string;
  basis: "documented" | "assumption";
  category: string;
  steps: any[];
};
export type TestPlan = {
  http: HttpTest[];
  browser: any[];
  commands: Command[];
  limitations: string[];
};
export function browserInputTypes(
  excerpts: any[] = [],
): Record<string, string> {
  const found = new Map<string, Set<string>>();
  for (const file of excerpts) {
    if (!/\.(?:html?|jsx|tsx|vue|svelte)$/i.test(file.path)) continue;
    for (const tag of file.content.matchAll(/<input\b[^>]*>/gi)) {
      const attribute = (name: string) => {
        const match = tag[0].match(
          new RegExp(
            `\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
            "i",
          ),
        );
        return match ? (match[1] ?? match[2] ?? match[3]) : null;
      };
      const id = attribute("id"),
        type = attribute("type")?.toLowerCase();
      if (!id || !/^[a-z_][a-z0-9_-]*$/i.test(id) || !type) continue;
      const types = found.get("#" + id) ?? new Set<string>();
      types.add(type);
      found.set("#" + id, types);
    }
  }
  // Ambiguous/dynamic controls require runtime evidence; do not guess their type.
  return Object.fromEntries(
    [...found]
      .filter(([, types]) => types.size === 1)
      .map(([selector, types]) => [selector, [...types][0]]),
  );
}
export function browserRequiredInputs(excerpts: any[] = []): string[] {
  const required = new Set<string>();
  for (const file of excerpts) {
    if (!/\.html?$/i.test(file.path)) continue;
    for (const [tag] of file.content.matchAll(/<input\b[^>]*>/gi)) {
      const id = tag.match(/\sid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const value = id && (id[1] ?? id[2] ?? id[3]);
      if (
        value &&
        /^[a-z_][a-z0-9_-]*$/i.test(value) &&
        /\srequired(?:\s|=|>)/i.test(tag)
      )
        required.add("#" + value);
    }
  }
  return [...required];
}
export function validateTests(
  value: any,
  inputTypes: Record<string, string> = {},
  requiredInputs: string[] = [],
): TestPlan {
  if (
    !value ||
    !Array.isArray(value.http) ||
    value.http.length > 30 ||
    !Array.isArray(value.browser) ||
    value.browser.length > 10 ||
    !Array.isArray(value.commands) ||
    value.commands.length > 15
  )
    throw new Error("Invalid generated test plan");
  value = structuredClone(value);
  // Translate equivalent declarative vocabulary without dropping an action or
  // assertion. Arbitrary evaluate/scripts and external navigation stay rejected.
  const browserAliases: Record<string, string> = {
    navigate: "goto",
    assertText: "text",
    assertTextContains: "text",
    waitForText: "text",
    expectText: "text",
    assert_text: "text",
    assertVisible: "visible",
    expectVisible: "visible",
    assert_visible: "visible",
    waitForSelector: "visible",
    pressKey: "press",
    clear: "fill",
  };
  for (const test of value.browser)
    if (Array.isArray(test?.steps))
      for (const step of test.steps) {
        if (!step || !Object.hasOwn(browserAliases, step.action)) continue;
        if (step.action === "clear") step.value = "";
        step.action = browserAliases[step.action];
        if (step.action === "goto" && step.path == null) step.path = step.url;
        if (step.action === "text" && step.value == null)
          step.value = step.text;
        if (step.action === "press" && step.value == null)
          step.value = step.key;
      }
  const ids = new Set<string>();
  for (const test of [...value.http, ...value.browser]) {
    if (
      !test ||
      !/^[a-z0-9-]{1,80}$/.test(test.id) ||
      /^(existing-|command-|adversarial-)/.test(test.id) ||
      ids.has(test.id)
    )
      throw new Error(
        "Tests require unique IDs outside reserved runner prefixes",
      );
    ids.add(test.id);
    text(test.title, 200);
    text(test.intent, 1200);
    text(test.expected, 2000);
    if (!["documented", "assumption"].includes(test.basis))
      throw new Error("Tests must mark documented expectations or assumptions");
    if (
      !Array.isArray(test.steps) ||
      test.steps.length < 1 ||
      test.steps.length > 40
    )
      throw new Error("Use 1–40 steps per test");
  }
  for (const test of value.http)
    for (const step of test.steps) {
      if (
        !step ||
        !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(
          step.method,
        ) ||
        typeof step.path !== "string" ||
        !step.path.startsWith("/") ||
        step.path.startsWith("//") ||
        /[\\#\r\n]/.test(step.path) ||
        step.path.length > 1000
      )
        throw new Error("HTTP tests must target relative application paths");
      if (step.label == null || step.label === "")
        step.label = (step.method + " " + step.path).slice(0, 200);
      text(step.label, 200);
      if (
        step.method === "HEAD" &&
        step.assertions?.some((a: any) => ["json", "contains"].includes(a.kind))
      )
        throw new Error(
          "HEAD responses have no body; test headers or status instead",
        );
      if (
        /content-type|response headers?/i.test(step.label) &&
        step.assertions?.some(
          (a: any) => a.kind === "contains" && /^application\//.test(a.value),
        )
      )
        throw new Error(
          "Content-Type assertions must use kind:header, name:content-type; contains checks only the body",
        );
      if (
        step.headers &&
        Object.entries(step.headers).some(
          ([k, v]) =>
            typeof v !== "string" ||
            /[\r\n]/.test(String(v)) ||
            !/^[a-z0-9-]+$/i.test(k) ||
            /^(host|connection|transfer-encoding|content-length)$/i.test(k),
        )
      )
        throw new Error("Invalid test headers");
      if (
        !Array.isArray(step.assertions) ||
        !step.assertions.length ||
        step.assertions.length > 20
      )
        throw new Error("Every HTTP step needs assertions");
      for (const a of step.assertions)
        if (
          ![
            "status",
            "not5xx",
            "json",
            "header",
            "contains",
            "notContains",
          ].includes(a.kind) ||
          (a.kind === "header" &&
            (typeof a.name !== "string" ||
              !/^[a-z0-9-]+$/i.test(a.name) ||
              typeof a.equals !== "string")) ||
          (a.kind === "json" &&
            (typeof a.path !== "string" ||
              a.path
                .split(".")
                .some((p: string) =>
                  ["__proto__", "prototype", "constructor"].includes(p),
                )))
        )
          throw new Error("Unsupported HTTP assertion");
    }
  for (const test of value.browser)
    for (const step of test.steps) {
      if (
        ![
          "goto",
          "click",
          "fill",
          "press",
          "text",
          "visible",
          "invalid",
        ].includes(step.action)
      )
        throw new Error(
          `Unsupported browser action ${String(step?.action)}. Use goto, click, fill, press, text, visible or invalid; scripts/evaluate are prohibited`,
        );
      if (
        step.action === "goto" &&
        (typeof step.path !== "string" ||
          !step.path.startsWith("/") ||
          step.path.startsWith("//") ||
          /[\\\r\n]/.test(step.path))
      )
        throw new Error("Browser navigation must stay within the application");
      if (step.action !== "goto") text(step.selector, 500);
      if (step.action === "fill") {
        if (typeof step.value !== "string" || step.value.length > 2000)
          throw new Error(
            "Browser fill requires a string of at most 2000 characters, including empty input",
          );
        if (
          inputTypes[step.selector] === "number" &&
          step.value !== "" &&
          (!/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(step.value) ||
            !Number.isFinite(Number(step.value)))
        )
          throw new Error(
            `Browser selector ${step.selector} is a numeric input in the supplied source; fill ${JSON.stringify(step.value)} cannot execute. Test malformed types through HTTP, and use source-documented numeric/empty edge cases for the browser error flow.`,
          );
      } else if (step.action === "press" || step.action === "text")
        text(step.value, 2000);
    }
  for (const test of value.browser)
    for (const [index, step] of test.steps.entries()) {
      if (
        step.action !== "fill" ||
        step.value !== "" ||
        !requiredInputs.includes(step.selector)
      )
        continue;
      const subsequent = test.steps.slice(index + 1);
      if (
        subsequent.some(
          (s: any) =>
            s.action === "fill" &&
            s.selector === step.selector &&
            s.value !== "",
        )
      )
        continue;
      if (
        !subsequent.some(
          (s: any) => s.action === "click" || s.action === "press",
        )
      )
        continue;
      if (
        !subsequent.some(
          (s: any) => s.action === "invalid" && s.selector === step.selector,
        )
      )
        throw new Error(
          `Required input ${step.selector} was cleared before submission. Native browser validation blocks the request. Assert {action:'invalid',selector:'${step.selector}'} rather than expecting a new API error region. Keep missing-value API requests in HTTP tests.`,
        );
    }
  if (JSON.stringify(value).length > 180_000)
    throw new Error("Generated tests exceed 180 KB");
  return {
    http: value.http,
    browser: value.browser,
    commands: value.commands.map(command),
    limitations: Array.isArray(value.limitations)
      ? value.limitations.slice(0, 30)
      : [],
  };
}
