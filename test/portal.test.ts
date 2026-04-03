import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { slugify } from '../lib/engine/naming.ts';

describe('portal', () => {
  it('slugify converts Korean to kebab-case', () => {
    assert.equal(slugify('로그인 버튼 색상 변경'), 'login-button-color-change');
  });

  it('slugify converts English to kebab-case', () => {
    assert.equal(slugify('Fix the login button'), 'fix-the-login-button');
  });

  it('slugify truncates long names', () => {
    const long = 'this is a very long description that should be truncated to a reasonable length';
    const result = slugify(long);
    assert.ok(result.length <= 50);
  });

  it('slugify handles mixed input', () => {
    const result = slugify('대시보드 filter 추가');
    assert.ok(result.length > 0);
    assert.ok(/^[a-z0-9-]+$/.test(result));
  });

  it('slugify removes special characters', () => {
    const result = slugify('fix: 버그 #42 수정!');
    assert.ok(/^[a-z0-9-]+$/.test(result));
  });

  it('slugify returns "camp" for empty string', () => {
    assert.equal(slugify(''), 'camp');
  });

  it('slugify returns "camp" for purely unmapped Korean', () => {
    assert.equal(slugify('가나다라마바사'), 'camp');
  });

  it('slugify returns "camp" for whitespace-only input', () => {
    assert.equal(slugify('   '), 'camp');
  });

  it('slugify handles single character input', () => {
    const result = slugify('a');
    assert.equal(result, 'a');
  });

  it('slugify handles numbers only', () => {
    const result = slugify('12345');
    assert.equal(result, '12345');
  });

  it('slugify truncates exactly at word boundary', () => {
    // 50+ chars slug
    const input = 'add user login page with search filter sort notification permission device';
    const result = slugify(input);
    assert.ok(result.length <= 50);
    assert.ok(!result.endsWith('-'));
  });
});
