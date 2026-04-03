import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addWorktree, campPath, listBranches, removeWorktree, setProjectRoot } from "../lib/engine/worktree.ts";

describe("worktree", () => {
  it("exports expected functions", () => {
    assert.equal(typeof setProjectRoot, "function");
    assert.equal(typeof campPath, "function");
    assert.equal(typeof listBranches, "function");
    assert.equal(typeof addWorktree, "function");
    assert.equal(typeof removeWorktree, "function");
  });
});
