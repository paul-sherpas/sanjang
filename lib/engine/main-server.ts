/**
 * Main branch dev server manager.
 * Creates a git worktree from origin's default branch and runs a dev server
 * for side-by-side comparison with the camp's changes.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { SanjangConfig } from "../types.ts";

interface MainServerState {
  status: "stopped" | "starting" | "running" | "error";
  port: number | null;
  error: string | null;
  branch: string | null;
}

let state: MainServerState = { status: "stopped", port: null, error: null, branch: null };
let proc: ChildProcess | null = null;
let logs: string[] = [];
let worktreePath: string | null = null;

export function getMainServerState(): MainServerState {
  return { ...state };
}

export function getMainServerLogs(): string[] {
  return [...logs];
}

/** Detect the default branch from origin (main, master, dev, etc.) */
function detectDefaultBranch(projectRoot: string): string {
  // Try origin/HEAD first
  const headRef = spawnSync("git", ["-C", projectRoot, "symbolic-ref", "refs/remotes/origin/HEAD"], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (headRef.status === 0 && headRef.stdout.trim()) {
    // refs/remotes/origin/main → main
    return headRef.stdout.trim().replace("refs/remotes/origin/", "");
  }

  // Fallback: check common names
  for (const name of ["main", "master", "dev", "develop"]) {
    const check = spawnSync("git", ["-C", projectRoot, "rev-parse", "--verify", `origin/${name}`], {
      encoding: "utf8",
      stdio: "pipe",
    });
    if (check.status === 0) return name;
  }

  return "main"; // last resort
}

/** Create a git worktree for the comparison server */
function ensureWorktree(projectRoot: string, branch: string): string {
  const campsDir = join(projectRoot, ".sanjang", "camps");
  const wtPath = join(campsDir, "__main__");

  // Clean up stale worktree if it exists
  if (existsSync(wtPath)) {
    spawnSync("git", ["-C", projectRoot, "worktree", "remove", "--force", wtPath], {
      stdio: "pipe",
    });
    if (existsSync(wtPath)) {
      rmSync(wtPath, { recursive: true, force: true });
    }
  }

  // Try origin first, fall back to local branch
  const hasOrigin = spawnSync("git", ["-C", projectRoot, "remote"], {
    encoding: "utf8",
    stdio: "pipe",
  }).stdout.trim().includes("origin");

  let ref: string;
  if (hasOrigin) {
    spawnSync("git", ["-C", projectRoot, "fetch", "origin", branch], { stdio: "pipe" });
    ref = `origin/${branch}`;
  } else {
    ref = branch;
  }

  // Create worktree
  if (!existsSync(campsDir)) mkdirSync(campsDir, { recursive: true });
  const result = spawnSync("git", ["-C", projectRoot, "worktree", "add", "--detach", wtPath, ref], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    throw new Error(`worktree 생성 실패: ${result.stderr?.trim() || "unknown error"}`);
  }

  return wtPath;
}

/** Run setup command (npm install, etc.) in the worktree */
function runSetup(wtPath: string, config: SanjangConfig, onLog: (msg: string) => void): void {
  if (!config.setup) return;

  const setupCwd = config.dev.cwd ? join(wtPath, config.dev.cwd) : wtPath;
  onLog(`의존성 설치 중: ${config.setup}`);

  const result = spawnSync(config.setup, [], {
    cwd: setupCwd,
    shell: true,
    stdio: "pipe",
    encoding: "utf8",
    timeout: 120_000,
  });

  if (result.status !== 0) {
    onLog(`⚠️ setup 실패 (exit ${result.status}), 계속 진행합니다`);
  } else {
    onLog("의존성 설치 완료 ✓");
  }
}

export async function startMainServer(
  projectRoot: string,
  config: SanjangConfig,
  onReady?: (port: number) => void,
  onLog?: (msg: string) => void,
): Promise<void> {
  if (state.status === "running" || state.status === "starting") return;

  const log = onLog ?? (() => {});
  state = { status: "starting", port: null, error: null, branch: null };
  logs = [];

  try {
    // 1. Detect default branch
    const branch = detectDefaultBranch(projectRoot);
    state.branch = branch;
    log(`비교 기준: origin/${branch}`);

    // 2. Create worktree from origin/<branch>
    log("원본 소스 준비 중...");
    const wtPath = ensureWorktree(projectRoot, branch);
    worktreePath = wtPath;

    // 3. Copy gitignored files (node_modules cache, .env, etc.)
    // We rely on setup (npm install) to handle dependencies

    // 4. Run setup
    runSetup(wtPath, config, log);

    // 5. Start dev server
    const basePort = config.dev.port + 100;
    const needsSeparator = config.dev.portFlag && /\b(npm|yarn|pnpm)\s+run\b/.test(config.dev.command);
    const fullCommand = config.dev.portFlag
      ? `${config.dev.command}${needsSeparator ? " --" : ""} ${config.dev.portFlag} ${basePort}`
      : config.dev.command;

    const cwd = config.dev.cwd ? join(wtPath, config.dev.cwd) : wtPath;

    log(`dev 서버 시작: ${fullCommand}`);
    proc = spawn(fullCommand, [], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...config.dev.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      shell: true,
      detached: true,
    });

    proc.stdout?.on("data", (chunk: Buffer) => {
      const line = chunk.toString();
      logs.push(line);
      if (logs.length > 100) logs.shift();
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      const line = chunk.toString();
      logs.push(line);
      if (logs.length > 100) logs.shift();
    });

    proc.on("close", (code) => {
      if (state.status !== "stopped") {
        state = { ...state, status: "stopped", port: null, error: code ? `exit ${code}` : null };
      }
      proc = null;
    });

    proc.on("error", (err) => {
      state = { ...state, status: "error", port: null, error: err.message };
      proc = null;
    });

    const detectedPort = await detectMainPort(logs, basePort, 60_000);
    if (detectedPort) {
      state = { status: "running", port: detectedPort, error: null, branch };
      log(`비교 서버 준비 완료 ✓ (origin/${branch}, :${detectedPort})`);
      onReady?.(detectedPort);
    } else {
      killProc();
      const lastLog = logs.slice(-5).join("\n").trim();
      state = { status: "error", port: null, error: lastLog || "포트를 감지하지 못했어요", branch };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state = { status: "error", port: null, error: message, branch: state.branch };
    log(`❌ 비교 서버 시작 실패: ${message}`);
  }
}

function killProc(): void {
  if (proc) {
    const pid = proc.pid;
    if (pid) {
      try { process.kill(-pid, "SIGTERM"); } catch { proc?.kill("SIGTERM"); }
    } else {
      proc.kill("SIGTERM");
    }
    proc = null;
  }
}

export function stopMainServer(): void {
  state = { status: "stopped", port: null, error: null, branch: null };
  killProc();
  logs = [];

  // Clean up worktree
  if (worktreePath && existsSync(worktreePath)) {
    try {
      // Find project root from worktree path
      const campsDir = join(worktreePath, "..");
      const projectRoot = join(campsDir, "..", "..");
      spawnSync("git", ["-C", projectRoot, "worktree", "remove", "--force", worktreePath], {
        stdio: "pipe",
      });
    } catch {
      // Force-delete if git worktree remove fails
      try { rmSync(worktreePath, { recursive: true, force: true }); } catch {}
    }
    worktreePath = null;
  }
}

function detectMainPort(logLines: string[], _fallbackPort: number, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    // Strip ANSI codes before matching — Vite injects bold/color around the port number
    const ansiRe = /\x1b\[[0-9;]*m/g;
    const portRe = /https?:\/\/localhost:(\d+)/;

    function check(): void {
      for (const line of logLines) {
        const match = portRe.exec(line.replace(ansiRe, ""));
        if (match?.[1]) {
          const port = parseInt(match[1], 10);
          const sock = createConnection({ port, host: "localhost" });
          sock.once("connect", () => {
            sock.destroy();
            resolve(port);
          });
          sock.once("error", () => {
            sock.destroy();
            if (Date.now() < deadline) setTimeout(check, 1000);
            else resolve(port);
          });
          return;
        }
      }
      if (Date.now() >= deadline) {
        resolve(null);
      } else {
        setTimeout(check, 1000);
      }
    }

    check();
  });
}
