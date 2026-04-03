import simpleGit from 'simple-git';
import { campPath } from './worktree.js';

const STASH_PREFIX = 'sanjang-snapshot:';

export async function saveSnapshot(name, label) {
  const git = simpleGit(campPath(name));
  await git.raw(['stash', 'push', '--include-untracked', '-m', `${STASH_PREFIX}${label}`]);
}

export async function restoreSnapshot(name, index) {
  const git = simpleGit(campPath(name));
  await git.raw(['checkout', '--', '.']).catch(() => {});
  await git.raw(['clean', '-fd']).catch(() => {});
  await git.raw(['stash', 'apply', `stash@{${index}}`]);
}

export async function listSnapshots(name) {
  const git = simpleGit(campPath(name));
  try {
    const result = await git.raw(['stash', 'list', '--format=%gd|%s|%ci']);
    if (!result?.trim()) return [];

    return result
      .trim()
      .split('\n')
      .map(line => {
        const [ref, message, date] = line.split('|');
        const match = ref?.match(/stash@\{(\d+)\}/);
        const index = match ? parseInt(match[1], 10) : 0;
        const isSanjangSnapshot = message ? message.includes(STASH_PREFIX) : false;
        return { index, message: message || '', isSanjangSnapshot, date: date || '' };
      })
      .filter(entry => entry.isSanjangSnapshot);
  } catch {
    return [];
  }
}
