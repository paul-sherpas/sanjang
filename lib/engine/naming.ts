import { spawnSync } from "node:child_process";

/**
 * Generate a short English slug from a task description using AI.
 * Returns null if AI is unavailable — caller should fallback to slugify().
 */
export function aiSlugify(description: string): string | null {
  try {
    const result = spawnSync(
      "claude",
      ["-p", "--model", "haiku", `Convert this task description to a short kebab-case English slug (2-4 words, max 30 chars, lowercase, no explanation, just the slug):\n\n"${description}"`],
      { encoding: "utf8", stdio: "pipe", timeout: 10_000 },
    );
    if (result.status !== 0) return null;
    const slug = (result.stdout ?? "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "").replace(/^-+|-+$/g, "");
    if (!slug || slug.length > 30) return null;
    return slug;
  } catch {
    return null;
  }
}

// Korean → romanized mappings for common dev terms
const KOREAN_MAP: Record<string, string> = {
  로그인: "login",
  버튼: "button",
  페이지: "page",
  추가: "add",
  수정: "fix",
  삭제: "delete",
  변경: "change",
  개선: "improve",
  색상: "color",
  대시보드: "dashboard",
  설정: "settings",
  사용자: "user",
  관리: "manage",
  목록: "list",
  검색: "search",
  필터: "filter",
  정렬: "sort",
  알림: "notification",
  권한: "permission",
  기기: "device",
  소프트웨어: "software",
  자산: "asset",
  구성원: "member",
  보고서: "report",
  차트: "chart",
  테이블: "table",
  폼: "form",
  모달: "modal",
  메뉴: "menu",
  헤더: "header",
  푸터: "footer",
  사이드바: "sidebar",
  카드: "card",
  탭: "tab",
  에러: "error",
  로딩: "loading",
  빈: "empty",
  새: "new",
  기존: "existing",
};

/**
 * Convert a task description (Korean or English) to a kebab-case branch-safe slug.
 * Max 50 chars.
 */
export function slugify(text: string): string {
  let result: string = text.toLowerCase();

  // Replace known Korean words with English
  for (const [ko, en] of Object.entries(KOREAN_MAP)) {
    result = result.replaceAll(ko, en);
  }

  // Remove remaining non-ASCII (unmapped Korean etc.)
  result = result.replace(/[^\x00-\x7F]/g, "");

  // Replace non-alphanumeric with hyphens
  result = result.replace(/[^a-z0-9]+/g, "-");

  // Clean up leading/trailing/double hyphens
  result = result.replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-");

  // Truncate to 50 chars at word boundary
  if (result.length > 50) {
    result = result.slice(0, 50).replace(/-[^-]*$/, "");
  }

  return result || "camp";
}
