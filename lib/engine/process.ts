import { type ChildProcess, spawn } from "node:child_process";
import { createConnection } from "node:net";
import { join } from "node:path";
import type { EventCallback, SanjangConfig } from "../types.ts";
import { campPath, getProjectRoot } from "./worktree.ts";

interface CampProcessEntry {
  feProc: ChildProcess | null;
  feLogs: string[];
  feExitCode: number | null;
}

export interface ProcessInfo {
  feLogs: string[];
  feExitCode: number | null;
}

const procs: Map<string, CampProcessEntry> = new Map();
let projectConfig: SanjangConfig | null = null;
let sharedBeProc: ChildProcess | null = null;

export function setConfig(config: SanjangConfig): void {
  projectConfig = config;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Detect actual port from dev server stdout (Vite: "➜  Local: http://localhost:3004/")
function detectPortFromStdout(logs: string[], timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    // Patterns: Vite "Local:   http://localhost:PORT/", Next "- Local: http://localhost:PORT"
    const portRe = /https?:\/\/localhost:(\d+)/;

    function check(): void {
      for (const line of logs) {
        const match = portRe.exec(line);
        if (match?.[1]) {
          const port = parseInt(match[1], 10);
          // Wait briefly for the port to actually be ready
          const sock = createConnection({ port, host: "localhost" });
          sock.once("connect", () => {
            sock.destroy();
            resolve(port);
          });
          sock.once("error", () => {
            sock.destroy();
            // Port printed but not ready yet, retry
            if (Date.now() < deadline) setTimeout(check, 1000);
            else resolve(port); // return the port anyway
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

function waitForPort(port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    function attempt(): void {
      const sock = createConnection({ port, host: "localhost" });
      sock.once("connect", () => {
        sock.destroy();
        resolve();
      });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() >= deadline) {
          reject(new Error(`포트 ${port}이 ${timeoutMs / 1000}초 내에 열리지 않았습니다.`));
        } else {
          setTimeout(attempt, 2000);
        }
      });
    }
    attempt();
  });
}

function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    async function attempt(): Promise<void> {
      try {
        const res = await fetch(url);
        if (res.ok) return resolve();
      } catch {
        /* not ready */
      }
      if (Date.now() >= deadline) {
        reject(new Error(`HTTP 응답 없음 (${timeoutMs / 1000}초 초과)`));
      } else {
        setTimeout(attempt, 3000);
      }
    }
    attempt();
  });
}

function attachLogs(child: ChildProcess, logBuf: string[], source: string, onEvent: EventCallback): void {
  function handleData(data: Buffer): void {
    const text = data.toString();
    logBuf.push(text);
    for (const line of text.split("\n")) {
      if (line.trim()) onEvent({ type: "log", source, data: line });
    }
  }
  child.stdout?.on("data", handleData);
  child.stderr?.on("data", handleData);
}

// ---------------------------------------------------------------------------
// Backend (shared, optional)
// ---------------------------------------------------------------------------

async function ensureBackend(onEvent: EventCallback): Promise<void> {
  const be = projectConfig?.backend;
  if (!be) return; // No backend configured

  // Check if already running
  try {
    const healthUrl = be.healthCheck?.startsWith("/")
      ? `http://localhost:${be.port}${be.healthCheck}`
      : `http://localhost:${be.port}`;
    const res = await fetch(healthUrl);
    if (res.ok) {
      onEvent({ type: "log", source: "sanjang", data: `Backend(:${be.port}) 실행 중 ✓` });
      return;
    }
  } catch {
    /* not running */
  }

  onEvent({ type: "log", source: "sanjang", data: `Backend(:${be.port}) 시작 중...` });

  const [cmd = "echo", ...args] = be.command.split(" ");
  const cwd = be.cwd ? join(getProjectRoot(), be.cwd) : getProjectRoot();

  const beProc = spawn(cmd, args, {
    cwd,
    env: { ...process.env, PORT: String(be.port), ...be.env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    shell: true,
  });
  beProc.unref();
  sharedBeProc = beProc;
  beProc.stdout?.on("data", (d: Buffer) => onEvent({ type: "log", source: "backend", data: d.toString() }));
  beProc.stderr?.on("data", (d: Buffer) => onEvent({ type: "log", source: "backend", data: d.toString() }));

  if (be.healthCheck) {
    const healthUrl = be.healthCheck.startsWith("/") ? `http://localhost:${be.port}${be.healthCheck}` : be.healthCheck;
    await waitForHttp(healthUrl, 60_000);
  } else {
    await waitForPort(be.port, 60_000);
  }

  onEvent({ type: "log", source: "sanjang", data: `Backend(:${be.port}) 시작 완료 ✓` });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

interface StartCampParams {
  name: string;
  fePort: number;
  /** Ports reserved by other camps — detected port must not collide with these */
  reservedPorts?: Set<number>;
}

export async function startCamp(pg: StartCampParams, onEvent: EventCallback): Promise<number> {
  const { name, fePort } = pg;
  const wtPath = campPath(name);
  const dev = projectConfig?.dev;

  if (!dev) throw new Error("dev command not configured");

  const entry: CampProcessEntry = {
    feProc: null,
    feLogs: [],
    feExitCode: null,
  };
  procs.set(name, entry);

  // Step 1: Backend (optional, shared)
  try {
    await ensureBackend(onEvent);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onEvent({ type: "log", source: "sanjang", data: `⚠️ Backend 시작 실패 — FE만 띄웁니다. (${message})` });
  }

  // Step 2: Frontend
  onEvent({ type: "log", source: "sanjang", data: "Frontend 준비 중..." });
  onEvent({ type: "status", data: "starting-frontend" });

  // Build command — try to pass port flag if available, but always verify via stdout
  // npm/yarn/pnpm run require "--" before flags to forward them to the underlying script
  const needsSeparator = dev.portFlag && /\b(npm|yarn|pnpm)\s+run\b/.test(dev.command);
  const fullCommand = dev.portFlag
    ? `${dev.command}${needsSeparator ? " --" : ""} ${dev.portFlag} ${fePort}`
    : dev.command;
  const cwd = dev.cwd ? join(wtPath, dev.cwd) : wtPath;

  const feProc = spawn(fullCommand, [], {
    cwd,
    env: {
      ...process.env,
      ...dev.env,
      ...(projectConfig?.backend
        ? {
            VITE_API_PROXY_TARGET: `http://localhost:${projectConfig.backend.port}`,
          }
        : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
    detached: true,
  });

  entry.feProc = feProc;
  attachLogs(feProc, entry.feLogs, "frontend", onEvent);
  feProc.on("exit", (code: number | null) => {
    entry.feExitCode = code;
    onEvent({ type: "process-exit", source: "frontend", data: code });
  });

  onEvent({ type: "status", data: "waiting-for-vite" });

  // Always detect actual URL from stdout — never guess
  const detectedPort = await detectPortFromStdout(entry.feLogs, 90_000);
  if (!detectedPort) {
    throw new Error("dev 서버가 시작되지 않았습니다. 로그를 확인하세요.");
  }

  // Validate: detected port must not collide with another camp's port
  if (pg.reservedPorts?.has(detectedPort)) {
    onEvent({
      type: "log",
      source: "sanjang",
      data: `⚠️ 포트 충돌 감지: dev 서버가 ${fePort} 대신 ${detectedPort}을 사용했고, 다른 캠프와 겹칩니다. 프로세스를 종료합니다.`,
    });
    stopCamp(name);
    throw new Error(
      `포트 충돌: dev 서버가 :${detectedPort}에 바인딩했지만, 다른 캠프가 이미 사용 중입니다. 해당 캠프를 정리하거나 포트를 확인하세요.`,
    );
  }

  if (detectedPort !== fePort) {
    onEvent({
      type: "log",
      source: "sanjang",
      data: `ℹ️ dev 서버가 요청한 포트(${fePort}) 대신 ${detectedPort}을 사용합니다.`,
    });
  }

  const url = `http://localhost:${detectedPort}`;
  onEvent({ type: "log", source: "sanjang", data: `Frontend 준비 완료 ✓` });
  onEvent({ type: "url-detected", data: { url, port: detectedPort } });
  onEvent({ type: "status", data: "running" });
  return detectedPort;
}

export function stopCamp(name: string): void {
  const entry = procs.get(name);
  if (!entry) return;
  if (entry.feProc && !entry.feProc.killed) {
    const pid = entry.feProc.pid;
    // Kill the entire process group (shell + children) — shell: true spawns
    // a shell wrapper, so SIGTERM on the shell alone leaves the child alive.
    if (pid) {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        // Process group may not exist; fall back to direct kill
        entry.feProc.kill("SIGTERM");
      }
    } else {
      entry.feProc.kill("SIGTERM");
    }
    // SIGKILL fallback if still alive after 5s
    const proc = entry.feProc;
    setTimeout(() => {
      try {
        if (!proc.killed && pid) process.kill(-pid, "SIGKILL");
        else if (!proc.killed) proc.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    }, 5000);
  }
  procs.delete(name);
}

export function stopAllCamps(): void {
  for (const [name] of procs) {
    stopCamp(name);
  }
  // Kill shared backend if tracked
  if (sharedBeProc && !sharedBeProc.killed) {
    try {
      sharedBeProc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    sharedBeProc = null;
  }
}

export function getProcessInfo(name: string): ProcessInfo | null {
  const entry = procs.get(name);
  if (!entry) return null;
  return {
    feLogs: entry.feLogs,
    feExitCode: entry.feExitCode,
  };
}
