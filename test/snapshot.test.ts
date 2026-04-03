import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Snapshot tests require a real git worktree, so we just verify imports
describe("snapshot", () => {
  it("exports expected functions", async () => {
    const mod = await import("../lib/engine/snapshot.ts");
    assert.equal(typeof mod.saveSnapshot, "function");
    assert.equal(typeof mod.restoreSnapshot, "function");
    assert.equal(typeof mod.listSnapshots, "function");
  });
});
