import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';

let campsDir = null;

export function setCampsDir(dir) {
  campsDir = dir;
}

export function getCampsDir() {
  if (!campsDir) throw new Error('campsDir not initialized. Call setCampsDir() first.');
  return campsDir;
}

function stateFile() {
  return join(getCampsDir(), 'state.json');
}

function ensureDir() {
  mkdirSync(getCampsDir(), { recursive: true });
}

function read() {
  const f = stateFile();
  if (!existsSync(f)) return [];
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return [];
  }
}

function write(records) {
  ensureDir();
  // Atomic write: write to temp file then rename to prevent corruption
  const tmp = stateFile() + '.tmp';
  writeFileSync(tmp, JSON.stringify(records, null, 2), 'utf8');
  renameSync(tmp, stateFile());
}

export function getAll() {
  return read();
}

export function getOne(name) {
  return read().find((r) => r.name === name) ?? null;
}

export function upsert(record) {
  const records = read();
  const idx = records.findIndex((r) => r.name === record.name);
  if (idx === -1) records.push(record);
  else records[idx] = record;
  write(records);
}

export function remove(name) {
  write(read().filter((r) => r.name !== name));
}
