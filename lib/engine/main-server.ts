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

  const cmdParts = config.dev.command.split(/\s+/);
  const cmd = cmdParts[0]!;
  const args = cmdParts.slice(1);

  if (config.dev.portFlag) {
    args.push(config.dev.portFlag, String(basePort));
  }

  const cwd = config.dev.cwd
    ? config.dev.cwd.startsWith("/")
      ? config.dev.cwd
      : `${projectRoot}/${config.dev.cwd}`
    : projectRoot;

  proc = spawn(cmd, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...config.dev.env, FORCE_COLOR: "0" },
    shell: true,
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

  const detectedPort = await detectMainPort(logs, basePort, 15_000);
  if (detectedPort) {
    state = { status: "running", port: detectedPort, error: null };
    onReady?.(detectedPort);
  } else {
    state = { status: "error", port: null, error: "포트를 감지하지 못했어요" };
  }
}

export function stopMainServer(): void {
  state = { status: "stopped", port: null, error: null };
  if (proc) {
    proc.kill("SIGTERM");
    proc = null;
  }
  logs = [];
}

function detectMainPort(logLines: string[], fallbackPort: number, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const portRe = /https?:\/\/localhost:(\d+)/;

    function check(): void {
      for (const line of logLines) {
        const match = portRe.exec(line);
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
