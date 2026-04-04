/**
 * Task suggestion engine.
 *
 * Aggregates open issues, PRs, and recent git activity to surface
 * actionable suggestions on the dashboard — no LLM required.
 */

import { spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Suggestion {
  type: "issue" | "pr" | "recent";
  title: string;
  detail?: string;
  action?: string; // e.g., branch name to create camp from
}

interface GhIssue {
  number: number;
  title: string;
  labels: Array<{ name: string }>;
}

interface GhPr {
  number: number;
  title: string;
  headRefName: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 10_000;

/**
 * Async spawn wrapper — resolves with stdout or rejects on timeout / error.
 */
function run(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Command timed out: ${cmd} ${args.join(" ")}`));
    }, TIMEOUT_MS);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`Exit ${code}: ${stderr || stdout}`));
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Data fetchers
// ---------------------------------------------------------------------------

async function fetchIssues(cwd: string): Promise<Suggestion[]> {
  const raw = await run(
    "gh",
    ["issue", "list", "--state", "open", "--limit", "5", "--json", "number,title,labels"],
    cwd,
  );
  const issues: GhIssue[] = JSON.parse(raw);
  return issues.map((i) => {
    const labelStr = i.labels.map((l) => l.name).join(", ");
    return {
      type: "issue" as const,
      title: `#${i.number} ${i.title}`,
      detail: labelStr || undefined,
    };
  });
}

async function fetchMyPrs(cwd: string): Promise<Suggestion[]> {
  const raw = await run(
    "gh",
    ["pr", "list", "--state", "open", "--author", "@me", "--limit", "3", "--json", "number,title,headRefName"],
    cwd,
  );
  const prs: GhPr[] = JSON.parse(raw);
  return prs.map((p) => ({
    type: "pr" as const,
    title: `#${p.number} ${p.title}`,
    detail: p.headRefName,
    action: p.headRefName,
  }));
}

async function fetchRecentCommits(cwd: string): Promise<Suggestion[]> {
  const raw = await run("git", ["log", "--oneline", "-10"], cwd);
  const lines = raw.trim().split("\n").filter(Boolean);
  return lines.map((line) => {
    const spaceIdx = line.indexOf(" ");
    const hash = spaceIdx > 0 ? line.slice(0, spaceIdx) : line;
    const msg = spaceIdx > 0 ? line.slice(spaceIdx + 1) : "";
    return {
      type: "recent" as const,
      title: msg || hash,
      detail: hash,
    };
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Suggest tasks the user might work on next.
 *
 * Aggregates data from GitHub (issues, PRs) and git (recent commits).
 * If `gh` CLI is unavailable, returns git-based suggestions only.
 *
 * Results are sorted by relevance: PRs (이어하기) > Issues (이슈) > Recent (최근 작업).
 */
export async function suggestTasks(projectRoot: string): Promise<Suggestion[]> {
  const results: Suggestion[] = [];

  // gh-dependent fetches — tolerate failure (gh not installed / no repo)
  const [issues, prs] = await Promise.allSettled([fetchIssues(projectRoot), fetchMyPrs(projectRoot)]);

  // PRs first — most actionable ("이어하기")
  if (prs.status === "fulfilled") {
    results.push(...prs.value);
  }

  // Issues next ("이슈")
  if (issues.status === "fulfilled") {
    results.push(...issues.value);
  }

  // Recent commits always available ("최근 작업")
  try {
    const recent = await fetchRecentCommits(projectRoot);
    results.push(...recent);
  } catch {
    // No git history — return whatever we have
  }

  return results;
}
