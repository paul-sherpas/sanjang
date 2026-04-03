import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { slugify } from '../lib/engine/naming.js';

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
});
