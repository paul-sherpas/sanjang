#!/usr/bin/env node
// Shell wrapper — delegates to the TypeScript entry point
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tsEntry = join(__dirname, 'sanjang.ts');

try {
  execFileSync(process.execPath, ['--experimental-transform-types', tsEntry, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
} catch (err) {
  process.exit(err?.status ?? 1);
}
