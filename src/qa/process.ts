import { spawn, type ChildProcess } from "node:child_process";
import { redact, maskServerSecrets } from "./safety.ts";
export type ProcessResult = {
  argv: string[];
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
};
export function launch(
  binary: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    timeout?: number;
    maxBytes?: number;
    signal?: AbortSignal;
    onLog?: (stream: string, text: string) => void;
  } = {},
) {
  const started = Date.now();
  let out = "",
    err = "",
    bytes = 0,
    truncated = false,
    timedOut = false;
  const child = spawn(binary, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const collect = (stream: string, buffer: Buffer) => {
    // Keep machine-readable JSON intact. Generic credential masking is applied
    // after decoding, at report/UI boundaries.
    const value = maskServerSecrets(buffer.toString());
    bytes += buffer.length;
    if (bytes <= (options.maxBytes ?? 1_000_000)) {
      stream === "stdout" ? (out += value) : (err += value);
      options.onLog?.(stream, value);
    } else truncated = true;
  };
  child.stdout.on("data", (b) => collect("stdout", b));
  child.stderr.on("data", (b) => collect("stderr", b));
  child.stdin.on("error", () => {});
  child.stdin.end(options.input ?? "");
  const kill = () => {
    child.kill("SIGKILL");
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, options.timeout ?? 120_000);
  options.signal?.addEventListener("abort", kill, { once: true });
  if (options.signal?.aborted) kill();
  const done = new Promise<ProcessResult>((resolve, reject) => {
    child.once("error", (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", kill);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", kill);
      resolve({
        argv: [binary, ...args],
        exitCode: code,
        signal,
        timedOut,
        stdout: maskServerSecrets(out),
        stderr: maskServerSecrets(err),
        durationMs: Date.now() - started,
        truncated,
      });
    });
  });
  return { child, done, kill };
}
export async function run(
  binary: string,
  args: string[],
  options: Parameters<typeof launch>[2] = {},
) {
  return launch(binary, args, options).done;
}
export async function requireSuccess(
  binary: string,
  args: string[],
  options: Parameters<typeof launch>[2] = {},
) {
  const result = await run(binary, args, options);
  if (result.exitCode !== 0 || result.timedOut)
    throw new Error(
      redact(
        result.stderr ||
          result.stdout ||
          `${args[0]} ${result.timedOut ? "timed out" : `failed (exit ${result.exitCode}, signal ${result.signal ?? "none"})`} after ${result.durationMs} ms`,
      ),
    );
  return result.stdout.trim();
}
