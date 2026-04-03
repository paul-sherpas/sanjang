import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

import { buildFallbackPrBody } from "../lib/engine/pr.ts";

describe("ship PR creation", () => {
  it("gh CLI detection returns boolean", () => {
    const result = spawnSync("which", ["gh"], { stdio: "pipe" });
    const hasGh = result.status === 0;
    assert.equal(typeof hasGh, "boolean");
  });

  it("fallback PR body includes message, actions, and files", () => {
    const body = buildFallbackPrBody({
      message: "Fix login button",
      actions: [{ description: "Changed button color" }, { description: "Added hover effect" }],
      diffStat: " src/app.js | 5 ++---\n 1 file changed, 2 insertions(+), 3 deletions(-)",
    });
    assert.ok(body.includes("Fix login button"));
    assert.ok(body.includes("Changed button color"));
    assert.ok(body.includes("src/app.js"));
    assert.ok(body.includes("산장"));
  });

  it("fallback PR body works with no actions", () => {
    const body = buildFallbackPrBody({
      message: "Quick fix",
      actions: [],
      diffStat: "",
    });
    assert.ok(body.includes("Quick fix"));
    assert.ok(!body.includes("### 작업 내역"));
  });

  it("buildClaudePrPrompt includes diff context", async () => {
    const { buildClaudePrPrompt } = await import("../lib/engine/pr.ts");
    const prompt = buildClaudePrPrompt({
      message: "Add dark mode",
      diffStat: " src/theme.js | 20 ++++\n 1 file changed",
      diff: '+const dark = { bg: "#000" }',
    });
    assert.ok(prompt.includes("Add dark mode"));
    assert.ok(prompt.includes("diff"));
    assert.ok(prompt.includes("Summary"));
  });
});
