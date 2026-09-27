import { randomUUID } from "node:crypto";
import { resolve, dirname, delimiter, isAbsolute } from "node:path";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { launch, run, requireSuccess, type ProcessResult } from "./process.ts";
import { IMAGES, type Plan, type Command } from "./contracts.ts";
import { redact, hash } from "./safety.ts";
import { nodeToolchains } from "./toolchains.ts";

const worker = fileURLToPath(new URL("../../worker/", import.meta.url));
function dockerBinary() {
  if (process.platform === "win32") {
    for (const base of [
      process.env.LOCALAPPDATA &&
        resolve(process.env.LOCALAPPDATA, "Programs/DockerDesktop"),
      process.env.ProgramFiles &&
        resolve(process.env.ProgramFiles, "Docker/Docker"),
    ]) {
      if (!base) continue;
      const binary = resolve(base, "resources/bin/docker.exe");
      if (existsSync(binary)) return binary;
    }
  }
  return "docker";
}
function dockerEnv(binary: string) {
  const env = { ...process.env };
  if (isAbsolute(binary)) {
    const key =
      Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
    env[key] = dirname(binary) + delimiter + (env[key] || "");
  }
  return env;
}
const limits = [
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  // Vercel's threaded cgroup tree cannot delegate memory to nested containers.
  // Each visitor instead receives a Firecracker VM with hard 4 GiB memory and 2 vCPU caps.
  ...(process.env.PROOFRUN_CLOUD_VM === "1" ? [] : ["--memory", "1536m"]),
  ...(process.env.PROOFRUN_CLOUD_VM === "1" ? [] : ["--cpus", "2"]),
  "--pids-limit",
  "256",
  "--read-only",
  "--tmpfs",
  "/tmp:rw,nosuid,size=512m",
  "--ulimit",
  "nofile=1024:1024",
];
export interface Executor {
  status(): Promise<any>;
  open(plan: Plan, root: string, options: any): Promise<Session>;
}
export interface Session {
  command(command: Command, phase: string): Promise<ProcessResult>;
  start(): Promise<void>;
  probe(test: any): Promise<any>;
  browser(test: any): Promise<any>;
  close(): Promise<void>;
  runtimeLogs(): string;
  bootstrap?(): Promise<ProcessResult[]>;
  snapshot?(): Promise<PreparedEnvironment>;
}
export interface PreparedEnvironment {
  open(options: any): Promise<Session>;
  close(): Promise<void>;
}
export class DockerExecutor implements Executor {
  binary = process.env.PROOFRUN_DOCKER_BIN || dockerBinary();
  async status() {
    try {
      const result = await run(
        this.binary,
        ["info", "--format", "{{json .ServerVersion}}"],
        { timeout: 8000, maxBytes: 2000, env: dockerEnv(this.binary) },
      );
      return {
        available: result.exitCode === 0,
        version: result.stdout.trim(),
        detail:
          result.exitCode === 0
            ? "Docker engine ready"
            : "Start Docker Desktop with Linux containers",
      };
    } catch {
      return {
        available: false,
        detail:
          "Install and start Docker Desktop (Linux containers), or Docker Engine on Linux",
      };
    }
  }
  async open(plan: Plan, root: string, options: any) {
    const status = await this.status();
    if (!status.available) throw new Error(status.detail);
    const session = new DockerSession(this.binary, plan, root, options);
    try {
      await session.prepare();
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }
}
class DockerSession implements Session {
  prefix = "proofrun-" + randomUUID().slice(0, 12);
  containers: string[] = [];
  networks: string[] = [];
  volumes: string[] = [];
  appName = "";
  proxyName = "";
  app: any = null;
  appExit: ProcessResult | null = null;
  logs = "";
  closing = false;
  binary: string;
  plan: Plan;
  root: string;
  options: any;
  constructor(binary: string, plan: Plan, root: string, options: any) {
    this.binary = binary;
    this.plan = plan;
    this.root = root;
    this.options = options;
  }
  async docker(args: string[], extra: any = {}) {
    if (["create", "run"].includes(args[0]))
      args = [
        args[0],
        "--label",
        "proofrun.managed=true",
        "--log-driver",
        "local",
        "--log-opt",
        "max-size=10m",
        "--log-opt",
        "max-file=1",
        "--log-opt",
        "compress=false",
        ...(process.env.PROOFRUN_CONTAINER_CA ? [
          "--mount", "type=bind,source=" + process.env.PROOFRUN_CONTAINER_CA + ",target=/proofrun-ca.pem,readonly",
          "-e", "NODE_EXTRA_CA_CERTS=/proofrun-ca.pem",
          "-e", "REQUESTS_CA_BUNDLE=/proofrun-ca.pem",
          "-e", "SSL_CERT_FILE=/proofrun-ca.pem",
        ] : []),
        ...args.slice(1),
      ];
    return requireSuccess(this.binary, args, {
      env: dockerEnv(this.binary),
      timeout: 120000,
      signal: this.options.signal,
      ...extra,
    });
  }
  record(stream: string, text: string) {
    this.logs = (this.logs + `[${stream}] ${redact(text)}`).slice(-300000);
    this.options.onLog?.(stream, text);
  }
  environment() {
    return {
      HOME: "/tmp",
      CI: "true",
      PYTHONDONTWRITEBYTECODE: "1",
      ...this.plan.env,
      HTTP_PROXY: "http://proxy:3128",
      HTTPS_PROXY: "http://proxy:3128",
      http_proxy: "http://proxy:3128",
      https_proxy: "http://proxy:3128",
      NO_PROXY:
        "localhost,127.0.0.1,app," +
        this.plan.services.map((s) => s.name).join(","),
      npm_config_proxy: "http://proxy:3128",
      npm_config_https_proxy: "http://proxy:3128",
      ...(/^node(?:\d+)?$/.test(this.plan.runtime)
        ? {
            PATH: "/tmp/proofrun-tools/node_modules/.bin:/tmp/proofrun-tools/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            npm_config_nodedir: "/usr/local",
            // Match test worker counts to this container's two-CPU quota.
            // Support both Vitest 3 pool variables and Vitest 4 worker variables.
            VITEST_MAX_THREADS: "2",
            VITEST_MIN_THREADS: "1",
            VITEST_MAX_FORKS: "2",
            VITEST_MIN_FORKS: "1",
            VITEST_MAX_WORKERS: "2",
            VITEST_MIN_WORKERS: "1",
            npm_config_store_dir: "/workspace/.proofrun-cache/pnpm",
            npm_config_cache: "/workspace/.proofrun-cache/npm",
          }
        : {}),
    };
  }
  async restorePrepared() {
    if (this.plan.services.length || !this.options.toolsVolume)
      throw new Error(
        "Prepared restoration requires a trusted worker volume and no database services",
      );
    const volume = this.prefix + "-source",
      temporary = this.prefix + "-tmp";
    this.volumes.push(volume, this.options.toolsVolume, temporary);
    this.options.onEvent?.(
      "Restoring isolated source and temporary files; reusing immutable workers without recreating a download proxy",
    );
    for (const [name, size, mode] of [
      [volume, "2048m", "0755"],
      [temporary, "1024m", "1777"],
    ]) {
      await this.docker([
        "volume",
        "create",
        "--label",
        "proofrun.managed=true",
        "--driver",
        "local",
        "--opt",
        "type=tmpfs",
        "--opt",
        "device=tmpfs",
        "--opt",
        `o=size=${size},uid=1000,gid=1000,mode=${mode},nosuid,nodev`,
        name,
      ]);
    }
    this.appName = this.prefix + "-app";
    this.containers.push(this.appName);
    await this.docker([
      "create",
      "--name",
      this.appName,
      "--network",
      "none",
      "--add-host",
      "app:127.0.0.1",
      ...limits.filter(
        (value, index) =>
          value !== "--tmpfs" && limits[index - 1] !== "--tmpfs",
      ),
      "--user",
      "1000:1000",
      "--mount",
      `type=volume,source=${volume},target=/workspace`,
      "--mount",
      `type=volume,source=${temporary},target=/tmp`,
      "--workdir",
      "/workspace",
      ...Object.entries(this.environment()).flatMap(([k, v]) => [
        "-e",
        `${k}=${v}`,
      ]),
      "--entrypoint",
      "/bin/sleep",
      IMAGES[this.plan.runtime],
      "infinity",
    ]);
    // Hold the tmpfs mounts before the trusted loader exits, preserving data.
    await this.docker(["start", this.appName]);
    const loader = this.prefix + "-restore";
    this.containers.push(loader);
    await this.docker([
      "run",
      "--rm",
      "--name",
      loader,
      "--network",
      "none",
      ...limits,
      "--user",
      "1000:1000",
      "--mount",
      `type=volume,source=${this.options.snapshotVolume},target=/prepared,readonly`,
      "--mount",
      `type=volume,source=${volume},target=/workspace`,
      "--mount",
      `type=volume,source=${temporary},target=/runtime-tmp`,
      IMAGES.node,
      "sh",
      "-c",
      "cp -a /prepared/workspace/. /workspace/ && cp -a /prepared/tmp/. /runtime-tmp/",
    ]);
    this.containers = this.containers.filter((name) => name !== loader);
  }
  async prepare() {
    if (this.options.snapshotVolume) return this.restorePrepared();
    if (!Object.hasOwn(IMAGES, this.plan.runtime))
      throw new Error("Runtime image not allowed");
    const image = IMAGES[this.plan.runtime];
    const network = this.prefix + "-net",
      volume = this.prefix + "-source",
      tools = this.prefix + "-tools",
      temporary = this.prefix + "-tmp";
    this.networks.push(network);
    this.volumes.push(volume, tools, temporary);
    for (const img of [...new Set([image, IMAGES.node])]) {
      try {
        await this.docker(["image", "inspect", img]);
      } catch {
        await this.docker(["pull", img], {
          timeout: 600000,
          onLog: (s: string, t: string) => this.options.onLog?.(s, t),
        });
      }
    }
    await this.docker([
      "network",
      "create",
      "--internal",
      "--label",
      "proofrun.managed=true",
      network,
    ]);
    await this.docker([
      "volume",
      "create",
      "--label",
      "proofrun.managed=true",
      "--driver",
      "local",
      "--opt",
      "type=tmpfs",
      "--opt",
      "device=tmpfs",
      "--opt",
      "o=size=2048m,uid=1000,gid=1000,nosuid,nodev",
      volume,
    ]);
    await this.docker([
      "volume",
      "create",
      "--label",
      "proofrun.managed=true",
      tools,
    ]);
    await this.docker([
      "volume",
      "create",
      "--label",
      "proofrun.managed=true",
      "--driver",
      "local",
      "--opt",
      "type=tmpfs",
      "--opt",
      "device=tmpfs",
      "--opt",
      "o=size=1024m,uid=1000,gid=1000,mode=1777,nosuid,nodev",
      temporary,
    ]);
    const init = this.prefix + "-init";
    this.containers.push(init);
    await this.docker([
      "create",
      "--name",
      init,
      "--network",
      "none",
      ...limits,
      "--cap-add",
      "CHOWN",
      "--mount",
      `type=volume,source=${volume},target=/workspace`,
      "--mount",
      `type=volume,source=${tools},target=/runner`,
      "--mount",
      `type=volume,source=${temporary},target=/runtime-tmp`,
      IMAGES.node,
      "node",
      "-e",
      "setInterval(()=>{},10000)",
    ]);
    await this.docker(["start", init]);
    await this.docker(["cp", resolve(this.root) + "/.", init + ":/workspace"]);
    await this.docker(["cp", resolve(worker) + "/.", init + ":/runner"]);
    await this.docker([
      "exec",
      init,
      "chown",
      "-R",
      "1000:1000",
      "/workspace",
      "/runner",
    ]);
    this.proxyName = this.prefix + "-proxy";
    this.containers.push(this.proxyName);
    // Trusted worker volume is immutable to project containers. No host directories are mounted.
    await this.docker([
      "create",
      "--name",
      this.proxyName,
      "--network",
      network,
      "--network-alias",
      "proxy",
      ...limits,
      "--user",
      "1000:1000",
      "--mount",
      `type=volume,source=${tools},target=/runner,readonly`,
      IMAGES.node,
      "node",
      "/runner/proxy.mjs",
    ]);
    await this.docker(["network", "connect", "bridge", this.proxyName]);
    await this.docker(["start", this.proxyName]);
    for (const service of this.plan.services) {
      const name = this.prefix + "-" + service.name;
      this.containers.push(name);
      let img = "",
        args: string[] = [];
      if (service.kind === "postgres") {
        img = "postgres:17-bookworm";
        args = [
          "--tmpfs",
          "/var/lib/postgresql/data:uid=1000,gid=1000,mode=0700,size=512m",
          "--tmpfs",
          "/var/run/postgresql:uid=1000,gid=1000",
          "-e",
          "POSTGRES_USER=qa",
          "-e",
          "POSTGRES_PASSWORD=qa",
          "-e",
          "POSTGRES_DB=qa",
        ];
      }
      if (service.kind === "mysql") {
        img = "mysql:8.4";
        args = [
          "--tmpfs",
          "/var/lib/mysql:uid=1000,gid=1000,size=512m",
          "--tmpfs",
          "/var/run/mysqld:uid=1000,gid=1000",
          "-e",
          "MYSQL_ROOT_PASSWORD=qa",
          "-e",
          "MYSQL_USER=qa",
          "-e",
          "MYSQL_PASSWORD=qa",
          "-e",
          "MYSQL_DATABASE=qa",
        ];
      }
      if (service.kind === "redis") {
        img = "redis:7-bookworm";
        args = ["--tmpfs", "/data:uid=1000,gid=1000,size=256m"];
      }
      await this.docker(["pull", img], { timeout: 600000 });
      await this.docker([
        "run",
        "-d",
        "--name",
        name,
        "--network",
        network,
        "--network-alias",
        service.name,
        ...limits,
        "--user",
        "1000:1000",
        ...args,
        img,
      ]);
      const probe =
        service.kind === "postgres"
          ? ["pg_isready", "-U", "qa"]
          : service.kind === "mysql"
            ? ["mysqladmin", "ping", "-h", "127.0.0.1", "-u", "qa", "-pqa"]
            : ["redis-cli", "ping"];
      let ready = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        if (this.options.signal?.aborted) throw new Error("Setup cancelled");
        const result = await run(this.binary, ["exec", name, ...probe], {
          timeout: 5000,
          signal: this.options.signal,
        });
        if (result.exitCode === 0) {
          ready = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!ready) {
        const logs = await run(this.binary, ["logs", name], { timeout: 5000 });
        this.record("database", logs.stdout + logs.stderr);
        throw new Error(
          "Disposable " + service.kind + " service did not become ready",
        );
      }
    }
    this.appName = this.prefix + "-app";
    this.containers.push(this.appName);
    const env = this.environment();
    const envArgs = Object.entries(env).flatMap(([k, v]) => [
      "-e",
      `${k}=${v}`,
    ]);
    await this.docker([
      "create",
      "--name",
      this.appName,
      "--network",
      network,
      "--network-alias",
      "app",
      ...limits.filter(
        (value, index) =>
          value !== "--tmpfs" && limits[index - 1] !== "--tmpfs",
      ),
      "--user",
      "1000:1000",
      "--mount",
      `type=volume,source=${volume},target=/workspace`,
      "--mount",
      `type=volume,source=${temporary},target=/tmp`,
      "--workdir",
      "/workspace",
      ...envArgs,
      // Setup and existing suites may spawn compilers/subprocesses. Two concurrent
      // jobs receive four CPUs each; independent prepared workflows get two each.
      ...(process.env.PROOFRUN_CLOUD_VM === "1" ? [] : [
        "--cpus", this.options.snapshotVolume ? "2" : "4",
      ]),
      "--entrypoint",
      "/bin/sleep",
      image,
      "infinity",
    ]);
    await this.docker(["start", this.appName]);
    // Keep a live mount while transferring the tmpfs volume to the application.
    await this.docker(["rm", "-f", init]);
    this.containers = this.containers.filter((name) => name !== init);
  }
  execArgs(command: Command) {
    return [
      "exec",
      "-i",
      "--workdir",
      command.cwd === "." ? "/workspace" : "/workspace/" + command.cwd,
      this.appName,
      ...command.argv,
    ];
  }
  async command(command: Command, phase: string) {
    const args = this.execArgs(command);
    this.options.onEvent?.(`${phase}: ${command.label}`);
    const result = await run(this.binary, args, {
      timeout: command.timeoutSeconds * 1000,
      signal: this.options.signal,
      onLog: (s, t) => this.record(s, t),
    });
    if (result.timedOut || this.options.signal?.aborted) {
      await this.docker(["kill", this.appName], { signal: undefined }).catch(
        () => {},
      );
    }
    return {
      ...result,
      argv: command.argv,
      label: command.label,
      timeoutSeconds: command.timeoutSeconds,
      cwd: command.cwd,
    };
  }
  async bootstrap() {
    if (!/^node(?:\d+)?$/.test(this.plan.runtime)) return [];
    const results: ProcessResult[] = [];
    results.push(
      await this.command(
        {
          label: "Prepare project tool directory and Python alias",
          argv: [
            "node",
            "-e",
            "const fs=require('fs');fs.mkdirSync('/tmp/proofrun-tools/bin',{recursive:true});if(fs.existsSync('/usr/bin/python3')&&!fs.existsSync('/tmp/proofrun-tools/bin/python'))fs.symlinkSync('/usr/bin/python3','/tmp/proofrun-tools/bin/python');",
          ],
          cwd: ".",
          timeoutSeconds: 15,
        },
        "environment setup",
      ),
    );
    if (results.at(-1)?.exitCode !== 0) return results;
    for (const manager of await nodeToolchains(this.plan, this.root)) {
      results.push(
        await this.command(
          {
            label: `Provision ${manager.name} ${manager.version}`,
            argv: [
              "npm",
              "install",
              "--prefix",
              "/tmp/proofrun-tools",
              "--ignore-scripts",
              "--no-audit",
              "--no-fund",
              "--save-exact",
              `${manager.packageName}@${manager.version}`,
            ],
            cwd: ".",
            timeoutSeconds: 300,
          },
          "environment setup",
        ),
      );
      if (results.at(-1)?.exitCode !== 0 || results.at(-1)?.timedOut)
        return results;
      results.push(
        await this.command(
          {
            label: `Verify ${manager.name} ${manager.version}`,
            argv: [manager.name, "--version"],
            cwd: ".",
            timeoutSeconds: 30,
          },
          "environment setup",
        ),
      );
      if (results.at(-1)?.exitCode !== 0) return results;
    }
    return results;
  }
  async start() {
    if (!this.plan.start) return;
    if (this.proxyName) await this.docker(["stop", this.proxyName]);
    this.logs = "";
    this.app = launch(this.binary, this.execArgs(this.plan.start), {
      timeout: 1800000,
      signal: this.options.signal,
      onLog: (s, t) => this.record(s, t),
    });
    let ended = false;
    this.app.done
      .then((result: any) => {
        ended = true;
        this.appExit = result;
        if (this.closing) {
          this.options.onEvent?.("Application stopped during workflow cleanup");
          return;
        }
        this.options.onEvent?.(
          "Application process exited with code " + result.exitCode,
        );
        this.logs += `\nExit ${result.exitCode}; ${result.stderr}`;
      })
      .catch(() => {
        ended = true;
      });
    if (this.plan.port) {
      const readinessTimeoutMs =
        Math.min(60, this.plan.start.timeoutSeconds) * 1000;
      this.options.onEvent?.(
        "Waiting for application readiness inside its isolated network namespace",
      );
      const readinessController = new AbortController();
      let result;
      try {
        const signal = this.options.signal
          ? AbortSignal.any([this.options.signal, readinessController.signal])
          : readinessController.signal;
        result = await Promise.race([
          this.probe({ ready: true, readinessTimeoutMs }, signal),
          this.app.done.then((exit: any) => {
            throw Object.assign(
              new Error(
                "Application exited before readiness: " +
                  this.runtimeLogs().slice(-5000),
              ),
              {
                code: "APPLICATION_CRASH",
                exitCode: exit.exitCode,
                logs: this.runtimeLogs(),
                command: this.plan.start,
              },
            );
          }),
        ]);
      } finally {
        readinessController.abort();
      }
      if (ended)
        throw Object.assign(
          new Error(
            "Application exited before readiness: " + this.logs.slice(-5000),
          ),
          {
            code: "APPLICATION_CRASH",
            exitCode: this.appExit?.exitCode,
            logs: this.runtimeLogs(),
            command: this.plan.start,
          },
        );
      if (result.ready) return;
      throw Object.assign(
        new Error(
          `Application did not listen on port ${this.plan.port} within ${readinessTimeoutMs / 1000} seconds. Review its start command, configured port and captured logs.`,
        ),
        {
          code: "APPLICATION_NOT_READY",
          logs: this.runtimeLogs(),
          command: this.plan.start,
          timeoutSeconds: readinessTimeoutMs / 1000,
        },
      );
    }
  }
  async probe(test: any, signal?: AbortSignal) {
    const ready = test.ready === true;
    // A shared *container* network namespace reaches servers binding localhost,
    // including Vite. It never uses the host network or exposes a host port.
    const base = `http://127.0.0.1:${this.plan.port}`;
    const args = [
      "run",
      "--rm",
      "-i",
      "--name",
      this.prefix + "-probe",
      "--network",
      "container:" + this.appName,
      ...limits,
      "--user",
      "1000:1000",
      "--mount",
      `type=volume,source=${this.volumes[1]},target=/runner,readonly`,
      IMAGES.node,
      "node",
      "/runner/http.mjs",
    ];
    this.containers.push(this.prefix + "-probe");
    const output = await this.docker(args, {
      input: JSON.stringify(
        ready
          ? { base, ready: true, readinessTimeoutMs: test.readinessTimeoutMs }
          : { base, test },
      ),
      timeout: ready
        ? (test.readinessTimeoutMs || 0) + 10000
        : Math.min(600000, test.steps.length * 15000),
      maxBytes: 2000000,
      signal: signal ?? this.options.signal,
    });
    const result = JSON.parse(output);
    this.containers = this.containers.filter(
      (name) => name !== this.prefix + "-probe",
    );
    if (!ready && this.appExit && result.trace?.some((s: any) => s.error)) {
      result.outcome = "failed";
      result.category = "runtime-crash";
      result.errors = [
        ...(result.errors ?? []),
        {
          message: "Application process exited",
          exitCode: this.appExit.exitCode,
          stack: this.appExit.stderr,
        },
      ];
    }
    return result;
  }
  async browser(test: any) {
    const revision = hash(
      Buffer.concat(
        await Promise.all([
          readFile(resolve(worker, "browser.mjs")),
          readFile(resolve(worker, "Dockerfile.browser")),
        ]),
      ),
    ).slice(0, 16);
    const tag = "proofrun-browser:1.63.0-" + revision;
    try {
      await this.docker(["image", "inspect", tag]);
    } catch {
      this.options.onEvent?.(
        "Preparing browser runtime: the first run downloads Chromium; later runs reuse this image",
      );
      await this.docker(
        [
          "build",
          "-t",
          tag,
          "-f",
          resolve(worker, "Dockerfile.browser"),
          worker,
        ],
        {
          timeout: 600000,
          onLog: (stream: string, text: string) => this.record(stream, text),
        },
      );
    }
    const name = this.prefix + "-browser";
    this.containers.push(name);
    const artifacts = resolve(this.options.artifacts);
    await mkdir(artifacts, { recursive: true });
    await this.docker([
      "create",
      "--name",
      name,
      "--network",
      "container:" + this.appName,
      ...limits,
      "--shm-size",
      "256m",
      "--tmpfs",
      "/artifacts:uid=1000,gid=1000,mode=0777,size=64m",
      "--entrypoint",
      "/bin/sleep",
      tag,
      "infinity",
    ]);
    await this.docker(["start", name]);
    const output = await this.docker(
      ["exec", "-i", name, "node", "/runner/browser.mjs"],
      {
        input: JSON.stringify({
          base: `http://127.0.0.1:${this.plan.port}`,
          test,
        }),
        timeout: Math.min(600000, test.steps.length * 15000),
        maxBytes: 2000000,
      },
    );
    // docker cp can report success but omit a tmpfs mount's live contents.
    // Transfer a bounded PNG through the trusted worker's JSON channel instead.
    const result = JSON.parse(output);
    const screenshot = Buffer.from(result.screenshotBase64 ?? "", "base64");
    if (
      screenshot.length < 8 ||
      screenshot.length > 1_000_000 ||
      !screenshot
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw new Error(
        "Browser worker did not return valid PNG screenshot evidence",
      );
    result.screenshot = this.prefix + "-" + test.id + "-final.png";
    await writeFile(resolve(artifacts, result.screenshot), screenshot);
    delete result.screenshotBase64;
    await this.docker(["rm", "-f", name]);
    this.containers = this.containers.filter((container) => container !== name);
    return result;
  }
  runtimeLogs() {
    return this.logs;
  }
  async snapshot(): Promise<PreparedEnvironment> {
    if (this.plan.services.length)
      throw new Error(
        "Service data needs fresh setup; filesystem snapshots cannot preserve database initialization",
      );
    const volume = this.prefix + "-prepared",
      holder = this.prefix + "-prepared-holder";
    const cleanup = async () => {
      await run(this.binary, ["rm", "-f", holder], { timeout: 20000 }).catch(
        () => {},
      );
      await run(this.binary, ["volume", "rm", "-f", volume], {
        timeout: 20000,
      }).catch(() => {});
      // The holder kept the original tmpfs mount alive after its parent session closed.
      await run(this.binary, ["volume", "rm", "-f", this.volumes[0]], {
        timeout: 20000,
      }).catch(() => {});
      await run(
        this.binary,
        ["volume", "rm", "-f", this.volumes[2], this.volumes[1]],
        {
          timeout: 20000,
        },
      ).catch(() => {});
    };
    try {
      await this.docker([
        "volume",
        "create",
        "--label",
        "proofrun.managed=true",
        "--driver",
        "local",
        "--opt",
        "type=tmpfs",
        "--opt",
        "device=tmpfs",
        "--opt",
        "o=size=3072m,uid=1000,gid=1000,nosuid,nodev",
        volume,
      ]);
      await this.docker([
        "create",
        "--name",
        holder,
        "--network",
        "none",
        ...limits,
        "--user",
        "1000:1000",
        "--mount",
        `type=volume,source=${this.volumes[0]},target=/source,readonly`,
        "--mount",
        `type=volume,source=${this.volumes[2]},target=/source-tmp,readonly`,
        "--mount",
        `type=volume,source=${this.volumes[1]},target=/runner,readonly`,
        "--mount",
        `type=volume,source=${volume},target=/prepared`,
        IMAGES.node,
        "node",
        "-e",
        "setInterval(()=>{},10000)",
      ]);
      await this.docker(["start", holder]);
      await this.docker([
        "exec",
        holder,
        "node",
        "-e",
        "require('fs').mkdirSync('/prepared/workspace',{recursive:true});require('fs').mkdirSync('/prepared/tmp',{recursive:true});",
      ]);
      for (const [source, target] of [
        ["/source/.", "/prepared/workspace/"],
        ["/source-tmp/.", "/prepared/tmp/"],
      ])
        await this.docker(["exec", holder, "cp", "-a", source, target]);
      // The holder is trusted and idle. Project containers only see this frozen volume read-only.
      this.options.onEvent?.(
        "Prepared environment captured; subsequent workflows skip installation and build",
      );
      return {
        open: async (options: any) => {
          const session = new DockerSession(this.binary, this.plan, this.root, {
            ...options,
            snapshotVolume: volume,
            toolsVolume: this.volumes[1],
          });
          try {
            await session.prepare();
            return session;
          } catch (error) {
            await session.close();
            throw error;
          }
        },
        close: cleanup,
      };
    } catch (error) {
      await cleanup();
      throw error;
    }
  }
  async close() {
    this.closing = true;
    if (this.app) {
      this.app.kill();
      await this.app.done.catch(() => {});
    }
    if (this.containers.length)
      await run(this.binary, ["rm", "-f", ...new Set(this.containers)], {
        timeout: 20000,
      }).catch(() => {});
    if (this.volumes.length)
      await run(this.binary, ["volume", "rm", "-f", ...this.volumes], {
        timeout: 20000,
      }).catch(() => {});
    if (this.networks.length)
      await run(this.binary, ["network", "rm", ...this.networks], {
        timeout: 20000,
      }).catch(() => {});
  }
}
