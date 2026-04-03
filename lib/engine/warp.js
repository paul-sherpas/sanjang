import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/**
 * Detect if Warp terminal is installed.
 */
export function detectWarp() {
  const installed = existsSync('/Applications/Warp.app');
  return { installed };
}

/**
 * Build the command to open a Warp tab at the given path.
 */
export function buildOpenCommand(worktreePath) {
  return ['open', '-a', 'Warp', worktreePath];
}

/**
 * Open a Warp tab at the given worktree path.
 * Returns { opened: true } if Warp opened, { opened: false, path } if not installed.
 */
export function openWarpTab(worktreePath) {
  const { installed } = detectWarp();
  if (!installed) {
    return { opened: false, terminal: null, path: worktreePath };
  }

  const cmd = buildOpenCommand(worktreePath);
  const result = spawnSync(cmd[0], cmd.slice(1), { stdio: 'pipe' });

  return {
    opened: result.status === 0,
    terminal: 'warp',
  };
}
