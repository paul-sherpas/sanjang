import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { detectProject, loadConfig, generateConfig, detectApps } from '../lib/config.ts';

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

  it('generates config for selected app', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sanjang-gen-'));
    mkdirSync(join(dir, 'web'));
    writeFileSync(join(dir, 'web', 'next.config.js'), '');
    writeFileSync(join(dir, 'web', 'package.json'), '{}');

    const result = generateConfig(dir, { appDir: 'web' });
    assert.equal(result.created, true);
    assert.equal(result.framework, 'Next.js');

    const content = readFileSync(join(dir, 'sanjang.config.js'), 'utf8');
    assert.ok(content.includes("cwd: 'web'"));
    rmSync(dir, { recursive: true, force: true });
  });

  it('overwrites config with force option', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sanjang-gen-'));
    writeFileSync(join(dir, 'sanjang.config.js'), 'export default {}');
    writeFileSync(join(dir, 'next.config.js'), '');

    const result = generateConfig(dir, { force: true });
    assert.equal(result.created, true);
    assert.equal(result.framework, 'Next.js');
    rmSync(dir, { recursive: true, force: true });
  });

  it('generates setup with cd for subdirectory app', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sanjang-gen-'));
    mkdirSync(join(dir, 'frontend'));
    writeFileSync(join(dir, 'frontend', 'vite.config.js'), '');
    writeFileSync(join(dir, 'frontend', 'package.json'), '{}');
    writeFileSync(join(dir, 'frontend', 'pnpm-lock.yaml'), '');

    const result = generateConfig(dir, { appDir: 'frontend' });
    assert.equal(result.created, true);

    const content = readFileSync(join(dir, 'sanjang.config.js'), 'utf8');
    assert.ok(content.includes("cwd: 'frontend'"));
    assert.ok(content.includes("cd 'frontend' && pnpm install"));
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('config — detectApps', () => {
  it('returns empty array for empty directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sanjang-apps-'));
    const apps = detectApps(dir);
    assert.deepEqual(apps, []);
    rmSync(dir, { recursive: true, force: true });
  });

  it('detects multiple apps in monorepo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sanjang-apps-'));
    mkdirSync(join(dir, 'frontend'));
    writeFileSync(join(dir, 'frontend', 'shadow-cljs.edn'), '{}');
    writeFileSync(join(dir, 'frontend', 'package.json'), '{}');
    mkdirSync(join(dir, 'new-frontend'));
    writeFileSync(join(dir, 'new-frontend', 'turbo.json'), '{}');
    writeFileSync(join(dir, 'new-frontend', 'package.json'), '{}');
    mkdirSync(join(dir, 'backend'));
    writeFileSync(join(dir, 'backend', 'package.json'), '{"scripts":{"dev":"node server.js"}}');

    const apps = detectApps(dir);
    assert.equal(apps.length, 3);
    const names = apps.map(a => a.dir).sort();
    assert.deepEqual(names, ['backend', 'frontend', 'new-frontend']);
    const fe = apps.find(a => a.dir === 'frontend');
    assert.equal(fe!.framework, 'shadow-cljs');
    const newFe = apps.find(a => a.dir === 'new-frontend');
    assert.equal(newFe!.framework, 'Turborepo');
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns single app without root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sanjang-apps-'));
    mkdirSync(join(dir, 'app'));
    writeFileSync(join(dir, 'app', 'next.config.js'), '');
    writeFileSync(join(dir, 'app', 'package.json'), '{}');
    const apps = detectApps(dir);
    assert.equal(apps.length, 1);
    assert.equal(apps[0]!.dir, 'app');
    assert.equal(apps[0]!.framework, 'Next.js');
    rmSync(dir, { recursive: true, force: true });
  });

  it('ignores node_modules and dot directories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sanjang-apps-'));
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'node_modules', 'package.json'), '{}');
    mkdirSync(join(dir, '.hidden'));
    writeFileSync(join(dir, '.hidden', 'package.json'), '{}');
    mkdirSync(join(dir, 'app'));
    writeFileSync(join(dir, 'app', 'vite.config.js'), '');
    writeFileSync(join(dir, 'app', 'package.json'), '{}');

    const apps = detectApps(dir);
    assert.equal(apps.length, 1);
    assert.equal(apps[0]!.dir, 'app');
    rmSync(dir, { recursive: true, force: true });
  });

  it('skips subdirs with only package.json and no scripts.dev', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sanjang-apps-'));
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'package.json'), '{"name":"docs"}');
    mkdirSync(join(dir, 'app'));
    writeFileSync(join(dir, 'app', 'next.config.js'), '');
    writeFileSync(join(dir, 'app', 'package.json'), '{}');

    const apps = detectApps(dir);
    assert.equal(apps.length, 1);
    assert.equal(apps[0]!.dir, 'app');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('config — generateConfig edge cases', () => {
  it('generates config with nonexistent appDir (falls back to unknown)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sanjang-gen-'));
    const result = generateConfig(dir, { appDir: 'nonexistent', force: true });
    assert.equal(result.created, true);
    assert.equal(result.framework, 'unknown');
    rmSync(dir, { recursive: true, force: true });
  });

  it('force overwrites existing config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sanjang-gen-'));
    writeFileSync(join(dir, 'sanjang.config.js'), 'old');
    writeFileSync(join(dir, 'next.config.js'), '');
    writeFileSync(join(dir, 'package.json'), '{}');
    const result = generateConfig(dir, { force: true });
    assert.equal(result.created, true);
    assert.equal(result.framework, 'Next.js');
    const content = readFileSync(join(dir, 'sanjang.config.js'), 'utf8');
    assert.ok(content.includes('Next.js'));
    rmSync(dir, { recursive: true, force: true });
  });

  it('detects bun.lock (not just bun.lockb)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sanjang-bun-'));
    writeFileSync(join(dir, 'bun.lock'), '{}');
    writeFileSync(join(dir, 'package.json'), '{"scripts":{"dev":"bun run dev"}}');
    const result = generateConfig(dir);
    assert.equal(result.created, true);
    const content = readFileSync(join(dir, 'sanjang.config.js'), 'utf8');
    assert.ok(content.includes('bun install'));
    rmSync(dir, { recursive: true, force: true });
  });
});
