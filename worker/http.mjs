import { isDeepStrictEqual } from "node:util";
import net from "node:net";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const { base, test, ready, readinessTimeoutMs } = JSON.parse(input);
if (ready) {
  const u = new URL(base);
  const check = () =>
    new Promise((resolve) => {
      const socket = net.connect(Number(u.port), u.hostname);
      socket.setTimeout(1500);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
      socket.once("timeout", () => {
        socket.destroy();
        resolve(false);
      });
    });
  const deadline =
    Date.now() + Math.min(60000, Math.max(0, Number(readinessTimeoutMs) || 0));
  let ok;
  do {
    ok = await check();
    if (ok || Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (true);
  console.log(JSON.stringify({ ready: ok }));
  process.exit(0);
}
const vars = new Map();
const trace = [];
const started = Date.now();
function substitute(v, path = false) {
  if (typeof v === "string") {
    const exact = /^\{\{([a-zA-Z0-9_]+)\}\}$/.exec(v);
    if (exact && !path) {
      if (!vars.has(exact[1]))
        throw new Error("Missing captured value " + exact[1]);
      return vars.get(exact[1]);
    }
    return v.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, k) => {
      if (!vars.has(k)) throw new Error("Missing captured value " + k);
      return path
        ? encodeURIComponent(String(vars.get(k)))
        : String(vars.get(k));
    });
  }
  if (Array.isArray(v)) return v.map((x) => substitute(x));
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, substitute(x)]),
    );
  return v;
}
function field(body, path) {
  let value = body;
  for (const p of path.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, p))
      return undefined;
    value = value[p];
  }
  return value;
}
for (const step of test.steps) {
  const entry = {
    label: step.label,
    request: null,
    response: null,
    assertions: [],
    error: null,
  };
  try {
    const path = substitute(step.path, true);
    const url = new URL(path, base);
    if (url.origin !== new URL(base).origin)
      throw new Error("Test attempted external navigation");
    const headers = substitute(step.headers ?? {});
    let body;
    if (Object.hasOwn(step, "rawBody")) body = substitute(step.rawBody);
    else if (Object.hasOwn(step, "body")) {
      body = JSON.stringify(substitute(step.body));
      headers["content-type"] ??= "application/json";
    }
    entry.request = { method: step.method, path, headers, body: body ?? null };
    const res = await fetch(url, {
      method: step.method,
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(12000),
    });
    const reader = res.body?.getReader();
    let size = 0;
    const chunks = [];
    if (reader)
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 524288) {
          await reader.cancel();
          throw new Error("Response exceeded 512 KB");
        }
        chunks.push(Buffer.from(value));
      }
    const text = Buffer.concat(chunks).toString();
    let json;
    try {
      json = JSON.parse(text);
    } catch {}
    entry.response = {
      status: res.status,
      headers: Object.fromEntries(res.headers),
      body: text.slice(0, 20000),
      truncated: text.length > 20000,
    };
    for (const assertion of step.assertions) {
      let actual,
        passed = false;
      const expected = substitute(
        Object.hasOwn(assertion, "equals") ? assertion.equals : assertion.value,
      );
      if (assertion.kind === "status") {
        actual = res.status;
        passed = actual === expected;
      }
      if (assertion.kind === "not5xx") {
        actual = res.status;
        passed = actual < 500;
      }
      if (assertion.kind === "json") {
        actual = field(json, assertion.path);
        passed = isDeepStrictEqual(actual, expected);
      }
      if (assertion.kind === "header") {
        actual = res.headers.get(assertion.name);
        passed = actual === expected;
      }
      if (assertion.kind === "contains") {
        actual = text.slice(0, 20000);
        passed = text.includes(expected);
      }
      if (assertion.kind === "notContains") {
        actual = text.slice(0, 20000);
        passed = !text.includes(expected);
      }
      entry.assertions.push({ ...assertion, actual: actual ?? null, passed });
    }
    for (const [name, path] of Object.entries(step.capture ?? {})) {
      const value = field(json, path);
      if (value === undefined) throw new Error("Capture not found: " + path);
      vars.set(name, value);
    }
  } catch (error) {
    entry.error = error.message;
  }
  trace.push(entry);
}
const failed = trace.reduce(
  (n, s) => n + s.assertions.filter((a) => !a.passed).length,
  0,
);
const incomplete = trace.filter((s) => s.error).length;
console.log(
  JSON.stringify({
    id: test.id,
    title: test.title,
    intent: test.intent,
    expected: test.expected,
    basis: test.basis,
    category: test.category,
    outcome: failed ? "failed" : incomplete ? "inconclusive" : "passed",
    trace,
    failedAssertions: failed,
    incomplete,
    durationMs: Date.now() - started,
  }),
);
