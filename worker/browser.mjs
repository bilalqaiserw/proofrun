import { chromium } from "playwright";
import { readFile, mkdir } from "node:fs/promises";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const { base, test } = JSON.parse(input);
const browser = await chromium.launch({
  headless: true,
  args: ["--disable-dev-shm-usage"],
});
const context = await browser.newContext();
const page = await context.newPage();
const observations = [],
  errors = [],
  requests = [],
  network = [],
  trace = [];
let activeAction = null;
await context.route("**/*", (route) => {
  const u = new URL(route.request().url());
  return u.origin === new URL(base).origin ||
    u.protocol === "data:" ||
    u.protocol === "blob:"
    ? route.continue()
    : route.abort("blockedbyclient");
});
page.on("pageerror", (error) =>
  errors.push({
    kind: "exception",
    action: activeAction,
    message: error.message,
    stack: error.stack,
  }),
);
page.on("console", (msg) => {
  if (msg.type() !== "error") return;
  const entry = {
    kind: "console",
    action: activeAction,
    message: msg.text(),
    location: msg.location(),
  };
  // Chromium's network console duplicates response/request events. A handled
  // validation 400 is evidence, not an unhandled JavaScript error. Real missing
  // assets, failed requests and 5xx responses are classified separately below.
  if (/^Failed to load resource:/i.test(entry.message))
    observations.push({ ...entry, kind: "network-console" });
  else errors.push(entry);
});
page.on("requestfailed", (request) =>
  requests.push({
    action: activeAction,
    url: request.url(),
    method: request.method(),
    input: request.postData()?.slice(0, 10000),
    error: request.failure()?.errorText,
  }),
);
page.on("response", (res) => {
  if (network.length < 200)
    network.push({
      action: activeAction,
      url: res.url(),
      method: res.request().method(),
      status: res.status(),
    });
  if (res.status() >= 400 && res.status() < 500) {
    const entry = {
      kind: "http",
      action: activeAction,
      url: res.url(),
      status: res.status(),
      resourceType: res.request().resourceType(),
    };
    if (["script", "stylesheet", "image", "font"].includes(entry.resourceType))
      errors.push({ ...entry, kind: "missing-resource" });
    else observations.push(entry);
  }
  if (res.status() >= 500)
    errors.push({
      kind: "http",
      action: activeAction,
      url: res.url(),
      status: res.status(),
    });
});
page.setDefaultTimeout(10000);
const started = Date.now();
await mkdir("/artifacts", { recursive: true });
for (const [index, step] of test.steps.entries()) {
  const entry = { action: step, error: null };
  activeAction = step;
  try {
    if (step.action === "goto") {
      const u = new URL(step.path, base);
      if (u.origin !== new URL(base).origin)
        throw new Error("External navigation rejected");
      await page.goto(u.href, {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });
    } else {
      const locator = page.locator(step.selector);
      if (step.action === "fill") await locator.fill(step.value);
      if (step.action === "click") await locator.click();
      if (step.action === "press") await locator.press(step.value);
      if (step.action === "visible")
        await locator.waitFor({ state: "visible" });
      if (step.action === "invalid") {
        const validation = await locator.evaluate((el) => ({
          valid: el.validity?.valid,
          willValidate: el.willValidate,
          message: el.validationMessage,
          value: el.value,
        }));
        entry.validation = validation;
        if (validation.valid !== false || validation.willValidate !== true)
          throw new Error(
            "Expected native browser validation to reject this field",
          );
      }
      if (step.action === "text") {
        await locator
          .filter({ hasText: step.value })
          .waitFor({ state: "attached" });
        const value = await locator.textContent();
        if (!value?.includes(step.value))
          throw new Error(`Expected text ${step.value}, got ${value}`);
      }
    }
  } catch (error) {
    entry.error = error.message;
  }
  trace.push(entry);
  if (entry.error) {
    await page.screenshot({
      path: `/artifacts/${test.id}-${index}.png`,
      fullPage: false,
    });
    break;
  }
}
await page.screenshot({
  path: `/artifacts/${test.id}-final.png`,
  fullPage: false,
});
const screenshotBytes = await readFile(`/artifacts/${test.id}-final.png`);
if (screenshotBytes.length > 1_000_000)
  throw new Error("Screenshot exceeded the 1 MB evidence limit");
const result = {
  id: test.id,
  title: test.title,
  intent: test.intent,
  expected: test.expected,
  basis: test.basis,
  category: "frontend",
  outcome:
    trace.some((s) => s.error) || errors.length || requests.length
      ? "failed"
      : "passed",
  trace,
  errors,
  observations,
  requests,
  network,
  durationMs: Date.now() - started,
  screenshot: `${test.id}-final.png`,
  screenshotBase64: screenshotBytes.toString("base64"),
  limitations: requests.some((r) => r.error?.includes("BLOCKED"))
    ? [
        "External requests are intentionally blocked; these integration dependencies were not exercised.",
      ]
    : [],
};
await browser.close();
console.log(JSON.stringify(result));
