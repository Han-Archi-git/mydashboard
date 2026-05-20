// mydashboard — 단일 페이지 대시보드
// 대분류 → 프로젝트 → 단계 → 할일 (4단계)
// 데이터는 GitHub Private Gist에 저장, LocalStorage 캐시

const PAT_KEY = 'mydashboard_pat';
const GIST_KEY = 'mydashboard_gist_id';
const DATA_KEY = 'mydashboard_data';
const POLL_MS = 5000;
const PUSH_DEBOUNCE = 1500;
const DATA_FILENAME = 'data.json';

const SEED_CATEGORIES = [
  { id: 'personal',             name: '개인',                       color: '#6366f1' },
  { id: 'ilsangmodu_interior',  name: '일상모두_인테리어',          color: '#10b981' },
  { id: 'ilsangmodu_commerce',  name: '일상모두_온라인커머스',      color: '#f59e0b' },
  { id: 'slk',                  name: '(주)SLK종합건축사사무소',    color: '#ef4444' },
];

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
    if (!res.ok) throw new Error(`저장 실패 (${res.status})`);
    setSyncStatus('idle');
  } catch (e) {
    console.error(e);
    setSyncStatus('error');
    toast('저장 실패 — 인터넷/토큰 확인');
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
  // 비어 있을 때만 시드. 이후 사용자가 삭제한 분류는 다시 만들지 않음.
  if (d.categories.length === 0) {
    d.categories = SEED_CATEGORIES.map(c => ({ ...c, projects: [] }));
  }
  for (const c of d.categories) {
    c.projects = Array.isArray(c.projects) ? c.projects : [];
    for (const p of c.projects) {
      p.phases = Array.isArray(p.phases) ? p.phases : [];
      for (const ph of p.phases) {
        ph.tasks = Array.isArray(ph.tasks) ? ph.tasks : [];
      }
    }
  }
  if (!d.version) d.version = 1;
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

function activePhaseIdx(project) {
  // 첫 미완료 단계 인덱스. 모두 완료면 -1.
  for (let i = 0; i < project.phases.length; i++) {
    if (progressOfPhase(project.phases[i]) < 1) return i;
  }
  return -1;
}

function commit() {
  state.data.updatedAt = now();
  saveLocal(state.data);
  schedulePush();
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
  f.phase.tasks.push({ id: uid(), title, done: false, memo: '', due: null });
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

// ---------- Routing ----------
function currentRoute() {
  const hash = location.hash.slice(1) || '/';
  const parts = hash.split('/').filter(Boolean);
  if (!parts.length) return { name: 'home' };
  if (parts[0] === 'c' && parts[1]) return { name: 'category', id: decodeURIComponent(parts[1]) };
  if (parts[0] === 'p' && parts[1]) return { name: 'project',  id: decodeURIComponent(parts[1]) };
  return { name: 'home' };
}
const navigate = h => { location.hash = h; };

// ---------- Render ----------
function render() {
  const root = $('#app');
  const r = currentRoute();
  if (r.name === 'home')      root.innerHTML = renderHome();
  else if (r.name === 'category') root.innerHTML = renderCategory(r.id);
  else if (r.name === 'project')  root.innerHTML = renderProject(r.id);
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

  return `
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
    const isOpen = isActive || ph.tasks.length === 0 || idx === 0;
    const tasks = ph.tasks.map(t => renderTask(t, p.id, ph.id)).join('');
    return `
      <section class="phase ${isActive ? 'active' : ''} ${isOpen ? 'open' : ''}" data-phase-id="${escapeHtml(ph.id)}">
        <header class="phase-head" data-action="toggle-phase">
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
        <li class="sub-item ${s.done ? 'done' : ''}" data-sub-id="${escapeHtml(s.id)}">
          <input type="checkbox" ${s.done ? 'checked' : ''} data-action="toggle-sub" data-task-id="${escapeHtml(t.id)}" data-sub-id="${escapeHtml(s.id)}">
          <span class="sub-text">${escapeHtml(s.text)}</span>
          <button class="row-btn danger" data-action="delete-sub" data-task-id="${escapeHtml(t.id)}" data-sub-id="${escapeHtml(s.id)}" title="삭제">×</button>
        </li>`).join('')}
    </ul>` : '';
  const addSubForm = `
    <form class="add-row sub-add" data-action="add-sub" data-task-id="${escapeHtml(t.id)}">
      <input class="add-input" name="text" placeholder="+ 서류·세부항목 추가 (엔터)" autocomplete="off" required>
      <button class="btn ghost" type="submit">+</button>
    </form>`;

  return `
    <li class="task ${taskDone ? 'done' : ''} ${hasSubs ? 'has-subs' : ''}" data-task-id="${escapeHtml(t.id)}">
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

function showAuthModal() {
  const pat = loadPat() || '';
  const gid = loadGistId() || '';
  showModal(`
    <h2>GitHub 연결</h2>
    <p>Private Gist에 데이터를 저장합니다. <b>처음 한 번만</b> 입력하면 됩니다.</p>
    <form data-modal-form="auth">
      <label>Personal Access Token (PAT)</label>
      <input name="pat" type="password" value="${escapeHtml(pat)}" placeholder="ghp_..." autocomplete="off" required>
      <div class="field-hint"><a href="https://github.com/settings/tokens?type=beta" target="_blank">Fine-grained PAT 발급</a> · Account permissions에서 <b>Gists: Read and write</b> 체크</div>

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
      <button type="button" class="btn ghost" data-action="reconnect">재연결</button>
      <button type="button" class="btn danger" data-action="signout">연결 해제</button>
    </div>
  `);
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
    if (sec) sec.classList.toggle('open');
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
    const n = state.data.notes.find(n => n.id === btn.dataset.noteId);
    if (!n) return;
    const v = prompt('메모 수정', n.text);
    if (v !== null) updateNote(btn.dataset.noteId, v.trim());
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
    try {
      const remote = await fetchGist();
      if (remote && remote.categories) {
        state.data = ensureSeed(remote);
        saveLocal(state.data);
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

// ---------- Init ----------
async function init() {
  state.data = ensureSeed(loadLocal());
  render();

  if (!loadPat() || !loadGistId()) {
    showAuthModal();
    return;
  }

  setSyncStatus('syncing');
  try {
    const remote = await fetchGist();
    if (remote && remote.categories) {
      state.data = ensureSeed(remote);
      saveLocal(state.data);
      render();
    } else if (remote === null) {
      // empty gist — push our seed
      await pushGist(state.data);
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
