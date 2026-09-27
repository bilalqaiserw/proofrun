import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { inside } from "./safety.ts";
import type { Plan } from "./contracts.ts";

export async function nodeToolchains(plan: Plan, root: string) {
  const commands = [
    ...plan.install,
    ...plan.build,
    ...plan.checks,
    ...(plan.start ? [plan.start] : []),
  ];
  const requested = new Set(
    commands
      .map((c) => c.argv[0])
      .filter((name) => ["pnpm", "yarn"].includes(name)),
  );
  const pinned = new Map<string, string>();
  for (const cwd of new Set([".", ...commands.map((c) => c.cwd)])) {
    const path =
      cwd === "."
        ? resolve(root, "package.json")
        : inside(root, cwd + "/package.json");
    let pkg: any;
    try {
      pkg = JSON.parse(await readFile(path, "utf8"));
    } catch {
      continue;
    }
    if (typeof pkg.packageManager !== "string") continue;
    const match =
      /^(pnpm|yarn)@(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)(?:\+sha\d+\.[a-fA-F0-9]+)?$/.exec(
        pkg.packageManager,
      );
    if (!match) continue;
    const [, name, version] = match;
    if (pinned.has(name) && pinned.get(name) !== version)
      throw new Error(
        `Conflicting ${name} versions require separate runtime plans`,
      );
    pinned.set(name, version);
    requested.add(name);
  }
  return [...requested].map((name) => {
    const version =
      pinned.get(name) || (name === "pnpm" ? "10.6.2" : "1.22.22");
    const packageName =
      name === "yarn" && Number(version.split(".")[0]) >= 2
        ? "@yarnpkg/cli-dist"
        : name;
    return { name, version, packageName };
  });
}
