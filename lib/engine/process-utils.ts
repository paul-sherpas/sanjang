import { type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/** Build the full dev command, handling npm/yarn/pnpm's `--` separator requirement */
export function buildDevCommand(command: string, portFlag: string | null | undefined, port: number): string {
  if (!portFlag) return command;
  const needsSeparator = /\b(npm|yarn|pnpm)\s+run\b/.test(command);
  return `${command}${needsSeparator ? " --" : ""} ${portFlag} ${port}`;
}

/** Kill a process and its entire process group (for shell: true + detached: true spawns) */
export function killProcessGroup(proc: ChildProcess): void {
  const pid = proc.pid;
  if (pid) {
    try { process.kill(-pid, "SIGTERM"); } catch { proc.kill("SIGTERM"); }
  } else {
    proc.kill("SIGTERM");
  }
}

/**
 * Detect actual port from dev server stdout logs by polling for a localhost URL.
 * Strips ANSI codes before matching. Verifies port is reachable via TCP probe.
 */
export function detectPortFromLogs(logs: string[], timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const portRe = /https?:\/\/localhost:(\d+)/;

    function check(): void {
      for (const line of logs) {
        const match = portRe.exec(stripAnsi(line));
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
