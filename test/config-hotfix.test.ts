import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { suggestConfigFix, applyConfigFix, type ConfigFix } from "../lib/engine/config-hotfix.ts";

describe("config-hotfix — suggestConfigFix", () => {
  it("detects missing env from PUBLIC_* export error", () => {
    // Create a project with .env files so deepFindEnvFiles returns them
    const dir = mkdtempSync(join(tmpdir(), "sanjang-hotfix-"));
    writeFileSync(join(dir, ".env"), "PUBLIC_API_URL=http://localhost");
    writeFileSync(join(dir, ".env.local"), "PUBLIC_SECRET=xxx");

    const logs = [
      "The requested module '/@id/__x00__virtual:env/static/public' does not provide an export named 'PUBLIC_API_URL'",
    ];

    const fix = suggestConfigFix(dir, logs);
    assert.ok(fix, "should return a fix");
    assert.equal(fix.type, "add-copyfiles");
    assert.ok(Array.isArray(fix.patch.copyFiles));
    const files = fix.patch.copyFiles as string[];
    assert.ok(files.includes(".env"));
    assert.ok(files.includes(".env.local"));

    rmSync(dir, { recursive: true, force: true });
  });

  it("returns info fix for port-in-use", () => {
    const dir = mkdtempSync(join(tmpdir(), "sanjang-hotfix-"));
    const logs = ["Port 3000 is in use, trying another one"];

    const fix = suggestConfigFix(dir, logs);
    assert.ok(fix, "should return a fix");
    assert.equal(fix.type, "info");
    assert.equal(fix.patch._conflictPort, 3000);

    rmSync(dir, { recursive: true, force: true });
  });

  it("returns update-setup fix for missing module", () => {
    const dir = mkdtempSync(join(tmpdir(), "sanjang-hotfix-"));
    const logs = ["Error: Cannot find module 'express'", "at Module._resolveFilename"];

    const fix = suggestConfigFix(dir, logs);
    assert.ok(fix, "should return a fix");
    assert.equal(fix.type, "update-setup");
    assert.equal(fix.patch._missingModule, "express");

    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null for clean logs", () => {
    const dir = mkdtempSync(join(tmpdir(), "sanjang-hotfix-"));
    const logs = ["VITE v8.0.2  ready in 597 ms", "Local:   http://localhost:3002/"];

    const fix = suggestConfigFix(dir, logs);
    assert.equal(fix, null);

    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when PUBLIC_* error but no env files exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "sanjang-hotfix-"));
    const logs = [
      "does not provide an export named 'PUBLIC_API_URL'",
    ];

    const fix = suggestConfigFix(dir, logs);
    // No env files found → the pattern matches but buildFix returns null
    assert.equal(fix, null);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("config-hotfix — applyConfigFix", () => {
  it("adds copyFiles to config without existing copyFiles", () => {
    const dir = mkdtempSync(join(tmpdir(), "sanjang-hotfix-"));
    const configContent = [
      "export default {",
      "  dev: {",
      "    command: 'npx vite dev',",
      "    port: 5173,",
      "    portFlag: '--port',",
      "    cwd: '.',",
      "  },",
      "  setup: 'npm install',",
      "};",
      "",
    ].join("\n");
    writeFileSync(join(dir, "sanjang.config.js"), configContent);

    const fix: ConfigFix = {
      type: "add-copyfiles",
      description: "환경변수 참조 오류",
      patch: { copyFiles: [".env", ".env.local"] },
    };

    const result = applyConfigFix(dir, fix);
    assert.equal(result, true);

    const updated = readFileSync(join(dir, "sanjang.config.js"), "utf8");
    assert.ok(updated.includes("copyFiles: ['.env', '.env.local']"));

    rmSync(dir, { recursive: true, force: true });
  });

  it("merges into existing copyFiles without duplicates", () => {
    const dir = mkdtempSync(join(tmpdir(), "sanjang-hotfix-"));
    const configContent = [
      "export default {",
      "  dev: {",
      "    command: 'npx vite dev',",
      "    port: 5173,",
      "  },",
      "  copyFiles: ['.env'],",
      "};",
      "",
    ].join("\n");
    writeFileSync(join(dir, "sanjang.config.js"), configContent);

    const fix: ConfigFix = {
      type: "add-copyfiles",
      description: "env 추가",
      patch: { copyFiles: [".env", ".env.local"] },
    };

    const result = applyConfigFix(dir, fix);
    assert.equal(result, true);

    const updated = readFileSync(join(dir, "sanjang.config.js"), "utf8");
    assert.ok(updated.includes("copyFiles: ['.env', '.env.local']"));
    // Exactly two entries: '.env' and '.env.local'
    const entries = updated.match(/copyFiles:\s*\[([^\]]*)\]/);
    assert.ok(entries);
    const items = entries[1]!.split(",").map((s) => s.trim()).filter(Boolean);
    assert.equal(items.length, 2);

    rmSync(dir, { recursive: true, force: true });
  });

  it("returns false when config file does not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "sanjang-hotfix-"));

    const fix: ConfigFix = {
      type: "add-copyfiles",
      description: "test",
      patch: { copyFiles: [".env"] },
    };

    const result = applyConfigFix(dir, fix);
    assert.equal(result, false);

    rmSync(dir, { recursive: true, force: true });
  });

  it("returns false for info-type fixes (nothing to write)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sanjang-hotfix-"));
    writeFileSync(join(dir, "sanjang.config.js"), "export default {};");

    const fix: ConfigFix = {
      type: "info",
      description: "port conflict",
      patch: { _conflictPort: 3000 },
    };

    const result = applyConfigFix(dir, fix);
    assert.equal(result, false);

    rmSync(dir, { recursive: true, force: true });
  });

  it("returns false for update-setup fixes (requires user input)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sanjang-hotfix-"));
    writeFileSync(join(dir, "sanjang.config.js"), "export default {};");

    const fix: ConfigFix = {
      type: "update-setup",
      description: "missing module",
      patch: { _missingModule: "express" },
    };

    const result = applyConfigFix(dir, fix);
    assert.equal(result, false);

    rmSync(dir, { recursive: true, force: true });
  });
});
