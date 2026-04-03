import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { setCampsDir, getAll, getOne, upsert, remove } from '../lib/engine/state.js';

describe('state', () => {
  let tmp;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'sanjang-test-'));
    setCampsDir(tmp);
  });

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('starts empty', () => {
    assert.deepEqual(getAll(), []);
  });

  it('upserts and retrieves a record', () => {
    upsert({ name: 'test-camp', branch: 'main', fePort: 3001, status: 'stopped' });
    const record = getOne('test-camp');
    assert.equal(record.name, 'test-camp');
    assert.equal(record.branch, 'main');
  });

  it('updates existing record', () => {
    upsert({ name: 'test-camp', branch: 'main', fePort: 3001, status: 'running' });
    assert.equal(getOne('test-camp').status, 'running');
    assert.equal(getAll().length, 1);
  });

  it('removes a record', () => {
    remove('test-camp');
    assert.equal(getOne('test-camp'), null);
    assert.equal(getAll().length, 0);
  });
});
