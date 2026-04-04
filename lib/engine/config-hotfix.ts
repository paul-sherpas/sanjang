import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deepFindEnvFiles } from "./smart-init.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConfigFix {
  type: "add-copyfiles" | "update-setup" | "info";
  description: string;
  patch: Record<string, unknown>; // the values to add/change
}

// ---------------------------------------------------------------------------
// Pattern matchers
// ---------------------------------------------------------------------------

interface PatternMatcher {
  test: RegExp;
  buildFix: (projectRoot: string, match: RegExpMatchArray) => ConfigFix | null;
}

const PATTERNS: PatternMatcher[] = [
  {
    // SvelteKit / Vite: "does not provide an export named 'PUBLIC_*'"
    test: /does not provide an export named '(PUBLIC_\w+)'/,
    buildFix(projectRoot: string, _match: RegExpMatchArray): ConfigFix | null {
      const envFiles = deepFindEnvFiles(projectRoot).filter(
        (f) => !f.includes("example") && !f.includes("template") && !f.includes(".test"),
      );
      if (envFiles.length === 0) return null;
      return {
        type: "add-copyfiles",
        description: `환경변수 참조 오류 — copyFiles에 ${envFiles.join(", ")}을 추가합니다.`,
        patch: { copyFiles: envFiles },
      };
    },
  },
  {
    // Port mismatch: "Port X is in use, trying another one"
    test: /Port (\d+) is in use/,
    buildFix(_projectRoot: string, match: RegExpMatchArray): ConfigFix | null {
      const port = match[1];
      return {
        type: "info",
        description: `포트 ${port}이(가) 이미 사용 중입니다. 다른 캠프가 실행 중인지 확인하세요.`,
        patch: { _conflictPort: Number(port) },
      };
    },
  },
  {
    // Module not found after fresh install → setup command might be wrong
    test: /Cannot find module '([^']+)'/,
    buildFix(_projectRoot: string, match: RegExpMatchArray): ConfigFix | null {
      const moduleName = match[1];
      return {
        type: "update-setup",
        description: `모듈 '${moduleName}'을(를) 찾을 수 없습니다. setup 명령이 올바른지 확인하세요.`,
        patch: { _missingModule: moduleName },
      };
    },
  },
];

// ---------------------------------------------------------------------------
// suggestConfigFix — analyze logs and return a fix, or null
// ---------------------------------------------------------------------------

export function suggestConfigFix(projectRoot: string, logs: string[]): ConfigFix | null {
  const combined = logs.join("\n");

  for (const pattern of PATTERNS) {
    const match = combined.match(pattern.test);
    if (match) {
      const fix = pattern.buildFix(projectRoot, match);
      if (fix) return fix;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// applyConfigFix — modify sanjang.config.js in place
// ---------------------------------------------------------------------------

const CONFIG_FILE = "sanjang.config.js";

export function applyConfigFix(projectRoot: string, fix: ConfigFix): boolean {
  const configPath = join(projectRoot, CONFIG_FILE);
  if (!existsSync(configPath)) return false;

  let content: string;
  try {
    content = readFileSync(configPath, "utf8");
  } catch {
    return false;
  }

  switch (fix.type) {
    case "add-copyfiles": {
      const newFiles = fix.patch.copyFiles as string[];
      if (!newFiles || newFiles.length === 0) return false;
      content = mergeCopyFiles(content, newFiles);
      break;
    }
    case "update-setup": {
      // Informational — we don't auto-change setup without explicit user input
      return false;
    }
    case "info": {
      // Purely informational, nothing to write
      return false;
    }
    default:
      return false;
  }

  try {
    writeFileSync(configPath, content, "utf8");
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Merge new file paths into the existing copyFiles array inside the config
 * source text.  If copyFiles doesn't exist, insert it before the closing `};`.
 */
function mergeCopyFiles(source: string, newFiles: string[]): string {
  // Try to find existing copyFiles: [...]
  const copyFilesRe = /copyFiles:\s*\[([^\]]*)\]/;
  const match = source.match(copyFilesRe);

  if (match) {
    // Parse existing entries
    const existing = match[1]!
      .split(",")
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean);

    const merged = [...new Set([...existing, ...newFiles])];
    const formatted = merged.map((f) => `'${f}'`).join(", ");
    return source.replace(copyFilesRe, `copyFiles: [${formatted}]`);
  }

  // No copyFiles field — insert before the last `};`
  const formatted = newFiles.map((f) => `'${f}'`).join(", ");
  const insertion = `  copyFiles: [${formatted}],\n`;

  const closingIdx = source.lastIndexOf("};");
  if (closingIdx === -1) return source; // malformed config, bail

  return source.slice(0, closingIdx) + insertion + source.slice(closingIdx);
}
