import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, cpSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const LOCKFILES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock'];

// ---------------------------------------------------------------------------
// Lockfile helpers
// ---------------------------------------------------------------------------

export function findLockfile(dir) {
  for (const name of LOCKFILES) {
    const p = join(dir, name);
    if (existsSync(p)) return { path: p, name };
  }
  return null;
}

export function hashLockfile(lockfilePath) {
  const content = readFileSync(lockfilePath);
  return createHash('sha256').update(content).digest('hex');
}

// ---------------------------------------------------------------------------
// Cache directory
// ---------------------------------------------------------------------------

export function getCacheDir(projectRoot) {
  return join(projectRoot, '.sanjang', 'cache');
}

function getCacheModulesDir(projectRoot, setupCwd) {
  const base = getCacheDir(projectRoot);
  return setupCwd === '.' ? join(base, 'node_modules') : join(base, setupCwd, 'node_modules');
}

function getHashFile(projectRoot, setupCwd = '.') {
  const base = getCacheDir(projectRoot);
  const name = setupCwd === '.' ? 'lockfile.hash' : `lockfile-${setupCwd.replace(/\//g, '-')}.hash`;
  return join(base, name);
}

// ---------------------------------------------------------------------------
// Cache validation
// ---------------------------------------------------------------------------

export function isCacheValid(projectRoot, setupCwd) {
  const cacheModules = getCacheModulesDir(projectRoot, setupCwd);
  if (!existsSync(cacheModules)) {
    return { valid: false, reason: 'cache not found' };
  }

  const hashFile = getHashFile(projectRoot, setupCwd);
  if (!existsSync(hashFile)) {
    return { valid: false, reason: 'no hash file' };
  }

  const srcDir = setupCwd === '.' ? projectRoot : join(projectRoot, setupCwd);
  const lockfile = findLockfile(srcDir);
  if (!lockfile) {
    return { valid: false, reason: 'no lockfile in project' };
  }

  const storedHash = readFileSync(hashFile, 'utf8').trim();
  const currentHash = hashLockfile(lockfile.path);

  if (storedHash !== currentHash) {
    return { valid: false, reason: 'lockfile changed' };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Find all node_modules dirs (monorepo support)
// ---------------------------------------------------------------------------

function findAllNodeModules(baseDir, maxDepth = 4) {
  const results = [];
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    if (!existsSync(dir)) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules') {
        results.push(join(dir, entry.name));
        // Don't recurse into node_modules
      } else if (!entry.name.startsWith('.')) {
        walk(join(dir, entry.name), depth + 1);
      }
    }
  }
  walk(baseDir, 0);
  return results;
}

// ---------------------------------------------------------------------------
// Build cache
// ---------------------------------------------------------------------------

export async function buildCache(projectRoot, config, onLog) {
  const start = Date.now();
  const setupCwd = config.dev?.cwd || '.';
  const srcDir = setupCwd === '.' ? projectRoot : join(projectRoot, setupCwd);
  const modulesDir = join(srcDir, 'node_modules');

  const lockfile = findLockfile(srcDir);
  if (!lockfile) {
    return { success: false, error: 'lockfile not found', duration: Date.now() - start };
  }

  // If node_modules doesn't exist, run setup to create it
  if (!existsSync(modulesDir)) {
    if (!config.setup) {
      return { success: false, error: 'no setup command and no node_modules', duration: Date.now() - start };
    }

    onLog?.('node_modules가 없습니다. 설치를 실행합니다...');
    const exitCode = await runSetup(config.setup, projectRoot, onLog);
    if (exitCode !== 0) {
      return { success: false, error: `setup failed (exit ${exitCode})`, duration: Date.now() - start };
    }

    if (!existsSync(modulesDir)) {
      return { success: false, error: 'setup completed but node_modules not found', duration: Date.now() - start };
    }
  }

  // Find all node_modules (monorepo: root + workspace packages)
  const allModules = findAllNodeModules(srcDir);
  onLog?.(`캐시에 node_modules를 저장합니다... (${allModules.length}개 디렉토리)`);

  const cacheDir = getCacheDir(projectRoot);
  const cacheBase = setupCwd === '.' ? cacheDir : join(cacheDir, setupCwd);

  // Clean old cache
  if (existsSync(cacheBase)) {
    rmSync(cacheBase, { recursive: true, force: true });
  }
  mkdirSync(cacheBase, { recursive: true });

  // Cache each node_modules with its relative path preserved
  try {
    for (const modDir of allModules) {
      const rel = relative(srcDir, modDir);
      const target = join(cacheBase, rel);
      mkdirSync(join(target, '..'), { recursive: true });
      cpSync(modDir, target, { recursive: true });
    }
  } catch (err) {
    return { success: false, error: `cache copy failed: ${err.message}`, duration: Date.now() - start };
  }

  // Store lockfile hash
  writeFileSync(getHashFile(projectRoot, setupCwd), hashLockfile(lockfile.path), 'utf8');

  const duration = Date.now() - start;
  onLog?.(`캐시 저장 완료 (${allModules.length}개, ${(duration / 1000).toFixed(1)}초)`);
  return { success: true, duration };
}

// ---------------------------------------------------------------------------
// Apply cache to worktree
// ---------------------------------------------------------------------------

export function applyCacheToWorktree(projectRoot, wtPath, setupCwd) {
  const start = Date.now();
  const validity = isCacheValid(projectRoot, setupCwd);

  if (!validity.valid) {
    return { applied: false, reason: validity.reason };
  }

  const cacheBase = setupCwd === '.'
    ? getCacheDir(projectRoot)
    : join(getCacheDir(projectRoot), setupCwd);
  const targetBase = setupCwd === '.' ? wtPath : join(wtPath, setupCwd);

  // Find all cached node_modules and restore them
  const cachedModules = findAllNodeModules(cacheBase);
  if (cachedModules.length === 0) {
    return { applied: false, reason: 'no cached node_modules found' };
  }

  try {
    for (const cachedDir of cachedModules) {
      const rel = relative(cacheBase, cachedDir);
      const target = join(targetBase, rel);
      mkdirSync(join(target, '..'), { recursive: true });
      cpSync(cachedDir, target, { recursive: true });
    }
  } catch (err) {
    return { applied: false, reason: `clone failed: ${err.message}` };
  }

  return { applied: true, duration: Date.now() - start, count: cachedModules.length };
}

// ---------------------------------------------------------------------------
// Internal: run setup command
// ---------------------------------------------------------------------------

function runSetup(command, cwd, onLog) {
  return new Promise((resolve) => {
    const proc = spawn(command, [], {
      cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', (d) => onLog?.(d.toString().trimEnd()));
    proc.stderr.on('data', (d) => onLog?.(d.toString().trimEnd()));
    proc.on('close', (code) => resolve(code));
    proc.on('error', () => resolve(1));
  });
}
