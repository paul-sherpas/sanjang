import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { Camp } from '../types.ts';

let campsDir: string | null = null;

export function setCampsDir(dir: string): void {
  campsDir = dir;
}

export function getCampsDir(): string {
  if (!campsDir) throw new Error('campsDir not initialized. Call setCampsDir() first.');
  return campsDir;
}

function stateFile(): string {
  return join(getCampsDir(), 'state.json');
}

function ensureDir(): void {
  mkdirSync(getCampsDir(), { recursive: true });
}

function read(): Camp[] {
  const f = stateFile();
  if (!existsSync(f)) return [];
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return [];
  }
}

function write(records: Camp[]): void {
  ensureDir();
  // Atomic write: write to temp file then rename to prevent corruption
  const tmp = stateFile() + '.tmp';
  writeFileSync(tmp, JSON.stringify(records, null, 2), 'utf8');
  renameSync(tmp, stateFile());
}

export function getAll(): Camp[] {
  return read();
}

export function getOne(name: string): Camp | null {
  return read().find((r) => r.name === name) ?? null;
}

export function upsert(record: Camp): void {
  const records = read();
  const idx = records.findIndex((r) => r.name === record.name);
  if (idx === -1) records.push(record);
  else records[idx] = record;
  write(records);
}

export function remove(name: string): void {
  write(read().filter((r) => r.name !== name));
}
