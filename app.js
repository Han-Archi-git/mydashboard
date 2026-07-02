// mydashboard — 단일 페이지 대시보드
// 대분류 → 프로젝트 → 단계 → 할일 (4단계)
// 데이터는 GitHub Private Gist에 저장, LocalStorage 캐시

const PAT_KEY = 'mydashboard_pat';
const GIST_KEY = 'mydashboard_gist_id';
const DATA_KEY = 'mydashboard_data';
const POLL_MS = 5000;
const PUSH_DEBOUNCE = 2500; // 노드맵에서 짧은 간격으로 연속 조작할 때 저장 요청이 몰려 GitHub rate limit에 걸리는 것을 줄이기 위해 늘림
const DATA_FILENAME = 'data.json';

const SEED_CATEGORIES = [
  { id: 'visionlab',            name: 'Vision Lab',              color: '#06b6d4' },
  { id: 'personal',             name: 'Personal Tasks',          color: '#6366f1' },
  { id: 'devlab',               name: 'Dev Lab',                 color: '#8b5cf6' },
  { id: 'ilsangmodu_commerce',  name: 'Ilsangmodu_E-Commerce',   color: '#f59e0b' },
  { id: 'ilsangmodu_interior',  name: 'Ilsangmodu_Interior',     color: '#10b981' },
  { id: 'slk',                  name: '(주)SLK종합건축사사무소', color: '#ef4444' },
];

// v1 → v2 마이그레이션: 카테고리 이름 영문화 매핑
const CATEGORY_NAME_V2 = {
  personal:            'Personal Tasks',
  ilsangmodu_interior: 'Ilsangmodu_Interior',
  ilsangmodu_commerce: 'Ilsangmodu_E-Commerce',
  slk:                 '(주)SLK종합건축사사무소',
};
const CATEGORY_ORDER_V2 = ['visionlab', 'personal', 'devlab', 'ilsangmodu_commerce', 'ilsangmodu_interior', 'slk'];

const COLOR_PALETTE = [
  '#6366f1', '#10b981', '#f59e0b', '#ef4444',
  '#06b6d4', '#8b5cf6', '#ec4899', '#84cc16',
  '#f97316', '#14b8a6', '#3b82f6', '#a855f7',
];
function pickNextColor() {
  const used = new Set(state.data.categories.map(c => c.color));
  return COLOR_PALETTE.find(c => !used.has(c)) || COLOR_PALETTE[state.data.categories.length % COLOR_PALETTE.length];
}

const state = {
  data: null,
  syncStatus: 'idle',
  pushPending: false,
  online: navigator.onLine,
  // Transient UI state (re-render 사이에만 유지, Gist 저장 X)
  ui: { phaseOpen: {}, phasePrevDone: {} },  // phaseOpen: 사용자 명시 토글, phasePrevDone: 완료 전이 감지용
};

// ---------- Utility ----------
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
const now = () => new Date().toISOString();
const $ = sel => document.querySelector(sel);
const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtPct = v => `${Math.round(v * 100)}%`;

function toast(msg, ms = 1800) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), ms);
}

// ---------- Auth / Storage ----------
const loadPat    = () => localStorage.getItem(PAT_KEY);
const loadGistId = () => localStorage.getItem(GIST_KEY);
const savePat    = v  => localStorage.setItem(PAT_KEY, v);
const saveGistId = v  => localStorage.setItem(GIST_KEY, v);
const clearAuth  = () => { localStorage.removeItem(PAT_KEY); localStorage.removeItem(GIST_KEY); };

const loadLocal = () => {
  const raw = localStorage.getItem(DATA_KEY);
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
};
const saveLocal = d => localStorage.setItem(DATA_KEY, JSON.stringify(d));

// ---------- Gist Sync ----------
async function fetchGist() {
  const pat = loadPat(), gistId = loadGistId();
  if (!pat || !gistId) return null;
  const res = await fetch(`https://api.github.com/gists/${gistId}`, {
    headers: { Authorization: `token ${pat}`, Accept: 'application/vnd.github+json' }
  });
  if (!res.ok) throw new Error(`Gist 읽기 실패 (${res.status})`);
  const json = await res.json();
  const file = json.files[DATA_FILENAME] || Object.values(json.files)[0];
  if (!file || !file.content) return null;
  try { return JSON.parse(file.content); } catch { return null; }
}

async function fetchGistRevisions() {
  const pat = loadPat(), gistId = loadGistId();
  if (!pat || !gistId) return null;
  const res = await fetch(`https://api.github.com/gists/${gistId}/commits`, {
    headers: { Authorization: `token ${pat}`, Accept: 'application/vnd.github+json' }
  });
  if (!res.ok) throw new Error(`리비전 목록 읽기 실패 (${res.status})`);
  return await res.json();
}

async function fetchGistAtVersion(version) {
  const pat = loadPat(), gistId = loadGistId();
  if (!pat || !gistId) return null;
  const res = await fetch(`https://api.github.com/gists/${gistId}/${version}`, {
    headers: { Authorization: `token ${pat}`, Accept: 'application/vnd.github+json' }
  });
  if (!res.ok) throw new Error(`리비전 읽기 실패 (${res.status})`);
  const json = await res.json();
  const file = json.files[DATA_FILENAME] || Object.values(json.files)[0];
  if (!file || !file.content) return null;
  try { return JSON.parse(file.content); } catch { return null; }
}

let pushRetryTimer = null;
async function pushGist(data) {
  const pat = loadPat(), gistId = loadGistId();
  if (!pat || !gistId) return;
  setSyncStatus('syncing');
  try {
    const res = await fetch(`https://api.github.com/gists/${gistId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `token ${pat}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        files: { [DATA_FILENAME]: { content: JSON.stringify(data, null, 2) } }
      })
    });
    if (!res.ok) {
      const isRateLimit = res.status === 403 || res.status === 429;
      throw Object.assign(new Error(`저장 실패 (${res.status})`), { isRateLimit });
    }
    setSyncStatus('idle');
    clearTimeout(pushRetryTimer);
    updateLastSaved();
  } catch (e) {
    console.error(e);
    setSyncStatus('error');
    if (e.isRateLimit) {
      // 짧은 시간에 저장 요청이 몰려 GitHub가 일시적으로 막은 경우 — 데이터는 로컬에 남아있으니
      // 조용히 잠시 후 자동 재시도(반복 토스트로 방해하지 않음)
      clearTimeout(pushRetryTimer);
      pushRetryTimer = setTimeout(() => pushGist(state.data), 20000);
      toast('저장 요청이 몰려 잠시 지연됩니다 — 곧 자동으로 다시 시도합니다 (데이터는 유지됨)', 3000);
    } else {
      toast('저장 실패 — 인터넷/토큰 확인');
    }
  }
}

let pushTimer = null;
function schedulePush() {
  clearTimeout(pushTimer);
  state.pushPending = true;
  pushTimer = setTimeout(async () => {
    state.pushPending = false;
    await pushGist(state.data);
  }, PUSH_DEBOUNCE);
}

function setSyncStatus(s) {
  state.syncStatus = s;
  const el = $('#sync-status');
  if (!el) return;
  el.classList.remove('idle', 'syncing', 'error', 'offline');
  el.classList.add(state.online ? s : 'offline');
  el.title = !state.online ? '오프라인' :
    s === 'syncing' ? '동기화 중...' :
    s === 'error'   ? '동기화 오류' : '동기화됨';
}

let lastSavedAt = null; // Gist에 마지막으로 실제 저장 성공한 시각
function updateLastSaved() {
  lastSavedAt = new Date();
  const el = $('#last-saved');
  if (el) {
    const hh = String(lastSavedAt.getHours()).padStart(2, '0');
    const mm = String(lastSavedAt.getMinutes()).padStart(2, '0');
    const ss = String(lastSavedAt.getSeconds()).padStart(2, '0');
    el.textContent = `저장 ${hh}:${mm}:${ss}`;
    el.title = lastSavedAt.toLocaleString('ko-KR');
  }
}

// ---------- Data model ----------
function freshData() {
  return {
    version: 2,
    updatedAt: now(),
    notes: [],
    categories: SEED_CATEGORIES.map(c => ({ ...c, projects: [] }))
  };
}

function ensureSeed(d) {
  if (!d || typeof d !== 'object') return freshData();
  if (!Array.isArray(d.categories)) d.categories = [];
  if (!Array.isArray(d.notes)) d.notes = [];
  if (!d.version) d.version = 1;

  // 구 한글 이름 → 영문 자동 변환 (version 무관)
  for (const c of d.categories) {
    if (CATEGORY_NAME_V2[c.id] && c.name !== CATEGORY_NAME_V2[c.id]) {
      c.name = CATEGORY_NAME_V2[c.id];
    }
  }
  // Vision Lab 없으면 맨 앞에 추가
  if (!d.categories.find(c => c.id === 'visionlab')) {
    d.categories.unshift({ id: 'visionlab', name: 'Vision Lab', color: '#06b6d4', projects: [] });
  }
  // Dev Lab 없으면 personal 바로 다음에 추가
  if (!d.categories.find(c => c.id === 'devlab')) {
    const pi = d.categories.findIndex(c => c.id === 'personal');
    d.categories.splice(pi + 1, 0, { id: 'devlab', name: 'Dev Lab', color: '#8b5cf6', projects: [] });
  }

  // 비어 있을 때만 시드. 이후 사용자가 삭제한 분류는 다시 만들지 않음.
  if (d.categories.length === 0) {
    d.categories = SEED_CATEGORIES.map(c => ({ ...c, projects: [] }));
  }
  for (const c of d.categories) {
    c.projects = Array.isArray(c.projects) ? c.projects : [];
    for (const p of c.projects) {
      if (typeof p.color !== 'string') p.color = null; // 노드맵 허브 색상
      if (!Array.isArray(p.links)) p.links = [];       // 노드맵 허브 자유연결
      p.phases = Array.isArray(p.phases) ? p.phases : [];
      for (const ph of p.phases) {
        ph.tasks = Array.isArray(ph.tasks) ? ph.tasks : [];
        // 노드맵용: 좌표 미배정(null)이면 렌더 시 방사형 기준 자동배치
        if (typeof ph.x !== 'number') ph.x = null;
        if (typeof ph.y !== 'number') ph.y = null;
        if (!Array.isArray(ph.links)) ph.links = [];
        if (typeof ph.color !== 'string') ph.color = null;
        if (typeof ph.w !== 'number') ph.w = null; // 노드맵 노드 크기(리사이즈) — null이면 기본 크기
        if (typeof ph.h !== 'number') ph.h = null;
        for (const t of ph.tasks) {
          if (typeof t.x !== 'number') t.x = null;
          if (typeof t.y !== 'number') t.y = null;
          if (!Array.isArray(t.links)) t.links = [];
          if (typeof t.color !== 'string') t.color = null; // 노드맵 색상 — null이면 기본 테마색
          if (typeof t.w !== 'number') t.w = null; // 노드맵 노드 크기(리사이즈)
          if (typeof t.h !== 'number') t.h = null;
        }
      }
    }
  }
  if (!d.updatedAt) d.updatedAt = now();
  return d;
}

const findCategory = id => state.data.categories.find(c => c.id === id);
function findProject(pid) {
  for (const c of state.data.categories) {
    const p = c.projects.find(p => p.id === pid);
    if (p) return { category: c, project: p };
  }
  return null;
}
function findPhase(pid, phid) {
  const f = findProject(pid);
  if (!f) return null;
  const ph = f.project.phases.find(p => p.id === phid);
  return ph ? { ...f, phase: ph } : null;
}

function progressOfTask(t) {
  if (Array.isArray(t.subItems) && t.subItems.length > 0) {
    return t.subItems.filter(s => s.done).length / t.subItems.length;
  }
  return t.done ? 1 : 0;
}
const progressOfPhase    = ph => ph.tasks.length ? ph.tasks.reduce((s, t) => s + progressOfTask(t), 0) / ph.tasks.length : 0;
const progressOfProject  = p  => p.phases.length ? p.phases.reduce((s, ph) => s + progressOfPhase(ph), 0) / p.phases.length : 0;
const progressOfCategory = c  => c.projects.length ? c.projects.reduce((s, p) => s + progressOfProject(p), 0) / c.projects.length : 0;

// ---------- Overview stats helpers ----------
function forEachTask(cb) {
  for (const c of state.data.categories)
    for (const p of c.projects)
      for (const ph of p.phases)
        for (const t of ph.tasks)
          cb(t, ph, p, c);
}
function startOfDay(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function tasksCompletedSince(ts) {
  let n = 0;
  forEachTask(t => { if (t.doneAt && new Date(t.doneAt).getTime() >= ts) n++; });
  return n;
}
function statsCompletedToday() { return tasksCompletedSince(startOfDay(new Date()).getTime()); }
function statsCompletedWeek()  {
  const d = startOfDay(new Date()); d.setDate(d.getDate() - 6);
  return tasksCompletedSince(d.getTime());
}
function relTime(ts) {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  const hr  = Math.floor(diff / 3600000);
  const day = Math.floor(diff / 86400000);
  if (min < 1)  return '방금';
  if (min < 60) return `${min}분 전`;
  if (hr  < 24) return `${hr}시간 전`;
  if (day <  7) return `${day}일 전`;
  return new Date(ts).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
}

function statsRecentManual(limit = 10) {
  const items = [];
  forEachTask((t, ph, p, c) => {
    if (t.manual && t.createdAt && !t.done) {
      items.push({ task: t, phase: ph, project: p, category: c, ts: new Date(t.createdAt).getTime() });
    }
  });
  items.sort((a, b) => b.ts - a.ts);
  return items.slice(0, limit);
}

function statsTop5Projects() {
  const arr = [];
  for (const c of state.data.categories) {
    for (const p of c.projects) {
      const pct = progressOfProject(p);
      if (pct < 1 && p.phases.some(ph => ph.tasks.length)) {
        arr.push({ name: p.name, pct, catColor: c.color });
      }
    }
  }
  return arr.sort((a, b) => b.pct - a.pct).slice(0, 5);
}
function statsLast7Days() {
  const today = startOfDay(new Date());
  const arr = [];
  for (let i = 6; i >= 0; i--) {
    const dayStart = new Date(today); dayStart.setDate(today.getDate() - i);
    const dayEnd   = new Date(dayStart); dayEnd.setDate(dayStart.getDate() + 1);
    let n = 0;
    forEachTask(t => {
      if (!t.doneAt) return;
      const tt = new Date(t.doneAt).getTime();
      if (tt >= dayStart.getTime() && tt < dayEnd.getTime()) n++;
    });
    arr.push({ date: dayStart, count: n, isToday: i === 0 });
  }
  return arr;
}
function statsDueSoon() {
  // 마감일 있고 미완료, 오늘 기준 +7일 이내 또는 이미 지난 것
  const now = Date.now();
  const limit = now + 7 * 24 * 60 * 60 * 1000;
  const out = [];
  forEachTask((t, ph, p, c) => {
    if (!t.due || t.done) return;
    const dueT = new Date(t.due).getTime();
    if (dueT > limit) return;
    out.push({ task: t, phase: ph, project: p, category: c, dueT });
  });
  return out.sort((a, b) => a.dueT - b.dueT).slice(0, 10);
}

// ---------- SVG donut helper ----------
function renderDonut(pct, color, size = 92) {
  const stroke = 10;
  const r = (size - stroke) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const c = 2 * Math.PI * r;
  const dash = Math.max(0, Math.min(1, pct)) * c;
  return `
    <svg viewBox="0 0 ${size} ${size}" role="img" aria-label="${Math.round(pct * 100)}%">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(56,189,248,0.10)" stroke-width="${stroke}"/>
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}"
              stroke-dasharray="${dash} ${c}" stroke-linecap="round"
              transform="rotate(-90 ${cx} ${cy})"
              style="filter:drop-shadow(0 0 4px ${color})"/>
    </svg>`;
}

function renderOverview() {
  const today  = statsCompletedToday();
  const week   = statsCompletedWeek();
  const top5   = statsTop5Projects();
  const last7  = statsLast7Days();
  const due    = statsDueSoon();
  const recent = statsRecentManual(10);
  const cats  = state.data.categories;

  // top5
  const topHtml = top5.length ? top5.map(p => `
    <div class="top-project-row">
      <span class="tp-name">${escapeHtml(p.name)}</span>
      <span class="tp-bar"><span style="width:${p.pct * 100}%"></span></span>
      <span class="tp-pct">${fmtPct(p.pct)}</span>
    </div>
  `).join('') : `<div class="empty-mini">진행 중인 프로젝트 없음</div>`;

  // donuts (per-category)
  const donutsHtml = cats.length ? cats.map(c => {
    const pct = progressOfCategory(c);
    return `
      <div class="donut-cell">
        <div class="dn-wrap">
          ${renderDonut(pct, c.color, 92)}
          <span class="dn-pct">${Math.round(pct * 100)}%</span>
        </div>
        <span class="dn-label">${escapeHtml(c.name)}</span>
      </div>`;
  }).join('') : '';

  // bar chart
  const maxBar = Math.max(1, ...last7.map(d => d.count));
  const barsHtml = last7.map(d => {
    const h = d.count === 0 ? 2 : Math.max(4, (d.count / maxBar) * 100);
    const label = d.date.toLocaleDateString('ko-KR', { weekday: 'short' });
    return `
      <div class="bar-col${d.isToday ? ' today' : ''}">
        <span class="bar-val">${d.count}</span>
        <span class="bar-bg" style="height:${h}%"></span>
        <span class="bar-day">${label}</span>
      </div>`;
  }).join('');

  // due-soon list
  const dueHtml = due.length ? due.map(d => {
    const dueDate = new Date(d.dueT);
    const diff = Math.floor((d.dueT - Date.now()) / (1000 * 60 * 60 * 24));
    const isLate = diff < 0;
    const pill = isLate ? `${-diff}일 지남` : diff === 0 ? '오늘' : `D-${diff}`;
    return `
      <a href="#/p/${encodeURIComponent(d.project.id)}" class="duesoon-item${isLate ? ' late' : ''}">
        <span class="ds-pill">${pill}</span>
        <span class="ds-title">${escapeHtml(d.task.title)}</span>
        <span class="ds-meta">${escapeHtml(d.project.name)}</span>
      </a>`;
  }).join('') : `<div class="duesoon-empty">마감 임박 task 없음 ✓</div>`;

  return `
    <section class="overview">
      <div class="ov-card ov-today">
        <h3>오늘 완료</h3>
        <div class="stat-num">${today}</div>
        <div class="stat-sub">건 (today)</div>
      </div>
      <div class="ov-card ov-week">
        <h3>최근 7일</h3>
        <div class="stat-num">${week}</div>
        <div class="stat-sub">건 (last 7d)</div>
      </div>
      <div class="ov-card ov-top">
        <h3>진척도 TOP 5</h3>
        <div class="top-projects">${topHtml}</div>
      </div>
      <div class="ov-card ov-donuts">
        <h3>분류별 진척도</h3>
        <div class="donut-grid">${donutsHtml}</div>
      </div>
      <div class="ov-card ov-bar">
        <h3>일별 완료 추이</h3>
        <div class="bar-chart">${barsHtml}</div>
      </div>
      <div class="ov-card ov-duesoon">
        <h3>마감 임박 (7일 이내)</h3>
        <div class="duesoon-list">${dueHtml}</div>
      </div>
      <div class="ov-card ov-recent">
        <h3>최근 추가</h3>
        <div class="recent-list">${recent.length ? recent.map(item => `
          <a href="#/p/${encodeURIComponent(item.project.id)}" class="recent-item">
            <span class="ri-when">${relTime(item.ts)}</span>
            <span class="ri-title">${escapeHtml(item.task.title)}</span>
            <span class="ri-meta">${escapeHtml(item.category.name)} · ${escapeHtml(item.project.name)}</span>
          </a>`).join('') : `<div class="duesoon-empty">직접 추가한 할일 없음</div>`}
        </div>
      </div>
    </section>
  `;
}

function activePhaseIdx(project) {
  // 첫 미완료 단계 인덱스. 모두 완료면 -1.
  for (let i = 0; i < project.phases.length; i++) {
    if (progressOfPhase(project.phases[i]) < 1) return i;
  }
  return -1;
}

// ---------- 실행취소/다시실행 (전체 앱 공용) ----------
let historyStack = [];   // JSON 스냅샷 목록, 오래된 것→최신 순
let historyIndex = -1;   // historyStack 중 현재 위치
const HISTORY_LIMIT = 50;

function historyPush() {
  const snap = JSON.stringify(state.data);
  historyStack = historyStack.slice(0, historyIndex + 1);
  historyStack.push(snap);
  if (historyStack.length > HISTORY_LIMIT) historyStack.shift();
  historyIndex = historyStack.length - 1;
}

function historyRestore(idx) {
  if (idx < 0 || idx >= historyStack.length) return;
  historyIndex = idx;
  state.data = JSON.parse(historyStack[idx]);
  saveLocal(state.data);
  schedulePush();
  render();
}

function historyUndo() { if (historyIndex > 0) historyRestore(historyIndex - 1); }
function historyRedo() { if (historyIndex < historyStack.length - 1) historyRestore(historyIndex + 1); }

document.addEventListener('keydown', e => {
  const tag = (document.activeElement && document.activeElement.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA') return; // 텍스트 입력 중엔 브라우저 기본 동작(실행취소 포함)에 맡김
  if (e.ctrlKey || e.metaKey) {
    if (e.key === 'z' || e.key === 'Z') {
      e.preventDefault();
      if (e.shiftKey) historyRedo(); else historyUndo();
    } else if (e.key === 'y' || e.key === 'Y') {
      e.preventDefault();
      historyRedo();
    }
    return;
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && nodemapSelected.size > 0) {
    e.preventDefault();
    nodemapDeleteSelected();
  }
});

function nodemapDeleteSelected() {
  const ids = [...nodemapSelected];
  if (!ids.length) return;
  if (!confirm(`선택한 노드 ${ids.length}개를 삭제할까요?`)) return;
  ids.forEach(id => {
    let removed = false;
    for (const c of state.data.categories)
      for (const p of c.projects) {
        const phIdx = p.phases.findIndex(ph => ph.id === id);
        if (phIdx !== -1) { p.phases.splice(phIdx, 1); removed = true; }
      }
    if (!removed) {
      for (const c of state.data.categories)
        for (const p of c.projects)
          for (const ph of p.phases) {
            const tIdx = ph.tasks.findIndex(t => t.id === id);
            if (tIdx !== -1) { ph.tasks.splice(tIdx, 1); removed = true; }
          }
    }
  });
  nodemapSelected.clear();
  commit();
}

// ---------- 노드맵 복사/붙여넣기 ----------
let nodemapClipboard = null; // [{ kind:'task'|'phase', data, srcPhaseId? }, ...]

function nodemapCopySelected() {
  if (nodemapSelected.size === 0) return;
  const items = [];
  nodemapSelected.forEach(id => {
    outer: for (const c of state.data.categories)
      for (const p of c.projects) {
        const ph = p.phases.find(ph => ph.id === id);
        if (ph) { items.push({ kind: 'phase', data: JSON.parse(JSON.stringify(ph)) }); break outer; }
        for (const phx of p.phases) {
          const t = phx.tasks.find(t => t.id === id);
          if (t) { items.push({ kind: 'task', data: JSON.parse(JSON.stringify(t)), srcPhaseId: phx.id }); break outer; }
        }
      }
  });
  if (!items.length) return;
  nodemapClipboard = items;
  toast(`${items.length}개 복사됨`);
}

function nodemapPasteClipboard(pid) {
  if (!nodemapClipboard || !nodemapClipboard.length) return;
  const f = findProject(pid);
  if (!f) return;
  const OFFSET = 40;
  let count = 0;
  nodemapClipboard.forEach(item => {
    if (item.kind === 'task') {
      const t = JSON.parse(JSON.stringify(item.data));
      t.id = uid();
      t.links = [];
      if (typeof t.x === 'number') t.x += OFFSET;
      if (typeof t.y === 'number') t.y += OFFSET;
      // 원래 있던 단계가 이 프로젝트에 그대로 있으면 거기로, 없으면 "메모" 단계로
      const targetPh = f.project.phases.find(ph => ph.id === item.srcPhaseId) || ensureMemoPhase(pid);
      targetPh.tasks.push(t);
      count++;
    } else {
      const ph = JSON.parse(JSON.stringify(item.data));
      ph.id = uid();
      ph.links = [];
      if (typeof ph.x === 'number') ph.x += OFFSET;
      if (typeof ph.y === 'number') ph.y += OFFSET;
      ph.tasks = (ph.tasks || []).map(t => {
        const nt = JSON.parse(JSON.stringify(t));
        nt.id = uid();
        nt.links = [];
        return nt;
      });
      f.project.phases.push(ph);
      count++;
    }
  });
  commit();
  toast(`${count}개 붙여넣기 완료`);
}

function commit() {
  state.data.updatedAt = now();
  saveLocal(state.data);
  schedulePush();
  historyPush();
  render();
}

// ---------- Mutations ----------
function addCategory(name) {
  const id = 'cat_' + uid();
  state.data.categories.push({ id, name, color: pickNextColor(), projects: [] });
  commit();
}
function renameCategory(cid, name) {
  const c = findCategory(cid); if (!c) return;
  c.name = name; commit();
}
function deleteCategory(cid) {
  const i = state.data.categories.findIndex(c => c.id === cid);
  if (i !== -1) { state.data.categories.splice(i, 1); commit(); }
}
function moveCategory(cid, dir) {
  const arr = state.data.categories;
  const i = arr.findIndex(c => c.id === cid);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  commit();
}
function recolorCategory(cid, color) {
  const c = findCategory(cid); if (!c) return;
  c.color = color; commit();
}

function addProject(catId, name) {
  const c = findCategory(catId);
  if (!c) return;
  c.projects.push({ id: uid(), name, createdAt: now(), phases: [] });
  commit();
}
function renameProject(pid, name) {
  const f = findProject(pid); if (!f) return;
  f.project.name = name; commit();
}
function deleteProject(pid) {
  for (const c of state.data.categories) {
    const i = c.projects.findIndex(p => p.id === pid);
    if (i !== -1) { c.projects.splice(i, 1); commit(); return; }
  }
}
function addPhase(pid, name) {
  const f = findProject(pid); if (!f) return;
  f.project.phases.push({ id: uid(), name, tasks: [] });
  commit();
}
function renamePhase(pid, phid, name) {
  const f = findPhase(pid, phid); if (!f) return;
  f.phase.name = name; commit();
}
function deletePhase(pid, phid) {
  const f = findProject(pid); if (!f) return;
  const i = f.project.phases.findIndex(p => p.id === phid);
  if (i !== -1) { f.project.phases.splice(i, 1); commit(); }
}
function movePhase(pid, phid, dir) {
  const f = findProject(pid); if (!f) return;
  const arr = f.project.phases;
  const i = arr.findIndex(p => p.id === phid);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  commit();
}
function addTask(pid, phid, title) {
  const f = findPhase(pid, phid); if (!f) return;
  f.phase.tasks.push({ id: uid(), title, done: false, memo: '', due: null, createdAt: now(), manual: true });
  commit();
}
function toggleTask(tid) {
  for (const c of state.data.categories)
    for (const p of c.projects)
      for (const ph of p.phases) {
        const t = ph.tasks.find(t => t.id === tid);
        if (t) {
          if (Array.isArray(t.subItems) && t.subItems.length > 0) {
            const allDone = t.subItems.every(s => s.done);
            t.subItems.forEach(s => { s.done = !allDone; });
          } else {
            t.done = !t.done;
            t.doneAt = t.done ? now() : null;
          }
          commit(); return;
        }
      }
}
function updateTask(tid, patch) {
  for (const c of state.data.categories)
    for (const p of c.projects)
      for (const ph of p.phases) {
        const t = ph.tasks.find(t => t.id === tid);
        if (t) { Object.assign(t, patch); commit(); return; }
      }
}
function deleteTask(tid) {
  for (const c of state.data.categories)
    for (const p of c.projects)
      for (const ph of p.phases) {
        const i = ph.tasks.findIndex(t => t.id === tid);
        if (i !== -1) { ph.tasks.splice(i, 1); commit(); return; }
      }
}

// ---------- Sub-items (서류 체크리스트) ----------
function findTask(tid) {
  for (const c of state.data.categories)
    for (const p of c.projects)
      for (const ph of p.phases) {
        const t = ph.tasks.find(t => t.id === tid);
        if (t) return t;
      }
  return null;
}
function addSubItem(tid, text) {
  const t = findTask(tid); if (!t) return;
  if (!Array.isArray(t.subItems)) t.subItems = [];
  t.subItems.push({ id: uid(), text, done: false });
  commit();
}
function toggleSubItem(tid, sid) {
  const t = findTask(tid); if (!t) return;
  const s = (t.subItems || []).find(x => x.id === sid);
  if (s) { s.done = !s.done; commit(); }
}
function deleteSubItem(tid, sid) {
  const t = findTask(tid); if (!t) return;
  if (!Array.isArray(t.subItems)) return;
  const i = t.subItems.findIndex(x => x.id === sid);
  if (i !== -1) { t.subItems.splice(i, 1); commit(); }
}
function updateSubItem(tid, sid, text) {
  const t = findTask(tid); if (!t) return;
  const s = (t.subItems || []).find(x => x.id === sid);
  if (s) { s.text = text; commit(); }
}
function moveSubItem(tid, sid, dir) {
  const t = findTask(tid); if (!t || !Array.isArray(t.subItems)) return;
  const arr = t.subItems;
  const i = arr.findIndex(x => x.id === sid);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  commit();
}

// ---------- Sticky notes ----------
const NOTE_COLORS = ['#fef08a', '#bbf7d0', '#bae6fd', '#fbcfe8', '#fed7aa', '#e9d5ff'];
function addNote(text) {
  if (!Array.isArray(state.data.notes)) state.data.notes = [];
  const color = NOTE_COLORS[state.data.notes.length % NOTE_COLORS.length];
  state.data.notes.unshift({ id: uid(), text, color, createdAt: now() });
  commit();
}
function updateNote(nid, text) {
  const n = state.data.notes.find(n => n.id === nid);
  if (n) { n.text = text; commit(); }
}
function deleteNote(nid) {
  const i = state.data.notes.findIndex(n => n.id === nid);
  if (i !== -1) { state.data.notes.splice(i, 1); commit(); }
}
function recolorNote(nid) {
  const n = state.data.notes.find(n => n.id === nid);
  if (!n) return;
  const idx = NOTE_COLORS.indexOf(n.color);
  n.color = NOTE_COLORS[(idx + 1) % NOTE_COLORS.length];
  commit();
}
function moveTask(tid, dir) {
  for (const c of state.data.categories)
    for (const p of c.projects)
      for (const ph of p.phases) {
        const i = ph.tasks.findIndex(t => t.id === tid);
        if (i === -1) continue;
        const j = i + dir;
        if (j < 0 || j >= ph.tasks.length) return;
        [ph.tasks[i], ph.tasks[j]] = [ph.tasks[j], ph.tasks[i]];
        commit(); return;
      }
}

// ---------- Drag & Drop reorder ----------
// 순서 이동만 수행한다. 출발/도착 중 하나라도 못 찾으면 데이터를 건드리지 않는다.
function findPhaseById(phid) {
  for (const c of state.data.categories)
    for (const p of c.projects) {
      const ph = p.phases.find(x => x.id === phid);
      if (ph) return ph;
    }
  return null;
}
// 할일: 같은 단계 재정렬 + 다른 단계로 이동. beforeTid 앞에 삽입(없으면 끝).
function dndMoveTask(srcTid, destPhid, beforeTid) {
  if (srcTid === beforeTid) return;
  const dest = findPhaseById(destPhid);
  if (!dest) return;
  let srcPhase = null, srcIdx = -1;
  for (const c of state.data.categories)
    for (const p of c.projects)
      for (const ph of p.phases) {
        const i = ph.tasks.findIndex(t => t.id === srcTid);
        if (i !== -1) { srcPhase = ph; srcIdx = i; }
      }
  if (!srcPhase) return;
  const [task] = srcPhase.tasks.splice(srcIdx, 1);
  let pos = beforeTid ? dest.tasks.findIndex(t => t.id === beforeTid) : dest.tasks.length;
  if (pos < 0) pos = dest.tasks.length;
  dest.tasks.splice(pos, 0, task);
  commit();
}
// 세부항목: 같은 할일 내에서만 재정렬.
function dndMoveSub(taskId, srcSid, beforeSid) {
  if (srcSid === beforeSid) return;
  const t = findTask(taskId);
  if (!t || !Array.isArray(t.subItems)) return;
  const i = t.subItems.findIndex(s => s.id === srcSid);
  if (i < 0) return;
  const [s] = t.subItems.splice(i, 1);
  let pos = beforeSid ? t.subItems.findIndex(x => x.id === beforeSid) : t.subItems.length;
  if (pos < 0) pos = t.subItems.length;
  t.subItems.splice(pos, 0, s);
  commit();
}
// 단계: 같은 프로젝트 내에서 재정렬.
function dndMovePhase(pid, srcPhid, beforePhid) {
  if (srcPhid === beforePhid) return;
  const f = findProject(pid);
  if (!f) return;
  const arr = f.project.phases;
  const i = arr.findIndex(p => p.id === srcPhid);
  if (i < 0) return;
  const [ph] = arr.splice(i, 1);
  let pos = beforePhid ? arr.findIndex(p => p.id === beforePhid) : arr.length;
  if (pos < 0) pos = arr.length;
  arr.splice(pos, 0, ph);
  commit();
}

let dragState = null;
function dndCleanup() {
  document.querySelectorAll('.dragging, .drag-over-top, .drag-over-bottom')
    .forEach(el => el.classList.remove('dragging', 'drag-over-top', 'drag-over-bottom'));
  dragState = null;
}
function dndIsAfter(el, clientY) {
  const r = el.getBoundingClientRect();
  return clientY > r.top + r.height / 2;
}
document.addEventListener('dragstart', e => {
  // 입력/버튼에서 시작한 드래그는 무시(클릭·편집 보호)
  if (e.target.closest('input, textarea, button, a')) { e.preventDefault(); return; }
  const subLi = e.target.closest('li.sub-item');
  const taskLi = e.target.closest('li.task');
  const phHead = e.target.closest('.phase-head');
  if (subLi) {
    const owner = subLi.closest('li.task');
    dragState = { kind: 'sub', id: subLi.dataset.subId, taskId: owner && owner.dataset.taskId };
    subLi.classList.add('dragging');
  } else if (taskLi) {
    dragState = { kind: 'task', id: taskLi.dataset.taskId };
    taskLi.classList.add('dragging');
  } else if (phHead) {
    const sec = phHead.closest('.phase');
    dragState = { kind: 'phase', id: sec.dataset.phaseId, projectId: sec.dataset.projectId };
    sec.classList.add('dragging');
  } else { return; }
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', dragState.id); } catch (_) {}
});
document.addEventListener('dragover', e => {
  if (!dragState) return;
  let over = null;
  if (dragState.kind === 'task') over = e.target.closest('li.task');
  else if (dragState.kind === 'sub') over = e.target.closest('li.sub-item');
  else if (dragState.kind === 'phase') over = e.target.closest('.phase');
  // 적절한 드롭 영역(목록/섹션) 위라면 항상 드롭 허용
  const inZone = over || (dragState.kind === 'task' && e.target.closest('ul.task-list'))
    || (dragState.kind === 'sub' && e.target.closest('ul.sub-list'));
  if (!inZone) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.drag-over-top, .drag-over-bottom')
    .forEach(el => el.classList.remove('drag-over-top', 'drag-over-bottom'));
  if (over && !over.classList.contains('dragging')) {
    over.classList.add(dndIsAfter(over, e.clientY) ? 'drag-over-bottom' : 'drag-over-top');
  }
});
document.addEventListener('drop', e => {
  if (!dragState) { return; }
  e.preventDefault();
  const st = dragState;
  if (st.kind === 'task') {
    const overLi = e.target.closest('li.task');
    const phase = (overLi && overLi.closest('.phase')) || e.target.closest('.phase');
    if (phase) {
      let beforeId = null;
      if (overLi && overLi.dataset.taskId !== st.id) {
        beforeId = dndIsAfter(overLi, e.clientY)
          ? (overLi.nextElementSibling && overLi.nextElementSibling.dataset.taskId) || null
          : overLi.dataset.taskId;
      }
      dndMoveTask(st.id, phase.dataset.phaseId, beforeId);
    }
  } else if (st.kind === 'sub') {
    const overLi = e.target.closest('li.sub-item');
    const taskLi = (overLi && overLi.closest('li.task')) || e.target.closest('li.task');
    if (taskLi && taskLi.dataset.taskId === st.taskId) {
      let beforeId = null;
      if (overLi && overLi.dataset.subId !== st.id) {
        beforeId = dndIsAfter(overLi, e.clientY)
          ? (overLi.nextElementSibling && overLi.nextElementSibling.dataset.subId) || null
          : overLi.dataset.subId;
      }
      dndMoveSub(st.taskId, st.id, beforeId);
    }
  } else if (st.kind === 'phase') {
    const overSec = e.target.closest('.phase');
    if (overSec && overSec.dataset.projectId) {
      let beforeId = null;
      if (overSec.dataset.phaseId !== st.id) {
        const sib = overSec.nextElementSibling;
        beforeId = dndIsAfter(overSec, e.clientY)
          ? (sib && sib.classList.contains('phase') ? sib.dataset.phaseId : null)
          : overSec.dataset.phaseId;
      }
      dndMovePhase(overSec.dataset.projectId, st.id, beforeId);
    }
  }
  dndCleanup();
});
document.addEventListener('dragend', dndCleanup);

// ---------- Routing ----------
function currentRoute() {
  const hash = location.hash.slice(1) || '/';
  const parts = hash.split('/').filter(Boolean);
  if (!parts.length) return { name: 'home' };
  if (parts[0] === 'c' && parts[1]) return { name: 'category', id: decodeURIComponent(parts[1]) };
  if (parts[0] === 'p' && parts[1]) return { name: 'project',  id: decodeURIComponent(parts[1]), view: parts[2] === 'map' ? 'map' : 'list' };
  return { name: 'home' };
}
const navigate = h => { location.hash = h; };

// ---------- Render ----------
function render() {
  const root = $('#app');
  const r = currentRoute();
  if (r.name === 'home')      root.innerHTML = renderHome();
  else if (r.name === 'category') root.innerHTML = renderCategory(r.id);
  else if (r.name === 'project')  {
    if (r.view === 'map') { root.innerHTML = renderProjectMap(r.id); mountNodeCanvas(r.id); }
    else root.innerHTML = renderProject(r.id);
  }
  root.classList.toggle('app-fullbleed', r.name === 'project' && r.view === 'map');
  renderCrumbs(r);
  setSyncStatus(state.syncStatus);
}

function renderCrumbs(r) {
  const el = $('#crumbs');
  if (!el) return;
  if (r.name === 'home') { el.innerHTML = ''; return; }
  if (r.name === 'category') {
    const c = findCategory(r.id);
    el.innerHTML = c ? `<a href="#/">홈</a><span class="sep">›</span>${escapeHtml(c.name)}` : '';
  } else if (r.name === 'project') {
    const f = findProject(r.id);
    if (!f) { el.innerHTML = `<a href="#/">홈</a>`; return; }
    el.innerHTML = `<a href="#/">홈</a><span class="sep">›</span><a href="#/c/${encodeURIComponent(f.category.id)}">${escapeHtml(f.category.name)}</a><span class="sep">›</span>${escapeHtml(f.project.name)}`;
  }
}

function renderNotesSection() {
  const notes = (state.data.notes || []).map(n => `
    <div class="note-card" style="background:${n.color}" data-note-id="${escapeHtml(n.id)}">
      <div class="note-text" data-action="edit-note" data-note-id="${escapeHtml(n.id)}" title="클릭해서 편집">${escapeHtml(n.text)}</div>
      <div class="note-actions">
        <button class="note-btn" data-action="recolor-note" data-note-id="${escapeHtml(n.id)}" title="색상">●</button>
        <button class="note-btn" data-action="delete-note" data-note-id="${escapeHtml(n.id)}" title="삭제">×</button>
      </div>
    </div>`).join('');
  return `
    <section class="notes-section">
      <form class="add-row note-add" data-action="add-note">
        <input class="add-input" name="text" placeholder="📝 오늘 할일·메모 (엔터로 추가)" autocomplete="off" required>
        <button class="btn ghost" type="submit">메모</button>
      </form>
      <div class="notes-grid">${notes}</div>
    </section>
  `;
}

function renderHome() {
  const notesSection = renderNotesSection();
  const sections = state.data.categories.map(c => {
    const projects = c.projects.map(p => {
      const pct = progressOfProject(p);
      const totalTasks = p.phases.reduce((s, ph) => s + ph.tasks.length, 0);
      const doneTasks  = p.phases.reduce((s, ph) => s + ph.tasks.filter(t => t.done).length, 0);
      const activeIdx  = activePhaseIdx(p);
      const activeName = activeIdx >= 0 ? p.phases[activeIdx].name : (p.phases.length ? '완료' : '');
      return `
        <a href="#/p/${encodeURIComponent(p.id)}" class="project-row">
          <div class="project-row-main">
            <span class="project-row-name">${escapeHtml(p.name)}</span>
            ${activeName ? `<span class="project-row-phase">${escapeHtml(activeName)}</span>` : ''}
          </div>
          <div class="project-row-bar"><span class="progress-fill" style="width:${pct * 100}%;background:${c.color}"></span></div>
          <div class="project-row-stat">
            <span class="pct">${fmtPct(pct)}</span>
            <span class="count">${doneTasks}/${totalTasks}</span>
          </div>
        </a>`;
    }).join('') || `<div class="empty-mini">아직 프로젝트가 없습니다</div>`;

    return `
      <section class="home-cat">
        <header class="home-cat-head">
          <a href="#/c/${encodeURIComponent(c.id)}" class="home-cat-title">
            <span class="cat-dot" style="background:${c.color}"></span>
            ${escapeHtml(c.name)}
          </a>
          <span class="home-cat-meta">${c.projects.length}개 · ${fmtPct(progressOfCategory(c))}</span>
          <span class="home-cat-actions">
            <button class="row-btn" data-action="move-cat-up"   data-cat-id="${escapeHtml(c.id)}" title="위로">▲</button>
            <button class="row-btn" data-action="move-cat-down" data-cat-id="${escapeHtml(c.id)}" title="아래로">▼</button>
            <button class="row-btn" data-action="recolor-cat"   data-cat-id="${escapeHtml(c.id)}" title="색상">색</button>
            <button class="row-btn" data-action="rename-cat"    data-cat-id="${escapeHtml(c.id)}" title="이름변경">이름</button>
            <button class="row-btn danger" data-action="delete-cat" data-cat-id="${escapeHtml(c.id)}" title="삭제">삭제</button>
          </span>
        </header>
        <div class="project-list">${projects}</div>
        <form class="add-row mini" data-action="add-project" data-cat-id="${escapeHtml(c.id)}">
          <input class="add-input" name="name" placeholder="+ 새 프로젝트 (엔터)" autocomplete="off" required>
          <button class="btn ghost" type="submit">추가</button>
        </form>
      </section>`;
  }).join('');

  const overview = renderOverview();

  return `
    ${overview}
    <div class="section-head"><h1>대시보드</h1></div>
    ${notesSection}
    ${sections}
    <section class="home-cat add-cat-section">
      <form class="add-row" data-action="add-category">
        <input class="add-input" name="name" placeholder="+ 새 대분류 (예: 세무, 외주, 학습 등)" autocomplete="off" required>
        <button class="btn" type="submit">대분류 추가</button>
      </form>
    </section>
  `;
}

function renderCategory(id) {
  const c = findCategory(id);
  if (!c) return `<div class="empty"><h3>분류 없음</h3><p><a href="#/">홈으로</a></p></div>`;
  const items = c.projects.map(p => {
    const pct = progressOfProject(p);
    return `
      <a href="#/p/${encodeURIComponent(p.id)}" class="project-item">
        <span class="name">${escapeHtml(p.name)}</span>
        <span class="progress"><span class="progress-fill" style="width:${pct * 100}%;background:${c.color}"></span></span>
        <span class="pct">${fmtPct(pct)}</span>
      </a>`;
  }).join('') || `<div class="empty"><p>아직 프로젝트가 없습니다.</p></div>`;
  return `
    <div class="section-head">
      <h2><span class="cat-dot" style="background:${c.color};display:inline-block;margin-right:8px"></span>${escapeHtml(c.name)}</h2>
    </div>
    <div class="project-list">${items}</div>
    <form class="add-row" data-action="add-project" data-cat-id="${escapeHtml(c.id)}" style="margin-top:16px">
      <input class="add-input" name="name" placeholder="새 프로젝트 이름 입력 후 엔터" autocomplete="off" required>
      <button class="btn" type="submit">추가</button>
    </form>
  `;
}

function renderProject(pid) {
  const f = findProject(pid);
  if (!f) return `<div class="empty"><h3>프로젝트 없음</h3><p><a href="#/">홈으로</a></p></div>`;
  const { category: c, project: p } = f;
  const pct = progressOfProject(p);
  const activeIdx = activePhaseIdx(p);
  const phases = p.phases.map((ph, idx) => {
    const phPct = progressOfPhase(ph);
    const isActive = idx === activeIdx;
    const isDone = phPct >= 1 && ph.tasks.length > 0;
    // Phase open 규칙:
    // - 완료된 phase: 기본 닫힘 (사용자가 다시 열면 유지)
    // - 미완료 phase: 기본 열림 (사용자가 닫으면 유지)
    // - 미완료→완료 전이 시점에만 명시적 토글 리셋해서 자동 닫힘 적용
    const prevDone = !!state.ui.phasePrevDone[ph.id];
    if (!prevDone && isDone) delete state.ui.phaseOpen[ph.id];
    state.ui.phasePrevDone[ph.id] = isDone;
    const explicit = state.ui.phaseOpen[ph.id];
    const isOpen = explicit !== undefined ? explicit : !isDone;
    const tasks = ph.tasks.map(t => renderTask(t, p.id, ph.id)).join('');
    return `
      <section class="phase ${isActive ? 'active' : ''} ${isOpen ? 'open' : ''}" data-phase-id="${escapeHtml(ph.id)}" data-project-id="${escapeHtml(p.id)}">
        <header class="phase-head" data-action="toggle-phase" draggable="true" title="드래그해서 단계 순서 변경">
          <span class="phase-caret">▶</span>
          <span class="phase-name ${isDone ? 'done' : ''}">${escapeHtml(ph.name)}</span>
          <span class="phase-meta">${ph.tasks.filter(t => t.done).length}/${ph.tasks.length} · ${fmtPct(phPct)}</span>
          <button class="row-btn" data-action="move-phase-up"    data-project-id="${escapeHtml(p.id)}" data-phase-id="${escapeHtml(ph.id)}" title="위로">▲</button>
          <button class="row-btn" data-action="move-phase-down"  data-project-id="${escapeHtml(p.id)}" data-phase-id="${escapeHtml(ph.id)}" title="아래로">▼</button>
          <button class="row-btn" data-action="rename-phase"     data-project-id="${escapeHtml(p.id)}" data-phase-id="${escapeHtml(ph.id)}" title="이름변경">이름</button>
          <button class="row-btn danger" data-action="delete-phase" data-project-id="${escapeHtml(p.id)}" data-phase-id="${escapeHtml(ph.id)}" title="삭제">삭제</button>
        </header>
        <div class="phase-body">
          <ul class="task-list">${tasks}</ul>
          <form class="add-row" data-action="add-task" data-project-id="${escapeHtml(p.id)}" data-phase-id="${escapeHtml(ph.id)}">
            <input class="add-input" name="title" placeholder="새 할일 (엔터로 추가)" autocomplete="off" required>
            <button class="btn ghost" type="submit">추가</button>
          </form>
        </div>
      </section>`;
  }).join('') || `<div class="empty"><p>단계를 추가해 시작하세요.</p></div>`;

  return `
    <div class="section-head">
      <div>
        <h2>${escapeHtml(p.name)}</h2>
        <div class="section-sub"><a href="#/c/${encodeURIComponent(c.id)}">${escapeHtml(c.name)}</a> · 전체 ${fmtPct(pct)}</div>
      </div>
      <div style="display:flex;gap:6px">
        <div class="view-toggle">
          <a href="#/p/${encodeURIComponent(p.id)}" class="view-toggle-btn active">리스트</a>
          <a href="#/p/${encodeURIComponent(p.id)}/map" class="view-toggle-btn">노드맵</a>
        </div>
        <button class="btn ghost" data-action="rename-project" data-project-id="${escapeHtml(p.id)}">이름변경</button>
        <button class="btn ghost" data-action="delete-project" data-project-id="${escapeHtml(p.id)}">삭제</button>
      </div>
    </div>
    <div class="progress" style="margin-bottom:18px"><div class="progress-fill" style="width:${pct * 100}%;background:${c.color}"></div></div>

    ${phases}

    <form class="add-row" data-action="add-phase" data-project-id="${escapeHtml(p.id)}" style="margin-top:16px">
      <input class="add-input" name="name" placeholder="새 단계 이름 (예: 기획, 설계, 시공)" autocomplete="off" required>
      <button class="btn" type="submit">단계 추가</button>
    </form>
  `;
}

// ---------- 노드맵 (프로젝트 단위, 마인드맵식 허브앤스포크) ----------
// 구조: 중심(project) → 1차 링(phase) → 2차 링(phase 섹터 안에서 부채꼴로 퍼지는 task)
const NODEMAP_PHASE_RADIUS = 170;   // 중심→phase 거리
const NODEMAP_RING_STEP = 100;      // phase→task, 링이 늘어날 때마다 반지름 증가폭
const NODEMAP_TASKS_PER_RING = 5;   // 한 링에 들어가는 task 수(넘으면 다음 링으로)
const NODEMAP_MARGIN = 140;         // 캔버스 여백(노드 크기 감안)
const NODEMAP_MIN_CANVAS = 20000;   // 캔버스 최소 크기 — 사실상 무한하게 느껴질 만큼 넉넉하게(크기 자체는 성능비용 거의 없음)

// 노드 텍스트를 마크다운으로 렌더 (marked.js + DOMPurify, index.html에서 CDN 로드)
// marked는 결과 HTML을 새니타이징하지 않으므로 반드시 DOMPurify를 거쳐야 XSS를 막을 수 있음.
function nodemapRenderText(text) {
  const t = text || '';
  if (window.marked && window.DOMPurify) {
    try { return DOMPurify.sanitize(marked.parse(t)); } catch { /* fall through */ }
  }
  return escapeHtml(t);
}

// 좌표 미배정 phase/task에 방사형 기본좌표를 부여 (state는 건드리지 않음, 렌더용 계산만)
function nodemapLayout(project) {
  const phasePos = {};  // phaseId -> {x,y,angle}
  const taskPos = {};   // taskId  -> {x,y}
  const n = project.phases.length;
  let maxRadius = NODEMAP_PHASE_RADIUS;

  project.phases.forEach((ph, pi) => {
    const angle = n > 0 ? (pi / n) * Math.PI * 2 - Math.PI / 2 : 0;
    if (typeof ph.x === 'number' && typeof ph.y === 'number') {
      phasePos[ph.id] = { x: ph.x, y: ph.y, angle };
    } else {
      phasePos[ph.id] = {
        x: Math.cos(angle) * NODEMAP_PHASE_RADIUS,
        y: Math.sin(angle) * NODEMAP_PHASE_RADIUS,
        angle,
      };
    }
    const sectorWidth = n > 0 ? (Math.PI * 2 / n) : Math.PI * 2;
    ph.tasks.forEach((t, i) => {
      if (typeof t.x === 'number' && typeof t.y === 'number') {
        taskPos[t.id] = { x: t.x, y: t.y };
        maxRadius = Math.max(maxRadius, Math.hypot(t.x, t.y));
        return;
      }
      const ring = Math.floor(i / NODEMAP_TASKS_PER_RING);
      const posInRing = i % NODEMAP_TASKS_PER_RING;
      const ringCount = Math.min(NODEMAP_TASKS_PER_RING, ph.tasks.length - ring * NODEMAP_TASKS_PER_RING);
      const spread = sectorWidth * 0.8;
      const angleOffset = ringCount > 1 ? (posInRing / (ringCount - 1) - 0.5) * spread : 0;
      const taskAngle = angle + angleOffset;
      const radius = NODEMAP_PHASE_RADIUS + NODEMAP_RING_STEP * (ring + 1);
      taskPos[t.id] = { x: Math.cos(taskAngle) * radius, y: Math.sin(taskAngle) * radius };
      maxRadius = Math.max(maxRadius, radius);
    });
  });

  return { phasePos, taskPos, maxRadius };
}

function renderProjectMap(pid) {
  const f = findProject(pid);
  if (!f) return `<div class="empty"><h3>프로젝트 없음</h3><p><a href="#/">홈으로</a></p></div>`;
  const { category: c, project: p } = f;
  const pct = progressOfProject(p);
  const { phasePos, taskPos, maxRadius } = nodemapLayout(p);
  // 넉넉한 최소 크기로 캔버스를 잡아 "무제한에 가까운" 자유 배치 공간을 확보 (콘텐츠가 더 크면 그만큼 확장)
  const canvasSize = Math.max(NODEMAP_MIN_CANVAS, maxRadius * 2 + NODEMAP_MARGIN * 2);
  const cx = canvasSize / 2, cy = canvasSize / 2;
  // 커넥터는 상단(북쪽) 1개만 — 여러 개면 헷갈리고 방해된다는 피드백 반영
  const connectorsHtml = id =>
    `<div class="node-connector node-connector-n" data-task-id="${escapeHtml(id)}" title="드래그해서 다른 노드와 연결"></div>`;

  const taskNodesHtml = [];
  const allPos = { [p.id]: { x: 0, y: 0 } }; // id(project|task|phase) -> {x,y} — 자유연결선(links) 렌더용 통합 좌표표. 허브는 항상 중심(0,0).
  p.phases.forEach(ph => {
    const pp = phasePos[ph.id];
    allPos[ph.id] = pp;
    // 허브↔단계는 자동으로 선을 긋지 않음 — 필요하면 허브 커넥터로 직접 연결(다른 노드와 완전히 동일하게 취급).
    ph.tasks.forEach(t => {
      const tp = taskPos[t.id];
      allPos[t.id] = tp;
      // 단계→할일도 자동으로 선을 긋지 않음 — 배치(위치)로만 소속을 나타내고,
      // 실제로 보이는 선은 전부 사용자가 만든 자유연결(links)뿐이라 클릭/Shift로 항상 지울 수 있음.
      const colorStyle = t.color ? `background:${t.color};` : '';
      const sizeStyle = (t.w ? `width:${t.w}px;` : '') + (t.h ? `height:${t.h}px;` : '');
      taskNodesHtml.push(`
        <div class="node ${t.done ? 'done' : ''} ${t.color ? 'colored' : ''}" data-task-id="${escapeHtml(t.id)}" data-search="${escapeHtml((t.title + ' ' + (t.memo || '')).toLowerCase())}" style="left:${cx + tp.x}px;top:${cy + tp.y}px;${colorStyle}${sizeStyle}">
          <div class="node-title" data-task-id="${escapeHtml(t.id)}">${nodemapRenderText(t.title)}</div>
          ${connectorsHtml(t.id)}
        </div>`);
    });
  });

  const phaseNodesHtml = p.phases.map(ph => {
    const pp = phasePos[ph.id];
    const colorStyle = ph.color ? `background:${ph.color};` : '';
    const sizeStyle = (ph.w ? `width:${ph.w}px;` : '') + (ph.h ? `height:${ph.h}px;` : '');
    return `<div class="node phase-node ${ph.color ? 'colored' : ''}" data-phase-id="${escapeHtml(ph.id)}" data-search="${escapeHtml(ph.name.toLowerCase())}" style="left:${cx + pp.x}px;top:${cy + pp.y}px;${colorStyle}${sizeStyle}">
      <div class="node-title">${nodemapRenderText(ph.name)}</div>
      ${connectorsHtml(ph.id)}
    </div>`;
  }).join('');

  const allLinkables = [p];
  p.phases.forEach(ph => { allLinkables.push(ph); ph.tasks.forEach(t => allLinkables.push(t)); });
  const drawn = new Set();
  const linkLinesHtml = allLinkables.flatMap(node =>
    (node.links || []).map(otherId => {
      const key = [node.id, otherId].sort().join('|');
      if (drawn.has(key) || !allPos[otherId]) return '';
      drawn.add(key);
      const a = allPos[node.id], b = allPos[otherId];
      return `<line class="node-link" data-a="${escapeHtml(node.id)}" data-b="${escapeHtml(otherId)}" x1="${cx + a.x}" y1="${cy + a.y}" x2="${cx + b.x}" y2="${cy + b.y}"/>`;
    })
  ).join('');

  return `
    <div class="section-head">
      <div>
        <h2>${escapeHtml(p.name)}</h2>
        <div class="section-sub"><a href="#/c/${encodeURIComponent(c.id)}">${escapeHtml(c.name)}</a> · 전체 ${fmtPct(pct)}</div>
      </div>
      <div style="display:flex;gap:6px">
        <div class="view-toggle">
          <a href="#/p/${encodeURIComponent(p.id)}" class="view-toggle-btn">리스트</a>
          <a href="#/p/${encodeURIComponent(p.id)}/map" class="view-toggle-btn active">노드맵</a>
        </div>
      </div>
    </div>
    <div class="nodemap-toolbar">
      <input id="node-search" class="add-input" placeholder="🔍 메모·제목 검색" autocomplete="off">
      <div class="field-hint">빈 곳 더블클릭/우클릭 = 새 노드 추가 · 노드 클릭 = 편집 · 노드 우클릭 = 수정·색상·삭제 · 커넥터 드래그 = 연결 · 빈 곳 드래그 = 다중선택 · Del = 선택삭제 · Ctrl+C/V = 복사·붙여넣기 · Ctrl+Z = 실행취소 · Shift+드래그 = 화면 이동 · Shift+휠 = 확대·축소</div>
    </div>
    <div class="nodemap-scroll">
      <div id="node-canvas" class="nodemap-canvas" data-project-id="${escapeHtml(p.id)}" style="width:${canvasSize}px;height:${canvasSize}px">
        <svg class="nodemap-lines" width="${canvasSize}" height="${canvasSize}">${linkLinesHtml}</svg>
        <div class="node hub-node ${p.color ? 'colored' : ''}" data-hub-id="${escapeHtml(p.id)}" style="left:${cx}px;top:${cy}px;${p.color ? `background:${p.color};` : ''}">
          <div class="node-title">${escapeHtml(p.name)}</div>
          ${connectorsHtml(p.id)}
        </div>
        ${phaseNodesHtml}
        ${taskNodesHtml.join('') || ''}
      </div>
    </div>
  `;
}

// project 내 "메모" 단계 보장 — 노드맵에서 더블클릭으로 새 노드를 만들 때 소속시킬 기본 단계
function ensureMemoPhase(pid) {
  const f = findProject(pid);
  if (!f) return null;
  let ph = f.project.phases.find(ph => ph.name === '메모');
  if (!ph) {
    ph = { id: uid(), name: '메모', tasks: [], x: null, y: null };
    f.project.phases.push(ph);
  }
  return ph;
}

function setTaskPos(tid, x, y) { updateTask(tid, { x, y }); }

// 노드맵 색상 순환 — 홈 화면 스티커 메모(NOTE_COLORS)와 동일한 팔레트, null(기본 테마색)부터 시작해 순환
const NODEMAP_COLORS = ['#fef08a', '#bbf7d0', '#bae6fd', '#fbcfe8', '#fed7aa', '#e9d5ff', '#fca5a5', '#a5f3fc'];

function setTaskColorValue(id, color) {
  if (id.startsWith('project:')) {
    const f = findProject(id.slice(8));
    if (!f) return;
    f.project.color = color;
    commit();
    return;
  }
  if (id.startsWith('phase:')) {
    const phid = id.slice(6);
    for (const c of state.data.categories)
      for (const p of c.projects) {
        const ph = p.phases.find(ph => ph.id === phid);
        if (ph) { ph.color = color; commit(); return; }
      }
    return;
  }
  const t = findTask(id);
  if (!t) return;
  t.color = color;
  commit();
}

function nodemapShowColorPicker(tid, x, y) {
  document.querySelectorAll('.nodemap-ctxmenu, .nodemap-colorpicker').forEach(m => m.remove());
  const picker = document.createElement('div');
  picker.className = 'nodemap-colorpicker';
  picker.style.left = x + 'px';
  picker.style.top = y + 'px';
  picker.innerHTML = `
    <button type="button" class="cp-swatch cp-default" data-color="" title="기본"></button>
    ${NODEMAP_COLORS.map(c => `<button type="button" class="cp-swatch" data-color="${c}" style="background:${c}" title="${c}"></button>`).join('')}
  `;
  document.body.appendChild(picker);
  picker.addEventListener('mousedown', e => e.stopPropagation());
  picker.addEventListener('click', ev => {
    const btn = ev.target.closest('.cp-swatch');
    if (btn) setTaskColorValue(tid, btn.dataset.color || null);
    picker.remove();
  });
  setTimeout(() => {
    document.addEventListener('click', function onDoc(ev2) {
      if (!picker.contains(ev2.target)) { picker.remove(); document.removeEventListener('click', onDoc); }
    }, { once: true });
  }, 0);
}

function setPhasePos(phid, x, y) {
  for (const c of state.data.categories)
    for (const p of c.projects) {
      const ph = p.phases.find(ph => ph.id === phid);
      if (ph) { ph.x = x; ph.y = y; commit(); return; }
    }
}

function addMapTask(pid, x, y) {
  const ph = ensureMemoPhase(pid);
  if (!ph) return null;
  const task = { id: uid(), title: '', done: false, memo: '', due: null, createdAt: now(), manual: true, x, y, links: [] };
  ph.tasks.push(task);
  commit();
  return task.id;
}

function addMapPhase(pid, x, y) {
  const f = findProject(pid);
  if (!f) return null;
  const ph = { id: uid(), name: '새 단계', tasks: [], x, y, links: [] };
  f.project.phases.push(ph);
  commit();
  return ph.id;
}

// 노드맵 커넥터 연결은 task와 phase 노드 모두 대상이 될 수 있어, id로 둘 다 뒤져서 찾는다.
function nodemapFind(id) {
  const t = findTask(id);
  if (t) return t;
  for (const c of state.data.categories)
    for (const p of c.projects) {
      if (p.id === id) return p; // 허브(프로젝트) 자신
      const ph = p.phases.find(ph => ph.id === id);
      if (ph) return ph;
    }
  return null;
}

function linkTasks(aId, bId) {
  if (!aId || !bId || aId === bId) return;
  const a = nodemapFind(aId), b = nodemapFind(bId);
  if (!a || !b) return;
  if (!a.links.includes(bId)) a.links.push(bId);
  if (!b.links.includes(aId)) b.links.push(aId);
  commit();
}

function unlinkTasks(aId, bId) {
  const a = nodemapFind(aId), b = nodemapFind(bId);
  if (a) a.links = a.links.filter(id => id !== bId);
  if (b) b.links = b.links.filter(id => id !== aId);
  commit();
}

// 노드 제목을 그 자리에서 바로 편집 — 홈 화면 스티커 메모(edit-note)와 동일한 인라인 치환 방식
function nodemapInlineEdit(titleEl, getValue, setValue) {
  const nodeEl = titleEl.closest('.node');
  if (!nodeEl || nodeEl.classList.contains('editing')) return;
  nodeEl.classList.add('editing');
  const ta = document.createElement('textarea');
  ta.className = 'node-edit-area';
  ta.value = getValue();
  titleEl.replaceWith(ta);
  ta.focus();
  ta.select();
  let done = false;
  const cancel = () => { if (done) return; done = true; ta.replaceWith(titleEl); nodeEl.classList.remove('editing'); };
  const save = () => {
    if (done) return; done = true;
    const val = ta.value.trim();
    if (!val) { cancel(); return; }
    setValue(val); // commit() → render() 전체 재렌더로 이어짐
  };
  ta.addEventListener('blur', save);
  ta.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ta.blur(); }
  });
}

function nodemapShowContextMenu(pid, x, y, nodeEl) {
  document.querySelectorAll('.nodemap-ctxmenu').forEach(m => m.remove());
  const isPhase = nodeEl.classList.contains('phase-node');
  const isHub = nodeEl.classList.contains('hub-node');
  const menu = document.createElement('div');
  menu.className = 'nodemap-ctxmenu';
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.innerHTML = `
    <button type="button" data-act="edit">수정</button>
    <button type="button" data-act="color">색상</button>
    ${isHub ? '' : '<button type="button" data-act="delete" class="danger">삭제</button>'}
  `;
  document.body.appendChild(menu);
  menu.addEventListener('mousedown', e => e.stopPropagation());
  menu.addEventListener('click', ev => {
    const act = ev.target.dataset.act;
    if (act === 'edit') {
      const titleEl = nodeEl.querySelector('.node-title');
      if (titleEl) {
        nodemapInlineEdit(titleEl,
          () => titleEl.textContent,
          val => isHub ? renameProject(pid, val) : isPhase ? renamePhase(pid, nodeEl.dataset.phaseId, val) : updateTask(nodeEl.dataset.taskId, { title: val })
        );
      }
    } else if (act === 'color') {
      if (isHub) nodemapShowColorPicker('project:' + pid, x, y);
      else nodemapShowColorPicker(nodeEl.dataset.taskId || ('phase:' + nodeEl.dataset.phaseId), x, y);
    } else if (act === 'delete') {
      if (isPhase) {
        if (confirm('이 단계와 안의 모든 할일을 삭제할까요?')) deletePhase(pid, nodeEl.dataset.phaseId);
      } else if (confirm('이 노드를 삭제할까요?')) {
        deleteTask(nodeEl.dataset.taskId);
      }
    }
    menu.remove();
  });
  setTimeout(() => {
    document.addEventListener('click', function onDoc(ev2) {
      if (!menu.contains(ev2.target)) { menu.remove(); document.removeEventListener('click', onDoc); }
    }, { once: true });
  }, 0);
}

function nodemapShowEmptyContextMenu(pid, screenX, screenY, relX, relY) {
  document.querySelectorAll('.nodemap-ctxmenu').forEach(m => m.remove());
  const menu = document.createElement('div');
  menu.className = 'nodemap-ctxmenu';
  menu.style.left = screenX + 'px';
  menu.style.top = screenY + 'px';
  menu.innerHTML = `
    <button type="button" data-act="add-task">+ 새 메모 노드</button>
    <button type="button" data-act="add-phase">+ 새 단계</button>
  `;
  document.body.appendChild(menu);
  menu.addEventListener('mousedown', e => e.stopPropagation());
  menu.addEventListener('click', ev => {
    const act = ev.target.dataset.act;
    let newId = null, isPhase = false;
    if (act === 'add-task') { newId = addMapTask(pid, relX, relY); }
    else if (act === 'add-phase') { newId = addMapPhase(pid, relX, relY); isPhase = true; }
    menu.remove();
    if (!newId) return;
    const freshCanvas = $('#node-canvas');
    const sel = isPhase ? `.node.phase-node[data-phase-id="${CSS.escape(newId)}"] .node-title` : `.node[data-task-id="${CSS.escape(newId)}"] .node-title`;
    const titleEl = freshCanvas && freshCanvas.querySelector(sel);
    if (titleEl) {
      nodemapInlineEdit(titleEl, () => (isPhase ? '' : ''),
        val => isPhase ? renamePhase(pid, newId, val) : updateTask(newId, { title: val }));
    }
  });
  setTimeout(() => {
    document.addEventListener('click', function onDoc(ev2) {
      if (!menu.contains(ev2.target)) { menu.remove(); document.removeEventListener('click', onDoc); }
    }, { once: true });
  }, 0);
}

// 드래그/연결 상태는 모듈 전역에 둠 — mountNodeCanvas가 render()마다 재호출되므로
// document 리스너를 매번 새로 붙이면 쌓이기 때문에 최초 1회만 바인딩(nodemapBound)한다.
let nodemapDrag = null;   // { kind: 'task'|'phase', id, el, startX, startY, origLeft, origTop, moved }
let nodemapWireFrom = null;
let nodemapWireShiftMode = false; // 커넥터 드래그 시작 시 Shift가 눌려있었는지 — 놓으면 연결 대신 연결 해제
let nodemapTempLine = null;
let nodemapBound = false;
let nodemapPanKey = false; // Shift 누르고 있는 동안 true — 손바닥 커서로 캔버스 자유 이동
let nodemapPan = null;     // { scrollEl, startX, startY, startLeft, startTop }
let nodemapSelected = new Set(); // 마퀴 다중선택된 task/phase id
let nodemapMarquee = null;       // { startX, startY, box }
let nodemapGroupDrag = null;     // { items:[{kind,id,el,origLeft,origTop}], startX, startY, moved }
let nodemapResizeTarget = null;  // 리사이즈 핸들로 드래그 중인 노드 — mouseup에서 한 번만 저장
const NODEMAP_CLICK_THRESHOLD = 4; // px — 이보다 적게 움직이면 드래그가 아니라 클릭으로 취급

function nodemapCenter(canvas) {
  return { cx: parseFloat(canvas.style.width) / 2, cy: parseFloat(canvas.style.height) / 2 };
}

// 브라우저 네이티브 리사이즈 핸들(우하단 모서리, CSS resize:both)과 커스텀 드래그가 충돌하지 않도록
// 그 영역에서 시작된 mousedown이면 true를 반환해 드래그를 건너뛰게 한다.
function nodemapNearResizeHandle(nodeEl, e) {
  const r = nodeEl.getBoundingClientRect();
  return (r.right - e.clientX) < 16 && (r.bottom - e.clientY) < 16;
}

function nodemapSaveSize(nodeEl) {
  if (!nodeEl.isConnected) return; // 재렌더로 이미 DOM에서 떨어져 나간 요소면 크기가 0으로 잘못 저장되니 건너뜀
  const w = Math.round(nodeEl.clientWidth), h = Math.round(nodeEl.clientHeight);
  if (!w || !h) return;
  if (nodeEl.classList.contains('phase-node')) {
    const phid = nodeEl.dataset.phaseId;
    for (const c of state.data.categories)
      for (const p of c.projects) {
        const ph = p.phases.find(ph => ph.id === phid);
        if (ph) { ph.w = w; ph.h = h; commit(); return; }
      }
  } else {
    const t = findTask(nodeEl.dataset.taskId);
    if (t) { t.w = w; t.h = h; commit(); }
  }
}

let nodemapScrollPos = null; // { left, top } — commit()의 전체 재렌더로 스크롤이 리셋되는 것을 막기 위해 기억해둠
let nodemapZoom = 1;         // Shift+휠로 조절되는 배율, 재렌더 후에도 유지
const NODEMAP_ZOOM_MIN = 0.3, NODEMAP_ZOOM_MAX = 2.5;

function mountNodeCanvas(pid) {
  const canvas = $('#node-canvas');
  if (!canvas) return;
  canvas.style.transform = `scale(${nodemapZoom})`;

  const scrollEl = canvas.closest('.nodemap-scroll');
  if (scrollEl) {
    scrollEl.addEventListener('wheel', e => {
      if (!e.shiftKey) return;
      e.preventDefault();
      nodemapZoom = Math.min(NODEMAP_ZOOM_MAX, Math.max(NODEMAP_ZOOM_MIN, nodemapZoom + (e.deltaY > 0 ? -0.1 : 0.1)));
      canvas.style.transform = `scale(${nodemapZoom})`;
    }, { passive: false });
    if (nodemapScrollPos) {
      scrollEl.scrollLeft = nodemapScrollPos.left;
      scrollEl.scrollTop = nodemapScrollPos.top;
    } else {
      // 첫 진입: 중심(hub)이 보이도록 스크롤 위치를 가운데로 맞춤
      scrollEl.scrollLeft = Math.max(0, canvas.clientWidth / 2 - scrollEl.clientWidth / 2);
      scrollEl.scrollTop = Math.max(0, canvas.clientHeight / 2 - scrollEl.clientHeight / 2);
    }
    scrollEl.addEventListener('scroll', () => {
      nodemapScrollPos = { left: scrollEl.scrollLeft, top: scrollEl.scrollTop };
    });
  }

  if (scrollEl) scrollEl.classList.toggle('pan-ready', nodemapPanKey);

  canvas.addEventListener('mousedown', e => {
    const connector = e.target.closest('.node-connector');
    const nodeEl = e.target.closest('.node');
    const linkEl = e.target.closest('.node-link');
    if (nodemapPanKey && scrollEl && !connector && !nodeEl && !linkEl) {
      // 빈 캔버스에서만 패닝 시작 — 노드/커넥터/연결선 위에서는 그쪽 상호작용(연결해제 등)이 우선
      e.preventDefault();
      nodemapPan = { scrollEl, startX: e.clientX, startY: e.clientY, startLeft: scrollEl.scrollLeft, startTop: scrollEl.scrollTop };
      scrollEl.classList.add('panning');
      return;
    }
    if (connector) {
      e.preventDefault();
      nodemapWireFrom = connector.dataset.taskId;
      nodemapWireShiftMode = e.shiftKey; // Shift 누른 채 커넥터에서 드래그 → 놓을 때 연결 대신 연결 해제
      const svg = canvas.querySelector('.nodemap-lines');
      nodemapTempLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      nodemapTempLine.setAttribute('class', nodemapWireShiftMode ? 'node-link-temp unlink' : 'node-link-temp');
      const r0 = nodeEl.getBoundingClientRect(), cr = canvas.getBoundingClientRect();
      // getBoundingClientRect는 화면(줌 반영) 픽셀 기준이라, 캔버스 내부 논리좌표로 쓰려면 줌 배율로 나눠야 함
      const cx = ((r0.left - cr.left) + r0.width / 2) / nodemapZoom, cy = ((r0.top - cr.top) + r0.height / 2) / nodemapZoom;
      nodemapTempLine.setAttribute('x1', cx); nodemapTempLine.setAttribute('y1', cy);
      nodemapTempLine.setAttribute('x2', cx); nodemapTempLine.setAttribute('y2', cy);
      svg.appendChild(nodemapTempLine);
    } else if (nodeEl && !nodeEl.classList.contains('hub-node') && !nodeEl.classList.contains('editing') && nodemapNearResizeHandle(nodeEl, e)) {
      // 리사이즈 핸들 영역 — 네이티브 리사이즈(브라우저 기본 동작)에 맡기고,
      // 대상만 기억해뒀다가 mouseup 시점에 딱 한 번만 저장한다. 도중에 재렌더하면
      // 드래그 중인 네이티브 리사이즈 자체가 끊겨서 "커졌다 다시 줄어드는" 것처럼 보인다.
      nodemapResizeTarget = nodeEl;
    } else if (nodeEl && !nodeEl.classList.contains('hub-node') && !nodeEl.classList.contains('editing')) {
      // 주의: 여기서 preventDefault()를 호출하면 일부 브라우저/자동화 환경에서
      // 뒤이은 click 이벤트가 억제된다(드래그 없는 순수 클릭 시 인라인 편집이 안 열림).
      // 텍스트 선택 방지는 CSS user-select:none으로 대신 처리(.node 규칙).
      const isPhase = nodeEl.classList.contains('phase-node');
      const id = isPhase ? nodeEl.dataset.phaseId : nodeEl.dataset.taskId;
      if (nodemapSelected.size > 1 && nodemapSelected.has(id)) {
        // 선택된 노드가 여럿이고 그중 하나를 끄는 경우 → 선택된 전체를 같이 이동
        const items = [...nodemapSelected].map(sid => {
          const el2 = canvas.querySelector(`.node[data-task-id="${CSS.escape(sid)}"], .node.phase-node[data-phase-id="${CSS.escape(sid)}"]`);
          if (!el2) return null;
          return { kind: el2.classList.contains('phase-node') ? 'phase' : 'task', id: sid, el: el2, origLeft: parseFloat(el2.style.left), origTop: parseFloat(el2.style.top) };
        }).filter(Boolean);
        nodemapGroupDrag = { items, startX: e.clientX, startY: e.clientY, moved: false };
        items.forEach(it => it.el.classList.add('dragging'));
      } else {
        nodemapDrag = {
          kind: isPhase ? 'phase' : 'task',
          id,
          el: nodeEl,
          startX: e.clientX, startY: e.clientY,
          origLeft: parseFloat(nodeEl.style.left), origTop: parseFloat(nodeEl.style.top),
          moved: false,
        };
        nodeEl.classList.add('dragging');
      }
    } else if (!nodeEl && !linkEl) {
      // 빈 캔버스 드래그 = 마퀴 다중선택 시작
      nodemapSelected.forEach(sid => {
        const el2 = canvas.querySelector(`.node[data-task-id="${CSS.escape(sid)}"], .node.phase-node[data-phase-id="${CSS.escape(sid)}"]`);
        if (el2) el2.classList.remove('selected');
      });
      nodemapSelected.clear();
      const box = document.createElement('div');
      box.className = 'nodemap-marquee';
      document.body.appendChild(box);
      nodemapMarquee = { startX: e.clientX, startY: e.clientY, box };
    }
  });

  canvas.addEventListener('dblclick', e => {
    if (e.target.closest('.node')) return; // 노드 위 더블클릭은 무시, 빈 캔버스만
    const cr = canvas.getBoundingClientRect();
    const { cx, cy } = nodemapCenter(canvas);
    const relX = (e.clientX - cr.left) / nodemapZoom - cx, relY = (e.clientY - cr.top) / nodemapZoom - cy;
    nodemapShowEmptyContextMenu(pid, e.clientX, e.clientY, relX, relY);
  });

  canvas.addEventListener('contextmenu', e => {
    const nodeEl = e.target.closest('.node');
    e.preventDefault();
    if (!nodeEl) {
      const cr = canvas.getBoundingClientRect();
      const { cx, cy } = nodemapCenter(canvas);
      const relX = (e.clientX - cr.left) / nodemapZoom - cx, relY = (e.clientY - cr.top) / nodemapZoom - cy;
      nodemapShowEmptyContextMenu(pid, e.clientX, e.clientY, relX, relY);
      return;
    }
    nodemapShowContextMenu(pid, e.clientX, e.clientY, nodeEl);
  });

  canvas.addEventListener('click', e => {
    if (e.target.closest('.node-connector')) return;
    if (e.target.tagName === 'SELECT') return;
    const titleEl = e.target.closest('.node-title');
    if (titleEl) {
      const nodeEl = titleEl.closest('.node');
      if (nodeEl.classList.contains('hub-node')) {
        nodemapInlineEdit(titleEl, () => titleEl.textContent, val => renameProject(pid, val));
      } else if (nodeEl.classList.contains('phase-node')) {
        nodemapInlineEdit(titleEl, () => titleEl.textContent, val => renamePhase(pid, nodeEl.dataset.phaseId, val));
      } else {
        nodemapInlineEdit(titleEl, () => titleEl.textContent, val => updateTask(nodeEl.dataset.taskId, { title: val }));
      }
      return;
    }
    const line = e.target.closest('.node-link');
    if (line) {
      if (e.shiftKey || confirm('이 연결을 삭제할까요?')) unlinkTasks(line.dataset.a, line.dataset.b);
    }
  });

  const search = $('#node-search');
  if (search) {
    let matchIdx = -1; // Enter로 다음 검색결과로 이동할 때 쓰는 순번
    search.addEventListener('input', () => {
      matchIdx = -1;
      const q = search.value.trim().toLowerCase();
      canvas.querySelectorAll('.node[data-search]').forEach(el => {
        const match = !q || el.dataset.search.includes(q);
        el.classList.toggle('dim', !!q && !match);
        el.classList.toggle('match', !!q && match);
      });
    });
    search.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const matches = [...canvas.querySelectorAll('.node.match')];
      if (!matches.length) return;
      matchIdx = (matchIdx + 1) % matches.length;
      const el = matches[matchIdx];
      const scrollEl2 = canvas.closest('.nodemap-scroll');
      if (scrollEl2) {
        const left = parseFloat(el.style.left), top = parseFloat(el.style.top);
        scrollEl2.scrollLeft = left * nodemapZoom - scrollEl2.clientWidth / 2;
        scrollEl2.scrollTop = top * nodemapZoom - scrollEl2.clientHeight / 2;
      }
      canvas.querySelectorAll('.node.current-match').forEach(n => n.classList.remove('current-match'));
      el.classList.add('current-match');
    });
  }

  if (nodemapBound) return;
  nodemapBound = true;

  document.addEventListener('keydown', e => {
    if (e.key === 'Shift' && !nodemapPanKey) {
      nodemapPanKey = true;
      const se = $('#node-canvas')?.closest('.nodemap-scroll');
      if (se) se.classList.add('pan-ready');
    }
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return; // 텍스트 입력 중엔 브라우저 기본 복사/붙여넣기에 맡김
    if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
      if (nodemapSelected.size > 0) { e.preventDefault(); nodemapCopySelected(); }
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
      if (nodemapClipboard && nodemapClipboard.length) {
        const r = currentRoute();
        if (r.name === 'project' && r.view === 'map') { e.preventDefault(); nodemapPasteClipboard(r.id); }
      }
    }
  });
  document.addEventListener('keyup', e => {
    if (e.key === 'Shift') {
      nodemapPanKey = false;
      document.querySelectorAll('.nodemap-scroll').forEach(el => el.classList.remove('pan-ready', 'panning'));
    }
  });
  window.addEventListener('blur', () => {
    nodemapPanKey = false; nodemapPan = null;
    document.querySelectorAll('.nodemap-scroll').forEach(el => el.classList.remove('pan-ready', 'panning'));
  });

  document.addEventListener('mousemove', e => {
    if (nodemapPan) {
      nodemapPan.scrollEl.scrollLeft = nodemapPan.startLeft - (e.clientX - nodemapPan.startX);
      nodemapPan.scrollEl.scrollTop = nodemapPan.startTop - (e.clientY - nodemapPan.startY);
      return;
    }
    if (nodemapMarquee) {
      const x1 = Math.min(nodemapMarquee.startX, e.clientX), x2 = Math.max(nodemapMarquee.startX, e.clientX);
      const y1 = Math.min(nodemapMarquee.startY, e.clientY), y2 = Math.max(nodemapMarquee.startY, e.clientY);
      Object.assign(nodemapMarquee.box.style, { left: x1 + 'px', top: y1 + 'px', width: (x2 - x1) + 'px', height: (y2 - y1) + 'px' });
      const c = $('#node-canvas');
      if (c) {
        c.querySelectorAll('.node:not(.hub-node)').forEach(el => {
          const r = el.getBoundingClientRect();
          const id = el.dataset.taskId || el.dataset.phaseId;
          const intersects = r.left < x2 && r.right > x1 && r.top < y2 && r.bottom > y1;
          if (intersects) { nodemapSelected.add(id); el.classList.add('selected'); }
          else { nodemapSelected.delete(id); el.classList.remove('selected'); }
        });
      }
      return;
    }
    if (nodemapGroupDrag) {
      const dx = (e.clientX - nodemapGroupDrag.startX) / nodemapZoom, dy = (e.clientY - nodemapGroupDrag.startY) / nodemapZoom;
      if (Math.abs(dx) > NODEMAP_CLICK_THRESHOLD || Math.abs(dy) > NODEMAP_CLICK_THRESHOLD) nodemapGroupDrag.moved = true;
      nodemapGroupDrag.items.forEach(it => {
        const nx = it.origLeft + dx, ny = it.origTop + dy;
        it.el.style.left = nx + 'px';
        it.el.style.top = ny + 'px';
        nodemapUpdateLinesFor(it.id, nx, ny);
      });
      return;
    }
    if (nodemapDrag) {
      // 화면(줌 반영) 픽셀 이동량을 캔버스 내부 논리좌표 이동량으로 환산
      const dx = (e.clientX - nodemapDrag.startX) / nodemapZoom, dy = (e.clientY - nodemapDrag.startY) / nodemapZoom;
      if (Math.abs(dx) > NODEMAP_CLICK_THRESHOLD || Math.abs(dy) > NODEMAP_CLICK_THRESHOLD) nodemapDrag.moved = true;
      const nx = nodemapDrag.origLeft + dx, ny = nodemapDrag.origTop + dy;
      nodemapDrag.el.style.left = nx + 'px';
      nodemapDrag.el.style.top = ny + 'px';
      nodemapUpdateLinesFor(nodemapDrag.id, nx, ny);
    } else if (nodemapWireFrom && nodemapTempLine) {
      const c = $('#node-canvas');
      if (!c) return;
      const cr = c.getBoundingClientRect();
      nodemapTempLine.setAttribute('x2', (e.clientX - cr.left) / nodemapZoom);
      nodemapTempLine.setAttribute('y2', (e.clientY - cr.top) / nodemapZoom);
    }
  });

  document.addEventListener('mouseup', e => {
    if (nodemapResizeTarget) {
      nodemapSaveSize(nodemapResizeTarget);
      nodemapResizeTarget = null;
      return;
    }
    if (nodemapPan) {
      nodemapPan.scrollEl.classList.remove('panning');
      nodemapPan = null;
      return;
    }
    if (nodemapMarquee) {
      nodemapMarquee.box.remove();
      nodemapMarquee = null;
      return;
    }
    if (nodemapGroupDrag) {
      const c = $('#node-canvas');
      const { cx, cy } = c ? nodemapCenter(c) : { cx: 0, cy: 0 };
      nodemapGroupDrag.items.forEach(it => it.el.classList.remove('dragging'));
      if (nodemapGroupDrag.moved) {
        nodemapGroupDrag.items.forEach(it => {
          const nx = parseFloat(it.el.style.left), ny = parseFloat(it.el.style.top);
          const relX = nx - cx, relY = ny - cy;
          if (it.kind === 'phase') {
            outer: for (const cat of state.data.categories)
              for (const p of cat.projects) {
                const ph = p.phases.find(ph => ph.id === it.id);
                if (ph) { ph.x = relX; ph.y = relY; break outer; }
              }
          } else {
            const t = findTask(it.id);
            if (t) { t.x = relX; t.y = relY; }
          }
        });
        commit(); // 그룹 전체를 한 번에 커밋(각 아이템마다 재렌더되는 것 방지)
      }
      nodemapGroupDrag = null;
      return;
    }
    if (nodemapDrag) {
      const nx = parseFloat(nodemapDrag.el.style.left), ny = parseFloat(nodemapDrag.el.style.top);
      nodemapDrag.el.classList.remove('dragging');
      if (nodemapDrag.moved) {
        const c = $('#node-canvas');
        const { cx, cy } = c ? nodemapCenter(c) : { cx: 0, cy: 0 };
        if (nodemapDrag.kind === 'phase') setPhasePos(nodemapDrag.id, nx - cx, ny - cy);
        else setTaskPos(nodemapDrag.id, nx - cx, ny - cy);
      }
      nodemapDrag = null;
    } else if (nodemapWireFrom) {
      const targetEl = e.target.closest('.node');
      if (nodemapTempLine) nodemapTempLine.remove();
      const targetId = targetEl && (targetEl.dataset.taskId || targetEl.dataset.phaseId || targetEl.dataset.hubId);
      if (targetId && targetId !== nodemapWireFrom) {
        if (nodemapWireShiftMode) {
          // Shift 누른 채 커넥터 드래그 → 연결 해제
          unlinkTasks(nodemapWireFrom, targetId);
        } else {
          // 할일↔할일/할일↔단계/단계↔단계 구분 없이 전부 개수 제한 없는 자유연결.
          // (단계 소속 자체를 바꾸고 싶으면 리스트 뷰에서 이동/변경할 것 — 노드맵 연결과는 별개)
          linkTasks(nodemapWireFrom, targetId);
        }
      }
      nodemapWireFrom = null; nodemapWireShiftMode = false; nodemapTempLine = null;
    }
  });
}

function nodemapUpdateLinesFor(id, x, y) {
  const canvas = $('#node-canvas');
  if (!canvas) return;
  canvas.querySelectorAll(`.node-link[data-a="${CSS.escape(id)}"]`).forEach(l => { l.setAttribute('x1', x); l.setAttribute('y1', y); });
  canvas.querySelectorAll(`.node-link[data-b="${CSS.escape(id)}"]`).forEach(l => { l.setAttribute('x2', x); l.setAttribute('y2', y); });
}

function renderTask(t, pid, phid) {
  const due = t.due ? renderDue(t.due) : '';
  const memo = t.memo ? `<div class="task-memo">${escapeHtml(t.memo)}</div>` : '';
  const hasSubs = Array.isArray(t.subItems) && t.subItems.length > 0;
  const subsDone = hasSubs ? t.subItems.filter(s => s.done).length : 0;
  const taskPct = progressOfTask(t);
  const taskDone = taskPct >= 1;
  const subsHtml = hasSubs ? `
    <ul class="sub-list">
      ${t.subItems.map(s => `
        <li class="sub-item ${s.done ? 'done' : ''}" data-sub-id="${escapeHtml(s.id)}" draggable="true">
          <input type="checkbox" ${s.done ? 'checked' : ''} data-action="toggle-sub" data-task-id="${escapeHtml(t.id)}" data-sub-id="${escapeHtml(s.id)}">
          <span class="sub-text" data-action="edit-sub" data-task-id="${escapeHtml(t.id)}" data-sub-id="${escapeHtml(s.id)}" title="클릭해서 편집">${escapeHtml(s.text)}</span>
          <button class="row-btn" data-action="move-sub-up"   data-task-id="${escapeHtml(t.id)}" data-sub-id="${escapeHtml(s.id)}" title="위로">▲</button>
          <button class="row-btn" data-action="move-sub-down" data-task-id="${escapeHtml(t.id)}" data-sub-id="${escapeHtml(s.id)}" title="아래로">▼</button>
          <button class="row-btn danger" data-action="delete-sub" data-task-id="${escapeHtml(t.id)}" data-sub-id="${escapeHtml(s.id)}" title="삭제">×</button>
        </li>`).join('')}
    </ul>` : '';
  const addSubForm = `
    <form class="add-row sub-add" data-action="add-sub" data-task-id="${escapeHtml(t.id)}">
      <input class="add-input" name="text" placeholder="+ 서류·세부항목 추가 (엔터)" autocomplete="off" required>
      <button class="btn ghost" type="submit">+</button>
    </form>`;

  return `
    <li class="task ${taskDone ? 'done' : ''} ${hasSubs ? 'has-subs' : ''}" data-task-id="${escapeHtml(t.id)}" draggable="true">
      <div class="task-main">
        <input type="checkbox" ${taskDone ? 'checked' : ''} data-action="toggle-task" data-task-id="${escapeHtml(t.id)}" ${hasSubs ? 'title="하위 항목 모두 체크/해제"' : ''}>
        <div class="task-body">
          <div class="task-title">
            ${escapeHtml(t.title)}
            ${hasSubs ? `<span class="sub-count">${subsDone}/${t.subItems.length}</span>` : ''}
          </div>
          ${memo}
          ${due}
        </div>
        <div class="task-actions">
          <button class="row-btn" data-action="toggle-subs"     data-task-id="${escapeHtml(t.id)}" title="체크리스트">${hasSubs ? '▾' : '+'}</button>
          <button class="row-btn" data-action="move-task-up"   data-task-id="${escapeHtml(t.id)}" title="위로">▲</button>
          <button class="row-btn" data-action="move-task-down" data-task-id="${escapeHtml(t.id)}" title="아래로">▼</button>
          <button class="row-btn" data-action="edit-task"      data-task-id="${escapeHtml(t.id)}" title="편집">편집</button>
          <button class="row-btn danger" data-action="delete-task" data-task-id="${escapeHtml(t.id)}" title="삭제">삭제</button>
        </div>
      </div>
      ${hasSubs || t._showAdd ? `<div class="task-subs">${subsHtml}${addSubForm}</div>` : ''}
    </li>`;
}

function renderDue(d) {
  const due = new Date(d);
  const diff = Math.floor((due - Date.now()) / (1000 * 60 * 60 * 24));
  const cls = diff < 0 ? 'late' : diff <= 3 ? 'soon' : '';
  const label = diff < 0 ? `${-diff}일 지남` : diff === 0 ? '오늘' : `D-${diff}`;
  return `<div class="task-due ${cls}">${due.toISOString().slice(0, 10)} · ${label}</div>`;
}

// ---------- Modal ----------
function showModal(html) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-backdrop" data-modal-backdrop><div class="modal">${html}</div></div>`;
  setTimeout(() => {
    const firstInput = root.querySelector('input, textarea');
    if (firstInput) firstInput.focus();
  }, 0);
}
function closeModal() { $('#modal-root').innerHTML = ''; }

// 인증 모달 진입점 — 기기별로 PAT/Gist ID를 1회 직접 입력
function showAuthModal() {
  showManualAuthModal();
}

function showManualAuthModal() {
  const pat = loadPat() || '';
  const gid = loadGistId() || '';
  showModal(`
    <h2>GitHub 연결</h2>
    <p>Private Gist에 데이터를 저장합니다. <b>이 기기에서 처음 한 번만</b> 입력하면 됩니다.</p>
    <form data-modal-form="auth">
      <label>Personal Access Token (PAT)</label>
      <input name="pat" type="password" value="${escapeHtml(pat)}" placeholder="ghp_..." autocomplete="off" required>
      <div class="field-hint"><a href="https://github.com/settings/tokens" target="_blank">Classic PAT 발급</a> · Scopes에서 <b>gist</b>만 체크, Expiration은 <b>No expiration</b> 권장</div>

      <label>Gist ID</label>
      <input name="gid" value="${escapeHtml(gid)}" placeholder="abc123..." autocomplete="off" required>
      <div class="field-hint"><a href="https://gist.github.com/" target="_blank">새 Private Gist 만들기</a> · 파일명 <b>data.json</b>, 내용은 비워둬도 됨. 만든 뒤 URL의 마지막 부분이 ID입니다.</div>

      <div class="modal-actions">
        <button type="button" class="btn ghost" data-action="modal-close">취소</button>
        <button type="submit" class="btn">저장하고 연결</button>
      </div>
    </form>
  `);
}

// 연결 후 동기화
async function connectAndSync() {
  try {
    const remote = await fetchGist();
    if (remote && remote.categories) {
      state.data = ensureSeed(remote);
      saveLocal(state.data);
      setSyncStatus('idle');
    } else {
      state.data = ensureSeed(state.data || freshData());
      saveLocal(state.data);
      await pushGist(state.data);
    }
    render();
  } catch (err) {
    console.error(err);
    toast('연결 실패 — 토큰/Gist ID 확인');
  }
}

function showEditTaskModal(tid) {
  let task = null;
  outer: for (const c of state.data.categories)
    for (const p of c.projects)
      for (const ph of p.phases)
        for (const t of ph.tasks)
          if (t.id === tid) { task = t; break outer; }
  if (!task) return;
  showModal(`
    <h2>할일 편집</h2>
    <form data-modal-form="edit-task" data-task-id="${escapeHtml(tid)}">
      <label>제목</label>
      <input name="title" value="${escapeHtml(task.title)}" required>
      <label>메모</label>
      <textarea name="memo" placeholder="설명, 링크 등">${escapeHtml(task.memo || '')}</textarea>
      <label>마감일</label>
      <input name="due" type="date" value="${task.due ? task.due.slice(0,10) : ''}">
      <div class="modal-actions">
        <button type="button" class="btn ghost" data-action="modal-close">취소</button>
        <button type="submit" class="btn">저장</button>
      </div>
    </form>
  `);
}

function showSettingsModal() {
  showModal(`
    <h2>설정</h2>
    <p>현재 연결 정보를 확인하거나 초기화할 수 있습니다.</p>
    <label>Gist ID</label>
    <input value="${escapeHtml(loadGistId() || '')}" readonly>
    <label>PAT</label>
    <input value="${loadPat() ? '••••••••' + (loadPat().slice(-4)) : ''}" readonly>
    <div class="modal-actions">
      <button type="button" class="btn ghost" data-action="modal-close">닫기</button>
      <button type="button" class="btn ghost" data-action="restore-revision">이전 버전 복구</button>
      <button type="button" class="btn ghost" data-action="reconnect">재연결</button>
      <button type="button" class="btn danger" data-action="signout">연결 해제</button>
    </div>
  `);
}

async function showRestoreModal() {
  showModal(`<h2>이전 버전 복구</h2><p>리비전 목록 불러오는 중...</p>`);
  try {
    const commits = await fetchGistRevisions();
    if (!commits || commits.length === 0) {
      showModal(`<h2>이전 버전 복구</h2><p>저장된 이전 버전이 없습니다.</p><div class="modal-actions"><button type="button" class="btn ghost" data-action="modal-close">닫기</button></div>`);
      return;
    }
    const rows = commits.slice(0, 15).map((c, i) => {
      const d = new Date(c.committed_at);
      const label = d.toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const added = c.change_status?.additions ?? '';
      const deleted = c.change_status?.deletions ?? '';
      const badge = (added || deleted) ? ` <small style="opacity:.5">+${added}/-${deleted}</small>` : '';
      return `<button class="btn ghost" style="width:100%;text-align:left;margin-bottom:4px" data-action="restore-version" data-version="${escapeHtml(c.version)}">${i === 0 ? '[현재] ' : ''}${label}${badge}</button>`;
    }).join('');
    showModal(`
      <h2>이전 버전 복구</h2>
      <p style="color:#f87171">복구하면 현재 데이터가 선택한 시점으로 교체됩니다.</p>
      <div style="max-height:320px;overflow-y:auto">${rows}</div>
      <div class="modal-actions">
        <button type="button" class="btn ghost" data-action="modal-close">취소</button>
      </div>
    `);
  } catch (e) {
    showModal(`<h2>오류</h2><p>${escapeHtml(e.message)}</p><div class="modal-actions"><button type="button" class="btn ghost" data-action="modal-close">닫기</button></div>`);
  }
}

// ---------- Event handling ----------
document.addEventListener('click', async e => {
  // modal backdrop click closes
  if (e.target.matches('[data-modal-backdrop]')) { closeModal(); return; }

  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const a = btn.dataset.action;

  if (a === 'toggle-phase') {
    const sec = btn.closest('.phase');
    if (sec) {
      const willBeOpen = !sec.classList.contains('open');
      sec.classList.toggle('open');
      state.ui.phaseOpen[sec.dataset.phaseId] = willBeOpen;
    }
    return;
  }
  if (a === 'toggle-task') {
    e.preventDefault();
    toggleTask(btn.dataset.taskId);
    return;
  }
  if (a === 'toggle-sub') {
    e.preventDefault();
    toggleSubItem(btn.dataset.taskId, btn.dataset.subId);
    return;
  }
  if (a === 'delete-sub') {
    e.preventDefault();
    deleteSubItem(btn.dataset.taskId, btn.dataset.subId);
    return;
  }
  if (a === 'edit-sub') {
    e.preventDefault();
    const t = findTask(btn.dataset.taskId); if (!t) return;
    const s = (t.subItems || []).find(x => x.id === btn.dataset.subId);
    if (!s) return;
    const v = prompt('항목 내용', s.text);
    if (v !== null && v.trim()) updateSubItem(btn.dataset.taskId, btn.dataset.subId, v.trim());
    return;
  }
  if (a === 'move-sub-up')   { e.preventDefault(); moveSubItem(btn.dataset.taskId, btn.dataset.subId, -1); return; }
  if (a === 'move-sub-down') { e.preventDefault(); moveSubItem(btn.dataset.taskId, btn.dataset.subId, +1); return; }
  if (a === 'toggle-subs') {
    e.preventDefault();
    const t = findTask(btn.dataset.taskId);
    if (!t) return;
    const has = Array.isArray(t.subItems) && t.subItems.length > 0;
    if (!has) {
      const v = prompt('첫 서류·세부항목 이름');
      if (v && v.trim()) addSubItem(btn.dataset.taskId, v.trim());
    }
    return;
  }
  if (a === 'edit-note') {
    e.preventDefault();
    const noteId = btn.dataset.noteId;
    const n = state.data.notes.find(n => n.id === noteId);
    if (!n) return;
    const card = btn.closest('.note-card');
    if (card.classList.contains('editing')) return;
    card.classList.add('editing');
    const textEl = card.querySelector('.note-text');
    const ta = document.createElement('textarea');
    ta.className = 'note-edit-area';
    ta.value = n.text;
    textEl.replaceWith(ta);
    ta.focus();
    ta.selectionStart = ta.selectionEnd = ta.value.length;
    const save = () => {
      const v = ta.value.trim();
      if (v && v !== n.text) updateNote(noteId, v);
      else render();
    };
    ta.addEventListener('blur', save);
    ta.addEventListener('keydown', ev => {
      if (ev.key === 'Escape') { ev.preventDefault(); render(); }
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); ta.blur(); }
    });
    return;
  }
  if (a === 'delete-note') {
    e.preventDefault();
    deleteNote(btn.dataset.noteId);
    return;
  }
  if (a === 'recolor-note') {
    e.preventDefault();
    recolorNote(btn.dataset.noteId);
    return;
  }
  if (a === 'move-cat-up')   { e.preventDefault(); moveCategory(btn.dataset.catId, -1); return; }
  if (a === 'move-cat-down') { e.preventDefault(); moveCategory(btn.dataset.catId, +1); return; }
  if (a === 'rename-cat') {
    e.preventDefault();
    const c = findCategory(btn.dataset.catId); if (!c) return;
    const v = prompt('대분류 이름', c.name);
    if (v && v.trim()) renameCategory(btn.dataset.catId, v.trim());
    return;
  }
  if (a === 'recolor-cat') {
    e.preventDefault();
    const c = findCategory(btn.dataset.catId); if (!c) return;
    const idx = COLOR_PALETTE.indexOf(c.color);
    const next = COLOR_PALETTE[(idx + 1) % COLOR_PALETTE.length];
    recolorCategory(btn.dataset.catId, next);
    return;
  }
  if (a === 'delete-cat') {
    e.preventDefault();
    const c = findCategory(btn.dataset.catId); if (!c) return;
    const msg = c.projects.length
      ? `"${c.name}"과 안의 프로젝트 ${c.projects.length}개를 모두 삭제할까요?`
      : `"${c.name}"을 삭제할까요?`;
    if (confirm(msg)) deleteCategory(btn.dataset.catId);
    return;
  }
  if (a === 'move-phase-up')   { e.preventDefault(); movePhase(btn.dataset.projectId, btn.dataset.phaseId, -1); return; }
  if (a === 'move-phase-down') { e.preventDefault(); movePhase(btn.dataset.projectId, btn.dataset.phaseId, +1); return; }
  if (a === 'move-task-up')    { e.preventDefault(); moveTask(btn.dataset.taskId, -1); return; }
  if (a === 'move-task-down')  { e.preventDefault(); moveTask(btn.dataset.taskId, +1); return; }
  if (a === 'rename-phase') {
    e.preventDefault();
    const f = findPhase(btn.dataset.projectId, btn.dataset.phaseId);
    if (!f) return;
    const v = prompt('단계 이름', f.phase.name);
    if (v && v.trim()) renamePhase(btn.dataset.projectId, btn.dataset.phaseId, v.trim());
    return;
  }
  if (a === 'delete-phase') {
    e.preventDefault();
    if (confirm('이 단계와 안의 모든 할일을 삭제할까요?')) deletePhase(btn.dataset.projectId, btn.dataset.phaseId);
    return;
  }
  if (a === 'rename-project') {
    const f = findProject(btn.dataset.projectId);
    if (!f) return;
    const v = prompt('프로젝트 이름', f.project.name);
    if (v && v.trim()) renameProject(btn.dataset.projectId, v.trim());
    return;
  }
  if (a === 'delete-project') {
    if (confirm('이 프로젝트와 안의 모든 단계/할일을 삭제할까요?')) {
      const pid = btn.dataset.projectId;
      const f = findProject(pid);
      const catId = f?.category.id;
      deleteProject(pid);
      if (catId) navigate(`#/c/${encodeURIComponent(catId)}`);
    }
    return;
  }
  if (a === 'edit-task')   { showEditTaskModal(btn.dataset.taskId); return; }
  if (a === 'delete-task') {
    if (confirm('이 할일을 삭제할까요?')) deleteTask(btn.dataset.taskId);
    return;
  }
  if (a === 'modal-close') { closeModal(); return; }
  if (a === 'reconnect')   { closeModal(); showAuthModal(); return; }
  if (a === 'manual-auth') { showManualAuthModal(); return; }
  if (a === 'restore-revision') { showRestoreModal(); return; }
  if (a === 'restore-version') {
    const version = btn.dataset.version;
    if (!version) return;
    if (!confirm('이 시점으로 복구할까요? 현재 데이터가 교체됩니다.')) return;
    closeModal();
    toast('복구 중...', 3000);
    fetchGistAtVersion(version).then(data => {
      if (!data) { toast('해당 버전 데이터를 읽을 수 없습니다.', 3000); return; }
      state.data = ensureSeed(data);
      saveLocal(state.data);
      pushGist(state.data);
      render();
      toast('복구 완료');
    }).catch(e => toast(`복구 실패: ${e.message}`, 3000));
    return;
  }
  if (a === 'signout') {
    if (confirm('연결을 해제할까요? 로컬에 저장된 데이터는 유지됩니다.')) {
      clearAuth(); closeModal(); showAuthModal();
    }
    return;
  }
});

document.addEventListener('submit', async e => {
  const form = e.target.closest('form');
  if (!form) return;
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form));

  if (form.dataset.modalForm === 'auth') {
    if (!data.pat || !data.gid) return;
    savePat(data.pat.trim());
    saveGistId(data.gid.trim());
    closeModal();
    toast('연결됨, 동기화 중...');
    await connectAndSync();
    return;
  }

  if (form.dataset.modalForm === 'edit-task') {
    const tid = form.dataset.taskId;
    updateTask(tid, {
      title: (data.title || '').trim(),
      memo:  (data.memo  || '').trim(),
      due:   data.due ? new Date(data.due).toISOString() : null,
    });
    closeModal();
    return;
  }

  const a = form.dataset.action;
  if (a === 'add-category') {
    if (data.name?.trim()) { addCategory(data.name.trim()); form.reset(); }
    return;
  }
  if (a === 'add-project') {
    if (data.name?.trim()) { addProject(form.dataset.catId, data.name.trim()); form.reset(); }
    return;
  }
  if (a === 'add-phase') {
    if (data.name?.trim()) { addPhase(form.dataset.projectId, data.name.trim()); form.reset(); }
    return;
  }
  if (a === 'add-task') {
    if (data.title?.trim()) { addTask(form.dataset.projectId, form.dataset.phaseId, data.title.trim()); form.reset(); }
    return;
  }
  if (a === 'add-sub') {
    if (data.text?.trim()) { addSubItem(form.dataset.taskId, data.text.trim()); form.reset(); }
    return;
  }
  if (a === 'add-note') {
    if (data.text?.trim()) { addNote(data.text.trim()); form.reset(); }
    return;
  }
});

// Settings button
document.addEventListener('DOMContentLoaded', () => {
  $('#settings-btn')?.addEventListener('click', showSettingsModal);
});

// ---------- Polling / Online detection ----------
async function pollSync() {
  if (!navigator.onLine || state.pushPending || state.syncStatus === 'syncing') return;
  if (!loadPat() || !loadGistId()) return;
  try {
    const remote = await fetchGist();
    if (!remote || !remote.updatedAt) return;
    const localUpdated = state.data?.updatedAt || '';
    if (remote.updatedAt > localUpdated) {
      state.data = ensureSeed(remote);
      saveLocal(state.data);
      render();
      toast('다른 기기 변경 반영됨');
    }
  } catch (e) {
    console.warn('poll fail', e);
  }
}

window.addEventListener('online',  () => { state.online = true;  setSyncStatus(state.syncStatus); });
window.addEventListener('offline', () => { state.online = false; setSyncStatus(state.syncStatus); });
window.addEventListener('hashchange', render);

// ---------- Live clock ----------
function startLiveClock() {
  const dateEl = document.getElementById('lc-date');
  const timeEl = document.getElementById('lc-time');
  if (!dateEl || !timeEl) return;
  const tick = () => {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    dateEl.textContent = `${yyyy}-${mm}-${dd}`;
    timeEl.textContent = `${hh}:${mi}:${ss}`;
  };
  tick();
  setInterval(tick, 1000);
}

// ---------- Init ----------
async function init() {
  state.data = ensureSeed(loadLocal());
  startLiveClock();
  render();
  historyPush(); // 실행취소 기준점
  if (state.data.updatedAt) {
    lastSavedAt = new Date(state.data.updatedAt);
    const el = $('#last-saved');
    if (el) {
      const hh = String(lastSavedAt.getHours()).padStart(2, '0');
      const mm = String(lastSavedAt.getMinutes()).padStart(2, '0');
      el.textContent = `저장 ${hh}:${mm}`;
      el.title = lastSavedAt.toLocaleString('ko-KR');
    }
  }

  if (!loadPat() || !loadGistId()) {
    showAuthModal();
    return;
  }

  setSyncStatus('syncing');
  try {
    const remote = await fetchGist();
    if (remote && remote.categories) {
      const prevVersion = remote.version || 1;
      state.data = ensureSeed(remote);
      saveLocal(state.data);
      render();
      historyPush(); // 원격 데이터로 갱신된 시점을 새 실행취소 기준점으로
      if (state.data.version > prevVersion) {
        await pushGist(state.data);
        toast('카테고리 업데이트 완료');
      }
    } else if (remote === null) {
      // Gist 파일이 비어있거나 없음 — 로컬에 실제 데이터가 없을 때만 시드 push
      const hasData = state.data.categories.some(c => c.projects.length > 0)
        || (Array.isArray(state.data.notes) && state.data.notes.length > 0);
      if (!hasData) {
        await pushGist(state.data);
      } else {
        toast('Gist가 비어있어 로컬 데이터를 유지합니다. 설정을 확인하세요.', 4000);
      }
    }
    setSyncStatus('idle');
  } catch (e) {
    console.error('초기 동기화 실패', e);
    setSyncStatus('error');
    toast('초기 동기화 실패 — 설정 확인');
  }

  setInterval(pollSync, POLL_MS);
}

init();
