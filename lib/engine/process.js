import { spawn, execSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { campPath, getProjectRoot } from './worktree.js';

const procs = new Map();
let projectConfig = null;

export function setConfig(config) {
  projectConfig = config;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function waitForPort(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    function attempt() {
      const sock = createConnection({ port, host: 'localhost' });
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() >= deadline) {
          reject(new Error(`포트 ${port}이 ${timeoutMs / 1000}초 내에 열리지 않았습니다.`));
        } else {
          setTimeout(attempt, 2000);
        }
      });
    }
    attempt();
  });
}

function waitForHttp(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    async function attempt() {
      try {
        const res = await fetch(url);
        if (res.ok) return resolve();
      } catch { /* not ready */ }
      if (Date.now() >= deadline) {
        reject(new Error(`HTTP 응답 없음 (${timeoutMs / 1000}초 초과)`));
      } else {
        setTimeout(attempt, 3000);
      }
    }
    attempt();
  });
}

function attachLogs(child, logBuf, source, onEvent) {
  function handleData(data) {
    const text = data.toString();
    logBuf.push(text);
    for (const line of text.split('\n')) {
      if (line.trim()) onEvent({ type: 'log', source, data: line });
    }
  }
  child.stdout?.on('data', handleData);
  child.stderr?.on('data', handleData);
}

// ---------------------------------------------------------------------------
// Backend (shared, optional)
// ---------------------------------------------------------------------------

async function ensureBackend(onEvent) {
  const be = projectConfig?.backend;
  if (!be) return; // No backend configured

  // Check if already running
  try {
    const healthUrl = be.healthCheck?.startsWith('/')
      ? `http://localhost:${be.port}${be.healthCheck}`
      : `http://localhost:${be.port}`;
    const res = await fetch(healthUrl);
    if (res.ok) {
      onEvent({ type: 'log', source: 'sanjang', data: `Backend(:${be.port}) 실행 중 ✓` });
      return;
    }
  } catch { /* not running */ }

  onEvent({ type: 'log', source: 'sanjang', data: `Backend(:${be.port}) 시작 중...` });

  const [cmd, ...args] = be.command.split(' ');
  const cwd = be.cwd ? join(getProjectRoot(), be.cwd) : getProjectRoot();

  const beProc = spawn(cmd, args, {
    cwd,
    env: { ...process.env, PORT: String(be.port), ...be.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    shell: true,
  });
  beProc.unref();
  beProc.stdout?.on('data', (d) => onEvent({ type: 'log', source: 'backend', data: d.toString() }));
  beProc.stderr?.on('data', (d) => onEvent({ type: 'log', source: 'backend', data: d.toString() }));

  if (be.healthCheck) {
    const healthUrl = be.healthCheck.startsWith('/')
      ? `http://localhost:${be.port}${be.healthCheck}`
      : be.healthCheck;
    await waitForHttp(healthUrl, 60_000);
  } else {
    await waitForPort(be.port, 60_000);
  }

  onEvent({ type: 'log', source: 'sanjang', data: `Backend(:${be.port}) 시작 완료 ✓` });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function startCamp(pg, onEvent) {
  const { name, fePort } = pg;
  const wtPath = campPath(name);
  const dev = projectConfig?.dev;

  if (!dev) throw new Error('dev command not configured');

  const entry = {
    feProc: null,
    feLogs: [],
    feExitCode: null,
  };
  procs.set(name, entry);

  // Step 1: Backend (optional, shared)
  try {
    await ensureBackend(onEvent);
  } catch (err) {
    onEvent({ type: 'log', source: 'sanjang', data: `⚠️ Backend 시작 실패 — FE만 띄웁니다. (${err.message})` });
  }

  // Step 2: Frontend
  onEvent({ type: 'log', source: 'sanjang', data: `Frontend(:${fePort}) 시작 중...` });
  onEvent({ type: 'status', data: 'starting-frontend' });

  // Build command with port flag
  const portFlag = dev.portFlag || '--port';
  const fullCommand = `${dev.command} ${portFlag} ${fePort}`;
  const cwd = dev.cwd ? join(wtPath, dev.cwd) : wtPath;

  const feProc = spawn(fullCommand, [], {
    cwd,
    env: {
      ...process.env,
      ...dev.env,
      ...(projectConfig?.backend ? {
        VITE_API_PROXY_TARGET: `http://localhost:${projectConfig.backend.port}`,
      } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  });

  entry.feProc = feProc;
  attachLogs(feProc, entry.feLogs, 'frontend', onEvent);
  feProc.on('exit', (code) => {
    entry.feExitCode = code;
    onEvent({ type: 'process-exit', source: 'frontend', data: code });
  });

  onEvent({ type: 'status', data: 'waiting-for-vite' });
  await waitForPort(fePort, 60_000);

  onEvent({ type: 'log', source: 'sanjang', data: `Frontend 시작 완료 ✓ → http://localhost:${fePort}` });
  onEvent({ type: 'status', data: 'running' });
}

export function stopCamp(name) {
  const entry = procs.get(name);
  if (!entry) return;
  entry.feProc?.kill('SIGTERM');
  procs.delete(name);
}

export function getProcessInfo(name) {
  const entry = procs.get(name);
  if (!entry) return null;
  return {
    feLogs: entry.feLogs,
    feExitCode: entry.feExitCode,
  };
}
