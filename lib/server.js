import { createServer } from 'node:http';
import { execSync, spawnSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, copyFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve } from 'node:path';

import express from 'express';
import { WebSocketServer } from 'ws';

import { getAll, getOne, upsert, remove, setCampsDir } from './engine/state.js';
import { allocate, scanPorts, setPortConfig } from './engine/ports.js';
import { addWorktree, removeWorktree, listBranches, campPath, setProjectRoot, getProjectRoot } from './engine/worktree.js';
import { startCamp, stopCamp, stopAllCamps, getProcessInfo, setConfig } from './engine/process.js';
import { saveSnapshot, restoreSnapshot, listSnapshots } from './engine/snapshot.js';
import { buildDiagnostics } from './engine/diagnostics.js';
import { buildFallbackPrBody, buildClaudePrPrompt } from './engine/pr.js';
import { parseConflictFiles, buildConflictPrompt } from './engine/conflict.js';
import { loadConfig } from './config.js';
import { detectWarp, openWarpTab } from './engine/warp.js';
import { slugify } from './engine/naming.js';
import { isCacheValid, applyCacheToWorktree, buildCache } from './engine/cache.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Error translation
// ---------------------------------------------------------------------------

function runGit(args, cwd) {
  const r = spawnSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr?.trim() || `git ${args[0]} failed`);
  return r.stdout || '';
}

function getChangedFiles(wtPath) {
  const diff = (spawnSync('git', ['-C', wtPath, 'diff', '--name-status'], { encoding: 'utf8', stdio: 'pipe' }).stdout || '').trim();
  const untracked = (spawnSync('git', ['-C', wtPath, 'ls-files', '--others', '--exclude-standard'], { encoding: 'utf8', stdio: 'pipe' }).stdout || '').trim();
  const files = [];
  if (diff) {
    for (const line of diff.split('\n')) {
      const [status, ...pathParts] = line.split('\t');
      files.push({ path: pathParts.join('\t'), status: status === 'M' ? '수정' : status === 'D' ? '삭제' : status === 'A' ? '추가' : status });
    }
  }
  if (untracked) {
    for (const p of untracked.split('\n')) files.push({ path: p, status: '새 파일' });
  }
  return files;
}

function copyCampFiles(projectRoot, wtPath, copyFiles, onLog) {
  if (!copyFiles?.length) return;
  for (const file of copyFiles) {
    try {
      copyFileSync(join(projectRoot, file), join(wtPath, file));
      onLog?.(`${file} 복사 완료 ✓`);
    } catch {
      onLog?.(`⚠️ ${file} 파일을 찾을 수 없습니다.`);
    }
  }
}

function friendlyError(err, branch) {
  const msg = err?.message || String(err);
  if (/invalid reference/.test(msg)) return `"${branch}" 브랜치를 찾을 수 없습니다.`;
  if (/already exists/.test(msg)) return '이미 같은 이름의 캠프가 있습니다.';
  if (/already checked out/.test(msg)) return '이 브랜치가 다른 곳에서 사용 중입니다.';
  if (/No available port/.test(msg)) return '포트가 부족합니다.';
  return msg;
}

function friendlyStartError(err) {
  const msg = err?.message || String(err);
  if (/Timeout waiting for port|포트.*열리지/.test(msg)) return '서버가 시작하는 데 너무 오래 걸립니다.';
  if (/ECONNREFUSED/.test(msg)) return '서버 연결이 거부됐습니다.';
  return msg;
}

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

export async function createApp(projectRoot, options = {}) {
  const port = options.port ?? 4000;

  // Initialize modules
  setProjectRoot(projectRoot);

  const campsDir = join(projectRoot, '.sanjang', 'camps');
  setCampsDir(campsDir);

  const config = await loadConfig(projectRoot);
  setConfig(config);

  if (config.ports) setPortConfig(config.ports);

  // Reset stale running/starting statuses from previous sessions
  for (const camp of getAll()) {
    if (camp.status === 'running' || camp.status === 'starting') {
      upsert({ ...camp, status: 'stopped' });
    }
  }

  // Warp detection (cached for this server instance)
  const warpStatus = detectWarp();

  // Express app
  const app = express();
  app.use(express.json());
  app.use(express.static(join(__dirname, '..', 'dashboard')));

  const server = createServer(app);
  const wss = new WebSocketServer({ server });

  function broadcast(msg) {
    const text = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(text);
    }
  }

  wss.on('connection', (ws) => {
    ws.on('error', (err) => console.error('[ws] client error:', err.message));
  });

  // -------------------------------------------------------------------------
  // REST API
  // -------------------------------------------------------------------------

  app.get('/api/ports', (_req, res) => res.json(scanPorts()));

  app.get('/api/branches', async (_req, res) => {
    try {
      res.json(await listBranches());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/playgrounds', (_req, res) => res.json(getAll()));

  app.post('/api/playgrounds', async (req, res) => {
    const { name, branch } = req.body ?? {};
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (!branch) return res.status(400).json({ error: 'branch is required' });
    if (!/^[a-z0-9-]+$/.test(name)) return res.status(400).json({ error: 'name must match /^[a-z0-9-]+$/' });
    if (!/^[a-zA-Z0-9/_.\-]+$/.test(branch)) return res.status(400).json({ error: 'branch name contains invalid characters' });

    const existing = getAll();
    if (getOne(name)) return res.status(409).json({ error: `'${name}' 캠프가 이미 있습니다.` });
    if (existing.length >= 7) return res.status(400).json({ error: '최대 7개 캠프까지 가능합니다.' });

    try {
      // Reload config for each camp creation (hot reload)
      const freshConfig = await loadConfig(projectRoot);
      setConfig(freshConfig);
      if (freshConfig.ports) setPortConfig(freshConfig.ports);

      const { slot, fePort, bePort } = allocate(existing);
      // When portFlag is null, dev server uses its own fixed port
      const actualFePort = freshConfig.dev?.portFlag ? fePort : (freshConfig.dev?.port || fePort);
      await addWorktree(name, branch);

      const wtPath = campPath(name);

      // Copy gitignored files first (sync, fast)
      copyCampFiles(projectRoot, wtPath, freshConfig.copyFiles, (msg) => {
        broadcast({ type: 'log', name, source: 'sanjang', data: msg });
      });

      const record = { name, branch, slot, fePort: actualFePort, bePort, status: 'setting-up' };
      upsert(record);
      broadcast({ type: 'playground-created', name, data: record });
      res.status(201).json(record);

      // Try cached node_modules first, fall back to full setup
      if (freshConfig.setup) {
        const setupCwd = freshConfig.dev?.cwd || '.';
        const cacheResult = applyCacheToWorktree(projectRoot, wtPath, setupCwd);

        if (cacheResult.applied) {
          broadcast({ type: 'log', name, source: 'sanjang', data: `캐시에서 node_modules 복사 완료 ✓ (${cacheResult.duration}ms)` });
          upsert({ ...getOne(name), status: 'stopped' });
          broadcast({ type: 'playground-status', name, data: { status: 'stopped' } });
        } else {
          // Cache miss — fall back to full setup
          broadcast({ type: 'log', name, source: 'sanjang', data: `캐시 없음 (${cacheResult.reason}), 설치 중 (${freshConfig.setup})...` });
          const setupProc = spawn(freshConfig.setup, [], {
            cwd: wtPath, shell: true, stdio: ['ignore', 'pipe', 'pipe'],
          });
          setupProc.stdout.on('data', (d) => {
            broadcast({ type: 'log', name, source: 'setup', data: d.toString() });
          });
          setupProc.stderr.on('data', (d) => {
            broadcast({ type: 'log', name, source: 'setup', data: d.toString() });
          });
          setupProc.on('close', (code) => {
            if (code === 0) {
              broadcast({ type: 'log', name, source: 'sanjang', data: '설치 완료 ✓' });
              upsert({ ...getOne(name), status: 'stopped' });
              broadcast({ type: 'playground-status', name, data: { status: 'stopped' } });
            } else {
              broadcast({ type: 'log', name, source: 'sanjang', data: `⚠️ 설치 실패 (코드 ${code})` });
              upsert({ ...getOne(name), status: 'error' });
              broadcast({ type: 'playground-status', name, data: { status: 'error', error: '의존성 설치에 실패했습니다.' } });
            }
          });
        }
      } else {
        upsert({ ...getOne(name), status: 'stopped' });
        broadcast({ type: 'playground-status', name, data: { status: 'stopped' } });
      }
    } catch (err) {
      // Clean up orphan worktree on failure
      try { await removeWorktree(name); } catch { /* may not exist */ }
      res.status(500).json({ error: friendlyError(err, branch) });
    }
  });

  // Track in-flight start operations
  const startingSet = new Set();

  app.post('/api/playgrounds/:name/start', async (req, res) => {
    const { name } = req.params;
    const pg = getOne(name);
    if (!pg) return res.status(404).json({ error: 'not found' });
    if (startingSet.has(name)) return res.json({ status: 'already-starting' });

    startingSet.add(name);
    upsert({ ...pg, status: 'starting' });
    broadcast({ type: 'playground-status', name, data: { status: 'starting' } });
    res.json({ status: 'starting' });

    (async () => {
      try {
        await startCamp(pg, (event) => {
          broadcast({ type: event.type, name, data: event.data, source: event.source });
        });
        upsert({ ...getOne(name), status: 'running' });
        broadcast({ type: 'playground-status', name, data: { status: 'running' } });
      } catch (err) {
        const current = getOne(name) ?? pg;
        upsert({ ...current, status: 'error' });
        broadcast({ type: 'playground-status', name, data: { status: 'error', error: friendlyStartError(err) } });

        const processInfo = getProcessInfo(name) ?? { feLogs: [], feExitCode: null };
        const diagnostics = await buildDiagnostics(current, processInfo);
        broadcast({ type: 'playground-diagnostics', name, data: diagnostics });
      } finally {
        startingSet.delete(name);
      }
    })();
  });

  app.post('/api/playgrounds/:name/stop', (req, res) => {
    const { name } = req.params;
    const pg = getOne(name);
    if (!pg) return res.status(404).json({ error: 'not found' });
    startingSet.delete(name);
    stopCamp(name);
    upsert({ ...pg, status: 'stopped' });
    broadcast({ type: 'playground-status', name, data: { status: 'stopped' } });
    res.json({ status: 'stopped' });
  });

  app.delete('/api/playgrounds/:name', async (req, res) => {
    const { name } = req.params;
    const pg = getOne(name);
    if (!pg) return res.status(404).json({ error: 'not found' });
    try {
      startingSet.delete(name);
      stopCamp(name);
      await removeWorktree(name);
      remove(name);
      broadcast({ type: 'playground-deleted', name, data: null });
      res.json({ deleted: true });
    } catch (err) {
      remove(name);
      broadcast({ type: 'playground-deleted', name, data: null });
      res.json({ deleted: true, warning: err.message });
    }
  });

  app.post('/api/playgrounds/:name/snapshot', async (req, res) => {
    const { name } = req.params;
    const { label } = req.body ?? {};
    if (!getOne(name)) return res.status(404).json({ error: 'not found' });
    try {
      await saveSnapshot(name, label ?? new Date().toISOString());
      res.json({ saved: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/playgrounds/:name/restore', async (req, res) => {
    const { name } = req.params;
    const { index } = req.body ?? {};
    if (!getOne(name)) return res.status(404).json({ error: 'not found' });
    const idx = parseInt(index, 10);
    if (!Number.isFinite(idx) || idx < 0) return res.status(400).json({ error: 'index must be a non-negative integer' });
    try {
      await restoreSnapshot(name, idx);
      res.json({ restored: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/playgrounds/:name/snapshots', async (req, res) => {
    const { name } = req.params;
    if (!getOne(name)) return res.status(404).json({ error: 'not found' });
    try {
      res.json(await listSnapshots(name));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/playgrounds/:name/reset', (req, res) => {
    const { name } = req.params;
    const pg = getOne(name);
    if (!pg) return res.status(404).json({ error: 'not found' });
    try {
      const wtPath = campPath(name);
      runGit(['-C', wtPath, 'fetch', 'origin'], wtPath);
      runGit(['-C', wtPath, 'reset', '--hard', `origin/${pg.branch}`], wtPath);
      runGit(['-C', wtPath, 'clean', '-fd'], wtPath);

      // Re-copy gitignored files (git clean deletes them)
      copyCampFiles(projectRoot, wtPath, config.copyFiles);

      // Re-apply cached node_modules (git clean deletes them)
      if (config.setup) {
        const setupCwd = config.dev?.cwd || '.';
        const cacheResult = applyCacheToWorktree(projectRoot, wtPath, setupCwd);
        if (cacheResult.applied) {
          broadcast({ type: 'log', name, source: 'sanjang', data: `캐시에서 node_modules 복원 ✓ (${cacheResult.duration}ms)` });
        }
      }

      writeActions(name, []);
      broadcast({ type: 'playground-reset', name, data: { branch: pg.branch } });
      res.json({ reset: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/playgrounds/:name/diagnostics', async (req, res) => {
    const { name } = req.params;
    const pg = getOne(name);
    if (!pg) return res.status(404).json({ error: 'not found' });
    const processInfo = getProcessInfo(name) ?? { feLogs: [], feExitCode: null };
    try {
      res.json(await buildDiagnostics(pg, processInfo));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // -------------------------------------------------------------------------
  // Cache management
  // -------------------------------------------------------------------------

  app.get('/api/cache/status', (_req, res) => {
    const setupCwd = config.dev?.cwd || '.';
    res.json(isCacheValid(projectRoot, setupCwd));
  });

  app.post('/api/cache/rebuild', async (_req, res) => {
    try {
      broadcast({ type: 'cache-rebuild', data: { status: 'building' } });
      const result = await buildCache(projectRoot, config, (msg) => {
        broadcast({ type: 'log', name: '_cache', source: 'sanjang', data: msg });
      });
      if (result.success) {
        broadcast({ type: 'cache-rebuild', data: { status: 'done', duration: result.duration } });
        res.json({ success: true, duration: result.duration });
      } else {
        broadcast({ type: 'cache-rebuild', data: { status: 'error', error: result.error } });
        res.status(500).json({ error: result.error });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // -------------------------------------------------------------------------
  // Action log + Ship + Revert + Sync
  // -------------------------------------------------------------------------

  function actionsFile(name) {
    return join(campPath(name), 'actions.json');
  }

  function readActions(name) {
    try { return JSON.parse(readFileSync(actionsFile(name), 'utf8')); }
    catch { return []; }
  }

  function writeActions(name, actions) {
    try { writeFileSync(actionsFile(name), JSON.stringify(actions, null, 2)); }
    catch { /* worktree may not exist yet */ }
  }

  app.post('/api/playgrounds/:name/log-action', (req, res) => {
    const { name } = req.params;
    const { description, files } = req.body ?? {};
    if (!description) return res.status(400).json({ error: 'description required' });
    const actions = readActions(name);
    actions.push({ description, files: files || [], timestamp: new Date().toISOString() });
    writeActions(name, actions);
    broadcast({ type: 'playground-action', name, data: { description } });
    res.json({ logged: true });
  });

  app.post('/api/playgrounds/:name/remove-action', (req, res) => {
    const { name } = req.params;
    const { index } = req.body ?? {};
    const actions = readActions(name);
    if (index >= 0 && index < actions.length) {
      actions.splice(index, 1);
      writeActions(name, actions);
    }
    res.json({ removed: true });
  });

  app.get('/api/playgrounds/:name/changes', (req, res) => {
    const { name } = req.params;
    if (!getOne(name)) return res.status(404).json({ error: 'not found' });
    try {
      const wtPath = campPath(name);
      const files = getChangedFiles(wtPath);
      res.json({ count: files.length, files, actions: readActions(name) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/playgrounds/:name/ship', async (req, res) => {
    const { name } = req.params;
    const { message } = req.body ?? {};
    const pg = getOne(name);
    if (!pg) return res.status(404).json({ error: 'not found' });
    if (!message) return res.status(400).json({ error: '변경 내용을 한 줄로 설명해주세요.' });
    try {
      const wtPath = campPath(name);
      const ts = Date.now();
      const branchName = `sanjang/${name}-${ts}`;
      // Check for actual changes before shipping
      spawnSync('git', ['-C', wtPath, 'add', '-A'], { stdio: 'pipe' });
      spawnSync('git', ['-C', wtPath, 'reset', 'HEAD', 'actions.json'], { stdio: 'pipe' });
      const statusCheck = spawnSync('git', ['-C', wtPath, 'diff', '--cached', '--quiet'], { stdio: 'pipe' });
      if (statusCheck.status === 0) {
        return res.status(400).json({ error: '변경된 파일이 없습니다.' });
      }

      spawnSync('git', ['-C', wtPath, 'checkout', '-b', branchName], { stdio: 'pipe' });
      spawnSync('git', ['-C', wtPath, 'add', '-A'], { stdio: 'pipe' });
      spawnSync('git', ['-C', wtPath, 'reset', 'HEAD', 'actions.json'], { stdio: 'pipe' });
      const commitResult = spawnSync('git', ['-C', wtPath, 'commit', '-m', message], { stdio: 'pipe' });
      if (commitResult.status !== 0) throw new Error(commitResult.stderr?.toString() || 'commit failed');
      const pushResult = spawnSync('git', ['-C', wtPath, 'push', '-u', 'origin', branchName], { stdio: 'pipe' });
      if (pushResult.status !== 0) throw new Error(pushResult.stderr?.toString() || 'push failed');
      spawnSync('git', ['-C', wtPath, 'checkout', '--detach'], { stdio: 'pipe' });

      // Read actions before clearing (used for fallback PR body)
      const actions = readActions(name);
      writeActions(name, []);
      broadcast({ type: 'playground-shipped', name, data: { branch: branchName } });
      // Respond immediately after push
      res.json({ shipped: true, branch: branchName });

      // Background: create PR via gh CLI
      setImmediate(async () => {
        try {
          const ghCheck = spawnSync('which', ['gh'], { stdio: 'pipe' });
          if (ghCheck.status !== 0) return; // gh not installed, skip

          const diffStat = spawnSync('git', ['-C', wtPath, 'diff', '--stat', 'HEAD~1'],
            { encoding: 'utf8', stdio: 'pipe' }).stdout || '';
          const diff = spawnSync('git', ['-C', wtPath, 'diff', 'HEAD~1'],
            { encoding: 'utf8', stdio: 'pipe' }).stdout || '';

          // Try Claude for rich PR body, fallback to simple
          const claudeCheck = spawnSync('which', ['claude'], { stdio: 'pipe' });
          let prBody;

          if (claudeCheck.status === 0) {
            const prompt = buildClaudePrPrompt({ message, diffStat, diff });
            const claudeResult = spawnSync('claude', ['-p', prompt, '--output-format', 'text'], {
              cwd: wtPath,
              encoding: 'utf8',
              stdio: ['pipe', 'pipe', 'pipe'],
              timeout: 30_000,
              env: { ...process.env, FORCE_COLOR: '0' },
            });
            prBody = claudeResult.status === 0 && claudeResult.stdout?.trim()
              ? claudeResult.stdout.trim()
              : buildFallbackPrBody({ message, actions, diffStat });
          } else {
            prBody = buildFallbackPrBody({ message, actions, diffStat });
          }

          const prResult = spawnSync('gh', ['pr', 'create',
            '--title', message,
            '--body', prBody,
            '--head', branchName,
          ], { cwd: wtPath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

          if (prResult.status === 0) {
            const prUrl = prResult.stdout.trim();
            broadcast({ type: 'playground-pr-created', name, data: { prUrl, branch: branchName } });
          }
        } catch {
          // Background task — swallow errors silently
        }
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/playgrounds/:name/revert-files', (req, res) => {
    const { name } = req.params;
    const { files } = req.body ?? {};
    if (!getOne(name)) return res.status(404).json({ error: 'not found' });
    if (!files?.length) return res.status(400).json({ error: '되돌릴 파일을 선택해주세요.' });
    // Validate file paths against traversal and shell injection
    for (const file of files) {
      if (typeof file !== 'string' || file.includes('..') || file.startsWith('/') || /[`$;"'\\|&]/.test(file)) {
        return res.status(400).json({ error: `invalid file path: ${file}` });
      }
    }
    try {
      const wtPath = campPath(name);
      for (const file of files) {
        const fullPath = resolve(join(wtPath, file));
        if (!fullPath.startsWith(wtPath)) {
          continue; // path traversal attempt
        }
        const result = spawnSync('git', ['-C', wtPath, 'checkout', '--', file], { stdio: 'pipe' });
        if (result.status !== 0) {
          try { unlinkSync(fullPath); } catch { /* file may not exist */ }
        }
      }
      res.json({ reverted: files.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Shared task runner state (used by task endpoint and conflict resolver)
  const runningTasks = new Map();

  app.post('/api/playgrounds/:name/sync', (req, res) => {
    const { name } = req.params;
    const pg = getOne(name);
    if (!pg) return res.status(404).json({ error: 'not found' });
    try {
      const wtPath = campPath(name);
      runGit(['-C', wtPath, 'fetch', 'origin'], wtPath);
      const mergeResult = spawnSync('git', ['-C', wtPath, 'merge', `origin/${pg.branch}`, '--no-edit'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      const result = ((mergeResult.stdout || '') + (mergeResult.stderr || '')).trim();
      if (result.includes('CONFLICT') || (mergeResult.status !== 0 && result.includes('CONFLICT'))) {
        // Don't abort — leave merge state so user can resolve
        const statusOut = spawnSync('git', ['-C', wtPath, 'status', '--porcelain'], {
          encoding: 'utf8', stdio: 'pipe',
        }).stdout || '';
        const conflictFiles = parseConflictFiles(statusOut);
        res.json({ synced: false, conflict: true, conflictFiles, message: '충돌이 있습니다. 어떻게 할까요?' });
      } else {
        broadcast({ type: 'playground-synced', name });
        res.json({ synced: true, message: '최신 버전이 반영되었습니다.' });
      }
    } catch (err) {
      const msg = err.message || '';
      if (msg.includes('CONFLICT')) {
        const statusOut = spawnSync('git', ['-C', campPath(name), 'status', '--porcelain'], {
          encoding: 'utf8', stdio: 'pipe',
        }).stdout || '';
        const conflictFiles = parseConflictFiles(statusOut);
        res.json({ synced: false, conflict: true, conflictFiles, message: '충돌이 있습니다. 어떻게 할까요?' });
      } else {
        res.status(500).json({ error: err.message });
      }
    }
  });

  // POST /api/playgrounds/:name/resolve-conflict
  // body: { strategy: 'claude' | 'ours' | 'theirs' }
  app.post('/api/playgrounds/:name/resolve-conflict', async (req, res) => {
    const { name } = req.params;
    const { strategy } = req.body ?? {};
    const pg = getOne(name);
    if (!pg) return res.status(404).json({ error: 'not found' });

    const wtPath = campPath(name);

    if (strategy === 'ours') {
      spawnSync('git', ['-C', wtPath, 'checkout', '--ours', '.'], { stdio: 'pipe' });
      spawnSync('git', ['-C', wtPath, 'add', '.'], { stdio: 'pipe' });
      spawnSync('git', ['-C', wtPath, 'commit', '--no-edit'], { stdio: 'pipe' });
      return res.json({ resolved: true, strategy: 'ours' });
    }

    if (strategy === 'theirs') {
      spawnSync('git', ['-C', wtPath, 'checkout', '--theirs', '.'], { stdio: 'pipe' });
      spawnSync('git', ['-C', wtPath, 'add', '.'], { stdio: 'pipe' });
      spawnSync('git', ['-C', wtPath, 'commit', '--no-edit'], { stdio: 'pipe' });
      return res.json({ resolved: true, strategy: 'theirs' });
    }

    if (strategy === 'claude') {
      if (runningTasks.has(name)) {
        return res.status(409).json({ error: '이미 작업 중입니다.' });
      }

      const statusOut = spawnSync('git', ['-C', wtPath, 'status', '--porcelain'], {
        encoding: 'utf8', stdio: 'pipe',
      }).stdout || '';
      const conflictFiles = parseConflictFiles(statusOut);
      const prompt = buildConflictPrompt(conflictFiles);

      const child = spawn('claude', ['-p', prompt, '--output-format', 'text'], {
        cwd: wtPath,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '0' },
      });

      runningTasks.set(name, child);
      broadcast({ type: 'task-started', name, data: { prompt: '충돌 해결 중...' } });

      child.stdout.on('data', (chunk) => {
        broadcast({ type: 'task-output', name, data: { text: chunk.toString() } });
      });
      child.stderr.on('data', (chunk) => {
        broadcast({ type: 'task-output', name, data: { text: chunk.toString() } });
      });
      child.on('close', (code) => {
        runningTasks.delete(name);
        // Commit after Claude resolves conflicts
        spawnSync('git', ['-C', wtPath, 'add', '.'], { stdio: 'pipe' });
        const hasConflicts = (spawnSync('git', ['-C', wtPath, 'diff', '--check'], { stdio: 'pipe' }).status !== 0);
        if (!hasConflicts) {
          spawnSync('git', ['-C', wtPath, 'commit', '--no-edit'], { stdio: 'pipe' });
          broadcast({ type: 'conflict-resolved', name, data: { strategy: 'claude' } });
        } else {
          broadcast({ type: 'conflict-failed', name, data: { message: 'Claude가 충돌을 완전히 해결하지 못했습니다.' } });
        }
      });
      child.on('error', (err) => {
        runningTasks.delete(name);
        const msg = err.code === 'ENOENT'
          ? 'Claude CLI가 설치되어 있지 않습니다.'
          : err.message;
        broadcast({ type: 'task-error', name, data: { error: msg } });
      });

      return res.json({ resolving: true, strategy: 'claude' });
    }

    res.status(400).json({ error: 'strategy must be claude, ours, or theirs' });
  });

  // POST /api/playgrounds/:name/resolve-abort — cancel conflict state
  app.post('/api/playgrounds/:name/resolve-abort', (req, res) => {
    const { name } = req.params;
    if (!getOne(name)) return res.status(404).json({ error: 'not found' });
    const wtPath = campPath(name);
    spawnSync('git', ['-C', wtPath, 'merge', '--abort'], { stdio: 'pipe' });
    res.json({ aborted: true });
  });

  // -------------------------------------------------------------------------
  // Task runner (claude -p spawn)
  // -------------------------------------------------------------------------

  app.post('/api/playgrounds/:name/task', (req, res) => {
    const { name } = req.params;
    const { prompt } = req.body ?? {};
    const pg = getOne(name);
    if (!pg) return res.status(404).json({ error: '캠프를 찾을 수 없습니다.' });
    if (!prompt?.trim()) return res.status(400).json({ error: '할 일을 입력해주세요.' });
    if (runningTasks.has(name)) return res.status(409).json({ error: '이미 작업 중입니다.' });

    const cwd = campPath(name);
    const child = spawn('claude', ['-p', prompt.trim(), '--output-format', 'text'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    runningTasks.set(name, child);
    broadcast({ type: 'task-started', name, data: { prompt: prompt.trim() } });

    child.stdout.on('data', (chunk) => {
      broadcast({ type: 'task-output', name, data: { text: chunk.toString() } });
    });
    child.stderr.on('data', (chunk) => {
      broadcast({ type: 'task-output', name, data: { text: chunk.toString() } });
    });
    child.on('close', (code) => {
      runningTasks.delete(name);
      const actions = readActions(name);
      actions.push({ description: prompt.trim(), files: [], ts: Date.now() });
      writeActions(name, actions);
      broadcast({ type: 'task-done', name, data: { code, prompt: prompt.trim() } });
    });
    child.on('error', (err) => {
      runningTasks.delete(name);
      const msg = err.code === 'ENOENT'
        ? 'Claude CLI가 설치되어 있지 않습니다. npm i -g @anthropic-ai/claude-code 로 설치하세요.'
        : err.message;
      broadcast({ type: 'task-error', name, data: { error: msg } });
    });

    res.json({ started: true });
  });

  app.post('/api/playgrounds/:name/task/cancel', (req, res) => {
    const { name } = req.params;
    const child = runningTasks.get(name);
    if (!child) return res.status(404).json({ error: '진행 중인 작업이 없습니다.' });
    child.kill('SIGTERM');
    runningTasks.delete(name);
    broadcast({ type: 'task-cancelled', name });
    res.json({ cancelled: true });
  });

  app.get('/api/playgrounds/:name/task/status', (req, res) => {
    res.json({ running: runningTasks.has(req.params.name) });
  });

  // POST /api/playgrounds/:name/enter — 캠프 진입 (전체 정보 + Warp 탭 열기)
  app.post('/api/playgrounds/:name/enter', async (req, res) => {
    const { name } = req.params;
    const pg = getOne(name);
    if (!pg) return res.status(404).json({ error: 'not found' });

    const wtPath = campPath(name);

    // Warp 탭 열기 시도
    const terminal = warpStatus.installed
      ? openWarpTab(wtPath)
      : { opened: false, terminal: null, path: wtPath };

    // 변경사항 조회
    let changes = { count: 0, files: [], actions: [] };
    try {
      const files = getChangedFiles(wtPath);
      changes = { count: files.length, files, actions: readActions(name) };
    } catch { /* ignore */ }

    res.json({
      camp: pg,
      changes,
      terminal,
      previewUrl: pg.status === 'running' ? `http://localhost:${pg.fePort}` : null,
    });
  });

  // POST /api/playgrounds/:name/open-terminal — 터미널만 열기
  app.post('/api/playgrounds/:name/open-terminal', (req, res) => {
    const { name } = req.params;
    const pg = getOne(name);
    if (!pg) return res.status(404).json({ error: 'not found' });

    const wtPath = campPath(name);
    const result = openWarpTab(wtPath);
    res.json(result);
  });

  // GET /api/my-work — 내 진행 중인 작업 (open PRs + 로컬 캠프)
  app.get('/api/my-work', async (_req, res) => {
    const camps = getAll();

    // Open PRs by me (gh CLI)
    let prs = [];
    const ghCheck = spawnSync('which', ['gh'], { stdio: 'pipe' });
    if (ghCheck.status === 0) {
      const prResult = spawnSync('gh', ['pr', 'list', '--author', '@me', '--state', 'open', '--json', 'number,title,url,headRefName,updatedAt,isDraft,reviewDecision'], {
        encoding: 'utf8', stdio: 'pipe', timeout: 10_000,
      });
      if (prResult.status === 0) {
        try { prs = JSON.parse(prResult.stdout); } catch { /* ignore */ }
      }
    }

    // Match camps to PRs
    const work = [];

    // 1. PRs (리뷰중)
    for (const pr of prs) {
      const camp = camps.find(c => c.branch === pr.headRefName);
      work.push({
        type: 'pr',
        title: pr.title,
        prNumber: pr.number,
        prUrl: pr.url,
        branch: pr.headRefName,
        updatedAt: pr.updatedAt,
        isDraft: pr.isDraft,
        reviewStatus: pr.reviewDecision || 'PENDING',
        camp: camp?.name || null,
      });
    }

    // 2. Local camps without PR (작업중)
    const prBranches = new Set(prs.map(p => p.headRefName));
    for (const camp of camps) {
      if (!prBranches.has(camp.branch)) {
        work.push({
          type: 'camp',
          title: camp.name,
          branch: camp.branch,
          status: camp.status,
          camp: camp.name,
        });
      }
    }

    res.json(work);
  });

  // POST /api/quick-start — 자연어 → 브랜치 생성 → 캠프 생성
  app.post('/api/quick-start', async (req, res) => {
    const { description } = req.body ?? {};
    if (!description?.trim()) return res.status(400).json({ error: '뭘 하고 싶은지 입력해주세요.' });

    const slug = slugify(description.trim());
    const name = slug.slice(0, 30);
    const branch = `camp/${slug}`;

    // Check if camp already exists
    if (getOne(name)) return res.status(409).json({ error: `'${name}' 캠프가 이미 있습니다.` });

    const existing = getAll();
    if (existing.length >= 7) return res.status(400).json({ error: '최대 7개 캠프까지 가능합니다.' });

    try {
      // Create branch from default branch (dev or main)
      const defaultBranch = spawnSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
        encoding: 'utf8', stdio: 'pipe',
      }).stdout?.trim()?.replace('refs/remotes/origin/', '') || 'main';

      spawnSync('git', ['branch', branch, `origin/${defaultBranch}`], { stdio: 'pipe' });

      const freshConfig2 = await loadConfig(projectRoot);
      setConfig(freshConfig2);
      if (freshConfig2.ports) setPortConfig(freshConfig2.ports);

      const { slot, fePort, bePort } = allocate(existing);
      const actualFePort2 = freshConfig2.dev?.portFlag ? fePort : (freshConfig2.dev?.port || fePort);
      await addWorktree(name, branch);

      const wtPath = campPath(name);

      copyCampFiles(projectRoot, wtPath, freshConfig2.copyFiles, (msg) => {
        broadcast({ type: 'log', name, source: 'sanjang', data: msg });
      });

      const record = { name, branch, slot, fePort: actualFePort2, bePort, status: 'setting-up', description: description.trim() };
      upsert(record);
      broadcast({ type: 'playground-created', name, data: record });
      res.status(201).json(record);

      // Try cached node_modules first, fall back to full setup
      if (freshConfig2.setup) {
        const setupCwd = freshConfig2.dev?.cwd || '.';
        const cacheResult = applyCacheToWorktree(projectRoot, wtPath, setupCwd);

        if (cacheResult.applied) {
          broadcast({ type: 'log', name, source: 'sanjang', data: `캐시에서 node_modules 복사 완료 ✓ (${cacheResult.duration}ms)` });
          upsert({ ...getOne(name), status: 'stopped' });
          broadcast({ type: 'playground-status', name, data: { status: 'stopped' } });
        } else {
          broadcast({ type: 'log', name, source: 'sanjang', data: `캐시 없음 (${cacheResult.reason}), 설치 중 (${freshConfig2.setup})...` });
          const setupProc = spawn(freshConfig2.setup, [], {
            cwd: wtPath, shell: true, stdio: ['ignore', 'pipe', 'pipe'],
          });
          setupProc.stdout.on('data', (d) => {
            broadcast({ type: 'log', name, source: 'setup', data: d.toString() });
          });
          setupProc.stderr.on('data', (d) => {
            broadcast({ type: 'log', name, source: 'setup', data: d.toString() });
          });
          setupProc.on('close', (code) => {
            if (code === 0) {
              broadcast({ type: 'log', name, source: 'sanjang', data: '설치 완료 ✓' });
              upsert({ ...getOne(name), status: 'stopped' });
              broadcast({ type: 'playground-status', name, data: { status: 'stopped' } });
            } else {
              broadcast({ type: 'log', name, source: 'sanjang', data: `⚠️ 설치 실패 (코드 ${code})` });
              upsert({ ...getOne(name), status: 'error' });
              broadcast({ type: 'playground-status', name, data: { status: 'error', error: '의존성 설치에 실패했습니다.' } });
            }
          });
        }
      } else {
        upsert({ ...getOne(name), status: 'stopped' });
        broadcast({ type: 'playground-status', name, data: { status: 'stopped' } });
      }
    } catch (err) {
      try { await removeWorktree(name); } catch { /* cleanup */ }
      spawnSync('git', ['branch', '-D', branch], { stdio: 'pipe' });
      res.status(500).json({ error: friendlyError(err, branch) });
    }
  });

  // SPA fallback
  app.get('*', (_req, res) => {
    res.sendFile(join(__dirname, '..', 'dashboard', 'index.html'));
  });

  return { app, server, port, runningTasks, warpStatus };
}

export async function startServer(projectRoot, options = {}) {
  const { server, port, runningTasks, warpStatus } = await createApp(projectRoot, options);
  server.listen(port, '127.0.0.1', () => {
    console.log(`⛰ 산장 서버 실행 중 — http://localhost:${port}`);
    if (warpStatus.installed) {
      console.log('  Warp 감지됨 ✓ — 캠프 진입 시 터미널이 자동으로 열립니다');
    } else {
      console.log('  ℹ Warp를 설치하면 캠프↔터미널 자동 연동을 사용할 수 있습니다');
    }
  });

  // Graceful shutdown
  function shutdown() {
    console.log('\n⛰ 산장 종료 중...');
    for (const [, child] of runningTasks) {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    }
    stopAllCamps();
    server.close(() => process.exit(0));
    // Force exit after 10s if cleanup hangs
    setTimeout(() => process.exit(1), 10_000);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return server;
}
