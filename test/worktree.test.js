import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('worktree', () => {
  it('exports expected functions', async () => {
    const mod = await import('../lib/engine/worktree.js');
    assert.equal(typeof mod.setProjectRoot, 'function');
    assert.equal(typeof mod.campPath, 'function');
    assert.equal(typeof mod.listBranches, 'function');
    assert.equal(typeof mod.addWorktree, 'function');
    assert.equal(typeof mod.removeWorktree, 'function');
  });
});
