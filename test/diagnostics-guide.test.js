import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildDiagnostics } from '../lib/engine/diagnostics.js';

describe('diagnostics guides', () => {
  it('port conflict includes actionable guide', async () => {
    const pg = { fePort: 3001 };
    const processInfo = {
      feLogs: ['Error: address already in use :::3001'],
      feExitCode: 1,
    };
    const checks = await buildDiagnostics(pg, processInfo);
    const portCheck = checks.find(c => c.name === 'port-conflict');
    assert.ok(portCheck.guide);
    assert.ok(portCheck.guide.length > 0);
  });

  it('frontend exit error includes guide', async () => {
    const pg = { fePort: 3001 };
    const processInfo = { feLogs: ['MODULE_NOT_FOUND'], feExitCode: 1 };
    const checks = await buildDiagnostics(pg, processInfo);
    const exitCheck = checks.find(c => c.name === 'frontend-exit');
    assert.ok(exitCheck.guide);
  });

  it('ok status has no guide', async () => {
    const pg = { fePort: 3001 };
    const processInfo = { feLogs: [], feExitCode: null };
    const checks = await buildDiagnostics(pg, processInfo);
    const exitCheck = checks.find(c => c.name === 'frontend-exit');
    assert.equal(exitCheck.guide, null);
  });
});
