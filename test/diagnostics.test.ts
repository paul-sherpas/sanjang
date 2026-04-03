import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildDiagnostics } from '../lib/engine/diagnostics.ts';

describe('diagnostics', () => {
  it('detects port conflict in logs', async () => {
    const pg = { fePort: 3001 };
    const processInfo = {
      feLogs: ['Error: listen EADDRINUSE: address already in use :::3001'],
      feExitCode: 1,
    };
    const checks = await buildDiagnostics(pg, processInfo);
    const portCheck = checks.find(c => c.name === 'port-conflict');
    assert.equal(portCheck?.status, 'error');
  });

  it('reports ok when no port conflict', async () => {
    const pg = { fePort: 3001 };
    const processInfo = { feLogs: ['Server started on port 3001'], feExitCode: null };
    const checks = await buildDiagnostics(pg, processInfo);
    const portCheck = checks.find(c => c.name === 'port-conflict');
    assert.equal(portCheck?.status, 'ok');
  });

  it('detects abnormal frontend exit', async () => {
    const pg = { fePort: 3001 };
    const processInfo = { feLogs: ['MODULE_NOT_FOUND: some-module'], feExitCode: 1 };
    const checks = await buildDiagnostics(pg, processInfo);
    const exitCheck = checks.find(c => c.name === 'frontend-exit');
    assert.equal(exitCheck?.status, 'error');
    assert.ok(exitCheck?.detail.includes('비정상'));
  });

  it('reports ok for running process', async () => {
    const pg = { fePort: 3001 };
    const processInfo = { feLogs: [], feExitCode: null };
    const checks = await buildDiagnostics(pg, processInfo);
    const exitCheck = checks.find(c => c.name === 'frontend-exit');
    assert.equal(exitCheck?.status, 'ok');
  });

  it('reports ok for clean exit', async () => {
    const pg = { fePort: 3001 };
    const processInfo = { feLogs: [], feExitCode: 0 };
    const checks = await buildDiagnostics(pg, processInfo);
    const exitCheck = checks.find(c => c.name === 'frontend-exit');
    assert.equal(exitCheck?.status, 'ok');
  });

  it('returns 3 diagnostic checks', async () => {
    const pg = { fePort: 9999 };
    const processInfo = { feLogs: [], feExitCode: null };
    const checks = await buildDiagnostics(pg, processInfo);
    assert.equal(checks.length, 3);
  });
});
