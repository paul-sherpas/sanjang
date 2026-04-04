import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getMainServerState } from "../lib/engine/main-server.ts";

describe("main-server", () => {
  it("initial state is stopped", () => {
    const state = getMainServerState();
    assert.equal(state.status, "stopped");
    assert.equal(state.port, null);
    assert.equal(state.error, null);
  });
});
