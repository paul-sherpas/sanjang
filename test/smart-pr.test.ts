import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseDiffStatSummary } from "../lib/engine/smart-pr.ts";

describe("smart PR description", () => {
  describe("parseDiffStatSummary (fallback)", () => {
    it("produces a reasonable description from diff stat", () => {
      const stat = [
        " src/app.ts  | 10 +++++-----",
        " src/util.ts |  3 +++",
        " README.md   |  2 +-",
        " 3 files changed, 10 insertions(+), 6 deletions(-)",
      ].join("\n");

      const result = parseDiffStatSummary(stat);
      assert.ok(result.includes("3개 파일을 수정했어요"));
      assert.ok(result.includes("+10"));
      assert.ok(result.includes("-6"));
    });

    it("handles single file change", () => {
      const stat = " index.ts | 1 +\n 1 file changed, 1 insertion(+)";
      const result = parseDiffStatSummary(stat);
      assert.ok(result.includes("1개 파일을 수정했어요"));
    });

    it("returns empty-change message for empty diff", () => {
      const result = parseDiffStatSummary("");
      assert.equal(result, "변경사항이 없어요");
    });

    it("returns empty-change message for whitespace-only input", () => {
      const result = parseDiffStatSummary("   \n  ");
      assert.equal(result, "변경사항이 없어요");
    });
  });
});
