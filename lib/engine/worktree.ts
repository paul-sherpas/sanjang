import { join } from 'node:path';
import simpleGit, { type SimpleGit } from 'simple-git';
import { getCampsDir } from './state.ts';

let projectRoot: string | null = null;

export interface BranchInfo {
  name: string;
  remote: boolean;
  local: boolean;
  date: string;
  category?: 'default' | 'feature' | 'fix' | 'other';
}

export function setProjectRoot(root: string): void {
  projectRoot = root;
}

export function getProjectRoot(): string {
  if (!projectRoot) throw new Error('projectRoot not initialized. Call setProjectRoot() first.');
  return projectRoot;
}

export function campPath(name: string): string {
  return join(getCampsDir(), name);
}

function git(): SimpleGit {
  return simpleGit(getProjectRoot());
}

export async function listBranches(): Promise<BranchInfo[]> {
  // Best-effort fetch — continue with local refs on network failure
  try { await git().fetch(['--prune']); } catch { /* offline is OK */ }

  const raw = await git().raw([
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(refname:short)\t%(committerdate:relative)\t%(refname)',
    'refs/heads/',
    'refs/remotes/origin/',
  ]);

  const map = new Map<string, BranchInfo>();
  for (const line of raw.trim().split('\n')) {
    if (!line) continue;
    const [shortName, date, fullRef] = line.split('\t');
    if (shortName.includes('HEAD')) continue;
    const isRemote = fullRef.startsWith('refs/remotes/origin/');
    const clean = shortName.replace(/^origin\//, '').trim();
    if (!clean) continue;

    const entry: BranchInfo = map.get(clean) || { name: clean, remote: false, local: false, date };
    if (isRemote) entry.remote = true;
    else entry.local = true;
    if (!entry.date) entry.date = date;
    map.set(clean, entry);
  }

  const branches = [...map.values()];

  for (const b of branches) {
    if (['dev', 'main', 'master'].includes(b.name)) {
      b.category = 'default';
    } else if (b.name.startsWith('feature/')) {
      b.category = 'feature';
    } else if (b.name.startsWith('fix/') || b.name.startsWith('hotfix/')) {
      b.category = 'fix';
    } else {
      b.category = 'other';
    }
  }

  return branches;
}

export async function addWorktree(name: string, branch: string): Promise<void> {
  const path = campPath(name);
  const refs = [`origin/${branch}`, branch];
  let lastErr: unknown;
  for (const ref of refs) {
    try {
      await git().raw(['worktree', 'add', '--detach', path, ref]);
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

export async function removeWorktree(name: string): Promise<void> {
  const path = campPath(name);
  await git().raw(['worktree', 'remove', '--force', path]);
}
