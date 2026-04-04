import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, beforeEach, afterEach } from "node:test";

import { detectWarp, writeLaunchConfig, removeLaunchConfig } from "../lib/engine/warp.ts";

describe("warp", () => {
  it("detectWarp returns object with installed boolean", () => {
    const result = detectWarp();
    assert.equal(typeof result.installed, "boolean");
  });
});

describe("warp launch config", () => {
  // Use a temp dir to avoid touching real ~/.warp
  const testDir = join(tmpdir(), `sanjang-warp-test-${Date.now()}`);
  const origHome = process.env["HOME"];

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    process.env["HOME"] = testDir;
  });

  afterEach(() => {
    process.env["HOME"] = origHome;
    rmSync(testDir, { recursive: true, force: true });
  });

  it("writeLaunchConfig creates YAML file with camp name and path", () => {
    writeLaunchConfig("my-camp", "/path/to/worktree");
    const configPath = join(testDir, ".warp", "launch_configurations", "sanjang-my-camp.yaml");
    assert.ok(existsSync(configPath), "launch config file should exist");

    const content = readFileSync(configPath, "utf8");
    assert.ok(content.includes("sanjang-my-camp"), "should contain launch config name");
    assert.ok(content.includes("my-camp"), "should contain camp name in title");
    assert.ok(content.includes("/path/to/worktree"), "should contain worktree path");
  });

  it("removeLaunchConfig deletes the config file", () => {
    writeLaunchConfig("delete-me", "/path/to/worktree");
    const configPath = join(testDir, ".warp", "launch_configurations", "sanjang-delete-me.yaml");
    assert.ok(existsSync(configPath), "file should exist before removal");

    removeLaunchConfig("delete-me");
    assert.ok(!existsSync(configPath), "file should not exist after removal");
  });

  it("removeLaunchConfig does nothing if file doesn't exist", () => {
    // Should not throw
    removeLaunchConfig("nonexistent-camp");
  });
});
