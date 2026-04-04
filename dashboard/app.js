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

// ---------------------------------------------------------------------------
// Route inference — map file paths to preview routes
// ---------------------------------------------------------------------------

/**
 * Infer a preview route from a file path.
 * Only works for file-based routing patterns (pages/, app/, views/).
 * Returns null if no route can be inferred.
 */
function inferRouteFromPath(filePath) {
  const lower = filePath.toLowerCase();

  // Match pages/xxx.tsx, app/xxx/page.tsx, views/xxx.vue etc.
  const patterns = [
    // Next.js app router: app/dashboard/page.tsx → /dashboard
    { regex: /(?:^|[/\\])app[/\\](.+?)[/\\]page\.[^.]+$/, transform: m => '/' + m },
    // Next.js app router: app/page.tsx → /
    { regex: /(?:^|[/\\])app[/\\]page\.[^.]+$/, transform: () => '/' },
    // Next.js/Nuxt pages router: pages/login.tsx → /login
    { regex: /(?:^|[/\\])pages[/\\](.+?)(?:\.[^.]+)$/, transform: m => '/' + m },
    // views/: views/Login.vue → /login
    { regex: /(?:^|[/\\])views[/\\](.+?)(?:\.[^.]+)$/, transform: m => '/' + m },
  ];

  for (const { regex, transform } of patterns) {
    const match = regex.exec(lower);
    if (match) {
      let route = transform(match[1] || '');
      // Clean up: remove index, trailing slash dupes
      route = route.replace(/\/index$/, '/').replace(/\/+/g, '/');
      // Remove dynamic route brackets for navigation: [id] → placeholder
      route = route.replace(/\[([^\]]+)\]/g, '1');
      return route || '/';
    }
  }
  return null;
}

/**
 * Navigate the preview iframe to a given route.
 */
function navigatePreview(route) {
  const iframe = document.querySelector('#ws-preview iframe');
  if (!iframe) return;
  try {
    const base = new URL(iframe.src);
    base.pathname = route;
    iframe.contentWindow.location.href = base.toString();
  } catch {
    // cross-origin — reload with new path
    const src = iframe.src.replace(/\/preview\/(\d+)\/.*/, `/preview/$1${route}`);
    iframe.src = src;
  }
  updateUrlBar(route);
}

function updateUrlBar(route) {
  const input = document.getElementById('ws-url-input');
  if (input) input.value = route || '/';
}

window.previewBack = function previewBack() {
  const iframe = document.querySelector('#ws-preview iframe');
  if (!iframe) return;
  try { iframe.contentWindow.history.back(); } catch { /* cross-origin */ }
};

window.previewRefresh = function previewRefresh() {
  const iframe = document.querySelector('#ws-preview iframe');
  if (!iframe) return;
  try { iframe.contentWindow.location.reload(); } catch { iframe.src = iframe.src; }
};

// Viewport presets
const VIEWPORTS = {
  desktop: { width: '100%', height: '100%', label: '데스크탑' },
  tablet: { width: '768px', height: '100%', label: '태블릿' },
  mobile: { width: '375px', height: '100%', label: '모바일' },
};
let currentViewport = 'desktop';

window.setViewport = function setViewport(size) {
  currentViewport = size;
  const vp = VIEWPORTS[size];
  const iframe = document.querySelector('#ws-preview iframe');
  if (!iframe) return;
  iframe.style.maxWidth = vp.width;
  iframe.style.margin = size === 'desktop' ? '0' : '0 auto';
  iframe.style.transition = 'max-width 0.2s ease';
  // Update active button
  document.querySelectorAll('.ws-vp-btn').forEach(btn => btn.classList.remove('ws-vp-active'));
  document.querySelector(`.ws-vp-btn[onclick*="${size}"]`)?.classList.add('ws-vp-active');
};

/** @type {Map<string, Array>} diagnostics keyed by playground name */
const diagnostics = new Map();


/** @type {string|null} name of camp in workspace view, or null for list view */
let currentWorkspace = null;

/** @type {number|null} polling interval for workspace changes */
let wsPollingInterval = null;

/** @type {object|null} 마지막 리포트 캐시 — 세이브 후 축소 표시용 */
let lastReport = null;

let compareMode = false;

const SHERPA_QUOTES = [
  "요구사항 또 바뀌었댜... 뭐 그러려니 하쥬",
  "'간단한 건데~' 그 말이 제일 무섭댜",
  "CEO가 데모 전날 피드백 줬어유. 다 뜯으래유.",
  "이거 금방 되쥬? 네... 산도 금방 오르쥬.",
  "스펙 확정이랬는디... 또 바뀌었댜",
  "우선순위 1이 열두 개여유. 산봉우리가 열두 개.",
  "디자인 안 나왔는디 개발 먼저 하래유",
  "어제 합의한 거 오늘 모른댜. 나도 모르겠댜.",
  "v1인디 왜 v3 기능을 넣으래유",
  "PRD 다섯 번째 바뀌는 중이여유. 난 여그 서있쥬.",
  "아 그거 빼자고 한 거... 다시 넣는댜. 그러쥬 뭐.",
  "고객이 원한댜. 근디 고객이 누구여.",
  "MVP라며유. M이 자꾸 빠져유.",
  "이번엔 진짜 마지막 수정이래유. 네 번째 마지막.",
  "배포하면 쉬는 거 아니었어유?",
  "'빨리 한번 해봐유' 3주째 하는 중이쥬.",
  "피벗이래유. 하산 아니래유. 글쎄유.",
  "개발 부채가 배낭보다 무겁댜. 그래도 가야쥬.",
  "야근이여유? 셰르파는 원래 이러쥬 뭐.",
  "롤백한 거 아무도 모르쥬? 나도 모른댜.",
];

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
      if (currentWorkspace === name) transitionReportToSaved();
      break;
    }

    case 'autosaved': {
      if (!name) break;
      toast('💾 오토세이브 완료', 'success');
      if (currentWorkspace === name) {
        transitionReportToSaved();
        api('POST', `/api/playgrounds/${name}/enter`).then(renderWorkspace).catch(() => {});
      }
      break;
    }

    case 'browser-error': {
      if (!name || !data) break;
      if (currentWorkspace !== name) break;
      addBrowserError(data);
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
        // Debounced AI report fetch
        debounceReportFetch(name);
      }

      updateChangeSummary(data.count, data.ts);
      updateMiniChar('running', data.count);
      debouncePreviewRefresh();
      break;
    }

    case 'compare-ready': {
      if (!compareMode) break;
      const mainPreview = document.getElementById('ws-preview-main');
      if (mainPreview && data?.port) {
        const proxyUrl = `/preview/${data.port}/`;
        mainPreview.innerHTML = `
          <div class="ws-preview-label">🏔️ 원본 (main)</div>
          <iframe src="${escHtml(proxyUrl)}" class="ws-preview-iframe"></iframe>`;
        toast('원본 프리뷰 준비 완료!', 'success');
      }
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

function setShipStep(step, state) {
  const el = document.getElementById(`ship-step-${step}`);
  if (!el) return;
  el.classList.remove('ship-step-active', 'ship-step-done', 'ship-step-fail');
  if (state) el.classList.add(`ship-step-${state}`);
}

window.shipPg = async function shipPg() {
  if (!shipModalName) return;
  const message = document.getElementById('ship-message').value.trim();
  if (!message) { toast('변경 내용을 한 줄로 설명해주세요.', 'error'); return; }

  const btn = document.getElementById('ship-btn');
  btn.disabled = true;
  btn.textContent = '진행 중...';

  // Show steps
  const stepsEl = document.getElementById('ship-steps');
  stepsEl.classList.remove('hidden');
  setShipStep('test', 'active');
  setShipStep('push', null);
  setShipStep('pr', null);

  try {
    // Step 1: Pre-ship test
    const testResult = await api('POST', `/api/playgrounds/${shipModalName}/pre-ship`);
    if (!testResult.passed && !testResult.skipped) {
      setShipStep('test', 'fail');
      btn.textContent = '보내기';
      btn.disabled = false;
      toast('테스트 실패 — 터미널에서 확인해주세요', 'error');
      return;
    }
    setShipStep('test', 'done');

    // Step 2: Ship (squash + push)
    setShipStep('push', 'active');
    await api('POST', `/api/playgrounds/${shipModalName}/ship`, { message });
    setShipStep('push', 'done');

    // Step 3: PR (happens in background via WebSocket)
    setShipStep('pr', 'active');
    closeShipModal();

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
// Workspace View — SPA routing (list ↔ workspace)
// ---------------------------------------------------------------------------

function enterWorkspace(name) {
  currentWorkspace = name;
  clearBrowserErrors();
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
  compareMode = false;
  const compareBtn = document.getElementById('ws-compare-btn');
  if (compareBtn) compareBtn.classList.remove('btn-active');
  const mainPreview = document.getElementById('ws-preview-main');
  if (mainPreview) mainPreview.classList.add('hidden');
  const container = document.getElementById('ws-preview-container');
  if (container) container.classList.remove('ws-split-view');
  const exitToolbar = document.getElementById('ws-preview-toolbar');
  if (exitToolbar) exitToolbar.style.display = 'none';
  lastReport = null;
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

async function fetchAndRenderReport(campName, withAi = false) {
  const section = document.getElementById('ws-report-section');
  if (!section) return;

  try {
    const report = await api('GET', `/api/playgrounds/${campName}/change-report${withAi ? '?ai=true' : ''}`);

    if (report.totalCount === 0) {
      if (lastReport && lastReport.summary) {
        section.style.display = '';
        section.classList.add('ws-report-saved');
        document.getElementById('ws-report-summary').innerHTML =
          `<div class="ws-report-desc ws-report-saved-desc">✅ 마지막 세이브: ${escHtml(lastReport.summary)}</div>`;
        document.getElementById('ws-report-warnings').innerHTML = '';
        document.getElementById('ws-report-categories').innerHTML = '';
      } else {
        section.style.display = 'none';
      }
      return;
    }

    lastReport = report;
    section.style.display = '';
    section.classList.remove('ws-report-saved');

    const summaryEl = document.getElementById('ws-report-summary');
    const changeSummaryText = document.getElementById('ws-changes-summary-text');
    if (report.humanDescription) {
      summaryEl.innerHTML = `<div class="ws-report-desc">${escHtml(report.humanDescription)}</div>`;
    } else if (report.summary) {
      summaryEl.innerHTML = `<div class="ws-report-desc">${escHtml(report.summary)}</div>`;
    } else {
      summaryEl.innerHTML = `<div class="ws-report-desc">${report.totalCount}개 파일 변경됨</div>`;
    }

    if (changeSummaryText && report.summary) {
      changeSummaryText.textContent = `⚠️ 저장 안 됨 — ${report.summary}`;
    }

    const warningsEl = document.getElementById('ws-report-warnings');
    if (report.warnings.length > 0) {
      warningsEl.innerHTML = report.warnings.map(w =>
        `<div class="ws-report-warning">
          <span class="ws-report-warning-icon">⚠️</span>
          <span>${escHtml(w.message)}</span>
        </div>`
      ).join('');
    } else {
      warningsEl.innerHTML = '';
    }

    const categoryNames = { ui: '🎨 화면', api: '⚙️ 서버', config: '🔧 설정', test: '🧪 테스트', docs: '📝 문서', other: '📦 기타' };
    const categoriesEl = document.getElementById('ws-report-categories');
    const details = report.categoryDetails || {};
    categoriesEl.innerHTML = Object.entries(report.byCategory).map(([cat, files]) => {
      const items = details[cat];
      const hasDetails = items && items.length > 0;
      return `<div class="ws-report-cat-group">
        <div class="ws-report-cat-header">
          <span class="ws-report-cat-label">${categoryNames[cat] || cat}</span>
          <span class="ws-report-cat-count">${files.length}</span>
        </div>
        ${hasDetails
          ? `<ul class="ws-report-cat-items">${items.map((item, idx) => {
              const file = files[idx];
              const route = cat === 'ui' && file ? inferRouteFromPath(file.path) : null;
              return route
                ? `<li class="ws-report-nav-item" onclick="navigatePreview('${escHtml(route)}')" title="${escHtml(file.path)} → ${escHtml(route)}">${escHtml(item)} <span class="ws-report-nav-hint">→ 보기</span></li>`
                : `<li>${escHtml(item)}</li>`;
            }).join('')}</ul>`
          : `<ul class="ws-report-cat-items">${files.map(f => {
              const route = cat === 'ui' ? inferRouteFromPath(f.path) : null;
              const label = `${escHtml(f.path.split('/').pop() || f.path)} ${f.status === '새 파일' ? '추가됨' : '수정됨'}`;
              return route
                ? `<li class="ws-report-nav-item" onclick="navigatePreview('${escHtml(route)}')" title="${escHtml(f.path)} → ${escHtml(route)}">${label} <span class="ws-report-nav-hint">→ 보기</span></li>`
                : `<li>${label}</li>`;
            }).join('')}</ul>`
        }
      </div>`;
    }).join('');

  } catch {
    section.style.display = 'none';
  }
}

function transitionReportToSaved() {
  const section = document.getElementById('ws-report-section');
  if (!section || !lastReport) return;

  if (lastReport.summary) {
    section.style.display = '';
    section.classList.add('ws-report-saved');
    document.getElementById('ws-report-summary').innerHTML =
      `<div class="ws-report-desc ws-report-saved-desc">✅ 마지막 세이브: ${escHtml(lastReport.summary)}</div>`;
    document.getElementById('ws-report-warnings').innerHTML = '';
    document.getElementById('ws-report-categories').innerHTML = '';
  } else {
    section.style.display = 'none';
  }
}

function renderWorkspace(data) {
  const { camp, changes, warpInstalled, previewUrl, autosave } = data;

  // Header
  document.getElementById('ws-title').textContent = `캠프: ${camp.name}`;
  const statusEl = document.getElementById('ws-status');
  statusEl.textContent = camp.status;
  statusEl.className = `workspace-status badge badge-${camp.status}`;

  // Mini character in topbar — sherpa load level
  updateMiniChar(camp.status, changes.count);

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
    fetchAndRenderReport(camp.name);
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
    // 먼저 fallback으로 빠르게 렌더, 이어서 AI로 업그레이드
    fetchAndRenderReport(camp.name);
    fetchAndRenderReport(camp.name, true);
  }

  // Actions — show commits as work history
  const actionsEl = document.getElementById('ws-actions');
  const commitList = data.commits || [];
  if (commitList.length > 0) {
    actionsEl.innerHTML = commitList.map(c =>
      `<details class="ws-commit-item" data-hash="${escHtml(c.hash)}">
        <summary class="ws-commit-summary">
          <span class="ws-commit-arrow">▶</span>
          <span class="ws-commit-msg">${escHtml(c.message)}</span>
          <span class="ws-commit-date">${escHtml(c.date)}</span>
          <button class="btn btn-ghost btn-sm ws-revert-btn" onclick="event.stopPropagation();event.preventDefault();revertCommit('${escHtml(c.hash)}')" title="이 세이브 되돌리기">↩</button>
        </summary>
        <div class="ws-commit-report"></div>
      </details>`
    ).join('');
    // 펼칠 때 자동으로 리포트 로드
    actionsEl.querySelectorAll('.ws-commit-item').forEach(el => {
      el.addEventListener('toggle', function() {
        if (this.open) loadCommitReport(this, this.dataset.hash);
      });
    });
  } else if (changes.count > 0) {
    actionsEl.innerHTML = '<span style="color:var(--text-muted);font-size:13px">아직 커밋 없음 (작업 중)</span>';
  } else {
    actionsEl.innerHTML = '<span style="color:var(--text-muted);font-size:13px">아직 없음</span>';
  }

  // Preview — use proxy URL (same origin, no X-Frame-Options issues)
  const previewEl = document.getElementById('ws-preview');
  const previewToolbar = document.getElementById('ws-preview-toolbar');
  if (previewUrl) {
    const port = new URL(previewUrl).port || '80';
    const proxyUrl = `/preview/${port}/`;
    previewEl.innerHTML = `
      <iframe src="${escHtml(proxyUrl)}" class="ws-preview-iframe"></iframe>
      <div class="ws-preview-fallback" style="display:none">
        <a href="${escHtml(previewUrl)}" target="_blank" class="btn btn-primary">
          새 탭에서 열기 → ${escHtml(previewUrl)}
        </a>
      </div>`;
    const iframe = previewEl.querySelector('iframe');
    iframe.addEventListener('error', () => {
      iframe.style.display = 'none';
      previewEl.querySelector('.ws-preview-fallback').style.display = 'flex';
    });
    if (previewToolbar) previewToolbar.style.display = '';
    updateUrlBar('/');
    if (currentViewport !== 'desktop') setViewport(currentViewport);
  } else {
    if (previewToolbar) previewToolbar.style.display = 'none';
    previewEl.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:16px;user-select:none;">
        <div style="width:4px;height:4px;image-rendering:pixelated;color:transparent;box-shadow:
          /* tent peak */
          12px 0 0 #6b7394,
          8px 4px 0 #6b7394, 12px 4px 0 #6b7394, 16px 4px 0 #6b7394,
          4px 8px 0 #6b7394, 8px 8px 0 #6b7394, 12px 8px 0 #6b7394, 16px 8px 0 #6b7394, 20px 8px 0 #6b7394,
          0px 12px 0 #4a5170, 4px 12px 0 #4a5170, 8px 12px 0 #4a5170, 12px 12px 0 #4a5170, 16px 12px 0 #4a5170, 20px 12px 0 #4a5170, 24px 12px 0 #4a5170,
          /* zzz */
          36px 0 0 #4a5170, 40px 4px 0 #4a5170, 36px 8px 0 #4a5170;
          transform:scale(2);margin-bottom:8px;
        "></div>
        <div style="color:var(--text-muted);font-size:14px;text-align:center;margin-top:24px;">
          캠프가 자고 있어유... zzZ
        </div>
      </div>`;
  }

  // Terminal button label
  const termBtn = document.getElementById('ws-terminal-btn');
  termBtn.textContent = warpInstalled ? '💻 터미널' : '💻 경로 복사';

  // Autosave toggle
  const autosaveCheck = document.getElementById('ws-autosave-check');
  if (autosaveCheck) autosaveCheck.checked = !!autosave;

  // Log — show existing logs
  updateWorkspaceLog(camp.name);

  // Quest progress bar
  const hasChanges = changes.count > 0;
  const hasSaves = (data.commits || []).length > 0;
  updateQuestProgress(hasChanges, hasSaves);

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
    return `<div class="ws-block ws-block-${type}" title="${escHtml(f.path)}"></div>`;
  }).join('');
  container.classList.toggle('ws-blocks-wobble', files.length >= 5);
}

function playSaveEffect() {
  // 1. Flush blocks
  const blocks = document.getElementById('ws-blocks');
  if (blocks) {
    blocks.classList.add('ws-blocks-flush');
    setTimeout(() => {
      blocks.innerHTML = '';
      blocks.classList.remove('ws-blocks-flush', 'ws-blocks-wobble');
    }, 400);
  }

  // 2. Screen flash (retro single-color)
  const flash = document.createElement('div');
  flash.className = 'ws-save-flash';
  document.body.appendChild(flash);
  setTimeout(() => flash.remove(), 400);

  // 3. Pixel sparkles around save button
  const btn = document.getElementById('ws-save-btn');
  if (btn) {
    btn.style.position = 'relative';
    const sparkles = document.createElement('div');
    sparkles.className = 'ws-sparkles';
    for (let i = 0; i < 10; i++) {
      const s = document.createElement('div');
      s.className = 'ws-sparkle';
      const angle = (i / 10) * Math.PI * 2;
      const dist = 24 + Math.random() * 16;
      s.style.setProperty('--sx', `${Math.cos(angle) * dist}px`);
      s.style.setProperty('--sy', `${Math.sin(angle) * dist}px`);
      s.style.left = '50%';
      s.style.top = '50%';
      sparkles.appendChild(s);
    }
    btn.appendChild(sparkles);
    setTimeout(() => sparkles.remove(), 600);
  }

  // 4. Sherpa celebrates — jump + wave
  const miniChar = document.getElementById('ws-mini-char');
  if (miniChar) {
    miniChar.className = 'ws-mini-char ws-mini-char-saved';
    setTimeout(() => updateMiniChar('running', 0), 1000);
  }

  // 5. Slide-in new save entry in history
  setTimeout(() => {
    const actionsEl = document.getElementById('ws-actions');
    if (actionsEl) {
      const firstItem = actionsEl.querySelector('.ws-commit-item');
      if (firstItem) {
        firstItem.classList.add('ws-commit-slide-in');
        setTimeout(() => firstItem.classList.remove('ws-commit-slide-in'), 500);
      }
    }
  }, 500); // Wait for workspace data refresh
}

function updateMiniChar(status, changeCount) {
  const miniChar = document.getElementById('ws-mini-char');
  if (!miniChar) return;
  miniChar.className = 'ws-mini-char';

  if (status === 'error') {
    miniChar.classList.add('ws-mini-char-error');
  } else if (status === 'starting' || status === 'starting-frontend') {
    miniChar.classList.add('ws-mini-char-starting');
  } else if (status === 'stopped') {
    miniChar.classList.add('ws-mini-char-stopped');
  } else if (changeCount >= 15) {
    miniChar.classList.add('ws-mini-char-load-heavy');
  } else if (changeCount >= 7) {
    miniChar.classList.add('ws-mini-char-load-medium');
  } else if (changeCount >= 3) {
    miniChar.classList.add('ws-mini-char-load-light');
  } else {
    miniChar.classList.add('ws-mini-char-running');
  }
}

function updateQuestProgress(hasChanges, hasSaves) {
  const stepWork = document.getElementById('ws-step-work');
  const stepSave = document.getElementById('ws-step-save');
  const stepShip = document.getElementById('ws-step-ship');
  if (!stepWork) return;

  [stepWork, stepSave, stepShip].forEach(s => {
    s.classList.remove('ws-quest-active', 'ws-quest-done');
  });

  if (!hasChanges && !hasSaves) {
    stepWork.classList.add('ws-quest-active');
  } else if (hasChanges && !hasSaves) {
    stepWork.classList.add('ws-quest-done');
    stepSave.classList.add('ws-quest-active');
  } else if (!hasChanges && hasSaves) {
    stepWork.classList.add('ws-quest-done');
    stepSave.classList.add('ws-quest-done');
    stepShip.classList.add('ws-quest-active');
  } else {
    stepWork.classList.add('ws-quest-done');
    stepSave.classList.add('ws-quest-active');
  }
}

async function loadCommitReport(el, hash) {
  const reportEl = el.querySelector('.ws-commit-report');
  if (!reportEl || reportEl.dataset.loaded) return;

  reportEl.innerHTML = '<div class="ws-commit-report-loading">불러오는 중...</div>';

  try {
    const report = await api('GET', `/api/playgrounds/${currentWorkspace}/commit-report/${hash}?ai=true`);
    const categoryNames = { ui: '🎨 화면', api: '⚙️ 서버', config: '🔧 설정', test: '🧪 테스트', docs: '📝 문서', other: '📦 기타' };
    const details = report.categoryDetails || {};

    if (report.totalCount === 0) {
      reportEl.innerHTML = '<div class="ws-commit-report-empty">변경 내용 없음</div>';
      return;
    }

    reportEl.innerHTML = Object.entries(report.byCategory).map(([cat, files]) => {
      const items = details[cat];
      const hasDetails = items && items.length > 0;
      return `<div class="ws-commit-cat">
        <span class="ws-commit-cat-label">${categoryNames[cat] || cat}</span>
        ${hasDetails
          ? items.map((item, idx) => {
              const file = files[idx];
              const route = cat === 'ui' && file ? inferRouteFromPath(file.path) : null;
              return route
                ? `<div class="ws-commit-cat-item ws-report-nav-item" onclick="navigatePreview('${escHtml(route)}')" title="${escHtml(file.path)} → ${escHtml(route)}">${escHtml(item)} <span class="ws-report-nav-hint">→ 보기</span></div>`
                : `<div class="ws-commit-cat-item">${escHtml(item)}</div>`;
            }).join('')
          : files.map(f => {
              const route = cat === 'ui' ? inferRouteFromPath(f.path) : null;
              const label = `${escHtml(f.path.split('/').pop() || f.path)} ${f.status === '새 파일' ? '추가됨' : '수정됨'}`;
              return route
                ? `<div class="ws-commit-cat-item ws-report-nav-item" onclick="navigatePreview('${escHtml(route)}')" title="${escHtml(f.path)} → ${escHtml(route)}">${label} <span class="ws-report-nav-hint">→ 보기</span></div>`
                : `<div class="ws-commit-cat-item">${label}</div>`;
            }).join('')
        }
      </div>`;
    }).join('');
    reportEl.dataset.loaded = 'true';
  } catch {
    reportEl.innerHTML = '<div class="ws-commit-report-empty">불러오기 실패</div>';
  }
}

let reportFetchTimer = null;
function debounceReportFetch(campName) {
  if (reportFetchTimer) clearTimeout(reportFetchTimer);
  reportFetchTimer = setTimeout(() => {
    fetchAndRenderReport(campName, true);
  }, 5000);
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

// ---------------------------------------------------------------------------
// Browser Error Panel
// ---------------------------------------------------------------------------

/** @type {Array<{level: string, message: string, source?: string, line?: number, ts: number}>} */
const browserErrors = [];

function addBrowserError(data) {
  browserErrors.push({ ...data, ts: Date.now() });
  if (browserErrors.length > 50) browserErrors.shift();
  renderBrowserErrors();
}

function renderBrowserErrors() {
  const panel = document.getElementById('ws-browser-errors');
  if (!panel) return;
  const badge = document.getElementById('ws-browser-error-badge');
  const fixBtn = document.getElementById('ws-fix-btn');
  // Show fix button if there are browser errors OR server error logs
  const serverHasErrors = currentWorkspace && (logs.get(currentWorkspace) ?? [])
    .some(l => l.source !== 'frontend' && l.source !== 'task' && /error|ERR|ENOENT|ECONNREFUSED|TypeError|SyntaxError|Cannot find/i.test(l.text));
  if (browserErrors.length === 0) {
    panel.innerHTML = '<span style="color:var(--text-muted);font-size:12px">에러 없음</span>';
    if (badge) badge.style.display = 'none';
    if (fixBtn) fixBtn.style.display = serverHasErrors ? '' : 'none';
    return;
  }
  if (badge) {
    badge.style.display = '';
    badge.textContent = browserErrors.length;
  }
  if (fixBtn) fixBtn.style.display = '';
  panel.innerHTML = browserErrors.slice(-20).reverse().map(e => {
    const loc = e.source ? ` <span style="color:var(--text-muted)">${escHtml(e.source.split('/').pop())}:${e.line || ''}</span>` : '';
    return `<div class="ws-browser-error-item">
      <span class="ws-browser-error-level">${escHtml(e.level)}</span>
      <span class="ws-browser-error-msg">${escHtml(e.message)}</span>${loc}
    </div>`;
  }).join('');
}

window.toggleAutosave = async function toggleAutosave(enabled) {
  if (!currentWorkspace) return;
  try {
    await api('POST', `/api/playgrounds/${currentWorkspace}/autosave`, { enabled });
    toast(enabled ? '오토세이브 켜짐 (5분)' : '오토세이브 꺼짐', 'info');
  } catch (err) {
    toast(`오토세이브 설정 실패: ${err.message}`, 'error');
  }
};

window.revertCommit = async function revertCommit(hash) {
  if (!currentWorkspace) return;
  if (!confirm('이 세이브를 되돌릴까요?')) return;
  try {
    await api('POST', `/api/playgrounds/${currentWorkspace}/revert-commit`, { hash });
    toast('되돌리기 완료', 'success');
    const data = await api('POST', `/api/playgrounds/${currentWorkspace}/enter`);
    renderWorkspace(data);
  } catch (err) {
    toast(`되돌리기 실패: ${err.message}`, 'error');
  }
};

/**
 * Build a structured prompt from browser errors + server logs
 * that Claude Code can use to diagnose and fix the issue.
 */
window.copyFixPrompt = async function copyFixPrompt() {
  const name = currentWorkspace;
  if (!name) return;

  const sections = [];

  // 1. Browser errors
  if (browserErrors.length > 0) {
    const errs = browserErrors.slice(-10).map(e => {
      let line = `[${e.level}] ${e.message}`;
      if (e.source) line += `\n  위치: ${e.source}${e.line ? ':' + e.line : ''}${e.col ? ':' + e.col : ''}`;
      return line;
    }).join('\n\n');
    sections.push(`## 브라우저 에러 (${browserErrors.length}개)\n\n${errs}`);
  }

  // 2. Server logs (last 20 lines, stderr/error only)
  const serverLines = (logs.get(name) ?? [])
    .filter(l => l.source !== 'frontend' && l.source !== 'task')
    .slice(-20)
    .map(l => l.text.trim())
    .filter(Boolean);
  if (serverLines.length > 0) {
    sections.push(`## 서버 로그 (최근)\n\n${serverLines.join('\n')}`);
  }

  // 3. Current changes context
  try {
    const changes = await api('GET', `/api/playgrounds/${name}/changes`);
    if (changes.files?.length > 0) {
      const fileList = changes.files.map(f => `- ${f.status} ${f.path}`).join('\n');
      sections.push(`## 현재 수정된 파일\n\n${fileList}`);
    }
  } catch { /* ignore */ }

  if (sections.length === 0) {
    toast('복사할 에러가 없습니다', 'info');
    return;
  }

  const prompt = `아래 에러를 분석하고 수정해줘.

에러를 읽고 근본 원인을 먼저 파악한 다음, 최소한의 변경으로 고쳐줘.
추측하지 말고 에러 메시지와 스택 트레이스를 근거로 진단해.
수정 후 관련 파일만 변경하고, 변경 이유를 간단히 설명해줘.

${sections.join('\n\n---\n\n')}`;

  try {
    await navigator.clipboard.writeText(prompt);
    toast('📋 에러 프롬프트 복사 완료 — Claude Code에 붙여넣기', 'success');
  } catch {
    // Fallback for non-HTTPS
    const ta = document.createElement('textarea');
    ta.value = prompt;
    ta.style.cssText = 'position:fixed;left:-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast('📋 에러 프롬프트 복사 완료 — Claude Code에 붙여넣기', 'success');
  }
};

function clearBrowserErrors() {
  browserErrors.length = 0;
  renderBrowserErrors();
}

window.wsShip = async function() {
  if (!currentWorkspace) return;
  // Fetch report for ship confirmation
  try {
    const report = await api('GET', `/api/playgrounds/${currentWorkspace}/change-report?ai=true`);
    const reportPreview = document.getElementById('ship-report-preview');
    if (reportPreview && report.totalCount > 0) {
      let html = '';
      if (report.humanDescription) {
        html += `<div class="ship-report-desc">${escHtml(report.humanDescription)}</div>`;
      }
      if (report.warnings.length > 0) {
        html += report.warnings.map(w =>
          `<div class="ws-report-warning"><span>⚠️</span> ${escHtml(w.message)}</div>`
        ).join('');
      }
      reportPreview.innerHTML = html;
      reportPreview.style.display = html ? '' : 'none';
    }
  } catch { /* non-blocking */ }
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
      playSaveEffect();
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

window.toggleCompare = async function() {
  const container = document.getElementById('ws-preview-container');
  const mainPreview = document.getElementById('ws-preview-main');
  const compareBtn = document.getElementById('ws-compare-btn');
  if (!container || !mainPreview) return;

  compareMode = !compareMode;

  if (compareMode) {
    compareBtn.classList.add('btn-active');
    mainPreview.classList.remove('hidden');
    container.classList.add('ws-split-view');

    toast('원본 서버를 준비하고 있어요...', 'info');
    try {
      const state = await api('POST', '/api/compare/start');
      if (state.status === 'running' && state.port) {
        const proxyUrl = `/preview/${state.port}/`;
        mainPreview.innerHTML = `
          <div class="ws-preview-label">🏔️ 원본 (main)</div>
          <iframe src="${escHtml(proxyUrl)}" class="ws-preview-iframe"></iframe>`;
      } else if (state.status === 'starting') {
        mainPreview.innerHTML = `
          <div class="ws-preview-label">🏔️ 원본 (main)</div>
          <div class="ws-preview-loading">준비 중...</div>`;
      } else {
        mainPreview.innerHTML = `
          <div class="ws-preview-label">🏔️ 원본 (main)</div>
          <div class="ws-preview-loading">원본 서버를 시작하지 못했어요</div>`;
      }
    } catch {
      mainPreview.innerHTML = `
        <div class="ws-preview-label">🏔️ 원본 (main)</div>
        <div class="ws-preview-loading">원본 서버를 시작하지 못했어요</div>`;
    }
  } else {
    compareBtn.classList.remove('btn-active');
    mainPreview.classList.add('hidden');
    container.classList.remove('ws-split-view');
  }
};

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Portal
// ---------------------------------------------------------------------------


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

// ---------------------------------------------------------------------------
// Sherpa Guide Mode (replaces overlay onboarding)
// ---------------------------------------------------------------------------

const ONBOARDING_KEY = 'sanjang-onboarded';

const SHERPA_GUIDE = [
  "여기에 하고 싶은 거 적으면 되유. AI가 캠프 만들어줄겨.",
  "캠프 들어가면 프리뷰 전체화면으로 보여유. 편하쥬?",
  "세이브는 게임 세이브처럼 저장이여유. 💾 버튼 누르면 되유.",
  "팀에 보내기 누르면 PR 만들어주유. 셰르파가 다 해줄겨.",
  "그럼 이제 시작해봐유. 화이팅이여유~ 🏔️",
];

// ---------------------------------------------------------------------------
// Sherpa Mode System (guide ↔ grumpy toggle)
// ---------------------------------------------------------------------------

let sherpaInterval = null;
let sherpaMode = 'grumpy'; // 'guide' or 'grumpy'
let sherpaQueue = [];
let sherpaIdx = 0;

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function setSherpaMode(mode) {
  sherpaMode = mode;
  sherpaIdx = 0;
  sherpaQueue = mode === 'guide' ? [...SHERPA_GUIDE] : shuffleArray(SHERPA_QUOTES);

  const el = document.getElementById('sherpa-quote');
  const speech = document.getElementById('sherpa-speech');
  if (!el || !speech) return;

  // Visual mode indicator
  speech.classList.toggle('guide-mode', mode === 'guide');

  // Fade transition to first message
  el.style.opacity = '0';
  setTimeout(() => {
    el.textContent = sherpaQueue[0];
    el.style.opacity = '1';
  }, 300);
}

function advanceSherpa() {
  const el = document.getElementById('sherpa-quote');
  if (!el) return;

  el.style.opacity = '0';
  setTimeout(() => {
    sherpaIdx++;
    if (sherpaIdx >= sherpaQueue.length) {
      if (sherpaMode === 'guide') {
        // Guide done → switch to grumpy
        localStorage.setItem(ONBOARDING_KEY, '1');
        setSherpaMode('grumpy');
        return;
      }
      // Reshuffle grumpy quotes
      sherpaQueue = shuffleArray(SHERPA_QUOTES);
      sherpaIdx = 0;
    }
    el.textContent = sherpaQueue[sherpaIdx];
    el.style.opacity = '1';
  }, 500);
}

// ---------------------------------------------------------------------------
// Basecamp Scene — Time-based Himalaya SVG
// ---------------------------------------------------------------------------

const SCENE_THEMES = {
  dawn: {
    skyGradient: [['0%','#050810'],['60%','#0a1028'],['100%','#141830']],
    farRange: '#1a2040',
    midRange: '#141a30',
    ground: '#12151e',
    snowColor: 'rgba(200,215,240,0.35)',
    snowHighlight: 'rgba(220,230,250,0.4)',
  },
  morning: {
    skyGradient: [['0%','#1a2540'],['40%','#2d3a5c'],['70%','#5c4a6e'],['100%','#c4785a']],
    farRange: '#2a3058',
    midRange: '#1e2444',
    ground: '#12151e',
    snowColor: 'rgba(255,220,180,0.45)',
    snowHighlight: 'rgba(255,200,150,0.55)',
  },
  day: {
    skyGradient: [['0%','#1a3050'],['50%','#2a4a6a'],['100%','#3a5a7a']],
    farRange: '#253a58',
    midRange: '#1a2e48',
    ground: '#12151e',
    snowColor: 'rgba(255,255,255,0.5)',
    snowHighlight: 'rgba(255,255,255,0.6)',
  },
  evening: {
    skyGradient: [['0%','#060810'],['40%','#0e1530'],['75%','#1a1535'],['100%','#12151e']],
    farRange: '#182040',
    midRange: '#121830',
    ground: '#12151e',
    snowColor: 'rgba(200,180,230,0.35)',
    snowHighlight: 'rgba(220,200,240,0.4)',
  },
};

function renderBasecampScene() {
  const container = document.getElementById('bc-scene-container');
  if (!container) return;

  const P = 4; // pixel size (4px grid)
  const hour = new Date().getHours();
  let period;
  if (hour >= 0 && hour < 6) period = 'dawn';
  else if (hour >= 6 && hour < 12) period = 'morning';
  else if (hour >= 12 && hour < 18) period = 'day';
  else period = 'evening';

  const theme = SCENE_THEMES[period];

  // Build gradient stops
  const stops = theme.skyGradient.map(([offset, color]) =>
    `<stop offset="${offset}" stop-color="${color}"/>`
  ).join('');

  // --- Stars ---
  let starsHtml = '';
  if (period === 'dawn') {
    const starPositions = [
      [45,18],[120,30],[200,12],[280,25],[360,8],[440,22],[520,15],[590,28],[150,40],[400,35],[60,42],[500,38],[330,10]
    ];
    starsHtml = starPositions.map(([x,y]) =>
      `<rect x="${x}" y="${y}" width="2" height="2" fill="#fff" opacity="${0.4 + Math.random()*0.4}"><animate attributeName="opacity" values="${0.3};${0.8};${0.3}" dur="${1.5 + Math.random()*2}s" repeatCount="indefinite"/></rect>`
    ).join('');
    // Crescent moon (pixel)
    starsHtml += `
      <rect x="576" y="20" width="${P}" height="${P}" fill="#c8cee6" opacity="0.3"/>
      <rect x="580" y="16" width="${P}" height="${P}" fill="#c8cee6" opacity="0.3"/>
      <rect x="580" y="20" width="${P}" height="${P}" fill="#c8cee6" opacity="0.25"/>
      <rect x="584" y="16" width="${P}" height="${P}" fill="#c8cee6" opacity="0.3"/>
      <rect x="584" y="20" width="${P}" height="${P}" fill="#c8cee6" opacity="0.15"/>
      <rect x="588" y="20" width="${P}" height="${P}" fill="#c8cee6" opacity="0.3"/>
      <rect x="580" y="24" width="${P}" height="${P}" fill="#c8cee6" opacity="0.25"/>
      <rect x="584" y="24" width="${P}" height="${P}" fill="#c8cee6" opacity="0.3"/>
    `;
  } else if (period === 'morning') {
    const starPositions = [[120,20],[400,15],[550,30]];
    starsHtml = starPositions.map(([x,y]) =>
      `<rect x="${x}" y="${y}" width="2" height="2" fill="#fff" opacity="0.2"/>`
    ).join('');
  } else if (period === 'day') {
    // Pixel clouds (4px grid)
    starsHtml = `
      <g opacity="0.12">
        <rect x="104" y="28" width="8" height="4" fill="#fff"/>
        <rect x="100" y="32" width="16" height="4" fill="#fff"/>
        <rect x="108" y="36" width="4" height="4" fill="#fff"/>
        <rect x="436" y="24" width="12" height="4" fill="#fff"/>
        <rect x="432" y="28" width="20" height="4" fill="#fff"/>
        <rect x="440" y="32" width="8" height="4" fill="#fff"/>
      </g>
    `;
  } else {
    const starPositions = [
      [80,15],[160,35],[250,10],[340,28],[430,18],[510,32],[590,12],[140,45],[380,40],[620,25]
    ];
    starsHtml = starPositions.map(([x,y]) =>
      `<rect x="${x}" y="${y}" width="2" height="2" fill="#fff" opacity="${0.3 + Math.random()*0.5}"><animate attributeName="opacity" values="${0.2};${0.7};${0.2}" dur="${2 + Math.random()*2}s" repeatCount="indefinite"/></rect>`
    ).join('');
  }

  // --- Mountains ---
  const farRangePoly = `0,220 0,150 20,150 20,140 40,140 40,125 55,125 55,115 70,115 70,105 85,105 85,95
    95,95 95,85 105,85 105,80 115,80 115,85 125,85 125,95 135,95 135,105
    150,105 150,115 165,115 165,125 180,125 180,135 200,135 200,145 220,145
    220,135 235,135 235,120 250,120 250,105 260,105 260,90 270,90 270,78 280,78
    280,70 288,70 288,62 295,62 295,56 302,56 302,50 308,50 308,45 314,45
    314,50 320,50 320,56 326,56 326,65 335,65 335,78 345,78 345,90
    355,90 355,105 370,105 370,120 385,120 385,135 400,135
    400,125 415,125 415,110 425,110 425,98 435,98 435,88 445,88 445,78
    450,78 450,70 456,70 456,64 462,64 462,58 466,58 466,54 470,54
    470,50 474,50 474,46 478,46 478,50 482,50 482,56 486,56
    486,64 492,64 492,72 498,72 498,82 508,82 508,95 518,95
    518,108 530,108 530,120 545,120 545,135 560,135
    560,125 570,125 570,112 580,112 580,100 590,100 590,88 598,88 598,78
    605,78 605,70 612,70 612,76 618,76 618,85 625,85 625,95
    635,95 635,108 645,108 645,120 658,120 658,135 680,135 680,220`;

  const midRangePoly = `0,220 0,170 30,170 30,160 60,160 60,152 80,152 80,160 110,160 110,168
    140,168 140,158 160,158 160,148 175,148 175,140 188,140 188,135 198,135 198,140
    210,140 210,150 230,150 230,162 260,162 260,155 280,155 280,145 295,145 295,138
    310,138 310,145 330,145 330,155 350,155 350,165
    380,165 380,155 400,155 400,148 415,148 415,140 425,140 425,135 432,135 432,140
    440,140 440,150 460,150 460,160 480,160 480,168
    510,168 510,158 530,158 530,148 545,148 545,142 555,142 555,148
    565,148 565,158 585,158 585,165 610,165 610,158 630,158 630,165 660,165 660,170 680,170 680,220`;

  // --- Snow caps (4px grid) ---
  const snowCaps = `
    <!-- Main peak snow -->
    <rect x="308" y="45" width="${P*2}" height="${P}" fill="${theme.snowHighlight}"/>
    <rect x="304" y="49" width="${P*4}" height="${P}" fill="${theme.snowColor}"/>
    <!-- Second peak snow -->
    <rect x="474" y="46" width="${P*2}" height="${P}" fill="${theme.snowHighlight}"/>
    <rect x="470" y="50" width="${P*4}" height="${P}" fill="${theme.snowColor}"/>
    <!-- Smaller peaks -->
    <rect x="104" y="80" width="${P*2}" height="${P}" fill="${theme.snowHighlight}"/>
    <rect x="604" y="70" width="${P*2}" height="${P}" fill="${theme.snowHighlight}"/>
    <!-- Mid-range snow -->
    <rect x="188" y="135" width="${P*2}" height="${P}" fill="${theme.snowColor}" opacity="0.5"/>
    <rect x="424" y="135" width="${P*2}" height="${P}" fill="${theme.snowColor}" opacity="0.5"/>
    <rect x="544" y="142" width="${P*2}" height="${P}" fill="${theme.snowColor}" opacity="0.5"/>
  `;

  // --- Ground + texture ---
  const groundHtml = `
    <rect x="0" y="185" width="680" height="35" fill="${theme.ground}"/>
    <rect x="50" y="188" width="8" height="3" fill="#1a1d28" opacity="0.5"/>
    <rect x="200" y="190" width="6" height="2" fill="#1a1d28" opacity="0.4"/>
    <rect x="350" y="187" width="10" height="3" fill="#1a1d28" opacity="0.5"/>
    <rect x="500" y="191" width="7" height="2" fill="#1a1d28" opacity="0.4"/>
    <rect x="620" y="189" width="5" height="3" fill="#1a1d28" opacity="0.5"/>
  `;

  // --- Shared basecamp elements (all 4px grid pixel art) ---

  const tents = `
    <!-- Yellow expedition tent (pixel pyramid) -->
    <g>
      <rect x="88" y="172" width="${P}" height="${P}" fill="#c8a820"/>
      <rect x="84" y="176" width="${P}" height="${P}" fill="#c8a820"/>
      <rect x="88" y="176" width="${P}" height="${P}" fill="#a08818"/>
      <rect x="92" y="176" width="${P}" height="${P}" fill="#c8a820"/>
      <rect x="80" y="180" width="${P}" height="${P}" fill="#c8a820"/>
      <rect x="84" y="180" width="${P}" height="${P}" fill="#c8a820"/>
      <rect x="88" y="180" width="${P}" height="${P}" fill="#2c2210"/>
      <rect x="92" y="180" width="${P}" height="${P}" fill="#c8a820"/>
      <rect x="96" y="180" width="${P}" height="${P}" fill="#c8a820"/>
    </g>
    <!-- Blue dome tent (pixel) -->
    <g>
      <rect x="520" y="176" width="${P}" height="${P}" fill="#2855a0"/>
      <rect x="524" y="176" width="${P}" height="${P}" fill="#2855a0"/>
      <rect x="516" y="180" width="${P}" height="${P}" fill="#2855a0"/>
      <rect x="520" y="180" width="${P}" height="${P}" fill="#2855a0"/>
      <rect x="524" y="180" width="${P}" height="${P}" fill="#1a2040"/>
      <rect x="528" y="180" width="${P}" height="${P}" fill="#2855a0"/>
      <rect x="532" y="180" width="${P}" height="${P}" fill="#2855a0"/>
    </g>
    <!-- Green small tent (pixel) -->
    <g>
      <rect x="580" y="176" width="${P}" height="${P}" fill="#1e8040"/>
      <rect x="576" y="180" width="${P}" height="${P}" fill="#1e8040"/>
      <rect x="580" y="180" width="${P}" height="${P}" fill="#166030"/>
      <rect x="584" y="180" width="${P}" height="${P}" fill="#1e8040"/>
    </g>
    <!-- Red expedition tent (pixel) -->
    <g>
      <rect x="448" y="172" width="${P}" height="${P}" fill="#b83030"/>
      <rect x="444" y="176" width="${P}" height="${P}" fill="#b83030"/>
      <rect x="448" y="176" width="${P}" height="${P}" fill="#902020"/>
      <rect x="452" y="176" width="${P}" height="${P}" fill="#b83030"/>
      <rect x="440" y="180" width="${P}" height="${P}" fill="#b83030"/>
      <rect x="444" y="180" width="${P}" height="${P}" fill="#b83030"/>
      <rect x="448" y="180" width="${P}" height="${P}" fill="#401010"/>
      <rect x="452" y="180" width="${P}" height="${P}" fill="#b83030"/>
      <rect x="456" y="180" width="${P}" height="${P}" fill="#b83030"/>
    </g>
  `;

  const flagColors = ['#e74c3c','#f39c12','#fff','#2ecc71','#3498db'];
  const prayerFlags1 = flagColors.map((c, i) =>
    `<rect x="${156 + i*8}" y="172" width="${P}" height="${P}" fill="${c}" opacity="0.7"/>`
  ).join('') + flagColors.map((c, i) =>
    `<rect x="${156 + i*8}" y="168" width="${P}" height="1" fill="#4a5170" opacity="0.5"/>`
  ).join('');

  const prayerFlags2 = flagColors.map((c, i) =>
    `<rect x="${420 + i*8}" y="168" width="${P}" height="${P}" fill="${c}" opacity="0.6"/>`
  ).join('') + flagColors.map((c, i) =>
    `<rect x="${420 + i*8}" y="164" width="${P}" height="1" fill="#4a5170" opacity="0.4"/>`
  ).join('');

  const supplies = `
    <!-- Supply crates (pixel) -->
    <rect x="128" y="180" width="${P*2}" height="${P}" fill="#6b4a28"/>
    <rect x="128" y="180" width="${P*2}" height="1" fill="#8b6a38"/>
    <rect x="128" y="176" width="${P*2}" height="${P}" fill="#5a3a20"/>
    <rect x="128" y="176" width="${P*2}" height="1" fill="#7a5a30"/>
    <rect x="136" y="180" width="${P}" height="${P}" fill="#5a3a20"/>
    <!-- Oxygen tanks (pixel) -->
    <rect x="472" y="180" width="${P}" height="${P}" fill="#4a6a8a"/>
    <rect x="472" y="176" width="${P}" height="${P}" fill="#6a8aaa"/>
    <rect x="476" y="180" width="${P}" height="${P}" fill="#4a6a8a"/>
    <rect x="476" y="176" width="${P}" height="${P}" fill="#6a8aaa"/>
    <!-- Signpost (pixel) -->
    <rect x="300" y="172" width="${P}" height="${P*3}" fill="#5a4a30"/>
    <rect x="296" y="172" width="${P*3}" height="${P}" fill="#6b5a38"/>
    <rect x="308" y="173" width="${P}" height="2" fill="#6b5a38"/>
    <!-- Rope coil (pixel) -->
    <rect x="600" y="176" width="${P}" height="${P}" fill="#8b7a50"/>
    <rect x="604" y="176" width="${P}" height="${P}" fill="#8b7a50"/>
    <rect x="596" y="180" width="${P}" height="${P}" fill="#8b7a50"/>
    <rect x="608" y="180" width="${P}" height="${P}" fill="#8b7a50"/>
    <rect x="600" y="184" width="${P}" height="${P}" fill="#8b7a50"/>
    <rect x="604" y="184" width="${P}" height="${P}" fill="#8b7a50"/>
    <!-- Ice axe (pixel) -->
    <rect x="144" y="168" width="${P}" height="${P}" fill="#8090b0"/>
    <rect x="144" y="172" width="${P}" height="${P}" fill="#6b5a38"/>
    <rect x="144" y="176" width="${P}" height="${P}" fill="#6b5a38"/>
    <rect x="140" y="168" width="${P}" height="${P}" fill="#aab0c0"/>
  `;

  // --- Stone ring around campfire (4px grid) ---
  const stoneRing = `
    <rect x="320" y="184" width="${P}" height="${P}" fill="#3a3a40"/>
    <rect x="324" y="184" width="${P}" height="${P}" fill="#454550"/>
    <rect x="336" y="184" width="${P}" height="${P}" fill="#454550"/>
    <rect x="340" y="184" width="${P}" height="${P}" fill="#3a3a40"/>
    <rect x="318" y="180" width="${P}" height="${P}" fill="#454550"/>
    <rect x="342" y="180" width="${P}" height="${P}" fill="#3a3a40"/>
  `;

  // --- Campfire (period-specific) ---
  let campfireHtml = '';
  if (period === 'dawn') {
    // Dim embers (pixel)
    campfireHtml = `
      ${stoneRing}
      <rect x="328" y="180" width="${P}" height="${P}" fill="#8b2200" opacity="0.5"/>
      <rect x="332" y="180" width="${P}" height="${P}" fill="#a03000" opacity="0.4"/>
    `;
  } else if (period === 'morning') {
    // Smoke only (pixel)
    campfireHtml = `
      ${stoneRing}
      <rect x="328" y="180" width="${P}" height="${P}" fill="#5a4a30"/>
      <rect x="332" y="180" width="${P}" height="${P}" fill="#5a4a30"/>
      <rect x="328" y="176" width="${P}" height="${P}" fill="#4a5170" opacity="0.2"/>
      <rect x="332" y="172" width="${P}" height="${P}" fill="#4a5170" opacity="0.15"/>
      <rect x="328" y="168" width="${P}" height="${P}" fill="#4a5170" opacity="0.1"/>
    `;
  } else if (period === 'day') {
    // No fire, just logs (pixel)
    campfireHtml = `
      ${stoneRing}
      <rect x="324" y="180" width="${P*3}" height="${P}" fill="#5a4a30"/>
      <rect x="328" y="176" width="${P*2}" height="${P}" fill="#6b4a28"/>
    `;
  } else {
    // Full fire with glow (all 4px pixel)
    campfireHtml = `
      ${stoneRing}
      <!-- Glow (rect-based) -->
      <rect x="316" y="168" width="${P*7}" height="${P*4}" fill="#ff8c32" opacity="0.04"/>
      <rect x="320" y="172" width="${P*5}" height="${P*3}" fill="#ff6600" opacity="0.06"/>
      <!-- Logs -->
      <rect x="324" y="180" width="${P*3}" height="${P}" fill="#5a3a20"/>
      <rect x="326" y="180" width="${P*3}" height="${P}" fill="#6b4a28"/>
      <!-- Flames (pixel, animated with steps) -->
      <rect x="328" y="176" width="${P}" height="${P}" fill="#ff6600">
        <animate attributeName="opacity" values="1;0.6;1" dur="0.4s" steps="2" repeatCount="indefinite"/>
      </rect>
      <rect x="332" y="172" width="${P}" height="${P}" fill="#ffcc00">
        <animate attributeName="opacity" values="0.8;1;0.6" dur="0.5s" steps="2" repeatCount="indefinite"/>
      </rect>
      <rect x="332" y="176" width="${P}" height="${P}" fill="#ff8800"/>
      <rect x="328" y="172" width="${P}" height="${P}" fill="#ff9900" opacity="0.7">
        <animate attributeName="opacity" values="0.7;0.3;0.7" dur="0.35s" steps="2" repeatCount="indefinite"/>
      </rect>
      <rect x="336" y="176" width="${P}" height="${P}" fill="#ff6600" opacity="0.6"/>
      <rect x="330" y="168" width="${P}" height="${P}" fill="#ff6600" opacity="0.4">
        <animate attributeName="opacity" values="0.4;0.1;0.4" dur="0.6s" steps="2" repeatCount="indefinite"/>
      </rect>
      <!-- Smoke (pixel) -->
      <rect x="332" y="164" width="${P}" height="${P}" fill="#4a5170" opacity="0.15">
        <animate attributeName="opacity" values="0.15;0.05;0.15" dur="2s" repeatCount="indefinite"/>
      </rect>
      <rect x="328" y="160" width="${P}" height="${P}" fill="#4a5170" opacity="0.08"/>
    `;
  }

  // --- Sherpa (period-specific) ---
  let sherpaHtml = '';
  if (period === 'dawn') {
    // Sleeping horizontally
    sherpaHtml = `
      <g transform="translate(345, 178)">
        <!-- Body lying flat -->
        <rect x="0" y="0" width="4" height="4" fill="#3498db"/>
        <rect x="4" y="0" width="4" height="4" fill="#3498db"/>
        <rect x="8" y="0" width="4" height="4" fill="#3498db"/>
        <rect x="12" y="0" width="4" height="4" fill="#2c3e50"/>
        <rect x="16" y="0" width="4" height="4" fill="#2c3e50"/>
        <!-- Head -->
        <rect x="-4" y="-1" width="4" height="4" fill="#f5c6a0"/>
        <!-- Hat flat -->
        <rect x="-8" y="-2" width="4" height="4" fill="#e74c3c"/>
        <!-- Zzz (pixel) -->
        <rect x="8" y="-8" width="${P}" height="${P}" fill="#8888aa" opacity="0.5"/>
        <rect x="12" y="-12" width="${P}" height="${P}" fill="#8888aa" opacity="0.4"/>
        <rect x="14" y="-16" width="${P}" height="${P}" fill="#8888aa" opacity="0.3"/>
        <rect x="16" y="-20" width="${P}" height="${P}" fill="#8888aa" opacity="0.2"/>
      </g>
    `;
  } else if (period === 'morning') {
    // Stretching (arms raised)
    sherpaHtml = `
      <g transform="translate(345, 170)">
        <!-- Hat -->
        <rect x="0" y="-8" width="4" height="4" fill="#e74c3c"/>
        <rect x="-4" y="-8" width="4" height="4" fill="#e74c3c"/>
        <rect x="4" y="-8" width="4" height="4" fill="#e74c3c"/>
        <!-- Face -->
        <rect x="-4" y="-4" width="4" height="4" fill="#f5c6a0"/>
        <rect x="0" y="-4" width="4" height="4" fill="#f5c6a0"/>
        <rect x="4" y="-4" width="4" height="4" fill="#f5c6a0"/>
        <!-- Body -->
        <rect x="-4" y="0" width="4" height="4" fill="#3498db"/>
        <rect x="0" y="0" width="4" height="4" fill="#3498db"/>
        <rect x="4" y="0" width="4" height="4" fill="#3498db"/>
        <!-- Arms raised -->
        <rect x="-8" y="-8" width="4" height="4" fill="#3498db"/>
        <rect x="8" y="-4" width="4" height="4" fill="#3498db"/>
        <!-- Lower body -->
        <rect x="-4" y="4" width="4" height="4" fill="#3498db"/>
        <rect x="0" y="4" width="4" height="4" fill="#3498db"/>
        <rect x="4" y="4" width="4" height="4" fill="#3498db"/>
        <!-- Legs -->
        <rect x="-4" y="8" width="4" height="4" fill="#2c3e50"/>
        <rect x="4" y="8" width="4" height="4" fill="#2c3e50"/>
      </g>
    `;
  } else if (period === 'day') {
    // Walking pose with backpack
    sherpaHtml = `
      <g transform="translate(355, 166)">
        <!-- Hat -->
        <rect x="0" y="-8" width="4" height="4" fill="#e74c3c"/>
        <rect x="-4" y="-8" width="4" height="4" fill="#e74c3c"/>
        <rect x="4" y="-8" width="4" height="4" fill="#e74c3c"/>
        <!-- Face -->
        <rect x="-4" y="-4" width="4" height="4" fill="#f5c6a0"/>
        <rect x="0" y="-4" width="4" height="4" fill="#f5c6a0"/>
        <rect x="4" y="-4" width="4" height="4" fill="#f5c6a0"/>
        <!-- Body -->
        <rect x="-4" y="0" width="4" height="4" fill="#3498db"/>
        <rect x="0" y="0" width="4" height="4" fill="#3498db"/>
        <rect x="4" y="0" width="4" height="4" fill="#3498db"/>
        <rect x="-4" y="4" width="4" height="4" fill="#3498db"/>
        <rect x="0" y="4" width="4" height="4" fill="#3498db"/>
        <rect x="4" y="4" width="4" height="4" fill="#3498db"/>
        <!-- Backpack -->
        <rect x="8" y="0" width="4" height="4" fill="#8b6914"/>
        <rect x="8" y="4" width="4" height="4" fill="#8b6914"/>
        <!-- Legs (walking) -->
        <rect x="-4" y="8" width="4" height="4" fill="#2c3e50"/>
        <rect x="0" y="8" width="4" height="4" fill="#2c3e50"/>
        <rect x="4" y="12" width="4" height="4" fill="#2c3e50"/>
        <rect x="-4" y="12" width="4" height="4" fill="#2c3e50"/>
      </g>
    `;
  } else {
    // Sitting with mug
    sherpaHtml = `
      <g transform="translate(345, 170)">
        <!-- Hat -->
        <rect x="0" y="-8" width="4" height="4" fill="#e74c3c"/>
        <rect x="-4" y="-8" width="4" height="4" fill="#e74c3c"/>
        <rect x="4" y="-8" width="4" height="4" fill="#e74c3c"/>
        <!-- Face -->
        <rect x="-4" y="-4" width="4" height="4" fill="#f5c6a0"/>
        <rect x="0" y="-4" width="4" height="4" fill="#f5c6a0"/>
        <rect x="4" y="-4" width="4" height="4" fill="#f5c6a0"/>
        <!-- Body -->
        <rect x="-4" y="0" width="4" height="4" fill="#3498db"/>
        <rect x="0" y="0" width="4" height="4" fill="#3498db"/>
        <rect x="4" y="0" width="4" height="4" fill="#3498db"/>
        <!-- Backpack -->
        <rect x="8" y="0" width="4" height="4" fill="#8b6914"/>
        <!-- Sitting legs -->
        <rect x="-4" y="4" width="4" height="4" fill="#2c3e50"/>
        <rect x="0" y="4" width="4" height="4" fill="#2c3e50"/>
        <!-- Mug (pixel) -->
        <rect x="-8" y="0" width="${P}" height="${P}" fill="#ddd"/>
        <rect x="-12" y="0" width="${P}" height="${P}" fill="#ddd" opacity="0.5"/>
        <!-- Steam (pixel) -->
        <rect x="-8" y="-4" width="${P}" height="${P}" fill="#4a5170" opacity="0.2">
          <animate attributeName="opacity" values="0.2;0.05;0.2" dur="2s" repeatCount="indefinite"/>
        </rect>
      </g>
    `;
  }

  // --- Distant climber (day and evening only) ---
  let distantClimber = '';
  if (period === 'day' || period === 'evening') {
    const climbOpacity = period === 'day' ? 0.6 : 0.5;
    distantClimber = `
      <g transform="translate(612, 148)" opacity="${climbOpacity}">
        <rect x="0" y="0" width="${P}" height="${P}" fill="#f5c6a0"/>
        <rect x="0" y="4" width="${P}" height="${P}" fill="#c84040"/>
        <rect x="0" y="8" width="${P}" height="${P}" fill="#2c3e50"/>
        <rect x="4" y="0" width="${P}" height="${P}" fill="#8090b0" opacity="0.5"/>
        <rect x="4" y="4" width="${P}" height="${P}" fill="#8090b0" opacity="0.4"/>
      </g>
    `;
  }

  // --- Tent glow (dawn only) ---
  let tentGlow = '';
  if (period === 'dawn') {
    tentGlow = `<rect x="88" y="180" width="4" height="4" fill="#ffcc44" opacity="0.3"/>`;
  }

  // --- Sunrise glow (morning only) ---
  let sunriseGlow = '';
  if (period === 'morning') {
    sunriseGlow = `<rect x="360" y="140" width="280" height="60" fill="#e8834a" opacity="0.06"/>
      <rect x="400" y="160" width="200" height="40" fill="#f5a060" opacity="0.05"/>`;
  }

  // --- Assemble SVG ---
  const svgString = `
    <svg viewBox="0 0 680 220" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice" style="image-rendering:pixelated">
      <defs>
        <linearGradient id="bc-sky" x1="0" y1="0" x2="0" y2="1">
          ${stops}
        </linearGradient>
      </defs>

      <!-- Sky -->
      <rect width="680" height="220" fill="url(#bc-sky)"/>

      ${sunriseGlow}

      <!-- Stars / clouds -->
      ${starsHtml}

      <!-- Far range mountains -->
      <polygon points="${farRangePoly}" fill="${theme.farRange}"/>

      <!-- Snow caps -->
      ${snowCaps}

      <!-- Mid range mountains -->
      <polygon points="${midRangePoly}" fill="${theme.midRange}"/>

      <!-- Ground -->
      ${groundHtml}

      <!-- Tent glow -->
      ${tentGlow}

      <!-- Tents -->
      ${tents}

      <!-- Prayer flags -->
      ${prayerFlags1}
      ${prayerFlags2}

      <!-- Supplies & gear -->
      ${supplies}

      <!-- Campfire -->
      ${campfireHtml}

      <!-- Sherpa -->
      ${sherpaHtml}

      <!-- Distant climber -->
      ${distantClimber}
    </svg>
  `;

  container.innerHTML = svgString;
}

function startSherpaQuotes() {
  const el = document.getElementById('sherpa-quote');
  if (!el) return;

  const isFirstVisit = !localStorage.getItem(ONBOARDING_KEY);

  if (isFirstVisit) {
    // First visit: start with tap prompt, then guide on click
    sherpaMode = 'intro';
    el.textContent = '나를 눌러보세유~';
  } else {
    setSherpaMode('grumpy');
  }

  // Start rotation timer
  if (sherpaInterval) clearInterval(sherpaInterval);
  sherpaInterval = setInterval(() => {
    if (sherpaMode === 'intro') return; // Don't rotate during intro
    advanceSherpa();
  }, 8000);
}

window.toggleSherpaMode = function() {
  const speech = document.getElementById('sherpa-speech');
  const el = document.getElementById('sherpa-quote');
  if (!el || !speech) return;

  if (sherpaMode === 'intro') {
    // First click ever: enter guide mode
    setSherpaMode('guide');
    return;
  }

  // Toggle between guide and grumpy
  const newMode = sherpaMode === 'guide' ? 'grumpy' : 'guide';

  // Brief mode-switch message
  el.style.opacity = '0';
  setTimeout(() => {
    if (newMode === 'guide') {
      el.textContent = '가이드 모드여유~ 사용법 알려줄겨 📋';
    } else {
      el.textContent = '다시 푸념 모드여유... 😮‍💨';
    }
    el.style.opacity = '1';

    setTimeout(() => {
      setSherpaMode(newMode);
    }, 2000);
  }, 300);
};

// ---------------------------------------------------------------------------
// Activity Trail
// ---------------------------------------------------------------------------

async function loadActivityTrail() {
  const container = document.getElementById('activity-trail');
  const section = document.getElementById('activity-trail-section');
  if (!container || !section) return;

  try {
    const data = await api('GET', '/api/activity');
    if (!data || !data.daily || data.daily.length === 0) {
      section.style.display = 'none';
      return;
    }

    section.style.display = '';
    const days = data.daily;
    const prs = data.mergedPrs || [];
    const streak = data.streak || 0;
    const totalCommits = days.reduce((s, d) => s + d.commits, 0);

    // Calculate terrain heights
    const maxCommits = Math.max(...days.map(d => d.commits), 1);
    const svgW = 680, svgH = 180;
    const ground = 150, ceiling = 35;
    const dayW = (svgW - 40) / days.length; // 20px padding each side

    // Map commits to Y coordinate (more commits = higher = lower Y)
    const heights = days.map(d => {
      if (d.commits === 0) return ground;
      return ground - ((d.commits / maxCommits) * (ground - ceiling));
    });

    // Build stepped polyline points (pixel staircase)
    let terrainPoints = `20,${ground} `;
    heights.forEach((h, i) => {
      const x = 20 + i * dayW;
      const xEnd = 20 + (i + 1) * dayW;
      terrainPoints += `${x},${h} ${xEnd},${h} `;
    });
    terrainPoints += `${20 + days.length * dayW},${ground}`;

    // PR merge dates set for lookup
    const prByDate = {};
    prs.forEach(pr => {
      const date = pr.mergedAt.split('T')[0];
      if (!prByDate[date]) prByDate[date] = [];
      prByDate[date].push(pr);
    });

    // Build pixel decorations
    let decorations = '';

    // Stars
    const starPositions = [[45,8],[130,14],[220,6],[350,10],[480,5],[560,16],[640,8]];
    starPositions.forEach(([x,y]) => {
      decorations += `<rect x="${x}" y="${y}" width="2" height="2" fill="#fff" opacity="${0.2 + Math.random() * 0.3}"/>`;
    });

    // Snow on high peaks (top 20%)
    const threshold = ceiling + (ground - ceiling) * 0.3;
    heights.forEach((h, i) => {
      if (h < threshold) {
        const x = 20 + i * dayW + dayW / 2 - 3;
        decorations += `<rect x="${x}" y="${h}" width="6" height="2" fill="rgba(255,255,255,0.2)"/>`;
      }
    });

    // Trees on low terrain
    heights.forEach((h, i) => {
      if (h > ground - 30 && h < ground && days[i].commits > 0 && Math.random() > 0.7) {
        const x = 20 + i * dayW + dayW / 2;
        decorations += `
          <rect x="${x}" y="${h - 8}" width="2" height="8" fill="#3d5a3d"/>
          <rect x="${x - 2}" y="${h - 12}" width="6" height="4" fill="#4a7a4a"/>
          <rect x="${x}" y="${h - 16}" width="2" height="4" fill="#5b8c5a"/>`;
      }
    });

    // Tents on rest days — limit density when most days are rest days
    const activeDays = days.filter(d => d.commits > 0).length;
    const tentChance = activeDays < 5 ? 0.85 : 0.5; // fewer active days → fewer tents
    heights.forEach((h, i) => {
      if (days[i].commits === 0 && i > 0 && i < days.length - 1 && Math.random() > tentChance) {
        const x = 20 + i * dayW + dayW / 2 - 4;
        decorations += `
          <rect x="${x + 3}" y="${ground - 8}" width="2" height="2" fill="#6b7394"/>
          <rect x="${x + 1}" y="${ground - 6}" width="6" height="2" fill="#6b7394"/>
          <rect x="${x}" y="${ground - 4}" width="8" height="2" fill="#4a5170"/>`;
      }
    });

    // PR campfires + tooltip triggers
    let prMarkers = '';
    days.forEach((d, i) => {
      const datePrs = prByDate[d.date];
      if (datePrs && datePrs.length > 0) {
        const x = 20 + i * dayW + dayW / 2 - 4;
        const h = heights[i];
        const tooltipText = datePrs.map(p => `#${p.number} ${escHtml(p.title)}`).join('\n');
        prMarkers += `
          <g class="pr-marker" data-tooltip="${escHtml(tooltipText)}">
            <rect x="${x}" y="${h - 4}" width="2" height="2" fill="#8B4513"/>
            <rect x="${x + 4}" y="${h - 4}" width="2" height="2" fill="#8B4513"/>
            <rect x="${x + 2}" y="${h - 8}" width="2" height="4" fill="#ff6600"/>
            <rect x="${x}" y="${h - 10}" width="2" height="2" fill="#ffcc00"/>
            <rect x="${x + 4}" y="${h - 12}" width="2" height="4" fill="#ff9900"/>
            <rect x="${x + 2}" y="${h - 14}" width="2" height="4" fill="#ffcc00"/>
            <circle cx="${x + 3}" cy="${h - 8}" r="6" fill="#ff9900" opacity="0.06"/>
          </g>`;
      }
    });

    // Coins on top 3 peaks
    const peakIndices = heights
      .map((h, i) => ({ h, i }))
      .sort((a, b) => a.h - b.h)
      .slice(0, 3);
    peakIndices.forEach(({ h, i }) => {
      const x = 20 + i * dayW + dayW / 2 - 3;
      decorations += `
        <rect x="${x}" y="${h - 10}" width="6" height="6" fill="#f59e0b" opacity="0.7"/>
        <rect x="${x + 2}" y="${h - 8}" width="2" height="2" fill="#0a0c11"/>`;
    });

    // Flag on highest peak
    const highest = peakIndices[0];
    if (highest) {
      const x = 20 + highest.i * dayW + dayW / 2;
      decorations += `
        <rect x="${x}" y="${highest.h}" width="2" height="14" fill="#f59e0b"/>
        <polygon points="${x + 2},${highest.h} ${x + 8},${highest.h + 3} ${x + 2},${highest.h + 6}" fill="#f59e0b"/>`;
    }

    // Sherpa at today (last position, clamped to SVG bounds)
    const lastX = Math.min(20 + (days.length - 1) * dayW + dayW / 2 - 4, svgW - 24);
    const lastH = heights[heights.length - 1];
    const sherpaY = lastH - 16;
    const sherpa = `
      <g transform="translate(${lastX}, ${sherpaY})">
        <rect x="2" y="0" width="4" height="2" fill="#5b8c5a"/>
        <rect x="0" y="2" width="8" height="2" fill="#5b8c5a"/>
        <rect x="2" y="4" width="4" height="4" fill="#ffcc88"/>
        <rect x="2" y="8" width="4" height="4" fill="#e74c3c"/>
        <rect x="0" y="8" width="2" height="2" fill="#e74c3c"/>
        <rect x="6" y="8" width="2" height="4" fill="#8B6914"/>
        <rect x="2" y="12" width="2" height="2" fill="#5b4a3a"/>
        <rect x="4" y="12" width="2" height="2" fill="#5b4a3a"/>
      </g>`;

    // Week labels
    let weekLabels = '';
    const weekSize = 7;
    for (let w = 0; w < Math.floor(days.length / weekSize); w++) {
      const x = 20 + (w * weekSize + 3) * dayW;
      const weeksAgo = Math.floor(days.length / weekSize) - w - 1;
      const label = weeksAgo === 0 ? '이번 주' : `${weeksAgo}주 전`;
      weekLabels += `<text x="${x}" y="170" font-size="8" fill="#4a5170" font-family="Outfit,sans-serif" text-anchor="middle">${label}</text>`;
    }

    // Pixel clouds
    const clouds = `
      <g opacity="0.08">
        <rect x="80" y="20" width="4" height="4" fill="#fff"/>
        <rect x="84" y="18" width="8" height="4" fill="#fff"/>
        <rect x="88" y="16" width="4" height="4" fill="#fff"/>
        <rect x="92" y="18" width="4" height="4" fill="#fff"/>
        <rect x="76" y="22" width="24" height="4" fill="#fff"/>
      </g>
      <g opacity="0.06">
        <rect x="420" y="14" width="4" height="4" fill="#fff"/>
        <rect x="424" y="12" width="8" height="4" fill="#fff"/>
        <rect x="432" y="14" width="4" height="4" fill="#fff"/>
        <rect x="416" y="18" width="24" height="4" fill="#fff"/>
      </g>`;

    // PR tooltip container (CSS positioned)
    const tooltip = `<div class="activity-tooltip" id="activity-tooltip" style="display:none;position:absolute;background:#1c2030;border:1px solid #2a2f42;border-radius:6px;padding:8px 12px;font-size:12px;color:#e4e8f0;pointer-events:none;white-space:nowrap;z-index:10;max-width:320px;box-shadow:0 4px 12px rgba(0,0,0,0.4);"></div>`;

    const svg = `
      <svg viewBox="0 0 ${svgW} ${svgH}" style="display:block;width:100%;" xmlns="http://www.w3.org/2000/svg">
        <rect x="0" y="0" width="${svgW}" height="${svgH}" fill="#080a10"/>
        ${clouds}
        ${decorations}
        <defs>
          <linearGradient id="trailFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#5b8c5a" stop-opacity="0.25"/>
            <stop offset="100%" stop-color="#5b8c5a" stop-opacity="0.03"/>
          </linearGradient>
        </defs>
        <polygon fill="url(#trailFill)" points="${terrainPoints}"/>
        <polyline fill="none" stroke="#5b8c5a" stroke-width="2" points="${terrainPoints.split(` ${20 + days.length * dayW},${ground}`)[0]}"/>
        <line x1="16" y1="${ground}" x2="${svgW - 16}" y2="${ground}" stroke="#1c2030" stroke-width="1"/>
        ${prMarkers}
        ${sherpa}
        ${weekLabels}
      </svg>`;

    const streakText = streak > 0 ? `🔥 연속 ${streak}일째 등반 중` : '⛺ 오늘은 쉬는 날';
    const periodText = `최근 4주 · 커밋 ${totalCommits}개 · PR ${prs.length}개`;

    container.innerHTML = `
      <div style="position:relative;">
        ${svg}
        ${tooltip}
      </div>
      <div class="activity-info">
        <div class="activity-streak">${streakText}</div>
        <div class="activity-period">${periodText}</div>
      </div>`;

    // Add PR tooltip hover handlers
    container.querySelectorAll('.pr-marker').forEach(marker => {
      marker.style.cursor = 'pointer';
      marker.addEventListener('mouseenter', (e) => {
        const tip = document.getElementById('activity-tooltip');
        if (!tip) return;
        tip.innerHTML = marker.getAttribute('data-tooltip').split('\n').map(l => escHtml(l)).join('<br>');
        tip.style.display = 'block';
        const rect = marker.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        let left = rect.left - containerRect.left;
        // Prevent overflow on right edge
        const tipWidth = tip.offsetWidth;
        if (left + tipWidth > containerRect.width) {
          left = containerRect.width - tipWidth - 8;
        }
        if (left < 8) left = 8;
        tip.style.left = left + 'px';
        tip.style.top = (rect.top - containerRect.top - 40) + 'px';
      });
      marker.addEventListener('mouseleave', () => {
        const tip = document.getElementById('activity-tooltip');
        if (tip) tip.style.display = 'none';
      });
    });

  } catch {
    if (section) section.style.display = 'none';
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

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
  renderBasecampScene();
  startSherpaQuotes();
  loadActivityTrail();
  connectWs();

}

document.addEventListener('DOMContentLoaded', init);
