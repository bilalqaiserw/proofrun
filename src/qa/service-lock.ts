import { createServer, connect } from "node:net";
import { resolve } from "node:path";
import { hash } from "./safety.ts";

// An OS-owned loopback socket releases automatically on crash. It prevents
// separate processes from independently overwriting the same workspace store.
export async function ownWorkspaceStore(directory: string, webPort: number) {
  const normalized = resolve(directory).replaceAll("\\", "/");
  const identity = hash(
    process.platform === "win32" ? normalized.toLowerCase() : normalized,
  );
  const port = 40000 + (parseInt(identity.slice(0, 8), 16) % 16000);
  const server = createServer((socket) => {
    // A second CLI exits as soon as it reads ownership; its abrupt disconnect
    // must never emit an unhandled socket error in the running QA service.
    socket.on("error", () => {});
    socket.end(JSON.stringify({ app: "ProofRun", identity, port: webPort }));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
  } catch (error: any) {
    if (error.code !== "EADDRINUSE") throw error;
    const owner: any = await new Promise((resolve) => {
      let data = "";
      const socket = connect(port, "127.0.0.1");
      socket.setTimeout(1000);
      socket.on("data", (chunk) => {
        data += chunk;
        if (data.length > 1000) socket.destroy();
      });
      socket.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
      socket.on("timeout", () => socket.destroy());
      socket.on("error", () => resolve(null));
      socket.on("close", () => resolve(null));
    });
    throw new Error(
      owner?.app === "ProofRun" && owner.identity === identity
        ? `This workspace store is already open at http://localhost:${owner.port}. Use that window or stop that server before restarting.`
        : `Workspace ownership port ${port} is unavailable. Close the conflicting service or use a different PROOFRUN_DATA_DIR.`,
    );
  }
  return {
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
