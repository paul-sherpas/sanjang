import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DevConfig } from '../lib/types.ts';

describe('process — portFlag handling', () => {
  it('uses config.dev.port when portFlag is null', () => {
    // portFlag:null means dev server uses its own fixed port
    const dev: Pick<DevConfig, 'command' | 'port' | 'portFlag'> = {
      command: 'vite dev',
      port: 3002,
      portFlag: null,
    };
    const fePort = 3001; // allocated by sanjang
    const actualPort = dev.portFlag ? fePort : dev.port;
    assert.equal(actualPort, 3002);
  });

  it('uses fePort when portFlag is set', () => {
    const dev: Pick<DevConfig, 'command' | 'port' | 'portFlag'> = {
      command: 'vite dev',
      port: 3000,
      portFlag: '--port',
    };
    const fePort = 3001;
    const actualPort = dev.portFlag ? fePort : dev.port;
    assert.equal(actualPort, 3001);
  });
});
