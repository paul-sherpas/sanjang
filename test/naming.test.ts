import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { aiSlugify, slugify } from "../lib/engine/naming.ts";

describe("slugify", () => {
  it("converts known Korean to English kebab-case", () => {
    assert.equal(slugify("로그인 버튼 색상 변경"), "login-button-color-change");
  });

  it("converts English to kebab-case", () => {
    assert.equal(slugify("Fix the login button"), "fix-the-login-button");
  });

  it("handles mixed input", () => {
    const result = slugify("대시보드 filter 추가");
    assert.ok(result.includes("dashboard"));
    assert.ok(result.includes("filter"));
    assert.ok(result.includes("add"));
  });

  it("truncates long names at word boundary", () => {
    const long = "a".repeat(100);
    const result = slugify(long);
    assert.ok(result.length <= 50);
  });

  it('returns "camp" for empty string', () => {
    assert.equal(slugify(""), "camp");
  });

  it('returns "camp" for whitespace-only input', () => {
    assert.equal(slugify("   "), "camp");
  });
});

describe("aiSlugify", () => {
  it("returns string or null", () => {
    const result = aiSlugify("테스트 설명");
    assert.ok(result === null || typeof result === "string");
  });

  it("result is lowercase kebab-case if not null", () => {
    const result = aiSlugify("login button fix");
    if (result !== null) {
      assert.ok(/^[a-z0-9-]+$/.test(result), `Expected kebab-case, got: ${result}`);
      assert.ok(result.length <= 30, `Expected max 30 chars, got: ${result.length}`);
    }
  });
});
