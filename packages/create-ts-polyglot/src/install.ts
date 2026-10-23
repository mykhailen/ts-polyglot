// Installs the new project's dependencies with the package manager that ran `create`, so a pnpm or
// yarn user gets their lockfile and layout, not npm's.
import { spawnSync } from "node:child_process";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/** npm, pnpm, yarn and bun all set npm_config_user_agent to "<name>/<version> ..." for the scripts they run. */
export function packageManager(userAgent: string | undefined): PackageManager {
  const name = userAgent?.split("/")[0];
  return name === "pnpm" || name === "yarn" || name === "bun" ? name : "npm";
}

export function installCommand(manager: PackageManager): { command: string; args: string[] } {
  return { command: manager, args: ["install"] };
}

/** How the user runs a package.json script with their manager, for the printed next steps. */
export function runScriptCommand(manager: PackageManager, script: string): string {
  if (script === "start") return `${manager} start`;
  return manager === "npm" || manager === "bun" ? `${manager} run ${script}` : `${manager} ${script}`;
}

/** Runs the install in `dir`. Returns the output when it fails, so the caller can show it. */
export function install(manager: PackageManager, dir: string): { ok: true } | { ok: false; output: string } {
  const { command, args } = installCommand(manager);
  // On Windows the package managers are .cmd shims, which Node only spawns through a shell.
  const result = spawnSync(command, args, { cwd: dir, encoding: "utf8", shell: process.platform === "win32" });
  if (result.status === 0) return { ok: true };
  return { ok: false, output: `${result.error?.message ?? ""}${result.stdout}${result.stderr}`.trim() };
}
