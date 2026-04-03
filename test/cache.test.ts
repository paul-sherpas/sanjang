import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { findLockfile, hashLockfile, isCacheValid, buildCache, applyCacheToWorktree, getCacheDir } from '../lib/engine/cache.ts';
import type { SanjangConfig } from '../lib/types.ts';

type CacheConfig = Pick<SanjangConfig, 'dev' | 'setup'>;

describe('cache — findLockfile', () => {
  let dir: string;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'sanjang-cache-')); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  it('returns null when no lockfile exists', () => {
    assert.equal(findLockfile(dir), null);
  });

  it('finds package-lock.json', () => {
    writeFileSync(join(dir, 'package-lock.json'), '{}');
    const result = findLockfile(dir);
    assert.equal(result?.name, 'package-lock.json');
  });

  it('finds yarn.lock', () => {
    const d = mkdtempSync(join(tmpdir(), 'sanjang-yarn-'));
    writeFileSync(join(d, 'yarn.lock'), '# yarn');
    const result = findLockfile(d);
    assert.equal(result?.name, 'yarn.lock');
    rmSync(d, { recursive: true, force: true });
  });
});

describe('cache — hashLockfile', () => {
  it('returns consistent SHA-256 hex', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sanjang-hash-'));
    const f = join(dir, 'package-lock.json');
    writeFileSync(f, '{"lockfileVersion":3}');
    const h1 = hashLockfile(f);
    const h2 = hashLockfile(f);
    assert.equal(h1, h2);
    assert.equal(h1.length, 64);
    rmSync(dir, { recursive: true, force: true });
  });

  it('changes when content changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sanjang-hash2-'));
    const f = join(dir, 'package-lock.json');
    writeFileSync(f, 'v1');
    const h1 = hashLockfile(f);
    writeFileSync(f, 'v2');
    const h2 = hashLockfile(f);
    assert.notEqual(h1, h2);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('cache — isCacheValid', () => {
  let projectRoot: string;
  before(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'sanjang-valid-'));
    mkdirSync(join(projectRoot, 'frontend'), { recursive: true });
    writeFileSync(join(projectRoot, 'frontend', 'package-lock.json'), '{"v":1}');
  });
  after(() => { rmSync(projectRoot, { recursive: true, force: true }); });

  it('returns invalid when no cache exists', () => {
    const result = isCacheValid(projectRoot, 'frontend');
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'cache not found');
  });

  it('returns valid when cache matches lockfile', () => {
    const cacheDir = getCacheDir(projectRoot);
    mkdirSync(join(cacheDir, 'frontend', 'node_modules'), { recursive: true });
    writeFileSync(join(cacheDir, 'frontend', 'node_modules', 'test.txt'), 'cached');
    const hash = hashLockfile(join(projectRoot, 'frontend', 'package-lock.json'));
    writeFileSync(join(cacheDir, 'lockfile-frontend.hash'), hash);

    const result = isCacheValid(projectRoot, 'frontend');
    assert.equal(result.valid, true);
  });

  it('returns invalid when lockfile changes', () => {
    writeFileSync(join(projectRoot, 'frontend', 'package-lock.json'), '{"v":2}');
    const result = isCacheValid(projectRoot, 'frontend');
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'lockfile changed');
  });
});

describe('cache — applyCacheToWorktree', () => {
  let projectRoot: string;
  let wtPath: string;
  before(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'sanjang-apply-'));
    wtPath = mkdtempSync(join(tmpdir(), 'sanjang-wt-'));

    mkdirSync(join(projectRoot, 'frontend'), { recursive: true });
    writeFileSync(join(projectRoot, 'frontend', 'package-lock.json'), '{"v":1}');

    const cacheDir = getCacheDir(projectRoot);
    mkdirSync(join(cacheDir, 'frontend', 'node_modules', 'express'), { recursive: true });
    writeFileSync(join(cacheDir, 'frontend', 'node_modules', 'express', 'index.js'), 'module.exports = {}');
    const hash = hashLockfile(join(projectRoot, 'frontend', 'package-lock.json'));
    writeFileSync(join(cacheDir, 'lockfile-frontend.hash'), hash);
  });
  after(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(wtPath, { recursive: true, force: true });
  });

  it('clones cache to worktree via fs.cpSync', () => {
    const result = applyCacheToWorktree(projectRoot, wtPath, 'frontend');
    assert.equal(result.applied, true);
    assert.ok(typeof result.duration === 'number' && result.duration >= 0);
    assert.ok(existsSync(join(wtPath, 'frontend', 'node_modules', 'express', 'index.js')));
  });

  it('returns not applied when cache invalid', () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), 'sanjang-empty-'));
    mkdirSync(join(emptyRoot, 'frontend'), { recursive: true });
    writeFileSync(join(emptyRoot, 'frontend', 'package-lock.json'), '{}');
    const result = applyCacheToWorktree(emptyRoot, wtPath, 'frontend');
    assert.equal(result.applied, false);
    rmSync(emptyRoot, { recursive: true, force: true });
  });
});

describe('cache — buildCache', () => {
  it('caches existing node_modules without running setup', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'sanjang-build-'));
    mkdirSync(join(projectRoot, 'node_modules', 'foo'), { recursive: true });
    writeFileSync(join(projectRoot, 'node_modules', 'foo', 'index.js'), 'ok');
    writeFileSync(join(projectRoot, 'package-lock.json'), '{"lock":true}');

    const config = { dev: { cwd: '.' }, setup: 'npm install' } as CacheConfig;
    const logs: string[] = [];
    const result = await buildCache(projectRoot, config, (msg: string) => logs.push(msg));

    assert.equal(result.success, true);
    assert.ok(existsSync(join(getCacheDir(projectRoot), 'node_modules', 'foo', 'index.js')));
    assert.ok(existsSync(join(getCacheDir(projectRoot), 'lockfile.hash')));

    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('returns failure when no lockfile', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'sanjang-nolock-'));
    const config = { dev: { cwd: '.' }, setup: 'npm install' } as CacheConfig;
    const result = await buildCache(projectRoot, config);
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('lockfile'));
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('returns failure when no node_modules and no setup command', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'sanjang-nosetup-'));
    writeFileSync(join(projectRoot, 'package-lock.json'), '{}');
    const config = { dev: { cwd: '.' }, setup: null } as CacheConfig;
    const result = await buildCache(projectRoot, config);
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('no setup command'));
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('returns failure when setup command fails', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'sanjang-failsetup-'));
    writeFileSync(join(projectRoot, 'package-lock.json'), '{}');
    const config = { dev: { cwd: '.' }, setup: 'exit 1' } as CacheConfig;
    const result = await buildCache(projectRoot, config);
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('setup failed'));
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('handles subdirectory setupCwd correctly', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'sanjang-subcwd-'));
    mkdirSync(join(projectRoot, 'frontend', 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(projectRoot, 'frontend', 'node_modules', 'pkg', 'index.js'), 'ok');
    writeFileSync(join(projectRoot, 'frontend', 'package-lock.json'), '{"sub":true}');

    const config = { dev: { cwd: 'frontend' }, setup: 'npm install' } as CacheConfig;
    const result = await buildCache(projectRoot, config);
    assert.equal(result.success, true);
    assert.ok(existsSync(join(getCacheDir(projectRoot), 'frontend', 'node_modules', 'pkg', 'index.js')));

    rmSync(projectRoot, { recursive: true, force: true });
  });
});
