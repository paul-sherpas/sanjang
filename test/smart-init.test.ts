import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { deepFindEnvFiles, detectSetupIssues } from "../lib/engine/smart-init.ts";

describe("smart-init — deepFindEnvFiles", () => {
  it("finds .env in project root", () => {
    const dir = mkdtempSync(join(tmpdir(), "sanjang-env-"));
    writeFileSync(join(dir, ".env"), "FOO=bar");
    const files = deepFindEnvFiles(dir);
    assert.ok(files.includes(".env"));
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds .env in nested apps/ directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "sanjang-env-"));
    mkdirSync(join(dir, "apps", "web"), { recursive: true });
    writeFileSync(join(dir, "apps", "web", ".env"), "API=http://localhost");
    writeFileSync(join(dir, "apps", "web", ".env.local"), "SECRET=xxx");
    const files = deepFindEnvFiles(dir);
    assert.ok(files.includes("apps/web/.env"));
    assert.ok(files.includes("apps/web/.env.local"));
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips node_modules and .sanjang", () => {
    const dir = mkdtempSync(join(tmpdir(), "sanjang-env-"));
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "pkg", ".env"), "bad");
    mkdirSync(join(dir, ".sanjang"), { recursive: true });
    writeFileSync(join(dir, ".sanjang", ".env"), "bad");
    writeFileSync(join(dir, ".env"), "good");
    const files = deepFindEnvFiles(dir);
    assert.equal(files.length, 1);
    assert.equal(files[0], ".env");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("smart-init — detectSetupIssues", () => {
  it("detects missing env files", () => {
    const dir = mkdtempSync(join(tmpdir(), "sanjang-issue-"));
    // Source code references PUBLIC_API_URL but no .env
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "config.ts"), 'const url = import.meta.env.PUBLIC_API_URL;');
    const issues = detectSetupIssues(dir);
    assert.ok(issues.some(i => i.type === "env-reference-no-file"));
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty for project with .env", () => {
    const dir = mkdtempSync(join(tmpdir(), "sanjang-ok-"));
    writeFileSync(join(dir, ".env"), "PUBLIC_API_URL=http://localhost");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "config.ts"), 'const url = import.meta.env.PUBLIC_API_URL;');
    const issues = detectSetupIssues(dir);
    assert.ok(!issues.some(i => i.type === "env-reference-no-file"));
    rmSync(dir, { recursive: true, force: true });
  });

  it("detects bun project for cache skip hint", () => {
    const dir = mkdtempSync(join(tmpdir(), "sanjang-bun-"));
    writeFileSync(join(dir, "bun.lock"), "{}");
    const issues = detectSetupIssues(dir);
    assert.ok(issues.some(i => i.type === "bun-cache-skip"));
    rmSync(dir, { recursive: true, force: true });
  });
});
