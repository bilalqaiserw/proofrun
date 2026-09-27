import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { QAEngine } from "./qa/engine.ts";
import { inside, redact, redactValue } from "./qa/safety.ts";
import { finalReport } from "./qa/reports.ts";
import { exportZip, importZip } from "./qa/zip.ts";
import { PROJECT_LIMITS } from "../public/project-limits.js";
import { ownWorkspaceStore } from "./qa/service-lock.ts";
const root = fileURLToPath(new URL("../public/", import.meta.url));
export async function createApp(engine = new QAEngine()) {
  await engine.init();
  const assets: Record<string, [string, string]> = {
    "/": ["workbench.html", "text/html; charset=utf-8"],
    "/workbench.js": ["workbench.js", "text/javascript; charset=utf-8"],
    "/languages.js": ["languages.js", "text/javascript; charset=utf-8"],
    "/project-limits.js": [
      "project-limits.js",
      "text/javascript; charset=utf-8",
    ],
    "/styles.css": ["styles.css", "text/css; charset=utf-8"],
    "/workbench.css": ["workbench.css", "text/css; charset=utf-8"],
    "/favicon.svg": ["favicon.svg", "image/svg+xml"],
  };
  const server = createServer(async (req, res) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "same-origin");
    res.setHeader("cache-control", "no-store");
    res.setHeader(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    const json = (value: any, status = 200) => {
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(redactValue(value)));
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      if (path === "/healthz") return json({ ok: true });
      if (path.startsWith("/api/qa/")) {
        // Loopback API with CSRF protection; never expose a Docker controller publicly.
        const host = req.headers.host ?? "";
        const origin = req.headers.origin;
        const allowedHost = /^(localhost|127\.0\.0\.1):\d+$/.test(host);
        if (
          !allowedHost ||
          (origin && origin !== "http://" + host) ||
          req.headers["sec-fetch-site"] === "cross-site" ||
          req.headers["x-proofrun"] !== "1"
        )
          throw new Error("Same-origin ProofRun workspace request required");
        let body: any = {};
        if (["POST", "PUT", "PATCH"].includes(req.method ?? "")) {
          let bytes = 0;
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            bytes += chunk.length;
            if (bytes > PROJECT_LIMITS.maxRequestBytes)
              throw new Error(
                "Upload exceeds 180 MB transport limit (128 MB project data)",
              );
            chunks.push(chunk);
          }
          try {
            body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
          } catch {
            throw new Error("Request body is not valid JSON");
          }
        }
        if (path === "/api/qa/status" && req.method === "GET")
          return json(await engine.status());
        if (path === "/api/qa/projects" && req.method === "GET")
          return json({
            projects: [...engine.jobs.values()].map((j) => ({
              id: j.id,
              name: j.name,
              phase: j.phase,
              createdAt: j.createdAt,
              issues: j.issues.filter((i: any) => i.status !== "resolved")
                .length,
            })),
          });
        if (path === "/api/qa/projects" && req.method === "DELETE")
          return json(await engine.clearProjects());
        if (path === "/api/qa/projects" && req.method === "POST") {
          if (body.zip) {
            if (
              typeof body.zip !== "string" ||
              body.zip.length >
                Math.ceil(PROJECT_LIMITS.maxProjectBytes / 3) * 4
            )
              throw new Error("ZIP exceeds upload limit");
            body.files = importZip(Buffer.from(body.zip, "base64"));
          }
          return json(await engine.create(body), 201);
        }
        const match = /^\/api\/qa\/projects\/([0-9a-f-]{36})(?:\/(.*))?$/.exec(
          path,
        );
        if (!match) throw new Error("Unknown workspace endpoint");
        const id = match[1],
          action = match[2] ?? "",
          job = engine.get(id);
        if (req.method === "GET") {
          if (!action) return json(engine.public(job));
          if (action === "report") return json(finalReport(job));
          if (action === "report-md") {
            const markdown = await engine.generateMarkdownReport(id);
            const filename = `proofrun-report-${job.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.md`;
            res.writeHead(200, {
              "content-type": "text/markdown; charset=utf-8",
              "content-disposition": `attachment; filename="${filename}"`,
            });
            return res.end(markdown);
          }
          if (action === "source") {
            const relative = url.searchParams.get("path") ?? "";
            if (
              !job.inventory.some((f: any) => f.path === relative) &&
              !job.fixes.some((f: any) =>
                f.files.some((p: any) => p.path === relative),
              )
            )
              throw new Error("Source file not in project");
            if (job.inventory.find((f: any) => f.path === relative)?.binary)
              throw new Error(
                "Binary assets cannot be previewed as source. Download the working copy to inspect this file.",
              );
            return json({
              path: relative,
              content: (
                await readFile(inside(job.root, relative), "utf8")
              ).slice(0, 180000),
            });
          }
          if (action === "download") {
            const archive = await exportZip(job.root);
            res.writeHead(200, {
              "content-type": "application/zip",
              "content-disposition":
                'attachment; filename="proofrun-project.zip"',
            });
            return res.end(archive);
          }
          if (action.startsWith("artifact/")) {
            const name = action.slice(9);
            if (!/^[a-z0-9-]+\.png$/.test(name))
              throw new Error("Invalid artifact");
            let data;
            try {
              data = await readFile(
                inside(resolve(engine.root, id, "artifacts"), name),
              );
            } catch (error: any) {
              if (error.code === "ENOENT")
                throw new Error(
                  "This older run did not save its screenshot. Rerun the unchanged checks to capture fresh browser evidence.",
                );
              throw error;
            }
            res.writeHead(200, { "content-type": "image/png" });
            return res.end(data);
          }
        }
        if (req.method === "POST") {
          if (action === "start") return json(await engine.start(id));
          if (action === "resume") return json(await engine.resume(id));
          if (action === "cancel") return json(await engine.cancel(id));
          if (action === "retest") return json(await engine.retest(id));
          if (action === "fixes/approve") return json(await engine.approveFixes(id, body));
          if (action === "fixes/generate") return json(await engine.generateFix(id));
          const issue = /^issues\/([0-9a-f-]{36})\/fix$/.exec(action);
          if (issue) return json(await engine.generateFix(id, issue[1]));
          const fix = /^fixes\/([0-9a-f-]{36})\/(approve|reject|edit)$/.exec(
            action,
          );
          if (fix) {
            if (fix[2] === "approve")
              return json(await engine.approveFix(id, fix[1], body));
            if (fix[2] === "reject")
              return json(await engine.rejectFix(id, fix[1]));
            return json(await engine.editFix(id, fix[1], body));
          }
        }
        throw new Error("Unsupported workspace request");
      }
      const asset = assets[path];
      if (!asset || req.method !== "GET") {
        res.writeHead(404, { "content-type": "text/plain" });
        return res.end("Not found");
      }
      res.writeHead(200, { "content-type": asset[1] });
      res.end(await readFile(resolve(root, asset[0])));
    } catch (error: any) {
      json({ error: redact(error.message) }, 400);
    }
  });
  return { server, engine };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error("PORT must be an integer between 1 and 65535.");
    process.exit(1);
  }
  const engine = new QAEngine();
  let ownership;
  try {
    ownership = await ownWorkspaceStore(engine.root, port);
  } catch (error: any) {
    console.error(error.message);
    process.exit(1);
  }
  const { server } = await createApp(engine);
  server.once("error", async (error: any) => {
    console.error(
      error.code === "EADDRINUSE"
        ? `Port ${port} is already in use. Open http://localhost:${port} if ProofRun is running, or choose a free PORT in .env.`
        : `ProofRun could not start: ${error.message}`,
    );
    await ownership.close();
    process.exit(1);
  });
  server.listen(port, "127.0.0.1", () =>
    console.log(`ProofRun workspace: http://localhost:${port}`),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      for (const controller of engine.active.values()) controller.abort();
      server.close();
      const timer = setTimeout(() => process.exit(1), 45000);
      timer.unref();
      const wait = setInterval(() => {
        if (!engine.active.size) {
          clearInterval(wait);
          clearTimeout(timer);
          process.exit(0);
        }
      }, 250);
    });
}
