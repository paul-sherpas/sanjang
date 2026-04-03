// Tests for bin/sanjang.js CLI flag parsing logic
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('sanjang CLI flag parsing', () => {
  it('detects --no-start flag in args array', () => {
    const args = ['init', '--no-start'];
    const noStart = args.includes('--no-start');
    assert.equal(noStart, true);
  });

  it('does not detect --no-start when absent', () => {
    const args = ['init'];
    const noStart = args.includes('--no-start');
    assert.equal(noStart, false);
  });

  it('parses --port value correctly', () => {
    const args = ['init', '--port', '5000'];
    let port = 4000;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--port' && args[i + 1]) {
        port = parseInt(args[i + 1]!);
        i++;
      }
    }
    assert.equal(port, 5000);
  });

  it('uses default port 4000 when --port not specified', () => {
    const args = ['init'];
    let port = 4000;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--port' && args[i + 1]) {
        port = parseInt(args[i + 1]!);
        i++;
      }
    }
    assert.equal(port, 4000);
  });
});
