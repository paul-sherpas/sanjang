# 바이브 코더 UX 갭 해소 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 바이브 코더가 대시보드 안에서 PR 생성, 충돌 해결, 에러 복구까지 터미널 없이 완료할 수 있게 한다.

**Architecture:** 기존 Express REST API + WebSocket 브로드캐스트 패턴을 유지하면서, ship 엔드포인트를 확장하여 `gh` CLI로 PR을 생성하고, sync 엔드포인트에 Claude 기반 충돌 해결을 추가한다. 에러 UX는 기존 diagnostics 시스템 위에 "다음 단계" 가이드를 얹는다. 설치는 `npx sanjang init`으로 원클릭화한다.

**Tech Stack:** Node.js, Express, WebSocket, `gh` CLI (GitHub), `claude -p` (충돌 해결), vanilla JS dashboard

---

## File Structure

```
bin/sanjang.js              — Modify: npx 원클릭 설치 플로우 추가
lib/server.js               — Modify: ship에 PR 생성, sync에 충돌 해결, 에러 가이드 API
lib/engine/pr.js            — Create: PR 본문 생성 (Claude rich body + fallback)
lib/engine/conflict.js      — Create: 충돌 감지 + Claude 해결 엔진
lib/engine/diagnostics.js   — Modify: 에러별 "다음 단계" 가이드 추가
dashboard/index.html        — Modify: PR 결과 모달, 충돌 해결 UI, 에러 가이드 영역
dashboard/app.js            — Modify: PR 플로우, 충돌 해결 UI, 에러 가이드 렌더링
test/ship-pr.test.js        — Create: PR 생성 테스트
test/conflict.test.js       — Create: 충돌 해결 테스트
test/diagnostics-guide.test.js — Create: 에러 가이드 테스트
```

---

## Task 1: "팀에 보내기" → PR까지 한 번에 (server.js + dashboard)

현재 ship은 commit+push만 하고 "터미널에서 PR 만들어줘"라고 안내한다.
바이브 코더는 터미널을 안 쓴다. 대시보드 안에서 PR까지 끝나야 한다.

**Files:**
- Modify: `lib/server.js:359-392` (ship 엔드포인트)
- Modify: `dashboard/index.html:112-134` (ship 모달)
- Modify: `dashboard/app.js:927-969` (shipPg 함수)
- Create: `test/ship-pr.test.js`

### 설계 결정

- `gh` CLI가 없으면 PR 생성을 건너뛰고 push만 완료. PR URL 대신 "gh CLI를 설치하면 PR도 자동으로 만들어집니다" 안내.
- PR 제목 = 사용자가 입력한 message.
- **PR 본문은 Claude가 생성한다.** Push 후 `claude -p`로 diff를 분석하여 변경 이유, 요약, 테스트 계획 등 풍부한 PR 본문을 만든다. Claude Code가 PR을 만들 때와 동일한 품질.
- Claude CLI가 없으면 fallback으로 간단한 파일 목록 + 작업 로그로 PR 본문 생성.
- ship 엔드포인트를 비동기로 전환: 즉시 `{ shipped: true, branch }` 응답 후, 백그라운드에서 Claude PR body 생성 → `gh pr create` → WebSocket으로 PR URL 브로드캐스트.
- ship 응답에 `prUrl` 필드 추가. 대시보드에서 "PR 보기" 링크 표시.

- [ ] **Step 1: Write the failing test**

```js
// test/ship-pr.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { buildFallbackPrBody } from '../lib/engine/pr.js';

describe('ship PR creation', () => {
  it('gh CLI detection returns boolean', () => {
    const result = spawnSync('which', ['gh'], { stdio: 'pipe' });
    const hasGh = result.status === 0;
    assert.equal(typeof hasGh, 'boolean');
  });

  it('fallback PR body includes message, actions, and files', () => {
    const body = buildFallbackPrBody({
      message: 'Fix login button',
      actions: [{ description: 'Changed button color' }, { description: 'Added hover effect' }],
      diffStat: ' src/app.js | 5 ++---\n 1 file changed, 2 insertions(+), 3 deletions(-)',
    });
    assert.ok(body.includes('Fix login button'));
    assert.ok(body.includes('Changed button color'));
    assert.ok(body.includes('src/app.js'));
    assert.ok(body.includes('산장'));
  });

  it('fallback PR body works with no actions', () => {
    const body = buildFallbackPrBody({
      message: 'Quick fix',
      actions: [],
      diffStat: '',
    });
    assert.ok(body.includes('Quick fix'));
    assert.ok(!body.includes('### 작업 내역'));
  });

  it('buildClaudePrPrompt includes diff context', () => {
    const { buildClaudePrPrompt } = await import('../lib/engine/pr.js');
    const prompt = buildClaudePrPrompt({
      message: 'Add dark mode',
      diffStat: ' src/theme.js | 20 ++++\n 1 file changed',
      diff: '+const dark = { bg: "#000" }',
    });
    assert.ok(prompt.includes('Add dark mode'));
    assert.ok(prompt.includes('diff'));
    assert.ok(prompt.includes('Summary'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/ship-pr.test.js`
Expected: FAIL — `pr.js` does not exist

- [ ] **Step 3: Implement PR helper module**

```js
// lib/engine/pr.js

/**
 * Build a fallback PR body when Claude CLI is unavailable.
 */
export function buildFallbackPrBody({ message, actions, diffStat }) {
  const lines = [
    `## Summary`,
    ``,
    message,
  ];

  if (actions?.length > 0) {
    lines.push('', '### 작업 내역');
    for (const a of actions) {
      lines.push(`- ${a.description}`);
    }
  }

  if (diffStat?.trim()) {
    lines.push('', '### 변경된 파일', '```', diffStat.trim(), '```');
  }

  lines.push('', '---', '_🏔 산장에서 보냄_');
  return lines.join('\n');
}

/**
 * Build a prompt for Claude to generate a rich PR body from the diff.
 */
export function buildClaudePrPrompt({ message, diffStat, diff }) {
  return [
    'You are writing a GitHub Pull Request description.',
    'The author described the change as: "' + message + '"',
    '',
    'Here is the diff stat:',
    diffStat || '(no stat)',
    '',
    'Here is the full diff (may be truncated):',
    (diff || '').slice(0, 8000),
    '',
    'Write a PR body in this format:',
    '## Summary',
    '<2-3 bullet points explaining what changed and why>',
    '',
    '## Changes',
    '<brief description of each modified file/component>',
    '',
    '## Test plan',
    '<how to verify this works>',
    '',
    '---',
    '_🏔 산장에서 보냄_',
    '',
    'Write in Korean if the commit message is Korean, English otherwise.',
    'Be concise. No filler. Just the facts.',
  ].join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/ship-pr.test.js`
Expected: PASS

- [ ] **Step 5: Implement async PR creation in ship endpoint**

`lib/server.js` — ship 엔드포인트의 push 성공 후 블록을 교체:

```js
// lib/server.js — ship 엔드포인트, push 성공 후
import { buildFallbackPrBody, buildClaudePrPrompt } from './engine/pr.js';

// 즉시 응답 (push까지 완료)
writeActions(name, []);
broadcast({ type: 'playground-shipped', name, data: { branch: branchName } });
res.json({ shipped: true, branch: branchName });

// 백그라운드에서 PR 생성
const ghCheck = spawnSync('which', ['gh'], { stdio: 'pipe' });
if (ghCheck.status === 0) {
  const diffStat = spawnSync('git', ['-C', wtPath, 'diff', '--stat', 'HEAD~1'],
    { encoding: 'utf8', stdio: 'pipe' }).stdout || '';
  const diff = spawnSync('git', ['-C', wtPath, 'diff', 'HEAD~1'],
    { encoding: 'utf8', stdio: 'pipe' }).stdout || '';
  const actions = readActions(name); // read before clearing

  // Try Claude for rich PR body, fallback to simple
  const claudeCheck = spawnSync('which', ['claude'], { stdio: 'pipe' });
  let prBody;

  if (claudeCheck.status === 0) {
    const prompt = buildClaudePrPrompt({ message, diffStat, diff });
    const claudeResult = spawnSync('claude', ['-p', prompt, '--output-format', 'text'], {
      cwd: wtPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    prBody = claudeResult.status === 0 && claudeResult.stdout?.trim()
      ? claudeResult.stdout.trim()
      : buildFallbackPrBody({ message, actions, diffStat });
  } else {
    prBody = buildFallbackPrBody({ message, actions, diffStat });
  }

  const prResult = spawnSync('gh', ['pr', 'create',
    '--title', message,
    '--body', prBody,
    '--head', branchName,
  ], { cwd: wtPath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

  if (prResult.status === 0) {
    const prUrl = prResult.stdout.trim();
    broadcast({ type: 'playground-pr-created', name, data: { prUrl, branch: branchName } });
  }
}
```

- [ ] **Step 4: Update ship modal UI for PR result**

`dashboard/index.html` — ship 모달 뒤에 결과 표시 영역 추가:

```html
<!-- Ship Result (shown after successful ship) -->
<div class="modal-backdrop" id="ship-result-modal">
  <div class="modal" role="dialog" aria-modal="true">
    <h2>보내기 완료!</h2>
    <div id="ship-result-content"></div>
    <div class="modal-actions">
      <button class="btn btn-primary" onclick="closeShipResultModal()">확인</button>
    </div>
  </div>
</div>
```

- [ ] **Step 5: Update shipPg function for PR result**

`dashboard/app.js` — `shipPg` 함수의 성공 핸들러 수정:

```js
// dashboard/app.js — shipPg 성공 시
const result = await api('POST', `/api/playgrounds/${shipModalName}/ship`, { message });
closeShipModal();

const content = document.getElementById('ship-result-content');
if (result.prUrl) {
  content.innerHTML = `
    <p style="margin-bottom:12px">변경사항이 팀에 전달되었습니다.</p>
    <a href="${escHtml(result.prUrl)}" target="_blank" class="btn btn-primary"
       style="display:inline-block;text-decoration:none">
      PR 보기 →
    </a>
    <p style="margin-top:12px;font-size:12px;color:var(--text-muted)">
      팀원이 확인하고 반영할 거예요.
    </p>`;
} else {
  content.innerHTML = `
    <p style="margin-bottom:12px">코드가 올라갔습니다.</p>
    <p style="font-size:13px;color:var(--text-muted)">
      gh CLI를 설치하면 PR도 자동으로 만들어집니다.<br>
      <code style="font-size:12px">brew install gh && gh auth login</code>
    </p>`;
}
document.getElementById('ship-result-modal').classList.add('open');
```

`closeShipResultModal` 함수 + WebSocket PR 알림 핸들러 추가:

```js
window.closeShipResultModal = function() {
  document.getElementById('ship-result-modal').classList.remove('open');
};
```

`handleWsMessage`의 switch문에 추가:

```js
case 'playground-pr-created': {
  if (!name) break;
  // PR URL을 받으면 결과 모달 업데이트
  const content = document.getElementById('ship-result-content');
  content.innerHTML = `
    <p style="margin-bottom:12px">PR이 만들어졌습니다!</p>
    <a href="${escHtml(data?.prUrl || '')}" target="_blank" class="btn btn-primary"
       style="display:inline-block;text-decoration:none">
      PR 보기 →
    </a>
    <p style="margin-top:12px;font-size:12px;color:var(--text-muted)">
      팀원이 확인하고 반영할 거예요.
    </p>`;
  document.getElementById('ship-result-modal').classList.add('open');
  toast(`PR이 만들어졌습니다!`, 'success');
  break;
}
```

`shipPg` 성공 핸들러 수정 — PR은 백그라운드에서 생성되므로 즉시 응답:

```js
const result = await api('POST', `/api/playgrounds/${shipModalName}/ship`, { message });
closeShipModal();

const content = document.getElementById('ship-result-content');
const ghInstalled = result.prUrl !== undefined; // 서버가 prUrl 필드를 안 보내면 gh 없음
content.innerHTML = `
  <p style="margin-bottom:12px">코드가 올라갔습니다!</p>
  <p style="font-size:13px;color:var(--text-muted)">
    PR을 만드는 중입니다... 잠시 후 알림이 옵니다.
  </p>`;
document.getElementById('ship-result-modal').classList.add('open');
```

- [ ] **Step 6: Run tests and verify**

Run: `node --test test/ship-pr.test.js`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add lib/server.js dashboard/index.html dashboard/app.js test/ship-pr.test.js
git commit -m "feat: 팀에 보내기에서 PR 자동 생성 (gh CLI 연동)"
```

---

## Task 2: 충돌 해결 — Claude에게 맡기기 (conflict.js + server.js + dashboard)

현재 sync에서 충돌이 발생하면 "충돌이 있어서 자동 반영이 안 됩니다"만 표시하고 끝이다.
바이브 코더에게 충돌은 공포 그 자체다. Claude가 자동으로 해결하거나, 최소한 선택지를 줘야 한다.

**Files:**
- Create: `lib/engine/conflict.js`
- Modify: `lib/server.js:422-448` (sync 엔드포인트)
- Modify: `dashboard/index.html` (충돌 해결 모달)
- Modify: `dashboard/app.js` (syncPg 함수 + 충돌 UI)
- Create: `test/conflict.test.js`

### 설계 결정

- 충돌 발생 시 merge --abort 하지 않고, 충돌 파일 목록을 반환한다.
- 대시보드에 3가지 선택지 표시: "Claude에게 맡기기" / "내 것 유지" / "팀 것으로 덮기"
- "Claude에게 맡기기"는 기존 task runner (claude -p)를 재활용. 충돌 파일 컨텍스트와 함께 프롬프트 전달.
- "내 것 유지" = `git checkout --ours .` + `git add .`
- "팀 것으로 덮기" = `git checkout --theirs .` + `git add .`
- 해결 후 자동으로 `git commit` (merge commit)

- [ ] **Step 1: Write the test**

```js
// test/conflict.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseConflictFiles, buildConflictPrompt } from '../lib/engine/conflict.js';

describe('conflict', () => {
  it('parses conflict file list from git status', () => {
    const gitStatus = [
      'UU src/app.js',
      'UU src/config.js',
      'M  src/utils.js',
    ].join('\n');
    const result = parseConflictFiles(gitStatus);
    assert.deepEqual(result, ['src/app.js', 'src/config.js']);
  });

  it('returns empty array for no conflicts', () => {
    const gitStatus = 'M  src/utils.js\nA  src/new.js';
    const result = parseConflictFiles(gitStatus);
    assert.deepEqual(result, []);
  });

  it('builds Claude prompt with conflict context', () => {
    const files = ['src/app.js'];
    const prompt = buildConflictPrompt(files);
    assert.ok(prompt.includes('src/app.js'));
    assert.ok(prompt.includes('충돌'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/conflict.test.js`
Expected: FAIL — `conflict.js` does not exist

- [ ] **Step 3: Implement conflict.js**

```js
// lib/engine/conflict.js

/**
 * Parse `git status --porcelain` output to find conflicted files.
 * Conflict markers: UU (both modified), AA (both added), DD, AU, UA, DU, UD
 */
export function parseConflictFiles(statusOutput) {
  if (!statusOutput?.trim()) return [];
  return statusOutput
    .trim()
    .split('\n')
    .filter(line => /^(UU|AA|DD|AU|UA|DU|UD)\s/.test(line))
    .map(line => line.slice(3).trim());
}

/**
 * Build a Claude prompt to resolve merge conflicts.
 */
export function buildConflictPrompt(conflictFiles) {
  return [
    '아래 파일들에 git merge 충돌이 발생했습니다.',
    '각 파일의 충돌 마커(<<<<<<< ======= >>>>>>>)를 읽고,',
    '두 버전의 의도를 모두 살려서 충돌을 해결해주세요.',
    '해결 후 충돌 마커는 완전히 제거해야 합니다.',
    '',
    '충돌 파일 목록:',
    ...conflictFiles.map(f => `- ${f}`),
    '',
    '각 파일을 읽고 수정해주세요.',
  ].join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/conflict.test.js`
Expected: PASS

- [ ] **Step 5: Extend sync endpoint for conflict resolution**

`lib/server.js` — sync 엔드포인트 수정. 충돌 시 abort 대신 충돌 파일 목록을 반환:

```js
// lib/server.js — sync 엔드포인트 수정
// 기존 conflict 감지 블록을 다음으로 교체:

import { parseConflictFiles, buildConflictPrompt } from './engine/conflict.js';

// sync 엔드포인트에서 충돌 감지 시:
if (result.includes('CONFLICT')) {
  // 충돌 파일 목록 파싱 (merge abort 하지 않음)
  const statusOut = spawnSync('git', ['-C', wtPath, 'status', '--porcelain'], {
    encoding: 'utf8', stdio: 'pipe',
  }).stdout || '';
  const conflictFiles = parseConflictFiles(statusOut);
  res.json({
    synced: false,
    conflict: true,
    conflictFiles,
    message: '충돌이 있습니다. 어떻게 할까요?',
  });
}
```

새 엔드포인트 3개 추가 (sync 엔드포인트 뒤에):

```js
// POST /api/playgrounds/:name/resolve-conflict
// body: { strategy: 'claude' | 'ours' | 'theirs' }
app.post('/api/playgrounds/:name/resolve-conflict', async (req, res) => {
  const { name } = req.params;
  const { strategy } = req.body ?? {};
  const pg = getOne(name);
  if (!pg) return res.status(404).json({ error: 'not found' });

  const wtPath = campPath(name);

  if (strategy === 'ours') {
    spawnSync('git', ['-C', wtPath, 'checkout', '--ours', '.'], { stdio: 'pipe' });
    spawnSync('git', ['-C', wtPath, 'add', '.'], { stdio: 'pipe' });
    spawnSync('git', ['-C', wtPath, 'commit', '--no-edit'], { stdio: 'pipe' });
    return res.json({ resolved: true, strategy: 'ours' });
  }

  if (strategy === 'theirs') {
    spawnSync('git', ['-C', wtPath, 'checkout', '--theirs', '.'], { stdio: 'pipe' });
    spawnSync('git', ['-C', wtPath, 'add', '.'], { stdio: 'pipe' });
    spawnSync('git', ['-C', wtPath, 'commit', '--no-edit'], { stdio: 'pipe' });
    return res.json({ resolved: true, strategy: 'theirs' });
  }

  if (strategy === 'claude') {
    // Claude에게 충돌 해결 요청 (task runner 재활용)
    if (runningTasks.has(name)) {
      return res.status(409).json({ error: '이미 작업 중입니다.' });
    }

    const statusOut = spawnSync('git', ['-C', wtPath, 'status', '--porcelain'], {
      encoding: 'utf8', stdio: 'pipe',
    }).stdout || '';
    const conflictFiles = parseConflictFiles(statusOut);
    const prompt = buildConflictPrompt(conflictFiles);

    const child = spawn('claude', ['-p', prompt, '--output-format', 'text'], {
      cwd: wtPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    runningTasks.set(name, child);
    broadcast({ type: 'task-started', name, data: { prompt: '충돌 해결 중...' } });

    child.stdout.on('data', (chunk) => {
      broadcast({ type: 'task-output', name, data: { text: chunk.toString() } });
    });
    child.stderr.on('data', (chunk) => {
      broadcast({ type: 'task-output', name, data: { text: chunk.toString() } });
    });
    child.on('close', (code) => {
      runningTasks.delete(name);
      // 충돌 해결 후 자동 commit
      spawnSync('git', ['-C', wtPath, 'add', '.'], { stdio: 'pipe' });
      const hasConflicts = (spawnSync('git', ['-C', wtPath, 'diff', '--check'], { stdio: 'pipe' }).status !== 0);
      if (!hasConflicts) {
        spawnSync('git', ['-C', wtPath, 'commit', '--no-edit'], { stdio: 'pipe' });
        broadcast({ type: 'conflict-resolved', name, data: { strategy: 'claude' } });
      } else {
        broadcast({ type: 'conflict-failed', name, data: { message: 'Claude가 충돌을 완전히 해결하지 못했습니다.' } });
      }
    });
    child.on('error', (err) => {
      runningTasks.delete(name);
      const msg = err.code === 'ENOENT'
        ? 'Claude CLI가 설치되어 있지 않습니다.'
        : err.message;
      broadcast({ type: 'task-error', name, data: { error: msg } });
    });

    return res.json({ resolving: true, strategy: 'claude' });
  }

  res.status(400).json({ error: 'strategy must be claude, ours, or theirs' });
});

// POST /api/playgrounds/:name/resolve-abort — 충돌 상태 취소
app.post('/api/playgrounds/:name/resolve-abort', (req, res) => {
  const { name } = req.params;
  if (!getOne(name)) return res.status(404).json({ error: 'not found' });
  const wtPath = campPath(name);
  spawnSync('git', ['-C', wtPath, 'merge', '--abort'], { stdio: 'pipe' });
  res.json({ aborted: true });
});
```

- [ ] **Step 6: Add conflict resolution UI to dashboard**

`dashboard/index.html` — 충돌 해결 모달 추가:

```html
<!-- Conflict Modal -->
<div class="modal-backdrop" id="conflict-modal">
  <div class="modal" role="dialog" aria-modal="true">
    <h2>충돌이 발생했어요</h2>
    <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px">
      팀의 변경사항과 내 변경사항이 같은 부분을 수정해서 충돌이 생겼어요.
    </p>
    <div id="conflict-files" style="margin-bottom:16px"></div>
    <p style="font-size:13px;margin-bottom:16px">어떻게 할까요?</p>
    <div style="display:flex;flex-direction:column;gap:8px">
      <button class="btn btn-primary" onclick="resolveConflict('claude')">
        Claude에게 맡기기 (추천)
      </button>
      <button class="btn btn-ghost" onclick="resolveConflict('ours')">
        내 것 유지하기
      </button>
      <button class="btn btn-ghost" onclick="resolveConflict('theirs')">
        팀 것으로 덮기
      </button>
      <button class="btn btn-ghost" onclick="resolveAbort()" style="color:var(--text-muted)">
        취소 (원래대로 되돌리기)
      </button>
    </div>
  </div>
</div>
```

`dashboard/app.js` — syncPg 수정 + 충돌 핸들러:

```js
// dashboard/app.js — syncPg 수정
let conflictCampName = null;

window.syncPg = async function syncPg(name) {
  if (!confirm('팀의 최신 변경사항을 가져올까요?')) return;
  try {
    const result = await api('POST', `/api/playgrounds/${name}/sync`);
    if (result.conflict) {
      conflictCampName = name;
      const fileList = document.getElementById('conflict-files');
      if (result.conflictFiles?.length) {
        fileList.innerHTML = `<div style="font-size:12px;background:var(--bg-card);padding:8px;border-radius:4px">
          충돌 파일: ${result.conflictFiles.map(f => `<code>${escHtml(f)}</code>`).join(', ')}
        </div>`;
      } else {
        fileList.innerHTML = '';
      }
      document.getElementById('conflict-modal').classList.add('open');
    } else {
      toast(result.message, 'success');
    }
  } catch (err) {
    toast(`최신 반영 실패: ${err.message}`, 'error');
  }
};

window.resolveConflict = async function resolveConflict(strategy) {
  if (!conflictCampName) return;
  document.getElementById('conflict-modal').classList.remove('open');
  const label = { claude: 'Claude가 해결 중...', ours: '내 것으로 적용 중...', theirs: '팀 것으로 적용 중...' };
  toast(label[strategy] || '처리 중...', 'info');
  try {
    await api('POST', `/api/playgrounds/${conflictCampName}/resolve-conflict`, { strategy });
    if (strategy !== 'claude') {
      toast('충돌이 해결되었습니다!', 'success');
    }
    // claude strategy는 WebSocket으로 결과를 받음
  } catch (err) {
    toast(`충돌 해결 실패: ${err.message}`, 'error');
  }
  conflictCampName = null;
};

window.resolveAbort = async function resolveAbort() {
  if (!conflictCampName) return;
  document.getElementById('conflict-modal').classList.remove('open');
  try {
    await api('POST', `/api/playgrounds/${conflictCampName}/resolve-abort`);
    toast('원래대로 되돌렸습니다.', 'success');
  } catch (err) {
    toast(`되돌리기 실패: ${err.message}`, 'error');
  }
  conflictCampName = null;
};
```

WebSocket 핸들러에 `conflict-resolved` / `conflict-failed` 추가:

```js
// dashboard/app.js — handleWsMessage의 switch문에 추가
case 'conflict-resolved': {
  toast(`충돌이 해결되었습니다!`, 'success');
  break;
}
case 'conflict-failed': {
  toast(data?.message || '충돌 해결에 실패했습니다.', 'error');
  break;
}
```

- [ ] **Step 7: Run tests**

Run: `node --test test/conflict.test.js`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add lib/engine/conflict.js lib/server.js dashboard/index.html dashboard/app.js test/conflict.test.js
git commit -m "feat: 충돌 발생 시 Claude/ours/theirs 선택 해결 UI"
```

---

## Task 3: 에러 시 "다음 단계" 가이드 (diagnostics.js + dashboard)

현재 에러가 발생하면 기술적 메시지만 보인다.
바이브 코더에게 "이런 일이 일어났어요. 이렇게 하면 됩니다"를 보여줘야 한다.

**Files:**
- Modify: `lib/engine/diagnostics.js` — 각 체크에 `guide` 필드 추가
- Modify: `dashboard/app.js:411-432` — 진단 패널에 가이드 렌더링
- Modify: `dashboard/app.js:271-302` — error 카드에 가이드 표시
- Create: `test/diagnostics-guide.test.js`

### 설계 결정

- 기존 diagnostics 체크 함수들의 반환값에 `guide` 문자열 필드 추가
- guide는 한국어로, "뭘 해야 하는지" 버튼 클릭 가능한 형태로
- error 상태 카드에 diagnostics 결과를 자동 표시 (현재는 수동 "디버그" 버튼)

- [ ] **Step 1: Write the test**

```js
// test/diagnostics-guide.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/diagnostics-guide.test.js`
Expected: FAIL — `guide` field does not exist

- [ ] **Step 3: Add guide field to diagnostics checks**

`lib/engine/diagnostics.js` — 각 체크 함수에 `guide` 반환:

```js
function checkPortConflict(processInfo) {
  const combined = (processInfo.feLogs ?? []).join('');
  const hit = /address already in use/i.test(combined);
  return {
    name: 'port-conflict',
    status: hit ? 'error' : 'ok',
    detail: hit
      ? '포트가 이미 사용 중입니다.'
      : '포트 충돌 없음.',
    guide: hit
      ? '다른 프로그램이 같은 포트를 쓰고 있어요. "중지" → "시작"을 눌러보세요. 계속되면 "삭제" 후 다시 만들어보세요.'
      : null,
  };
}

function checkFrontendExit(processInfo) {
  const { feExitCode, feLogs } = processInfo;
  if (feExitCode === null || feExitCode === 0) {
    return {
      name: 'frontend-exit',
      status: 'ok',
      detail: feExitCode === 0 ? 'Frontend가 정상 종료되었습니다.' : 'Frontend 프로세스 실행 중.',
      guide: null,
    };
  }
  const tail = (feLogs ?? []).join('').slice(-500);
  const isModuleError = /MODULE_NOT_FOUND|Cannot find module/i.test(tail);
  const guide = isModuleError
    ? '필요한 패키지가 없어요. "처음부터 다시"를 눌러 의존성을 다시 설치해보세요.'
    : '서버가 에러로 종료됐어요. "처음부터 다시"를 누르거나, "디버그" 버튼으로 로그를 복사해서 Claude에게 물어보세요.';
  return {
    name: 'frontend-exit',
    status: 'error',
    detail: `Frontend가 비정상 종료되었습니다 (코드 ${feExitCode}).`,
    guide,
  };
}

function checkFePort(pg) {
  const port = pg.fePort;
  const output = tryExec(`lsof -i :${port} -t`);
  return {
    name: 'fe-port',
    status: output?.length ? 'ok' : 'warn',
    detail: output?.length
      ? `Frontend 포트 ${port}이 사용 중 (PID: ${output}).`
      : `Frontend 포트 ${port}이 비어있습니다.`,
    guide: !output?.length
      ? '서버가 아직 준비 안 됐거나 종료됐어요. "시작" 버튼을 눌러보세요.'
      : null,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/diagnostics-guide.test.js`
Expected: PASS

- [ ] **Step 5: Update dashboard to show guides**

`dashboard/app.js` — `updateDiagPanel` 수정:

```js
function updateDiagPanel(name) {
  const panel = document.getElementById(`diag-${name}`);
  if (!panel) return;

  const items = diagnostics.get(name) ?? [];
  if (items.length === 0) {
    panel.classList.add('hidden');
    return;
  }

  panel.classList.remove('hidden');

  const rows = items.map((item) => {
    const icon = item.status === 'ok' ? '✅' : item.status === 'error' ? '❌' : 'ℹ️';
    const guideHtml = item.guide
      ? `<div class="diag-guide">${escHtml(item.guide)}</div>`
      : '';
    return `<div class="diag-item">
      <span class="diag-icon">${icon}</span>
      <span class="diag-text"><strong>${escHtml(item.name ?? '')}</strong>${item.detail ? ' — ' + escHtml(item.detail) : ''}</span>
      ${guideHtml}
    </div>`;
  }).join('');

  panel.innerHTML = `<div class="diag-title">무슨 일이 일어났나요?</div>${rows}`;
}
```

error 상태 카드 힌트 문구 수정 (`renderCard` 안):

```js
// 기존:
// '시작에 실패했습니다. 로그를 확인하거나 "처음부터 다시"를 눌러보세요.'
// 변경:
'걱정 마세요! 아래 안내를 따라하면 됩니다.'
```

error 상태일 때 diagnostics를 자동으로 펼치도록 — `renderAll`에서 error 캠프의 diag 패널 자동 fetch:

```js
// renderAll 끝부분 — 이미 refreshChanges 호출하는 곳 근처에 추가
for (const [name, pg] of playgrounds) {
  if (pg.status === 'error' && !diagnostics.has(name)) {
    api('GET', `/api/playgrounds/${name}/diagnostics`).then(data => {
      diagnostics.set(name, data);
      updateDiagPanel(name);
    }).catch(() => {});
  }
}
```

- [ ] **Step 6: Add CSS for guide styling**

`dashboard/style.css` — 추가:

```css
.diag-guide {
  margin-top: 4px;
  padding: 6px 10px;
  background: var(--bg-input);
  border-radius: 4px;
  font-size: 12px;
  color: var(--text-primary);
  line-height: 1.5;
}
```

- [ ] **Step 7: Run all diagnostics tests**

Run: `node --test test/diagnostics.test.js test/diagnostics-guide.test.js`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add lib/engine/diagnostics.js dashboard/app.js dashboard/style.css dashboard/index.html test/diagnostics-guide.test.js
git commit -m "feat: 에러 시 한국어 다음 단계 가이드 표시"
```

---

## Task 4: 원클릭 설치 — `npx sanjang init` (bin/sanjang.js + package.json)

현재 설치는 `git clone` → `cd .sanjang` → `npm install` → `cd ..` → `node .sanjang/bin/sanjang.js init` 5단계이다.
바이브 코더에게 5단계 터미널 명령은 탈출 포인트이다. `npx sanjang init` 한 줄이면 끝나야 한다.

**Files:**
- Modify: `bin/sanjang.js` — init 명령 확장 (자동 감지 + 서버 시작)
- Modify: `package.json` — bin, files 필드 정리

### 설계 결정

- `npx sanjang init`은: 프로젝트 감지 → config 생성 → .gitignore 업데이트 → 서버 시작까지 한 번에.
- `npx sanjang`은 이미 config가 있으면 바로 서버 시작.
- `npx sanjang init --start` (기본값)으로 init 후 자동 서버 시작. `--no-start`로 config만 생성.
- README의 AI 설치 섹션도 단순화: `npx sanjang init` 한 줄로.

- [ ] **Step 1: Update bin/sanjang.js init command**

```js
// bin/sanjang.js — init 명령 수정
if (command === 'init') {
  const { generateConfig } = await import('../lib/config.js');
  const result = generateConfig(projectRoot);

  if (result.created) {
    console.log(`⛰ ${result.message}`);
    console.log(`  프레임워크: ${result.framework}`);
    console.log(`  설정 파일: ${result.configPath}`);
  } else {
    console.log(`⛰ ${result.message}`);
  }

  // Add .sanjang to .gitignore if not present
  const gitignorePath = resolve(projectRoot, '.gitignore');
  if (existsSync(gitignorePath)) {
    const content = (await import('node:fs')).readFileSync(gitignorePath, 'utf8');
    if (!content.includes('.sanjang')) {
      (await import('node:fs')).appendFileSync(gitignorePath, '\n# Sanjang local dev camps\n.sanjang/\n');
      console.log('  .gitignore에 .sanjang/ 추가됨');
    }
  }

  // Auto-start server unless --no-start
  const noStart = args.includes('--no-start');
  if (!noStart) {
    console.log('');
    console.log('  서버를 시작합니다...');
    const { startServer } = await import('../lib/server.js');
    await startServer(projectRoot, { port });
  } else {
    console.log('');
    console.log('  다음 단계: sanjang 또는 npx sanjang 으로 서버를 시작하세요.');
  }
}
```

- [ ] **Step 2: Update package.json for npx support**

`package.json` — files 필드 추가:

```json
{
  "files": [
    "bin/",
    "lib/",
    "dashboard/",
    "templates/"
  ]
}
```

- [ ] **Step 3: Simplify README install section**

`README.md` — AI 설치 절차 단순화:

```markdown
### 자동 설치 절차

1. **대상 프로젝트의 git root로 이동합니다.**

2. **산장을 설치하고 시작합니다:**
```bash
npx sanjang init
```
이 명령이 자동으로:
- 프로젝트를 분석하여 `sanjang.config.js` 생성
- `.gitignore`에 `.sanjang/` 추가
- 대시보드 서버 시작 (http://localhost:4000)

3. **사용자에게 안내합니다:**
```
⛰ 산장 설치 완료!
  대시보드: http://localhost:4000
  "+ 새 캠프" 버튼으로 브랜치별 작업 환경을 만들 수 있습니다.
```
```

- [ ] **Step 4: Run existing tests to verify no regression**

Run: `node --test test/**/*.test.js`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add bin/sanjang.js package.json README.md
git commit -m "feat: npx sanjang init 원클릭 설치 (자동 감지+서버 시작)"
```

---

## 실행 순서 & 의존성

```
Task 1 (PR 생성)        ← 독립, 먼저 시작 가능
Task 2 (충돌 해결)       ← 독립, 병렬 가능
Task 3 (에러 가이드)     ← 독립, 병렬 가능
Task 4 (원클릭 설치)     ← 독립, 병렬 가능
```

4개 태스크 모두 독립적. 병렬 실행 가능.

---

## 완료 기준

- [ ] "팀에 보내기" 후 대시보드에서 PR 링크가 보인다 (gh CLI 있을 때)
- [ ] gh CLI 없을 때 설치 안내가 보인다 (graceful degradation)
- [ ] sync에서 충돌 시 3가지 선택지 모달이 뜬다
- [ ] "Claude에게 맡기기"로 충돌이 자동 해결된다
- [ ] 에러 상태 카드에 한국어 다음 단계 가이드가 보인다
- [ ] `npx sanjang init` 한 줄로 설치+서버 시작이 된다
- [ ] 기존 테스트 전부 통과
