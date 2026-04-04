import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

interface WarpDetectResult {
  installed: boolean;
}

interface WarpOpenResult {
  opened: boolean;
  terminal: string | null;
  path?: string;
}

function launchConfigDir(): string {
  return join(homedir(), ".warp", "launch_configurations");
}

/**
 * Detect if Warp terminal is installed.
 */
export function detectWarp(): WarpDetectResult {
  const installed = existsSync("/Applications/Warp.app");
  return { installed };
}

function launchConfigName(campName: string): string {
  return `sanjang-${campName}`;
}

function launchConfigPath(campName: string): string {
  return join(launchConfigDir(), `${launchConfigName(campName)}.yaml`);
}

/**
 * Write a Warp launch configuration YAML for a camp.
 */
export function writeLaunchConfig(campName: string, worktreePath: string): void {
  mkdirSync(launchConfigDir(), { recursive: true });
  const yaml = `---
name: ${launchConfigName(campName)}
windows:
  - tabs:
      - title: "🏕️ ${campName}"
        layout:
          cwd: ${worktreePath}
`;
  writeFileSync(launchConfigPath(campName), yaml, "utf8");
}

/**
 * Remove the Warp launch configuration for a camp.
 */
export function removeLaunchConfig(campName: string): void {
  const configPath = launchConfigPath(campName);
  if (existsSync(configPath)) {
    rmSync(configPath);
  }
}

/**
 * Open a named Warp tab for a camp using launch configuration.
 * Creates the launch config if needed, then opens via warp:// URL scheme.
 */
export function openWarpTab(campName: string, worktreePath: string): WarpOpenResult {
  const { installed } = detectWarp();
  if (!installed) {
    return { opened: false, terminal: null, path: worktreePath };
  }

  writeLaunchConfig(campName, worktreePath);

  const name = launchConfigName(campName);
  const result = spawnSync("open", [`warp://launch/${name}`], { stdio: "pipe" });

  return {
    opened: result.status === 0,
    terminal: "warp",
  };
}
