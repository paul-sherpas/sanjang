import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseConflictFiles, buildConflictPrompt } from '../lib/engine/conflict.ts';

describe('conflict', () => {
  it('parses conflict file list from git status', () => {
    const gitStatus = [
      'UU src/app.js',
      'UU src/config.js',
      'M  src/utils.js',
    ].join('\n');
    const result = parseConflictFiles(gitStatus);
    assert.deepEqual(result, ['src/app.js', 'src/config.js']);
  });

  it('returns empty array for no conflicts', () => {
    const gitStatus = 'M  src/utils.js\nA  src/new.js';
    const result = parseConflictFiles(gitStatus);
    assert.deepEqual(result, []);
  });

  it('builds Claude prompt with conflict context', () => {
    const files = ['src/app.js'];
    const prompt = buildConflictPrompt(files);
    assert.ok(prompt.includes('src/app.js'));
    assert.ok(prompt.includes('충돌'));
  });
});
