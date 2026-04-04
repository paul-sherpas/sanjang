import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// ---------------------------------------------------------------------------
// Deep env file scanner
// ---------------------------------------------------------------------------

const ENV_PATTERNS = [".env", ".env.local", ".env.development", ".env.development.local"];
const SKIP_DIRS = new Set(["node_modules", ".git", ".sanjang", "dist", "build", ".next", ".nuxt", ".svelte-kit"]);

export function deepFindEnvFiles(projectRoot: string, maxDepth: number = 4): string[] {
  const results: string[] = [];

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isFile() && ENV_PATTERNS.includes(entry.name)) {
        results.push(relative(projectRoot, join(dir, entry.name)));
      }
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
        walk(join(dir, entry.name), depth + 1);
      }
    }
  }

  walk(projectRoot, 0);
  return results.sort();
}

// ---------------------------------------------------------------------------
// Setup issue detector
// ---------------------------------------------------------------------------

export interface SetupIssue {
  type: "env-reference-no-file" | "bun-cache-skip" | "missing-lockfile" | "turbo-no-filter";
  message: string;
  fix?: string;
}

export function detectSetupIssues(projectRoot: string): SetupIssue[] {
  const issues: SetupIssue[] = [];

  // 1. Check for env variable references without .env files
  const hasEnvFile = ENV_PATTERNS.some((f) => existsSync(join(projectRoot, f)));
  if (!hasEnvFile) {
    const envRefFound = scanForEnvReferences(projectRoot);
    if (envRefFound) {
      issues.push({
        type: "env-reference-no-file",
        message: "코드에서 환경변수를 참조하지만 .env 파일이 없습니다.",
        fix: "프로젝트의 .env 파일을 찾아 copyFiles에 추가",
      });
    }
  }

  // 2. Check for bun (cache doesn't work with bun symlinks)
  if (existsSync(join(projectRoot, "bun.lock")) || existsSync(join(projectRoot, "bun.lockb"))) {
    issues.push({
      type: "bun-cache-skip",
      message: "bun 프로젝트는 캐시 대신 직접 설치합니다.",
    });
  }

  // 3. Check for missing lockfile
  const lockfiles = ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock"];
  if (!lockfiles.some((f) => existsSync(join(projectRoot, f)))) {
    issues.push({
      type: "missing-lockfile",
      message: "lockfile이 없습니다. 의존성 설치가 느릴 수 있습니다.",
      fix: "npm install 또는 bun install을 한 번 실행해주세요",
    });
  }

  // 4. Check for turbo without filter (multiple apps)
  if (existsSync(join(projectRoot, "turbo.json"))) {
    const appCount = countTurboApps(projectRoot);
    if (appCount > 1) {
      issues.push({
        type: "turbo-no-filter",
        message: `${appCount}개 앱이 감지됨. --filter 없이 실행하면 모든 앱이 동시에 시작됩니다.`,
        fix: "메인 앱에 --filter 적용",
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scanForEnvReferences(dir: string, depth: number = 0): boolean {
  if (depth > 3) return false;
  const envPatterns = /import\.meta\.env\.|process\.env\.|PUBLIC_|VITE_|NEXT_PUBLIC_/;

  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    if (entry.isFile() && /\.(ts|js|tsx|jsx|svelte|vue)$/.test(entry.name)) {
      try {
        const content = readFileSync(join(dir, entry.name), "utf8").slice(0, 5000);
        if (envPatterns.test(content)) return true;
      } catch {
        continue;
      }
    }
    if (
      entry.isDirectory() &&
      !SKIP_DIRS.has(entry.name) &&
      !entry.name.startsWith(".") &&
      entry.name !== "node_modules"
    ) {
      if (scanForEnvReferences(join(dir, entry.name), depth + 1)) return true;
    }
  }
  return false;
}

function countTurboApps(root: string): number {
  let count = 0;
  for (const dir of ["apps", "packages"]) {
    const base = join(root, dir);
    if (!existsSync(base)) continue;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pkgPath = join(base, entry.name, "package.json");
      if (!existsSync(pkgPath)) continue;
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
        const scripts = pkg.scripts as Record<string, string> | undefined;
        if (scripts?.dev) count++;
      } catch {}
    }
  }
  return count;
}
