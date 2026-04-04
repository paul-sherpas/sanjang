import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { suggestTasks, type Suggestion } from "../lib/engine/suggest.ts";

describe("suggestTasks", () => {
  it("returns an array", async () => {
    const results = await suggestTasks(process.cwd());
    assert.ok(Array.isArray(results), "should return an array");
  });

  it("returns recent commit suggestions even without gh CLI", async () => {
    // Even if gh is not available, git log should still work in this repo
    const results = await suggestTasks(process.cwd());
    const recentItems = results.filter((s: Suggestion) => s.type === "recent");
    assert.ok(recentItems.length > 0, "should have at least one recent commit suggestion");
  });

  it("Suggestion items have correct shape", async () => {
    const results = await suggestTasks(process.cwd());
    for (const item of results) {
      assert.ok(
        item.type === "issue" || item.type === "pr" || item.type === "recent",
        `type should be issue|pr|recent, got: ${item.type}`,
      );
      assert.ok(typeof item.title === "string", "title should be a string");
      if (item.detail !== undefined) {
        assert.ok(typeof item.detail === "string", "detail should be a string if present");
      }
      if (item.action !== undefined) {
        assert.ok(typeof item.action === "string", "action should be a string if present");
      }
    }
  });
});
