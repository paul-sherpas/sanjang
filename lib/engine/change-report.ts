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
    categoryDetails: null,
  };
}

/**
 * Enrich a ChangeReport with AI-generated category-level descriptions.
 * Each category gets human-readable bullet points explaining what changed.
 * Tries `claude -p --model haiku` and falls back to file-based summary.
 */
export function generateReportSummary(diffStat: string, diff: string, report: ChangeReport): ChangeReport {
  const categoryNames: Record<string, string> = {
    ui: "화면",
    api: "서버/API",
    config: "설정",
    test: "테스트",
    docs: "문서",
    other: "기타",
  };

  const categoryList = Object.keys(report.byCategory)
    .map((cat) => `${categoryNames[cat] || cat}: ${(report.byCategory[cat] ?? []).length}개`)
    .join(", ");

  const fallbackSummary = `${categoryList} 변경`;

  // Build per-category diff sections for the prompt
  const categoryDiffSections = Object.entries(report.byCategory)
    .map(([cat, files]) => {
      const fileList = files.map((f) => `  ${f.status} ${f.path}`).join("\n");
      return `[${categoryNames[cat] || cat}]\n${fileList}`;
    })
    .join("\n\n");

  const prompt = `너는 비개발자에게 코드 변경사항을 설명하는 도우미야.
아래 git diff를 분석하고, 카테고리별로 "실제로 뭐가 바뀌었는지"를 설명해.

규칙:
- 파일명이 아니라 사용자 관점에서 뭐가 바뀌었는지 설명 (예: "로그인 버튼이 보라색으로 바뀌었어요")
- 각 항목은 한국어, '~했어요/~됐어요' 체, 한 줄
- 새 파일이면 "추가됐어요", 수정이면 구체적으로 뭐가 바뀌었는지

카테고리별 파일:
${categoryDiffSections}

diff:
${diff.slice(0, 4000)}

JSON으로만 응답해 (다른 텍스트 없이):
{"summary": "전체 한 줄 요약 (30자 이내)", "categories": {"ui": ["설명1", "설명2"], "api": ["설명1"], ...}}

categories의 키는 반드시 다음 중 하나: ${Object.keys(report.byCategory).join(", ")}`;

  try {
    const result = spawnSync("claude", ["-p", "--model", "claude-haiku-4-5", "--output-format", "text"], {
      input: prompt,
      encoding: "utf8",
      timeout: 15_000,
    });

    if (result.status === 0 && result.stdout) {
      const output = result.stdout.trim();
      const jsonMatch = output.match(/\{[\s\S]*"summary"[\s\S]*"categories"[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as {
          summary?: string;
          categories?: Record<string, string[]>;
        };
        if (parsed.summary && parsed.categories) {
          return {
            ...report,
            summary: parsed.summary,
            humanDescription: null,
            categoryDetails: parsed.categories,
          };
        }
      }
    }
  } catch {
    // Fall through to fallback
  }

  // Fallback: 파일 기반 설명 생성
  const fallbackDetails: Record<string, string[]> = {};
  for (const [cat, files] of Object.entries(report.byCategory)) {
    fallbackDetails[cat] = files.map((f) => {
      const name = f.path.split("/").pop() || f.path;
      return f.status === "새 파일" ? `${name} 파일이 추가됐어요` : `${name} 파일이 수정됐어요`;
    });
  }

  return {
    ...report,
    summary: fallbackSummary,
    humanDescription: null,
    categoryDetails: fallbackDetails,
  };
}
