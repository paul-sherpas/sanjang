/* ============================================================
   산장 Dashboard — Client Logic
   ============================================================ */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {Map<string, { name: string, branch: string, status: string, fePort?: number, bePort?: number, slot?: number }>} */
const playgrounds = new Map();

/** @type {Map<string, Array<{text: string, source: string}>>} logs keyed by playground name */
const logs = new Map();

/** @type {Map<string, Array>} diagnostics keyed by playground name */
const diagnostics = new Map();

/** @type {Map<string, { running: boolean, prompt: string }>} task states */
const taskStates = new Map();

/** @type {string|null} name of camp in workspace view, or null for list view */
let currentWorkspace = null;

/** @type {number|null} polling interval for workspace changes */
let wsPollingInterval = null;

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Escape HTML to prevent XSS.
 * @param {string} str
 * @returns {string}
 */
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Show a toast notification.
 * @param {string} message
 * @param {'info'|'success'|'error'} type
 */
function toast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'error' ? ' toast-error' : type === 'success' ? ' toast-success' : '');
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/**
 * Fetch wrapper.
 * @param {string} method
 * @param {string} path
 * @param {object|null} [body]
 * @returns {Promise<any>}
 */
async function api(method, path, body = null) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== null) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

let ws = null;

function connectWs() {
  const url = `ws://${location.host}`;
  ws = new WebSocket(url);

  ws.addEventListener('message', (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    handleWsMessage(msg);
  });

  ws.addEventListener('close', () => {
    setTimeout(connectWs, 2000);
  });

  ws.addEventListener('error', () => {
    ws.close();
  });
}

/**
 * Handle incoming WebSocket message.
 * @param {{ type: string, name?: string, data?: any, source?: string }} msg
 */
function handleWsMessage(msg) {
  const { type, name, data, source } = msg;

  switch (type) {
    case 'log': {
      if (!name) break;
      if (!logs.has(name)) logs.set(name, []);
      const lines = logs.get(name);
      lines.push({ text: data, source: source ?? 'be' });
      if (lines.length > 50) lines.splice(0, lines.length - 50);
      updateLogPanel(name);
      if (currentWorkspace === name) updateWorkspaceLog(name);
      break;
    }

    case 'playground-status': {
      if (!name) break;
      const pg = playgrounds.get(name);
      if (pg) {
        playgrounds.set(name, { ...pg, ...data });
        renderAll();
      }
      break;
    }

    case 'playground-diagnostics': {
      if (!name) break;
      diagnostics.set(name, data ?? []);
      updateDiagPanel(name);
      break;
    }

    case 'playground-created': {
      if (!name || !data) break;
      playgrounds.set(name, data);
      renderAll();
      toast(`캠프 "${name}" 생성됨`, 'success');
      break;
    }

    case 'playground-deleted': {
      if (!name) break;
      playgrounds.delete(name);
      logs.delete(name);
      diagnostics.delete(name);
      renderAll();
      break;
    }

    case 'task-started': {
      if (!name) break;
      taskStates.set(name, { running: true, prompt: data?.prompt ?? '' });
      renderAll();
      toast(`캠프 "${name}"에 일 시킴!`, 'success');
      break;
    }

    case 'task-output': {
      if (!name) break;
      if (!logs.has(name)) logs.set(name, []);
      const taskLines = logs.get(name);
      taskLines.push({ text: data?.text ?? '', source: 'task' });
      if (taskLines.length > 100) taskLines.splice(0, taskLines.length - 100);
      updateLogPanel(name);
      if (currentWorkspace === name) updateWorkspaceLog(name);
      // auto-open log panel when task output comes
      const logToggle = document.querySelector(`[data-name="${name}"] .log-toggle`);
      if (logToggle && !logToggle.classList.contains('open')) logToggle.click();
      break;
    }

    case 'task-done': {
      if (!name) break;
      taskStates.delete(name);
      renderAll();
      toast(`캠프 "${name}" 작업 완료!`, 'success');
      break;
    }

    case 'task-error': {
      if (!name) break;
      taskStates.delete(name);
      renderAll();
      toast(`캠프 "${name}" 작업 실패: ${data?.error}`, 'error');
      break;
    }

    case 'task-cancelled': {
      if (!name) break;
      taskStates.delete(name);
      renderAll();
      toast(`캠프 "${name}" 작업 취소됨`, 'success');
      break;
    }

    case 'reset': {
      if (!name) break;
      toast(`캠프 "${name}" 초기화 완료`, 'success');
      break;
    }

    case 'playground-pr-created': {
      if (!name) break;
      // PR URL arrived from background — update result modal
      const prContent = document.getElementById('ship-result-content');
      if (prContent) {
        prContent.innerHTML = `
          <p style="margin-bottom:12px">PR이 만들어졌습니다!</p>
          <a href="${escHtml(data?.prUrl || '')}" target="_blank" class="btn btn-primary"
             style="display:inline-block;text-decoration:none">
            PR 보기 →
          </a>
          <p style="margin-top:12px;font-size:12px;color:var(--text-muted)">
            팀원이 확인하고 반영할 거예요.
          </p>`;
      }
      document.getElementById('ship-result-modal').classList.add('open');
      toast(`PR이 만들어졌습니다!`, 'success');
      break;
    }

    case 'conflict-resolved': {
      toast(`충돌이 해결되었습니다!`, 'success');
      break;
    }

    case 'conflict-failed': {
      toast(data?.message || '충돌 해결에 실패했습니다.', 'error');
      break;
    }

    case 'playground-saved': {
      if (!name) break;
      toast(`💾 세이브됨: ${data?.message || ''}`, 'success');
      break;
    }

    case 'file-changes': {
      if (!name || !data) break;
      if (currentWorkspace !== name) break;

      const changesEl2 = document.getElementById('ws-changes');
      const summaryText2 = document.getElementById('ws-changes-summary-text');
      if (!changesEl2) break;

      const prevPaths = new Set(
        [...changesEl2.querySelectorAll('.ws-file-item span:last-child')].map(el => el.textContent)
      );

      if (data.count === 0) {
        if (summaryText2) summaryText2.textContent = '변경 없음';
        changesEl2.innerHTML = '';
        renderBlocks([]);
      } else {
        if (summaryText2) summaryText2.textContent = `${data.count}개 파일 변경됨`;
        changesEl2.innerHTML = data.files.map(f => {
          const isNew = !prevPaths.has(f.path);
          return `<div class="ws-file-item${isNew ? ' ws-file-new' : ''}">
            <span class="changes-status changes-status-${f.status === '수정' ? 'mod' : f.status === '새 파일' ? 'new' : 'del'}">${escHtml(f.status)}</span>
            <span>${escHtml(f.path)}</span>
          </div>`;
        }).join('');
        renderBlocks(data.files);
        // Debounced AI summary fetch
        debounceSummaryFetch(name);
      }

      updateChangeSummary(data.count, data.ts);
      debouncePreviewRefresh();
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderAll() {
  const grid = document.getElementById('grid');

  // Show/hide the portal camps section based on whether camps exist
  const campsSection = document.getElementById('portal-camps-section');
  if (campsSection) {
    if (playgrounds.size > 0) {
      campsSection.classList.remove('hidden');
    } else {
      campsSection.classList.add('hidden');
    }
  }

  if (playgrounds.size === 0) {
    grid.innerHTML = '';
    return;
  }

  // Build a map of existing cards
  const existingCards = new Map();
  for (const card of grid.querySelectorAll('.card[data-name]')) {
    existingCards.set(card.dataset.name, card);
  }

  const names = [...playgrounds.keys()];

  // Remove cards for deleted playgrounds
  for (const [name, card] of existingCards) {
    if (!playgrounds.has(name)) card.remove();
  }

  // Add/update cards
  for (const name of names) {
    const pg = playgrounds.get(name);
    const html = renderCard(pg);
    const existing = existingCards.get(name);
    if (existing) {
      // Preserve log panel open state before replacing
      const logOpen = existing.querySelector('.log-panel')?.classList.contains('open');
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      const newCard = tmp.firstElementChild;
      if (logOpen) {
        newCard.querySelector('.log-panel')?.classList.add('open');
        newCard.querySelector('.log-toggle')?.classList.add('open');
      }
      existing.replaceWith(newCard);
    } else {
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      grid.appendChild(tmp.firstElementChild);
    }
  }

  // Refresh log, diag, and changes panels
  for (const name of names) {
    updateLogPanel(name);
    updateDiagPanel(name);
    refreshChanges(name);
  }

  // Auto-fetch diagnostics for error-status camps
  for (const [name, pg] of playgrounds) {
    if (pg.status === 'error' && !diagnostics.has(name)) {
      api('GET', `/api/playgrounds/${name}/diagnostics`).then(data => {
        diagnostics.set(name, data);
        updateDiagPanel(name);
      }).catch(() => {});
    }
  }
}

/**
 * Build the HTML string for a single playground card.
 * @param {{ name: string, branch: string, status: string, fePort?: number, bePort?: number }} pg
 * @returns {string}
 */
function renderCard(pg) {
  const { name, branch, status, fePort, bePort } = pg;
  const n = escHtml(name);
  const b = escHtml(branch);

  const badgeClass = `badge badge-${status}`;
  const statusLabel = escHtml(status);

  // (URLs are now inline in the card template)

  const isStopped  = status === 'stopped' || status === 'error';
  const isRunning  = status === 'running';
  const isStarting = status === 'starting';
  const canStop    = isRunning || isStarting;

  const diagPanelClass = diagnostics.has(name) && diagnostics.get(name).length > 0
    ? 'diag-panel'
    : 'diag-panel hidden';

  const pixelState = status === 'running' ? 'running'
    : status === 'starting' ? 'starting'
    : status === 'error' ? 'error'
    : 'stopped';

  const bubbles = {
    running: ['정상까지 얼마 안 남았다!', '한 걸음씩...', '경치 좋다~', '배고프다...', '오늘 안에 되겠지?', '커밋 냄새가 난다', '산이 높을수록 뷰가 좋지', '거의 다 왔어!'],
    starting: ['불 좀 피우는 중...', '따뜻해지면 출발!', '잠깐만 준비중~', '텐트 어디뒀지', '커피 한 잔만...', '워밍업 중!', '곧 간다곧 가~'],
    stopped: ['zzZ...', '좋은 꿈...', '내일 하자...', '5분만 더...', '푹 자는 중', '꿈에서 코딩중', '알람 끄기...'],
    error: ['살려줘ㅠ', '길을 잃었어...', '누가 좀!!', '여기 어디야', '구조대 불러줘', 'SOS!!!', '미끄러졌다ㅠ', '헬프미...']
  };
  const bubble = bubbles[pixelState][Math.floor(Math.random() * bubbles[pixelState].length)];
  const sceneClass = pixelState === 'stopped' ? 'card-scene-stars' : 'card-scene-mountains';
  const zzzHtml = pixelState === 'stopped' ? '<span class="camp-zzz">z z z</span>' : '';

  const statusKo = { running: '실행 중', starting: '준비 중', stopped: '대기 중', error: '문제 발생', 'setting-up': '설치 중' };
  const statusText = statusKo[status] || status;

  // Simplified card — just a "door" to enter the workspace
  const mainAction = status === 'error'
    ? `<button class="btn btn-primary btn-sm" onclick="event.stopPropagation();autoFix('${n}')">자동으로 고치기</button>`
    : isStopped
    ? `<button class="btn btn-primary btn-sm" onclick="event.stopPropagation();startPg('${n}')">시작</button>`
    : isRunning
    ? `<button class="btn btn-primary btn-sm" onclick="event.stopPropagation();enterWorkspace('${n}')">들어가기</button>`
    : '';

  return `
<div class="card" data-name="${n}" onclick="enterWorkspace('${n}')" style="cursor:pointer">
  <div class="card-scene ${sceneClass}"></div>
  <div class="card-header">
    <div class="card-header-left">
      <div class="camp-avatar">
        <div class="camp-bubble">${bubble}</div>
        <div class="camp-pixel-wrap">
          <div class="camp-pixel camp-pixel-${pixelState}"></div>
        </div>
        ${zzzHtml}
      </div>
      <div class="card-header-text">
        <span class="card-name">${n}</span>
        <span class="card-branch">${statusText}</span>
      </div>
    </div>
    <div class="card-header-right">
      ${mainAction}
    </div>
  </div>
</div>`.trim();
}

/**
 * Re-render the log panel for a playground (preserves open state).
 * @param {string} name
 */
function updateLogPanel(name) {
  const panel = document.getElementById(`log-${name}`);
  if (!panel) return;
  const pre = panel.querySelector('pre');
  if (!pre) return;

  const lines = logs.get(name) ?? [];
  pre.innerHTML = lines.map(({ text, source }) => {
    const cls = source === 'fe' ? 'log-line-fe'
              : source === 'be' ? 'log-line-be'
              : source === 'task' ? 'log-line-task'
              : 'log-line-err';
    return `<span class="${cls}">${escHtml(text)}</span>`;
  }).join('\n');

  // Auto-scroll if already open
  if (panel.classList.contains('open')) {
    panel.scrollTop = panel.scrollHeight;
  }
}

/**
 * Re-render the diagnostics panel for a playground.
 * @param {string} name
 */
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

// ---------------------------------------------------------------------------
// Log toggle
// ---------------------------------------------------------------------------

window.toggleLog = function toggleLog(name, toggleEl) {
  const panel = document.getElementById(`log-${name}`);
  if (!panel) return;
  const isOpen = panel.classList.toggle('open');
  toggleEl.classList.toggle('open', isOpen);
  if (isOpen) {
    updateLogPanel(name);
    panel.scrollTop = panel.scrollHeight;
  }
};

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

window.startPg = async function startPg(name) {
  try {
    await api('POST', `/api/playgrounds/${name}/start`);
  } catch (err) {
    toast(`Start failed: ${err.message}`, 'error');
  }
};

window.stopPg = async function stopPg(name) {
  try {
    await api('POST', `/api/playgrounds/${name}/stop`);
  } catch (err) {
    toast(`Stop failed: ${err.message}`, 'error');
  }
};

window.deletePg = async function deletePg(name) {
  if (!confirm(`캠프 "${name}"을(를) 삭제할까요? 되돌릴 수 없습니다.`)) return;
  try {
    await api('DELETE', `/api/playgrounds/${name}`);
    toast(`Deleted "${name}"`, 'success');
  } catch (err) {
    toast(`Delete failed: ${err.message}`, 'error');
  }
};

window.resetPg = async function resetPg(name) {
  if (!confirm('모든 변경 사항을 버리고 원래 상태로 돌아갑니다.\n\n되돌릴 수 없습니다. 계속할까요?')) return;
  try {
    await api('POST', `/api/playgrounds/${name}/reset`);
    toast('원래 상태로 되돌렸습니다', 'success');
    refreshChanges(name);
  } catch (err) {
    toast(`되돌리기 실패: ${err.message}`, 'error');
  }
};

// ---------------------------------------------------------------------------
// Snapshot modal
// ---------------------------------------------------------------------------

let snapModalName = null;

window.openSnapModal = async function openSnapModal(name) {
  snapModalName = name;
  document.getElementById('snap-modal-title').textContent = `Snapshots — ${name}`;
  document.getElementById('snap-label-input').value = '';
  document.getElementById('snap-modal').classList.add('open');
  await loadSnapshots(name);
};

window.closeSnapModal = function closeSnapModal() {
  document.getElementById('snap-modal').classList.remove('open');
  snapModalName = null;
};

async function loadSnapshots(name) {
  const list = document.getElementById('snap-list');
  list.innerHTML = '<div class="snap-empty">Loading…</div>';
  try {
    const snaps = await api('GET', `/api/playgrounds/${name}/snapshots`);
    if (!snaps.length) {
      list.innerHTML = '<div class="snap-empty">No snapshots yet.</div>';
      return;
    }
    list.innerHTML = snaps.map((snap) => {
      // Clean up the message: remove "On (no branch): playground-snapshot:" prefix
      const label = (snap.message || '')
        .replace(/^On \([^)]*\): /, '')
        .replace(/^playground-snapshot:/, '')
        .trim() || `스냅샷 #${snap.index}`;
      const date = snap.date ? `<span style="color:var(--text-muted);font-size:11px;margin-left:8px">${escHtml(snap.date)}</span>` : '';
      return `
      <div class="snap-item">
        <span class="snap-label">${escHtml(label)}${date}</span>
        <button class="btn btn-ghost btn-sm" onclick="restoreSnap(${snap.index})">Restore</button>
      </div>`;
    }).join('');
  } catch (err) {
    list.innerHTML = `<div class="snap-empty">Error: ${escHtml(err.message)}</div>`;
  }
}

window.saveSnap = async function saveSnap() {
  if (!snapModalName) return;
  const label = document.getElementById('snap-label-input').value.trim()
    || new Date().toISOString();
  try {
    await api('POST', `/api/playgrounds/${snapModalName}/snapshot`, { label });
    toast('Snapshot saved', 'success');
    await loadSnapshots(snapModalName);
  } catch (err) {
    toast(`Save failed: ${err.message}`, 'error');
  }
};

window.copyDebugInfo = async function copyDebugInfo(name) {
  const pg = playgrounds.get(name);
  if (!pg) return;

  const logLines = (logs.get(name) || []).slice(-30);
  const diagChecks = diagnostics.get(name) || [];

  let diagText = '';
  if (diagChecks.length > 0) {
    diagText = diagChecks.map(c => `  [${c.status}] ${c.name}: ${c.detail}`).join('\n');
  }

  // Fetch fresh diagnostics if none cached
  if (diagChecks.length === 0) {
    try {
      const fresh = await api('GET', `/api/playgrounds/${name}/diagnostics`);
      diagText = fresh.map(c => `  [${c.status}] ${c.name}: ${c.detail}`).join('\n');
    } catch { /* ignore */ }
  }

  const info = [
    `## 캠프 디버그 정보`,
    `- Name: ${pg.name}`,
    `- Branch: ${pg.branch}`,
    `- Status: ${pg.status}`,
    `- URL: ${pg.url || "(시작 전)"}`,
    ``,
    `### Diagnostics`,
    diagText || '  (none)',
    ``,
    `### Recent Logs (last 30 lines)`,
    '```',
    logLines.map(l => `[${l.source}] ${l.text}`).join(''),
    '```',
  ].join('\n');

  try {
    await navigator.clipboard.writeText(info);
    toast('Debug info copied — paste it to Claude', 'success');
  } catch {
    // Fallback for non-HTTPS
    const ta = document.createElement('textarea');
    ta.value = info;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast('Debug info copied — paste it to Claude', 'success');
  }
};

window.restoreSnap = async function restoreSnap(index) {
  if (!snapModalName) return;
  if (!confirm(`Restore snapshot #${index}? Current state will be overwritten.`)) return;
  try {
    await api('POST', `/api/playgrounds/${snapModalName}/restore`, { index });
    toast('Snapshot restored', 'success');
    closeSnapModal();
  } catch (err) {
    toast(`Restore failed: ${err.message}`, 'error');
  }
};

// Close snap modal on backdrop click
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('snap-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeSnapModal();
  });
});

// ---------------------------------------------------------------------------
// New 산장 modal
// ---------------------------------------------------------------------------

let allBranches = [];
let allBranchData = [];

const CATEGORY_LABELS = {
  default: '기본',
  feature: '기능 개발',
  fix: '버그 수정',
  other: '기타',
};

function renderBranchDropdown(filter = '') {
  const dropdown = document.getElementById('branch-dropdown');
  const q = filter.toLowerCase();

  const filtered = q
    ? allBranchData.filter(b => b.name.toLowerCase().includes(q))
    : allBranchData;

  if (filtered.length === 0) {
    dropdown.innerHTML = '<div class="branch-empty">검색 결과 없음</div>';
    dropdown.classList.add('open');
    return;
  }

  // Group: show "최근" (top 8) when no filter, otherwise just filtered results
  let html = '';
  if (!q) {
    // Recent top 8
    const recent = filtered.slice(0, 8);
    html += '<div class="branch-group-label">최근</div>';
    for (const b of recent) {
      html += branchItemHtml(b);
    }
    // Then by category (skip already shown)
    const recentNames = new Set(recent.map(r => r.name));
    const rest = filtered.filter(b => !recentNames.has(b.name));
    const groups = {};
    for (const b of rest) {
      const cat = b.category || 'other';
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(b);
    }
    for (const cat of ['default', 'feature', 'fix', 'other']) {
      if (!groups[cat] || groups[cat].length === 0) continue;
      html += `<div class="branch-group-label">${CATEGORY_LABELS[cat]}</div>`;
      for (const b of groups[cat]) {
        html += branchItemHtml(b);
      }
    }
  } else {
    for (const b of filtered) {
      html += branchItemHtml(b);
    }
  }

  dropdown.innerHTML = html;
  dropdown.classList.add('open');
}

function branchItemHtml(b) {
  const dateStr = b.date ? `<span class="branch-date">${escHtml(b.date)}</span>` : '';
  const localTag = b.local && !b.remote ? '<span class="branch-tag">local</span>' : '';
  return `<div class="branch-item" data-name="${escHtml(b.name)}">`
    + `<span class="branch-item-name">${escHtml(b.name)}</span>`
    + `<span class="branch-item-meta">${localTag}${dateStr}</span>`
    + `</div>`;
}

window.openNewModal = async function openNewModal() {
  document.getElementById('new-pg-name').value = '';
  document.getElementById('new-pg-name-error').textContent = '';
  const input = document.getElementById('new-pg-branch');
  const dropdown = document.getElementById('branch-dropdown');
  const countEl = document.getElementById('branch-count');
  input.value = '';
  dropdown.innerHTML = '';
  dropdown.classList.remove('open');
  countEl.textContent = '불러오는 중...';
  document.getElementById('new-pg-modal').classList.add('open');

  try {
    const branchList = await api('GET', '/api/branches');
    allBranchData = branchList;
    allBranches = branchList.map(b => b.name || b);
    countEl.textContent = `${allBranches.length}개 브랜치`;
    renderBranchDropdown();
  } catch (err) {
    countEl.textContent = '브랜치를 불러올 수 없습니다';
    toast(`브랜치 로드 실패: ${err.message}`, 'error');
  }

  // Wire up search filtering
  input.oninput = () => renderBranchDropdown(input.value);
  input.onfocus = () => renderBranchDropdown(input.value);

  // Wire up click selection on dropdown
  dropdown.onclick = (e) => {
    const item = e.target.closest('.branch-item');
    if (!item) return;
    input.value = item.dataset.name;
    dropdown.classList.remove('open');
  };

  // Close dropdown on outside click
  setTimeout(() => {
    const closer = (e) => {
      if (!document.getElementById('branch-picker').contains(e.target)) {
        dropdown.classList.remove('open');
      }
    };
    document.getElementById('new-pg-modal').addEventListener('click', closer);
  }, 0);
};

window.closeNewModal = function closeNewModal() {
  document.getElementById('new-pg-modal').classList.remove('open');
};

window.createPg = async function createPg() {
  const name = document.getElementById('new-pg-name').value.trim();
  const branch = document.getElementById('new-pg-branch').value;
  const errEl = document.getElementById('new-pg-name-error');

  errEl.textContent = '';

  if (!name) {
    errEl.textContent = 'Name is required.';
    return;
  }
  if (!/^[a-z0-9-]+$/.test(name)) {
    errEl.textContent = 'Only lowercase letters, numbers, and hyphens allowed.';
    return;
  }
  if (!branch) {
    errEl.textContent = 'Please enter a branch name.';
    return;
  }
  if (allBranches.length > 0 && !allBranches.includes(branch)) {
    errEl.textContent = `"${branch}" 브랜치를 찾을 수 없습니다. 목록에서 선택해주세요.`;
    return;
  }

  const btn = document.getElementById('create-pg-btn');
  btn.disabled = true;
  btn.textContent = '만드는 중...';
  toast('캠프를 만들고 있습니다... (의존성 설치 중)', 'info');
  try {
    await api('POST', '/api/playgrounds', { name, branch });
    closeNewModal();
  } catch (err) {
    toast(`Create failed: ${err.message}`, 'error');
    errEl.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '생성';
  }
};

// Close new modal on backdrop click
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('new-pg-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeNewModal();
  });
});

// Enter key in name field submits
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('new-pg-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createPg();
  });
});

// ---------------------------------------------------------------------------
// 변경 상태 — 카드에 "N개 파일 변경됨" 표시
// ---------------------------------------------------------------------------

async function refreshChanges(name) {
  const el = document.getElementById(`changes-${name}`);
  if (!el) return;
  try {
    const data = await api('GET', `/api/playgrounds/${name}/changes`);
    if (data.count === 0 && (!data.actions || data.actions.length === 0)) {
      el.innerHTML = '';
    } else {
      const actionCount = data.actions?.length || 0;
      const label = actionCount > 0
        ? `${actionCount}개 변경 작업`
        : `${data.count}개 파일 변경됨`;
      el.innerHTML = `<span class="changes-badge" title="수정된 파일 목록 보기 + 되돌리기" onclick="openChangesModal('${escHtml(name)}')">${label}</span>`;
    }
  } catch { el.innerHTML = ''; }
}

// Refresh changes for all running playgrounds periodically
setInterval(() => {
  for (const [name, pg] of playgrounds) {
    if (pg.status === 'running') refreshChanges(name);
  }
}, 10000);

// ---------------------------------------------------------------------------
// 변경 내역 모달 — 파일 목록 + 선택 되돌리기
// ---------------------------------------------------------------------------

let changesModalName = null;

window.openChangesModal = async function openChangesModal(name) {
  changesModalName = name;
  const modal = document.getElementById('changes-modal');
  document.getElementById('changes-modal-title').textContent = `변경 내역 — ${name}`;
  const list = document.getElementById('changes-file-list');
  list.innerHTML = '<div style="color:var(--text-muted);padding:8px">로딩 중...</div>';
  modal.classList.add('open');

  try {
    const data = await api('GET', `/api/playgrounds/${name}/changes`);
    if (data.count === 0 && (!data.actions || data.actions.length === 0)) {
      list.innerHTML = '<div style="color:var(--text-muted);padding:8px">변경 사항이 없습니다.</div>';
      return;
    }

    let html = '';

    // 행위 로그 + 행위별 되돌리기
    if (data.actions && data.actions.length > 0) {
      html += '<div class="changes-section-title">변경 작업</div>';
      html += data.actions.map((a, i) => `
        <div class="changes-action-item">
          <span class="changes-action-dot"></span>
          <div class="changes-action-body">
            <span class="changes-action-desc">${escHtml(a.description)}</span>
            <span class="changes-action-time">${new Date(a.timestamp).toLocaleTimeString('ko-KR', {hour:'2-digit',minute:'2-digit'})}</span>
          </div>
          ${a.files && a.files.length > 0
            ? `<button class="btn btn-ghost btn-sm" onclick="revertAction(${i})">되돌리기</button>`
            : ''}
        </div>
      `).join('');
    }

    // 파일 목록 (접이식, 개별 되돌리기용)
    if (data.count > 0) {
      html += `
        <details class="changes-files-detail">
          <summary class="changes-section-title" style="cursor:pointer">파일 상세 (${data.count}개)</summary>
          ${data.files.map(f => `
            <div class="changes-file-item">
              <span class="changes-status changes-status-${f.status === '수정' ? 'mod' : f.status === '새 파일' ? 'new' : 'del'}">${escHtml(f.status)}</span>
              <span class="changes-path">${escHtml(f.path.replace('new-frontend/', ''))}</span>
              <button class="btn btn-ghost btn-sm" onclick="revertFiles(['${escHtml(f.path)}'])">되돌리기</button>
            </div>
          `).join('')}
        </details>`;
    }

    list.innerHTML = html;
  } catch (err) {
    list.innerHTML = `<div style="color:var(--status-error-fg);padding:8px">${escHtml(err.message)}</div>`;
  }
};

window.closeChangesModal = function() {
  document.getElementById('changes-modal').classList.remove('open');
  changesModalName = null;
};

// 행위 단위 되돌리기
window.revertAction = async function revertAction(actionIndex) {
  if (!changesModalName) return;
  try {
    const data = await api('GET', `/api/playgrounds/${changesModalName}/changes`);
    const action = data.actions?.[actionIndex];
    if (!action || !action.files?.length) {
      toast('되돌릴 파일 정보가 없습니다.', 'error');
      return;
    }
    if (!confirm(`"${action.description}"을(를) 되돌릴까요?`)) return;

    await api('POST', `/api/playgrounds/${changesModalName}/revert-files`, { files: action.files });
    // Remove action from log
    await api('POST', `/api/playgrounds/${changesModalName}/remove-action`, { index: actionIndex });
    toast(`"${action.description}" 되돌림 완료`, 'success');
    openChangesModal(changesModalName);
    refreshChanges(changesModalName);
  } catch (err) {
    toast(`되돌리기 실패: ${err.message}`, 'error');
  }
};

// 파일 단위 되돌리기
window.revertFiles = async function revertFiles(files) {
  if (!changesModalName) return;
  if (!confirm(`선택한 파일을 원래대로 되돌릴까요?`)) return;
  try {
    await api('POST', `/api/playgrounds/${changesModalName}/revert-files`, { files });
    toast('되돌림 완료', 'success');
    openChangesModal(changesModalName);
    refreshChanges(changesModalName);
  } catch (err) {
    toast(`되돌리기 실패: ${err.message}`, 'error');
  }
};

// ---------------------------------------------------------------------------
// 보내기 모달 — 커밋 + PR
// ---------------------------------------------------------------------------

let shipModalName = null;

window.openShipModal = async function openShipModal(name) {
  shipModalName = name;
  document.getElementById('ship-modal').classList.add('open');
  document.getElementById('ship-message').value = '';
  document.getElementById('ship-message').focus();

  // Auto-generate description
  api('POST', `/api/playgrounds/${name}/smart-pr`).then(data => {
    if (data.description) {
      document.getElementById('ship-message').value = data.description;
    }
  }).catch(() => {}); // silent fail

  // Show changed file count
  try {
    const data = await api('GET', `/api/playgrounds/${name}/changes`);
    document.getElementById('ship-file-count').textContent =
      data.count > 0 ? `${data.count}개 파일이 변경되었습니다.` : '변경된 파일이 없습니다.';
  } catch {
    document.getElementById('ship-file-count').textContent = '';
  }
};

window.closeShipModal = function() {
  document.getElementById('ship-modal').classList.remove('open');
  shipModalName = null;
};

window.closeShipResultModal = function() {
  document.getElementById('ship-result-modal').classList.remove('open');
};

window.shipPg = async function shipPg() {
  if (!shipModalName) return;
  const message = document.getElementById('ship-message').value.trim();
  if (!message) { toast('변경 내용을 한 줄로 설명해주세요.', 'error'); return; }

  const btn = document.getElementById('ship-btn');
  btn.disabled = true;
  btn.textContent = '보내는 중...';

  try {
    await api('POST', `/api/playgrounds/${shipModalName}/ship`, { message });
    closeShipModal();

    // Show result modal immediately — PR creation happens in background via WebSocket
    const content = document.getElementById('ship-result-content');
    content.innerHTML = `
      <p style="margin-bottom:12px">코드가 올라갔습니다!</p>
      <p style="font-size:13px;color:var(--text-muted)">
        PR을 만드는 중입니다... 잠시 후 알림이 옵니다.
      </p>`;
    document.getElementById('ship-result-modal').classList.add('open');
  } catch (err) {
    toast(`보내기 실패: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '보내기';
  }
};

// ---------------------------------------------------------------------------
// 최신 반영 (sync) + 충돌 해결
// ---------------------------------------------------------------------------

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
    // claude strategy: result arrives via WebSocket conflict-resolved/conflict-failed
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

// ---------------------------------------------------------------------------
// Task — 일 시키기
// ---------------------------------------------------------------------------

window.sendTask = async function sendTask(name) {
  const input = document.getElementById(`task-input-${name}`);
  if (!input) return;
  const prompt = input.value.trim();
  if (!prompt) { toast('뭘 해줄지 입력해주세요!', 'error'); return; }

  try {
    await api('POST', `/api/playgrounds/${name}/task`, { prompt });
  } catch (err) {
    toast(`일 시키기 실패: ${err.message}`, 'error');
  }
};

window.cancelTask = async function cancelTask(name) {
  try {
    await api('POST', `/api/playgrounds/${name}/task/cancel`);
  } catch (err) {
    toast(`취소 실패: ${err.message}`, 'error');
  }
};

// ---------------------------------------------------------------------------
// Workspace View — SPA routing (list ↔ workspace)
// ---------------------------------------------------------------------------

function enterWorkspace(name) {
  currentWorkspace = name;
  document.getElementById('grid').classList.add('hidden');
  document.getElementById('portal').classList.add('hidden');
  document.querySelector('header').classList.add('hidden');
  const ws = document.getElementById('workspace');
  ws.classList.remove('hidden');

  // Call enter API
  api('POST', `/api/playgrounds/${name}/enter`).then(data => {
    renderWorkspace(data);
  }).catch(err => {
    toast(`캠프 진입 실패: ${err.message}`, 'error');
    exitWorkspace();
  });
}

function exitWorkspace() {
  currentWorkspace = null;
  if (wsPollingInterval) { clearInterval(wsPollingInterval); wsPollingInterval = null; }
  document.getElementById('workspace').classList.add('hidden');
  document.getElementById('grid').classList.remove('hidden');
  document.getElementById('portal').classList.remove('hidden');
  document.querySelector('header').classList.remove('hidden');
  renderAll();
  loadPortal();
}
window.exitWorkspace = exitWorkspace;

function renderWorkspace(data) {
  const { camp, changes, warpInstalled, previewUrl } = data;

  // Header
  document.getElementById('ws-title').textContent = `캠프: ${camp.name}`;
  const statusEl = document.getElementById('ws-status');
  statusEl.textContent = camp.status;
  statusEl.className = `workspace-status badge badge-${camp.status}`;

  // Changes — unsaved indicator + save button
  const changesEl = document.getElementById('ws-changes');
  const summaryTextEl = document.getElementById('ws-changes-summary-text');
  const unsavedSection = document.getElementById('ws-unsaved-section');
  const saveBtn = document.getElementById('ws-save-btn');
  if (changes.count === 0) {
    unsavedSection.classList.add('ws-no-changes');
    summaryTextEl.textContent = '✅ 모든 변경이 세이브됨';
    saveBtn.style.display = 'none';
    changesEl.innerHTML = '';
    renderBlocks([]);
  } else {
    unsavedSection.classList.remove('ws-no-changes');
    summaryTextEl.textContent = `⚠️ 저장 안 됨 — ${changes.count}개 파일 수정 중`;
    saveBtn.style.display = '';
    saveBtn.textContent = '💾 세이브하기';
    saveBtn.disabled = false;
    changesEl.innerHTML = changes.files.map(f =>
      `<div class="ws-file-item">
        <span class="changes-status changes-status-${f.status === '수정' ? 'mod' : f.status === '새 파일' ? 'new' : 'del'}">${escHtml(f.status)}</span>
        <span>${escHtml(f.path)}</span>
      </div>`
    ).join('');
    renderBlocks(changes.files);
    // Fetch AI summary
    api('GET', `/api/playgrounds/${camp.name}/changes-summary`).then(data => {
      if (data.summary) summaryTextEl.textContent = `⚠️ 저장 안 됨 — ${data.summary}`;
    }).catch(() => {});
  }

  // Actions — show commits as work history
  const actionsEl = document.getElementById('ws-actions');
  const commitList = data.commits || [];
  if (commitList.length > 0) {
    actionsEl.innerHTML = commitList.map(c =>
      `<div class="ws-commit-item">
        <span class="ws-commit-msg">${escHtml(c.message)}</span>
        <span class="ws-commit-date">${escHtml(c.date)}</span>
      </div>`
    ).join('');
  } else if (changes.count > 0) {
    actionsEl.innerHTML = '<span style="color:var(--text-muted);font-size:13px">아직 커밋 없음 (작업 중)</span>';
  } else {
    actionsEl.innerHTML = '<span style="color:var(--text-muted);font-size:13px">아직 없음</span>';
  }

  // Preview
  const previewEl = document.getElementById('ws-preview');
  if (previewUrl) {
    previewEl.innerHTML = `
      <iframe src="${escHtml(previewUrl)}" class="ws-preview-iframe"></iframe>
      <div class="ws-preview-fallback" style="display:none">
        <a href="${escHtml(previewUrl)}" target="_blank" class="btn btn-primary">
          새 탭에서 열기 → ${escHtml(previewUrl)}
        </a>
      </div>`;
    // iframe load event — detect X-Frame-Options block via cross-origin access
    const iframe = previewEl.querySelector('iframe');
    iframe.addEventListener('load', () => {
      try { iframe.contentDocument; } catch {
        iframe.style.display = 'none';
        previewEl.querySelector('.ws-preview-fallback').style.display = 'flex';
      }
    });
  } else {
    previewEl.innerHTML = `<span style="color:var(--text-muted);font-size:13px">
      서버가 실행 중이 아닙니다. 먼저 시작해주세요.
    </span>`;
  }

  // Terminal button label
  const termBtn = document.getElementById('ws-terminal-btn');
  termBtn.textContent = warpInstalled ? '💻 터미널' : '💻 경로 복사';

  // Log — show existing logs
  updateWorkspaceLog(camp.name);

  // Start polling changes
  startWorkspacePolling(camp.name);
}

function updateChangeSummary(count, ts) {
  let summary = document.getElementById('ws-changes-summary');
  if (!summary) {
    const changesSection = document.getElementById('ws-changes')?.parentElement;
    if (!changesSection) return;
    const h3 = changesSection.querySelector('h3');
    if (!h3) return;
    summary = document.createElement('span');
    summary.id = 'ws-changes-summary';
    summary.className = 'ws-changes-summary';
    h3.appendChild(summary);
  }
  if (count === 0) {
    summary.textContent = '';
  } else {
    const ago = ts ? timeAgo(ts) : '';
    summary.textContent = ` · ${count}개 파일${ago ? ' · ' + ago : ''}`;
  }
}

function timeAgo(ts) {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 5) return '방금';
  if (sec < 60) return `${sec}초 전`;
  return `${Math.floor(sec / 60)}분 전`;
}

function renderBlocks(files) {
  const container = document.getElementById('ws-blocks');
  if (!container) return;
  if (!files || files.length === 0) {
    container.innerHTML = '';
    container.classList.remove('ws-blocks-wobble');
    return;
  }
  container.innerHTML = files.map(f => {
    const type = f.status === '수정' ? 'mod' : f.status === '새 파일' ? 'new' : 'del';
    return `<div class="ws-block ws-block-${type}" title="${f.path}"></div>`;
  }).join('');
  container.classList.toggle('ws-blocks-wobble', files.length >= 5);
}

let summaryFetchTimer = null;
function debounceSummaryFetch(campName) {
  if (summaryFetchTimer) clearTimeout(summaryFetchTimer);
  summaryFetchTimer = setTimeout(() => {
    api('GET', `/api/playgrounds/${campName}/changes-summary`).then(data => {
      const el = document.getElementById('ws-changes-summary-text');
      if (data.summary && el) el.textContent = data.summary;
    }).catch(() => {});
  }, 3000);
}

let previewRefreshTimer = null;
function debouncePreviewRefresh() {
  if (previewRefreshTimer) clearTimeout(previewRefreshTimer);
  previewRefreshTimer = setTimeout(() => {
    const iframe = document.querySelector('#ws-preview iframe');
    if (iframe) {
      try { iframe.contentWindow.location.reload(); } catch {
        iframe.src = iframe.src;
      }
    }
  }, 1000);
}

function startWorkspacePolling(name) {
  if (wsPollingInterval) clearInterval(wsPollingInterval);
  wsPollingInterval = setInterval(async () => {
    if (currentWorkspace !== name) {
      clearInterval(wsPollingInterval);
      wsPollingInterval = null;
      return;
    }
    try {
      const data = await api('GET', `/api/playgrounds/${name}/changes`);
      const changesEl = document.getElementById('ws-changes');
      if (!changesEl) return;
      if (data.count === 0) {
        changesEl.innerHTML = '<span style="color:var(--text-muted);font-size:13px">변경 없음</span>';
      } else {
        changesEl.innerHTML = data.files.map(f =>
          `<div class="ws-file-item">
            <span class="changes-status changes-status-${f.status === '수정' ? 'mod' : f.status === '새 파일' ? 'new' : 'del'}">${escHtml(f.status)}</span>
            <span>${escHtml(f.path)}</span>
          </div>`
        ).join('');
      }
      // Update actions
      const actionsEl = document.getElementById('ws-actions');
      if (actionsEl && data.actions?.length) {
        actionsEl.innerHTML = data.actions.map(a =>
          `<div class="ws-action-item">• ${escHtml(a.description)}</div>`
        ).join('');
      }
    } catch { /* ignore */ }
  }, 10000);
}

function updateWorkspaceLog(name) {
  const panel = document.getElementById('ws-log');
  if (!panel) return;
  const pre = panel.querySelector('pre');
  if (!pre) return;
  const lines = logs.get(name) ?? [];
  pre.innerHTML = lines.map(({ text, source }) => {
    const cls = source === 'frontend' ? 'log-line-fe'
      : source === 'task' ? 'log-line-task'
      : 'log-line-err';
    return `<span class="${cls}">${escHtml(text)}</span>`;
  }).join('\n');
  panel.scrollTop = panel.scrollHeight;
}

// Workspace action handlers — reuse existing functions
window.wsSubmitTask = function() {
  if (!currentWorkspace) return;
  const input = document.getElementById('ws-task-input');
  const prompt = input.value.trim();
  if (!prompt) { toast('뭘 해줄지 입력해주세요!', 'error'); return; }
  api('POST', `/api/playgrounds/${currentWorkspace}/task`, { prompt })
    .then(() => { input.value = ''; })
    .catch(err => toast(`일 시키기 실패: ${err.message}`, 'error'));
};

window.wsShip = function() {
  if (!currentWorkspace) return;
  openShipModal(currentWorkspace);
};

window.wsSnap = function() {
  if (!currentWorkspace) return;
  openSnapModal(currentWorkspace);
};

window.wsSync = function() {
  if (!currentWorkspace) return;
  syncPg(currentWorkspace);
};

window.wsReset = function() {
  if (!currentWorkspace) return;
  resetPg(currentWorkspace);
};

window.wsOpenTerminal = async function() {
  if (!currentWorkspace) return;
  const termBtn = document.getElementById('ws-terminal-btn');
  try {
    const result = await api('POST', `/api/playgrounds/${currentWorkspace}/open-terminal`);
    if (result.opened) {
      termBtn.textContent = '💻 열림 ✓';
      setTimeout(() => { termBtn.textContent = '💻 터미널 열기'; }, 2000);
    } else {
      // Fallback: copy path
      const path = result.path;
      await navigator.clipboard.writeText(`cd ${path}`).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = `cd ${path}`;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      });
      toast('경로가 복사되었습니다. 터미널에 붙여넣기 하세요.', 'success');
    }
  } catch (err) {
    toast(`터미널 열기 실패: ${err.message}`, 'error');
  }
};

window.wsDelete = function() {
  if (!currentWorkspace) return;
  deletePg(currentWorkspace).then(() => exitWorkspace());
};

window.wsSave = async function() {
  if (!currentWorkspace) return;
  const btn = document.getElementById('ws-save-btn');
  btn.disabled = true;
  btn.textContent = '💾 세이브 중...';
  try {
    const result = await api('POST', `/api/playgrounds/${currentWorkspace}/save`);
    if (result.saved) {
      btn.textContent = '✅ 세이브 완료!';
      toast(`세이브됨: ${result.message}`, 'success');
      // Refresh workspace data
      const data = await api('POST', `/api/playgrounds/${currentWorkspace}/enter`);
      renderWorkspace(data);
    } else {
      btn.textContent = '💾 세이브하기';
      toast(result.reason || '변경사항이 없습니다.', 'info');
    }
  } catch (err) {
    btn.textContent = '💾 세이브하기';
    toast(`세이브 실패: ${err.message}`, 'error');
  }
  btn.disabled = false;
};

window.togglePanel = function() {
  document.getElementById('ws-panel')?.classList.toggle('open');
};

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Portal
// ---------------------------------------------------------------------------


async function loadSuggestions() {
  const section = document.getElementById('portal-suggestions-section');
  const list = document.getElementById('portal-suggestions');
  if (!section || !list) return;

  try {
    const suggestions = await api('GET', '/api/suggestions');
    if (!suggestions || suggestions.length === 0) {
      section.style.display = 'none';
      return;
    }

    // Exclude "recent" commits (noise) and deduplicate with "이어하기"
    const workTitles = new Set([...playgrounds.values()].map(p => p.branch));
    const filtered = suggestions
      .filter(item => item.type !== 'recent')
      .filter(item => !workTitles.has(item.action))
      .slice(0, 5);

    if (filtered.length === 0) {
      section.style.display = 'none';
      return;
    }

    const iconMap = { issue: '🔵', pr: '🟡' };
    list.innerHTML = filtered.map(item => {
      const icon = iconMap[item.type] || '⚪';
      return `
      <div class="portal-work-item">
        <div class="portal-work-left">
          <span class="portal-work-icon">${icon}</span>
          <div>
            <div class="portal-work-title">${escHtml(item.title)}</div>
          </div>
        </div>
      </div>`;
    }).join('');
    section.style.display = '';
  } catch {
    section.style.display = 'none';
  }
}
async function loadPortal() {
  const workList = document.getElementById('portal-work');
  if (!workList) return;

  try {
    const work = await api('GET', '/api/my-work');

    const workSection = document.getElementById('portal-work-section');
    if (work.length === 0) {
      if (workSection) workSection.style.display = 'none';
      return;
    }
    if (workSection) workSection.style.display = '';

    workList.innerHTML = work.slice(0, 3).map(item => {
      if (item.type === 'pr') {
        const statusLabel = item.isDraft ? '초안'
          : item.reviewStatus === 'APPROVED' ? '승인됨'
          : item.reviewStatus === 'CHANGES_REQUESTED' ? '수정 요청'
          : '팀이 보는 중';
        const statusClass = item.isDraft ? 'draft'
          : item.reviewStatus === 'APPROVED' ? 'approved'
          : item.reviewStatus === 'CHANGES_REQUESTED' ? 'changes'
          : 'pending';
        const timeAgo = new Date(item.updatedAt).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });

        return `
        <div class="portal-work-item" onclick="${item.camp ? `enterWorkspace('${escHtml(item.camp)}')` : `window.open('${escHtml(item.prUrl)}','_blank')`}">
          <div class="portal-work-left">
            <span class="portal-work-icon">🟡</span>
            <div>
              <div class="portal-work-title">${escHtml(item.title)}</div>
              <div class="portal-work-meta">PR #${item.prNumber} · ${timeAgo}</div>
            </div>
          </div>
          <span class="portal-work-status portal-status-${statusClass}">${statusLabel}</span>
        </div>`;
      } else {
        return `
        <div class="portal-work-item" onclick="enterWorkspace('${escHtml(item.camp)}')">
          <div class="portal-work-left">
            <span class="portal-work-icon">🟢</span>
            <div>
              <div class="portal-work-title">${escHtml(item.title)}</div>
              <div class="portal-work-meta">${escHtml(item.branch)}</div>
            </div>
          </div>
          <span class="portal-work-status portal-status-active">작업 이어하기</span>
        </div>`;
      }
    }).join('');
  } catch (err) {
    workList.innerHTML = '<div class="portal-empty">작업 목록을 불러올 수 없습니다</div>';
  }
}

window.quickStart = async function quickStart() {
  const input = document.getElementById('quickstart-input');
  const description = input.value.trim();
  if (!description) { toast('뭘 하고 싶은지 입력해주세요!', 'error'); return; }

  // 즉시 로딩 상태 표시
  const btn = input.nextElementSibling;
  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '만드는 중...';
  input.disabled = true;
  toast('캠프를 만들고 있습니다... (의존성 설치 중)', 'info');

  try {
    const result = await api('POST', '/api/quick-start', { description });
    input.value = '';
    toast(`캠프 "${result.name}" 생성 완료!`, 'success');
    await loadPortal();
    renderAll();
  } catch (err) {
    toast(`생성 실패: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
    input.disabled = false;
  }
};


window.autoFix = async function autoFix(name) {
  toast('문제를 분석하고 있습니다...', 'info');
  try {
    const result = await api('POST', `/api/playgrounds/${name}/auto-fix`);
    if (result.fixed) {
      toast(`자동 수정 완료: ${result.description}`, 'success');
    } else {
      toast(result.description, 'error');
    }
  } catch (err) {
    toast(`자동 수정 실패: ${err.message}`, 'error');
  }
};

async function init() {
  try {
    const pgs = await api('GET', '/api/playgrounds');
    for (const pg of pgs) {
      playgrounds.set(pg.name, pg);
    }
  } catch (err) {
    toast(`캠프 목록 로드 실패: ${err.message}`, 'error');
  }
  renderAll();
  loadPortal();
  loadSuggestions();
  connectWs();
}

document.addEventListener('DOMContentLoaded', init);
