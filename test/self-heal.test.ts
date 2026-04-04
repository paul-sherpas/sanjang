import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { diagnoseFromLogs, type HealAction } from "../lib/engine/self-heal.ts";

describe("self-heal — diagnoseFromLogs", () => {
  it("detects MODULE_NOT_FOUND", () => {
    const logs = ["Error: Cannot find module 'express'", "at Module._resolveFilename"];
    const actions = diagnoseFromLogs(logs);
    assert.ok(actions.some(a => a.type === "reinstall"));
  });

  it("detects missing env variable", () => {
    const logs = [
      "The requested module '/@id/__x00__virtual:env/static/public' does not provide an export named 'PUBLIC_API_URL'"
    ];
    const actions = diagnoseFromLogs(logs);
    assert.ok(actions.some(a => a.type === "copy-env"));
  });

  it("detects 403 forbidden (symlink issue)", () => {
    const logs = ["Failed to load resource: the server responded with a status of 403 (Forbidden)"];
    const actions = diagnoseFromLogs(logs);
    assert.ok(actions.some(a => a.type === "reinstall"));
  });

  it("detects port already in use", () => {
    const logs = ["Error: listen EADDRINUSE: address already in use :::3000"];
    const actions = diagnoseFromLogs(logs);
    assert.ok(actions.some(a => a.type === "restart"));
  });

  it("returns empty for clean logs", () => {
    const logs = ["VITE v8.0.2  ready in 597 ms", "Local:   http://localhost:3002/"];
    const actions = diagnoseFromLogs(logs);
    assert.equal(actions.length, 0);
  });

  it("detects ENOENT for missing file", () => {
    const logs = ["ENOENT: no such file or directory, open '/path/to/.env'"];
    const actions = diagnoseFromLogs(logs);
    assert.ok(actions.some(a => a.type === "copy-env"));
  });
});
