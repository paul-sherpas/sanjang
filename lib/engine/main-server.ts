/**
 * Main branch dev server manager.
 * Runs a dev server from the project root for side-by-side comparison preview.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createConnection } from "node:net";
import type { SanjangConfig } from "../types.ts";

interface MainServerState {
  status: "stopped" | "starting" | "running" | "error";
  port: number | null;
  error: string | null;
}

let state: MainServerState = { status: "stopped", port: null, error: null };
let proc: ChildProcess | null = null;
let logs: string[] = [];

export function getMainServerState(): MainServerState {
  return { ...state };
}

export function getMainServerLogs(): string[] {
  return [...logs];
}

export async function startMainServer(
  projectRoot: string,
  config: SanjangConfig,
  onReady?: (port: number) => void,
): Promise<void> {
  if (state.status === "running" || state.status === "starting") return;

  state = { status: "starting", port: null, error: null };
  logs = [];

  const basePort = config.dev.port + 100;

  // npm/yarn/pnpm run require "--" before flags to forward them to the script
  const needsSeparator = config.dev.portFlag && /\b(npm|yarn|pnpm)\s+run\b/.test(config.dev.command);
  const fullCommand = config.dev.portFlag
    ? `${config.dev.command}${needsSeparator ? " --" : ""} ${config.dev.portFlag} ${basePort}`
    : config.dev.command;

  const cwd = config.dev.cwd
    ? config.dev.cwd.startsWith("/")
      ? config.dev.cwd
      : `${projectRoot}/${config.dev.cwd}`
    : projectRoot;

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

  const detectedPort = await detectMainPort(logs, basePort, 30_000);
  if (detectedPort) {
    state = { status: "running", port: detectedPort, error: null };
    onReady?.(detectedPort);
  } else {
    // Cleanup on failure
    if (proc) {
      const pid = proc.pid;
      if (pid) { try { process.kill(-pid, "SIGTERM"); } catch {} }
      proc = null;
    }
    const lastLog = logs.slice(-5).join("\n").trim();
    state = { status: "error", port: null, error: lastLog || "포트를 감지하지 못했어요" };
  }
}

export function stopMainServer(): void {
  state = { status: "stopped", port: null, error: null };
  if (proc) {
    const pid = proc.pid;
    if (pid) {
      try { process.kill(-pid, "SIGTERM"); } catch { proc.kill("SIGTERM"); }
    } else {
      proc.kill("SIGTERM");
    }
    proc = null;
  }
  logs = [];
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
