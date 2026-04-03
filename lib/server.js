import { createServer } from 'node:http';
import { execSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

import express from 'express';
import { WebSocketServer } from 'ws';

import { getAll, getOne, upsert, remove, setCampsDir } from './engine/state.js';
import { allocate, scanPorts, setPortConfig } from './engine/ports.js';
import { addWorktree, removeWorktree, listBranches, campPath, setProjectRoot, getProjectRoot } from './engine/worktree.js';
import { startCamp, stopCamp, getProcessInfo, setConfig } from './engine/process.js';
import { saveSnapshot, restoreSnapshot, listSnapshots } from './engine/snapshot.js';
import { buildDiagnostics } from './engine/diagnostics.js';
import { loadConfig } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Error translation
// ---------------------------------------------------------------------------

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

    const existing = getAll();
    if (getOne(name)) return res.status(409).json({ error: `'${name}' 캠프가 이미 있습니다.` });
    if (existing.length >= 7) return res.status(400).json({ error: '최대 7개 캠프까지 가능합니다.' });

    try {
      const { slot, fePort, bePort } = allocate(existing);
      await addWorktree(name, branch);

      const wtPath = campPath(name);

      // Run setup command (e.g., npm install)
      if (config.setup) {
        broadcast({ type: 'log', name, source: 'sanjang', data: `설치 중 (${config.setup})...` });
        execSync(config.setup, {
          cwd: config.dev?.cwd ? join(wtPath, config.dev.cwd) : wtPath,
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 120_000,
        });
        broadcast({ type: 'log', name, source: 'sanjang', data: '설치 완료 ✓' });
      }

      // Copy gitignored files
      if (config.copyFiles?.length) {
        for (const file of config.copyFiles) {
          const src = join(projectRoot, file);
          const dest = join(wtPath, file);
          try {
            copyFileSync(src, dest);
            broadcast({ type: 'log', name, source: 'sanjang', data: `${file} 복사 완료 ✓` });
          } catch {
            broadcast({ type: 'log', name, source: 'sanjang', data: `⚠️ ${file} 파일을 찾을 수 없습니다.` });
          }
        }
      }

      const record = { name, branch, slot, fePort, bePort, status: 'stopped' };
      upsert(record);
      broadcast({ type: 'playground-created', name, data: record });
      res.status(201).json(record);
    } catch (err) {
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
    if (index === undefined) return res.status(400).json({ error: 'index is required' });
    try {
      await restoreSnapshot(name, index);
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
      execSync(`git -C "${wtPath}" fetch origin`, { stdio: 'pipe' });
      execSync(`git -C "${wtPath}" reset --hard "origin/${pg.branch}"`, { stdio: 'pipe' });
      execSync(`git -C "${wtPath}" clean -fd`, { stdio: 'pipe' });
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
      const diff = execSync(`git -C "${wtPath}" diff --name-status`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      const untracked = execSync(`git -C "${wtPath}" ls-files --others --exclude-standard`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      const files = [];
      if (diff) {
        for (const line of diff.split('\n')) {
          const [status, ...pathParts] = line.split('\t');
          files.push({ path: pathParts.join('\t'), status: status === 'M' ? '수정' : status === 'D' ? '삭제' : status === 'A' ? '추가' : status });
        }
      }
      if (untracked) {
        for (const path of untracked.split('\n')) files.push({ path, status: '새 파일' });
      }
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
      const safeMsg = message.replace(/"/g, '\\"');

      execSync(`git -C "${wtPath}" checkout -b "${branchName}"`, { stdio: 'pipe' });
      execSync(`git -C "${wtPath}" add -A`, { stdio: 'pipe' });
      execSync(`git -C "${wtPath}" reset HEAD actions.json 2>/dev/null || true`, { stdio: 'pipe', shell: true });
      execSync(`git -C "${wtPath}" commit -m "${safeMsg}" --allow-empty`, { stdio: 'pipe' });
      execSync(`git -C "${wtPath}" push -u origin "${branchName}"`, { stdio: 'pipe' });
      execSync(`git -C "${wtPath}" checkout --detach`, { stdio: 'pipe' });

      writeActions(name, []);
      broadcast({ type: 'playground-shipped', name, data: { branch: branchName } });
      res.json({ shipped: true, branch: branchName });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/playgrounds/:name/revert-files', (req, res) => {
    const { name } = req.params;
    const { files } = req.body ?? {};
    if (!getOne(name)) return res.status(404).json({ error: 'not found' });
    if (!files?.length) return res.status(400).json({ error: '되돌릴 파일을 선택해주세요.' });
    try {
      const wtPath = campPath(name);
      for (const file of files) {
        try { execSync(`git -C "${wtPath}" checkout -- "${file}"`, { stdio: 'pipe' }); }
        catch { execSync(`rm -f "${wtPath}/${file}"`, { stdio: 'pipe' }); }
      }
      res.json({ reverted: files.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/playgrounds/:name/sync', (req, res) => {
    const { name } = req.params;
    const pg = getOne(name);
    if (!pg) return res.status(404).json({ error: 'not found' });
    try {
      const wtPath = campPath(name);
      execSync(`git -C "${wtPath}" fetch origin`, { stdio: 'pipe' });
      const result = execSync(`git -C "${wtPath}" merge "origin/${pg.branch}" --no-edit 2>&1`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      if (result.includes('CONFLICT')) {
        try { execSync(`git -C "${wtPath}" merge --abort`, { stdio: 'pipe' }); } catch {}
        res.json({ synced: false, conflict: true, message: '충돌이 있어서 자동 반영이 안 됩니다.' });
      } else {
        broadcast({ type: 'playground-synced', name });
        res.json({ synced: true, message: '최신 버전이 반영되었습니다.' });
      }
    } catch (err) {
      const msg = err.message || '';
      if (msg.includes('CONFLICT')) {
        try { execSync(`git -C "${campPath(name)}" merge --abort`, { stdio: 'pipe' }); } catch {}
        res.json({ synced: false, conflict: true, message: '충돌이 있어서 자동 반영이 안 됩니다.' });
      } else {
        res.status(500).json({ error: err.message });
      }
    }
  });

  // -------------------------------------------------------------------------
  // Task runner (claude -p spawn)
  // -------------------------------------------------------------------------

  const runningTasks = new Map();

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
      broadcast({ type: 'task-error', name, data: { error: err.message } });
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

  // SPA fallback
  app.get('*', (_req, res) => {
    res.sendFile(join(__dirname, '..', 'dashboard', 'index.html'));
  });

  return { app, server, port };
}

export async function startServer(projectRoot, options = {}) {
  const { server, port } = await createApp(projectRoot, options);
  server.listen(port, () => {
    console.log(`⛰ 산장 서버 실행 중 — http://localhost:${port}`);
  });
  return server;
}
