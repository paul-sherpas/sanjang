import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Type-only imports — verify the module exports compile correctly
import type {
  BroadcastMessage,
  CacheApplyResult,
  CacheBuildResult,
  CacheValidation,
  Camp,
  DetectedApp,
  DetectedProject,
  DevConfig,
  DiagnosticsResult,
  EventCallback,
  GenerateConfigResult,
  LockfileInfo,
  PortAllocation,
  PortStatus,
  SanjangConfig,
  SnapshotInfo,
} from "../lib/types.ts";

describe("types", () => {
  it("Camp interface satisfies expected shape", () => {
    const camp: Camp = {
      name: "test",
      branch: "main",
      slot: 1,
      fePort: 3001,
      bePort: 8001,
      status: "stopped",
    };
    assert.equal(camp.name, "test");
    assert.equal(camp.status, "stopped");
  });

  it("SanjangConfig interface satisfies expected shape", () => {
    const config: SanjangConfig = {
      dev: { command: "npm run dev", port: 3000, portFlag: "--port", cwd: ".", env: {} },
      setup: "npm install",
      copyFiles: [".env"],
      backend: null,
      ports: { fe: { base: 3000, slots: 8 }, be: { base: 8000, slots: 8 } },
    };
    assert.equal(config.dev.command, "npm run dev");
    assert.equal(config.setup, "npm install");
  });

  it("CacheApplyResult interface works for both success and failure", () => {
    const success: CacheApplyResult = { applied: true, duration: 150, count: 3 };
    const failure: CacheApplyResult = { applied: false, reason: "cache not found" };
    assert.equal(success.applied, true);
    assert.equal(failure.applied, false);
  });

  it("PortAllocation interface satisfies expected shape", () => {
    const alloc: PortAllocation = { slot: 1, fePort: 3001, bePort: 8001 };
    assert.equal(alloc.slot, 1);
  });
});
