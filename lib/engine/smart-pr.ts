/**
 * Smart PR description generator.
 *
 * Uses `claude -p` to generate a human-readable PR description from the diff.
 * Falls back to a simple file-count summary when the CLI is unavailable.
 */

import { spawn, spawnSync } from "node:child_process";

const TIMEOUT_MS = 30_000;

interface SpawnResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

/**
 * Run a command asynchronously with a timeout.
 */
function run(cmd: string, args: string[], opts: { cwd: string; timeoutMs: number }): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, opts.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });

    child.on("error", () => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: null, timedOut });
    });
  });
}

/**
 * Parse diff --stat output to extract file count.
 * Example line: " 3 files changed, 10 insertions(+), 2 deletions(-)"
 */
export function parseDiffStatSummary(diffStat: string): string {
  const trimmed = diffStat.trim();
  if (!trimmed) return "변경사항이 없어요";

  const lines = trimmed.split("\n");
  const summaryLine = lines[lines.length - 1] ?? "";
  const filesMatch = /(\d+)\s+files?\s+changed/.exec(summaryLine);
  const insertMatch = /(\d+)\s+insertions?/.exec(summaryLine);
  const deleteMatch = /(\d+)\s+deletions?/.exec(summaryLine);

  const fileCount = filesMatch ? parseInt(filesMatch[1]!, 10) : 0;
  const insertions = insertMatch ? parseInt(insertMatch[1]!, 10) : 0;
  const deletions = deleteMatch ? parseInt(deleteMatch[1]!, 10) : 0;

  if (fileCount === 0) return "변경사항이 없어요";

  const parts: string[] = [`${fileCount}개 파일을 수정했어요`];
  if (insertions > 0 || deletions > 0) {
    parts.push(`(+${insertions}, -${deletions})`);
  }
  return parts.join(" ");
}

/**
 * Check if claude CLI is available on PATH.
 */
function isClaudeAvailable(): boolean {
  const result = spawnSync("which", ["claude"], { stdio: "pipe" });
  return result.status === 0;
}

/**
 * Generate a PR description for the given worktree path.
 *
 * 1. Runs `git diff --stat` and `git diff` in the worktree.
 * 2. If claude CLI is available, asks it to summarise in Korean.
 * 3. Falls back to a simple file-count summary otherwise.
 */
export async function generatePrDescription(wtPath: string): Promise<string> {
  // Gather diff info
  const [statResult, diffResult] = await Promise.all([
    run("git", ["diff", "--stat", "HEAD"], { cwd: wtPath, timeoutMs: 10_000 }),
    run("git", ["diff", "HEAD"], { cwd: wtPath, timeoutMs: 10_000 }),
  ]);

  const diffStat = statResult.stdout.trim();
  const diff = diffResult.stdout;

  if (!diffStat && !diff.trim()) {
    return "변경사항이 없어요";
  }

  // Try claude CLI
  if (isClaudeAvailable()) {
    const diffSnippet = diff.slice(0, 500);
    const prompt = `이 변경사항을 비개발자도 이해할 수 있게 한국어 2-3줄로 설명해줘:\n\n${diffStat}\n\n${diffSnippet}`;
    const claudeResult = await run("claude", ["-p", prompt, "--output-format", "text"], {
      cwd: wtPath,
      timeoutMs: TIMEOUT_MS,
    });

    if (claudeResult.code === 0 && claudeResult.stdout.trim()) {
      return claudeResult.stdout.trim();
    }
  }

  // Fallback
  return parseDiffStatSummary(diffStat);
}
