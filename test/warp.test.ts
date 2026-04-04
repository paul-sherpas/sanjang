import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { detectWarp, removeLaunchConfig } from "../lib/engine/warp.ts";

describe("warp", () => {
  it("detectWarp returns object with installed boolean", () => {
    const result = detectWarp();
    assert.equal(typeof result.installed, "boolean");
  });

  it("removeLaunchConfig does nothing (no-op)", () => {
    // Should not throw
    removeLaunchConfig("nonexistent-camp");
  });
});
