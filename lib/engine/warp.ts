import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

interface WarpDetectResult {
  installed: boolean;
}

interface WarpOpenResult {
  opened: boolean;
  terminal: string | null;
  path?: string;
}

/**
 * Detect if Warp terminal is installed.
 */
export function detectWarp(): WarpDetectResult {
  const installed = existsSync("/Applications/Warp.app");
  return { installed };
}

/**
 * Open a Warp tab at the given worktree path.
 * Opens as a new tab in the existing Warp window (not a new window).
 * The tab title naturally shows the directory name (= camp name).
 */
export function openWarpTab(campName: string, worktreePath: string): WarpOpenResult {
  const { installed } = detectWarp();
  if (!installed) {
    return { opened: false, terminal: null, path: worktreePath };
  }

  // open -a Warp {path} → opens tab in existing window with dir name as title
  const result = spawnSync("open", ["-a", "Warp", worktreePath], { stdio: "pipe" });

  return {
    opened: result.status === 0,
    terminal: "warp",
  };
}

/**
 * No-op cleanup (launch config removed — using open -a instead).
 */
export function removeLaunchConfig(_campName: string): void {
  // Intentionally empty — kept for API compatibility with server.ts
}
