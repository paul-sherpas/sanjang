/**
 * Conflict detection and Claude-based resolution helpers.
 */

/**
 * Parse `git status --porcelain` output to find conflicted files.
 * Conflict markers: UU (both modified), AA (both added), DD, AU, UA, DU, UD
 */
export function parseConflictFiles(statusOutput: string | null | undefined): string[] {
  if (!statusOutput?.trim()) return [];
  return statusOutput
    .trim()
    .split("\n")
    .filter((line) => /^(UU|AA|DD|AU|UA|DU|UD)\s/.test(line))
    .map((line) => line.slice(3).trim());
}

/**
 * A single conflict section within a file.
 */
export interface ConflictSection {
  ours: string;
  theirs: string;
  startLine: number;
}

/**
 * Parse conflict markers from file content.
 * Returns an array of conflict sections found in the file.
 */
export function parseConflictSections(content: string): ConflictSection[] {
  const lines = content.split("\n");
  const sections: ConflictSection[] = [];
  let i = 0;

  while (i < lines.length) {
    if (lines[i]!.startsWith("<<<<<<<")) {
      const startLine = i + 1;
      const oursLines: string[] = [];
      const theirsLines: string[] = [];
      let inTheirs = false;
      i++;

      while (i < lines.length) {
        const line = lines[i]!;
        if (line.startsWith("=======")) {
          inTheirs = true;
        } else if (line.startsWith(">>>>>>>")) {
          break;
        } else if (inTheirs) {
          theirsLines.push(line);
        } else {
          oursLines.push(line);
        }
        i++;
      }

      sections.push({
        ours: oursLines.join("\n"),
        theirs: theirsLines.join("\n"),
        startLine,
      });
    }
    i++;
  }

  return sections;
}

/**
 * Build a Claude prompt to resolve merge conflicts.
 */
export function buildConflictPrompt(conflictFiles: string[]): string {
  return [
    "아래 파일들에 git merge 충돌이 발생했습니다.",
    "각 파일의 충돌 마커(<<<<<<< ======= >>>>>>>)를 읽고,",
    "두 버전의 의도를 모두 살려서 충돌을 해결해주세요.",
    "해결 후 충돌 마커는 완전히 제거해야 합니다.",
    "",
    "충돌 파일 목록:",
    ...conflictFiles.map((f) => `- ${f}`),
    "",
    "각 파일을 읽고 수정해주세요.",
  ].join("\n");
}
