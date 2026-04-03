import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { detectWarp, buildOpenCommand } from '../lib/engine/warp.js';

describe('warp', () => {
  it('detectWarp returns object with installed boolean', () => {
    const result = detectWarp();
    assert.equal(typeof result.installed, 'boolean');
  });

  it('buildOpenCommand returns correct command for macOS', () => {
    const cmd = buildOpenCommand('/path/to/worktree');
    assert.ok(cmd.includes('/path/to/worktree'));
  });
});
