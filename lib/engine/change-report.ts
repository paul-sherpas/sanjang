import { spawnSync } from "node:child_process";
import { basename, extname } from "node:path";

import type { ChangeReport, ChangeReportFile, ChangeReportWarning } from "../types.ts";

type FileCategory = "ui" | "api" | "config" | "test" | "docs" | "other";

/**
 * Classify a file path into one of the known categories.
 * Rules are checked in priority order: test > ui > api > docs > config > other
 */
export function categorizeFile(filePath: string): FileCategory {
  const name = basename(filePath);
  const ext = extname(filePath).toLowerCase();
  const lower = filePath.toLowerCase();

  // 1. test
  if (/\.(test|spec)\.[^.]+$/.test(lower)) return "test";
  if (/[/\\](test|tests|__tests__|__mocks__|fixtures)[/\\]/.test(lower)) return "test";
  if (/^(test|tests|__tests__|__mocks__|fixtures)[/\\]/.test(lower)) return "test";

  // 2. ui
  const uiExts = new Set([
    ".css",
    ".scss",
    ".less",
    ".sass",
    ".styl",
    ".html",
    ".htm",
    ".svg",
    ".tsx",
    ".jsx",
    ".vue",
    ".svelte",
  ]);
  if (uiExts.has(ext)) return "ui";
  if (/[/\\](pages|views|components|layouts|styles|public)[/\\]/.test(lower)) return "ui";
  if (/^(pages|views|components|layouts|styles|public)[/\\]/.test(lower)) return "ui";

  // 3. api
  if (/[/\\](api|routes|controllers|handlers|middleware|graphql|resolvers|schema)[/\\]/.test(lower)) return "api";
  if (/^(api|routes|controllers|handlers|middleware|graphql|resolvers|schema)[/\\]/.test(lower)) return "api";
  // files named "server" (any extension)
  if (/[/\\]server\.[^/\\]+$/.test(lower) || /^server\.[^/\\]+$/.test(lower)) return "api";

  // 4. docs
  if (ext === ".md") return "docs";
  if (/[/\\]docs[/\\]/.test(lower) || /^docs[/\\]/.test(lower)) return "docs";
  if (/^(README|CHANGELOG|LICENSE|CONTRIBUTING)(\.|$)/i.test(name)) return "docs";

  // 5. config
  const configPrefixes = [
    "package",
    "tsconfig",
    "jest.config",
    "vite.config",
    "next.config",
    "webpack.config",
    "biome",
    ".eslint",
    ".prettier",
    ".babel",
  ];
  const nameLower = name.toLowerCase();
  if (configPrefixes.some((p) => nameLower.startsWith(p.toLowerCase()))) return "config";
  if (name.startsWith(".")) return "config";
  if ([".json", ".yaml", ".yml", ".toml"].includes(ext)) return "config";

  // 6. other
  return "other";
}

/**
 * Detect warnings from a list of categorized files.
 * Returns deduplicated warnings (one per type).
 */
export function detectWarnings(files: ChangeReportFile[]): ChangeReportWarning[] {
  const seen = new Set<string>();
  const warnings: ChangeReportWarning[] = [];

  const add = (type: ChangeReportWarning["type"], message: string, file: string) => {
    if (seen.has(type)) return;
    seen.add(type);
    warnings.push({ type, message, file });
  };

  for (const f of files) {
    const p = f.path.toLowerCase();
    const name = basename(f.path);

    // env
    if (/\.env($|\.)/.test(name.toLowerCase())) {
      add("env", "환경 변수 파일이 변경되었습니다", f.path);
    }

    // db
    if (/migrat|schema|\.sql|prisma/.test(p)) {
      add("db", "데이터베이스 스키마 또는 마이그레이션이 변경되었습니다", f.path);
    }

    // infra
    if (/dockerfile|docker-compose|\.github\/|deploy\/|[/\\]k8s[/\\]|^k8s[/\\]|terraform|infrastructure/.test(p)) {
      add("infra", "인프라 설정이 변경되었습니다", f.path);
    }

    // config (package manager files)
    if (/package\.json|package-lock|yarn\.lock|pnpm-lock/.test(p)) {
      add("config", "패키지 의존성이 변경되었습니다", f.path);
    }

    // security
    if (/auth|security|token|secret|credential|password/.test(p)) {
      add("security", "보안 관련 파일이 변경되었습니다", f.path);
    }
  }

  return warnings;
}

/**
 * Build a ChangeReport from raw file list (path + status).
 * summary and humanDescription are set to null — call generateReportSummary to enrich.
 */
export function buildChangeReport(rawFiles: { path: string; status: ChangeReportFile["status"] }[]): ChangeReport {
  const files: ChangeReportFile[] = rawFiles.map((f) => ({
    path: f.path,
    status: f.status,
    category: categorizeFile(f.path),
  }));

  const byCategory: Record<string, ChangeReportFile[]> = {};
  for (const f of files) {
    const cat = f.category;
    if (!byCategory[cat]) byCategory[cat] = [];
    (byCategory[cat] as ChangeReportFile[]).push(f);
  }

  const warnings = detectWarnings(files);

  return {
    files,
    totalCount: files.length,
    byCategory,
    warnings,
    summary: null,
    humanDescription: null,
  };
}

/**
 * Enrich a ChangeReport with AI-generated summary and human description.
 * Tries `claude -p --model haiku` and falls back to category-based string.
 */
export function generateReportSummary(diffStat: string, diff: string, report: ChangeReport): ChangeReport {
  const categoryList = Object.keys(report.byCategory)
    .map((cat) => `${cat}: ${(report.byCategory[cat] ?? []).length}개`)
    .join(", ");

  const fallbackSummary = `총 ${report.totalCount}개 파일 변경 (${categoryList})`;

  // Try AI summary via claude CLI
  const prompt = `다음 git diff 통계와 변경 파일 목록을 분석하여 JSON으로 응답하세요.
반드시 다음 형식의 JSON만 응답하세요 (다른 텍스트 없이):
{"summary": "한 줄 요약 (50자 이내)", "description": "개발자용 변경 내용 설명 (100자 이내)"}

diff stat:
${diffStat}

변경 파일 (${report.totalCount}개):
${report.files.map((f) => `  ${f.status} ${f.path} [${f.category}]`).join("\n")}

경고: ${report.warnings.map((w) => w.type).join(", ") || "없음"}

diff (일부):
${diff.slice(0, 2000)}`;

  try {
    const result = spawnSync("claude", ["-p", "--model", "claude-haiku-4-5", "--output-format", "text"], {
      input: prompt,
      encoding: "utf8",
      timeout: 10000,
    });

    if (result.status === 0 && result.stdout) {
      const output = result.stdout.trim();
      // Extract JSON from output (may have surrounding text)
      const jsonMatch = output.match(/\{[\s\S]*"summary"[\s\S]*"description"[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as { summary?: string; description?: string };
        if (parsed.summary && parsed.description) {
          return {
            ...report,
            summary: parsed.summary,
            humanDescription: parsed.description,
          };
        }
      }
    }
  } catch {
    // Fall through to fallback
  }

  return {
    ...report,
    summary: fallbackSummary,
    humanDescription: fallbackSummary,
  };
}
