/**
 * Main branch dev server manager.
 * Creates a git worktree from origin's default branch and runs a dev server
 * for side-by-side comparison with the camp's changes.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { SanjangConfig } from "../types.ts";
import { buildDevCommand, detectPortFromLogs, killProcessGroup } from "./process-utils.ts";

interface MainServerState {
  status: "stopped" | "starting" | "running" | "error";
  port: number | null;
  error: string | null;
}

let state: MainServerState = { status: "stopped", port: null, error: null };
let proc: ChildProcess | null = null;
let logs: string[] = [];
let worktreePath: string | null = null;
let savedProjectRoot: string | null = null;

export function getMainServerState(): MainServerState {
  return { ...state };
}

export function getMainServerLogs(): string[] {
  return [...logs];
}

/** Detect the default branch from origin (main, master, dev, etc.) */
function detectDefaultBranch(projectRoot: string): string {
  const headRef = spawnSync("git", ["-C", projectRoot, "symbolic-ref", "refs/remotes/origin/HEAD"], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (headRef.status === 0 && headRef.stdout.trim()) {
    return headRef.stdout.trim().replace("refs/remotes/origin/", "");
  }

  for (const name of ["main", "master", "dev", "develop"]) {
    const check = spawnSync("git", ["-C", projectRoot, "rev-parse", "--verify", `origin/${name}`], {
      encoding: "utf8",
      stdio: "pipe",
    });
    if (check.status === 0) return name;
  }

  return "main";
}

/** Create a git worktree for the comparison server */
function ensureWorktree(projectRoot: string, branch: string): string {
  const campsDir = join(projectRoot, ".sanjang", "camps");
  const wtPath = join(campsDir, "__main__");

  if (existsSync(wtPath)) {
    spawnSync("git", ["-C", projectRoot, "worktree", "remove", "--force", wtPath], { stdio: "pipe" });
    if (existsSync(wtPath)) {
      rmSync(wtPath, { recursive: true, force: true });
    }
  }

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
  callbacks?: { onReady?: (port: number) => void; onLog?: (msg: string) => void },
): Promise<void> {
  if (state.status === "running" || state.status === "starting") return;

  const log = callbacks?.onLog ?? (() => {});
  state = { status: "starting", port: null, error: null };
  logs = [];
  savedProjectRoot = projectRoot;

  try {
    const branch = detectDefaultBranch(projectRoot);
    log(`비교 기준: origin/${branch}`);

    log("원본 소스 준비 중...");
    const wtPath = ensureWorktree(projectRoot, branch);
    worktreePath = wtPath;

    runSetup(wtPath, config, log);

    const basePort = config.dev.port + 100;
    const fullCommand = buildDevCommand(config.dev.command, config.dev.portFlag, basePort);
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
        state = { status: "stopped", port: null, error: code ? `exit ${code}` : null };
      }
      proc = null;
    });

    proc.on("error", (err) => {
      state = { status: "error", port: null, error: err.message };
      proc = null;
    });

    const detectedPort = await detectPortFromLogs(logs, 60_000);
    if (detectedPort) {
      state = { status: "running", port: detectedPort, error: null };
      log(`비교 서버 준비 완료 ✓ (origin/${branch}, :${detectedPort})`);
      callbacks?.onReady?.(detectedPort);
    } else {
      if (proc) { killProcessGroup(proc); proc = null; }
      const lastLog = logs.slice(-5).join("\n").trim();
      state = { status: "error", port: null, error: lastLog || "포트를 감지하지 못했어요" };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state = { status: "error", port: null, error: message };
    log(`❌ 비교 서버 시작 실패: ${message}`);
  }
}

export function stopMainServer(): void {
  state = { status: "stopped", port: null, error: null };
  if (proc) { killProcessGroup(proc); proc = null; }
  logs = [];

  if (worktreePath && existsSync(worktreePath) && savedProjectRoot) {
    try {
      spawnSync("git", ["-C", savedProjectRoot, "worktree", "remove", "--force", worktreePath], {
        stdio: "pipe",
      });
    } catch {
      try { rmSync(worktreePath, { recursive: true, force: true }); } catch {}
    }
    worktreePath = null;
  }
}
