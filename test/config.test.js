import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { detectProject, loadConfig, generateConfig } from '../lib/config.js';

describe('config — detectProject', () => {
  it('detects Next.js', () => {
    const nextDir = mkdtempSync(join(tmpdir(), 'sanjang-next-'));
    writeFileSync(join(nextDir, 'next.config.js'), 'module.exports = {}');
    writeFileSync(join(nextDir, 'package.json'), '{"scripts":{"dev":"next dev"}}');
    const result = detectProject(nextDir);
    assert.equal(result.framework, 'Next.js');
    assert.equal(result.dev.portFlag, '-p');
    rmSync(nextDir, { recursive: true, force: true });
  });

  it('detects Vite', () => {
    const viteDir = mkdtempSync(join(tmpdir(), 'sanjang-vite-'));
    writeFileSync(join(viteDir, 'vite.config.js'), 'export default {}');
    writeFileSync(join(viteDir, 'package.json'), '{"scripts":{"dev":"vite"}}');
    const result = detectProject(viteDir);
    assert.equal(result.framework, 'Vite');
    assert.equal(result.dev.port, 5173);
    rmSync(viteDir, { recursive: true, force: true });
  });

  it('detects Angular', () => {
    const angDir = mkdtempSync(join(tmpdir(), 'sanjang-ang-'));
    writeFileSync(join(angDir, 'angular.json'), '{}');
    const result = detectProject(angDir);
    assert.equal(result.framework, 'Angular');
    assert.equal(result.dev.port, 4200);
    rmSync(angDir, { recursive: true, force: true });
  });

  it('detects SvelteKit', () => {
    const svDir = mkdtempSync(join(tmpdir(), 'sanjang-sv-'));
    writeFileSync(join(svDir, 'svelte.config.js'), 'export default {}');
    const result = detectProject(svDir);
    assert.equal(result.framework, 'SvelteKit');
    rmSync(svDir, { recursive: true, force: true });
  });

  it('detects Nuxt', () => {
    const nuDir = mkdtempSync(join(tmpdir(), 'sanjang-nu-'));
    writeFileSync(join(nuDir, 'nuxt.config.ts'), 'export default {}');
    const result = detectProject(nuDir);
    assert.equal(result.framework, 'Nuxt');
    rmSync(nuDir, { recursive: true, force: true });
  });

  it('detects Turborepo', () => {
    const trDir = mkdtempSync(join(tmpdir(), 'sanjang-turbo-'));
    writeFileSync(join(trDir, 'turbo.json'), '{}');
    const result = detectProject(trDir);
    assert.equal(result.framework, 'Turborepo');
    rmSync(trDir, { recursive: true, force: true });
  });

  it('falls back to Node.js with package.json scripts.dev', () => {
    const nodeDir = mkdtempSync(join(tmpdir(), 'sanjang-node-'));
    writeFileSync(join(nodeDir, 'package.json'), '{"scripts":{"dev":"node server.js"}}');
    const result = detectProject(nodeDir);
    assert.equal(result.framework, 'Node.js');
    rmSync(nodeDir, { recursive: true, force: true });
  });

  it('returns unknown for empty directory', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'sanjang-empty-'));
    const result = detectProject(emptyDir);
    assert.equal(result.framework, 'unknown');
    rmSync(emptyDir, { recursive: true, force: true });
  });

  it('detects bun package manager', () => {
    const bunDir = mkdtempSync(join(tmpdir(), 'sanjang-bun-'));
    writeFileSync(join(bunDir, 'vite.config.js'), '');
    writeFileSync(join(bunDir, 'bun.lockb'), '');
    const result = detectProject(bunDir);
    assert.equal(result.setup, 'bun install');
    rmSync(bunDir, { recursive: true, force: true });
  });

  it('detects shadow-cljs with bb.edn', () => {
    const clDir = mkdtempSync(join(tmpdir(), 'sanjang-cljs-'));
    writeFileSync(join(clDir, 'shadow-cljs.edn'), '{}');
    writeFileSync(join(clDir, 'bb.edn'), '{}');
    const result = detectProject(clDir);
    assert.equal(result.framework, 'shadow-cljs');
    assert.equal(result.dev.command, 'bb dev');
    assert.equal(result.dev.portFlag, null);
    rmSync(clDir, { recursive: true, force: true });
  });

  it('detects shadow-cljs in subdirectory', () => {
    const monoDir = mkdtempSync(join(tmpdir(), 'sanjang-mono-'));
    mkdirSync(join(monoDir, 'frontend'));
    writeFileSync(join(monoDir, 'frontend', 'shadow-cljs.edn'), '{}');
    writeFileSync(join(monoDir, 'frontend', 'bb.edn'), '{}');
    const result = detectProject(monoDir);
    assert.equal(result.framework, 'shadow-cljs');
    assert.equal(result.dev.cwd, 'frontend');
    rmSync(monoDir, { recursive: true, force: true });
  });

  it('detects pnpm package manager', () => {
    const pnpmDir = mkdtempSync(join(tmpdir(), 'sanjang-pnpm-'));
    writeFileSync(join(pnpmDir, 'vite.config.js'), '');
    writeFileSync(join(pnpmDir, 'pnpm-lock.yaml'), '');
    const result = detectProject(pnpmDir);
    assert.equal(result.setup, 'pnpm install');
    rmSync(pnpmDir, { recursive: true, force: true });
  });
});

describe('config — mergeConfig (via loadConfig)', () => {
  it('loads defaults when no config file exists', async () => {
    const noDir = mkdtempSync(join(tmpdir(), 'sanjang-noconf-'));
    const config = await loadConfig(noDir);
    assert.equal(config.dev.command, 'npm run dev');
    assert.equal(config.dev.port, 3000);
    assert.equal(config.ports.fe.slots, 8);
    assert.equal(config.ports.be.slots, 8);
    rmSync(noDir, { recursive: true, force: true });
  });
});

describe('config — generateConfig', () => {
  it('creates config file and returns framework', () => {
    const genDir = mkdtempSync(join(tmpdir(), 'sanjang-gen-'));
    writeFileSync(join(genDir, 'next.config.js'), '');
    const result = generateConfig(genDir);
    assert.equal(result.created, true);
    assert.equal(result.framework, 'Next.js');
    rmSync(genDir, { recursive: true, force: true });
  });

  it('does not overwrite existing config', () => {
    const genDir = mkdtempSync(join(tmpdir(), 'sanjang-gen2-'));
    writeFileSync(join(genDir, 'sanjang.config.js'), 'export default {}');
    const result = generateConfig(genDir);
    assert.equal(result.created, false);
    rmSync(genDir, { recursive: true, force: true });
  });
});
