import { simpleGit } from 'simple-git';
import { campPath } from './worktree.ts';

const STASH_PREFIX = 'sanjang-snapshot:';

interface StashEntry {
  index: number;
  message: string;
  isSanjangSnapshot: boolean;
  date: string;
}

export async function saveSnapshot(name: string, label: string): Promise<void> {
  const git = simpleGit(campPath(name));
  await git.raw(['stash', 'push', '--include-untracked', '-m', `${STASH_PREFIX}${label}`]);
}

export async function restoreSnapshot(name: string, index: number): Promise<void> {
  const git = simpleGit(campPath(name));
  await git.raw(['checkout', '--', '.']).catch(() => {});
  await git.raw(['clean', '-fd']).catch(() => {});
  await git.raw(['stash', 'apply', `stash@{${index}}`]);
}

export async function listSnapshots(name: string): Promise<StashEntry[]> {
  const git = simpleGit(campPath(name));
  try {
    const result = await git.raw(['stash', 'list', '--format=%gd|%s|%ci']);
    if (!result?.trim()) return [];

    return result
      .trim()
      .split('\n')
      .map((line: string) => {
        const [ref, message, date] = line.split('|');
        const match = ref?.match(/stash@\{(\d+)\}/);
        const index = match ? parseInt(match[1]!, 10) : 0;
        const isSanjangSnapshot = message ? message.includes(STASH_PREFIX) : false;
        return { index, message: message || '', isSanjangSnapshot, date: date || '' };
      })
      .filter((entry: StashEntry) => entry.isSanjangSnapshot);
  } catch {
    return [];
  }
}
