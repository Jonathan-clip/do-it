'use strict';
/* ---------- Storage (local now; cloud adapter plugs in here later) ---------- */
const APP_VERSION = '2026-11-26.9-world'; // shown in the "עוד" menu, to check which version a device is running
const DEMO = /(^|[?&#])demo(\b|=)/.test(location.search + location.hash); // ?demo => fictional data, separate storage, no cloud
const KEY = DEMO ? 'doit-demo-v1' : 'doit-data-v1';
const empty = () => ({ visions: [], tasks: [], habits: [], lists: [], goals: [], projects: [], jobs: [], rhythm: [], dayRewards: [], breakIdeas: [], cheers: [], topics: [], sessions: [], assist: {}, rhythmLog: {}, dayLog: {}, review: {}, visual: {}, weeks: {}, notes: {}, journal: {}, focus: {}, org: {} });
const TS_KEY = DEMO ? 'doit-demo-updated-v1' : 'doit-updated-v1';
const SYNC_KEY = DEMO ? 'doit-demo-synced-v1' : 'doit-synced-v1';
// v2 structure: a task that had subtasks becomes a "job" (task) and each subtask an action; every other old task is already an action.
// Ids are derived from the old ids, so two devices migrating independently produce the same items and sync merges them cleanly.
function migrate(d) {
  d = migrate2(d); if (d.v >= 3) return d;
  // v3: the middle "task" layer is gone (project > action > sub-actions). A job that lived outside any project becomes a project; actions keep their data.
  const projs = d.projects = d.projects || [], loose = (d.jobs || []).filter(j => !j.projectId);
  if (loose.length) { try { if (!localStorage.getItem('doit-backup-before-v3')) localStorage.setItem('doit-backup-before-v3', JSON.stringify(d)); } catch (e) {} }
  loose.forEach(j => { const pid = 'pj_' + j.id; if (!projs.some(p => p.id === pid)) projs.push({ id: pid, title: j.title, createdAt: j.createdAt || '', quad: j.quad || '', want: j.want || 0 }); j.projectId = pid; (d.tasks || []).forEach(t => { if (t.jobId === j.id) t.projectId = pid; }); });
  d.v = 3; return d;
}
function migrate2(d) {
  if (d.v >= 2) return d;
  d.jobs = d.jobs || []; const keep = [];
  (d.tasks || []).forEach(t => {
    if (t.subs && t.subs.length) {
      const jid = 'j' + t.id;
      if (!d.jobs.some(j => j.id === jid)) d.jobs.push({ id: jid, title: t.title, projectId: t.projectId || '', notes: t.notes || '', createdAt: t.date || '' });
      t.subs.forEach(s => keep.push({ id: 's' + s.id, title: s.title, date: t.date || null, done: !!(s.done || t.done), priority: t.priority || 0, energy: t.energy || 3, mins: s.mins || Math.min(t.mins || 15, 15), brainless: !!t.brainless, print: !!t.print, visionId: t.visionId || '', projectId: t.projectId || '', notes: '', subs: [], jobId: jid }));
      Object.values(d.focus || {}).forEach(f => { if (f.mitId === t.id) { f.mit = t.title; f.mitId = ''; } });
    } else { t.subs = []; keep.push(t); }
  });
  d.tasks = keep; d.v = 2; return d;
}
const COLS = ['visions', 'tasks', 'habits', 'lists', 'goals', 'projects', 'jobs', 'rhythm', 'dayRewards', 'breakIdeas', 'cheers', 'topics', 'sessions'], MAPS = ['weeks', 'notes', 'journal', 'focus', 'org', 'rhythmLog', 'dayLog', 'review', 'visual', 'assist'];
const hash = str => { let h = 5381; for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0; return h + ':' + str.length; };
function itemHashes(d) { // one entry per collection item / per dated entry, so changes and deletions can be tracked
  const o = {};
  COLS.forEach(c => (d[c] || []).forEach(it => { o[c + ':' + it.id] = hash(JSON.stringify(it)); }));
  MAPS.forEach(m => Object.keys(d[m] || {}).forEach(k => { o[m + '|' + k] = hash(JSON.stringify(d[m][k])); }));
  return o;
}
const Store = {
  data: empty(), snap: {},
  load() {
    try { this.data = Object.assign(empty(), JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) { this.data = empty(); }
    migrate(this.data); this.resnap();
  },
  resnap() { this.snap = itemHashes(this.data); },
  track() { // stamp what changed since the last save; remember deletions as tombstones
    const now = new Date().toISOString(), m = (this.data._meta = this.data._meta || { u: {}, del: {} }), cur = itemHashes(this.data);
    Object.keys(cur).forEach(k => { if (this.snap[k] !== cur[k]) { m.u[k] = now; delete m.del[k]; } });
    Object.keys(this.snap).forEach(k => { if (!(k in cur)) { m.del[k] = now; delete m.u[k]; } });
    const old = new Date(Date.now() - 90 * 864e5).toISOString(); Object.keys(m.del).forEach(k => { if (m.del[k] < old) delete m.del[k]; });
    this.snap = cur;
  },
  save() {
    this.track();
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); localStorage.setItem(TS_KEY, new Date().toISOString()); } catch (e) {}
    Cloud.schedulePush();
  }
};
// Merge two copies item by item: the newer edit of each item wins, a deletion wins over an older edit, nothing is dropped silently.
function mergeData(local, remote) {
  const lm = local._meta || { u: {}, del: {} }, rm = remote._meta || { u: {}, del: {} }, out = empty(), om = (out._meta = { u: {}, del: {} });
  const decide = (key, l, r) => { // returns the winning item (or undefined when deleted)
    const lu = lm.u[key] || '', ru = rm.u[key] || '', ld = lm.del[key] || '', rd = rm.del[key] || '';
    if (l !== undefined && r !== undefined) { const w = lu >= ru ? l : r; om.u[key] = lu >= ru ? lu : ru; return w; }
    const have = l !== undefined ? l : r, hu = l !== undefined ? lu : ru, od = l !== undefined ? rd : ld;
    if (od && od > hu) { om.del[key] = od; return undefined; }
    if (hu) om.u[key] = hu; return have;
  };
  COLS.forEach(c => {
    const L = local[c] || [], R = remote[c] || [], rmap = new Map(R.map(x => [x.id, x])), seen = new Set();
    L.forEach(x => { seen.add(x.id); const w = decide(c + ':' + x.id, x, rmap.get(x.id)); if (w !== undefined) out[c].push(w); });
    R.forEach(x => { if (seen.has(x.id)) return; const w = decide(c + ':' + x.id, undefined, x); if (w !== undefined) out[c].push(w); });
  });
  MAPS.forEach(m => {
    const L = local[m] || {}, R = remote[m] || {};
    new Set([...Object.keys(L), ...Object.keys(R)]).forEach(k => { const w = decide(m + '|' + k, L[k], R[k]); if (w !== undefined) out[m][k] = w; });
  });
  [lm.del, rm.del].forEach(dm => Object.keys(dm).forEach(k => { if (!(k in om.u) && !om.del[k]) om.del[k] = dm[k]; }));
  out.v = 3; return out;
}

/* ---------- Cloud sync (Supabase: table doit_data, one row per user, RLS) ---------- */
const SB_URL = 'https://enzcazdpviwehxonnbrk.supabase.co';
const SB_KEY = 'sb_publishable_w7OeOyy4SoQAJHhEzVpajw_HghVFed-';
const Cloud = {
  sb: null, user: null, status: 'offline', timer: null,
  init() {
    if (DEMO || !window.supabase) return;
    this.sb = window.supabase.createClient(SB_URL, SB_KEY);
    this.sb.auth.onAuthStateChange((ev, session) => {
      this.user = session ? session.user : null;
      if (this.user) setTimeout(() => this.sync(), 0); else { this.status = 'offline'; render(); }
    });
  },
  localTs() { try { return localStorage.getItem(TS_KEY) || ''; } catch (e) { return ''; } },
  async sync() {
    if (!this.user) return;
    this.status = 'syncing'; render();
    const { data: row, error } = await this.sb.from('doit_data').select('data,updated_at').eq('user_id', this.user.id).maybeSingle();
    if (error) { this.status = 'error'; render(); return; }
    const lt = this.localTs(), ls = this.lastSynced(), dirty = !!lt && lt > ls, cloudNew = !!row && row.updated_at > ls;
    if (row && cloudNew && !dirty) { // only the cloud changed: take it
      Store.data = migrate(Object.assign(empty(), row.data)); Store.resnap();
      try { localStorage.setItem(KEY, JSON.stringify(Store.data)); localStorage.setItem(TS_KEY, row.updated_at); localStorage.setItem(SYNC_KEY, row.updated_at); } catch (e) {}
      this.status = 'ok'; render();
    } else if (row && cloudNew && dirty) { // both sides changed (e.g. phone and computer): merge, never overwrite
      Store.data = mergeData(migrate(Store.data), migrate(Object.assign(empty(), row.data))); Store.resnap();
      const now = new Date().toISOString();
      try { localStorage.setItem(KEY, JSON.stringify(Store.data)); localStorage.setItem(TS_KEY, now); } catch (e) {}
      await this.push(); render();
    } else await this.push();
  },
  lastSynced() { try { return localStorage.getItem(SYNC_KEY) || ''; } catch (e) { return ''; } },
  schedulePush() { if (!this.user) return; clearTimeout(this.timer); this.timer = setTimeout(() => this.push(), 800); },
  async push() {
    if (!this.user) return;
    const ts = this.localTs() || new Date().toISOString();
    const { error } = await this.sb.from('doit_data').upsert({ user_id: this.user.id, data: Store.data, updated_at: ts });
    if (!error) { try { localStorage.setItem(SYNC_KEY, ts); } catch (e) {} }
    this.status = error ? 'error' : 'ok'; render();
  }
};
// Pick up changes made on another device when the app comes back to the foreground
document.addEventListener('visibilitychange', () => { if (!document.hidden && Cloud.user && Date.now() - (Cloud.lastPull || 0) > 15000) { Cloud.lastPull = Date.now(); Cloud.sync(); } });
Store.load();
const D = () => Store.data;
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

/* ---------- Helpers ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return fmt(d); };
const TODAY = () => fmt(new Date());
const DAYN = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const DAYS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];
const MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const longDate = s => { const d = parse(s); return `יום ${DAYN[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; };
const shortDate = s => { const d = parse(s); return `${d.getDate()}/${d.getMonth() + 1}`; };
const weekStart = s => addDays(s, -parse(s).getDay());
const visionName = id => (D().visions.find(v => v.id === id) || {}).title;

// Secondary sections live behind the "עוד" tab to keep the main navigation simple.
/* ---------- Journal: thoughts (shared with the daily note), a photo of the day and wins ---------- */
const jEntry = d => { const e = D().journal[d] || {}; return { photo: e.photo || '', wins: e.wins || [] }; };
const jSet = d => (D().journal[d] = Object.assign({ photo: '', wins: [] }, D().journal[d]));
const journalDays = () => [...new Set([...Object.keys(D().notes).filter(k => (D().notes[k] || '').trim()), ...Object.keys(D().journal).filter(k => { const e = jEntry(k); return e.photo || e.wins.length; })])].sort().reverse();
function shrinkPhoto(file, cb) { // downscale so the data fits comfortably in local storage and cloud sync
  const r = new FileReader();
  r.onload = () => { const im = new Image(); im.onload = () => {
    const k = Math.min(1, 900 / Math.max(im.width, im.height)), c = document.createElement('canvas');
    c.width = Math.round(im.width * k); c.height = Math.round(im.height * k);
    c.getContext('2d').drawImage(im, 0, 0, c.width, c.height); cb(c.toDataURL('image/jpeg', 0.72));
  }; im.src = r.result; };
  r.readAsDataURL(file);
}
const MORE_TABS = ['week', 'journal', 'rhythm', 'dayrewards', 'matrix', 'assistant', 'assistmem', 'tasks', 'projects', 'habits', 'goals', 'vision', 'lists'];
const state = { tab: 'today', date: TODAY(), upStart: TODAY(), upDays: 14, upMode: 'three', up3: TODAY(), upWeek: weekStart(TODAY()), upMonth: TODAY().slice(0, 7), upSel: TODAY(), taskFilter: 'open', allMode: 'list', jDate: TODAY(), openList: null, openProject: null, openJob: null, goalFilter: 'active', weekStart: weekStart(TODAY()) };
try { if (D().assist && D().assist.homeTab === 'map') state.tab = 'map'; } catch (e) {}
state.mode = (() => { try { const m = localStorage.getItem('doit-mode'); if (m === 'plan' || m === 'do') return m; } catch (e) {} return window.matchMedia && matchMedia('(max-width: 700px)').matches ? 'do' : 'plan'; })();
// Weekly vision data lives in D().weeks[<Sunday date>]; created lazily on first edit.
const weekData = ws => (D().weeks[ws] = D().weeks[ws] || { vision: '', outcomes: [], visionIds: [], worked: '', improve: '' });

/* ---------- Domain ---------- */
// High-energy tasks always come first in the day; then by priority.
const taskOrder = (d, a, b) => { // a manual drag order wins; otherwise today's order follows the energy mode chosen by the user
  if (a.ord !== undefined && b.ord !== undefined) return a.ord - b.ord;
  if (a.ord !== undefined) return -1;
  if (b.ord !== undefined) return 1;
  const m = d === TODAY() ? normEnergy((D().focus[d] || {}).energy) : '', e = x => x.energy || 3, p = x => { const q = effQuad(x); return q ? ({ q1: 4, q2: 3, q3: 2, q4: 0 })[q] : 1 + (x.priority || 0) * 0.5; };
  if (m === 'midlow' || m === 'tired' || m === 'flood' || m === 'focus') return e(a) - e(b) || p(b) - p(a); // gentler states: easy actions first
  return (b.energy || 0) - (a.energy || 0) || p(b) - p(a);
};
const tasksOn = d => D().tasks.filter(t => t.date === d).sort((a, b) => taskOrder(d, a, b) || (b.want || 0) - (a.want || 0));
const stars = n => '★'.repeat(n || 0);
const logoMark = (s = 32) => `<svg class="logo" width="${s}" height="${s}" viewBox="0 0 512 512" role="img" aria-label="Do It"><rect width="512" height="512" rx="112" fill="#1f6f5c"/><path d="M130 270l90 90 170-190" fill="none" stroke="#fff" stroke-width="52" stroke-linecap="round" stroke-linejoin="round"/><circle cx="390" cy="170" r="36" fill="#e8a33d"/></svg>`;
/* Projects: a project groups several tasks (task.projectId). Deleting a project keeps its tasks. */
const projectName = id => (D().projects.find(p => p.id === id) || {}).title;
// "Project: action" prefix for titles (skipped inside that project's own screen)
const titleP = t => { const n = t.projectId && projectName(t.projectId); return (n && state.openProject !== t.projectId ? '<span class="ptag"><bdi>' + esc(n) + '</bdi>:</span> ' : '') + esc(t.title); };
const projectChip = t => t.projectId && projectName(t.projectId) ? `<span class="chip" style="background:var(--info-bg);color:var(--info-ink)">📁 ${esc(projectName(t.projectId))}</span>` : '';
const projectOpts = sel => `<option value="">ללא פרויקט</option>${D().projects.map(p => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.title)}</option>`).join('')}<option value="__new__">＋ פרויקט חדש...</option>`;
function newProject() {
  const title = (prompt('שם הפרויקט החדש') || '').trim();
  if (!title) return null;
  const p = { id: uid(), title, createdAt: TODAY() }; D().projects.push(p); Store.save(); return p;
}
const projState = p => {
  const ts = D().tasks.filter(t => t.projectId === p.id), done = ts.filter(t => t.done).length;
  return { ts, done, total: ts.length, pct: ts.length ? Math.round(done / ts.length * 100) : 0, mins: ts.filter(t => !t.done).reduce((s, t) => s + (t.mins || 0), 0) };
};
// Chevron icons drawn as SVG (text arrows rendered inconsistently). In RTL "previous/back" points right, "next" points left.
const chev = dir => `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" style="display:block"><path d="${dir === 'r' ? 'M9 5l7 7-7 7' : 'M15 5l-7 7 7 7'}" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const subProg = t => (t.subs && t.subs.length) ? `${t.subs.filter(s => s.done).length}/${t.subs.length}` : '';
const overdue = () => D().tasks.filter(t => !t.done && t.date && t.date < TODAY());
const habitsOn = d => D().habits.filter(h => h.days.includes(parse(d).getDay())).sort((a, b) => (b.energy || 0) - (a.energy || 0));
const habitDone = (h, d) => !!h.log[d];
function streak(h) {
  // consecutive scheduled days completed; unscheduled days are skipped; today doesn't break the streak
  let n = 0, d = TODAY();
  for (let i = 0; i < 1000; i++, d = addDays(d, -1)) {
    if (!h.days.includes(parse(d).getDay())) continue;
    if (habitDone(h, d)) n++;
    else if (d !== TODAY()) break;
  }
  return n;
}

/* ---------- Goals & rewards: progress tracking ---------- */
function goalState(g) {
  const T = TODAY();
  let p = 0;
  if (g.type === 'habit') {
    const h = D().habits.find(x => x.id === g.habitId);
    if (h) p = Object.keys(h.log).filter(d => d >= g.start && d <= T && (!g.deadline || d <= g.deadline)).length;
  } else p = (g.entries || []).reduce((s, e) => s + e.amt, 0);
  const target = g.target || 1, pct = Math.min(100, Math.round(p / target * 100));
  const achieved = p >= target, missed = !achieved && !!g.deadline && g.deadline < T;
  let left = null, status = 'ontrack';
  if (g.deadline) {
    const day = 86400000;
    left = Math.round((parse(g.deadline) - parse(T)) / day);
    const total = Math.max(1, Math.round((parse(g.deadline) - parse(g.start)) / day) + 1);
    const elapsed = Math.min(total, Math.max(0, Math.round((parse(T) - parse(g.start)) / day) + 1));
    if (!achieved && p < target * elapsed / total * 0.9) status = 'behind';
  }
  return { p, target, pct, achieved, missed, left, status };
}
function goalCard({ g, s }) {
  const v = g.visionId ? visionName(g.visionId) : '';
  const chip = s.achieved ? '<span class="chip">✓ הושג</span>'
    : s.missed ? '<span class="chip" style="background:var(--bad-bg);color:var(--danger)">עבר המועד</span>'
    : s.status === 'behind' ? '<span class="chip" style="background:var(--warn-bg);color:var(--warn-ink)">מאחר בלוח הזמנים</span>' : '<span class="chip">בדרך</span>';
  return `<div class="card">
   <div class="row"><div class="grow" data-act="editGoal" data-id="${g.id}"><div class="t"><b>${esc(g.title)}</b></div>
   <div class="meta">${chip}${g.deadline ? `<span>${s.left >= 0 ? `עוד ${s.left} ימים` : 'עד ' + shortDate(g.deadline)}</span>` : ''}${g.type === 'habit' ? '<span>🔁 אוטומטי</span>' : ''}${v ? `<span class="chip">${esc(v)}</span>` : ''}</div></div>
   ${g.type !== 'habit' && !s.achieved ? `<button class="iconbtn" data-act="goalAdd" data-id="${g.id}">+ התקדמות</button>` : ''}</div>
   <div class="bar"><div style="width:${s.pct}%"></div></div>
   <div class="sub">${s.p}/${s.target} ${esc(g.unit || '')} · ${s.pct}%</div>
   ${g.reward ? `<div class="meta" style="margin-top:6px">🎁 ${esc(g.reward)}${g.claimed ? ' · מומש ✓' : ''}</div>` : ''}
   ${s.achieved && g.reward && !g.claimed ? `<button class="btn" style="margin-top:8px;width:100%" data-act="goalClaim" data-id="${g.id}">🎁 מימשתי את התגמול</button>` : ''}</div>`;
}

/* ---------- Rendering ---------- */
/* ---------- Energy mode, "my three tasks", quick capture, start-now timer, stuck, what's next ---------- */
const ENERGY_MODES = [['high', '⚡ אנרגיה גבוהה'], ['midlow', '🙂 בינונית או נמוכה'], ['tired', '😴 עייפות'], ['flood', '🌊 הצפה'], ['judge', '🪞 שיפוטיות'], ['focus', '🎯 חוסר ריכוז'], ['victim', '🥀 אני קורבן']];
function energyBar(d) {
  if (d !== TODAY()) return '';
  const cur = focusOn(d).energy;
  return `<div class="ebar"><label class="sub" for="energySel" style="margin:0">האנרגיה שלי עכשיו:</label><select id="energySel" class="esel ${cur ? 'set' : ''}"><option value="">בחר מצב...</option>${ENERGY_MODES.map(([v, l]) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${l}</option>`).join('')}</select>${cur ? '<button class="iconbtn" data-act="energyHelpOpen" aria-label="הצעות למצב הנוכחי">💡</button>' : ''}</div>`;
}
// Actions left undone on a past day move to "no date" by themselves (t.from remembers the day, for the morning summary and "carry over")
const wasOn = d => tasksOn(d).concat(D().tasks.filter(t => !t.date && !t.done && t.from === d));
const yesterdayLeft = () => wasOn(addDays(TODAY(), -1)).filter(t => !t.done);
function sweepPast() {
  const T = TODAY(); if (state.sweptDay === T) return; state.sweptDay = T;
  const L = D().tasks.filter(t => t.date && t.date < T && !t.done); if (!L.length) return;
  state.sweepUndo = L.map(t => [t.id, t.date]);
  L.forEach(t => { t.from = t.date; t.date = null; delete t.ord; }); Store.save();
  setTimeout(() => toast('<span>' + L.length + ' פעולות שלא בוצעו הועברו ל"ללא תאריך"</span><button class="btn" data-act="undoSweep">בטל</button><button data-act="toastClose">✕</button>', 9000), 700);
}
function doneSection(d, ts, hs) {
  const rows = [], isToday = d === TODAY();
  ts.filter(t => t.done).forEach(t => rows.push(taskRow(t)));
  hs.filter(h => habitDone(h, d)).forEach(h => rows.push(habitRow(h, d)));
  if (isToday) {
    const log = D().rhythmLog[d] || {};
    rhythmSorted().filter(r => log[r.id]).forEach(r => rows.push('<div class="card row done"><button class="check on" data-act="rhythmDone" data-id="' + r.id + '" aria-label="בטל">✓</button><div class="grow"><div class="t">' + (r.kind === 'meal' ? '🍽' : '😌') + ' ' + esc(r.label) + '</div><div class="meta"><span>' + r.time + '</span></div></div></div>'));
    if (D().visual[d]) rows.push('<div class="card row done"><span style="font-size:20px">🧘</span><div class="grow"><div class="t">דמיון מודרך של הבוקר</div></div><button class="iconbtn" data-act="visStart">↺ שוב</button></div>');
    const rs = rewardState(d); if (rs.rule && rs.claimed) rows.push('<div class="card row done"><span style="font-size:20px">🎁</span><div class="grow"><div class="t">מימשת: ' + esc(rs.picked) + '</div></div></div>');
    if (orgDone(d)) rows.push('<div class="card row done"><span style="font-size:20px">🗂</span><div class="grow"><div class="t">ארגון</div></div></div>');
  }
  if (!rows.length) return '';
  return '<details class="donesec" id="doneSec" ' + (state.doneOpen ? 'open' : '') + '><summary>✓ בוצע (' + rows.length + ')</summary>' + rows.join('') + '</details>';
}
function tasksBlock(d, ts) {
  const open = ts.filter(t => !t.done), f = focusOn(d);
  const rows = list => list.map(t => taskRow(t)).join('');
  if (!ts.length) return d === TODAY() ? '' : '<div class="empty">אין פעולות ליום הזה</div>';
  if (state.showAll) return rows(open) + (open.length > 3 ? '<button class="btn ghost more3" data-act="toggleShowAll">הצג רק שלוש</button>' : '') + (ts.some(t => t.ord !== undefined) ? '<button class="lnk" data-act="resetOrder">↺ חזרה לסדר אוטומטי</button>' : '');
  const manual = ts.some(t => t.ord !== undefined), first = open.filter(t => t.id === f.mitId), pick = (manual ? open : [...first, ...open.filter(t => t.id !== f.mitId)]).slice(0, f.energy === 'flood' ? 1 : 3);
  const hidden = open.length - pick.length;
  return (pick.length ? rows(pick) : '<div class="empty">🎉 סיימת את כל הפעולות להיום</div>')
    + (manual ? '<button class="lnk" data-act="resetOrder">↺ חזרה לסדר אוטומטי</button>' : '')
    + (hidden > 0 ? `<button class="btn ghost more3" data-act="toggleShowAll">הצג את כל הפעולות (${hidden} נוספות)</button>` : '');
}
function nextTask(excludeId) { // the single suggestion after finishing: the MIT first, then by the current order
  const T = TODAY(), f = focusOn(T), open = tasksOn(T).filter(t => !t.done && t.id !== excludeId);
  return open.find(t => t.id === f.mitId) || open[0] || null;
}
function toast(html, ms = 9000) {
  const el = $('#toast'); el.innerHTML = html; el.hidden = false; clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, ms);
}
function showNext(doneId) {
  if (notifyLevel() === 'quiet') { const q = doneId ? findTask(doneId) : null; if (q && q.done) toast('<span>✓ "' + esc(q.title) + '" סומנה כבוצעה</span><button data-act="toastClose" aria-label="סגור">✕</button>', 2500); return; }
  const n = nextTask(doneId);
  if (!n) { const d0 = doneId ? findTask(doneId) : null; toast('<span>' + (d0 && d0.done ? '✓ "' + esc(d0.title) + '" סומנה כבוצעה. ' : '') + '🎉 סיימת את פעולות היום</span><button data-act="toastClose">✕</button>', 6000); return; }
  const q = quadOf(effQuad(n)), why = [q ? q[1] : ''].filter(Boolean).join(' · ');
  const dn = doneId ? findTask(doneId) : null;
  toast('<span>' + (dn && dn.done ? '✓ "' + esc(dn.title) + '" סומנה כבוצעה. ' : '') + 'ההצעה הבאה: <b>' + esc(n.title) + '</b>' + (why ? ' (' + why + ')' : '') + '</span><button class="btn" data-act="runStart" data-id="' + n.id + '">◀ התחל עכשיו</button><button class="btn ghost" data-act="chooseOther">בחר פעולה אחרת</button><button class="btn ghost" data-act="runBreak">☕ אני צריך הפסקה</button><button data-act="toastClose" aria-label="סגור">✕</button>');
}
/* Quick capture: one field, no date/energy/priority; classified later in the daily "ארגון" */
let captured = 0;
function captureSheet() {
  sheet(`<h1>💭 מה עובר לי בראש?</h1><p class="sub">שורה מהירה לרשימה, ותארגן אחר כך בתהליך "ארגון". או לפרוק הכל ולעשות סדר עם העוזר.</p>
   <form id="capForm"><div class="row"><input id="capText" placeholder="מה עולה לך?" autocomplete="off" autofocus><button class="btn">הוסף</button></div>
   <label>פרויקט (אופציונלי)</label><select id="capProj"><option value="">ללא פרויקט</option>${D().projects.map(p => `<option value="${p.id}">📁 ${esc(p.title)}</option>`).join('')}</select>
   <label>דחוף / חשוב (אופציונלי)</label><select id="capQuad"><option value="">ללא סיווג</option>${QUADS.map(q => `<option value="${q[0]}">${q[1]}</option>`).join('')}</select></form>
   <div id="capDone" class="sub" style="margin-top:8px">${captured ? `נקלטו ${captured} ✓` : ''}</div>
   <button class="btn" style="width:100%;margin-top:12px" data-act="asstFromCapture">🧠 לפרוק ולעשות סדר עם העוזר</button>
   <div class="actions"><button class="btn ghost" data-act="close">סגור</button></div>`);
  $('#capForm').onsubmit = e => {
    e.preventDefault(); const txt = $('#capText').value.trim(); if (!txt) return;
    D().tasks.push({ id: uid(), title: txt, date: null, done: false, priority: 0, energy: 0, mins: 0, brainless: false, print: false, visionId: '', projectId: $('#capProj').value, notes: '', subs: [], inbox: true, quad: $('#capQuad').value, ...($('#capQuad').value ? { priority: quadPri[$('#capQuad').value] } : {}) });
    Store.save(); render(); captured++; $('#capDone').textContent = `נקלטו ${captured} ✓`; $('#capText').value = ''; $('#capText').focus();
  };
}
/* Start now: a clean screen with one task, its first step and a 5/15/25 minute timer */
const Run = { id: null, total: 0, left: 0, endAt: 0, running: false, ended: false, tick: null, brk: false };
function runBeep() {
  try { const c = new (window.AudioContext || window.webkitAudioContext)(), o = c.createOscillator(), g = c.createGain(); o.connect(g); g.connect(c.destination); o.frequency.value = 660; g.gain.value = 0.15; o.start(); o.stop(c.currentTime + 0.4); } catch (e) {}
  try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch (e) {}
}
const mmss = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
function runOpen(id, brk, bmins, blabel, rid) {
  clearInterval(Run.tick); closeSheet();
  if (!brk && id) Work.last = id;
  Object.assign(Run, { mini: false, idea: brk ? pickIdea() : '', id: brk ? null : id, brk: !!brk, running: false, ended: false, label: blabel || '', rhythmId: rid || '', brkStarted: false, pomo: false });
  const t = findTask(id);
  const pick = brk ? (bmins || 10) : [5, 15, 25].reduce((a, m) => Math.abs(m - ((t && t.mins) || 15)) < Math.abs(a - ((t && t.mins) || 15)) ? m : a, 15);
  Run.total = Run.left = pick * 60; runRender(); $('#run').hidden = false; document.body.classList.add('running');
}
function runClose() { clearInterval(Run.tick); Run.running = false; Run.mini = false; $('#run').hidden = true; $('#run').classList.remove('mini'); document.body.classList.remove('running', 'miniRun'); render(); }
function runRender() {
  const t = Run.brk ? null : findTask(Run.id), el = $('#run');
  if (!Run.brk && !t) return runClose();
  if (Run.mini) { // minimized: a compact bar above the navigation
    el.classList.add('mini'); document.body.classList.remove('running'); document.body.classList.add('miniRun');
    el.innerHTML = '<div class="miniinfo" data-act="runExpand"><div class="t">' + (Run.brk ? esc(Run.label || '☕ הפסקה') : esc(t.title)) + '</div><div class="sub">' + (Run.ended ? 'הזמן נגמר' : Run.running ? 'רץ ברקע' : 'מושהה') + '</div></div><div class="minitime" id="runTime">' + mmss(Run.left) + '</div><button class="iconbtn" data-act="runToggle" aria-label="השהה או המשך">' + (Run.running ? '⏸' : '◀') + '</button>' + (Run.brk ? '' : '<button class="iconbtn" data-act="runDone" aria-label="סיימתי">✓</button>') + '<button class="iconbtn" data-act="runExpand" aria-label="הרחב">⤢</button>';
    return;
  }
  el.classList.remove('mini'); document.body.classList.remove('miniRun'); document.body.classList.add('running');
  const step = t ? ((t.subs || []).find(s => !s.done) || {}).title || t.first || '' : '';
  const mins = Run.brk ? [...new Set([5, 10, Math.round(Run.total / 60)])].sort((a, b) => a - b) : [5, 15, 25];
  el.innerHTML = `<div class="runbox">
    <button class="iconbtn runx" data-act="runClose" aria-label="סגור">✕</button><button class="iconbtn runmin" data-act="runMinimize" aria-label="מזער, הטיימר ממשיך ברקע">▁ מזער</button>
    <div class="sub">${Run.brk ? 'הפסקה' : 'עכשיו עובדים על'}</div>
    <h1>${Run.brk ? esc(Run.label || '☕ הפסקה') : esc(t.title)}</h1>
    ${Run.brk && !Run.ended && Run.idea ? '<div class="remind" style="margin:6px 0">💡 ' + esc(Run.idea) + ' <button type="button" class="iconbtn" data-act="nextIdea" aria-label="רעיון אחר">↻</button></div>' : ''}
    ${!Run.brk && t && t.notes ? '<div class="sub" style="white-space:pre-wrap;margin:-6px 0 12px">' + esc(t.notes) + '</div>' : ''}
    ${Run.brk ? '' : `<label class="sub">הצעד הראשון</label><input id="runStep" value="${esc(step)}" placeholder="מה הדבר הראשון והקטן שעושים?" autocomplete="off" ${(t.subs || []).some(s => !s.done) ? 'readonly' : ''}>`}
    <div class="opt runmins">${mins.map(m => `<button class="${Run.total === m * 60 ? 'on' : ''}" data-act="runMins" data-m="${m}" ${Run.running ? 'disabled' : ''}>${m} ד׳</button>`).join('')}</div>
    <div class="remind" style="margin-top:14px">💬 ${esc(reminder())}</div>
    <div class="runtime ${Run.ended ? 'end' : ''}" id="runTime">${mmss(Run.left)}</div>
    ${Run.ended ? `<div class="sub" style="text-align:center">${Run.brk ? 'ההפסקה נגמרה' : 'הזמן נגמר. איך הלך?'}</div>` : ''}
    <div class="grid2">
      ${Run.ended ? (Run.brk ? '<button class="btn" data-act="runNext">חזרה לעבודה</button>' : '<button class="btn" data-act="runDone">✓ סיימתי</button><button class="btn ghost" data-act="runMore">עוד 5 דקות</button>' + (Run.pomo ? '<button class="btn ghost" data-act="runBreakMin" data-m="5" data-l="🍅 הפסקת פומודורו">☕ הפסקה 5 דקות</button>' : ''))
        : `<button class="btn" data-act="runToggle">${Run.running ? '⏸ השהה' : '◀ התחל'}</button>${Run.brk ? '<button class="btn ghost" data-act="runNext">דלג</button>' + (Run.rhythmId ? '<button class="btn ghost" data-act="rhythmDoneRun">✓ ' + ((D().rhythm.find(x => x.id === Run.rhythmId) || {}).kind === 'rest' ? 'כבר נחתי' : 'כבר אכלתי') + '</button>' : '') : '<button class="btn ghost" data-act="runDone">✓ סיימתי</button>'}`}
      ${Run.brk ? '' : '<button class="btn ghost" data-act="stuck">🤝 נתקעתי</button>'}
    </div></div>`;
  const si = $('#runStep'); if (si) si.oninput = () => { t.first = si.value; Store.save(); };
}
function runTick() {
  Run.left = Math.max(0, Math.round((Run.endAt - Date.now()) / 1000));
  const el = $('#runTime'); if (el) el.textContent = mmss(Run.left);
  if (Run.left <= 0) { clearInterval(Run.tick); Run.running = false; Run.ended = true; Run.mini = false; if (!Run.brk) { addWork(Run.total / 60); Work.skipId = Run.id; } runBeep(); runRender(); }
}
function runStartTimer() { Run.endAt = Date.now() + Run.left * 1000; Run.running = true; if (Run.brk) Run.brkStarted = true; clearInterval(Run.tick); Run.tick = setInterval(runTick, 250); runRender(); }
function cheerSheet(id) {
  const c = id ? cheerAll().find(x => x.id === id) : null; if (id && !c) return;
  sheet(`<h1>${c ? '✏️ עריכת משפט' : '＋ משפט חדש'}</h1><form id="chForm"><textarea id="chText" rows="3" maxlength="240" placeholder="משפט שמחזק אותי" required>${esc(c ? c.text : '')}</textarea>
   <label>קטגוריה</label><select id="chCat">${CHEER_CATS.map(([k, l]) => `<option value="${k}" ${(c ? c.cat : state.cheerCat || 'gen') === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
   <div class="actions"><button type="button" class="btn ghost" data-act="close">ביטול</button><button class="btn">שמור</button></div></form>`);
  const ta = $('#chText'); ta.focus();
  $('#chForm').onsubmit = ev => { ev.preventDefault(); const t = ta.value.trim(); if (t) { if (c) { c.text = t; c.cat = $('#chCat').value; } else cheerAll().push({ id: uid(), cat: $('#chCat').value, text: t }); Store.save(); } closeSheet(); render(); };
}
function stuckSheet() {
  state.stuckShift = Math.floor(Math.random() * 1000);
  const T = TODAY(), t = findTask(Run.id), easy = t && tasksOn(T).filter(x => !x.done && x.id !== t.id).sort((a, b) => (a.energy || 3) - (b.energy || 3))[0];
  sheet(`<h1>זה קורה 🤝</h1><div class="remind" id="stuckCheer" data-act="stuckCheer" title="לחץ למשפט אחר">💬 ${esc(stuckLine())}</div><p class="sub">בוא נקל על זה. בחר מה מתאים עכשיו:</p>
   <div class="grid2">
     <button class="btn ghost" data-act="stuckSmall">🔹 לפרק לצעד קטן יותר</button>
     <button class="btn ghost" data-act="stuckTwo">⏱ רק שתי דקות</button>
     ${easy ? `<button class="btn ghost" data-act="stuckEasy" data-id="${easy.id}">🍃 לפעולה קלה: ${esc(easy.title)}</button>` : ''}
     <button class="btn ghost" data-act="stuckLater">📆 לחזור אליה אחר כך</button>
   </div><div class="actions"><button class="btn ghost" data-act="stuckClose">חזרה</button></div>`);
}
/* ---------- Structure: project > task (a "job", D().jobs) > action (D().tasks, the unit that gets a date, energy and duration) ---------- */
const findJob = id => D().jobs.find(j => j.id === id);
const jobName = id => (findJob(id) || {}).title;
const jobChip = t => t.jobId && jobName(t.jobId) ? `<span class="chip" data-act="openJob" data-id="${t.jobId}">🧩 ${esc(jobName(t.jobId))}</span>` : '';
const jobState = j => {
  const ts = D().tasks.filter(t => t.jobId === j.id), done = ts.filter(t => t.done).length;
  return { ts, done, total: ts.length, pct: ts.length ? Math.round(done / ts.length * 100) : 0, mins: ts.filter(t => !t.done).reduce((s, t) => s + (t.mins || 0), 0) };
};
const syncJob = j => D().tasks.forEach(t => { if (t.jobId === j.id) t.projectId = j.projectId; }); // an action always carries its task's project
function ownerOpts(sel) { // "belongs to": no project, or a project
  const opt = (v, l) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${l}</option>`;
  return opt('', 'ללא פרויקט') + D().projects.map(p => opt('p:' + p.id, '📁 ' + esc(p.title))).join('') + '<option value="__new__">＋ פרויקט חדש...</option>';
}
const projCard = t => '<div class="ucard mx" data-task="' + t.id + '" data-act="taskMenu" data-id="' + t.id + '"><div class="t">' + esc(t.title) + '</div><div class="meta">' + (t.date ? '<span>' + (t.date === TODAY() ? 'היום' : shortDate(t.date)) + '</span>' : '') + '</div></div>';
const allSeg = () => '<div class="seg"><button class="' + (state.allMode === 'list' ? 'on' : '') + '" data-act="allMode" data-m="list">📋 רשימה</button><button class="' + (state.allMode === 'projects' ? 'on' : '') + '" data-act="allMode" data-m="projects">📁 לפי פרויקטים</button><button class="' + (state.allMode === 'matrix' ? 'on' : '') + '" data-act="allMode" data-m="matrix">🧭 לפי עדיפות</button><button class="' + (state.allMode === 'done' ? 'on' : '') + '" data-act="allMode" data-m="done">✅ בוצע</button></div>';
function projectsBoard() { // "כל הפעולות" grouped by project: compact rows, drag an action onto a row to assign it
  const open = D().tasks.filter(t => !t.done), cap = 8, po = state.projOpen = state.projOpen || {};
  const isOpen = id => po[id] === undefined ? id === 'none' : po[id];
  const sec = p => { const ts = open.filter(t => t.projectId === p.id), s = projState(p), o = isOpen(p.id);
    return '<section class="prow" data-drop="p:' + p.id + '"><div class="prh"><b class="grow" data-act="projToggle" data-id="' + p.id + '"><bdi>' + esc(p.title) + '</bdi></b><span class="sub">' + s.done + '/' + s.total + '</span><button class="lnk" data-act="renameProject" data-id="' + p.id + '">עריכה</button></div><div class="bar thin"><div style="width:' + s.pct + '%"></div></div>'
      + (o ? '<div class="pbody">' + ts.slice(0, cap).map(projCard).join('') + (ts.length > cap ? '<div class="sub">ועוד ' + (ts.length - cap) + ' פעולות</div>' : '') + (ts.length ? '' : '<div class="sub mxempty">גרור לכאן פעולה</div>') + '<button class="lnk" data-act="openProject" data-id="' + p.id + '">פתח את הפרויקט</button></div>' : '') + '</section>'; };
  const free = open.filter(t => !t.projectId || !D().projects.some(p => p.id === t.projectId)).sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));
  return '<div class="top"><h1>כל הפעולות</h1><div class="sw"><button class="iconbtn" data-act="addProject">＋ פרויקט</button></div></div>' + allSeg()
    + '<div class="sub" style="margin:6px 0">לחיצה על שם פרויקט פותחת את הפעולות שלו. גרור פעולה (בטלפון: לחיצה ארוכה ואז גרירה) אל שורת פרויקט כדי לשייך אותה.</div>'
    + D().projects.map(sec).join('') + '<section class="prow none" data-drop="p:none"><div class="prh"><b class="grow" data-act="projToggle" data-id="none">ללא פרויקט</b><span class="sub">' + free.length + '</span></div>' + (isOpen('none') ? '<div class="pbody">' + (free.slice(0, 40).map(projCard).join('') || '<div class="sub mxempty">כל הפעולות משויכות לפרויקט</div>') + (free.length > 40 ? '<div class="sub">ועוד ' + (free.length - 40) + '. עבור לתצוגת רשימה כדי לראות הכל.</div>' : '') + '</div>' : '') + '</section>'
    + '<button class="fab" data-act="addTask">+</button>';
}
/* ---------- Wellbeing: energy states with suggestions, rhythm (meals / rest / hourly break), day start & end, deferral nudge, morning review ---------- */
const normEnergy = v => (v === 'low' || v === 'mid') ? 'midlow' : (v || '');
const fo = d => (D().focus[d] = D().focus[d] || {});
const nowHM = () => { const n = new Date(); return pad(n.getHours()) + ':' + pad(n.getMinutes()); };
const toMin = hm => (+hm.slice(0, 2)) * 60 + (+hm.slice(3, 5));
const fmtDur = m => { const h = Math.floor(m / 60), r = m % 60; return h ? `${h} שעות${r ? ` ו-${r} דק׳` : ''}` : `${r} דק׳`; };
const easiest = () => { const T = TODAY(); return D().tasks.filter(t => !t.done && t.date === T).sort((a, b) => (b.brainless ? 1 : 0) - (a.brainless ? 1 : 0) || (a.energy || 3) - (b.energy || 3))[0] || null; };

/* Energy: each state comes with a concrete suggestion */
function energyHelp(v) {
  if (v === 'focus') return focusHelp();
  if (v === 'victim') return victimHelp();
  const T = TODAY(), f = focusOn(T), easy = easiest(), mit = f.mitId ? findTask(f.mitId) : null, first = nextTask('');
  const b = (act, label, extra = '') => `<button class="btn ghost" data-act="${act}" ${extra}>${label}</button>`;
  const M = {
    high: ['⚡ אנרגיה גבוהה', ['זה הזמן לדבר הקשה והחשוב, לפני שהאנרגיה יורדת.', 'בלוק אחד של 25 דקות בלי הפרעות, ואז הפסקה.'],
      [mit && !mit.done ? b('runStart', '◀ להתחיל את הפעולה החשובה', `data-id="${mit.id}"`) : '', first ? b('runStart', '◀ להתחיל: ' + esc(first.title), `data-id="${first.id}"`) : '']],
    midlow: ['🙂 אנרגיה בינונית או נמוכה', ['לא מכריחים. מתחילים בקל ובקצר, וצוברים תנופה.', 'סידרתי את היום כך שהפעולות הקלות קודם.', 'שלוש פעולות להיום מספיקות.'],
      [easy ? b('runStart', '🍃 פעולה קלה: ' + esc(easy.title), `data-id="${easy.id}"`) : '', b('runBreakMin', '☕ הפסקה של 10 דקות', 'data-m="10" data-l="☕ הפסקה"')]],
    tired: ['😴 עייפות', ['עייפות היא מידע, לא כישלון.', 'בחר אחד מהשלושה:'],
      [b('brainlessList', '⚡ עבור לביצוע פעולות brainless'), b('runBreakMin', '💪 בצע פושאפס', 'data-m="2" data-l="💪 פושאפס"'), b('runBreakMin', '🛋 לך תנוח לחצי שעה', 'data-m="30" data-l="🛋 מנוחה של חצי שעה"')]],
    flood: ['🌊 הצפה', ['עוצרים הכל לדקה. נשימה איטית: שאיפה 4, נשיפה 6.', 'פורקים הכל לדף, בלי לארגן (הכפתור 💭).', 'מציגים רק פעולה אחת. השאר מחכות.'],
      [b('runBreakMin', '🫁 דקה של נשימה', 'data-m="1" data-l="🫁 נושמים לאט"'), b('capture', '💭 לפרוק הכל לדף'), easy ? b('runStart', '◀ פעולה אחת: ' + esc(easy.title), `data-id="${easy.id}"`) : '']],
    judge: ['🪞 שיפוטיות', ['"' + REMINDERS[1] + '"', 'הקול הפנימי הזה לא מדד של האמת. משווים רק לעצמך של אתמול.', 'כתוב הצלחה אחת קטנה, ואז שתי דקות בלבד על פעולה קלה, בלי חובה לסיים.'],
      [b('goTab', '🏆 לכתוב הצלחה קטנה', 'data-t="journal"'), easy ? b('run2', '⏱ שתי דקות על: ' + esc(easy.title), `data-id="${easy.id}"`) : '']]
  }[v];
  if (!M) return;
  sheet(`<h1>${M[0]}</h1>${M[1].map(x => `<p style="margin:6px 0">• ${x}</p>`).join('')}<div class="grid2" style="grid-template-columns:1fr">${M[2].join('')}</div><div class="actions"><button class="btn ghost" data-act="close">סגור</button></div>`);
}
/* "I'm a victim": four steps, from questioning the thought to action */
function victimHelp() {
  const t = focusTarget();
  sheet(`<h1>🥀 אני קורבן</h1><p class="sub">מרגיש שזה קורה לך ולא בידיים שלך. ארבעה צעדים, אפשר לעבור עליהם לפי הסדר:</p>
   <div class="card"><div class="t"><b>1. לשאול את עצמי: האם זה באמת נכון?</b></div>
    <textarea id="vThought" rows="2" placeholder="המחשבה שיש לי עכשיו..."></textarea>
    <div class="sub" style="margin:4px 0">האם זה 100% נכון? מה עוד יכול להיות נכון?</div><button class="btn ghost" data-act="victimSave" data-k="q">✍ לשמור ביומן</button></div>
   <div class="card"><div class="t"><b>2. לקחת אחריות</b></div>
    <input id="vResp" placeholder="מה החלק שבאחריותי כאן?" autocomplete="off"><button class="btn ghost" data-act="victimSave" data-k="r" style="margin-top:6px">✍ לשמור ביומן</button></div>
   <div class="card"><div class="t"><b>3. להתמקד בפתרונות</b></div><div class="sub">מהו הצעד הבא שאני יכול לעשות?</div>
    <input id="vStep" placeholder="צעד קטן וברור" autocomplete="off"><button class="btn ghost" data-act="victimStep" style="margin-top:6px">➕ להוסיף להיום ולהתחיל</button></div>
   <div class="card"><div class="t"><b>4. לעבור לפעולה</b></div>${t ? `<button class="btn" data-act="runStart" data-id="${t.id}" style="margin-top:6px">◀ להתחיל: ${esc(t.title)}</button>` : '<div class="sub">אין פעולה פתוחה להיום</div>'}</div>
   <div class="actions"><button class="btn ghost" data-act="close">סגור</button></div>`);
}
/* Lack of focus: seven methods to choose from */
const FOCUS_METHODS = [
  ['body', '🤸 הפעלת הגוף', 'לקום, להתמתח או לעשות כמה קפיצות פיסוק כדי להחזיר אנרגיה.', '⏱ שתי דקות תנועה'],
  ['reset', '🔹 איפוס פעולה', 'לפרק את העבודה לצעדים זעירים ולהתחיל מהקל ביותר.', '🔹 לפרק לצעד קטן'],
  ['pomo', '🍅 חלוקת זמן', 'שיטת הפומודורו: 25 דקות עבודה ו-5 דקות הפסקה.', '◀ להתחיל 25 דקות'],
  ['env', '🚪 החלפת סביבה', 'לעבור למקום אחר או לשנות את הסביבה הקרובה.', '⏱ עשר דקות במקום אחר'],
  ['noise', '🎧 גירוי רקע', 'מוזיקה אינסטרומנטלית או רעש רקע כדי לעזור בריכוז.', '◀ רעש רקע'],
  ['account', '📣 טריגר אחריותיות', 'לספר למישהו מה המטרה שלך, או להגדיר טיימר קצר כדי להישאר במסלול.', ''],
  ['touch', '🖍 מעורבות מישושית', 'צעצוע פידג׳ט, כדור לחץ או שרבוט תוך כדי חשיבה.', '']
];
const Noise = { ctx: null, src: null, on: false };
function toggleNoise() {
  if (Noise.on) { try { Noise.src.stop(); } catch (e) {} Noise.on = false; $('#toast').hidden = true; return; }
  try {
    const c = Noise.ctx = Noise.ctx || new (window.AudioContext || window.webkitAudioContext)(), len = c.sampleRate * 2, buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
    let last = 0; for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.5; } // soft brown-ish noise
    const src = c.createBufferSource(), g = c.createGain(); src.buffer = buf; src.loop = true; g.gain.value = 0.35; src.connect(g); g.connect(c.destination); src.start();
    Noise.src = src; Noise.on = true;
    toast('<span>🎧 רעש רקע פועל</span><button class="btn ghost" data-act="noiseOff">כבה</button>', 36e5);
  } catch (e) {}
}
const focusTarget = () => { const f = focusOn(TODAY()), m = f.mitId ? findTask(f.mitId) : null; return (m && !m.done) ? m : nextTask(''); };
function focusHelp() {
  const btn = (k, label) => `<button class="btn ghost" data-act="focusMethod" data-k="${k}">${label}</button>`;
  sheet(`<h1>🎯 חוסר ריכוז</h1><p class="sub">זה קורה לכולם. בחר שיטה אחת לנסות עכשיו:</p>
   ${FOCUS_METHODS.map(([k, title, desc, label]) => `<div class="card"><div class="t"><b>${title}</b></div><div class="sub" style="margin:4px 0 8px">${desc}</div>${k === 'account' ? `<div class="opt">${btn('share', '📲 לשתף את המטרה')}${btn('timer', '⏱ טיימר 5 דקות')}</div>` : label ? btn(k, k === 'noise' && Noise.on ? '⏹ לכבות את הרעש' : label) : ''}</div>`).join('')}
   <div class="actions"><button class="btn ghost" data-act="close">סגור</button></div>`);
}
function focusMethod(k) {
  const t = focusTarget(), timed = (m, pomo) => { if (!t) return toast('<span>אין פעולה פתוחה להיום</span><button data-act="toastClose">✕</button>', 4000); runOpen(t.id); Run.total = Run.left = m * 60; Run.pomo = !!pomo; runStartTimer(); };
  if (k === 'body') return runOpen(null, true, 2, '🤸 מזיזים את הגוף');
  if (k === 'env') return runOpen(null, true, 10, '🚪 מחליפים סביבה');
  if (k === 'pomo') return timed(25, true);
  if (k === 'timer') return timed(5);
  if (k === 'reset') { if (!t) return toast('<span>אין פעולה פתוחה להיום</span><button data-act="toastClose">✕</button>', 4000); runOpen(t.id); return A.stuckSmall(); }
  if (k === 'noise') { toggleNoise(); return focusHelp(); }
  if (k === 'share') {
    const txt = t ? `המטרה שלי עכשיו: ${t.title}. אעדכן אותך כשאסיים.` : 'המטרה שלי להיום: להתמקד. אעדכן אותך.';
    if (navigator.share) navigator.share({ text: txt }).catch(() => {});
    else if (navigator.clipboard) navigator.clipboard.writeText(txt).then(() => toast('<span>הטקסט הועתק. שלח אותו למישהו 👍</span><button data-act="toastClose">✕</button>', 5000)).catch(() => {});
  }
}

/* Work time and the hourly break: after ~50 minutes of work (timer + completed actions) suggest 10 minutes off */
const NOTIFY = [['quiet', '🔕 שקט: בלי הצעות והודעות', 'רק אישור קצר כשמסמנים פעולה כבוצעה.'], ['normal', '🔔 רגיל', 'הצעה לפעולה הבאה, הודעת תגמול וחזרה מהפסקה.'], ['full', '🔔 מזכירה יותר', 'בנוסף: הצעת הפסקה אחרי כ-50 דקות ותזכורות לארוחות ולמנוחה.']];
const notifyLevel = () => { try { return localStorage.getItem('doit-notify') || 'normal'; } catch (e) { return 'normal'; } };
const Work = { skipId: '', pending: false };
function addWork(m) {
  const f = fo(TODAY()); f.work = (f.work || 0) + Math.max(0, m); f.workTotal = (f.workTotal || 0) + Math.max(0, m); Store.save();
  return Work.pending = f.work >= (f.workNext || 50);
}
function suggestBreak() {
  if (!$('#run').hidden) return;
  toast(`<span>☕ עבדת בערך ${Math.round(fo(TODAY()).work || 50)} דקות. הגיע הזמן ל-10 דקות הפסקה.</span><button class="btn" data-act="runBreak">☕ התחל הפסקה</button><button class="btn ghost" data-act="breakLater">עוד מעט</button><button data-act="toastClose" aria-label="סגור">✕</button>`, 20000);
}
function afterDone(t) {
  let due;
  if (Work.skipId === t.id) { due = Work.pending; Work.skipId = ''; } else due = addWork(t.mins || 5);
  if (rewardNotify()) return;
  if (due && notifyLevel() === 'full') suggestBreak(); else showNext(t.id);
}
function finishBreak() {
  const T = TODAY(), f = fo(T); f.work = 0; f.workNext = 50;
  if (Run.rhythmId) { (D().rhythmLog[T] = D().rhythmLog[T] || {})[Run.rhythmId] = true; }
  Store.save(); runClose(); returnToast();
}

function estimateEnd(rem) { // when the day's remaining work should end, counting the hourly break and the meals/rest not yet taken
  const T = TODAY(), log = D().rhythmLog[T] || {}, now = toMin(nowHM());
  let end = now + rem + Math.floor(rem / 50) * 10;
  rhythmSorted().filter(r => !log[r.id]).forEach(r => { if (toMin(r.time) < end && toMin(r.time) + r.mins > now) end += r.mins; });
  return pad(Math.floor(end / 60) % 24) + ':' + pad(end % 60);
}
/* Rhythm of the day: meals and rest you define; separate from actions and not counted as progress */
const rhythmSorted = () => D().rhythm.slice().sort((a, b) => a.time.localeCompare(b.time));
function rhythmStrip(d, mode) {
  if (d !== TODAY()) return '';
  const items = rhythmSorted(), log = D().rhythmLog[d] || {}, now = nowHM(), nowM = toMin(now), noRest = !items.some(r => r.kind === 'rest');
  const near = r => !log[r.id] && Math.abs(toMin(r.time) - nowM) <= 30;
  const row = r => {
    const done = !!log[r.id], due = !done && r.time <= now;
    return `<div class="card row rh ${done ? 'done' : ''} ${due ? 'due' : ''}"><button class="check ${done ? 'on' : ''}" data-act="rhythmDone" data-id="${r.id}" aria-label="סמן">${done ? '✓' : ''}</button><div class="grow"><div class="t">${r.kind === 'meal' ? '🍽' : '😌'} ${esc(r.label)}</div><div class="meta"><span>${r.time}</span><span>${r.mins} ד׳</span>${due ? '<span style="color:var(--accent)">הגיע הזמן</span>' : ''}</div></div>${done ? '' : `<button class="iconbtn" data-act="rhythmStart" data-id="${r.id}">◀ הפסקה</button>`}</div>`;
  };
  if (mode === 'near') return items.filter(near).map(row).join('');
  const rows = items.filter(r => !near(r) && !log[r.id]).map(row).join('');
  if (!rows && !noRest) return '';
  return `<h2>מקצב היום</h2>${rows}${noRest ? '<div class="card" data-act="goTab" data-t="rhythm"><div class="t">😌 עדיין לא הגדרת מנוחה יומית</div><div class="sub">לחץ כדי להגדיר</div></div>' : ''}`;
}
let tickBusy = false;
function tick() {
  if (document.hidden || tickBusy) return; tickBusy = true;
  try {
    const T = TODAY(); ensureDayStart();
    if (!$('#toast').hidden || !$('#sheet').hidden || !$('#run').hidden || notifyLevel() !== 'full') return; // meal / rest / hourly-break reminders only in the "full" level
    const now = toMin(nowHM()), log = D().rhythmLog[T] || {}, f = D().focus[T] || {};
    const r = rhythmSorted().find(x => !log[x.id] && toMin(x.time) <= now && now < toMin(x.time) + 180 && !tick.shown[T + x.id]);
    if (r) { tick.shown[T + r.id] = 1; toast(`<span>${r.kind === 'meal' ? '🍽' : '😌'} הגיע הזמן: <b>${esc(r.label)}</b> (${r.mins} ד׳)</span><button class="btn" data-act="rhythmStart" data-id="${r.id}">◀ התחל</button><button class="btn ghost" data-act="rhythmDone" data-id="${r.id}">✓ ${r.kind === 'rest' ? 'כבר נחתי' : 'כבר אכלתי'}</button><button data-act="toastClose" aria-label="סגור">✕</button>`, 30000); return; }
    if ((f.work || 0) >= (f.workNext || 50)) { suggestBreak(); return; }
  } finally { tickBusy = false; }
}
tick.shown = {};
setInterval(tick, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(tick, 600); });
document.addEventListener('toggle', e => { if (e.target && e.target.id === 'todayMore') state.moreOpen = e.target.open; if (e.target && e.target.id === 'doneSec') state.doneOpen = e.target.open; }, true);

/* Day start and end: stamped automatically on the first open, end by button; both editable */
function ensureDayStart() { /* the day start is marked by the user (button), never stamped automatically */ }
// A day that ends after midnight counts from its start time on the previous date (end earlier than start = crossed midnight)
const dayDurMin = L => { if (!L || !L.start) return 0; const e = L.end || nowHM(); let d = toMin(e) - toMin(L.start); if (d < 0) d += 1440; return d; };
function dayKey() { // which log the "good night" button belongs to: today, or yesterday's day if it is still open past midnight
  const T = TODAY(), y = addDays(T, -1), Y = D().dayLog[y], now = toMin(nowHM());
  if ((D().dayLog[T] || {}).start || !Y || !Y.start) return T;
  if (!Y.end) return (now + 1440 - toMin(Y.start)) <= 18 * 60 && toMin(Y.start) > now ? y : T;
  return toMin(Y.end) < toMin(Y.start) && now <= toMin(Y.end) + 60 ? y : T;
}
function dayCard(d) {
  if (d !== TODAY()) return '';
  const L = D().dayLog[dayKey()] || {};
  const btn = !L.start ? '<button class="iconbtn" data-act="dayStart">◀ התחל יום</button>' : !L.end ? '<button class="iconbtn" data-act="dayEnd">🌙 לילה טוב</button>' : '<button class="iconbtn" data-act="dayReopen" aria-label="פתח מחדש">↺</button>';
  return `<div class="card row daycard"><span style="font-size:22px">🕗</span><div class="grow" data-act="dayEdit"><div class="t">${L.start ? 'התחלת ב-' + L.start : 'היום עוד לא התחיל'}${L.end ? ' · סיימת ב-' + L.end : ''}</div>${L.start ? `<div class="meta"><span>${L.end ? 'משך היום' : 'עד עכשיו'}: ${fmtDur(dayDurMin(L))}</span></div>` : ''}</div><button class="iconbtn" data-act="dayEdit" aria-label="עריכת שעת התחלה וסיום">✏️ שעות</button>${btn}</div>`;
}
function dayEditSheet() {
  const T = dayKey(), L = D().dayLog[T] || {};
  sheet(`<h1>שעות היום</h1><form id="f"><label>התחלת יום</label><input type="time" name="start" value="${L.start || ''}"><label>סיום יום</label><input type="time" name="end" value="${L.end || ''}">
   <div class="actions"><button type="button" class="btn ghost" data-act="close">ביטול</button><button class="btn">שמור</button></div></form>`);
  $('#f').onsubmit = e => { e.preventDefault(); const f = new FormData(e.target); D().dayLog[T] = { start: f.get('start') || '', end: f.get('end') || '' }; Store.save(); closeSheet(); render(); };
}
function dayHistoryHTML() {
  const days = Object.keys(D().dayLog).filter(k => D().dayLog[k] && (D().dayLog[k].start || D().dayLog[k].end)).sort().reverse().slice(0, 7);
  if (!days.length) return '<div class="empty">עדיין אין נתוני שעות</div>';
  const done = days.filter(k => D().dayLog[k].end), avg = done.length ? Math.round(done.reduce((s, k) => s + dayDurMin(D().dayLog[k]), 0) / done.length) : 0;
  return days.map(k => { const L = D().dayLog[k]; return `<div class="card row"><div class="grow"><div class="t"><b>${shortDate(k)}</b></div><div class="meta"><span>התחלה ${L.start || '—'}</span><span>סיום ${L.end || '—'}</span>${L.end ? `<span>${fmtDur(dayDurMin(L))}</span>` : ''}${((D().focus[k] || {}).workTotal || 0) >= 1 ? `<span>עבודה בפועל ${fmtDur(Math.round(D().focus[k].workTotal))}</span>` : ''}</div></div></div>`; }).join('')
    + (avg ? `<div class="sub" style="margin-top:6px">ממוצע ימים שהסתיימו: ${fmtDur(avg)}</div>` : '');
}

/* Deferral nudge: an action pushed to a later date three times gets a gentle "should we rewrite it?" */
function deferTo(t, nd) { const od = t.date; if (od && (!nd || nd > od)) t.defers = (t.defers || 0) + 1; t.date = nd; delete t.ord; }
const needsNudge = t => t && !t.done && (t.defers || 0) >= 3 && t.defers > (t.nudged || 0);
function rewriteSheet(t) {
  sheet(`<h1>נדחתה ${t.defers} פעמים 🤔</h1><p><b>${esc(t.title)}</b></p><p class="sub">משהו בה תוקע אותך. אולי הניסוח עמום, אולי היא גדולה מדי, ואולי היא כבר לא באמת חשובה. רוצה לכתוב אותה מחדש?</p>
   <div class="grid2" style="grid-template-columns:1fr"><button class="btn" data-act="rewriteEdit" data-id="${t.id}">✏️ לכתוב מחדש</button><button class="btn ghost" data-act="rewriteSplit" data-id="${t.id}">✂️ לפצל לשתי פעולות קטנות</button><button class="btn ghost" data-act="rewriteDel" data-id="${t.id}">🗑 למחוק, כנראה לא צריך אותה</button><button class="btn ghost" data-act="rewriteKeep" data-id="${t.id}">להשאיר כמו שהיא</button></div>`);
}
function nudgeAny(ids) { if (!$('#sheet').hidden) return; const t = (ids ? ids.map(findTask) : D().tasks).find(needsNudge); if (t) rewriteSheet(t); }

/* Morning review: did you keep yesterday's actions, and what to improve */
let reviewSnooze = false;
function reviewSheet() {
  fo(TODAY()).reviewAsked = true; Store.save(); // shown once per day
  const T = TODAY(), y = addDays(T, -1), ts = wasOn(y), doneL = ts.filter(t => t.done), left = ts.filter(t => !t.done), done = doneL.length, L = D().dayLog[y] || {}, F = D().focus[y] || {};
  const pct = ts.length ? Math.round(done / ts.length * 100) : 0, planned = ts.reduce((a, t) => a + (t.mins || 0), 0), doneMin = doneL.reduce((a, t) => a + (t.mins || 0), 0);
  // earlier days, for comparison
  const prev = [2, 3, 4, 5, 6, 7, 8].map(n => wasOn(addDays(T, -n))).filter(x => x.length), avg = prev.length ? Math.round(prev.reduce((a, x) => a + x.filter(t => t.done).length / x.length * 100, 0) / prev.length) : null;
  const mit = F.mitId ? findTask(F.mitId) : null, rl = D().rhythmLog[y] || {}, rItems = D().rhythm, rDone = rItems.filter(r => rl[r.id]).length, wt = Math.round(F.workTotal || 0);
  const energyL = (ENERGY_MODES.find(m => m[0] === normEnergy(F.energy)) || [0, ''])[1], tips = [];
  if (avg !== null && ts.length) tips.push(pct >= avg + 10 ? 'ביצעת יותר מהממוצע של הימים האחרונים (' + avg + '%). מה עזר לך אתמול?' : pct <= avg - 10 ? 'ביצעת פחות מהממוצע של הימים האחרונים (' + avg + '%). שווה לבדוק מה הפריע.' : 'קצב הביצוע דומה לממוצע של הימים האחרונים (' + avg + '%).');
  if (planned > DAY_CAP) tips.push('תכננת ' + planned + ' דקות, יותר מ-' + DAY_CAP + '. מחר אפשר לתכנן פחות.');
  if (left.some(t => (t.energy || 0) >= 4)) tips.push('פעולות עתירות אנרגיה נשארו בלי ביצוע. כדאי לשבץ אותן בתחילת היום.');
  if (left.some(t => (t.defers || 0) >= 2)) tips.push('יש פעולות שנדחות שוב ושוב. שווה לכתוב אותן מחדש או לפצל.');
  if (rItems.length && rDone < rItems.length) tips.push('לא כל ההפסקות שהגדרת נעשו (' + rDone + '/' + rItems.length + '). הפסקות עוזרות לשמור על קצב.');
  if (L.start && L.end && dayDurMin(L) > 600) tips.push('היום היה ארוך מאוד (' + fmtDur(dayDurMin(L)) + '). כדאי לקבוע שעת סיום.');
  if (L.start && !L.end) tips.push('לא סימנת סיום יום, ולכן משך היום לא נספר. כדאי ללחוץ "סיום יום" בסוף היום.');
  if (ts.length && done === ts.length) tips.push('עמדת בכל הפעולות. שים לב מה עזר לך, ושמור על זה.');
  else if (!tips.length && left.length) tips.push('נסה לתכנן פחות פעולות, ובחר מראש את החשובה ביותר.');
  const list = (arr, icon) => arr.slice(0, 8).map(t => '<div class="sub" style="margin:2px 0">' + icon + ' ' + esc(t.title) +  + ((t.defers || 0) >= 2 ? ' · נדחתה ' + t.defers + ' פעמים' : '') + '</div>').join('') + (arr.length > 8 ? '<div class="sub">ועוד ' + (arr.length - 8) + '…</div>' : '');
  sheet(`<h1>סיכום אתמול ☀️</h1>${morningBar('review')}
   <div class="meta" style="margin:4px 0 8px"><span>✅ ${done}/${ts.length} פעולות (${pct}%)</span>${doneMin ? '<span>⏱ ' + doneMin + ' ד׳ הושלמו</span>' : ''}${wt ? '<span>💼 עבודה בפועל ' + fmtDur(wt) + '</span>' : ''}${L.start ? '<span>🕗 ' + L.start + (L.end ? '–' + L.end + ' (' + fmtDur(dayDurMin(L)) + ')' : ' (בלי סיום)') + '</span>' : ''}${rItems.length ? '<span>☕ ' + rDone + '/' + rItems.length + ' הפסקות</span>' : ''}${energyL ? '<span>' + energyL + '</span>' : ''}</div>
   ${mit ? '<div class="sub">⭐ הפעולה החשובה: <b>' + esc(mit.title) + '</b> ' + (mit.done ? '✓ בוצעה' : '✗ לא בוצעה') + '</div>' : ''}
   ${doneL.length ? '<h2 style="margin:12px 0 4px">הספקת</h2>' + list(doneL, '✅') : ''}
   ${left.length ? '<h2 style="margin:12px 0 4px">לא הספקת</h2>' + list(left, '⏳') + '<button type="button" class="btn ghost" id="carryBtn" style="width:100%;margin-top:8px" data-act="carryOver">⏩ העבר את כולן להיום (' + left.length + ')</button>' : ''}
   ${tips.length ? '<h2 style="margin:12px 0 4px">ניתוח</h2><div class="clarity">' + tips.map(x => '<div class="ok">💡 ' + esc(x) + '</div>').join('') + '</div>' : ''}
   <form id="f"><label>עמדת בפעולות של אתמול?</label>
   <div class="opt" id="metOpts">${[['yes', '✅ כן'], ['part', '🟡 חלקית'], ['no', '❌ לא']].map(([v, l]) => `<button type="button" onclick="const f=this.closest('form');f.met.value='${v}';this.parentNode.querySelectorAll('button').forEach(b=>b.classList.remove('on'));this.classList.add('on')">${l}</button>`).join('')}</div><input type="hidden" name="met" value="">
   <label>מה הייתי משפר?</label><textarea name="improve" rows="3" placeholder="דבר אחד קטן לשפר היום"></textarea>
   <div class="actions"><button type="button" class="btn ghost" data-act="reviewLater">אין צורך</button><button class="btn">שמור והמשך</button></div></form>`);
  $('#f').onsubmit = e => { e.preventDefault(); const f = new FormData(e.target); D().review[y] = { met: f.get('met') || '', improve: f.get('improve').trim(), at: new Date().toISOString() }; Store.save(); closeSheet(); setTimeout(askFocus, 250); };
}
const Morning = { plan: [], active: false };
const morningEligible = () => {
  const T = TODAY(), y = addDays(T, -1), f = D().focus[T] || {}, fe = focusOn(T);
  return {
    visual: !visualSnooze && !D().visual[T] && !workedToday() && !f.visualAsked && new Date().getHours() < 14,
    review: !reviewSnooze && !D().review[y] && !f.reviewAsked && (wasOn(y).length > 0 || ((D().focus[y] || {}).workTotal || 0) > 0),
    focus: !focusSnooze && !f.askedAt && !(fe.mit && fe.fun)
  };
};
function morningBar(name) {
  if (!Morning.active || Morning.plan.length < 2 || !Morning.plan.includes(name)) return '';
  const i = Morning.plan.indexOf(name);
  return '<div class="stepbar">' + Morning.plan.map((k, n) => '<i class="' + (n <= i ? 'on' : '') + '"></i>').join('') + '<span class="sub">שלב ' + (i + 1) + ' מתוך ' + Morning.plan.length + '</span><button type="button" class="lnk" data-act="morningSkipAll">דלג על הכל</button></div>';
}
function askMorning() {
  if (!D().tasks.length) return; // a brand-new user has nothing to review or plan: no popups
  if (!$('#sheet').hidden || !$('#run').hidden) return;
  const el = morningEligible();
  if (!Morning.active) { Morning.plan = ['visual', 'review', 'focus'].filter(k => el[k]); if (!Morning.plan.length) return; Morning.active = true; }
  if (el.visual) return visualOffer();
  if (el.review) return reviewSheet();
  if (el.focus) return askFocus();
  Morning.active = false;
}
/* ---------- Morning guided visualization: shown paragraph by paragraph, optional auto-advance and read-aloud ---------- */
const VISUALIZATION = [
  'דמיין שאתה קם בבוקר.\nלא סתם בוקר — זה יום שאתה עומד לפגוש את היעד שלך.\nאתה יודע את זה.\nאתה מרגיש את זה בגוף.\nהנשימה שלך רגועה, הגוף שלך מלא באנרגיה.\nיש שקט פנימי.\nאין לחץ.\nיש בהירות.',
  'אתה מסתכל על היומן שלך — כל דבר שאתה עושה היום מוביל אותך אל היעד.\nאבל בניגוד לעבר, אתה לא רץ.\nאתה מתקדם בדיוק, בפוקוס, ובחיבור.',
  'אתה רואה את עצמך נכנס למשרד/הסטודיו/המרחב שלך.\nיש שם תחושת ביטחון, סדר, נוכחות.\nהעבודה זורמת.\nהפעולות שאתה עושה – נכונות, מדויקות, ממוקדות.\nאתה עונה למיילים, שולח הצעות, מדבר עם לקוחות, מציג רעיונות –\nוהכל מתוך תחושת עוצמה ובשליטה.\nאין התפזרות. אין דחיינות.\nרק בהירות.',
  'אתה רואה בעיני רוחך את היעד שלך כבר מושג.\nהמספר שרצית — נמצא במערכת.\nהפרויקט שרצית — נחתם.\nהתגובות שרצית — מגיעות.\nאתה עומד ומסתכל על התוצאה ואומר לעצמך:\n"עשיתי את זה. כי הלכתי בדרך. כי לא וויתרתי לעצמי. כי הייתי שם — יום אחרי יום."',
  'תן לעצמך רגע ממש להרגיש את התחושה של ההישג.\nאיך הגוף שלך מרגיש כשאתה עומד שם?\nמה הפנים שלך משדרות?\nמי איתך שם?\nאיך אתה מדבר?\nמה אתה משדר לעולם?',
  'ועכשיו... קח את התחושה הזו, ותכניס אותה לתוך הלב שלך.\nתנשום אותה פנימה.\nזוהי אנרגיית הביצוע שלך.\nהיא שלך — היא תמיד הייתה.'
];
const Vis = { i: 0, auto: false, speak: false, timer: null };
let visualSnooze = false;
const canSpeak = () => 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
function visSay() {
  if (!canSpeak()) return; speechSynthesis.cancel();
  if (!Vis.speak) return;
  const u = new SpeechSynthesisUtterance(VISUALIZATION[Vis.i].replace(/\n/g, '. ')); u.lang = 'he-IL'; u.rate = 0.85; speechSynthesis.speak(u);
}
function visSchedule() {
  clearTimeout(Vis.timer);
  if (!Vis.auto) return;
  const words = VISUALIZATION[Vis.i].split(/\s+/).length;
  Vis.timer = setTimeout(() => { if (Vis.i < VISUALIZATION.length - 1) { Vis.i++; visRender(); } }, Math.max(9000, words * 650));
}
function visRender() {
  const el = $('#run'), last = Vis.i === VISUALIZATION.length - 1;
  el.innerHTML = `<div class="runbox visbox"><button class="iconbtn runx" data-act="visClose" aria-label="סגור">✕</button>
    <div class="sub">🧘 דמיון מודרך · ${Vis.i + 1}/${VISUALIZATION.length}</div>
    <div class="visdots">${VISUALIZATION.map((_, k) => `<i class="${k <= Vis.i ? 'on' : ''}"></i>`).join('')}</div>
    <div class="vistext" key="${Vis.i}">${VISUALIZATION[Vis.i].split('\n').map(l => `<p>${esc(l)}</p>`).join('')}</div>
    <div class="opt" style="justify-content:center;margin:10px 0">
      <button class="${Vis.auto ? 'on' : ''}" data-act="visAuto">${Vis.auto ? '⏸ אוטומטי' : '◀ אוטומטי'}</button>
      ${canSpeak() ? `<button class="${Vis.speak ? 'on' : ''}" data-act="visSpeak">🔊 הקראה</button>` : ''}</div>
    <div class="grid2">${Vis.i > 0 ? '<button class="btn ghost" data-act="visPrev">הקודם</button>' : '<span></span>'}${last ? '<button class="btn" data-act="visDone">✓ סיימתי</button>' : '<button class="btn" data-act="visNext">הבא</button>'}</div></div>`;
  visSchedule(); visSay();
}
function visOpen() { clearInterval(Run.tick); closeSheet(); Vis.i = 0; Vis.auto = false; $('#run').hidden = false; document.body.classList.add('running'); visRender(); }
function visStop() { clearTimeout(Vis.timer); if (canSpeak()) speechSynthesis.cancel(); $('#run').hidden = true; document.body.classList.remove('running'); }
function visualOffer() {
  fo(TODAY()).visualAsked = true; Store.save(); // offered once a day; the card on the Today screen stays
  sheet(`<h1>🧘 דמיון מודרך</h1>${morningBar('visual')}<p class="sub">כמה דקות של דמיון לפני שמתחילים את היום. תקרא בקצב שלך, או תן לאפליקציה להתקדם לבד.</p>
   <div class="actions"><button class="btn ghost" data-act="visLater">אחר כך</button><button class="btn" data-act="visStart">◀ להתחיל</button></div>`);
}
const workedToday = () => { const T = TODAY(); return tasksOn(T).some(t => t.done) || ((D().focus[T] || {}).work || 0) > 0; }; // started working: the morning visualization no longer matters today
function syncHint() { // data lives only on this device until the user signs in
  let off = false; try { off = !!localStorage.getItem('doit-sync-hint-off'); } catch (e) {}
  if (DEMO || Cloud.user || off) return '';
  return '<div class="card focus synchint" data-act="account"><div class="row"><span style="font-size:22px">☁️</span><div class="grow"><div class="t">הנתונים שמורים רק במכשיר הזה</div><div class="sub">לחץ כדי להתחבר ולראות אותם גם בטלפון ובמחשב</div></div><button class="iconbtn" data-act="hideSyncHint" aria-label="הסתר">✕</button></div></div>';
}
function visualCard(d) {
  if (d !== TODAY()) return '';
  const done = !!D().visual[d];
  if (done || workedToday()) return ''; // a finished visualization moves to the "בוצע" section
  return `<div class="card row ${done ? 'done' : ''}"><span style="font-size:22px">🧘</span><div class="grow"><div class="t">דמיון מודרך של הבוקר</div><div class="meta"><span>${done ? 'בוצע היום ✓' : 'עוד לא בוצע'}</span></div></div><button class="iconbtn" data-act="visStart">${done ? '↺ שוב' : '◀ להתחיל'}</button></div>`;
}
/* ---------- Daily reward: you set the condition for each day; the reward comes from your own list ---------- */
const REWARD_RULES = [['', 'בלי תנאי'], ['mit', 'הפעולה החשובה'], ['p50', 'לפחות 50% מהפעולות'], ['p70', 'לפחות 70% מהפעולות'], ['all', 'כל הפעולות']];
function rewardState(d) {
  const f = D().focus[d] || {}, rule = f.rewardRule || '', ts = tasksOn(d), done = ts.filter(t => t.done).length, mit = f.mitId ? findTask(f.mitId) : null;
  let achieved = false, text = '';
  if (rule === 'mit') { achieved = !!(mit && mit.done); text = mit ? 'הפעולה החשובה עוד לא בוצעה' : 'עוד לא נבחרה פעולה חשובה להיום'; }
  else if (rule === 'all') { achieved = ts.length > 0 && done === ts.length; text = `${done}/${ts.length} פעולות בוצעו`; }
  else if (rule) { const p = +rule.slice(1); achieved = ts.length > 0 && done / ts.length * 100 >= p; text = `${done}/${ts.length} פעולות בוצעו, צריך ${p}%`; }
  return { rule, achieved, text, picked: f.rewardPicked || '', claimed: !!f.rewardClaimed };
}
function rewardCard(d) {
  if (d !== TODAY()) return '';
  const s = rewardState(d);
  if (!s.rule) return '<div class="card focus" data-act="focusEdit"><div class="t"><b>🎁 תגמול יומי</b></div><div class="sub">לחץ כדי לקבוע תנאי לתגמול של היום</div></div>';
  const label = REWARD_RULES.find(r => r[0] === s.rule)[1];
  if (s.claimed) return ''; // claimed rewards are listed under "בוצע"
  const body = s.claimed ? ''
    : s.achieved ? (s.picked ? `<div class="t">התגמול שלך: ${esc(s.picked)}</div><button class="btn startnow" data-act="rewardClaim">✓ מימשתי</button>` : '<button class="btn startnow" data-act="rewardOpen">🎉 עמדת! לבחור תגמול</button>')
    : `<div class="t">${esc(s.text)}</div>`;
  return `<div class="card focus"><div class="frow"><span>🎁</span><div class="grow"><div class="sub">תגמול יומי · תנאי: ${esc(label)}</div>${body}</div></div></div>`;
}
function rewardSheet() {
  const L = D().dayRewards;
  sheet(`<h1>🎉 עמדת בתנאי של היום!</h1>${L.length
    ? `<p class="sub">בחר תגמול, או תן לי להגריל:</p><div class="grid2" style="grid-template-columns:1fr">${L.map(r => `<button class="btn ghost" data-act="rewardPick" data-id="${r.id}">🎁 ${esc(r.title)}</button>`).join('')}<button class="btn" data-act="rewardRandom">🎲 הגרל לי</button></div>`
    : '<p class="sub">עדיין אין רשימת תגמולים. הוסף כמה תגמולים קטנים.</p><div class="actions"><button class="btn" data-act="rewardManage">להוספת תגמולים</button></div>'}
   <div class="actions"><button class="btn ghost" data-act="close">אחר כך</button></div>`);
}
function rewardNotify() { // first time today's condition is met: celebrate once
  const T = TODAY(), s = rewardState(T), f = fo(T);
  if (notifyLevel() === 'quiet' || !s.rule || !s.achieved || f.rewardNotified) return false;
  f.rewardNotified = true; Store.save(); celebrate();
  toast('<span>🎉 עמדת בתנאי התגמול של היום!</span><button class="btn" data-act="rewardOpen">🎁 לבחור תגמול</button><button data-act="toastClose" aria-label="סגור">✕</button>', 15000);
  return true;
}
const setReward = title => { fo(TODAY()).rewardPicked = title; Store.save(); closeSheet(); render(); };
/* A task (job) written together with its actions: one action per line */
const newChips = active => '<div class="opt" style="margin-bottom:6px">' + [['action', 'פעולה', 'newActionForm'], ['project', '📁 פרויקט', 'newProjectForm']].map(([k, l, act]) => k === active ? '<button type="button" class="on">' + l + '</button>' : '<button type="button" data-act="' + act + '">' + l + '</button>').join('') + '</div>';
function projectForm() {
  sheet(`<h1>פרויקט חדש</h1>${newChips('project')}
  <form id="f"><label>שם הפרויקט</label><input name="title" required autocomplete="off" placeholder="למשל: השקת האתר החדש" autofocus>
   <label>פעולות ראשונות בפרויקט (אופציונלי, שורה לכל פעולה)</label><textarea name="jobs" rows="4" placeholder="להקים את דף הבית&#10;לכתוב את הטקסטים&#10;להשיק קמפיין פתיחה"></textarea>
   ${prioFields({})}
   <div class="actions"><button type="button" class="btn ghost" data-act="close">ביטול</button><button class="btn">שמור</button></div></form>`);
  $('#f').onsubmit = e => {
    e.preventDefault(); const f = new FormData(e.target), title = f.get('title').trim(); if (!title) return;
    const lines = f.get('jobs').split('\n').map(x => x.trim()).filter(Boolean), bad = lines.map(l => ({ l, why: clarity(l)[0] })).filter(x => x.why);
    if (bad.length) { alert('לא ניתן לשמור: פעולה אחת או יותר לא כתובות בצורה ברורה.\n"' + bad[0].l + '"\n' + bad[0].why); return; }
    const p = { id: uid(), title, createdAt: TODAY(), quad: f.get('quad') || '', want: +f.get('want') || 0 }; D().projects.push(p);
    lines.forEach(l => D().tasks.push({ id: uid(), title: l, date: null, done: false, priority: 0, energy: 3, mins: 15, brainless: false, print: false, visionId: '', projectId: p.id, notes: '', subs: [], jobId: '' }));
    Store.save(); closeSheet(); state.tab = 'projects'; state.openJob = null; state.openProject = p.id; render(); window.scrollTo(0, 0);
  };
}
/* ---------- Eisenhower matrix: prioritize actions by urgent / important ---------- */
const QUADS = [
  ['q1', '🔴 דחוף וחשוב', 'לבצע ראשון. המוח שלך כבר ייצר לזה אדרנלין טבעי.', 'דד-ליין להיום, משבר, חשבון שחייבים לשלם עכשיו.'],
  ['q2', '🔵 חשוב אבל לא דחוף', 'המוקש של ADHD. חובה לתזמן לזה דד-ליין מלאכותי, לשבץ ביומן בשעה קבועה או לקבוע עם חבר או שותף ללמידה (Body Doubling).', 'פרויקטים גדולים, ספורט, למידה, סדר בבית.'],
  ['q3', '🟡 דחוף אבל לא חשוב', 'להגביל בזמן או להאציל. אל תיתן לזה לגזול לך את שעות השיא.', 'הודעות ווטסאפ, מיילים שגרתיים, בקשות של אחרים.'],
  ['q4', '⚪ לא דחוף ולא חשוב', 'למחוק מהרשימה או להשאיר כפרס רק אחרי סיום פעולה.', 'גלילה ברשתות, סידור אובססיבי של שולחן העבודה במקום ללמוד.']
];
const quadOf = k => QUADS.find(q => q[0] === k);
const quadRank = { q1: 3, q2: 2, q3: 1, q4: 0 }, quadPri = { q1: 2, q2: 1, q3: 1, q4: 0 }; // order of work, and the old priority value kept in step
const effQuad = t => t.quad || (t.jobId && (findJob(t.jobId) || {}).quad) || (t.projectId && (D().projects.find(p => p.id === t.projectId) || {}).quad) || '';
const quadChip = t => { const k = effQuad(t), q = quadOf(k); return q ? '<span class="chip quad ' + k + (t.quad ? '' : ' inh') + '" title="' + (t.quad ? '' : 'עדיפות שעברה בירושה') + '">' + q[1] + '</span>' : ''; };
const itemChips = x => quadChip({ quad: x.quad }) + (x.want ? '<span title="כמה בא לי">💗' + x.want + '</span>' : '');
const itemOf = (kind, id) => kind === 'job' ? findJob(id) : kind === 'project' ? D().projects.find(p => p.id === id) : findTask(id);
const wantStars = (id, cur, kind) => '<div class="hearts">' + [1, 2, 3, 4, 5].map(n => '<button type="button" class="' + (n <= cur ? 'on' : '') + '" data-act="setWant" data-id="' + id + '" data-k="' + (kind || '') + '" data-n="' + n + '" aria-label="' + n + '">♥</button>').join('') + '</div>';
const prioBox = (kind, x) => '<div class="card"><div class="sub">🧭 עדיפות (דחוף / חשוב)</div>' + quadChips(x.id, x.quad || '', kind) + '<div class="sub" style="margin-top:10px">💗 כמה בא לי לעשות את זה?</div>' + wantStars(x.id, x.want || 0, kind) + '</div>';
const prioFields = x => '<label>🧭 עדיפות (מטריצת אייזנהאואר)</label><div id="quadBox">' + quadChips('', x.quad || '', '') + '</div><input type="hidden" name="quad" value="' + (x.quad || '') + '"><label>💗 כמה בא לי לעשות את זה? (1 = בכלל לא, 5 = מאוד)</label><div id="wantBox">' + wantStars('', x.want || 0, '') + '</div><input type="hidden" name="want" value="' + (x.want || 0) + '">';
const quadChips = (id, cur, kind) => '<div class="opt quadopts">' + QUADS.map(q => '<button type="button" class="' + (cur === q[0] ? 'on' : '') + '" data-act="setQuad" data-id="' + id + '" data-k="' + (kind || '') + '" data-q="' + q[0] + '">' + q[1] + '</button>').join('') + '</div>' + (quadOf(cur) ? '<div class="sub" style="margin-top:6px">' + esc(quadOf(cur)[2]) + '</div>' : '');
/* ---------- Plan mode / do mode, the next-action suggestion, coming back from a break ---------- */
const modeSwitch = () => '<div class="opt modesw"><button class="' + (state.mode === 'plan' ? 'on' : '') + '" data-act="setMode" data-m="plan">📋 תכנון</button><button class="' + (state.mode === 'do' ? 'on' : '') + '" data-act="setMode" data-m="do">🎯 ביצוע</button></div>';
const currentAction = () => { const t = state.doId ? findTask(state.doId) : null; return (t && !t.done && t.date === TODAY()) ? t : nextTask(''); };
function nowCard(t) {
  return '<div class="card nowcard"><div class="sub">עכשיו</div><div class="t big">' + titleP(t) + '</div>' + (t.notes ? '<div class="sub" style="white-space:pre-wrap;margin-top:4px">' + esc(t.notes) + '</div>' : '')
    + '<div class="meta" style="margin:8px 0">' + quadChip(t) + (t.want ? '<span>💗' + t.want + '</span>' : '') + projectChip(t) + '</div>'
    + '<button class="btn startnow" data-act="runStart" data-id="' + t.id + '">◀ התחל עכשיו</button>'
    + '<div class="grid2"><button class="btn ghost" data-act="chooseOther">🔁 בחר פעולה אחרת</button><button class="btn ghost" data-act="runBreak">☕ אני צריך הפסקה</button></div>'
    + '<button class="lnk" data-act="toggleTask" data-id="' + t.id + '" style="margin-top:8px">✓ כבר עשיתי את זה</button></div>';
}
function doView() { // do mode: only the current action, nothing else to distract
  const d = TODAY(), ts = tasksOn(d), open = ts.filter(t => !t.done), done = ts.length - open.length, cur = currentAction(), L0 = D().dayLog[dayKey()] || {};
  const rem = open.reduce((a, t) => a + (t.mins || 0), 0), est = rem ? estimateEnd(rem) : '', pct = ts.length ? Math.round(done / ts.length * 100) : 0;
  const queue = open.filter(t => !cur || t.id !== cur.id).slice(0, 2);
  const dayBtn = !L0.start && !L0.end ? '<button class="iconbtn endday" data-act="dayStart">◀ התחלתי יום</button>' : (L0.start && !L0.end ? '<button class="iconbtn endday" data-act="dayEnd">🌙 לילה טוב</button>' : '');
  return '<div class="top"><div class="brand">' + logoMark(36) + '<div><h1>היום</h1><div class="sub">' + longDate(d) + '</div></div></div><div class="sw"><button class="iconbtn" data-act="printDayAll" aria-label="הדפסת פעילות היום" title="הדפסת פעילות היום">🖨</button><button class="iconbtn" data-act="account" title="סנכרון וחשבון">' + (Cloud.status === 'ok' ? '☁️' : Cloud.status === 'syncing' ? '🔄' : Cloud.status === 'error' ? '⚠️' : '👤') + '</button></div></div>'
    + modeSwitch()
    + '<div class="card"><div class="row"><b class="grow">' + done + '/' + ts.length + ' הושלמו' + (rem ? ' · נותרו ' + rem + ' ד׳' : '') + '</b><button class="iconbtn" data-act="dayEdit" aria-label="עריכת שעת התחלה וסיום">✏️ שעות</button>' + dayBtn + '</div><div class="bar"><div style="width:' + pct + '%"></div></div>' + (est ? '<div class="sub" style="margin-top:6px">סיום משוער ' + est + ' (כולל הפסקות)</div>' : '') + '</div>'
    + (cur ? nowCard(cur) : ts.length === 0 ? '<div class="card"><div class="t">עוד אין פעולות להיום</div><div class="sub" style="margin-top:6px">הוסף את הפעולה הראשונה, או בחר מהמאגר במצב תכנון.</div><button class="btn startnow" data-act="addTask" style="margin-top:8px">＋ פעולה חדשה</button><button class="btn ghost" data-act="setMode" data-m="plan" style="margin-top:8px;width:100%">📋 למצב תכנון</button></div>' : '<div class="card"><div class="t">🎉 אין עוד פעולות פתוחות להיום</div><div class="sub" style="margin-top:6px">במצב תכנון אפשר להוסיף פעולות מהמאגר, או לסיים את היום.</div><button class="btn ghost" data-act="setMode" data-m="plan" style="margin-top:8px">📋 למצב תכנון</button></div>')
    + (queue.length ? '<h2>בתור</h2>' + queue.map(t => '<div class="card"><div class="t">' + esc(t.title) + '</div><div class="meta">' + '</div></div>').join('') : '')
    + energyBar(d)
    + '<button class="fab" data-act="addTask" aria-label="פעולה חדשה">+</button>';
}
function chooseOther() { // pick another action to do now (the user decides, the order is only a hint)
  $('#toast').hidden = true; const cur = currentAction(), list = tasksOn(TODAY()).filter(t => !t.done && (!cur || t.id !== cur.id)).slice(0, 6);
  sheet('<h1>בחר פעולה אחרת</h1>' + (list.length ? '<div class="grid2" style="grid-template-columns:1fr">' + list.map(t => '<button class="btn ghost" data-act="pickNow" data-id="' + t.id + '">◀ ' + esc(t.title) +  + '</button>').join('') + '</div>' : '<p class="sub">אין עוד פעולות פתוחות להיום. אפשר להוסיף מהמאגר במצב תכנון.</p>') + '<div class="actions"><button class="btn ghost" data-act="close">סגור</button></div>');
}
function returnToast() { // after a break: remind what I was doing, back to it with one tap
  if (notifyLevel() === 'quiet') return;
  const t = Work.last ? findTask(Work.last) : null;
  if (t && !t.done) toast('<span>חזרת מהפסקה. עבדת על: <b>' + esc(t.title) + '</b>' + (t.first ? ' · הצעד: ' + esc(t.first) : '') + '</span><button class="btn" data-act="runStart" data-id="' + t.id + '">◀ חזור לעבוד עליה</button><button class="btn ghost" data-act="chooseOther">בחר פעולה אחרת</button><button data-act="toastClose" aria-label="סגור">✕</button>', 25000);
  else showNext('');
}
/* Break ideas: your own list (walk, sport, tidy up...), with a few defaults */
const DEFAULT_IDEAS = ['לצאת להליכה קצרה', 'לעשות ספורט קצר', 'לסדר קצת את הבית', 'לשתות מים ולהתמתח'];
const ideaList = () => D().breakIdeas.length ? D().breakIdeas.map(x => x.title) : DEFAULT_IDEAS;
const pickIdea = prev => { const l = ideaList().filter(x => x !== prev); return l[Math.floor(Math.random() * l.length)] || ''; };
/* ---------- Planning assistant ("עוזר התכנון שלי") ----------
   The screen, the conversation flow and the memory live here. The "engine" that produces the next question and the understanding of free text
   is replaceable: right now it is a clearly labelled development stub (no AI); the real model plugs in behind Engine.turn / Engine.start. */
const AREAS = [['work', '💼 עבודה ועסקים'], ['money', '💰 כסף וכלכלה'], ['health', '💪 בריאות וכושר'], ['couple', '❤️ זוגיות'], ['family', '👨‍👩‍👧 משפחה וחברים'], ['home', '🏠 בית וסידורים'], ['growth', '📚 למידה והתפתחות'], ['fun', '🎨 פנאי והנאה']];
const GROUPS = [['urgent', '🔴 דחוף'], ['project', '📁 פרויקט לקדם'], ['small', '✅ פעולה קטנה'], ['long', '🎯 חשוב לטווח ארוך'], ['idea', '💡 רעיון לשמור'], ['worry', '💭 מעסיק, בלי פעולה כרגע']];
const A_MODES = [['order', '🧹', 'לעשות סדר בראש', 'כשיש הרבה על הפרק ואני רוצה להבין מה חשוב'], ['weekly', '🗓', 'תכנון שבועי קצר', 'אני כבר יודע מה חשוב, רק להחליט איך מתקדמים'], ['today', '☀️', 'מה מעסיק אותי היום', 'לעדכן את הרשימה של היום לפי מה שקורה']];
const aGroup = k => (GROUPS.find(g => g[0] === k) || GROUPS[2])[1];
const aArea = k => (AREAS.find(a => a[0] === k) || [0, ''])[1];
const asstPrefs = () => Object.assign({ areas: [], consent: false, shareTitles: false }, D().assist.prefs);
const asstFocus = () => Object.assign({ month: [], week: [] }, D().assist.focus);
const asstSess = () => D().assist.session || null;
const asstSave = s => { D().assist.session = s; Store.save(); };
const norm = t => String(t || '').toLowerCase().replace(/["'׳״.,!?():;\-]/g, ' ').replace(/\s+/g, ' ').trim();
const toks = t => norm(t).split(' ').filter(w => w.length > 1 && !['את', 'של', 'עם', 'על', 'אל', 'לא', 'גם', 'או', 'כל', 'זה', 'זו', 'הוא', 'היא'].includes(w));
function similar(a, b) { // a loose check so the assistant does not add something that already exists
  const x = norm(a), y = norm(b); if (!x || !y) return false; if (x === y || x.includes(y) || y.includes(x)) return true;
  const A1 = new Set(toks(a)), B1 = toks(b); if (!A1.size || !B1.length) return false; const inter = B1.filter(w => A1.has(w)).length; return inter / Math.max(A1.size, B1.length) >= 0.6;
}
const findSimilarAction = title => D().tasks.find(t => !t.done && similar(t.title, title));

/* ---- Engine: development stub. Same contract the real model will follow: it reads the session + the user's text, and updates
   session.items (classified things the user mentioned), session.question/chips (ONE next question), session.phase, session.summary/priorities, session.proposals. */
const AREA_WORDS = { work: ['עבודה', 'לקוח', 'הצעה', 'עסק', 'פגישה', 'קמפיין', 'אתר', 'פרויקט', 'משכורת'], money: ['חשבון', 'תשלום', 'מס', 'כסף', 'משכנתא', 'הלוואה', 'תקציב', 'חוב'], health: ['ספורט', 'רופא', 'כושר', 'שינה', 'דיאטה', 'בדיקה', 'הליכה', 'בריאות'], couple: ['זוגיות', 'אשתי', 'בעלי', 'בן זוג', 'בת זוג'], family: ['ילדים', 'אמא', 'אבא', 'אחי', 'אחותי', 'חברים', 'משפחה'], home: ['בית', 'ניקיון', 'תיקון', 'קניות', 'דירה', 'סידור'], growth: ['ללמוד', 'קורס', 'ספר', 'ללמוד', 'התפתחות'], fun: ['טיול', 'סרט', 'חופשה', 'הנאה', 'תחביב'] };
const guessArea = t => { for (const [k, ws] of Object.entries(AREA_WORDS)) if (ws.some(w => t.includes(w))) return k; return ''; };
function guessGroup(t) {
  if (/דחוף|מיד|היום|עד מחר|בהקדם|אזהרה|קנס|דד.?ליין/.test(t)) return 'urgent';
  if (/אולי|רעיון|יום אחד|היה נחמד/.test(t)) return 'idea';
  if (/דואג|מפחד|מרגיש|מלחיץ|מטריד|לחץ|חשש/.test(t)) return 'worry';
  if (/פרויקט|לקדם|להקים|לבנות|להשיק|עסק|מערכת/.test(t)) return 'project';
  if (/^(לקנות|לשלוח|להתקשר|לשלם|לתאם|לסדר|לבדוק|לענות|להזמין)/.test(t)) return 'small';
  return 'long';
}
function mockItems(text) { // split free text into separate things, without turning every thought into a task
  return String(text || '').split(/[\n.,;]| וגם | ובנוסף /).map(x => x.trim()).filter(x => x.length >= 3 && !/^(כן|לא|לא יודע|אני לא יודע)$/.test(x)).map(x => ({ id: uid(), text: x, group: guessGroup(x), area: guessArea(x), delayed: false, calm: false }));
}
const Engine = {
  get kind() { return AI.on() && !AI.fell ? 'ai' : 'dev'; }, // 'dev' = scripted stub (no AI)
  start(s) {
    const f = asstFocus(), topics = D().topics, names = f.month.map(id => (topics.find(t => t.id === id) || {}).title).filter(Boolean);
    if (s.mode === 'overwhelm') { s.question = 'מה הכי מטריד אותך עכשיו? מספיקה מילה או שתיים.'; s.chips = ['כסף', 'עבודה', 'משהו אישי', 'הכל ביחד']; }
    else if (s.mode === 'today') { s.question = 'מה מעסיק אותך היום?'; s.chips = ['יש לי יותר מדי', 'אין לי כוח', 'משהו דחוף צץ']; }
    else if (s.mode === 'weekly') { if (topics.length) { s.phase = 'weekpick'; s.question = ''; } else { s.question = 'מה היית רוצה לקדם השבוע?'; s.chips = []; } }
    else if (names.length) { s.question = 'בפעם הקודמת החלטת להתמקד ב: ' + names.join(', ') + '. האם זה עדיין בעדיפות?'; s.chips = ['כן, ממשיכים', 'משהו השתנה']; s.recall = true; }
    else { s.question = 'מה הכי מעסיק אותך כרגע?'; s.chips = ['עבודה', 'כסף', 'בריאות', 'דברים בבית', 'אני לא יודע']; }
    return s;
  },
  async devTurn(s, text) {
    text = (text || '').trim(); s.turns++; if (text === '__skip__') text = '';
    if (s.mode === 'today') {
      const open = tasksOn(TODAY()).filter(t => !t.done), P = [], lines = mockItems(text);
      if (/עמוס|מוצף|יותר מדי|אין לי כוח|עייף|לא מספיק/.test(text)) open.slice().sort((a, b) => (effQuad(a) === 'q4' ? 0 : 1) - (effQuad(b) === 'q4' ? 0 : 1) || (a.want || 0) - (b.want || 0)).slice(0, 2).forEach(t => P.push({ id: uid(), type: 'postpone', title: t.title, taskId: t.id, reason: 'אמרת שהיום עמוס, וזו אחת הפחות חשובות או פחות רצויות', on: true }));
      lines.filter(l => !/עמוס|מוצף|יותר מדי|אין לי כוח|עייף|לא מספיק/.test(l.text)).forEach(l => { if (!findSimilarAction(l.text)) P.push({ id: uid(), type: 'add', title: l.text, reason: 'ציינת את זה כמשהו שמעסיק אותך היום', on: l.group === 'urgent' }); });
      s.proposals = P; s.phase = 'proposals'; s.question = ''; s.summary = P.length ? 'הנה מה שהצעתי לעדכן, לפי מה שכתבת בלבד. סמן מה מתאים לך.' : 'לא מצאתי מה לעדכן ברשימה של היום לפי מה שכתבת. אפשר לכתוב עוד.'; return s;
    }
    if (s.mode === 'overwhelm') {
      const it = mockItems(text)[0]; if (it) s.items.push(it);
      s.focusIds = []; s.steps = [{ id: uid(), topic: (it && it.text) || text, title: '', mins: 10, on: true }]; s.phase = 'steps'; s.stepIdx = 0; s.question = ''; return s;
    }
    if (s.recall && s.turns === 1) { s.recall = false; if (/^כן/.test(text)) { s.phase = 'weekpick'; s.question = ''; s.items = D().topics.filter(t => t.status === 'active').map(t => ({ id: t.id, text: t.title, group: t.group, area: t.area, delayed: false, calm: false })); return s; } s.question = 'מה הכי מעסיק אותך כרגע?'; s.chips = ['עבודה', 'כסף', 'בריאות', 'דברים בבית']; s.turns = 0; return s; }
    if (s.stage === 'delay') { const it = mockItems(text); it.forEach(x => { x.delayed = true; if (x.group !== 'worry') x.group = 'urgent'; s.items.push(x); }); }
    else if (s.stage === 'block') s.blockNote = text;
    else if (s.stage === 'calm') { s.items.forEach(x => { if (similar(x.text, text) || toks(text).some(w => toks(x.text).includes(w))) x.calm = true; }); }
    else { const it = mockItems(text); it.forEach(x => { if (!s.items.some(y => similar(y.text, x.text))) s.items.push(x); }); }
    const next = { undefined: 'delay', first: 'delay', delay: 'block', block: 'calm' }[s.stage] ;
    if (!s.stage || s.stage === 'first') s.stage = 'delay'; else if (s.stage === 'delay') s.stage = 'block'; else if (s.stage === 'block') s.stage = 'calm'; else s.stage = 'done';
    if (s.stage === 'delay') { s.question = 'האם יש משהו דחוף שאתה דוחה כבר הרבה זמן?'; s.chips = ['לא', 'כן, אכתוב']; }
    else if (s.stage === 'block') { s.question = 'מה הכי מפריע לך להתקדם?'; s.chips = ['חוסר זמן', 'אין לי כוח', 'לא יודע איפה להתחיל']; }
    else if (s.stage === 'calm') { s.question = 'איזה נושא ייתן לך הכי הרבה שקט אם תטפל בו?'; s.chips = []; }
    else Engine.summarize(s);
    return s;
  },
  summarize(s) {
    const score = x => ({ urgent: 5, project: 3, long: 3, small: 2, worry: 1, idea: 0 }[x.group] || 0) + (x.delayed ? 2 : 0) + (x.calm ? 2 : 0);
    const why = x => x.delayed ? 'אתה דוחה את זה כבר זמן' : x.calm ? 'ציינת שזה ייתן לך שקט' : x.group === 'urgent' ? 'נשמע דחוף לפי מה שכתבת' : x.group === 'project' ? 'פרויקט שמקדם משהו' : x.group === 'small' ? 'קטן ואפשר לסגור מהר' : x.group === 'worry' ? 'מעסיק אותך, בלי פעולה כרגע' : x.group === 'idea' ? 'רעיון לשמור להמשך' : 'חשוב לטווח ארוך';
    s.priorities = s.items.slice().sort((a, b) => score(b) - score(a)).map(x => ({ id: x.id, text: x.text, group: x.group, area: x.area, reason: why(x) }));
    const top = s.priorities.slice(0, 3).map(p => p.text);
    s.summary = s.priorities.length ? 'כרגע עולים ' + s.priorities.length + ' נושאים. המרכזיים לפי מה שכתבת: ' + top.join(' · ') + '.' : 'עוד לא כתבת נושאים. אפשר לחזור לשיחה ולכתוב מה מעסיק אותך.';
    s.phase = 'summary'; s.question = ''; s.chips = [];
  },
  suggestSteps(topic, s) { const c = s && s.sugg && s.sugg[topic]; if (c && c.length) return c; return ['לכתוב בשורה אחת מה התוצאה שאני רוצה', 'לפתוח את הקובץ או המסמך הרלוונטי', 'להתקשר או לשלוח הודעה אחת בנושא']; }
};

/* ---- Real AI (stage 2). The app talks only to our own Supabase Edge Function "doit-assistant" (it holds the Anthropic key; the key is never in the app).
   Used only when: signed in + the user gave consent. Any failure falls back to the dev stub, and the banner says so. ---- */
const AI = {
  fell: false, last: null, status: '',
  on() { return !!(Cloud.user && Cloud.sb && asstPrefs().consent); },
  async invoke(body) {
    const { data, error } = await Cloud.sb.functions.invoke('doit-assistant', { body });
    if (error) { let code = 'error'; try { const j = await error.context.json(); code = j.error || code; } catch (e) {} throw new Error(code); }
    if (!data || !data.ok) throw new Error('no_answer');
    return data;
  },
  async call(context) { this.last = context; return (await this.invoke({ context })).result; },
  ctx(s, text, task) { // the minimum needed: the conversation so far, what was sorted, and (only if allowed) titles from the user's lists
    const pf = asstPrefs(), T = TODAY(), h = s.history.slice(); if (h.length && h[h.length - 1].role === 'u') h.pop();
    const c = { task: task || 'turn', mode: s.mode, today: T, turnNumber: s.turns, areasOfInterest: pf.areas, newMessage: String(text || '').slice(0, 1500),
      transcript: h.slice(-12).map(x => ({ who: x.role === 'u' ? 'user' : 'assistant', text: String(x.text).slice(0, 500) })), knownItems: s.items.slice(0, 30).map(x => ({ text: x.text, group: x.group })) };
    if (pf.shareTitles) { c.memoryTopics = D().topics.slice(0, 20).map(t => ({ title: t.title, status: t.status })); if (s.mode === 'today') c.todayActions = tasksOn(T).filter(t => !t.done).slice(0, 25).map(t => ({ taskId: t.id, title: t.title, mins: t.mins })); }
    return c;
  },
  apply(s, r) { // validate everything the model returned before it touches the session
    const G = GROUPS.map(g => g[0]), AR = AREAS.map(a => a[0]), grp = g => G.includes(g) ? g : 'long', ar = a => AR.includes(a) ? a : '';
    const str = (v, n) => typeof v === 'string' ? v.trim().slice(0, n) : '', arr = v => Array.isArray(v) ? v : [];
    s.turns++; s.sugg = s.sugg || {};
    arr(r.items).slice(0, 12).forEach(x => { const t = str(x && x.text, 120); if (t && !s.items.some(y => similar(y.text, t))) s.items.push({ id: uid(), text: t, group: grp(x.group), area: ar(x.area), delayed: false, calm: false }); });
    const reply = str(r.reply, 500), q = str(r.question, 300); let phase = r.phase;
    s.chips = arr(r.chips).map(c => str(c, 40)).filter(Boolean).slice(0, 4); s.question = [reply, q].filter(Boolean).join('\n');
    if (phase === 'summary' && s.mode === 'order') {
      const pr = arr(r.priorities).slice(0, 12).map(p => { const t = str(p && p.text, 120); if (!t) return null; let it = s.items.find(y => similar(y.text, t)); if (!it) { it = { id: uid(), text: t, group: grp(p.group), area: ar(p.area) }; s.items.push(it); } return { id: it.id, text: t, group: grp(p.group), area: ar(p.area), reason: str(p.reason, 160) || 'לפי מה שכתבת' }; }).filter(Boolean);
      if (pr.length) { s.priorities = pr; s.summary = str(r.summary, 600) || reply; s.phase = 'summary'; s.question = ''; s.chips = []; } else Engine.summarize(s);
      return;
    }
    if (phase === 'steps' && s.mode === 'overwhelm') {
      const topic = (s.items[s.items.length - 1] || {}).text || str(r.summary, 80) || 'מה שמטריד אותי'; const sg = arr(r.stepSuggestions).map(x => str(x, 80)).filter(Boolean).slice(0, 3);
      if (sg.length) s.sugg[topic] = sg; s.focusIds = []; s.steps = [{ id: uid(), topic, title: '', mins: 10, on: true }]; s.stepIdx = 0; s.phase = 'steps'; s.reassure = reply; s.question = ''; s.chips = []; return;
    }
    if (phase === 'proposals' && s.mode === 'today') {
      const open = tasksOn(TODAY()).filter(t => !t.done), P = [];
      arr(r.proposals).slice(0, 4).forEach(p => { const type = p && p.type, reason = str(p.reason, 160) || 'לפי מה שכתבת';
        if (type === 'add') { const t = str(p.title, 120); if (t && !findSimilarAction(t)) P.push({ id: uid(), type, title: t, reason, on: true }); }
        else if (type === 'postpone' || type === 'drop') { const t = open.find(x => x.id === p.taskId); if (t) P.push({ id: uid(), type, title: t.title, taskId: t.id, reason, on: false }); } });
      s.proposals = P; s.phase = 'proposals'; s.summary = reply || (P.length ? 'הנה מה שהצעתי לעדכן, לפי מה שכתבת בלבד. סמן מה מתאים לך.' : 'לא מצאתי מה לעדכן. אפשר לכתוב עוד.'); s.question = ''; s.chips = []; return;
    }
    if (!s.question) s.question = 'ספר לי עוד, מה עוד מעסיק אותך?';
  }
};

Engine.turnAI = async function (s, text) {
  const t = text === '__sum__' ? 'בבקשה לסכם עכשיו: החזר phase summary לפי מה שנאמר עד כה' : text === '__skip__' ? '(המשתמש דילג על השאלה)' : text;
  AI.apply(s, await AI.call(AI.ctx(s, t, 'turn')));
};
const devTurnOnly = Engine.devTurn;
Engine.turn = async function (s, text) {
  if (AI.on()) { try { await Engine.turnAI(s, text); AI.fell = false; return s; } catch (e) { AI.fell = true; } }
  if (text === '__sum__') { Engine.summarize(s); return s; }
  return devTurnOnly.call(Engine, s, text);
};

/* ---- session control ---- */
function asstBegin(mode) {
  const s = { id: uid(), mode, phase: 'chat', history: [], items: [], priorities: [], proposals: [], steps: [], focusIds: [], question: '', chips: [], summary: '', turns: 0, stage: 'first', status: 'active', startedAt: new Date().toISOString() };
  Engine.start(s); if (s.question) s.history.push({ role: 'a', text: s.question }); asstSave(s); state.tab = 'assistant'; render(); window.scrollTo(0, 0);
}
async function asstSend(text, shown) {
  const s = asstSess(); if (!s) return; text = (text || '').trim(); if (!text) return;
  s.history.push({ role: 'u', text: shown || text }); s.pending = true; asstSave(s); render();
  try { await Engine.turn(s, text); } catch (e) { s.error = 'משהו השתבש. אפשר לנסות שוב.'; }
  s.pending = false; if (s.question) s.history.push({ role: 'a', text: s.question }); asstSave(s); render(); window.scrollTo(0, document.body.scrollHeight);
  if (s.phase === 'steps') asstFetchSteps();
}
async function asstFetchSteps() {
  const s = asstSess(); if (!s || !AI.on() || s.phase !== 'steps') return;
  const topic = s.mode === 'overwhelm' ? (s.steps[0] || {}).topic : (stepsPerTopic(s)[s.stepIdx] || {}).text; s.sugg = s.sugg || {}; if (!topic || s.sugg[topic]) return;
  try { const r = await AI.call(AI.ctx(s, topic, 'suggest_steps')), a = (Array.isArray(r.stepSuggestions) ? r.stepSuggestions : []).map(x => String(x).trim().slice(0, 80)).filter(Boolean).slice(0, 3); AI.fell = false; if (a.length) { s.sugg[topic] = a; asstSave(s); if (state.tab === 'assistant') render(); } } catch (e) { AI.fell = true; if (state.tab === 'assistant') render(); }
}
function asstEnd(toast_) { const s = asstSess(); if (s && s.history.length > 1) { D().sessions.push({ id: s.id, date: TODAY(), mode: s.mode, summary: s.summary || (s.history.find(h => h.role === 'u') || {}).text || '' }); } delete D().assist.session; Store.save(); state.tab = 'assistant'; render(); if (toast_) toast('<span>' + toast_ + '</span><button data-act="toastClose" aria-label="סגור">✕</button>', 6000); }
function stepsPerTopic(s) { return s.focusIds.map(id => s.priorities.find(p => p.id === id)).filter(Boolean); }
function asstCommit(s) { // turn the approved steps into real actions, avoiding duplicates; nothing happens without the user's approval
  const T = TODAY(); let added = 0, skipped = 0; const mem = D().topics;
  s.focusIds.forEach(id => { const p = s.priorities.find(x => x.id === id); if (p && !mem.some(t => t.id === id)) mem.push({ id, title: p.text, area: p.area || '', group: p.group, status: 'active', createdAt: T }); });
  s.priorities.forEach(p => { if (!mem.some(t => t.id === p.id) && p.group !== 'idea' && p.group !== 'worry') return; if (!mem.some(t => t.id === p.id)) mem.push({ id: p.id, title: p.text, area: p.area || '', group: p.group, status: 'parked', createdAt: T }); });
  const f = asstFocus(); if (s.mode === 'weekly') f.week = s.focusIds.slice(); else f.month = s.focusIds.slice(); D().assist.focus = f;
  s.steps.filter(x => x.on && x.title.trim()).forEach(st => {
    if (findSimilarAction(st.title) && !st.force) { skipped++; return; }
    const p = s.priorities.find(x => x.text === st.topic || x.id === st.topicId); let pid = '';
    if (p && p.group === 'project') { const ex = D().projects.find(pr => similar(pr.title, p.text)); if (ex) pid = ex.id; else { const np = { id: uid(), title: p.text, createdAt: T, quad: 'q2' }; D().projects.push(np); pid = np.id; } }
    D().tasks.push({ id: uid(), title: st.title.trim(), date: st.date === 'today' ? T : st.date === 'tomorrow' ? addDays(T, 1) : null, done: false, priority: 0, energy: 3, mins: st.mins || 15, brainless: false, print: false, visionId: '', projectId: pid, notes: p ? 'מתוך עוזר התכנון: ' + p.text : '', subs: [], jobId: '', quad: p && p.group === 'urgent' ? 'q1' : (p && (p.group === 'project' || p.group === 'long')) ? 'q2' : '', parked: !st.date || st.date === 'none' });
    added++;
  });
  return { added, skipped };
}

/* ---- views ---- */
const bubble = h => '<div class="bub ' + (h.role === 'u' ? 'me' : 'bot') + '">' + esc(h.text).replace(/\n/g, '<br>') + '</div>';
const devBanner = () => !AI.on() ? '<div class="devnote">🛠 מצב ללא AI: השאלות והסיווג כאן הם דוגמה מתוכנתת. כדי לחבר עוזר AI אמיתי, היכנס לחשבון והפעל אותו במסך הראשי של העוזר.</div>' : AI.fell ? '<div class="devnote">⚠ לא הצלחתי להתחבר ל-AI כרגע, ולכן התשובה האחרונה היא דוגמה מתוכנתת ולא AI. אפשר לנסות שוב.</div>' : '';
function aiCard() {
  const pf = asstPrefs(), head = '<div class="t"><b>🤖 עוזר AI אמיתי</b></div>';
  if (!Cloud.sb) return '<div class="card">' + head + '<div class="sub">לא זמין במצב דמו או בלי חיבור לענן.</div></div>';
  if (!Cloud.user) return '<div class="card">' + head + '<div class="sub">כדי להפעיל AI צריך להיכנס לחשבון.</div><div class="opt" style="margin-top:8px"><button data-act="account">כניסה</button></div></div>';
  if (!pf.consent) return '<div class="card">' + head + '<div class="sub">כרגע העוזר עובד בלי AI. אפשר להפעיל AI, אחרי שתראה בדיוק מה נשלח.</div><div class="opt" style="margin-top:8px"><button class="on" data-act="aiConsent">להפעיל עוזר AI</button></div></div>';
  const st = { ok: '✅ העוזר האמיתי מחובר ופעיל.', nokey: '⚠ השרת עוד לא קיבל מפתח AI (ראה הוראות).', login: '⚠ צריך להיכנס מחדש לחשבון.', error: '⚠ אין חיבור לפונקציית ה-AI (אולי עוד לא הותקנה).', busy: 'בודק חיבור...' }[AI.status] || 'מופעל. אפשר לבדוק שהחיבור עובד.';
  return '<div class="card">' + head + '<div class="sub">' + st + '</div><div class="opt" style="margin-top:8px"><button data-act="aiPing">בדוק חיבור</button><button data-act="aiWhat">מה נשלח?</button><button data-act="aiOff">כבה AI</button></div></div>';
}
function asstHome() {
  const s = asstSess(), pf = asstPrefs(), f = asstFocus(), tn = id => (D().topics.find(t => t.id === id) || {}).title;
  const mo = f.month.map(tn).filter(Boolean), wk = f.week.map(tn).filter(Boolean);
  return '<div class="top"><div class="row"><button class="iconbtn" data-act="goTab" data-t="more" aria-label="חזרה">' + chev('r') + '</button><div><h1>עוזר התכנון שלי</h1><div class="sub">בוא נעשה סדר במה שעל הפרק</div></div></div></div>' + devBanner() + aiCard()
    + (s ? '<div class="card focus"><div class="t"><b>שיחה שהתחלנו (' + esc((A_MODES.find(m => m[0] === s.mode) || [0, 0, ''])[2] || 'עוזר') + ')</b></div><div class="sub">אפשר להמשיך מאותו מקום</div><div class="opt" style="margin-top:8px"><button class="on" data-act="asstResume">◀ להמשיך</button><button data-act="asstDrop">להתחיל מחדש</button></div></div>' : '')
    + '<h2>במה נתמקד?</h2>' + A_MODES.map(m => '<div class="card row" data-act="asstBegin" data-m="' + m[0] + '"><span style="font-size:26px">' + m[1] + '</span><div class="grow"><div class="t"><b>' + m[2] + '</b></div><div class="sub">' + m[3] + '</div></div>' + chev('l') + '</div>').join('')
    + '<div class="card row" data-act="asstBegin" data-m="overwhelm"><span style="font-size:26px">🌊</span><div class="grow"><div class="t"><b>אני מוצף. תעזור לי לעשות סדר</b></div><div class="sub">פחות שאלות, וצעד קטן אחד</div></div>' + chev('l') + '</div>'
    + '<h2>הטווחים שלי</h2><div class="card"><div class="sub">🎯 מיקוד החודש</div><div class="t">' + (mo.length ? mo.map(esc).join(' · ') : 'עוד לא נבחר') + '</div><div class="sub" style="margin-top:8px">🗓 מיקוד השבוע</div><div class="t">' + (wk.length ? wk.map(esc).join(' · ') : 'עוד לא נבחר') + '</div></div>'
    + '<h2>תחומי חיים שרלוונטיים עכשיו</h2><div class="opt">' + AREAS.map(a => '<button class="' + (pf.areas.includes(a[0]) ? 'on' : '') + '" data-act="asstArea" data-a="' + a[0] + '">' + a[1] + '</button>').join('') + '</div>'
    + '<div class="card row" data-act="goTab" data-t="assistmem" style="margin-top:14px"><span style="font-size:24px">🧠</span><div class="grow"><div class="t"><b>הזיכרון של העוזר</b></div><div class="sub">' + D().topics.length + ' נושאים שמורים · לראות, לערוך ולמחוק</div></div>' + chev('l') + '</div>';
}
function asstChat(s) {
  const modeName = (A_MODES.find(m => m[0] === s.mode) || [0, '🌊', 'אני מוצף'])[2];
  return '<div class="top"><div class="row"><button class="iconbtn" data-act="asstExit" aria-label="חזרה">' + chev('r') + '</button><h1 style="font-size:19px">' + modeName + '</h1></div></div>' + devBanner()
    + '<div class="chatbox">' + s.history.map(bubble).join('') + (s.pending ? '<div class="bub bot">…</div>' : '') + '</div>'
    + (s.error ? '<div class="sub" style="color:var(--danger)">' + esc(s.error) + '</div>' : '')
    + (s.chips && s.chips.length && !s.pending ? '<div class="opt" style="margin:8px 0">' + s.chips.map(c => '<button data-act="asstChip" data-c="' + esc(c) + '">' + esc(c) + '</button>').join('') + '</div>' : '')
    + '<textarea id="asstInput" rows="3" placeholder="כתוב בחופשיות. שורה, משפט או כמה דברים ברצף" ' + (s.pending ? 'disabled' : '') + '></textarea>'
    + '<div class="grid2" style="margin-top:8px"><button class="btn" data-act="asstSendBtn" ' + (s.pending ? 'disabled' : '') + '>שלח ◀</button><button class="btn ghost" data-act="asstSkip">דלג על השאלה</button></div>'
    + '<div class="opt" style="margin-top:10px"><button data-act="asstPause">⏸ עצור והמשך אחר כך</button>' + (s.mode === 'order' && s.items.length ? '<button data-act="asstSummarize">מספיק, בוא נסכם</button>' : '') + (s.mode !== 'overwhelm' ? '<button data-act="asstBegin" data-m="overwhelm">🌊 אני מוצף</button>' : '') + '</div>';
}
function asstSummary(s) {
  return '<div class="top"><div class="row"><button class="iconbtn" data-act="asstBack" aria-label="חזרה לשיחה">' + chev('r') + '</button><h1 style="font-size:19px">מה הבנתי</h1></div></div>' + devBanner()
    + '<div class="card focus"><div class="t">' + esc(s.summary) + '</div><div class="sub" style="margin-top:4px">זה מבוסס רק על מה שכתבת. אפשר לתקן.</div></div>'
    + s.priorities.map((p, i) => '<div class="card"><div class="row"><div class="grow"><div class="t">' + (i + 1) + '. ' + esc(p.text) + '</div><div class="meta"><span class="chip">' + esc(aGroup(p.group)) + '</span>' + (p.area ? '<span>' + esc(aArea(p.area)) + '</span>' : '') + '<span>' + esc(p.reason) + '</span></div></div>'
      + '<button class="iconbtn" data-act="asstUp" data-i="' + i + '" aria-label="למעלה">▲</button><button class="iconbtn" data-act="asstDown" data-i="' + i + '" aria-label="למטה">▼</button></div>'
      + '<div class="opt" style="margin-top:6px"><button data-act="asstGroup" data-i="' + i + '">שנה סוג</button><button data-act="asstEditP" data-i="' + i + '">✏️ ערוך</button><button data-act="asstDelP" data-i="' + i + '">✕ הסר</button></div></div>').join('')
    + '<form id="asstAdd" class="row" style="margin-top:8px"><input name="t" placeholder="הוסף נושא שפספסתי" autocomplete="off"><button class="btn">הוסף</button></form>'
    + '<div class="grid2" style="margin-top:12px"><button class="btn" data-act="asstToFocus">✓ זה נכון. לבחור מיקוד ◀</button><button class="btn ghost" data-act="asstBack">↩ לתקן בשיחה</button></div>';
}
function asstFocusPick(s) {
  const cand = s.priorities.filter(p => p.group !== 'idea' && p.group !== 'worry');
  return '<div class="top"><div class="row"><button class="iconbtn" data-act="asstToSummary" aria-label="חזרה">' + chev('r') + '</button><h1 style="font-size:19px">במה נתמקד?</h1></div></div>' + devBanner()
    + '<p class="sub">בחר עד שלושה נושאים לתקופה הקרובה. ההחלטה שלך, וזו רק המלצה לפי הסדר.</p>'
    + cand.map(p => '<label class="card row pickrow"><input type="checkbox" data-act="asstPick" data-id="' + p.id + '" ' + (s.focusIds.includes(p.id) ? 'checked' : '') + ' style="width:22px;height:22px"><div class="grow"><div class="t">' + esc(p.text) + '</div><div class="meta"><span class="chip">' + esc(aGroup(p.group)) + '</span><span>' + esc(p.reason) + '</span></div></div></label>').join('')
    + '<div class="sub" style="margin:8px 0">נבחרו ' + s.focusIds.length + ' מתוך 3</div>'
    + '<button class="btn" style="width:100%" data-act="asstBuild" ' + (s.focusIds.length ? '' : 'disabled') + '>בנה לי תוכנית ◀</button>';
}
function asstSteps(s) {
  const tops = stepsPerTopic(s); if (s.mode === 'overwhelm') { const st = s.steps[0]; return '<div class="top"><h1 style="font-size:19px">צעד קטן אחד</h1></div>' + devBanner() + '<div class="card focus"><div class="t">מה שהכי מטריד: ' + esc(st.topic) + '</div>' + (s.reassure ? '<div class="sub">' + esc(s.reassure) + '</div>' : '') + '</div><label>מה הדבר הקטן ביותר שאפשר לעשות עכשיו?</label><input id="stepText" value="' + esc(st.title) + '" autocomplete="off" placeholder="צעד קטן וברור"><div class="opt" style="margin:8px 0">' + Engine.suggestSteps(st.topic, s).map(x => '<button data-act="asstStepChip" data-c="' + esc(x) + '">' + esc(x) + '</button>').join('') + '</div><div class="grid2"><button class="btn" data-act="asstStepSave">➕ להוסיף להיום ולהתחיל</button><button class="btn ghost" data-act="asstExit">לא עכשיו</button></div>'; }
  if (s.stepIdx < tops.length) { const p = tops[s.stepIdx]; return '<div class="top"><h1 style="font-size:19px">צעד ראשון ' + (s.stepIdx + 1) + ' מתוך ' + tops.length + '</h1></div>' + devBanner() + '<div class="card focus"><div class="t">' + esc(p.text) + '</div></div><label>מה הדבר הראשון שצריך לקרות כדי להתקדם בנושא הזה?</label><input id="stepText" autocomplete="off" placeholder="צעד קטן וברור"><div class="opt" style="margin:8px 0">' + Engine.suggestSteps(p.text, s).map(x => '<button data-act="asstStepChip" data-c="' + esc(x) + '">' + esc(x) + '</button>').join('') + '</div><div class="grid2"><button class="btn" data-act="asstStepNext">הבא ◀</button><button class="btn ghost" data-act="asstStepSkip">דלג על הנושא</button></div>'; }
  return '<div class="top"><h1 style="font-size:19px">התוכנית שלך</h1></div>' + devBanner() + '<p class="sub">סמן אילו צעדים להוסיף לרשימה. שום דבר לא נוסף בלי אישור.</p>'
    + (s.steps.length ? s.steps.map((st, i) => { const dup = findSimilarAction(st.title); return '<div class="card"><label class="row" style="color:var(--ink)"><input type="checkbox" data-act="asstStepOn" data-i="' + i + '" ' + (st.on && !dup ? 'checked' : (st.on && st.force ? 'checked' : '')) + ' style="width:22px;height:22px"><div class="grow"><div class="t">' + esc(st.title) + '</div><div class="sub">' + esc(st.topic) + '</div></div></label>' + (dup ? '<div class="sub" style="color:var(--warn-ink)">⚠ דומה לפעולה קיימת: ' + esc(dup.title) + ' <button class="lnk" data-act="asstForce" data-i="' + i + '">הוסף בכל זאת</button></div>' : '')
      + '<div class="opt" style="margin-top:6px">' + [['today', 'היום'], ['tomorrow', 'מחר'], ['none', 'בלי תאריך']].map(([v, l]) => '<button class="' + ((st.date || 'none') === v ? 'on' : '') + '" data-act="asstDate" data-i="' + i + '" data-d="' + v + '">' + l + '</button>').join('') + '</div></div>'; }).join('') : '<div class="empty">לא נוספו צעדים.</div>')
    + '<button class="btn" style="width:100%;margin-top:10px" data-act="asstCommit">✓ הוסף לרשימה שלי</button>';
}
function asstProposals(s) {
  return '<div class="top"><div class="row"><button class="iconbtn" data-act="asstExit" aria-label="חזרה">' + chev('r') + '</button><h1 style="font-size:19px">עדכון להיום</h1></div></div>' + devBanner()
    + '<div class="card focus"><div class="t">' + esc(s.summary) + '</div></div>'
    + s.proposals.map((p, i) => '<label class="card row pickrow"><input type="checkbox" data-act="asstProp" data-i="' + i + '" ' + (p.on ? 'checked' : '') + ' style="width:22px;height:22px"><div class="grow"><div class="t">' + ({ add: '➕ להוסיף: ', postpone: '⏭ לדחות למחר: ', drop: '↩ להחזיר למאגר: ' }[p.type]) + esc(p.title) + '</div><div class="sub">' + esc(p.reason) + '</div></div></label>').join('')
    + '<div class="grid2" style="margin-top:10px"><button class="btn" data-act="asstApply" ' + (s.proposals.length ? '' : 'disabled') + '>✓ עדכן את מה שסימנתי</button><button class="btn ghost" data-act="asstBack">↩ לכתוב עוד</button></div>';
}
function asstView() {
  const s = asstSess(); if (!s || s.status === 'paused' || state.asstHome) return asstHome();
  if (s.phase === 'summary') return asstSummary(s);
  if (s.phase === 'focus') return asstFocusPick(s);
  if (s.phase === 'steps') return asstSteps(s);
  if (s.phase === 'proposals') return asstProposals(s);
  if (s.phase === 'weekpick') return asstWeekPick(s);
  return asstChat(s);
}
function asstWeekPick(s) {
  const act = D().topics.filter(t => t.status === 'active'), f = asstFocus();
  return '<div class="top"><div class="row"><button class="iconbtn" data-act="asstExit" aria-label="חזרה">' + chev('r') + '</button><h1 style="font-size:19px">תכנון שבועי קצר</h1></div></div>' + devBanner()
    + '<p class="sub">מתוך הנושאים שלך, אילו נראה לך לקדם השבוע? בחר אחד עד שלושה.</p>'
    + act.map(t => '<label class="card row pickrow"><input type="checkbox" data-act="asstWeek" data-id="' + t.id + '" ' + (s.focusIds.includes(t.id) ? 'checked' : (f.week.includes(t.id) && !s.touched ? 'checked' : '')) + ' style="width:22px;height:22px"><div class="grow"><div class="t">' + esc(t.title) + '</div><div class="meta"><span class="chip">' + esc(aGroup(t.group)) + '</span>' + (f.month.includes(t.id) ? '<span>🎯 מיקוד החודש</span>' : '') + '</div></div></label>').join('')
    + (act.length ? '' : '<div class="empty">עוד אין נושאים שמורים. התחל ב"לעשות סדר בראש".</div>')
    + '<button class="btn" style="width:100%;margin-top:10px" data-act="asstWeekGo" ' + (act.length ? '' : 'disabled') + '>בנה לי תוכנית לשבוע ◀</button>';
}
function asstMemView() {
  const f = asstFocus();
  return '<div class="top"><h1>הזיכרון של העוזר</h1></div><p class="sub">כאן נשמר מה שסיפרת לעוזר. אפשר לערוך ולמחוק הכל.</p>'
    + '<h2>נושאים (' + D().topics.length + ')</h2>' + (D().topics.map(t => '<div class="card"><div class="row"><div class="grow"><div class="t">' + esc(t.title) + (f.month.includes(t.id) ? ' 🎯' : '') + (f.week.includes(t.id) ? ' 🗓' : '') + '</div><div class="meta"><span class="chip">' + esc(aGroup(t.group)) + '</span>' + (t.area ? '<span>' + esc(aArea(t.area)) + '</span>' : '') + '<span>' + ({ active: 'פעיל', parked: 'שמור להמשך', done: 'הושלם', dropped: 'ויתרתי' }[t.status] || '') + '</span></div></div></div>'
      + '<div class="opt" style="margin-top:6px">' + [['active', 'פעיל'], ['done', 'הושלם'], ['dropped', 'ויתרתי']].map(([v, l]) => '<button class="' + (t.status === v ? 'on' : '') + '" data-act="memStatus" data-id="' + t.id + '" data-s="' + v + '">' + l + '</button>').join('') + '<button data-act="memEdit" data-id="' + t.id + '">✏️</button><button data-act="memDel" data-id="' + t.id + '">🗑</button></div></div>').join('') || '<div class="empty">עוד לא נשמר כלום.</div>')
    + '<h2>שיחות קודמות (' + D().sessions.length + ')</h2>' + (D().sessions.slice().reverse().map(x => '<div class="card row"><div class="grow"><div class="t">' + esc(shortDate(x.date)) + ' · ' + esc((A_MODES.find(m => m[0] === x.mode) || [0, 0, 'אני מוצף'])[2]) + '</div><div class="sub">' + esc(x.summary) + '</div></div><button class="iconbtn" data-act="memDelSess" data-id="' + x.id + '" aria-label="מחק">🗑</button></div>').join('') || '<div class="sub">אין עדיין.</div>')
    + '<button class="btn danger" style="width:100%;margin-top:14px" data-act="memClear">🗑 מחק את כל הזיכרון</button>';
}
/* ---------- Personal reminders: two sentences shown on the daily screen and while working ---------- */
const REMINDERS = ['להרגיש את הכאב של הצמיחה, לצאת מאזור הנוחות.', 'האדם היחיד שאני רוצה להרשים הוא אני, בהשוואה לעצמי בלבד.', 'אני מזהה שיש בי פחד להישאר מאחור, אבל אני לא חייב לפעול מתוך הפחד הזה.'];
/* Encouragement: the user's own sentences (D().cheers, with a category), seeded once from the first three; shown on Today, in the focus sheet, while working, in the "עידוד" tab and when stuck */
const CHEER_CATS = [['gen', 'כללי'], ['fear', 'פחד והשוואה'], ['delay', 'דחיינות'], ['tired', 'עייפות וקושי'], ['win', 'הצלחה']];
const CHEER_SEED = [['c_seed1', 'gen', REMINDERS[0]], ['c_seed2', 'fear', REMINDERS[1]], ['c_seed3', 'fear', REMINDERS[2]]];
const cheerCatName = k => (CHEER_CATS.find(x => x[0] === k) || [0, 'כללי'])[1];
function cheerAll() {
  const d = D(); d.cheers = d.cheers || []; d.assist = d.assist || {};
  if (!d.assist.cheersSeeded) { CHEER_SEED.forEach(([id, cat, text]) => { if (!d.cheers.some(c => c.id === id)) d.cheers.push({ id, cat, text }); }); d.assist.cheersSeeded = 1; Store.save(); }
  return d.cheers;
}
const cheerPick = (L, shift) => { if (!L.length) return null; const n = Math.floor(parse(TODAY()).getTime() / 864e5) + (shift || 0); return L[((n % L.length) + L.length) % L.length]; };
const reminder = () => { const c = cheerPick(cheerAll(), state.remShift); return c ? c.text : REMINDERS[0]; };
const stuckLine = () => { const a = cheerAll(), h = a.filter(c => ['delay', 'tired', 'fear'].includes(c.cat)), L = h.length ? h : a, c = L.length ? L[((state.stuckShift || 0) % L.length + L.length) % L.length] : null; return c ? c.text : REMINDERS[0]; };
/* ---------- Daily focus: the most important task and the "fun" of the day; asked at the start of the day when missing ---------- */
const focusOn = d => { const f = D().focus[d] || {}, t = f.mitId ? D().tasks.find(x => x.id === f.mitId) : null; return { mit: t ? t.title : (f.mit || ''), mitId: t ? t.id : '', fun: f.fun || '', energy: normEnergy(f.energy) }; };
function focusCard(d) {
  const f = focusOn(d);
  if (!f.mit && !f.fun) return `<div class="card focus" data-act="focusEdit"><div class="t"><b>⭐ מה החשוב היום, ומה הפאן?</b></div><div class="sub">לחץ כדי לקבוע</div></div>`;
  return `<div class="card focus" data-act="focusEdit"><div class="frow"><span>⭐</span><div class="grow"><div class="sub">הפעולה החשובה של היום</div><div class="t">${f.mit ? esc(f.mit) : '—'}</div></div></div>
    <div class="frow"><span>🎉</span><div class="grow"><div class="sub">הפאן של היום</div><div class="t">${f.fun ? esc(f.fun) : '—'}</div></div></div>
    ${f.mit && d === TODAY() && !(f.mitId && (D().tasks.find(x => x.id === f.mitId) || {}).done) ? `<button class="btn startnow" data-act="runStart" data-id="${f.mitId}">◀ התחל עכשיו</button>` : ''}</div>`;
}
let focusSnooze = false;
function focusSheet(d) { // the morning sheet: one dropdown per choice, so it stays short and calm
  const f = focusOn(d), raw = D().focus[d] || {}, prevImp = (D().review[addDays(d, -1)] || {}).improve;
  const open = tasksOn(d).filter(t => !t.done).slice(0, 30), cur = f.mitId && open.some(t => t.id === f.mitId) ? f.mitId : (f.mit ? '__other' : '');
  sheet(`<h1>${d === TODAY() ? 'בוקר טוב 👋' : 'מיקוד היום'}</h1>${d === TODAY() ? morningBar('focus') : ''}
  <div class="focusnote">💬 ${esc(reminder())}${prevImp ? '<br>🔸 אתמול רצית לשפר: ' + esc(prevImp) : ''}</div>
  <form id="f" class="focusform">
   <label>⭐ הפעולה החשובה היום</label>
   <select name="mitSel"><option value="">בחר פעולה...</option>${open.map(t => '<option value="' + t.id + '" ' + (cur === t.id ? 'selected' : '') + '>' + esc(t.title) + '</option>').join('')}<option value="__other" ${cur === '__other' ? 'selected' : ''}>✏️ אחרת, אכתוב בעצמי</option></select>
   <input name="mit" value="${esc(f.mitId ? '' : f.mit)}" autocomplete="off" placeholder="כתוב את הפעולה החשובה" ${cur === '__other' ? '' : 'hidden'}>
   <label>🎉 הפאן של היום</label>
   <input name="fun" value="${esc(f.fun)}" autocomplete="off" placeholder="משהו שמשמח אותך לקראתו">
   <div class="two">
    <div><label>🎁 תנאי לתגמול</label><select name="rewardRule">${REWARD_RULES.map(([v, l]) => '<option value="' + v + '" ' + ((raw.rewardRule || '') === v ? 'selected' : '') + '>' + l + '</option>').join('')}</select></div>
    <div><label>🔋 אנרגיה</label><select name="energy"><option value="">בחר מצב...</option>${ENERGY_MODES.map(([v, l]) => '<option value="' + v + '" ' + (f.energy === v ? 'selected' : '') + '>' + l + '</option>').join('')}</select></div>
   </div>
   <div class="actions"><button type="button" class="btn ghost" data-act="focusLater">אין צורך</button><button class="btn">שמור</button></div>
  </form>`);
  const form = $('#f');
  form.mitSel.addEventListener('change', () => { const o = form.mitSel.value === '__other'; form.mit.hidden = !o; if (o) form.mit.focus(); });
  form.onsubmit = e => {
    e.preventDefault(); const fd = new FormData(form), sel = fd.get('mitSel') || '';
    const mitId = sel && sel !== '__other' ? sel : '', mit = sel === '__other' ? fd.get('mit').trim() : '';
    Object.assign(fo(d), { mit, mitId, fun: fd.get('fun').trim(), energy: fd.get('energy') || '', rewardRule: fd.get('rewardRule') || '', energyAt: new Date().toISOString() });
    Morning.active = false; Store.save(); closeSheet(); render();
  };
}
function askFocus() { // start-of-day prompt: only for today, only if something is missing, never over another open sheet
  const T = TODAY(), f = focusOn(T), raw = D().focus[T] || {};
  if (focusSnooze || raw.askedAt || (f.mit && f.fun) || !$('#sheet').hidden) return; // asked once per day, never again after it was shown or filled
  fo(T).askedAt = new Date().toISOString(); Store.save();
  focusSheet(T);
}
/* ---------- Repeating tasks: finishing one creates the next occurrence ---------- */
const REPEATS = [['', 'לא חוזרת'], ['d1', 'כל יום'], ['d2', 'כל יומיים'], ['d3', 'כל 3 ימים'], ['w1', 'כל שבוע'], ['w2', 'כל שבועיים'], ['m1', 'כל חודש']];
const repeatLabel = r => (REPEATS.find(x => x[0] === r) || [0, ''])[1];
function nextRepeatDate(t) {
  const T = TODAY(), base = t.date && t.date > T ? t.date : T, n = +t.repeat.slice(1);
  if (t.repeat[0] === 'm') { const d = parse(base); d.setMonth(d.getMonth() + n); return fmt(d); }
  return addDays(base, t.repeat[0] === 'w' ? 7 * n : n);
}
function taskRow(t, showDate) {
  const v = t.visionId ? visionName(t.visionId) : '';
  // Parent task; its subtasks are nested right under it.
  const subsHtml = (t.subs && t.subs.length && !t.collapsed) ? `<div class="subs">${t.subs.map(s => `<div class="row ${s.done ? 'done' : ''}"><button class="check ${s.done ? 'on' : ''}" data-act="subToggle" data-id="${t.id}" data-sid="${s.id}">${s.done ? '✓' : ''}</button><div class="t grow" data-act="taskMenu" data-id="${t.id}">${esc(s.title)}</div></div>`).join('')}</div>` : '';
  return `<div class="grp" data-tid="${t.id}"><div class="card row p${effQuad(t) === 'q1' ? 2 : t.priority} ${t.done ? 'done' : ''}">
    <button class="check ${t.done ? 'on' : ''}" data-act="toggleTask" data-id="${t.id}">${t.done ? '✓' : ''}</button>
    <div class="grow" data-act="taskMenu" data-id="${t.id}">
      <div class="t">${titleP(t)}</div>
      <div class="meta">${t.brainless ? '<span class="chip" style="background:var(--warn-bg);color:var(--warn-ink)">⚡ Brainless</span>' : ''}${showDate && t.date ? `<span>${shortDate(t.date)}</span>` : ''}${subToggle(t)}${t.print ? '<span>🖨</span>' : ''}${t.want ? '<span title="כמה בא לי">💗' + t.want + '</span>' : ''}${t.inbox ? '<span>📥 נקלט</span>' : ''}${t.parked ? '<span>📦 מאגר</span>' : ''}${focusOn(t.date || '').mitId === t.id ? '<span class="chip" style="background:var(--warn-bg);color:var(--warn-ink)">⭐ החשובה</span>' : ''}${t.repeat ? `<span title="${repeatLabel(t.repeat)}">🔁 ${repeatLabel(t.repeat)}</span>` : ''}${v ? `<span class="chip">${esc(v)}</span>` : ''}</div>
    </div>${t.done ? '' : `<button class="playbtn" data-act="runStart" data-id="${t.id}" aria-label="התחל עכשיו">◀</button>`}</div>${subsHtml}</div>`;
}
function habitRow(h, d) {
  const on = habitDone(h, d), v = h.visionId ? visionName(h.visionId) : '';
  return `<div class="card row ${on ? 'done' : ''}">
    <button class="check ${on ? 'on' : ''}" data-act="toggleHabit" data-id="${h.id}" data-date="${d}">${on ? '✓' : ''}</button>
    <div class="grow" data-act="editHabit" data-id="${h.id}"><div class="t">${esc(h.task || h.title)}</div>
    <div class="meta">${h.task ? `<span class="chip">🔁 ${esc(h.title)}</span>` : ''}<span>🔥 ${streak(h)}</span>${h.energy ? `<span style="color:var(--accent)">${stars(h.energy)}</span>` : ''}${h.mins ? `<span>${h.mins} ד׳</span>` : ''}${v ? `<span class="chip">${esc(v)}</span>` : ''}</div></div></div>`;
}

/* ---------- Upcoming board helpers ---------- */
const shiftMonth = (ym, n) => { const [y, m] = ym.split('-').map(Number); return fmt(new Date(y, m - 1 + n, 1)).slice(0, 7); };
// Collapse/expand chip for a parent task's subtasks (state is saved on the task as `collapsed`).
const subToggle = t => subProg(t) ? `<button class="chip subtog ${t.collapsed ? 'closed' : ''}" data-act="toggleSubs" data-id="${t.id}" aria-expanded="${!t.collapsed}">☰ ${subProg(t)}</button>` : '';
// "Done" view: finished actions grouped by the day they were finished (older ones fall back to their planned date), newest first
function doneBoard() {
  const T = TODAY(), by = {};
  D().tasks.filter(t => t.done).forEach(t => { const k = t.doneAt || t.date || ''; (by[k] = by[k] || []).push(t); });
  const keys = Object.keys(by).sort().reverse(), n = D().tasks.filter(t => t.done).length;
  const lbl = k => !k ? 'ללא תאריך' : k === T ? 'היום' : k === addDays(T, -1) ? 'אתמול' : longDate(k);
  return `<div class="top"><h1>כל הפעולות</h1></div>${allSeg()}
    <div class="sub" style="margin:6px 0">${n} פעולות שבוצעו, מהאחרון לראשון.</div>
    ${keys.map(k => `<h2>${lbl(k)} (${by[k].length})</h2>${by[k].map(t => taskRow(t, false)).join('')}`).join('') || '<div class="empty">עוד לא בוצעו פעולות</div>'}`;
}
function upCard(t, showDate) {
  const v = t.brainless ? '<span class="chip" style="background:var(--warn-bg);color:var(--warn-ink)">⚡ Brainless</span>' : '';
  const subs = (t.subs && t.subs.length && !t.collapsed) ? `<div class="usubs">${t.subs.map(s => `<div class="urow ${s.done ? 'done' : ''}"><button class="check ${s.done ? 'on' : ''}" data-act="subToggle" data-id="${t.id}" data-sid="${s.id}">${s.done ? '✓' : ''}</button><div class="t grow" data-act="taskMenu" data-id="${t.id}">${esc(s.title)}</div></div>`).join('')}</div>` : '';
  return `<div class="ucard p${t.priority} ${t.done ? 'done' : ''}" data-task="${t.id}"><div class="urow">
    <button class="check ${t.done ? 'on' : ''}" data-act="toggleTask" data-id="${t.id}">${t.done ? '✓' : ''}</button>
    <div class="grow" data-act="taskMenu" data-id="${t.id}"><div class="t">${titleP(t)}</div>
    <div class="meta">${v}${showDate && t.date ? `<span style="color:var(--danger)">${shortDate(t.date)}</span>` : ''}${subToggle(t)}</div></div></div>${subs}</div>`;
}
const upCol = (drop, head, count, body, extra = '') => `<section class="ucol" data-drop="${drop}"><div class="uhead"><b>${head}</b><span class="sub">${count}</span>${extra}</div>${body}</section>`;

const filterOk = t => (!state.fQuad || (state.fQuad === 'none' ? !effQuad(t) : effQuad(t) === state.fQuad)) && (!state.fWant || (t.want || 0) >= state.fWant);
const filterBar = () => '<details class="fdet" ' + (state.fQuad || state.fWant ? 'open' : '') + '><summary>🧭 סינון לפי עדיפות' + (state.fQuad || state.fWant ? ' · פעיל' : '') + '</summary>'
  + '<div class="opt fq"><span class="sub">🧭</span>' + [['', 'הכל']].concat(QUADS.map(q => [q[0], q[1]]), [['none', 'ללא סיווג']]).map(([k, l]) => '<button class="' + ((state.fQuad || '') === k ? 'on' : '') + '" data-act="filterQuad" data-q="' + k + '">' + l + '</button>').join('') + '</div>'
  + '<div class="opt fq"><span class="sub">💗</span>' + [[0, 'הכל'], [3, '3 ומעלה'], [4, '4 ומעלה'], [5, '5']].map(([n, l]) => '<button class="' + ((state.fWant || 0) === n ? 'on' : '') + '" data-act="filterWant" data-n="' + n + '">' + l + '</button>').join('') + '</div>'
  + (state.fQuad || state.fWant ? '<button class="lnk" data-act="filterReset">נקה סינון</button>' : '') + '</details>';
/* ---------- Project map: a calm overview of the projects I promote (why, values, progress, weekly focus) ---------- */
const PM_STATUS = [['focus', '🎯', 'במיקוד כרגע'], ['active', '🌱', 'פעיל'], ['paused', '⏸️', 'מושהה'], ['future', '🔭', 'עתידי'], ['done', '🏁', 'הושלם']];
const PM_AREAS0 = [['a1', '💼', 'עסקים וקריירה'], ['a2', '🚀', 'יזמות'], ['a3', '📚', 'למידה והתפתחות מקצועית'], ['a4', '💰', 'כלכלה והשקעות'], ['a5', '🏃', 'בריאות וספורט'], ['a6', '🤝', 'מערכות יחסים וחיים חברתיים'], ['a7', '🌱', 'התפתחות אישית'], ['a8', '🎈', 'פנאי וחוויות'], ['a9', '🌟', 'חלומות ושאיפות עתידיות']];
const PM_VALUES0 = ['סקרנות', 'יצירתיות', 'יזמות', 'למידה', 'אומץ', 'הנאה', 'חופש', 'נוכחות'];
const PM_COLORS = ['#1f6f5c', '#e8a33d', '#3b6fd4', '#c0453a', '#8a5cc2', '#2f9aa8', '#d46a9c', '#6f8f2f'];
const PM_ICONS = ['🚀', '💼', '📚', '💰', '🏃', '❤️', '🌱', '🎨', '🏠', '✈️', '🎯', '💡', '🛠️', '🎓', '🧘', '🌟'];
const PM_RANGES = [['m1', 'עד חודש'], ['m3', 'עד 3 חודשים'], ['m6', 'עד חצי שנה'], ['y1', 'עד שנה'], ['long', 'טווח ארוך']];
const PM_PRIO = [['high', 'גבוהה'], ['mid', 'בינונית'], ['low', 'נמוכה']];
const pmAreas = () => (D().assist.areas && D().assist.areas.length ? D().assist.areas : PM_AREAS0.map(([id, icon, name]) => ({ id, icon, name })));
const pmValues = () => D().assist.values || PM_VALUES0;
const pmSaveAreas = a => { D().assist.areas = a; Store.save(); };
const pmArea = p => pmAreas().find(a => a.id === p.area);
const pmStatus = p => p.status || 'active';
const pmColor = p => p.color || PM_COLORS[Math.max(0, D().projects.indexOf(p)) % PM_COLORS.length];
const pmIcon = p => p.icon || '📁';
const pmPct = p => pmPctAt(p, null); // main actions only (sub-actions are not counted twice); a ⭐ milestone counts three times
const pmDays = p => p.due ? Math.round((parse(p.due) - parse(TODAY())) / 864e5) : null;
const pmLeft = p => { const n = pmDays(p); if (n === null) return 'ללא תאריך יעד'; if (n < 0) return `עברו ${-n} ימים מהיעד`; if (n === 0) return 'היעד היום'; if (n <= 45) return `נותרו ${n} ימים`; const m = Math.round(n / 30.4); if (m < 18) return `נותרו כ-${m} חודשים`; return `נותרו כ-${(n / 365).toFixed(1).replace('.0', '')} שנים`; };
const pmInRange = (p, r) => { if (!r) return true; const n = pmDays(p); if (r === 'long') return n === null || n > 366; return n !== null && n <= { m1: 31, m3: 92, m6: 183, y1: 366 }[r]; };
const pmFocusTask = p => { const t = p.focusTaskId && findTask(p.focusTaskId); return t && t.projectId === p.id && !t.done ? t : null; };
const pmOrdered = p => D().tasks.filter(t => t.projectId === p.id && !t.done).map((t, i) => [t, i]).sort((a, b) => (a[0].pord ?? 1e6 + a[1]) - (b[0].pord ?? 1e6 + b[1])).map(x => x[0]);
const pmRing = (p, size) => {
  const pr = pmPct(p), r = 26, c = 2 * Math.PI * r;
  if (pr === null) return `<div class="pmring none" style="width:${size}px;height:${size}px"><small>התקדמות<br>טרם הוגדרה</small></div>`;
  return `<div class="pmring" style="width:${size}px;height:${size}px"><svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="${r}" fill="none" stroke="var(--line)" stroke-width="7"/><circle class="pmarc" cx="32" cy="32" r="${r}" fill="none" stroke="${pmColor(p)}" stroke-width="7" stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - pr / 100)).toFixed(1)}" style="--c:${c.toFixed(1)}" transform="rotate(-90 32 32)"/></svg><b>${pr}%</b></div>`;
};
const pmChips = p => (p.values || []).map(v => `<span class="pmval">${esc(v)}</span>`).join('');
// ---- Stage 5: project objects. One small SVG per life area; it gains parts as real progress passes 25/50/75/100% and never shrinks (pmMax = high-water mark).
const PM_KIND = { a1: 'building', a2: 'lab', a3: 'books', a4: 'growth', a5: 'park', a6: 'meeting', a7: 'sprout', a8: 'mountain', a9: 'star' };
const PM_OBJ = {
  building: [[1, '<rect x="22" y="34" width="22" height="20" rx="2" fill="currentColor"/>'], [2, '<rect x="12" y="26" width="13" height="28" rx="2" fill="currentColor" opacity=".78"/>'], [3, '<rect x="40" y="22" width="13" height="32" rx="2" fill="currentColor" opacity=".9"/><g fill="#fff" opacity=".75"><rect x="26" y="39" width="4" height="4"/><rect x="34" y="39" width="4" height="4"/><rect x="15" y="31" width="3" height="3"/><rect x="43" y="28" width="3" height="3"/><rect x="48" y="28" width="3" height="3"/></g>'], [4, '<rect x="45" y="13" width="3" height="10" fill="currentColor"/><circle cx="46.5" cy="12" r="2.4" fill="var(--accent)"/>'], [5, '<rect x="26" y="22" width="1.6" height="12" fill="currentColor"/><path d="M27.6 22v8l8-4z" fill="var(--accent)"/>']],
  lab: [[1, '<path d="M26 18h12v10l10 20a4 4 0 0 1-3.6 6H19.6A4 4 0 0 1 16 48l10-20z" fill="currentColor" opacity=".85"/>'], [2, '<path d="M20 44h24l3 6a2 2 0 0 1-1.8 3H18.8A2 2 0 0 1 17 50z" fill="#fff" opacity=".35"/><circle cx="28" cy="40" r="2" fill="#fff" opacity=".7"/><circle cx="36" cy="36" r="1.5" fill="#fff" opacity=".7"/>'], [3, '<circle cx="32" cy="9" r="5" fill="var(--accent)"/><rect x="30" y="13" width="4" height="4" rx="1" fill="currentColor"/>'], [4, '<g stroke="var(--accent)" stroke-width="1.8" stroke-linecap="round"><path d="M22 6l-3-2M42 6l3-2M20 12h-4M44 12h4"/></g>'], [5, '<path d="M52 20l1.6 4 4 1.6-4 1.6L52 31l-1.6-3.8-4-1.6 4-1.6z" fill="var(--accent)"/>']],
  books: [[1, '<rect x="14" y="44" width="36" height="9" rx="1.5" fill="currentColor"/>'], [2, '<rect x="18" y="35" width="30" height="9" rx="1.5" fill="currentColor" opacity=".75"/>'], [3, '<rect x="16" y="26" width="32" height="9" rx="1.5" fill="currentColor" opacity=".9"/>'], [4, '<g fill="#fff" opacity=".6"><rect x="18" y="47" width="14" height="2"/><rect x="22" y="38" width="12" height="2"/><rect x="20" y="29" width="14" height="2"/></g>'], [5, '<path d="M32 8l16 7-16 7-16-7z" fill="var(--accent)"/><path d="M24 20v5c4 3 12 3 16 0v-5" fill="none" stroke="currentColor" stroke-width="2"/>']],
  growth: [[1, '<rect x="12" y="42" width="10" height="12" rx="1.5" fill="currentColor" opacity=".6"/>'], [2, '<rect x="27" y="34" width="10" height="20" rx="1.5" fill="currentColor" opacity=".8"/>'], [3, '<rect x="42" y="24" width="10" height="30" rx="1.5" fill="currentColor"/>'], [4, '<path d="M12 34l16-10 10 6 16-16M48 14h7v7" fill="none" stroke="var(--accent)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>'], [5, '<circle cx="16" cy="12" r="6" fill="var(--accent)"/><text x="16" y="15.5" font-size="9" text-anchor="middle" fill="#fff" font-weight="700">₪</text>']],
  park: [[1, '<rect x="30" y="40" width="4" height="14" fill="#8b6b4a"/><circle cx="32" cy="34" r="10" fill="currentColor" opacity=".75"/>'], [2, '<circle cx="32" cy="28" r="14" fill="currentColor" opacity=".9"/>'], [3, '<rect x="47" y="46" width="3" height="8" fill="#8b6b4a"/><circle cx="48.5" cy="42" r="7" fill="currentColor" opacity=".7"/>'], [4, '<path d="M8 54q12-6 22 0" fill="none" stroke="#fff" stroke-width="2" opacity=".55" stroke-linecap="round"/><rect x="11" y="46" width="12" height="2.5" rx="1" fill="#8b6b4a"/><rect x="12" y="48" width="1.6" height="5" fill="#8b6b4a"/><rect x="21" y="48" width="1.6" height="5" fill="#8b6b4a"/>'], [5, '<circle cx="53" cy="11" r="6" fill="var(--accent)"/>']],
  meeting: [[1, '<ellipse cx="32" cy="46" rx="20" ry="7" fill="currentColor" opacity=".85"/>'], [2, '<circle cx="20" cy="30" r="5" fill="currentColor"/><path d="M12 42a8 8 0 0 1 16 0z" fill="currentColor" opacity=".8"/>'], [3, '<circle cx="44" cy="30" r="5" fill="currentColor"/><path d="M36 42a8 8 0 0 1 16 0z" fill="currentColor" opacity=".8"/>'], [4, '<circle cx="32" cy="22" r="5" fill="currentColor"/><path d="M24 34a8 8 0 0 1 16 0z" fill="currentColor" opacity=".8"/>'], [5, '<path d="M32 9c-3-5-10-2-7 3 2 3 7 6 7 6s5-3 7-6c3-5-4-8-7-3z" fill="var(--accent)"/>']],
  sprout: [[1, '<path d="M32 54V38" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>'], [2, '<path d="M32 46c-8 0-12-5-12-10 8 0 12 4 12 10z" fill="currentColor" opacity=".75"/><path d="M32 42c8 0 12-5 12-10-8 0-12 4-12 10z" fill="currentColor" opacity=".9"/>'], [3, '<path d="M32 40V24" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>'], [4, '<ellipse cx="32" cy="19" rx="4" ry="6" fill="var(--accent)"/>'], [5, '<g fill="var(--accent)"><circle cx="32" cy="12" r="4"/><circle cx="26" cy="18" r="4"/><circle cx="38" cy="18" r="4"/><circle cx="29" cy="24" r="4"/><circle cx="35" cy="24" r="4"/></g><circle cx="32" cy="18" r="3.4" fill="#fff"/>']],
  mountain: [[1, '<path d="M8 54L28 20l20 34z" fill="currentColor" opacity=".85"/>'], [2, '<path d="M30 54l16-24 14 24z" fill="currentColor" opacity=".65"/>'], [3, '<path d="M22 54q8-8 2-14t6-12" fill="none" stroke="#fff" stroke-width="1.8" stroke-dasharray="3 3" stroke-linecap="round" opacity=".8"/>'], [4, '<circle cx="52" cy="14" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M52 9l2 5-2 5-2-5z" fill="var(--accent)"/>'], [5, '<rect x="27" y="7" width="1.6" height="13" fill="currentColor"/><path d="M28.6 7v8l8-4z" fill="var(--accent)"/>']],
  star: [[1, '<circle cx="32" cy="34" r="6" fill="currentColor"/>'], [2, '<circle cx="32" cy="34" r="12" fill="none" stroke="currentColor" stroke-width="1.6" opacity=".5"/>'], [3, '<path d="M32 12l5.5 12 13 1.5-9.7 8.8 2.7 12.9L32 40l-11.5 7.2 2.7-12.9-9.7-8.8 13-1.5z" fill="currentColor" opacity=".9"/>'], [4, '<ellipse cx="32" cy="30" rx="26" ry="8" fill="none" stroke="var(--accent)" stroke-width="1.6" transform="rotate(-20 32 30)"/>'], [5, '<circle cx="52" cy="12" r="3" fill="var(--accent)"/><circle cx="10" cy="20" r="2" fill="var(--accent)"/>']]
};
const pmKind = areaId => PM_KIND[areaId] || 'star';
const pmStageOf = pr => pr >= 100 ? 5 : pr >= 75 ? 4 : pr >= 50 ? 3 : pr >= 25 ? 2 : 1;
const pmHigh = p => { const pr = pmPct(p) || 0; if (pr > (p.pmMax || 0)) p.pmMax = pr; return p.pmMax || 0; }; // a quiet week never shrinks the object
const pmObjInner = (kind, stage) => '<ellipse cx="32" cy="56" rx="24" ry="5" fill="currentColor" opacity=".16"/>' + PM_OBJ[kind].filter(x => x[0] <= stage).map(x => x[1]).join('');
const pmObj = (p, size) => `<svg class="pmobj" style="width:${size}px;height:${size}px" viewBox="0 0 64 64" aria-hidden="true">${pmObjInner(pmKind(p.area), pmStageOf(pmHigh(p)))}</svg>`;
const pmNextMile = p => { const t = pmOrdered(p).find(x => x.milestone); return t ? t.title : ''; };

// ---- Stage 4: the life map. Islands per life area; click = camera zoom into the area's projects. A plain list view stays available.
const pmWorldOn = () => document.documentElement.dataset.design === 'spatial' && (D().assist.pmView || 'world') === 'world';
const pmIsles = () => {
  const list = pmVisible(), all = pmAreas().map((a, i) => ({ id: a.id, icon: a.icon, name: a.name, i }));
  if (D().projects.some(p => !pmArea(p))) all.push({ id: '_none', icon: '📁', name: 'ללא תחום', i: all.length });
  return all.map(a => {
    const ps = list.filter(p => (pmArea(p) ? p.area : '_none') === a.id), hs = ps.map(p => Math.max(pmPct(p) || 0, pmHigh(p))), avg = hs.length ? Math.round(hs.reduce((x, y) => x + y, 0) / hs.length) : 0;
    return { ...a, ps, avg, color: PM_COLORS[a.i % PM_COLORS.length], kind: PM_KIND[a.id] || 'star' };
  });
};
function pmWorld() {
  const I = pmIsles(), cols = 3, rowH = 158, rows = Math.ceil(I.length / cols), H = rows * rowH + 30;
  const pos = I.map((a, k) => { const r = Math.floor(k / cols), c = k % cols, inRow = Math.min(cols, I.length - r * cols), x = (c + .5) * (100 / inRow); return { x: r % 2 ? 100 - x : x, y: r * rowH + 12 + (c % 2 ? 22 : 0) }; });
  const path = pos.map((p, k) => `${k ? 'L' : 'M'}${(p.x * 3).toFixed(0)} ${p.y + 62}`).join(' ');
  return `<div class="world" id="world" style="height:${H}px"><svg class="wpaths" viewBox="0 0 300 ${H}" preserveAspectRatio="none" aria-hidden="true"><path d="${path}" fill="none" stroke="var(--brand)" stroke-width="2" stroke-dasharray="2 7" stroke-linecap="round" opacity=".35" vector-effect="non-scaling-stroke"/></svg>
    ${I.map((a, k) => `<button class="isle" style="left:${pos[k].x}%;top:${pos[k].y}px;--pc:${a.color};--d:${(k * .37).toFixed(2)}s" data-act="pmIsle" data-id="${a.id}" aria-label="${esc(a.name)}: ${a.ps.length} פרויקטים">
      <svg viewBox="0 0 120 112" aria-hidden="true"><defs><linearGradient id="ig${k}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a.color}" stop-opacity=".35"/><stop offset="1" stop-color="${a.color}" stop-opacity=".95"/></linearGradient></defs>
        <path d="M12 68Q60 100 108 68z" fill="url(#ig${k})"/><ellipse cx="60" cy="68" rx="50" ry="14" fill="${a.color}" opacity=".28"/><ellipse cx="60" cy="67" rx="46" ry="11" fill="var(--card)" opacity=".85"/>
        <svg x="24" y="4" width="72" height="72" viewBox="0 0 64 64" style="color:${a.color}">${pmObjInner(a.kind, a.ps.length ? pmStageOf(a.avg) : 1)}</svg></svg>
      <b>${a.icon} ${esc(a.name)}</b><small>${a.ps.length ? a.ps.length + ' פרויקטים · ' + a.avg + '%' : 'אין פרויקטים'}</small></button>`).join('')}</div>`;
}
function pmIsleView(id) {
  const a = pmIsles().find(x => x.id === id); if (!a) { state.pmIsle = null; return pmMap(); }
  return `<div class="top"><button class="iconbtn" data-act="pmWorldBack" aria-label="חזרה למפת החיים">${chev('r')}<span style="margin-inline-start:6px">🌍 מפת החיים</span></button><div class="sw"><button class="iconbtn" data-act="pmNew" aria-label="פרויקט חדש">＋</button></div></div>
    <div class="pmhero isleview" style="--pc:${a.color}"><svg class="pmobj" style="width:96px;height:96px;color:${a.color}" viewBox="0 0 64 64" aria-hidden="true">${pmObjInner(a.kind, a.ps.length ? pmStageOf(a.avg) : 1)}</svg><div class="grow"><div class="sub">תחום חיים</div><div class="pmoutcome">${a.icon} ${esc(a.name)}</div><div class="pmleft">${a.ps.length ? a.ps.length + ' פרויקטים · התקדמות ממוצעת ' + a.avg + '%' : 'עוד אין כאן פרויקטים'}</div></div></div>
    ${a.ps.length ? `<div id="pmcards">${a.ps.map(pmCard).join('')}</div>` : '<div class="empty">אפשר להוסיף כאן פרויקט ראשון עם ＋</div>'}`;
}

function pmCard(p) {
  const f = pmFocusTask(p), st = PM_STATUS.find(x => x[0] === pmStatus(p)), a = pmArea(p), live = ['focus', 'active'].includes(pmStatus(p));
  return `<div class="pmcard" style="--pc:${pmColor(p)}" data-act="pmOpen" data-id="${p.id}">
    <div class="pmhead"><span class="pmgrip" data-act="pmNoop" title="גרור לשינוי סדר" aria-label="גרור לשינוי סדר">⋮⋮</span><span class="pmicon">${pmIcon(p)}</span><div class="grow"><b class="pmname">${esc(p.title)}</b><div class="sub">${a ? esc(a.icon + ' ' + a.name) + ' · ' : ''}${st[1]} ${st[2]}</div></div>${pmRing(p, 68)}</div>
    <div class="pmleft">⏳ ${pmLeft(p)}${p.due ? ' · ' + shortDate(p.due) : ''}</div>
    <div class="pmmid"><div class="pmobjwrap">${pmObj(p, 84)}</div><div class="grow">${p.why ? `<div class="pmwhy">“${esc(p.why)}”</div>` : `<div class="pmwhy none">אפשר להוסיף כאן את ה״למה״ שלך (✏️ בתוך הפרויקט)</div>`}
    ${p.values && p.values.length ? `<div class="pmvals">${pmChips(p)}</div>` : ''}${pmNextMile(p) ? `<div class="pmnext">⭐ אבן הדרך הבאה: <b>${esc(pmNextMile(p))}</b></div>` : ''}</div></div>
    ${f ? `<div class="pmfocus">🎯 <span>המיקוד השבוע</span><b>${esc(f.title)}</b></div>` : (live ? `<button class="lnk pmpick" data-act="pmFocusSet" data-id="${p.id}">＋ בחר מיקוד לשבוע</button>` : '')}
    <div class="pmopen">לפתיחת הפרויקט ${chev('l')}</div></div>`;
}
function pmVisible() {
  const S = state.pmStatus || 'live', A = state.pmArea || '', R = state.pmRange || '';
  const rank = p => ({ focus: 0, active: 1, future: 2, paused: 3, done: 4 }[pmStatus(p)]), pr = p => ({ high: 0, mid: 1, low: 2 }[p.prio] ?? 1);
  return D().projects.filter(p => (S === 'all' || (S === 'live' ? ['focus', 'active'].includes(pmStatus(p)) : pmStatus(p) === S)) && (!A || p.area === A) && pmInRange(p, R) && (!state.pmPrio || (p.prio || 'mid') === state.pmPrio) && (!state.pmValue || (p.values || []).includes(state.pmValue)))
    .sort((a, b) => (a.mord ?? 1e6) - (b.mord ?? 1e6) || rank(a) - rank(b) || pr(a) - pr(b) || (a.due || '9999').localeCompare(b.due || '9999'));
}
function pmMap() {
  const S = state.pmStatus || 'live', list = pmVisible(), home = D().assist.homeTab === 'map', live = D().projects.filter(p => ['focus', 'active'].includes(pmStatus(p)));
  const sel = (key, cur, opts, all) => `<select data-pmf="${key}" aria-label="${all}"><option value="">${all}</option>${opts.map(([v, l]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  return `<div class="top"><h1>🗺️ מפת הפרויקטים שלי</h1><div class="sw"><button class="iconbtn" data-act="pmHome" aria-label="מסך הבית" title="${home ? 'זה מסך הבית. לחץ לביטול' : 'הפוך למסך הבית'}">${home ? '🏠' : '🏡'}</button><button class="iconbtn" data-act="pmNew" aria-label="פרויקט חדש">＋</button></div></div>
    <div class="sub" style="margin:-4px 0 12px">לאן אני הולך, ולמה זה חשוב לי</div>
    ${document.documentElement.dataset.design === 'spatial' ? `<div class="seg pmviewseg"><button class="${pmWorldOn() ? 'on' : ''}" data-act="pmView" data-v="world">🌍 עולם</button><button class="${pmWorldOn() ? '' : 'on'}" data-act="pmView" data-v="list">📋 רשימה</button></div>` : ''}
    <div class="seg">${[['live', 'פעילים'], ...PM_STATUS.map(x => [x[0], x[1] + ' ' + x[2]]), ['all', 'הכל']].map(([k, l]) => `<button class="${S === k ? 'on' : ''}" data-act="pmStatusF" data-k="${k}">${l}</button>`).join('')}</div>
    ${pmWorldOn() ? '' : `<div class="pmfilters">${sel('pmArea', state.pmArea || '', pmAreas().map(a => [a.id, a.icon + ' ' + a.name]), 'כל התחומים')}${sel('pmRange', state.pmRange || '', PM_RANGES, 'כל טווח זמן')}<button class="iconbtn" data-act="pmAreasSheet" aria-label="עריכת תחומי חיים" title="תחומי חיים">⚙️</button></div>
    <div class="pmfilters">${sel('pmValue', state.pmValue || '', pmValues().map(v => [v, v]), 'כל הערכים')}${sel('pmPrio', state.pmPrio || '', PM_PRIO, 'כל העדיפויות')}</div>
`}
    <div class="seg pmrevs"><button data-act="pmWeekRev">📋 סקירה שבועית</button><button data-act="pmMonthRev">🗓️ סקירה חודשית</button><button data-act="pmLoad">⏱️ עומס</button></div>
    ${live.length ? `<button class="btn ghost pmweek" data-act="pmWalk">🧭 כוונון שבוע: מה אני מקדם בכל פרויקט</button>` : ''}
    ${pmWorldOn() ? pmWorld() : list.length ? `<div id="pmcards">${list.map(pmCard).join('')}</div>` : `<div class="empty">${D().projects.length ? 'אין פרויקטים שמתאימים לסינון הזה' : 'עוד אין פרויקטים. אפשר להתחיל מאחד שחשוב לך'}</div>`}`;
}
function pmDetail(p) {
  const f = pmFocusTask(p), st = pmStatus(p), s = projState(p), open = pmOrdered(p), done = s.ts.filter(t => t.done), a = pmArea(p), wasF = p.focusTaskId && !f && findTask(p.focusTaskId);
  const rowH = t => {
    const subs = (t.subs && t.subs.length && !t.collapsed) ? `<div class="subs">${t.subs.map(x => `<div class="row ${x.done ? 'done' : ''}"><button class="check ${x.done ? 'on' : ''}" data-act="subToggle" data-id="${t.id}" data-sid="${x.id}">${x.done ? '✓' : ''}</button><div class="t grow" data-act="taskMenu" data-id="${t.id}">${esc(x.title)}</div></div>`).join('')}</div>` : '';
    return `<div class="pmrow ${p.focusTaskId === t.id ? 'isfocus' : ''}" data-tid="${t.id}"><div class="card row ${t.milestone ? 'mile' : ''}"><span class="pmgrip" aria-label="גרור לשינוי סדר" title="גרור לשינוי סדר">⋮⋮</span>
      <button class="check" data-act="toggleTask" data-id="${t.id}"></button>
      <div class="grow" data-act="taskMenu" data-id="${t.id}"><div class="t">${t.milestone ? '⭐ ' : ''}${esc(t.title)}</div><div class="meta">${t.date ? `<span>📅 ${t.date === TODAY() ? 'היום' : shortDate(t.date)}</span>` : ''}${subToggle(t)}${p.focusTaskId === t.id ? '<span class="chip">🎯 מיקוד השבוע</span>' : ''}</div></div>
      <div class="pmtools"><button class="pmmini ${t.milestone ? 'on' : ''}" data-act="pmMile" data-id="${t.id}" aria-label="אבן דרך" title="אבן דרך">⭐</button><button class="pmmini ${p.focusTaskId === t.id ? 'on' : ''}" data-act="pmFocusTask" data-id="${t.id}" aria-label="מיקוד השבוע" title="מיקוד השבוע">🎯</button><button class="pmmini" data-act="pmToday" data-id="${t.id}" aria-label="העבר להיום" title="העבר למשימות היום">📥</button></div></div>${subs}</div>`;
  };
  const field = (l, v) => v ? `<div class="pmfield"><span>${l}</span><div>${v}</div></div>` : '';
  return `<div class="top"><div class="row"><button class="iconbtn" data-act="pmBack" aria-label="חזרה למפה">${chev('r')}</button><h1>${esc(p.title)}</h1></div><div class="sw"><button class="iconbtn" data-act="pmEdit" data-id="${p.id}" aria-label="עריכה">✏️</button></div></div>
    <div class="pmhero" style="--pc:${pmColor(p)}"><span class="pmicon big">${pmIcon(p)}</span><span class="pmobjbig">${pmObj(p, 84)}</span><div class="grow"><div class="sub">${a ? esc(a.icon + ' ' + a.name) : 'ללא תחום'}</div><div class="pmoutcome">${p.outcome ? esc(p.outcome) : '<span class="sub">עוד לא הוגדרה תוצאה רצויה</span>'}</div><div class="pmleft">⏳ ${pmLeft(p)}</div></div>${pmRing(p, 92)}</div>
    <div class="card pminfo">${p.why ? `<div class="pmwhy big">“${esc(p.why)}”</div>` : ''}
      ${p.values && p.values.length ? `<div class="pmvals">${pmChips(p)}</div>` : ''}
      ${field('איך אני רוצה להרגיש', esc(p.feel || ''))}${field('התחלה', p.start ? longDate(p.start) : '')}${field('יעד', p.due ? longDate(p.due) : '')}
      ${field('שעות בשבוע', p.hours ? p.hours + ' שעות' : '')}
      <div class="pmfield"><span>סטטוס</span><div><select data-pmset="status">${PM_STATUS.map(x => `<option value="${x[0]}" ${x[0] === st ? 'selected' : ''}>${x[1]} ${x[2]}</option>`).join('')}</select></div></div>
      <div class="pmfield"><span>עדיפות</span><div><select data-pmset="prio"><option value="">לא הוגדרה</option>${PM_PRIO.map(([k, l]) => `<option value="${k}" ${p.prio === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div></div>
    ${f ? `<div class="pmfocusbig" style="--pc:${pmColor(p)}"><div class="sub">🎯 המיקוד של השבוע</div><div class="row"><button class="check" data-act="toggleTask" data-id="${f.id}"></button><b class="grow" data-act="taskMenu" data-id="${f.id}">${esc(f.title)}</b></div>${p.focusSuccess ? `<div class="sub">הצלחה בסוף השבוע: ${esc(p.focusSuccess)}</div>` : ''}${p.focusValue ? `<div class="sub">מתוך הערך: <span class="pmval">${esc(p.focusValue)}</span></div>` : ''}<button class="lnk" data-act="pmFocusSet" data-id="${p.id}">החלפת מיקוד</button></div>`
      : `<div class="pmfocusbig empty" style="--pc:${pmColor(p)}">${wasF ? '<b>🎉 הפעולה המרכזית של השבוע הושלמה</b>' : '<div class="sub">אין מיקוד לשבוע הזה (וזה בסדר)</div>'}<button class="btn ghost" data-act="pmFocusSet" data-id="${p.id}">${wasF ? 'בחר מיקוד חדש' : '🎯 בחר מיקוד לשבוע'}</button></div>`}
    <div class="row" style="margin-top:18px"><h2 class="grow" style="margin:0">תוכנית פעולה (${open.length})</h2></div>
    <div class="opt" style="margin:8px 0"><button data-act="projAddTask" data-id="${p.id}">＋ פעולה</button><button data-act="projBulk" data-id="${p.id}">📋 הזנה מרוכזת</button><button data-act="projAssign" data-id="${p.id}">🔗 שייך פעולות קיימות</button></div>
    <div id="pmlist">${open.map(rowH).join('') || '<div class="empty">אין עדיין פעולות. התקדמות תוצג כשיהיו</div>'}</div>
    ${open.length > 1 ? '<div class="sub" style="text-align:center">גרור את ⋮⋮ כדי לשנות סדר · ⭐ אבן דרך (נחשבת פי 3 בהתקדמות) · 🎯 מיקוד · 📥 למשימות היום</div>' : ''}
    ${pmHistory(p)}
    ${done.length ? `<details class="pmdone"><summary>הושלמו (${done.length})</summary>${done.map(t => `<div class="card row done"><button class="check on" data-act="toggleTask" data-id="${t.id}">✓</button><div class="grow" data-act="taskMenu" data-id="${t.id}"><div class="t">${t.milestone ? '⭐ ' : ''}${esc(t.title)}</div></div></div>`).join('')}</details>` : ''}`;
}
function pmForm(id) {
  const p = id ? D().projects.find(x => x.id === id) : { title: '', icon: PM_ICONS[0], color: '', status: 'active', values: [], prio: 'mid' };
  if (!p) return;
  const vals = [...new Set([...pmValues(), ...(p.values || [])])], col = p.color || (id ? pmColor(p) : PM_COLORS[D().projects.length % PM_COLORS.length]);
  sheet(`<h1>${id ? '✏️ עריכת פרויקט' : '🗺️ פרויקט חדש'}</h1><form id="pmForm">
    <label>שם הפרויקט</label><input name="title" required maxlength="80" value="${esc(p.title)}" autocomplete="off">
    <label>מה אני רוצה להשיג? (התוצאה הרצויה)</label><textarea name="outcome" rows="2">${esc(p.outcome || '')}</textarea>
    <label>למה זה חשוב לי? מה זה יתרום לחיים שלי?</label><textarea name="why" rows="2" placeholder="משפט קצר, בשפה שלי">${esc(p.why || '')}</textarea>
    <label>מתוך אילו ערכים אני רוצה לפעול?</label><div class="pmpick2">${vals.map(v => `<label class="pmcb"><input type="checkbox" name="val" value="${esc(v)}" ${(p.values || []).includes(v) ? 'checked' : ''}><span>${esc(v)}</span></label>`).join('')}</div>
    <input name="newval" placeholder="ערך משלי (אפשר כמה, מופרדים בפסיק)" autocomplete="off">
    <label>איך אני רוצה להרגיש כשאני עובד על זה?</label><input name="feel" value="${esc(p.feel || '')}" placeholder="רגוע, סקרן, בשליטה..." autocomplete="off">
    <div class="row" style="gap:10px"><div class="grow"><label>תאריך התחלה</label><input type="date" name="start" value="${p.start || ''}"></div><div class="grow"><label>תאריך יעד</label><input type="date" name="due" value="${p.due || ''}"></div></div>
    <div class="row" style="gap:10px"><div class="grow"><label>תחום חיים</label><select name="area" onchange="pmAreaNew(this)"><option value="">ללא תחום</option>${pmAreas().map(a => `<option value="${a.id}" ${a.id === p.area ? 'selected' : ''}>${esc(a.icon + ' ' + a.name)}</option>`).join('')}<option value="__new__">＋ תחום חדש...</option></select></div>
    <div class="grow"><label>סטטוס</label><select name="status">${PM_STATUS.map(x => `<option value="${x[0]}" ${x[0] === (p.status || 'active') ? 'selected' : ''}>${x[1]} ${x[2]}</option>`).join('')}</select></div></div>
    <div class="row" style="gap:10px"><div class="grow"><label>עדיפות</label><select name="prio">${PM_PRIO.map(([k, l]) => `<option value="${k}" ${(p.prio || 'mid') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <div class="grow"><label>שעות בשבוע</label><input type="number" name="hours" min="0" max="80" step="0.5" value="${p.hours || ''}"></div></div>
    <label>אייקון</label><div class="pmpick2">${PM_ICONS.map(i => `<label class="pmcb ic"><input type="radio" name="icon" value="${i}" ${i === (p.icon || PM_ICONS[0]) ? 'checked' : ''}><span>${i}</span></label>`).join('')}</div>
    <label>צבע</label><div class="pmpick2">${PM_COLORS.map(c => `<label class="pmcb sw"><input type="radio" name="color" value="${c}" ${c === col ? 'checked' : ''}><span style="background:${c}"></span></label>`).join('')}</div>
    <div class="actions"><button type="button" class="btn ghost" data-act="close">ביטול</button><button class="btn">שמור</button></div></form>
    ${id ? `<button type="button" class="btn danger" style="width:100%;margin-top:10px" data-act="delProjectSheet" data-id="${id}">🗑 מחק את הפרויקט</button>` : ''}`);
  $('#pmForm').onsubmit = ev => {
    ev.preventDefault(); const f = new FormData(ev.target), title = (f.get('title') || '').trim(); if (!title) return;
    const extra = (f.get('newval') || '').split(/[,،]/).map(x => x.trim()).filter(Boolean), values = [...new Set([...f.getAll('val'), ...extra])];
    if (extra.length) D().assist.values = [...new Set([...pmValues(), ...extra])];
    const q = p.id ? p : { id: uid(), createdAt: TODAY() };
    Object.assign(q, { title, outcome: (f.get('outcome') || '').trim(), why: (f.get('why') || '').trim(), values, feel: (f.get('feel') || '').trim(), start: f.get('start') || '', due: f.get('due') || '', area: f.get('area') === '__new__' ? '' : (f.get('area') || ''), status: f.get('status') || 'active', prio: f.get('prio') || 'mid', hours: +f.get('hours') || 0, icon: f.get('icon') || PM_ICONS[0], color: f.get('color') || '' });
    if (!p.id) D().projects.push(q);
    Store.save(); closeSheet(); if (!p.id) state.pmOpen = q.id; render(); window.scrollTo(0, 0);
  };
}
window.pmAreaNew = sel => { // "＋ תחום חדש..." inside the project form
  if (sel.value !== '__new__') return;
  const name = (prompt('שם תחום החיים החדש') || '').trim();
  if (!name) { sel.value = ''; return; }
  const a = { id: uid(), icon: '📌', name }; pmSaveAreas([...pmAreas(), a]);
  sel.add(new Option(a.icon + ' ' + a.name, a.id), sel.options[sel.options.length - 1]); sel.value = a.id;
};
function pmAreasSheet() {
  sheet(`<h1>⚙️ תחומי חיים</h1><div class="sub" style="margin-bottom:8px">אפשר להוסיף, לשנות שם ולמחוק. פרויקטים לא נמחקים כשמוחקים תחום.</div>
    ${pmAreas().map(a => `<div class="card row"><span style="font-size:22px">${esc(a.icon)}</span><div class="grow">${esc(a.name)}</div><button class="iconbtn" data-act="pmAreaEdit" data-id="${a.id}" aria-label="שנה שם">✏️</button><button class="iconbtn" data-act="pmAreaDel" data-id="${a.id}" aria-label="מחק">🗑</button></div>`).join('')}
    <div class="actions"><button class="btn ghost" data-act="close">סגור</button><button class="btn" data-act="pmAreaAdd">＋ תחום חדש</button></div>`);
}
function pmFocusSheet(id) {
  const p = D().projects.find(x => x.id === id); if (!p) return;
  const open = pmOrdered(p), vals = p.values && p.values.length ? p.values : pmValues(), q = state.pmQueue, pos = q ? `(${q.i + 1} מתוך ${q.ids.length}) ` : '';
  sheet(`<h1>🎯 ${pos}${pmIcon(p)} ${esc(p.title)}</h1><div class="sub" style="margin-bottom:6px">אפשר גם לא לבחור כלום לפרויקט הזה השבוע</div>
    <form id="pmFocusForm"><label>מה הדבר החשוב ביותר שאני רוצה לקדם השבוע?</label>
    <select name="task"><option value="">ללא מיקוד השבוע</option>${open.map(t => `<option value="${t.id}" ${t.id === p.focusTaskId ? 'selected' : ''}>${esc(t.title)}</option>`).join('')}</select>
    <input name="newtask" placeholder="או פעולה חדשה (מתחילה בפועל)" autocomplete="off">
    <label>מה ייחשב לי להצלחה בסוף השבוע?</label><input name="success" value="${esc(p.focusSuccess || '')}" autocomplete="off">
    <label>מתוך איזה ערך אני רוצה לפעול השבוע?</label>
    <select name="value"><option value="">לא בחרתי</option>${vals.map(v => `<option value="${esc(v)}" ${v === p.focusValue ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
    <div class="actions"><button type="button" class="btn ghost" data-act="${q ? 'pmWalkSkip' : 'close'}">${q ? 'דלג' : 'ביטול'}</button><button class="btn">${q && q.i < q.ids.length - 1 ? 'שמור והבא' : 'שמור'}</button></div></form>`);
  $('#pmFocusForm').onsubmit = ev => {
    ev.preventDefault(); const f = new FormData(ev.target), nt = (f.get('newtask') || '').trim();
    let tid = f.get('task') || '';
    if (nt) { const t = { id: uid(), title: nt, date: null, done: false, priority: 0, energy: 3, mins: 15, brainless: false, print: false, visionId: '', projectId: p.id, notes: '', subs: [], jobId: '' }; D().tasks.push(t); tid = t.id; }
    Object.assign(p, { focusTaskId: tid, focusSuccess: tid ? (f.get('success') || '').trim() : '', focusValue: tid ? (f.get('value') || '') : '', focusWeek: tid ? weekStart(TODAY()) : '' });
    Store.save(); pmWalkNext();
  };
}
function pmWalkNext() { // after saving / skipping one project in the weekly tune-up: the next one, or finish
  const q = state.pmQueue; closeSheet();
  if (q && q.i < q.ids.length - 1) { q.i++; render(); pmFocusSheet(q.ids[q.i]); return; }
  state.pmQueue = null; render();
}
// drag the ⋮⋮ handle to reorder the actions inside a project
const PMD = {};
document.addEventListener('pointerdown', e => {
  const g = e.target.closest('.pmgrip'); if (!g) return; const row = g.closest('.pmrow, .pmcard'); if (!row) return;
  e.preventDefault(); Object.assign(PMD, { row, sy: e.clientY, pid: e.pointerId, t: null, before: true }); row.classList.add('pmdrag'); try { g.setPointerCapture(e.pointerId); } catch (_) {}
});
document.addEventListener('pointermove', e => {
  if (!PMD.row || e.pointerId !== PMD.pid) return;
  PMD.row.style.transform = `translateY(${e.clientY - PMD.sy}px)`;
  const rows = [...PMD.row.parentNode.children].filter(r => r !== PMD.row && (r.classList.contains('pmrow') || r.classList.contains('pmcard'))); rows.forEach(r => r.classList.remove('pmbefore', 'pmafter'));
  if (!rows.length) return; PMD.before = true;
  let t = rows.find(r => { const b = r.getBoundingClientRect(); return e.clientY < b.top + b.height / 2; }); if (!t) { t = rows[rows.length - 1]; PMD.before = false; }
  PMD.t = t; t.classList.add(PMD.before ? 'pmbefore' : 'pmafter');
  if (e.clientY < 90) window.scrollBy(0, -10); else if (e.clientY > innerHeight - 90) window.scrollBy(0, 10);
});
const pmDragEnd = commit => {
  const { row, t, before } = PMD; if (!row) return; PMD.row = null; row.classList.remove('pmdrag'); row.style.transform = '';
  document.querySelectorAll('.pmbefore,.pmafter').forEach(r => r.classList.remove('pmbefore', 'pmafter'));
  if (!commit || !t) return;
  const card = row.classList.contains('pmcard'), key = card ? 'id' : 'tid';
  const ids = [...row.parentNode.children].filter(r => r.dataset[key]).map(r => r.dataset[key]).filter(i => i !== row.dataset[key]);
  ids.splice(ids.indexOf(t.dataset[key]) + (before ? 0 : 1), 0, row.dataset[key]);
  ids.forEach((id, i) => { const x = card ? D().projects.find(p => p.id === id) : findTask(id); if (x) x[card ? 'mord' : 'pord'] = i; }); Store.save(); render();
};
document.addEventListener('pointerup', e => { if (PMD.row && e.pointerId === PMD.pid) pmDragEnd(true); });
document.addEventListener('pointercancel', e => { if (PMD.row && e.pointerId === PMD.pid) pmDragEnd(false); });
document.addEventListener('change', e => {
  const f = e.target.closest('[data-pmf]'), s = e.target.closest('[data-pmset]');
  if (f) { state[f.dataset.pmf] = f.value; render(); }
  if (s) { const p = D().projects.find(x => x.id === state.pmOpen); if (p) { p[s.dataset.pmset] = s.value; Store.save(); render(); } }
});

/* ---------- Project map, stage 2: weekly / monthly review, weighted progress, history, planned load ---------- */
const pmWt = t => t.milestone ? 3 : 1; // a milestone counts three times in the progress ring
const pmPctAt = (p, before) => { // weighted progress, counting only actions finished before the given day (null = now)
  const ts = D().tasks.filter(t => t.projectId === p.id), tot = ts.reduce((s, t) => s + pmWt(t), 0);
  return tot ? Math.round(ts.filter(t => t.done && (before === null || (t.doneAt && t.doneAt < before))).reduce((s, t) => s + pmWt(t), 0) / tot * 100) : null;
};
const pmDoneIn = (p, a, b) => D().tasks.filter(t => t.projectId === p.id && t.done && t.doneAt && t.doneAt >= a && t.doneAt <= b);
const pmLive = () => D().projects.filter(p => ['focus', 'active'].includes(pmStatus(p)));
const pmRevs = () => (D().assist.pmReviews = D().assist.pmReviews || {});
const pmCap = () => D().assist.pmCap || 20;
function pmReviewView() {
  return state.pmReview === 'month' ? pmMonthView() : pmWeekView();
}
function pmWeekView() {
  const ws = weekStart(TODAY()), we = addDays(ws, 6), R = pmRevs()[ws] || {}, live = pmLive();
  const rows = D().projects.filter(p => pmStatus(p) !== 'future').map(p => ({ p, done: pmDoneIn(p, ws, we), a: pmPctAt(p, ws), b: pmPctAt(p, null) })).filter(x => x.done.length || ['focus', 'active'].includes(pmStatus(x.p)));
  const moved = rows.filter(x => x.done.length), total = moved.reduce((s, x) => s + x.done.length, 0), miles = moved.flatMap(x => x.done.filter(t => t.milestone).map(t => ({ t, p: x.p })));
  const foc = D().projects.filter(p => p.focusTaskId && findTask(p.focusTaskId)).map(p => ({ p, t: findTask(p.focusTaskId) })).filter(x => x.t.done ? x.t.doneAt >= ws : ['focus', 'active'].includes(pmStatus(x.p)));
  const quiet = live.filter(p => !pmDoneIn(p, addDays(TODAY(), -13), TODAY()).length && D().tasks.some(t => t.projectId === p.id && !t.done));
  const top = moved.slice().sort((a, b) => b.done.length - a.done.length)[0];
  const ch = (k, opts) => opts.map(([v, l]) => `<button class="${R[k] === v ? 'on' : ''}" data-act="pmRev" data-k="${k}" data-v="${v}">${l}</button>`).join('');
  return `<div class="top"><div class="row"><button class="iconbtn" data-act="pmBack" aria-label="חזרה למפה">${chev('r')}</button><h1>📋 סקירה שבועית</h1></div></div>
    <div class="sub" style="margin:-4px 0 12px">${shortDate(ws)} – ${shortDate(we)}</div>
    <div class="card"><b>1. מה קידמתי השבוע</b>
      ${total ? `<div class="sub">${total} פעולות הושלמו ב-${moved.length} פרויקטים</div>` : '<div class="sub">עוד לא הושלמו פעולות השבוע. זה בסדר, אפשר להתחיל מצעד קטן</div>'}
      ${rows.map(x => `<div class="pmrevrow"><span>${pmIcon(x.p)} ${esc(x.p.title)}</span><span>${x.b === null ? 'ללא פעולות' : (x.a === null ? '' : x.a + '% ← ') + x.b + '%'}${x.done.length ? ` <b class="pmup">+${x.done.length}</b>` : ''}</span></div>`).join('') || '<div class="sub">אין פרויקטים פעילים</div>'}</div>
    <div class="card"><b>2. פעולות משמעותיות שהשלמתי</b>
      ${miles.map(m => `<div class="pmrevrow"><span>⭐ ${esc(m.t.title)}</span><span class="sub">${esc(m.p.title)}</span></div>`).join('') || '<div class="sub">לא הושלמו אבני דרך השבוע (אפשר לסמן ⭐ בתוך הפרויקט)</div>'}</div>
    <div class="card"><b>3. המיקוד השבועי: האם הושג</b>
      ${foc.map(({ p, t }) => `<div class="pmrevrow col"><span>${t.done ? '✅' : '⏳'} ${esc(t.title)} <span class="sub">· ${esc(p.title)}</span></span>${p.focusSuccess ? `<span class="sub">הצלחה שהגדרתי: ${esc(p.focusSuccess)}</span>` : ''}${t.done ? '' : `<span class="opt"><button data-act="pmFocusSet" data-id="${p.id}">להחליף</button><button data-act="pmRelease" data-id="${p.id}">לשחרר</button></span>`}</span>`.replace('class="pmrevrow col"><span>', 'class="pmrevrow col"><span>')).join('') || '<div class="sub">לא הוגדר מיקוד השבוע</div>'}</div>
    <div class="card"><b>4. אילו פרויקטים צריכים פחות או יותר תשומת לב</b>
      ${top ? `<div class="pmrevrow"><span>🔥 הכי הרבה תנועה: ${pmIcon(top.p)} ${esc(top.p.title)}</span><span class="sub">${top.done.length} פעולות</span></div>` : ''}
      ${quiet.map(p => `<div class="pmrevrow"><span>🌿 ${pmIcon(p)} ${esc(p.title)}</span><span class="sub">שבועיים בלי התקדמות</span></div>`).join('') || '<div class="sub">לכל הפרויקטים הפעילים הייתה תנועה לאחרונה</div>'}
      <div class="sub" style="margin-top:6px">אפשר לשנות סטטוס או עדיפות בסקירה החודשית</div></div>
    <div class="card"><b>5. האם פעלתי לפי הערכים שלי ונהניתי מהדרך</b>
      <div class="sub" style="margin-top:6px">פעלתי מתוך הערכים שבחרתי?</div><div class="seg" style="margin:4px 0">${ch('vals', [['y', 'כן'], ['p', 'חלקית'], ['n', 'לא']])}</div>
      <div class="sub">נהניתי מהדרך?</div><div class="seg" style="margin:4px 0">${ch('enjoy', [['y', '😊'], ['m', '😐'], ['n', '😕']])}</div>
      <label>מה עבד השבוע?</label><textarea data-pmrev="worked" rows="2">${esc(R.worked || '')}</textarea></div>
    <div class="card"><b>6. מה אני רוצה לקדם בשבוע הבא</b><div class="sub" style="margin:4px 0 8px">עוברים על הפרויקטים הפעילים וקובעים מיקוד לכל אחד (או לא)</div>
      <button class="btn ghost" data-act="pmWalk" style="width:100%">🧭 כוונון שבוע</button></div>
    <button class="btn" style="width:100%" data-act="pmRevDone">${R.doneAt ? '✓ הסקירה נשמרה, שמור שוב' : 'סיימתי סקירה'}</button>`;
}
function pmMonthView() {
  const ym = TODAY().slice(0, 7), R = pmRevs()['m' + ym] || {}, ps = D().projects.filter(p => pmStatus(p) !== 'done'), hrs = pmLive().reduce((s, p) => s + (p.hours || 0), 0);
  const stBtn = (p, k, l) => `<button class="${pmStatus(p) === k ? 'on' : ''}" data-act="pmSetStatus" data-id="${p.id}" data-s="${k}">${l}</button>`;
  return `<div class="top"><div class="row"><button class="iconbtn" data-act="pmBack" aria-label="חזרה למפה">${chev('r')}</button><h1>🗓️ סקירה חודשית</h1></div></div>
    <div class="sub" style="margin:-4px 0 12px">לכל פרויקט: לקדם, להשהות או לסיים. אפשר גם לעדכן יעד ועדיפות.${hrs > pmCap() ? ` <b style="color:var(--danger)">מתוכננות ${hrs} שעות בשבוע, מעל ${pmCap()} שהגדרת כמסגרת.</b>` : ''}</div>
    ${ps.map(p => `<div class="pmcard" style="--pc:${pmColor(p)};cursor:default"><div class="pmhead"><span class="pmicon">${pmIcon(p)}</span><div class="grow"><b class="pmname">${esc(p.title)}</b><div class="sub">⏳ ${pmLeft(p)}${p.hours ? ' · ' + p.hours + ' ש׳ בשבוע' : ''}</div></div>${pmRing(p, 56)}</div>
      <div class="seg" style="margin:10px 0 6px">${stBtn(p, 'focus', '🎯 לקדם')}${stBtn(p, 'active', '🌱 פעיל')}${stBtn(p, 'paused', '⏸️ להשהות')}${stBtn(p, 'future', '🔭 עתידי')}${stBtn(p, 'done', '🏁 לסיים')}</div>
      <div class="row" style="gap:8px"><label class="sub grow">יעד<input type="date" data-pmdue="${p.id}" value="${p.due || ''}"></label><label class="sub grow">עדיפות<select data-pmprio="${p.id}"><option value="">לא הוגדרה</option>${PM_PRIO.map(([k, l]) => `<option value="${k}" ${p.prio === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div></div>`).join('') || '<div class="empty">אין פרויקטים לסקירה</div>'}
    <label>מה אני לוקח איתי לחודש הבא?</label><textarea data-pmrev="monthNote" rows="2">${esc(R.monthNote || '')}</textarea>
    <button class="btn" style="width:100%;margin-top:10px" data-act="pmRevDone">${R.doneAt ? '✓ הסקירה נשמרה, שמור שוב' : 'סיימתי סקירה'}</button>`;
}
function pmLoadSheet() {
  const live = pmLive(), tot = live.reduce((s, p) => s + (p.hours || 0), 0), cap = pmCap(), max = Math.max(cap, tot, 1), none = live.filter(p => !p.hours);
  sheet(`<h1>⏱️ עומס שבועי מתוכנן</h1><div class="sub">לפי "שעות בשבוע" שהגדרת לכל פרויקט פעיל</div>
    <label>כמה שעות בשבוע אני באמת פנוי לפרויקטים?</label><input type="number" min="1" max="120" data-pmcap value="${cap}">
    <div style="margin:12px 0"><div class="row"><b class="grow">סה״כ מתוכנן: ${tot} ש׳</b><span class="${tot > cap ? 'pmover' : 'sub'}">${tot > cap ? 'חריגה של ' + (tot - cap) + ' ש׳' : 'נשארו ' + (cap - tot) + ' ש׳ פנויות'}</span></div>
    <div class="pmload">${live.filter(p => p.hours).map(p => `<div class="pmseg" style="width:${(p.hours / max * 100).toFixed(1)}%;background:${pmColor(p)}" title="${esc(p.title)}"></div>`).join('')}</div>
    <div class="pmcap" style="inset-inline-start:${Math.min(100, cap / max * 100).toFixed(1)}%"></div></div>
    ${live.filter(p => p.hours).sort((a, b) => b.hours - a.hours).map(p => `<div class="pmrevrow"><span><i class="pmdot" style="background:${pmColor(p)}"></i> ${pmIcon(p)} ${esc(p.title)}</span><span>${p.hours} ש׳ · ${tot ? Math.round(p.hours / tot * 100) : 0}%</span></div>`).join('') || '<div class="sub">עוד לא הוגדרו שעות. אפשר להוסיף בעריכת הפרויקט</div>'}
    ${none.length ? `<div class="sub" style="margin-top:8px">בלי שעות: ${none.map(p => esc(p.title)).join(', ')}</div>` : ''}
    <div class="actions"><button class="btn" data-act="close">סגור</button></div>`);
}
function pmHistory(p) { // finished actions by day, and a small week-by-week bar chart
  const done = D().tasks.filter(t => t.projectId === p.id && t.done), by = {};
  done.forEach(t => { const k = t.doneAt || ''; (by[k] = by[k] || []).push(t); });
  const keys = Object.keys(by).sort().reverse(), ws0 = weekStart(TODAY()), weeks = [...Array(8)].map((_, i) => addDays(ws0, -7 * (7 - i))), cnt = weeks.map(w => pmDoneIn(p, w, addDays(w, 6)).length), mx = Math.max(1, ...cnt);
  if (!done.length) return '';
  return `<details class="pmdone"><summary>🏆 היסטוריית התקדמות והישגים (${done.length})</summary>
    <div class="pmweeks">${cnt.map((n, i) => `<div><i style="height:${Math.round(n / mx * 100)}%;background:${pmColor(p)}"></i><small>${n || ''}</small><em>${shortDate(weeks[i])}</em></div>`).join('')}</div>
    ${keys.map(k => `<div class="pmhday"><div class="sub">${k ? (k === TODAY() ? 'היום' : longDate(k)) : 'ללא תאריך'}</div>${by[k].map(t => `<div class="pmhrow">${t.milestone ? '⭐' : '✓'} ${esc(t.title)}</div>`).join('')}</div>`).join('')}</details>`;
}
document.addEventListener('change', e => {
  const t = e.target, rv = t.closest('[data-pmrev]'), d = t.closest('[data-pmdue]'), pr = t.closest('[data-pmprio]'), cp = t.closest('[data-pmcap]');
  if (rv) { const ws = state.pmReview === 'month' ? 'm' + TODAY().slice(0, 7) : weekStart(TODAY()), R = pmRevs(); R[ws] = Object.assign({}, R[ws], { [rv.dataset.pmrev]: rv.value }); Store.save(); }
  if (d) { const p = D().projects.find(x => x.id === d.dataset.pmdue); if (p) { p.due = d.value; Store.save(); render(); } }
  if (pr) { const p = D().projects.find(x => x.id === pr.dataset.pmprio); if (p) { p.prio = pr.value; Store.save(); } }
  if (cp) { D().assist.pmCap = Math.max(1, +cp.value || 20); Store.save(); pmLoadSheet(); }
});

// ---- Spatial design layer (spatial.css): classic | spatial, 5 themes, 3 effect levels. Stored in assist settings, mirrored to localStorage so the first paint has no flash.
const DZ_THEMES = [['lavender', 'Lavender', '#6a4be0'], ['ocean', 'Ocean', '#0a82a8'], ['nature', 'Nature', '#3c7d4d'], ['sunset', 'Sunset', '#d9582b'], ['midnight', 'Midnight', '#2a2f57']], DZ_FX = [['minimal', 'Minimal'], ['spatial', 'Spatial'], ['immersive', 'Immersive']];
const dz = () => { const a = D().assist; return { d: a.design === 'spatial' ? 'spatial' : 'classic', t: a.dzTheme || 'lavender', f: a.dzFx || 'spatial' }; };
function applyDesign() {
  const z = dz(), h = document.documentElement;
  if (z.d === 'spatial') { h.dataset.design = 'spatial'; h.dataset.theme = z.t; h.dataset.fx = z.f; } else { delete h.dataset.design; delete h.dataset.theme; delete h.dataset.fx; }
  try { localStorage.setItem('doit-dz', JSON.stringify(z)); } catch (e) {}
  const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = z.d === 'spatial' ? (DZ_THEMES.find(x => x[0] === z.t) || DZ_THEMES[0])[2] : '#1f6f5c';
}
const dzCard = () => { const z = dz(); return `<div class="card"><div class="t"><b>🎨 עיצוב</b></div><div class="sub">עיצוב Spatial: עומק, זכוכית ותנועה עדינה. אפשר לחזור לקלאסי בכל רגע</div>
  <div class="dzpick"><button class="${z.d === 'classic' ? 'on' : ''}" data-act="dzSet" data-k="d" data-v="classic">קלאסי</button><button class="${z.d === 'spatial' ? 'on' : ''}" data-act="dzSet" data-k="d" data-v="spatial">Spatial</button></div>
  ${z.d === 'spatial' ? `<div class="dzpick">${DZ_THEMES.map(([v, l, c]) => `<button class="${z.t === v ? 'on' : ''}" data-act="dzSet" data-k="t" data-v="${v}"><span class="sw" style="background:${c}"></span>${l}</button>`).join('')}</div>
  <div class="dzpick">${DZ_FX.map(([v, l]) => `<button class="${z.f === v ? 'on' : ''}" data-act="dzSet" data-k="f" data-v="${v}">${l}</button>`).join('')}</div>` : ''}</div>`; };
// pointer tilt on project cards (only with a mouse, only in Spatial/Immersive, never with reduced motion)
(() => {
  let cur = null; const reduce = matchMedia('(prefers-reduced-motion:reduce)');
  const clear = () => { if (cur) { cur.style.removeProperty('--rx'); cur.style.removeProperty('--ry'); cur.style.removeProperty('--mx'); cur = null; } };
  document.addEventListener('pointermove', e => {
    const h = document.documentElement.dataset;
    if (e.pointerType !== 'mouse' || h.design !== 'spatial' || h.fx === 'minimal' || reduce.matches) return clear();
    const c = e.target.closest && e.target.closest('.pmcard, .pmfocusbig, .world');
    if (c !== cur) clear();
    if (!c) return; cur = c;
    const r = c.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - .5, y = (e.clientY - r.top) / r.height - .5, k = (h.fx === 'immersive' ? 7 : 4) * (c.classList.contains('world') ? 1.6 : 1);
    c.style.setProperty('--ry', (-x * k).toFixed(2) + 'deg'); c.style.setProperty('--rx', (y * k).toFixed(2) + 'deg'); c.style.setProperty('--mx', ((x + .5) * 100).toFixed(0) + '%');
  }, { passive: true });
  document.addEventListener('pointerleave', clear, true);
})();

const views = {
  today() {
    if (state.mode === 'do' && state.date === TODAY()) return doView();
    const d = state.date, ts = tasksOn(d), hs = habitsOn(d);
    const isToday = d === TODAY(); // the daily "ארגון" ritual counts as one item on today's list
    const total = ts.length + hs.length + (isToday ? 1 : 0), done = ts.filter(t => t.done).length + hs.filter(h => habitDone(h, d)).length + (isToday && orgDone(d) ? 1 : 0);
    const pct = total ? Math.round(done / total * 100) : 0;
    const remaining = ts.filter(t => !t.done).reduce((a, t) => a + (t.mins || 0), 0) + hs.filter(h => !habitDone(h, d)).reduce((a, h) => a + (h.mins || 0), 0);
    const L0 = isToday ? (D().dayLog[dayKey()] || {}) : {}, est = isToday && remaining ? estimateEnd(remaining) : '';
    const visTop = isToday && !D().visual[d] && new Date().getHours() < 11, rs = isToday ? rewardState(d) : {}, rewardTop = isToday && rs.rule && rs.achieved && !rs.claimed;
    const hAct = hs.filter(h => !habitDone(h, d)).length;
    return `<div class="top"><div class="brand">${logoMark(36)}<div><h1>${d === TODAY() ? 'היום' : 'יום נבחר'}</h1><div class="sub">${longDate(d)}</div></div></div>
      <div class="sw"><button class="iconbtn" data-act="printDayAll" aria-label="הדפסת פעילות היום" title="הדפסת פעילות היום">🖨</button><button class="iconbtn" data-act="account" title="סנכרון וחשבון">${Cloud.status === 'ok' ? '☁️' : Cloud.status === 'syncing' ? '🔄' : Cloud.status === 'error' ? '⚠️' : '👤'}</button><button class="iconbtn" data-act="shift" data-n="-1" aria-label="היום הקודם">${chev('r')}</button><button class="iconbtn" data-act="goToday">היום</button><button class="iconbtn" data-act="shift" data-n="1" aria-label="היום הבא">${chev('l')}</button></div></div>
      <div class="card" style="--pct:${pct}%"><div class="row"><b class="grow">${done}/${total} הושלמו${remaining ? ` · נותרו ${remaining} ד׳` : ''}</b>${isToday ? '<button class="iconbtn" data-act="dayEdit" aria-label="עריכת שעת התחלה וסיום">✏️ שעות</button>' : ''}${isToday && !L0.start && !L0.end ? '<button class="iconbtn endday" data-act="dayStart">◀ התחלתי יום</button>' : ''}${isToday && L0.start && !L0.end ? '<button class="iconbtn endday" data-act="dayEnd">🌙 לילה טוב</button>' : ''}${isToday && L0.end ? '<button class="iconbtn" data-act="dayReopen" aria-label="פתח את היום מחדש">↺ פתח מחדש</button>' : ''}</div><div class="bar"><div style="width:${pct}%"></div></div>
       ${L0.start || est ? `<div class="sub" style="margin-top:6px">${L0.start ? 'התחלת ב-' + L0.start : ''}${L0.end ? ` · סיימת ב-${L0.end} · משך ${fmtDur(dayDurMin(L0))}` : ''}${!L0.end && L0.start && est ? ' · ' : ''}${!L0.end && est ? `סיום משוער ${est} (כולל הפסקות)` : ''}</div>` : ''}</div>
      ${isToday ? modeSwitch() : ''}
      ${isToday ? syncHint() : ''}
      ${visTop ? visualCard(d) : ''}
      ${rhythmStrip(d, 'near')}
      ${rewardTop ? rewardCard(d) : ''}
      ${energyBar(d)}
      ${focusCard(d)}
      <h2>פעולות</h2>${isToday && yesterdayLeft().length ? '<button class="btn ghost more3" style="margin:0 0 8px" data-act="carryOver">⏩ העבר להיום את מה שלא בוצע אתמול (' + yesterdayLeft().length + ')</button>' : ''}${isToday && !orgDone(d) ? orgCard() : ''}${tasksBlock(d, ts)}
      ${doneSection(d, ts, hs)}
      <details class="todaymore" id="todayMore" ${state.moreOpen ? 'open' : ''}><summary>עוד להיום${hAct ? ` · ${hAct} הרגלים` : ''}</summary>
       <div class="opt" style="margin:6px 0"><button data-act="asstToday">💬 מה מעסיק אותי היום?</button></div>
       ${dayCard(d)}${visTop ? '' : visualCard(d)}${rewardTop ? '' : rewardCard(d)}${rhythmStrip(d, 'rest')}
       <div class="remind" data-act="nextReminder" title="לחץ להחלפה">💬 ${esc(reminder())}</div>
       <div class="opt" style="margin-bottom:6px"><button data-act="printDayAll">🖨 הדפס את כל פעולות היום</button><button data-act="printDay">🖨 רק פתוחות/מסומנות</button><button data-act="addBulk">📋 הזנה מרוכזת</button></div>
       ${hs.some(h => !habitDone(h, d)) ? `<h2>הרגלים</h2>${hs.filter(h => !habitDone(h, d)).map(h => habitRow(h, d)).join('')}` : ''}
       <h2>פתק יומי</h2><textarea id="note" placeholder="מחשבות, סיכום, דברים לזכור...">${esc(D().notes[d] || '')}</textarea>
      </details>
      <button class="fab" data-act="addTask" aria-label="פעולה חדשה">+</button>`;
  },
  upcoming() {
    // Todoist-style board in three modes: days (rolling), week, month. Everything is laid out right-to-left.
    const T = TODAY(), mode = state.upMode;
    const label = d => d === T ? 'היום' : d === addDays(T, 1) ? 'מחר' : 'יום ' + DAYN[parse(d).getDay()];
    const dayCol = d => { const ts = tasksOn(d).filter(t => !t.done).filter(filterOk); return upCol(d, `${shortDate(d)} · ${label(d)}`, ts.length, `<button class="uadd" data-act="addTaskOn" data-date="${d}">＋ הוסף פעולה</button>${ts.map(t => upCard(t)).join('')}`); };
    const poolCol = () => { const ps = D().tasks.filter(t => !t.date && !t.done && filterOk(t)); return upCol('none', 'ללא תאריך', ps.length, '<button class="uadd" data-act="addTaskOn" data-date="">＋ הוסף פעולה</button>' + ps.map(t => upCard(t)).join('')); };
    const curYM = mode === 'month' ? state.upMonth : state.upStart.slice(0, 7);
    const ymList = Array.from({ length: 14 }, (_, i) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 2 + i); return fmt(d).slice(0, 7); });
    if (!ymList.includes(curYM)) { ymList.push(curYM); ymList.sort(); }
    const monthSel = `<select id="upMonth" style="width:auto">${ymList.map(v => { const [y, m] = v.split('-').map(Number); return `<option value="${v}" ${v === curYM ? 'selected' : ''}>${MONTHS[m - 1]} ${y}</option>`; }).join('')}</select>`;
    const navRow = lbl => `<div class="row" style="margin:6px 0 10px"><button class="iconbtn" data-act="upNav" data-n="-1" aria-label="הקודם">${chev('r')}</button><b class="grow" style="text-align:center">${lbl}</b><button class="iconbtn" data-act="upNav" data-n="1" aria-label="הבא">${chev('l')}</button><button class="iconbtn" data-act="upToday">היום</button></div>`;
    let nav = '', body = '';
    if (mode === 'week') {
      const ws = state.upWeek;
      nav = navRow(`${shortDate(ws)} – ${shortDate(addDays(ws, 6))}`);
      body = `<div class="uboard week" id="uboard">${poolCol()}${Array.from({ length: 7 }, (_, i) => dayCol(addDays(ws, i))).join('')}</div>`;
    } else if (mode === 'three') {
      const s3 = state.up3;
      nav = navRow(`${shortDate(s3)} – ${shortDate(addDays(s3, 2))}`);
      body = `<div class="uboard three" id="uboard">${poolCol()}${Array.from({ length: 3 }, (_, i) => dayCol(addDays(s3, i))).join('')}</div>`;
    } else if (mode === 'month') {
      const [y, m] = state.upMonth.split('-').map(Number), first = new Date(y, m - 1, 1), st = new Date(y, m - 1, 1 - first.getDay());
      let cells = DAYS.map(x => `<div class="mh">${x}</div>`).join('');
      for (let i = 0; i < 42; i++) {
        const c = new Date(st); c.setDate(st.getDate() + i);
        const s = fmt(c), ts = tasksOn(s).filter(t => !t.done).filter(filterOk);
        cells += `<div class="mcell ${c.getMonth() !== m - 1 ? 'out' : ''} ${s === T ? 'today' : ''} ${s === state.upSel ? 'sel' : ''}" data-drop="${s}" data-act="upPick" data-date="${s}"><span class="mnum">${c.getDate()}</span>${ts.slice(0, 3).map(t => `<div class="ucard mini ${t.done ? 'done' : ''}" data-task="${t.id}" data-act="taskMenu" data-id="${t.id}"><span class="t">${esc(t.title)}</span></div>`).join('')}${ts.length > 3 ? `<span class="mmore">+${ts.length - 3}</span>` : ''}</div>`;
      }
      const sel = state.upSel, sts = tasksOn(sel).filter(t => !t.done);
      nav = navRow(`${MONTHS[m - 1]} ${y}`);
      body = `<div class="mgrid">${cells}</div><h2>${longDate(sel)}</h2>
        <section class="ucol msel" data-drop="${sel}"><button class="uadd" data-act="addTaskOn" data-date="${sel}">＋ הוסף פעולה</button>${sts.map(t => upCard(t)).join('') || '<div class="empty">אין פעולות ליום הזה</div>'}</section>`;
    } else {
      const start = state.upStart, days = Array.from({ length: state.upDays }, (_, i) => addDays(start, i));
      body = `<div class="uboard" id="uboard">
        ${poolCol()}
        ${days.map(dayCol).join('')}
        <section class="ucol umore"><button class="uadd" data-act="upMore">＋ עוד שבועיים</button></section>
      </div>`;
    }
    return `<div class="top"><h1>בקרוב</h1><div class="sw">${mode === 'week' || mode === 'three' ? '' : monthSel}<button class="iconbtn" data-act="printWeek">🖨 שבוע</button></div></div>
      <div class="seg">${[['three', '3 ימים'], ['week', 'שבוע'], ['month', 'חודש'], ['days', 'כל הימים']].map(([k, l]) => `<button class="${mode === k ? 'on' : ''}" data-act="upMode" data-m="${k}">${l}</button>`).join('')}</div>
      ${filterBar()}
      ${mode === 'month' ? '' : '<div class="opt" style="margin:6px 0"><button data-act="upJump" data-c="none">📥 ללא תאריך (' + D().tasks.filter(t => !t.date && !t.done && filterOk(t)).length + ')</button></div>'}
      ${nav}${body}
      <div class="sub" style="margin-top:6px">גרור פעולה (במגע: לחיצה ארוכה) כדי להעביר אותה ליום אחר, או למאגר "ללא תאריך".</div>`;
  },
  tasks() {
    if (state.allMode === 'projects') return projectsBoard();
    if (state.allMode === 'matrix') return views.matrixBody();
    if (state.allMode === 'done') return doneBoard();
    const f = state.taskFilter;
    let list = D().tasks.filter(filterOk);
    if (f === 'open') list = list.filter(t => !t.done);
    if (f === 'done') list = list.filter(t => t.done);
    if (f === 'nodate') list = list.filter(t => !t.date && !t.done);
    if (f === 'brainless') list = list.filter(t => t.brainless && !t.done);
    list.sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999') || b.priority - a.priority);
    const F = [['open', 'פתוחות'], ['brainless', '⚡ Brainless'], ['nodate', 'ללא תאריך'], ['all', 'הכל']];
    return `<div class="top"><h1>כל הפעולות</h1><div class="sw"><button class="iconbtn" data-act="addBulk">📋 הזנה מרוכזת</button><button class="iconbtn" data-act="printSel">🖨 נבחרות</button></div></div>
      ${allSeg()}<div class="seg">${F.map(([k, l]) => `<button class="${f === k ? 'on' : ''}" data-act="filter" data-f="${k}">${l}</button>`).join('')}</div>
      ${filterBar()}
      <div class="sub" style="margin:6px 0">${list.length} פעולות. הלוח עם הגרירה נמצא בטאב "בקרוב".</div>
      ${list.map(t => taskRow(t, true)).join('') || '<div class="empty">אין פעולות שמתאימות לסינון</div>'}
      <button class="fab" data-act="addTask">+</button>`;
  },
  habits() {
    const d = TODAY(), last7 = Array.from({ length: 7 }, (_, i) => addDays(d, i - 6));
    return `<div class="top"><h1>הרגלים</h1><button class="iconbtn" data-act="addHabitBulk">📋 הזנה מרוכזת</button></div>
      ${D().habits.map(h => {
        const v = h.visionId ? visionName(h.visionId) : '';
        return `<div class="card"><div class="row"><div class="grow" data-act="editHabit" data-id="${h.id}"><div class="t"><b>${esc(h.title)}</b></div>${h.task ? `<div class="sub">הפעולה: ${esc(h.task)}${h.mins ? ` · ${h.mins} ד׳` : ''}${h.energy ? ' ' + stars(h.energy) : ''}</div>` : ''}
        <div class="meta"><span>🔥 ${streak(h)} ימים</span><span>${h.days.length === 7 ? 'כל יום' : h.days.map(x => DAYS[x]).join(' ')}</span>${v ? `<span class="chip">${esc(v)}</span>` : ''}</div></div></div>
        <div class="dots" style="margin-top:8px;justify-content:flex-start">${last7.map(x => `<button class="dot7 ${habitDone(h, x) ? 'on' : ''}" style="${h.days.includes(parse(x).getDay()) ? '' : 'opacity:.35'}" data-act="toggleHabit" data-id="${h.id}" data-date="${x}">${parse(x).getDate()}</button>`).join('')}</div></div>`;
      }).join('') || '<div class="empty">עדיין אין הרגלים</div>'}
      <button class="fab" data-act="addHabit">+</button>`;
  },
  vision() {
    return `<div class="top"><h1>החזון שלי</h1></div>
      ${D().visions.map(v => {
        const ts = D().tasks.filter(t => t.visionId === v.id), hs = D().habits.filter(h => h.visionId === v.id);
        const dn = ts.filter(t => t.done).length;
        return `<div class="card vis" data-act="editVision" data-id="${v.id}"><div class="t"><b>${esc(v.title)}</b></div>
        ${v.desc ? `<div class="sub" style="white-space:pre-wrap;margin-top:4px">${esc(v.desc)}</div>` : ''}
        <div class="meta"><span>✅ ${dn}/${ts.length} פעולות</span><span>🔁 ${hs.length} הרגלים</span><span>🎯 ${D().goals.filter(x => x.visionId === v.id).length} יעדים</span>${v.area ? `<span class="chip">${esc(v.area)}</span>` : ''}</div></div>`;
      }).join('') || '<div class="empty">כתוב כאן את החזון שלך, תחומי חיים ויעדים גדולים</div>'}
      <button class="fab" data-act="addVision">+</button>`;
  },
  week() {
    const ws = state.weekStart, we = addDays(ws, 6), T = TODAY(), cur = ws === weekStart(T);
    const W = Object.assign({ vision: '', outcomes: [], visionIds: [], worked: '', improve: '' }, D().weeks[ws]);
    const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
    const wt = D().tasks.filter(t => t.date && t.date >= ws && t.date <= we), wdone = wt.filter(t => t.done).length;
    const left = wt.filter(t => !t.done).reduce((s, t) => s + (t.mins || 0), 0);
    let hPlan = 0, hDone = 0;
    days.filter(d => d <= T).forEach(d => habitsOn(d).forEach(h => { hPlan++; if (habitDone(h, d)) hDone++; }));
    const pct = wt.length ? Math.round(wdone / wt.length * 100) : 0, hp = hPlan ? Math.round(hDone / hPlan * 100) : 0;
    const maxN = Math.max(1, ...days.map(d => tasksOn(d).length));
    const okOut = W.outcomes.filter(o => o.done).length;
    return `<div class="top"><div class="brand">${logoMark(36)}<h1>חזון שבועי</h1></div><button class="iconbtn" data-act="printWeekVision">🖨</button></div>
      <div class="row" style="margin:0 0 10px"><button class="iconbtn" data-act="weekNav" data-n="-1" aria-label="שבוע קודם">${chev('r')}</button><b class="grow" style="text-align:center">${shortDate(ws)} – ${shortDate(we)}${cur ? ' · השבוע' : ''}</b><button class="iconbtn" data-act="weekNav" data-n="1" aria-label="שבוע הבא">${chev('l')}</button><button class="iconbtn" data-act="weekToday">היום</button></div>
      <h2>הכיוון שלי לשבוע</h2>
      <textarea data-weekfield="vision" placeholder="מה הדבר החשוב ביותר שאני רוצה להשיג השבוע, ולמה?">${esc(W.vision)}</textarea>
      <h2>תוצאות מפתח (${okOut}/${W.outcomes.length}) · מומלץ 3</h2>
      ${W.outcomes.map(o => `<div class="card row ${o.done ? 'done' : ''}"><button class="check ${o.done ? 'on' : ''}" data-act="weekOutToggle" data-id="${o.id}">${o.done ? '✓' : ''}</button><div class="t grow">${esc(o.text)}</div><button class="iconbtn" data-act="weekOutDel" data-id="${o.id}" aria-label="מחק">✕</button></div>`).join('') || '<div class="empty">מה 3 הדברים שיגרמו לי להרגיש שהשבוע הצליח?</div>'}
      <form id="outForm" class="row" style="margin-top:8px"><input id="outText" placeholder="תוצאה מדידה, למשל: 3 לקוחות חדשים ענו להצעה" autocomplete="off"><button class="btn">הוסף</button></form>
      <h2>החזון הגדול שהשבוע משרת</h2>
      ${D().visions.length ? `<div class="opt">${D().visions.map(v => `<button class="${W.visionIds.includes(v.id) ? 'on' : ''}" data-act="weekVisionTog" data-id="${v.id}">${esc(v.title)}</button>`).join('')}</div>` : '<div class="sub">עדיין אין פריטי חזון. אפשר להוסיף בעוד ← חזון.</div>'}
      <h2>התקדמות השבוע</h2>
      <div class="card"><div class="row"><b class="grow">${wdone}/${wt.length} פעולות · ${pct}%</b><span class="sub">${left} ד׳ נותרו</span></div><div class="bar"><div style="width:${pct}%"></div></div>
        <div class="row" style="margin-top:8px"><b class="grow">הרגלים: ${hDone}/${hPlan} · ${hp}%</b></div><div class="bar"><div style="width:${hp}%"></div></div>
        <div class="wbar" style="margin-top:12px">${days.map((d, i) => { const ts = tasksOn(d), dn = ts.filter(t => t.done).length; return `<div class="wcol" data-act="openDay" data-date="${d}"><div class="wfill" style="height:${Math.round(ts.length / maxN * 100)}%"><div class="wdone" style="height:${ts.length ? Math.round(dn / ts.length * 100) : 0}%"></div></div><span class="${d === T ? 'wtoday' : ''}">${DAYS[i]}</span><small>${ts.length}</small></div>`; }).join('')}</div></div>
      <h2>סיכום שבועי</h2>
      <label>מה עבד השבוע?</label><textarea data-weekfield="worked" placeholder="מה הלך טוב ורוצה להמשיך">${esc(W.worked)}</textarea>
      <label>מה לשפר בשבוע הבא?</label><textarea data-weekfield="improve" placeholder="מה לשנות, לפשט או להפסיק">${esc(W.improve)}</textarea>`;
  },
  map() {
    const p = state.pmOpen && D().projects.find(x => x.id === state.pmOpen);
    if (state.pmReview) return pmReviewView();
    if (state.pmIsle && !p && pmWorldOn()) return pmIsleView(state.pmIsle);
    if (p) return pmDetail(p);
    state.pmOpen = null; return pmMap();
  },
  projects() {
    if (state.openProject) {
      const p = D().projects.find(x => x.id === state.openProject);
      if (p) {
        const s = projState(p), open = s.ts.filter(t => !t.done), done = s.ts.filter(t => t.done);
        return `<div class="top"><div class="row"><button class="iconbtn" data-act="backProjects" aria-label="חזרה">${chev('r')}</button><h1>${esc(p.title)}</h1></div><div class="sw"><button class="iconbtn" data-act="renameProject" data-id="${p.id}" aria-label="שנה שם">✏️</button><button class="iconbtn" data-act="delProject" data-id="${p.id}" aria-label="מחק">🗑</button></div></div>
         <div class="card"><div class="row"><b class="grow">${s.done}/${s.total} פעולות הושלמו</b><span class="sub">${s.mins} ד׳ נותרו</span></div><div class="bar"><div style="width:${s.pct}%"></div></div></div>
         ${prioBox('project', p)}
         <div class="opt" style="margin-bottom:10px"><button data-act="projAddTask" data-id="${p.id}">＋ פעולה</button><button data-act="projBulk" data-id="${p.id}">📋 הזנה מרוכזת</button><button data-act="projAssign" data-id="${p.id}">🔗 שייך פעולות קיימות</button></div>
         <h2>פעולות בפרויקט (${open.length})</h2>${open.map(t => taskRow(t, true)).join('') || '<div class="empty">אין פעולות פתוחות. הוסף פעולה, או גרור אליו פעולות מכל הפעולות</div>'}
         ${done.length ? `<h2>הושלמו (${done.length})</h2>${done.map(t => taskRow(t, true)).join('')}` : ''}`;
      }
      state.openProject = null;
    }
    state.tab = 'tasks'; state.allMode = 'projects'; return projectsBoard();
  },
  more() {
    const gs = D().goals.map(goalState), activeG = gs.filter(s => !s.achieved && !s.missed).length;
    const wait = D().goals.filter(g => g.reward && !g.claimed && goalState(g).achieved).length;
    const item = (t, icon, title, sub) => `<div class="card row" data-act="goTab" data-t="${t}"><span style="font-size:26px">${icon}</span><div class="grow"><div class="t"><b>${title}</b></div><div class="meta">${sub}</div></div>${chev('l')}</div>`;
    return `<div class="top"><div class="brand">${logoMark(40)}<h1>Do It</h1></div></div>
      <h2>יומי</h2>
      ${item('journal', '📓', 'יומן', `${journalDays().length} ימים עם רישום`)}
      ${item('rhythm', '🕒', 'מקצב היום', `${D().rhythm.length} הפסקות · שעות התחלה וסיום`)}
      ${item('week', '🧭', 'חזון שבועי', 'תוצאות השבוע, סיכום ותכנון')}
      ${item('dayrewards', '🎁', 'תגמולים יומיים', `${D().dayRewards.length} תגמולים ברשימה`)}
      <h2>תכנון</h2>
      ${item('tasks', '✅', 'כל הפעולות והפרויקטים', `${D().tasks.filter(t => !t.done).length} פעולות פתוחות · ${D().projects.length} פרויקטים · ${D().tasks.filter(t => !t.done && !effQuad(t)).length} לא מסווגות`)}
      ${item('assistant', '🧠', 'עוזר התכנון שלי', `${D().topics.length} נושאים בזיכרון`)}
      <h2>אישי</h2>
      ${item('habits', '🔁', 'הרגלים', `${D().habits.length} הרגלים`)}
      ${item('goals', '🎯', 'יעדים ותגמולים', `${activeG} פעילים${wait ? ` · 🎁 ${wait} ממתינים` : ''}`)}
      ${item('vision', '🌟', 'חזון', `${D().visions.length} פריטים`)}
      ${item('lists', '📝', 'רשימות', `${D().lists.length} רשימות`)}
      <h2>הגדרות</h2>
      <div class="card"><div class="t"><b>🔔 רמת הודעות</b></div><select id="notifySel" style="margin-top:6px">${NOTIFY.map(([v, l]) => '<option value="' + v + '" ' + (notifyLevel() === v ? 'selected' : '') + '>' + l + '</option>').join('')}</select><div class="sub" id="notifyDesc" style="margin-top:6px">${(NOTIFY.find(x => x[0] === notifyLevel()) || NOTIFY[1])[2]}</div></div>
      ${dzCard()}
      <div class="card row"><div class="grow"><div class="t">גרסה ${APP_VERSION}</div><div class="sub">אם נראה שהאפליקציה לא מעודכנת, לחץ כדי לנקות את המטמון ולטעון מחדש</div></div><button class="iconbtn" data-act="refreshApp">🔄 רענון</button></div>
      <h2>חשבון</h2>
      <div class="card row" data-act="account"><span style="font-size:26px">☁️</span><div class="grow"><div class="t"><b>כניסה וסנכרון</b></div><div class="meta">${Cloud.user ? esc(Cloud.user.email) : 'לא מחובר'}</div></div>${chev('l')}</div>`;
  },
  journal() {
    const d = state.jDate, J = jEntry(d), note = D().notes[d] || '', T = TODAY();
    const past = journalDays().filter(x => x !== d).slice(0, 30);
    const pastRow = x => {
      const e = jEntry(x), n = D().notes[x] || '';
      return `<div class="card row" data-act="jOpen" data-d="${x}">${e.photo ? `<img class="jthumb" src="${e.photo}" alt="">` : ''}<div class="grow"><div class="t"><b>${longDate(x)}</b></div><div class="meta">${e.wins.length ? `<span>🏆 ${e.wins.length}</span>` : ''}<span>${esc(n.slice(0, 60))}${n.length > 60 ? '…' : ''}</span></div></div></div>`;
    };
    return `<div class="top"><div><h1>היומן שלי</h1><div class="sub">${longDate(d)}</div></div>
      <div class="sw"><button class="iconbtn" data-act="jShift" data-n="-1" aria-label="היום הקודם">${chev('r')}</button><button class="iconbtn" data-act="jToday">היום</button><button class="iconbtn" data-act="jShift" data-n="1" aria-label="היום הבא" ${d >= T ? 'disabled' : ''}>${chev('l')}</button></div></div>
      <h2>מחשבות</h2><textarea id="jnote" rows="6" placeholder="מה עבר עליך היום? מחשבות, רגשות, דברים לזכור...">${esc(note)}</textarea>
      <h2>תמונה של היום</h2>
      ${J.photo ? `<img class="jphoto" src="${J.photo}" alt="תמונה של היום"><div class="opt" style="margin-top:8px"><button data-act="jPhotoPick">החלף תמונה</button><button data-act="jPhotoDel">הסר</button></div>` : '<button class="btn ghost" data-act="jPhotoPick" style="width:100%">📷 הוסף תמונה</button>'}
      <input type="file" id="jphoto" accept="image/*" hidden>
      <h2>הצלחות 🏆</h2>
      ${J.wins.map(w => `<div class="card row win"><span style="font-size:20px">🏆</span><div class="t grow">${esc(w.text)}</div><button class="iconbtn" data-act="jWinDel" data-id="${w.id}" aria-label="מחק">✕</button></div>`).join('') || '<div class="empty">מה הלך טוב היום? גם דבר קטן נחשב</div>'}
      <form id="winForm" class="row" style="margin-top:10px"><input id="winText" placeholder="הצלחה חדשה" autocomplete="off"><button class="btn">הוסף</button></form>
      ${past.length ? `<h2>ימים קודמים</h2>${past.map(pastRow).join('')}` : ''}`;
  },
  rhythm() {
    const items = rhythmSorted();
    return `<div class="top"><h1>מקצב היום</h1></div>
     <p class="sub">הפסקות אוכל ומנוחה שאתה קובע בעצמך. הן מופיעות ביום, ואינן פעולות ואינן נספרות בהתקדמות.</p>
     ${items.map(r => `<div class="card row"><span style="font-size:22px">${r.kind === 'meal' ? '🍽' : '😌'}</span><div class="grow"><div class="t"><b>${esc(r.label)}</b></div><div class="meta"><span>${r.time}</span><span>${r.mins} ד׳</span><span>${r.kind === 'meal' ? 'ארוחה' : 'מנוחה יומית'}</span></div></div><button class="iconbtn" data-act="rhythmDel" data-id="${r.id}" aria-label="מחק">✕</button></div>`).join('') || '<div class="empty">עדיין לא הגדרת הפסקות</div>'}
     ${items.some(r => r.kind === 'rest') ? '' : '<div class="clarity"><div class="w">⚠ אין מנוחה יומית מוגדרת. מומלץ להוסיף לפחות אחת.</div></div>'}
     <h2>הפסקה חדשה</h2>
     <form id="rhForm"><label>שם</label><input name="label" required placeholder="למשל: ארוחת צהריים" autocomplete="off">
      <label>שעה</label><input type="time" name="time" required value="13:00">
      <label>משך</label><select name="mins">${[10, 15, 20, 30, 45, 60].map(m => `<option value="${m}" ${m === 30 ? 'selected' : ''}>${m} דקות</option>`).join('')}</select>
      <label>סוג</label><select name="kind"><option value="meal">ארוחה</option><option value="rest">מנוחה יומית</option></select>
      <div class="actions"><button class="btn">הוסף</button></div></form>
     <h2>רעיונות להפסקה</h2><p class="sub">מה כיף לעשות בהפסקה. אחד מהם מוצע בכל הפסקה.</p>
     ${D().breakIdeas.map(x => '<div class="card row"><span style="font-size:20px">💡</span><div class="t grow">' + esc(x.title) + '</div><button class="iconbtn" data-act="ideaDel" data-id="' + x.id + '" aria-label="מחק">✕</button></div>').join('') || '<div class="sub">עדיין אין רעיונות משלך. עד אז מוצעים: ' + DEFAULT_IDEAS.join(', ') + '.</div>'}
     <form id="ideaForm" class="row" style="margin-top:8px"><input name="title" placeholder="רעיון חדש להפסקה" required autocomplete="off"><button class="btn">הוסף</button></form>
     <h2>הפסקה בכל שעה</h2><p class="sub">אחרי כ-50 דקות עבודה (לפי הטיימר ופעולות שסימנת כבוצעו) תופיע הצעה ל-10 דקות הפסקה, בלי חסימה. ההצעה מופיעה כשהאפליקציה פתוחה.</p>
     <h2>שעות ההתחלה והסיום שלי</h2>${dayHistoryHTML()}`;
  },
  dayrewards() {
    const L = D().dayRewards;
    return `<div class="top"><h1>תגמולים יומיים</h1></div><p class="sub">רשימה של תגמולים קטנים. כשאתה עומד בתנאי של היום, תבחר אחד מהם או תגריל.</p>
     ${L.map(r => `<div class="card row"><span style="font-size:22px">🎁</span><div class="t grow">${esc(r.title)}</div><button class="iconbtn" data-act="rewardDel" data-id="${r.id}" aria-label="מחק">✕</button></div>`).join('') || '<div class="empty">עדיין אין תגמולים. הוסף קפה, פרק שוקולד, סרט בערב...</div>'}
     <form id="rwForm" class="row" style="margin-top:10px"><input name="title" placeholder="תגמול חדש" required autocomplete="off"><button class="btn">הוסף</button></form>`;
  },
  matrix() { state.tab = 'tasks'; state.allMode = 'matrix'; return views.matrixBody(); },
  matrixBody() {
    const open = D().tasks.filter(t => !t.done), by = k => open.filter(t => effQuad(t) === k).sort((a, b) => (b.want || 0) - (a.want || 0) || (a.date || '9999').localeCompare(b.date || '9999')), none = open.filter(t => !effQuad(t));
    const items = k => D().projects.filter(p => p.quad === k).map(p => '<div class="sub">📁 ' + esc(p.title) + '</div>').join('') ;
    const mcard = t => '<div class="ucard mx" data-task="' + t.id + '" data-act="taskMenu" data-id="' + t.id + '"><div class="t">' + esc(t.title) + '</div><div class="meta">' + (t.quad ? '' : (effQuad(t) ? '<span title="עדיפות שעברה בירושה">↳ בירושה</span>' : '')) + (t.date ? '<span>' + (t.date === TODAY() ? 'היום' : shortDate(t.date)) + '</span>' : '') + ((t.want || 0) >= 4 ? '<span>💗' + t.want + '</span>' : '') + '</div></div>';
    const cell = q => '<section class="mxcell ' + q[0] + '" data-drop="q:' + q[0] + '"><div class="mxh"><b>' + q[1] + '</b><span class="sub">' + by(q[0]).length + '</span></div>' + items(q[0]) + (by(q[0]).map(mcard).join('') || '<div class="sub mxempty">גרור לכאן</div>') + '</section>';
    return `<div class="top"><h1>כל הפעולות</h1></div>${allSeg()}
     <p class="sub">גרור כל פעולה לריבוע שמתאים לה (בטלפון: לחיצה ארוכה ואז גרירה). לחיצה קצרה פותחת את התפריט שלה. פעולה שלא מסווגת יורשת את העדיפות של הפעולה או הפרויקט שלה.</p>
     <div class="mxaxis"><span>🔥 דחוף</span><span>⏳ לא דחוף</span></div>
     <div class="mx2">${QUADS.map(cell).join('')}</div>
     <section class="mxcell mxnone" data-drop="q:none"><div class="mxh"><b>📥 עוד לא סווגו</b><span class="sub">${none.length}</span></div>${none.slice(0, 60).map(mcard).join('') || '<div class="sub mxempty">🎉 כל הפעולות הפתוחות סווגו. גרור לכאן כדי להסיר סיווג.</div>'}</section>
     <details class="card" style="margin-top:10px"><summary>מה עושים בכל ריבוע?</summary>${QUADS.map(q => '<div style="margin-top:8px"><b>' + q[1] + '</b><div class="sub">' + esc(q[2]) + '</div><div class="sub" style="opacity:.8">דוגמאות: ' + esc(q[3]) + '</div></div>').join('')}</details>`;
  },
  assistant() { return asstView(); },
  assistmem() { return asstMemView(); },
  cheer() {
    const all = cheerAll(), cat = state.cheerCat || '', list = cat ? all.filter(c => c.cat === cat) : all, cur = cheerPick(list, state.remShift);
    return `<div class="top"><h1>💪 עידוד</h1></div><p class="sub">המשפטים שלי, שמזכירים לי מי אני רוצה להיות. אני מחליט מה כתוב כאן.</p>
      <div class="cheerhero">${cur ? esc(cur.text) : 'אין עדיין משפטים בקטגוריה הזו'}${cur ? '<span class="sub">' + esc(cheerCatName(cur.cat)) + '</span>' : ''}</div>
      <button class="btn" style="width:100%;margin-bottom:12px" data-act="nextReminder" ${list.length > 1 ? '' : 'disabled'}>🔄 עוד משפט</button>
      <div class="opt" style="margin-bottom:8px"><button class="${cat ? '' : 'on'}" data-act="cheerCat" data-c="">הכל (${all.length})</button>${CHEER_CATS.map(([k, l]) => `<button class="${cat === k ? 'on' : ''}" data-act="cheerCat" data-c="${k}">${l} (${all.filter(c => c.cat === k).length})</button>`).join('')}</div>
      <h2>הרשימה שלי (${list.length})</h2>
      ${list.map(c => `<div class="card row"><div class="grow"><div class="t">${esc(c.text)}</div><div class="meta"><span class="chip">${esc(cheerCatName(c.cat))}</span></div></div><button class="iconbtn" data-act="cheerEdit" data-id="${c.id}" aria-label="עריכה">✏️</button><button class="iconbtn" data-act="cheerDel" data-id="${c.id}" aria-label="מחיקה">🗑</button></div>`).join('') || '<div class="empty">אין משפטים בקטגוריה הזו עדיין</div>'}
      <button class="btn ghost" style="width:100%;margin-top:10px" data-act="cheerAdd">＋ משפט חדש</button>`;
  },
  goals() {
    const F = state.goalFilter, all = D().goals.map(g => ({ g, s: goalState(g) }));
    const active = all.filter(x => !x.s.achieved && !x.s.missed), done = all.filter(x => x.s.achieved), missed = all.filter(x => x.s.missed);
    const waiting = done.filter(x => x.g.reward && !x.g.claimed), claimed = all.filter(x => x.g.claimed);
    const list = F === 'done' ? done : F === 'missed' ? missed : active;
    const FL = [['active', `פעילים (${active.length})`], ['done', `הושגו (${done.length})`], ['missed', `עבר המועד (${missed.length})`]];
    return `<div class="top"><h1>יעדים ותגמולים</h1></div>
      <div class="card"><div class="row"><b class="grow">${done.length} מתוך ${all.length} יעדים הושגו</b><span class="sub">🎁 ${waiting.length} ממתינים</span></div>
      <div class="bar"><div style="width:${all.length ? Math.round(done.length / all.length * 100) : 0}%"></div></div></div>
      <div class="seg">${FL.map(([k, l]) => `<button class="${F === k ? 'on' : ''}" data-act="goalFilter" data-f="${k}">${l}</button>`).join('')}</div>
      ${list.map(goalCard).join('') || '<div class="empty">אין יעדים בקטגוריה הזו</div>'}
      <h2>תגמולים</h2>
      ${waiting.map(x => `<div class="card row"><div class="grow"><div class="t">🎁 ${esc(x.g.reward)}</div><div class="meta">על: ${esc(x.g.title)}</div></div><button class="btn" data-act="goalClaim" data-id="${x.g.id}">מימשתי</button></div>`).join('')}
      ${claimed.map(x => `<div class="card done"><div class="t">🎁 ${esc(x.g.reward || x.g.title)}</div><div class="meta">מומש ${x.g.claimedAt ? shortDate(x.g.claimedAt) : ''} · ${esc(x.g.title)}</div></div>`).join('')}
      ${!waiting.length && !claimed.length ? '<div class="empty">תגמול מתווסף לכל יעד, והוא נפתח כשמשיגים אותו</div>' : ''}
      <button class="fab" data-act="addGoal">+</button>`;
  },
  lists() {
    if (state.openList) {
      const l = D().lists.find(x => x.id === state.openList);
      if (l) return `<div class="top"><div class="row"><button class="iconbtn" data-act="backLists" aria-label="חזרה">${chev('r')}</button><h1>${esc(l.title)}</h1></div><div class="sw"><button class="iconbtn" data-act="printList" data-id="${l.id}">🖨</button><button class="iconbtn" data-act="delList" data-id="${l.id}">🗑</button></div></div>
        ${l.items.map(i => `<div class="card row ${i.done ? 'done' : ''}"><button class="check ${i.done ? 'on' : ''}" data-act="toggleItem" data-id="${i.id}">${i.done ? '✓' : ''}</button><div class="t grow">${esc(i.text)}</div><button class="iconbtn" data-act="delItem" data-id="${i.id}">✕</button></div>`).join('') || '<div class="empty">הרשימה ריקה</div>'}
        <form id="itemForm" class="row" style="margin-top:10px"><input id="itemText" placeholder="פריט חדש" autocomplete="off"><button class="btn">הוסף</button></form>`;
      state.openList = null;
    }
    return `<div class="top"><h1>רשימות</h1></div>
      ${D().lists.map(l => `<div class="card row" data-act="openList" data-id="${l.id}"><div class="grow"><div class="t"><b>${esc(l.title)}</b></div><div class="meta">${l.items.filter(i => i.done).length}/${l.items.length} פריטים</div></div><span class="sub">${chev('l')}</span></div>`).join('') || '<div class="empty">עדיין אין רשימות</div>'}
      <button class="fab" data-act="addList">+</button>`;
  }
};

function render() {
  applyDesign();
  sweepPast();
  // A background re-render (sync status, timers) must not wipe what the user is typing: remember the changed fields of the current screen
  const typed = {}; let focusKey = null, caret = null;
  document.querySelectorAll('#view input, #view select, #view textarea').forEach(el => {
    const k = el.name || el.id; if (!k || ['hidden', 'checkbox', 'file', 'radio'].includes(el.type)) return;
    const changed = el.tagName === 'SELECT' ? el.value !== (([...el.options].find(o => o.defaultSelected) || el.options[0] || {}).value ?? '') : (el.value !== '' && el.value !== el.defaultValue);
    if (changed) typed[k] = el.value;
    if (el === document.activeElement) { focusKey = k; try { caret = el.selectionStart; } catch (e) {} }
  });
  const board = $('#uboard'), boardScroll = board ? board.scrollLeft : null; // keep the board's horizontal position across re-renders
  document.body.classList.toggle('wide', state.tab === 'upcoming');
  $('#view').innerHTML = views[state.tab]();
  if (MORE_TABS.includes(state.tab) && state.tab !== 'assistant' && !(state.tab === 'lists' && state.openList) && !(state.tab === 'projects' && (state.openProject || state.openJob))) // back to the "עוד" menu
    $('#view').insertAdjacentHTML('afterbegin', `<button class="iconbtn backmore" data-act="goTab" data-t="more" aria-label="חזרה לעוד">${chev('r')}<span style="margin-inline-start:6px">עוד</span></button>`);
  if (DEMO) $('#view').insertAdjacentHTML('afterbegin', '<div class="demobar">מצב דמו · נתונים בדויים <button class="lnk" data-act="demoReset">אפס דמו</button></div>');
  if (boardScroll === null && $('#uboard') && state.tab === 'upcoming' && state.upMode !== 'month') { const b = $('#uboard'), c = [...b.querySelectorAll('.ucol[data-drop]')].find(x => /^[0-9]{4}-/.test(x.dataset.drop)); if (c) b.scrollLeft += c.getBoundingClientRect().right - b.getBoundingClientRect().right + 16; }
  if (boardScroll !== null && $('#uboard')) $('#uboard').scrollLeft = boardScroll;
  // Entrance animation (FitMe-style soft rise, staggered) only when the screen changes, not on every re-render.
  const view = $('#view'), key = state.tab + (state.tab === 'upcoming' ? state.upMode : '') + (state.openList || '') + (state.openProject || '') + (state.openJob || '') + (state.pmOpen || '') + (state.pmIsle || '') + (state.pmReview || '');
  const enter = state.viewKey !== key; state.viewKey = key;
  if (!enter) { // same screen: put back what was typed, and the cursor
    document.querySelectorAll('#view input, #view select, #view textarea').forEach(el => {
      const k = el.name || el.id; if (k && k in typed) el.value = typed[k];
      if (k && k === focusKey) { el.focus(); try { if (caret !== null) el.setSelectionRange(caret, caret); } catch (e) {} }
    });
  }
  view.classList.toggle('enter', enter);
  { const w = document.getElementById('world'); if (w && state.pmZoom === 'out') w.classList.add('zoomout'); const iv = document.querySelector('.isleview'); if (iv && state.pmZoom === 'in') view.classList.add('zoomin'); else view.classList.remove('zoomin'); state.pmZoom = null; }
  if (enter) {
    [...view.children].forEach((el, i) => el.style.setProperty('--i', Math.min(i, 10)));
    view.querySelectorAll('.ucol').forEach((el, i) => el.style.setProperty('--c', Math.min(i, 8)));
  }
  if (state.pop) { // little "pop" on the item that was just checked
    const { id, sid, date } = state.pop; state.pop = null;
    document.querySelectorAll(sid ? `[data-sid="${sid}"].on` : `[data-id="${id}"].on`).forEach(el => { if (!date || el.dataset.date === date) el.classList.add('pop'); });
  }
  const navTab = MORE_TABS.includes(state.tab) ? 'more' : state.tab;
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === navTab));
  const of = $('#outForm');
  if (of) of.onsubmit = e => {
    e.preventDefault(); const txt = $('#outText').value.trim(); if (!txt) return;
    weekData(state.weekStart).outcomes.push({ id: uid(), text: txt, done: false });
    e.target.reset(); Store.save(); render(); $('#outText').focus();
  };
  const af = $('#asstAdd');
  if (af) af.onsubmit = e => { e.preventDefault(); const t = new FormData(af).get('t').trim(), ss = asstSess(); if (!t || !ss) return; ss.priorities.push({ id: uid(), text: t, group: guessGroup(t), area: guessArea(t), reason: 'הוספת בעצמך' }); asstSave(ss); render(); };
  const idf = $('#ideaForm');
  if (idf) idf.onsubmit = e => { e.preventDefault(); const t = new FormData(idf).get('title').trim(); if (!t) return; D().breakIdeas.push({ id: uid(), title: t }); idf.reset(); Store.save(); render(); };
  const rf = $('#rhForm');
  if (rf) rf.onsubmit = e => { e.preventDefault(); const f = new FormData(rf); D().rhythm.push({ id: uid(), label: f.get('label').trim(), time: f.get('time'), mins: +f.get('mins'), kind: f.get('kind') }); rf.reset(); Store.save(); render(); };
  const rw = $('#rwForm');
  if (rw) rw.onsubmit = e => { e.preventDefault(); const t = new FormData(rw).get('title').trim(); if (!t) return; D().dayRewards.push({ id: uid(), title: t }); rw.reset(); Store.save(); render(); };
  const wf = $('#winForm');
  if (wf) wf.onsubmit = e => {
    e.preventDefault(); const txt = $('#winText').value.trim(); if (!txt) return;
    jSet(state.jDate).wins.push({ id: uid(), text: txt });
    e.target.reset(); Store.save(); render(); celebrate(); $('#winText').focus();
  };
  const ph = $('#jphoto');
  if (ph) ph.onchange = () => { const file = ph.files[0]; if (file) shrinkPhoto(file, url => { jSet(state.jDate).photo = url; Store.save(); render(); }); };
  const f = $('#itemForm');
  if (f) f.onsubmit = e => {
    e.preventDefault();
    const txt = $('#itemText').value.trim(); if (!txt) return;
    const l = D().lists.find(x => x.id === state.openList);
    l.items.push({ id: uid(), text: txt, done: false });
    e.target.reset(); Store.save(); render(); $('#itemText').focus();
  };
}

/* ---------- Sheets / forms ---------- */
function sheet(html) {
  const s = $('#sheet'), opening = s.hidden;
  s.innerHTML = `<div class="panel">${html}</div>`; s.hidden = false;
  if (opening) { s.classList.add('opening'); setTimeout(() => s.classList.remove('opening'), 380); }
  s.onclick = e => { if (e.target === s) closeSheet(); };
}
function closeSheet() { $('#sheet').hidden = true; $('#sheet').innerHTML = ''; }
const visionOpts = sel => `<option value="">ללא קישור</option>` + D().visions.map(v => `<option value="${v.id}" ${v.id === sel ? 'selected' : ''}>${esc(v.title)}</option>`).join('');

function taskForm(id, presetDate, presetProject, preset) {
  const t = id ? D().tasks.find(x => x.id === id) : { title: '', date: presetDate !== undefined ? presetDate : state.date, priority: 0, print: false, visionId: '', projectId: presetProject || '', notes: '', energy: 3, mins: 15, repeat: '', jobId: '', ...preset };
  const mo = [...new Set([5, 10, 15, 20, 30, 45, 60, 90, t.mins || 15])].sort((a, b) => a - b);
  sheet(`<h1>${id ? 'עריכת פעולה' : 'פעולה חדשה'}</h1>
  ${id ? '' : newChips('action')}
  <form id="f">
   <label>מה לעשות (פעולה אחת, ברורה ומוחשית)</label><input name="title" required value="${esc(t.title)}" autofocus autocomplete="off">
   <div id="clHint" class="clarity">${id ? '' : clarityHTML('', true)}</div>
   <label>תיאור הפעולה (אופציונלי, באריכות)</label><textarea name="notes" rows="2" placeholder="פרטים: מה בדיוק, איפה, למי, מה צריך להיות מוכן">${esc(t.notes || '')}</textarea>
   <label>מתי?</label>
   <div class="opt" id="dateChips" style="margin-bottom:6px">${[['היום', TODAY()], ['מחר', addDays(TODAY(), 1)], ['ללא תאריך', '']].map(([l, v]) => `<button type="button" class="${(t.date || '') === v ? 'on' : ''}" onclick="const f=this.closest('form');f.elements.date.value='${v}';this.parentNode.querySelectorAll('button').forEach(b=>b.classList.remove('on'));this.classList.add('on')">${l}</button>`).join('')}</div>
   <label>תתי-פעולות (אופציונלי, שורה לכל תת-פעולה)</label><textarea name="subs" rows="2" placeholder="צעדים קטנים בתוך הפעולה">${esc((t.subs || []).map(x => x.title).join('\n'))}</textarea>
   <details class="moreopts" ${id || t.repeat ? 'open' : ''}><summary>אפשרויות נוספות</summary>
   <label>תאריך אחר</label><input type="date" name="date" value="${t.date || ''}" oninput="document.querySelectorAll('#dateChips button').forEach(b=>b.classList.remove('on'))">
   <label>חוזרת? (בסיום נוצרת הפעולה הבאה)</label><select name="repeat">${REPEATS.map(([v, l]) => `<option value="${v}" ${(t.repeat || '') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
   <label>כמה אנרגיה זה דורש ממך? (1 = קל, 5 = הכי מאמץ)</label>
   <div class="stars" id="stars">${[1, 2, 3, 4, 5].map(n => `<button type="button" class="${n <= (t.energy || 0) ? 'on' : ''}" data-act="star" data-n="${n}">★</button>`).join('')}</div>
   <input type="hidden" name="energy" value="${t.energy || 0}">
   <label>משך (עד 15 דקות; ארוך יותר יוצע לפיצול)</label>
   <select name="mins">${mo.map(m => `<option value="${m}" ${m == (t.mins || 15) ? 'selected' : ''}>${m} דקות</option>`).join('')}</select>
   ${prioFields(t)}
   <label>פרויקט (אופציונלי)</label><select name="owner">${ownerOpts(t.projectId ? 'p:' + t.projectId : '')}</select>
   <label class="row" style="color:var(--ink)"><input type="checkbox" name="brainless" style="width:auto" ${t.brainless ? 'checked' : ''}> ⚡ Brainless (פעולה פשוטה שאפשר להעיף ברגע)</label>
   <label class="row" style="color:var(--ink)"><input type="checkbox" name="print" style="width:auto" ${t.print ? 'checked' : ''}> סמן להדפסה</label>
   </details>
   <div class="actions">${id ? '<button type="button" class="btn danger" data-act="delTask" data-id="' + id + '">מחק</button>' : ''}<button type="button" class="btn ghost" data-act="close">ביטול</button><button class="btn">שמור</button></div>
  </form>`);
  // Clarity gate: new tasks (or a changed title) must be confirmed with "זה ברור" before they are saved.
  const form = $('#f'), origTitle = id ? t.title : null;
  form.owner.addEventListener('change', () => { // "＋ פעולה / פרויקט חדש" creates it on the spot and selects it
    const sel = form.owner, v = sel.value; if (v !== '__new__') return;
    const made = newProject();
    if (made) { sel.add(new Option('📁 ' + made.title, 'p:' + made.id), sel.options[sel.options.length - 1]); sel.value = 'p:' + made.id; } else sel.value = '';
  });
  form.title.addEventListener('input', () => {
    delete form.dataset.ok; $('#clHint').innerHTML = clarityHTML(form.title.value, true); // a changed title needs a fresh approval
  });
  // An unclear action (new, or with a changed title) is not saved: an alert explains what to fix.
  const blocked = () => !form.dataset.ok && (!id || form.title.value.trim() !== origTitle) && clarity(form.title.value).length > 0;
  $('#f').onsubmit = e => {
    e.preventDefault();
    if (blocked()) { const why = clarity(form.title.value)[0]; $('#clHint').innerHTML = clarityHTML(form.title.value, true); form.title.focus(); alert('לא ניתן לשמור: הפעולה לא כתובה בצורה ברורה.\n' + why); return; }
    const f = new FormData(e.target), own = f.get('owner') || '', jobId = '', projectId = own.startsWith('p:') ? own.slice(2) : '', prevS = t.subs || [], subs = (f.get('subs') || '').split('\n').map(x => x.trim()).filter(Boolean).map(l => prevS.find(x => x.title === l) || { id: uid(), title: l, done: false });
    const obj = { title: f.get('title').trim(), date: f.get('date') || null, priority: f.get('quad') ? quadPri[f.get('quad')] : (t.priority || 0), quad: f.get('quad') || '', want: +f.get('want') || 0, visionId: t.visionId || '', jobId, projectId, subs, notes: f.get('notes'), repeat: f.get('repeat') || '', print: f.get('print') === 'on', brainless: f.get('brainless') === 'on', energy: +f.get('energy'), mins: +f.get('mins') };
    let saved = t;
    if (id) Object.assign(t, obj); else { saved = { id: uid(), done: false, subs: [], ...obj }; D().tasks.push(saved); }
    resolveLong([saved]);
  };
}
function habitForm(id) {
  const h = id ? D().habits.find(x => x.id === id) : { title: '', task: '', mins: 10, energy: 2, days: [0, 1, 2, 3, 4, 5, 6], visionId: '' };
  const days = new Set(h.days), mo = [...new Set([5, 10, 15, h.mins || 10])].sort((a, b) => a - b);
  sheet(`<h1>${id ? 'עריכת הרגל' : 'הרגל חדש'}</h1>
  <form id="f"><label>שם ההרגל</label><input name="title" required value="${esc(h.title)}">
   <label>איזו פעולה ההרגל מייצר? (פעולה קונקרטית, עד 15 דקות)</label><input name="task" required value="${esc(h.task || '')}" autocomplete="off" placeholder="למשל: ללכת 15 דקות סביב הבלוק">
   <div id="htHint" class="clarity">${clarityHTML(h.task || '')}</div>
   <label>כמה אנרגיה זה דורש? (1 = קל, 5 = הכי מאמץ)</label>
   <div class="stars" id="stars">${[1, 2, 3, 4, 5].map(n => `<button type="button" class="${n <= (h.energy || 0) ? 'on' : ''}" data-act="star" data-n="${n}">★</button>`).join('')}</div>
   <input type="hidden" name="energy" value="${h.energy || 0}">
   <label>משך</label><select name="mins">${mo.map(m => `<option value="${m}" ${m == (h.mins || 10) ? 'selected' : ''}>${m} דקות</option>`).join('')}</select>
   <label>באילו ימים</label><div class="days">${DAYS.map((x, i) => `<button type="button" class="${days.has(i) ? 'on' : ''}" data-act="dayTog" data-d="${i}">${x}</button>`).join('')}</div>
   <label>קישור לחזון (אופציונלי)</label><select name="visionId">${visionOpts(h.visionId)}</select>
   ${id ? `<button type="button" class="btn ghost" style="width:100%;margin-top:12px" data-act="habToTask" data-id="${id}">🔁 הפוך לפעולה חוזרת</button><div class="sub">ההרגל נשאר. נוצרת פעולה שאפשר לקבוע כל כמה זמן היא חוזרת.</div>` : ''}
   <div class="actions">${id ? '<button type="button" class="btn danger" data-act="delHabit" data-id="' + id + '">מחק</button>' : ''}<button type="button" class="btn ghost" data-act="close">ביטול</button><button class="btn">שמור</button></div></form>`);
  $('#f').task.addEventListener('input', ev => { $('#htHint').innerHTML = clarityHTML(ev.target.value); });
  $('#f').onsubmit = e => {
    e.preventDefault();
    const sel = [...document.querySelectorAll('.days .on')].map(b => +b.dataset.d), fd = new FormData(e.target);
    const obj = { title: fd.get('title').trim(), task: fd.get('task').trim(), energy: +fd.get('energy'), mins: +fd.get('mins'), days: sel.length ? sel : [0, 1, 2, 3, 4, 5, 6], visionId: fd.get('visionId') || '' };
    if (id) Object.assign(h, obj); else D().habits.push({ id: uid(), log: {}, ...obj });
    Store.save(); closeSheet(); render();
  };
}
/* ---------- Bulk habits entry: for each habit we ask which concrete task it generates ---------- */
let habBulk = [];
function habBulkStart() {
  sheet(`<h1>הזנת הרגלים בבת אחת</h1><p class="sub">הרגל בכל שורה. בשלב הבא אשאל אותך, לכל הרגל, איזו פעולה קונקרטית הוא מייצר, באילו ימים, וכמה אנרגיה וזמן היא דורשת.</p>
   <textarea id="habText" style="min-height:160px" placeholder="פעילות גופנית&#10;קריאה&#10;סדר בבית"></textarea>
   <div class="actions"><button class="btn ghost" data-act="close">ביטול</button><button class="btn" data-act="habBulkNext">המשך</button></div>`);
  setTimeout(() => $('#habText') && $('#habText').focus(), 50);
}
function habBulkRender(showMiss) {
  const old = $('#sheet .panel'), st = old ? old.scrollTop : 0;
  sheet(`<h1>איזו פעולה כל הרגל מייצר?</h1>
   <p class="sub">${habBulk.length} הרגלים. כל הרגל הופך לפעולה קטנה וברורה בכל יום שנבחר.</p>
   ${habBulk.map((b, i) => `<div class="bulkrow ${showMiss && (!b.task.trim() || !clrOk(b.task, b.clear) || !b.energy) ? 'miss' : ''}">
     <input data-habtitle="${i}" value="${esc(b.title)}" style="font-weight:700" autocomplete="off">
     <label>הפעולה שההרגל מייצר (פעולה קונקרטית)</label>
     <input data-habtask="${i}" value="${esc(b.task)}" autocomplete="off" placeholder="למשל: ללכת 15 דקות סביב הבלוק">
     <div class="clarity" id="hcl${i}">${clarityHTML(b.task)}</div>
     <button class="clearbtn ${b.clear ? 'on' : ''}" ${clarity(b.task).length ? '' : 'hidden'} data-act="habClear" data-i="${i}">${b.clear ? '✅ זה ברור' : '☐ זה ברור: ' + CLEAR_LABEL}</button>
     <label>באילו ימים</label><div class="days">${DAYS.map((x, d) => `<button type="button" class="${b.days.includes(d) ? 'on' : ''}" data-act="habDay" data-i="${i}" data-d="${d}">${x}</button>`).join('')}</div>
     <label>אנרגיה</label><div class="stars">${[1, 2, 3, 4, 5].map(n => `<button type="button" class="${n <= b.energy ? 'on' : ''}" data-act="habStar" data-i="${i}" data-n="${n}">★</button>`).join('')}</div>
     <label>משך (דקות)</label><div class="opt">${[5, 10, 15].map(m => `<button class="${b.mins === m ? 'on' : ''}" data-act="habMins" data-i="${i}" data-m="${m}">${m}</button>`).join('')}</div></div>`).join('')}
   ${CLARITY_EX}
   ${showMiss ? '<div class="sub" style="color:var(--danger)">חסרה פעולה, אנרגיה או אישור "זה ברור" בשורות המסומנות.</div>' : ''}
   <div class="actions"><button class="btn ghost" data-act="close">ביטול</button><button class="btn" data-act="habBulkSave">הוסף ${habBulk.length} הרגלים</button></div>`);
  $('#sheet .panel').scrollTop = st;
}
function visionForm(id) {
  const v = id ? D().visions.find(x => x.id === id) : { title: '', desc: '', area: '' };
  sheet(`<h1>${id ? 'עריכת חזון' : 'פריט חזון חדש'}</h1>
  <form id="f"><label>כותרת</label><input name="title" required value="${esc(v.title)}">
   <label>תחום (בריאות, עסק, משפחה...)</label><input name="area" value="${esc(v.area)}">
   <label>תיאור</label><textarea name="desc">${esc(v.desc)}</textarea>
   <div class="actions">${id ? '<button type="button" class="btn danger" data-act="delVision" data-id="' + id + '">מחק</button>' : ''}<button type="button" class="btn ghost" data-act="close">ביטול</button><button class="btn">שמור</button></div></form>`);
  $('#f').onsubmit = e => {
    e.preventDefault(); const f = new FormData(e.target);
    const obj = { title: f.get('title').trim(), area: f.get('area').trim(), desc: f.get('desc') };
    if (id) Object.assign(v, obj); else D().visions.push({ id: uid(), ...obj });
    Store.save(); closeSheet(); render();
  };
}
function goalForm(id) {
  const g = id ? D().goals.find(x => x.id === id) : { title: '', type: 'manual', target: 10, unit: '', start: TODAY(), deadline: '', habitId: '', visionId: '', reward: '' };
  sheet(`<h1>${id ? 'עריכת יעד' : 'יעד חדש'}</h1><form id="f">
   <label>מה היעד?</label><input name="title" required value="${esc(g.title)}">
   <label>איך עוקבים אחרי ההתקדמות?</label>
   <select name="type"><option value="manual" ${g.type === 'manual' ? 'selected' : ''}>מספר שאני מעדכן ידנית</option><option value="habit" ${g.type === 'habit' ? 'selected' : ''}>ימי ביצוע של הרגל (אוטומטי)</option></select>
   <div id="habitSel"><label>איזה הרגל?</label><select name="habitId"><option value="">בחר הרגל</option>${D().habits.map(h => `<option value="${h.id}" ${h.id === g.habitId ? 'selected' : ''}>${esc(h.title)}</option>`).join('')}</select></div>
   <label>כמה צריך להגיע? (היעד)</label><input name="target" type="number" min="1" step="any" required value="${g.target}">
   <label>יחידה (ק"מ, פעמים, ימים...)</label><input name="unit" value="${esc(g.unit)}">
   <label>תאריך התחלה</label><input type="date" name="start" required value="${g.start}">
   <label>תאריך יעד (אופציונלי)</label><input type="date" name="deadline" value="${g.deadline || ''}">
   <label>קישור לחזון (אופציונלי)</label><select name="visionId">${visionOpts(g.visionId)}</select>
   <label>🎁 התגמול כשאשיג את היעד</label><input name="reward" value="${esc(g.reward)}" placeholder="למשל: ארוחה במסעדה, ציוד חדש">
   <div class="actions">${id ? '<button type="button" class="btn danger" data-act="delGoal" data-id="' + id + '">מחק</button>' : ''}<button type="button" class="btn ghost" data-act="close">ביטול</button><button class="btn">שמור</button></div></form>`);
  const f = $('#f'), sync = () => { const h = f.type.value === 'habit'; $('#habitSel').hidden = !h; f.habitId.required = h; };
  f.type.onchange = sync; sync();
  f.onsubmit = e => {
    e.preventDefault(); const d = new FormData(f), habit = d.get('type') === 'habit';
    const obj = { title: d.get('title').trim(), type: d.get('type'), habitId: habit ? d.get('habitId') : '', target: +d.get('target'), unit: d.get('unit').trim() || (habit ? 'ימים' : ''), start: d.get('start'), deadline: d.get('deadline') || '', visionId: d.get('visionId') || '', reward: d.get('reward').trim() };
    if (id) Object.assign(g, obj); else D().goals.push({ id: uid(), entries: [], claimed: false, ...obj });
    Store.save(); closeSheet(); render();
  };
}
function goalProgressSheet(id) {
  const g = D().goals.find(x => x.id === id), s = goalState(g);
  sheet(`<h1>${esc(g.title)}</h1><p class="sub">${s.p}/${s.target} ${esc(g.unit || '')} · ${s.pct}%</p>
   <form id="f" class="row"><input name="amt" type="number" step="any" value="1" required><input type="date" name="date" value="${TODAY()}" style="width:auto"><button class="btn">הוסף</button></form>
   ${(g.entries || []).slice().reverse().slice(0, 8).map(e => `<div class="row" style="margin-top:8px"><div class="grow">${shortDate(e.date)} · +${e.amt} ${esc(g.unit || '')}</div><button class="iconbtn" data-act="goalEntryDel" data-id="${g.id}" data-eid="${e.id}">✕</button></div>`).join('')}
   <div class="actions"><button type="button" class="btn ghost" data-act="close">סגור</button></div>`);
  $('#f').onsubmit = e => {
    e.preventDefault(); const d = new FormData(e.target);
    const was = goalState(g).achieved;
    (g.entries = g.entries || []).push({ id: uid(), date: d.get('date'), amt: +d.get('amt') });
    Store.save(); render(); goalProgressSheet(id);
    if (!was && goalState(g).achieved) celebrate();
  };
}
function listForm() {
  sheet(`<h1>רשימה חדשה</h1><form id="f"><label>שם הרשימה</label><input name="title" required autofocus>
   <div class="actions"><button type="button" class="btn ghost" data-act="close">ביטול</button><button class="btn">צור</button></div></form>`);
  $('#f').onsubmit = e => {
    e.preventDefault(); const l = { id: uid(), title: new FormData(e.target).get('title').trim(), items: [] };
    D().lists.push(l); Store.save(); closeSheet(); state.openList = l.id; render();
  };
}

/* ---------- Daily "ארגון": date undated/overdue tasks and verify tomorrow's schedule ---------- */
const DAY_CAP = 120; // minutes of tasks per day before a day is flagged as overloaded
const orgDone = d => !!(D().org && D().org[d]);
const dayLoad = d => tasksOn(d).filter(t => !t.done).reduce((s, t) => s + (t.mins || 0), 0);
const Org = { ids: [], orig: {} };
function orgCard() {
  const T = TODAY(), undated = D().tasks.filter(t => !t.date && !t.done && !t.parked).length, late = overdue().length, tm = addDays(T, 1), n = tasksOn(tm).length;
  const done = orgDone(T);
  return `<div class="card row org ${done ? 'done' : ''}" data-act="orgOpen"><button class="check ${done ? 'on' : ''}" data-act="orgOpen" aria-label="ארגון">${done ? '✓' : ''}</button>
    <div class="grow"><div class="t">🗂 ארגון</div><div class="meta"><span>${undated} ללא תאריך</span><span>${late} באיחור</span><span>מחר: ${n} פעולות · ${dayLoad(tm)} ד׳</span></div></div></div>`;
}
function classify(t) { t.parked = false; if (t.inbox) { t.inbox = false; if (!t.energy) t.energy = 3; if (!t.mins) t.mins = 15; } } // a captured thought becomes a normal task once dated
function orgOpen() {
  const late = overdue(), undated = D().tasks.filter(t => !t.date && !t.done && !t.parked);
  Org.ids = [...late, ...undated].map(t => t.id); Org.orig = Object.fromEntries([...late, ...undated].map(t => [t.id, t.date]));
  orgStep1();
}
function orgStep1() {
  const T = TODAY(), old = $('#sheet .panel'), st = old ? old.scrollTop : 0;
  const rows = Org.ids.map(findTask).filter(Boolean);
  const opts = [['היום', T], ['מחר', addDays(T, 1)], ['מחרתיים', addDays(T, 2)], ['בעוד 3 ימים', addDays(T, 3)], ['בעוד שבוע', addDays(T, 7)]];
  const left = rows.filter(t => (!t.date && !t.parked) || (t.date && t.date < T)).length;
  sheet(`<h1>🗂 ארגון · שלב 1 מתוך 2</h1><p class="sub">יום חדש, מתחילים מחדש. לכל פעולה שנשארה: להשאיר להיום, לדחות לתאריך אחר, או להעביר למאגר. שום דבר לא עובר אוטומטית. ${rows.length ? `נותרו ${left} לתארוך.` : ''}</p>
   ${rows.length ? `<div class="actions" style="margin:0 0 10px"><button class="btn ghost" data-act="orgSuggest">✨ הצע לי חלוקה לפי העומס</button></div>` : ''}
   ${rows.map(t => `<div class="bulkrow ${(!t.date && !t.parked) || (t.date && t.date < T) ? 'miss' : ''}"><div class="t"><b>${esc(t.title)}</b></div>
     <div class="meta">${Org.orig[t.id] ? `<span style="color:var(--danger)">היה ב-${shortDate(Org.orig[t.id])}</span>` : t.parked ? '<span>📦 במאגר</span>' : t.inbox ? '<span>📥 נקלט</span>' : '<span>ללא תאריך</span>'}</div>
     <div class="opt" style="margin-top:8px">${opts.map(([l, v]) => `<button class="${t.date === v ? 'on' : ''}" data-act="orgSet" data-id="${t.id}" data-d="${v}">${l}</button>`).join('')}<button class="${t.parked ? 'on' : ''}" data-act="orgPark" data-id="${t.id}">📦 למאגר</button><input type="date" style="width:auto" data-orgdate="${t.id}" value="${t.date && !opts.some(o => o[1] === t.date) ? t.date : ''}"></div></div>`).join('') || '<div class="empty">🎉 אין פעולות ללא תאריך או באיחור</div>'}
   <div class="actions"><button class="btn ghost" data-act="close">סגור</button><button class="btn" data-act="orgNext">המשך ללו"ז של מחר</button></div>`);
  $('#sheet .panel').scrollTop = st;
}
function orgSuggest() {
  const T = TODAY(), load = {}, get = d => (d in load ? load[d] : (load[d] = dayLoad(d)));
  const items = Org.ids.map(findTask).filter(t => t && !t.parked && (!t.date || t.date < T)).sort((a, b) => (b.energy || 0) - (a.energy || 0) || b.priority - a.priority);
  for (const t of items) {
    const first = t.date ? 0 : 1, m = t.mins || 15; // overdue may start today, undated start tomorrow
    let best = null;
    for (let i = first; i < first + 14 && !best; i++) { const d = addDays(T, i); if (get(d) + m <= DAY_CAP) best = d; }
    if (!best) { let min = Infinity; for (let i = first; i < first + 14; i++) { const d = addDays(T, i); if (get(d) < min) { min = get(d); best = d; } } }
    deferTo(t, best); load[best] = get(best) + m;
  }
  Store.save(); render(); orgStep1();
}
function orgStep2() {
  const T = TODAY(), tm = addDays(T, 1), ts = tasksOn(tm), load = dayLoad(tm), old = $('#sheet .panel'), st = old ? old.scrollTop : 0;
  const warns = [];
  if (!ts.length) warns.push('אין פעולות למחר. כדאי להוסיף לפחות פעולה חשובה אחת.');
  if (load > DAY_CAP) warns.push(`מחר עמוס: ${load} דקות (מעל ${DAY_CAP}). כדאי להעביר משהו ליום אחר.`);
  const noEn = ts.filter(t => !t.energy).length; if (noEn) warns.push(noEn === 1 ? 'פעולה אחת בלי דירוג אנרגיה.' : `${noEn} פעולות בלי דירוג אנרגיה.`);
  const longs = ts.filter(t => (t.mins || 0) > 15 && !(t.subs && t.subs.length)).length; if (longs) warns.push(longs === 1 ? 'פעולה אחת ארוכה מ-15 דקות בלי פיצול לתתי-פעולות.' : `${longs} פעולות ארוכות מ-15 דקות בלי פיצול לתתי-פעולות.`);
  if (!D().rhythm.some(r => r.kind === 'rest')) warns.push('לא הוגדרה מנוחה יומית. כדאי להגדיר ב"מקצב היום".');
  const unclear = ts.filter(t => clarity(t.title).length).length; if (unclear) warns.push(unclear === 1 ? 'פעולה אחת בניסוח לא ברור.' : `${unclear} פעולות בניסוח לא ברור.`);
  const first = ts.find(t => !t.done);
  const mv = [['מחרתיים', addDays(T, 2)], ['בעוד 3 ימים', addDays(T, 3)], ['ללא תאריך', 'none']];
  sheet(`<h1>🗂 ארגון · שלב 2 מתוך 2</h1><p class="sub">הלו"ז של מחר, ${longDate(tm)}</p>
   <div class="card" style="background:var(--soft)"><b>${ts.length} פעולות · ${load} דקות</b>${first ? `<div class="sub">הפעולה הראשונה: ${esc(first.title)}${first.energy ? ' ' + stars(first.energy) : ''}. פעולות עם אנרגיה גבוהה תמיד בהתחלה.</div>` : ''}</div>
   ${warns.length ? warns.map(w => `<div class="clarity"><div class="w">⚠ ${esc(w)}</div></div>`).join('') : '<div class="clarity"><div class="ok">✓ הלו"ז של מחר נראה מאוזן וברור.</div></div>'}
   ${ts.map(t => { const cl = clarity(t.title); return `<div class="bulkrow"><div class="t"><b>${esc(t.title)}</b></div>
     <div class="meta">${t.energy ? `<span style="color:var(--accent)">${stars(t.energy)}</span>` : '<span>בלי אנרגיה</span>'}${cl.length ? '<span style="color:var(--warn-ink)">⚠ ניסוח לא ברור</span>' : ''}</div>
     <div class="opt" style="margin-top:8px"><span class="sub">להעביר ל:</span>${mv.map(([l, v]) => `<button data-act="orgMove" data-id="${t.id}" data-d="${v}">${l}</button>`).join('')}</div></div>`; }).join('')}
   <div class="actions"><button class="btn ghost" data-act="orgAddTomorrow">＋ פעולה למחר</button></div>
   <div class="actions"><button class="btn ghost" data-act="orgBack">חזרה</button><button class="btn" data-act="orgFinish">✅ סיימתי ארגון</button></div>`);
  $('#sheet .panel').scrollTop = st;
}

/* ---------- Clarity gate: a task is only entered after the user confirms "זה ברור" ---------- */
const VAGUE_VERBS = ['לקדם', 'לטפל', 'לסדר', 'לעבוד על', 'לחשוב על', 'להתכונן', 'לשפר', 'לנסות', 'לדאוג', 'לנהל', 'לארגן', 'ללמוד', 'להמשיך', 'לעשות', 'להתעסק'];
const SELF_CARE = ['להתקלח', 'להתגלח', 'להתלבש', 'לכבס', 'להתפלל', 'לבשל', 'לנקות']; // one-word everyday actions that are already concrete
const NOT_VERBS = ['לקוח', 'לקוחות', 'לוח', 'לוחות', 'לילה', 'לחם', 'לימוד', 'לימודים', 'לחץ', 'לבוש', 'לבד', 'לאט', 'לעת', 'לפני', 'לאחר', 'לגבי', 'לבית', 'לעבודה']; // nouns/prepositions that start with ל
const looksLikeVerb = w => /^ל[א-ת]{3,}$/.test(w || '') && !NOT_VERBS.includes(w); // a Hebrew infinitive: ל + 3 letters or more
const VAGUE_WORDS = ['פרויקט', 'עניינים', 'דברים', 'משהו', 'הכל', 'כללי', 'וכו'];
const CONCRETE_VERBS = ['לכתוב', 'לשלוח', 'להתקשר', 'לפתוח', 'לשלם', 'לקנות', 'להזמין', 'לצלם', 'לערוך', 'להעלות', 'לחתום', 'לתאם', 'לקרוא', 'לצפות', 'לפרסם', 'להדפיס', 'לסרוק', 'למלא', 'להוריד', 'להעביר', 'לענות', 'להגיש', 'לבנות', 'לשרטט', 'להקליט', 'לקבוע', 'לרשום', 'לבדוק', 'לחפש', 'להכין', 'לנקות', 'לפנות', 'לשטוף', 'לקפל', 'להוציא', 'להכניס', 'לבחור', 'לסכם', 'לתרגל', 'לצלצל', 'להגדיר', 'ללכת', 'לרוץ', 'לצאת', 'לשתות', 'לאכול', 'לעשות', 'להתאמן', 'למתוח', 'לנשום', 'לשבת', 'לקום', 'לעלות', 'לרדת', 'לבשל', 'לכבס', 'לשטוף', 'לגהץ', 'להתקלח', 'לישון', 'לטעון', 'לחבר', 'לתלות'];
// Advisory only: the user always decides by ticking "זה ברור". Returns a list of problems (empty = looks clear).
function clarity(title) {
  const t = title.trim().replace(/\s+/g, ' '), words = t.split(' ').filter(Boolean), issues = [];
  if (!t) return issues;
  const hasNum = /\d/.test(t);
  if (words.length < 3 && !(words.length === 1 && SELF_CARE.includes(words[0]))) issues.push('קצר מדי. הוסף מה בדיוק, למי או כמה.');
  const vv = VAGUE_VERBS.find(v => t === v || t.startsWith(v + ' '));
  if (vv && !hasNum) issues.push(`"${vv}" הוא פועל מעורפל. כתוב את הפעולה הבאה המדויקת, למשל לכתוב, לשלוח, להתקשר או לפתוח.`);
  const vw = VAGUE_WORDS.find(w => t.includes(w));
  if (vw) issues.push(`"${vw}" היא מילה כללית. פרט למה הכוונה.`);
  if (!vv && !CONCRETE_VERBS.some(v => t.startsWith(v)) && !looksLikeVerb(words[0])) issues.push('לא זיהיתי פועל פעולה מוחשי בתחילת הפעולה. התחל בפועל כמו "לכתוב", "לשלוח" או "להתקשר".');
  if (words.length > 14) issues.push('ארוכה מאוד. אולי אלה כמה פעולות? פצל אותן.');
  return issues;
}
const ROUTINE = { 'מקלחת': 'להתקלח', 'מקלחת בוקר': 'להתקלח', 'הליכה': 'ללכת 15 דקות', 'ריצה': 'לרוץ 20 דקות', 'אימון': 'להתאמן 20 דקות', 'כושר': 'ללכת לחדר כושר', 'שינה': 'ללכת לישון', 'שנץ': 'לישון שנץ של 20 דקות', 'שנצ': 'לישון שנץ של 20 דקות', 'כביסה': 'לכבס', 'קניות': 'לקנות מצרכים', 'ניקיון': 'לנקות את הבית', 'בישול': 'לבשל ארוחת ערב', 'ארוחה': 'לאכול ארוחה', 'ארוחת צהריים': 'לאכול ארוחת צהריים', 'ארוחת בוקר': 'לאכול ארוחת בוקר', 'ארוחת ערב': 'לאכול ארוחת ערב', 'קפה': 'לשתות קפה', 'תפילה': 'להתפלל', 'מדיטציה': 'לעשות מדיטציה 10 דקות', 'קריאה': 'לקרוא 10 עמודים', 'כתיבה': 'לכתוב 10 דקות', 'מייל': 'לכתוב מייל אחד', 'מיילים': 'לענות על 5 מיילים', 'שיחה': 'להתקשר לשיחה אחת', 'פגישה': 'להגיע לפגישה', 'חשבונית': 'לשלוח חשבונית', 'חשבוניות': 'לשלוח חשבונית אחת', 'ספורט': 'לעשות ספורט 20 דקות', 'פושאפס': 'לעשות 20 שכיבות סמיכה' };
const suggestFix = title => { const t = title.trim().replace(/[\s"'׳״.]+/g, ' ').trim(); return ROUTINE[t] || ROUTINE[t.replace(/"/g, '')] || ''; };
function clarityHTML(title, withFix) {
  const fix = withFix ? suggestFix(title) : '';
  if (fix) return '<div class="w">⚠ קצר מדי. פעולה צריכה להתחיל בפועל.</div><button type="button" class="lnk" data-act="useSuggest" data-s="' + esc(fix) + '">✏️ להחליף ל: "' + esc(fix) + '"</button>';
  if (!title.trim()) return '<div class="sub">כתוב את הפעולה הבאה, בצורה שאפשר להתחיל מיד.</div>';
  const issues = clarity(title);
  return issues.length ? issues.map(x => `<div class="w">⚠ ${esc(x)}</div>`).join('') + (withFix ? '<button type="button" class="btn ghost okbtn" data-act="clearOk">✓ זה בסדר</button>' : '') : '<div class="ok">✓ נראית ברורה: יש פועל מוחשי ופעולה מוגדרת.</div>';
}
const CLARITY_EX = `<details class="clex"><summary>דוגמאות: מפעולה מעורפלת לפעולה הבאה</summary><table>
  <tr><th>מעורפלת</th><th>הפעולה הבאה</th></tr>
  <tr><td>לקדם את Giftimonials</td><td>לכתוב 3 בעיות שהמוצר פותר</td></tr>
  <tr><td>ללמוד כלי AI</td><td>לצפות בהדרכה אחת ולנסות דוגמה</td></tr>
  <tr><td>לטפל בקמפיין</td><td>לבדוק אילו מודעות דורשות שינוי</td></tr>
  <tr><td>לסדר את הבית</td><td>לפנות את שולחן העבודה במשך 10 דקות</td></tr></table></details>`;
const clrOk = (title, confirmed) => confirmed || !clarity(title).length; // clear wording passes; unclear needs the user's confirmation
const CLEAR_LABEL ='אני יודע מה בדיוק הפעולה הראשונה ואיך אדע שסיימתי';

/* ---------- Task menu, move, subtasks ---------- */
const findTask = id => D().tasks.find(x => x.id === id);
function menuSheet(id) {
  const t = findTask(id); if (!t) return closeSheet();
  const v = t.visionId ? visionName(t.visionId) : '';
  sheet(`<h1>${esc(t.title)}</h1>
   <div class="meta" style="margin-bottom:10px">${t.brainless ? '<span class="chip" style="background:var(--warn-bg);color:var(--warn-ink)">⚡ Brainless</span>' : ''}${t.date ? `<span>${longDate(t.date)}</span>` : '<span>ללא תאריך</span>'}${projectChip(t)}${v ? `<span class="chip">${esc(v)}</span>` : ''}</div>
   ${t.notes ? `<p class="sub" style="white-space:pre-wrap">${esc(t.notes)}</p>` : ''}
   ${(t.subs || []).length ? `<div class="sub" style="margin:8px 0 4px">☰ תתי-פעולות (${subProg(t)})</div><div class="subs">${t.subs.map(x => `<div class="row ${x.done ? 'done' : ''}"><button class="check ${x.done ? 'on' : ''}" data-act="subToggle" data-id="${t.id}" data-sid="${x.id}">${x.done ? '✓' : ''}</button><div class="t grow">${esc(x.title)}</div></div>`).join('')}</div>` : ''}
   ${t.done ? '' : '<div class="sub" style="margin:8px 0 4px">🧭 עדיפות</div>' + quadChips(t.id, t.quad || '', '') + '<div class="sub" style="margin:8px 0 2px">💗 כמה בא לי?</div>' + wantStars(t.id, t.want || 0, '')}
   <div class="grid2">
     ${t.done ? '' : `<button class="btn" data-act="runStart" data-id="${t.id}">◀ התחל עכשיו</button>`}
     <button class="btn ghost" data-act="menuDone" data-id="${t.id}">${t.done ? '↺ בטל ביצוע' : '✓ בוצע'}</button>
     <button class="btn ghost" data-act="moveSheet" data-id="${t.id}">📆 העבר</button>
     ${t.done || !t.date ? '' : `<button class="btn ghost" data-act="toPool" data-id="${t.id}">↩ החזר לכל הפעולות</button>`}
     <button class="btn ghost" data-act="editTask" data-id="${t.id}">✏️ ערוך</button>
   </div>
   <div class="actions"><button class="btn ghost" data-act="close">סגור</button></div>`);
}
function moveSheet(id) {
  const t = findTask(id), T = TODAY();
  const opts = [['היום', T], ['מחר', addDays(T, 1)], ['מחרתיים', addDays(T, 2)], ['בעוד שבוע', addDays(T, 7)], ['ללא תאריך', 'none']];
  sheet(`<h1>להעביר ל...</h1><p class="sub">${esc(t.title)}</p>
   <div class="opt">${opts.map(([l, v]) => `<button data-act="moveTo" data-id="${id}" data-d="${v}">${l}${v !== 'none' ? ' · ' + shortDate(v) : ''}</button>`).join('')}</div>
   <label>או בחר תאריך</label><div class="row"><input type="date" id="moveDate" value="${t.date || ''}"><button class="btn" data-act="moveCustom" data-id="${id}">קבע</button></div>
   <div class="actions"><button class="btn ghost" data-act="close">ביטול</button></div>`);
}

/* ---------- Tasks must be <= 15 min: offer to split longer ones ---------- */
let splitCtx = null;
// Splitting keeps the task as the parent (with its total minutes) and creates clearly named subtasks of <= 15 min each.
function splitNameSheet(t, next, forceN) {
  const n = forceN || Math.ceil(t.mins / 15), each = forceN ? Math.min(15, Math.ceil((t.mins || 15) / n)) : Math.ceil(t.mins / n);
  sheet(`<h1>שמות לפעולות</h1>
   <p>"${esc(t.title)}" תפוצל ל-${n} פעולות של כ-${each} דקות. תן לכל פעולה שם ברור, שיגיד מה בדיוק עושים בה.</p>
   <form id="f">${Array.from({ length: n }, (_, i) => `<label>פעולה ${i + 1} (${each} ד׳)</label><input name="s${i}" required autocomplete="off" placeholder="מה עושים בפעולה הזאת?" ${i === 0 ? 'autofocus' : ''}>`).join('')}
   <div id="splitMsg" class="sub" style="color:var(--danger);margin-top:8px"></div>
   <div class="actions"><button type="button" class="btn ghost" data-act="keepLong">להשאיר כמו שהיא</button><button class="btn">שמור</button></div></form>`);
  $('#f').onsubmit = e => {
    e.preventDefault(); const f = new FormData(e.target);
    const names = Array.from({ length: n }, (_, i) => f.get('s' + i).trim());
    if (names.some(x => !x) || new Set(names.map(x => x.toLowerCase())).size !== names.length) { $('#splitMsg').textContent = 'לכל פעולה צריך שם ברור, וכל השמות צריכים להיות שונים.'; return; }
    t.title = names[0]; t.mins = each; t.subs = [];
    names.slice(1).forEach(title => D().tasks.push({ ...t, id: uid(), title, mins: each, done: false, spawned: '' }));
    next();
  };
}
function resolveLong(list) {
  const q = list.filter(t => (t.mins || 0) > 15);
  const next = () => {
    const t = q.shift();
    if (!t) { Store.save(); closeSheet(); render(); return; }
    const n = Math.ceil(t.mins / 15);
    splitCtx = { t, next };
    sheet(`<h1>פעולה ארוכה</h1><p>"${esc(t.title)}" נמשכת ${t.mins} דקות, ופעולה צריכה להיות עד 15 דקות. לפצל ל-${n} פעולות של כ-${Math.ceil(t.mins / n)} דקות? אבקש ממך לתת שם ברור לכל אחת.</p>
     <div class="actions"><button class="btn ghost" data-act="keepLong">להשאיר כמו שהיא</button><button class="btn" data-act="doSplit">לפצל ל-${n}</button></div>`);
  };
  next();
}

/* ---------- Bulk entry ---------- */
let bulk = [], bulkProject = '';
function assignSheet(pid) {
  const p = D().projects.find(x => x.id === pid), cand = D().tasks.filter(t => !t.done && t.projectId !== pid);
  sheet(`<h1>שיוך פעולות ל-${esc(p.title)}</h1><form id="f">
   ${cand.map(t => `<label class="row" style="color:var(--ink);margin:8px 0"><input type="checkbox" name="t" value="${t.id}" style="width:auto"><span class="grow">${esc(t.title)}${t.projectId && projectName(t.projectId) ? ` <span class="sub">(כרגע ב-${esc(projectName(t.projectId))})</span>` : ''}</span></label>`).join('') || '<div class="empty">אין פעולות פתוחות לשייך</div>'}
   <div class="actions"><button type="button" class="btn ghost" data-act="close">ביטול</button><button class="btn">שייך</button></div></form>`);
  $('#f').onsubmit = e => {
    e.preventDefault(); new FormData(e.target).getAll('t').forEach(id => { const t = findTask(id); if (t) t.projectId = pid; });
    Store.save(); closeSheet(); render();
  };
}
const bulkDateOpts = () => { const T = TODAY(); return [['היום', T], ['מחר', addDays(T, 1)], ['מחרתיים', addDays(T, 2)], ['ללא', null]]; };
function bulkStart(project) {
  bulkProject = project || '';
  sheet(`<h1>הזנת פעולות בבת אחת</h1><p class="sub">פעולה בכל שורה. בשלב הבא אשאל אותך מתי לשלב כל אחת וכמה אנרגיה היא דורשת.</p>
   <div class="card" style="background:var(--soft)"><b>רשימה בכתב יד?</b>
    <div class="sub" style="margin:4px 0 8px">1. העתק את ההנחיה. 2. בצ'אט של Claude בטלפון הדבק אותה וצרף צילום של הרשימה. 3. העתק את התשובה וחזור לכאן.</div>
    <div class="opt"><button data-act="copyPrompt">📋 העתק הנחיה ל-Claude</button><button data-act="pasteClip">📥 הדבק מהלוח</button></div>
    <div id="clipMsg" class="sub" style="margin-top:6px"></div></div>
   <textarea id="bulkText" style="min-height:180px" placeholder="לשלוח מייל ללקוח&#10;להתקשר לרואה חשבון&#10;..."></textarea>
   <div class="actions"><button class="btn ghost" data-act="close">ביטול</button><button class="btn" data-act="bulkNext">המשך</button></div>`);
  setTimeout(() => $('#bulkText') && $('#bulkText').focus(), 50);
}
function bulkRender(showMiss) {
  const dopts = bulkDateOpts(), old = $('#sheet .panel'), st = old ? old.scrollTop : 0;
  sheet(`<h1>מתי ובאיזו אנרגיה?</h1>
   <p class="sub">${bulk.length} פעולות. פעולות עם אנרגיה גבוהה יופיעו תמיד בתחילת היום.</p>
   <label>פרויקט לכל הפעולות (אופציונלי)</label><select data-bulkproj="1">${projectOpts(bulkProject)}</select>
   <div class="sub">קבע תאריך לכולן:</div><div class="opt" style="margin:6px 0 12px">${dopts.map(([l], j) => `<button data-act="bulkAllDate" data-j="${j}">${l}</button>`).join('')}</div>
   ${bulk.map((b, i) => `<div class="bulkrow ${showMiss && (b.date === undefined || !b.energy || !clrOk(b.title, b.clear) || !b.title.trim()) ? 'miss' : ''}">
     <input data-bulktitle="${i}" value="${esc(b.title)}" style="font-weight:700" autocomplete="off">
     <div class="clarity" id="cl${i}">${clarityHTML(b.title)}</div>
     <button class="clearbtn ${b.clear ? 'on' : ''}" ${clarity(b.title).length ? '' : 'hidden'} data-act="bulkClear" data-i="${i}">${b.clear ? '✅ זה ברור' : '☐ זה ברור: ' + CLEAR_LABEL}</button>
     <label>מתי?</label><div class="opt">${dopts.map(([l, v], j) => `<button class="${b.date === v ? 'on' : ''}" data-act="bulkDate" data-i="${i}" data-j="${j}">${l}</button>`).join('')}<input type="date" style="width:auto" data-bulkdate="${i}" value="${b.date && !dopts.some(o => o[1] === b.date) ? b.date : ''}"></div>
     <label>אנרגיה</label><div class="stars">${[1, 2, 3, 4, 5].map(n => `<button type="button" class="${n <= b.energy ? 'on' : ''}" data-act="bulkStar" data-i="${i}" data-n="${n}">★</button>`).join('')}</div>
     <label>משך (דקות)</label><div class="opt">${[5, 10, 15, 20, 30, 45, 60].map(m => `<button class="${b.mins === m ? 'on' : ''}" data-act="bulkMins" data-i="${i}" data-m="${m}">${m}</button>`).join('')}</div>
     <div class="opt" style="margin-top:8px"><button class="${b.brainless ? 'on' : ''}" data-act="bulkBrain" data-i="${i}">⚡ Brainless (פשוטה, אפשר להעיף ברגע)</button></div></div>`).join('')}
   ${bulk.length ? CLARITY_EX : ''}
   ${showMiss ? '<div class="sub" style="color:var(--danger)">חסר תאריך, אנרגיה או אישור "זה ברור" בשורות המסומנות.</div>' : ''}
   <div class="actions"><button class="btn ghost" data-act="close">ביטול</button><button class="btn" data-act="bulkSave">הוסף ${bulk.length} פעולות</button></div>`);
  $('#sheet .panel').scrollTop = st;
}

const authErr = m => /not allowed|disabled/i.test(m) ? 'ההרשמה סגורה בפרויקט הזה. אם כבר יש לך חשבון (למשל מ-FitMe), היכנס עם אותו אימייל וסיסמה בכפתור "כניסה".' : /invalid login/i.test(m) ? 'אימייל או סיסמה שגויים. אם נרשמת ב-FitMe, השתמש באותה סיסמה.' : /already|registered/i.test(m) ? 'כבר קיים חשבון עם האימייל הזה. היכנס בכפתור "כניסה".' : /confirm/i.test(m) ? 'צריך לאשר את האימייל לפני הכניסה.' : m;
function accountSheet() {
  if (DEMO) { sheet(`<h1>מצב דמו</h1><p class="sub">זו גרסת הדגמה עם נתונים בדויים. אין כאן כניסה או סנכרון, והנתונים נשמרים רק בדפדפן הזה.</p><div class="actions"><button class="btn ghost" data-act="close">סגור</button></div>`); return; }
  if (!Cloud.sb) { sheet(`<h1>סנכרון</h1><p class="sub">לא ניתן לטעון את שירות הענן (בדוק חיבור לאינטרנט). הנתונים נשמרים בינתיים בטלפון.</p><div class="actions"><button class="btn ghost" data-act="close">סגור</button></div>`); return; }
  if (Cloud.user) {
    const st = { ok: 'מסונכרן ✓', syncing: 'מסנכרן...', error: 'שגיאת סנכרון', offline: '' }[Cloud.status];
    sheet(`<h1>החשבון שלי</h1><p>${esc(Cloud.user.email)}</p><p class="sub">${st}</p>
      <div class="actions"><button class="btn ghost" data-act="syncNow">סנכרן עכשיו</button><button class="btn danger" data-act="logout">התנתק</button></div>
      <div class="actions"><button class="btn ghost" data-act="close">סגור</button></div>`);
    return;
  }
  sheet(`<div class="brand" style="margin-bottom:6px">${logoMark(40)}<h1>כניסה וסנכרון</h1></div><p class="sub">התחבר כדי לשמור את הנתונים בענן ולראות אותם בכל המכשירים.</p>
    <form id="f"><label>אימייל</label><input name="email" type="email" required autocomplete="email">
     <label>סיסמה (לפחות 8 תווים)</label><input name="password" type="password" required minlength="8" autocomplete="current-password">
     <div id="authMsg" class="sub" style="color:var(--danger);margin-top:8px"></div>
     <div class="actions"><button type="button" class="btn ghost" data-act="signup">הרשמה</button><button class="btn">כניסה</button></div>
     <div class="actions"><button type="button" class="btn ghost" data-act="close">המשך בלי ענן</button></div></form>`);
  $('#f').onsubmit = async e => {
    e.preventDefault(); const f = new FormData(e.target);
    const { error } = await Cloud.sb.auth.signInWithPassword({ email: f.get('email'), password: f.get('password') });
    if (error) $('#authMsg').textContent = authErr(error.message); else closeSheet();
  };
}

/* ---------- Print ---------- */
const pTitle = t => { const n = t.projectId && projectName(t.projectId); return (n ? '⁧' + n + '⁩: ' : '') + t.title; };
function printHTML(html) {
  $('#print').innerHTML = html;
  setTimeout(() => window.print(), 50);
}
const pRow = (txt, sm) => `<div class="pl ${sm ? 'sm' : ''}"><span class="box"></span><span>${esc(txt)}</span></div>`;
// all=true: every task of the day (including completed, marked ✓), ignoring the "print" flag.
// all=false: unfinished tasks only, narrowed to the ones flagged for printing if any are flagged.
function printDayCore(all) {
  const d = state.date;
  let ts = tasksOn(d);
  if (!all) {
    ts = ts.filter(t => !t.done);
    const flagged = ts.filter(t => t.print);
    if (flagged.length) ts = flagged;
  }
  const orgRow = d === TODAY() && (all || !orgDone(d)) ? pRow('🗂 ארגון: לתארך פעולות ולוודא את הלו"ז של מחר') : '';
  const L = d === TODAY() ? (D().dayLog[dayKey()] || {}) : (D().dayLog[d] || {});
  const hours = L.start ? `<div class="pl sm">🕗 התחלת ב-${L.start}${L.end ? ` · סיימת ב-${L.end} · משך ${fmtDur(dayDurMin(L))}` : ''}</div>` : '';
  printHTML(`<h1>${longDate(d)}</h1>${hours}<h2>פעולות</h2>${orgRow}${ts.map(t => '<div>' + pRow((t.done ? '✓ ' : '') + (t.priority == 2 ? '‼ ' : t.priority == 1 ? '! ' : '') + pTitle(t)) + (t.subs || []).filter(s => all || !s.done).map(s => `<div style="margin-inline-start:26px">${pRow(s.title, true)}</div>`).join('') + '</div>').join('') || '<div class="pl">—</div>'}
   <h2>הרגלים</h2>${habitsOn(d).map(h => pRow(h.title)).join('') || '<div class="pl">—</div>'}
   <h2>הערות</h2><div class="lines">${'<div></div>'.repeat(8)}</div>`);
}
function printWeek() {
  const ws = weekStart(state.date);
  printHTML(`<h1>שבוע ${shortDate(ws)} – ${shortDate(addDays(ws, 6))}</h1><div class="wk">${Array.from({ length: 7 }, (_, i) => {
    const s = addDays(ws, i);
    return `<div class="wd"><b>יום ${DAYN[i]} · ${shortDate(s)}</b>${tasksOn(s).map(t => pRow(pTitle(t), true)).join('')}${habitsOn(s).map(h => pRow('🔁 ' + h.title, true)).join('')}</div>`;
  }).join('')}</div>`);
}
function printSel() {
  const ts = D().tasks.filter(t => t.print && !t.done);
  printHTML(`<h1>פעולות להדפסה</h1>${ts.map(t => pRow(pTitle(t) + (t.date ? ' (' + shortDate(t.date) + ')' : ''))).join('') || '<div class="pl">אין פעולות מסומנות להדפסה</div>'}`);
}

/* ---------- Events ---------- */
const A = {
  toggleTask: e => {
    const t = D().tasks.find(x => x.id === e.id); t.done = !t.done; t.doneAt = t.done ? TODAY() : '';
    if (t.repeat) {
      if (t.done && !t.spawned) { const n = { ...t, id: uid(), done: false, date: nextRepeatDate(t), spawned: '', subs: (t.subs || []).map(x => ({ ...x, id: uid(), done: false })) }; D().tasks.push(n); t.spawned = n.id; }
      else if (!t.done && t.spawned) { const n = D().tasks.find(x => x.id === t.spawned); if (n && !n.done) D().tasks = D().tasks.filter(x => x !== n); t.spawned = ''; }
    }
    Store.save(); state.pop = { id: e.id }; render();
    if (t.done && t.date === TODAY()) afterDone(t);
    if (t.done && t.date) { const day = D().tasks.filter(x => x.date === t.date); if (day.length >= 2 && day.every(x => x.done)) celebrate(); }
    if (t.done && t.projectId) { const pt = D().tasks.filter(x => x.projectId === t.projectId); if (pt.length >= 2 && pt.every(x => x.done)) celebrate(); }
  },
  toggleHabit: e => { const h = D().habits.find(x => x.id === e.id); if (h.log[e.date]) delete h.log[e.date]; else h.log[e.date] = true; Store.save(); state.pop = { id: e.id, date: e.date }; render(); },
  editTask: e => taskForm(e.id), addTask: () => taskForm(),
  habToTask: e => { const h = D().habits.find(x => x.id === e.id); taskForm(undefined, TODAY(), '', { title: h.task || h.title, energy: h.energy || 3, mins: h.mins || 15, visionId: h.visionId || '', repeat: 'd1' }); },
  focusEdit: () => focusSheet(state.date),
  morningSkipAll: () => { const f = fo(TODAY()); f.visualAsked = true; f.reviewAsked = true; f.askedAt = new Date().toISOString(); Morning.active = false; Store.save(); closeSheet(); },
  focusLater: () => { focusSnooze = true; Morning.active = false; closeSheet(); },
  demoReset: () => { if (confirm('לאפס את הדמו לנתונים ההתחלתיים?')) { seedDemo(); render(); } },
  editHabit: e => habitForm(e.id), addHabit: () => habitForm(),
  editVision: e => visionForm(e.id), addVision: () => visionForm(),
  addList: () => listForm(),
  delTask: e => { if (confirm('למחוק את הפעולה?')) { D().tasks = D().tasks.filter(x => x.id !== e.id); Store.save(); closeSheet(); render(); } },
  delHabit: e => { if (confirm('למחוק את ההרגל?')) { D().habits = D().habits.filter(x => x.id !== e.id); Store.save(); closeSheet(); render(); } },
  delVision: e => { if (confirm('למחוק את פריט החזון? קישורים אליו יוסרו.')) { D().visions = D().visions.filter(x => x.id !== e.id); D().tasks.forEach(t => { if (t.visionId === e.id) t.visionId = ''; }); D().habits.forEach(h => { if (h.visionId === e.id) h.visionId = ''; }); D().goals.forEach(g => { if (g.visionId === e.id) g.visionId = ''; }); Store.save(); closeSheet(); render(); } },
  close: closeSheet,
  addTaskOn: e => taskForm(undefined, e.date || ''),
  rescheduleOverdue: () => { const o = overdue(); if (o.length && confirm(`להעביר ${o.length} פעולות באיחור להיום?`)) { o.forEach(t => { t.date = TODAY(); }); Store.save(); render(); } },
  upMore: () => { state.upDays += 14; render(); },
  toggleSubs: e => { const t = findTask(e.id); t.collapsed = !t.collapsed; Store.save(); render(); },
  upMode: e => { state.upMode = e.m; render(); },
  upPick: e => { state.upSel = e.date; render(); },
  upNav: e => {
    const n = +e.n, m = state.upMode;
    if (m === 'three') state.up3 = addDays(state.up3, 3 * n);
    else if (m === 'week') state.upWeek = addDays(state.upWeek, 7 * n);
    else if (m === 'month') { state.upMonth = shiftMonth(state.upMonth, n); state.upSel = state.upMonth === TODAY().slice(0, 7) ? TODAY() : state.upMonth + '-01'; }
    render();
  },
  upToday: () => {
    const T = TODAY(), m = state.upMode;
    if (m === 'three') state.up3 = T; else if (m === 'week') state.upWeek = weekStart(T); else if (m === 'month') { state.upMonth = T.slice(0, 7); state.upSel = T; } else state.upStart = T;
    render();
  },
  addGoal: () => goalForm(), editGoal: e => goalForm(e.id),
  goalAdd: e => goalProgressSheet(e.id),
  goalFilter: e => { state.goalFilter = e.f; render(); },
  goalClaim: e => { const g = D().goals.find(x => x.id === e.id); g.claimed = true; g.claimedAt = TODAY(); Store.save(); render(); celebrate(); },
  goalEntryDel: e => { const g = D().goals.find(x => x.id === e.id); g.entries = g.entries.filter(x => x.id !== e.eid); Store.save(); render(); goalProgressSheet(e.id); },
  delGoal: e => { if (confirm('למחוק את היעד?')) { D().goals = D().goals.filter(x => x.id !== e.id); Store.save(); closeSheet(); render(); } },
  star: e => { const n = +e.n; document.querySelectorAll('#stars button').forEach((b, i) => b.classList.toggle('on', i < n)); document.querySelector('input[name=energy]').value = n; },
  taskMenu: e => menuSheet(e.id),
  menuDone: e => { const t = findTask(e.id); t.done = !t.done; t.doneAt = t.done ? TODAY() : ''; Store.save(); closeSheet(); render(); if (t.done && t.date === TODAY()) afterDone(t); },
  moveSheet: e => moveSheet(e.id),
  moveTo: e => { const t = findTask(e.id); deferTo(t, e.d === 'none' ? null : e.d); Store.save(); closeSheet(); render(); nudgeAny([t.id]); },
  moveCustom: e => { const v = $('#moveDate').value; if (!v) return; const t = findTask(e.id); deferTo(t, v); Store.save(); closeSheet(); render(); nudgeAny([t.id]); },
  subShow: () => { const f = $('#subForm'); f.hidden = false; $('#subText').focus(); },
  subToggle: e => { const s = findTask(e.id).subs.find(x => x.id === e.sid); s.done = !s.done; Store.save(); state.pop = { id: e.id, sid: e.sid }; render(); if (!$('#sheet').hidden) menuSheet(e.id); },
  subDel: e => { const t = findTask(e.id); t.subs = t.subs.filter(x => x.id !== e.sid); Store.save(); render(); menuSheet(e.id); },
  keepLong: () => splitCtx.next(),
  doSplit: () => splitNameSheet(splitCtx.t, splitCtx.next),
  weekNav: e => { state.weekStart = addDays(state.weekStart, 7 * +e.n); render(); },
  weekToday: () => { state.weekStart = weekStart(TODAY()); render(); },
  weekOutToggle: e => { const o = weekData(state.weekStart).outcomes.find(x => x.id === e.id); o.done = !o.done; Store.save(); state.pop = { id: e.id }; render(); },
  weekOutDel: e => { const W = weekData(state.weekStart); W.outcomes = W.outcomes.filter(x => x.id !== e.id); Store.save(); render(); },
  weekVisionTog: e => { const W = weekData(state.weekStart); W.visionIds = W.visionIds.includes(e.id) ? W.visionIds.filter(x => x !== e.id) : [...W.visionIds, e.id]; Store.save(); render(); },
  openDay: e => { state.date = e.date; state.tab = 'today'; render(); window.scrollTo(0, 0); },
  printWeekVision: () => {
    const ws = state.weekStart, we = addDays(ws, 6), W = Object.assign({ vision: '', outcomes: [], visionIds: [], worked: '', improve: '' }, D().weeks[ws]);
    const wt = D().tasks.filter(t => t.date && t.date >= ws && t.date <= we && !t.done);
    printHTML(`<h1>חזון שבועי · ${shortDate(ws)} – ${shortDate(we)}</h1>
      <h2>הכיוון שלי לשבוע</h2><div style="min-height:50px;white-space:pre-wrap">${esc(W.vision) || '<div class="lines"><div></div><div></div></div>'}</div>
      <h2>תוצאות מפתח</h2>${W.outcomes.map(o => pRow((o.done ? '✓ ' : '') + o.text)).join('') || '<div class="lines"><div></div><div></div><div></div></div>'}
      ${W.visionIds.length ? `<h2>החזון הגדול</h2><div>${W.visionIds.map(id => esc(visionName(id) || '')).filter(Boolean).join(' · ')}</div>` : ''}
      <h2>פעולות פתוחות השבוע</h2>${wt.map(t => pRow(`${shortDate(t.date)} · ${t.title}${t.energy ? ' ' + stars(t.energy) : ''}`, true)).join('') || '<div class="pl">—</div>'}
      <h2>סיכום: מה עבד? מה לשפר?</h2><div class="lines">${'<div></div>'.repeat(5)}</div>`);
  },
  jShift: e => { const n = addDays(state.jDate, +e.n); if (n <= TODAY()) { state.jDate = n; render(); } },
  jToday: () => { state.jDate = TODAY(); render(); },
  jOpen: e => { state.jDate = e.d; render(); window.scrollTo(0, 0); },
  jPhotoPick: () => $('#jphoto').click(),
  jPhotoDel: () => { jSet(state.jDate).photo = ''; Store.save(); render(); },
  jWinDel: e => { const J = jSet(state.jDate); J.wins = J.wins.filter(w => w.id !== e.id); Store.save(); render(); },
  goTab: e => { state.pmIsle = null; state.tab = e.t; state.openList = null; state.openProject = null; state.openJob = null; state.pmOpen = null; state.pmReview = null; render(); window.scrollTo(0, 0); },
  addProject: () => projectForm(),
  openProject: e => { state.openProject = e.id; render(); window.scrollTo(0, 0); },
  backProjects: () => { state.openProject = null; state.openJob = null; render(); },
  projToggle: e => { const po = state.projOpen = state.projOpen || {}; po[e.id] = !(po[e.id] === undefined ? e.id === 'none' : po[e.id]); render(); },
  renameProject: e => {
    const p = D().projects.find(x => x.id === e.id); if (!p) return;
    sheet(`<h1>✏️ שם הפרויקט</h1><form id="rnForm"><input id="rnText" value="${esc(p.title)}" maxlength="80" autocomplete="off" required>
      <div class="actions"><button type="button" class="btn ghost" data-act="close">ביטול</button><button class="btn">שמור</button></div></form><button type="button" class="btn danger" style="width:100%;margin-top:10px" data-act="delProjectSheet" data-id="${p.id}">🗑 מחק את הפרויקט</button>`);
    const inp = $('#rnText'); inp.focus(); inp.select();
    $('#rnForm').onsubmit = ev => { ev.preventDefault(); const n = inp.value.trim(); if (n) { p.title = n; Store.save(); } closeSheet(); render(); };
  },
  delProjectSheet: e => { closeSheet(); A.delProject(e); },
  delProject: e => { if (confirm('למחוק את הפרויקט? הפעולות שלו יישארו, בלי פרויקט.')) { D().tasks.forEach(t => { if (t.projectId === e.id) t.projectId = ''; }); D().jobs.forEach(j => { if (j.projectId === e.id) j.projectId = ''; }); D().projects = D().projects.filter(p => p.id !== e.id); state.openProject = null; state.pmOpen = null; Store.save(); render(); } },
  pmWeekRev: () => { state.pmReview = 'week'; render(); window.scrollTo(0, 0); },
  pmMonthRev: () => { state.pmReview = 'month'; render(); window.scrollTo(0, 0); },
  pmLoad: () => pmLoadSheet(),
  pmRev: e => { const ws = weekStart(TODAY()), R = pmRevs(); R[ws] = Object.assign({}, R[ws], { [e.k]: e.v }); Store.save(); render(); },
  pmRevDone: () => { const k = state.pmReview === 'month' ? 'm' + TODAY().slice(0, 7) : weekStart(TODAY()), R = pmRevs(); R[k] = Object.assign({}, R[k], { doneAt: TODAY() }); Store.save(); state.pmReview = null; render(); window.scrollTo(0, 0); celebrate(); toast('<span>✅ הסקירה נשמרה. כל הכבוד שעצרת לחשוב</span><button data-act="toastClose" aria-label="סגור">✕</button>', 4000); },
  pmRelease: e => { const p = D().projects.find(x => x.id === e.id); if (p) { p.focusTaskId = ''; Store.save(); render(); } },
  pmSetStatus: e => { const p = D().projects.find(x => x.id === e.id); if (p) { p.status = e.s; Store.save(); render(); } },
  dzSet: e => { const a = D().assist, m = { d: 'design', t: 'dzTheme', f: 'dzFx' }[e.k]; if (!m) return; a[m] = e.v; Store.save(); render(); },
  pmView: e => { D().assist.pmView = e.v; state.pmIsle = null; Store.save(); render(); },
  pmIsle: e => {
    const w = document.getElementById('world'), b = w && w.querySelector('.isle[data-id="' + e.id + '"]'), go = () => { state.pmIsle = e.id; state.pmZoom = 'in'; render(); window.scrollTo(0, 0); };
    const h = document.documentElement.dataset;
    if (!b || h.fx === 'minimal' || matchMedia('(prefers-reduced-motion:reduce)').matches) return go();
    const r = w.getBoundingClientRect(), br = b.getBoundingClientRect();
    w.style.transformOrigin = (br.left + br.width / 2 - r.left) + 'px ' + (br.top + br.height / 2 - r.top) + 'px'; w.classList.add('zooming'); setTimeout(go, 340);
  },
  pmWorldBack: () => { state.pmIsle = null; state.pmZoom = 'out'; render(); window.scrollTo(0, 0); },
  pmNoop: () => {},
  pmOpen: e => { state.pmOpen = e.id; render(); window.scrollTo(0, 0); },
  pmBack: () => { state.pmOpen = null; state.pmReview = null; render(); window.scrollTo(0, 0); },
  pmNew: () => pmForm(),
  pmEdit: e => pmForm(e.id),
  pmStatusF: e => { state.pmStatus = e.k; render(); },
  pmHome: () => { D().assist.homeTab = D().assist.homeTab === 'map' ? '' : 'map'; Store.save(); render(); toast('<span>' + (D().assist.homeTab === 'map' ? '🏠 המפה תיפתח ראשונה בכל כניסה' : 'מסך הבית חזר להיות "היום"') + '</span><button data-act="toastClose" aria-label="סגור">✕</button>', 3500); },
  pmFocusSet: e => pmFocusSheet(e.id),
  pmWalk: () => { const ids = pmVisible().filter(p => ['focus', 'active'].includes(pmStatus(p))).map(p => p.id); if (!ids.length) return; state.pmQueue = { ids, i: 0 }; pmFocusSheet(ids[0]); },
  pmWalkSkip: () => pmWalkNext(),
  pmFocusTask: e => { const t = findTask(e.id), p = t && D().projects.find(x => x.id === t.projectId); if (!p) return; if (p.focusTaskId === t.id) { p.focusTaskId = ''; } else { p.focusTaskId = t.id; p.focusWeek = weekStart(TODAY()); } Store.save(); render(); },
  pmMile: e => { const t = findTask(e.id); if (!t) return; t.milestone = !t.milestone; Store.save(); render(); },
  pmToday: e => { const t = findTask(e.id); if (!t) return; t.date = TODAY(); classify(t); delete t.ord; Store.save(); render(); toast('<span>📥 הועברה למשימות היום: <b>' + esc(t.title) + '</b></span><button data-act="toastClose" aria-label="סגור">✕</button>', 3500); },
  pmAreasSheet: () => pmAreasSheet(),
  pmAreaAdd: () => { const n = (prompt('שם התחום החדש') || '').trim(); if (!n) return; pmSaveAreas([...pmAreas(), { id: uid(), icon: '📌', name: n }]); pmAreasSheet(); render(); },
  pmAreaEdit: e => { const L = pmAreas().map(a => ({ ...a })), a = L.find(x => x.id === e.id); if (!a) return; const n = (prompt('שם התחום', a.name) || '').trim(); if (!n) return; a.name = n; pmSaveAreas(L); pmAreasSheet(); render(); },
  pmAreaDel: e => { if (!confirm('למחוק את התחום? הפרויקטים לא יימחקו.')) return; pmSaveAreas(pmAreas().filter(a => a.id !== e.id)); if (state.pmArea === e.id) state.pmArea = ''; pmAreasSheet(); render(); },
  projAddTask: e => taskForm(undefined, null, e.id),
  newProjectForm: () => projectForm(),
  newActionForm: () => taskForm(),
  projBulk: e => bulkStart(e.id),
  projAssign: e => assignSheet(e.id),
  addHabitBulk: () => habBulkStart(),
  habBulkNext: () => {
    const lines = $('#habText').value.split('\n').map(s => s.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean);
    if (!lines.length) return;
    habBulk = lines.map(title => ({ title, task: '', days: [0, 1, 2, 3, 4, 5, 6], mins: 10, energy: 0, clear: false })); habBulkRender();
  },
  habClear: e => { const b = habBulk[+e.i]; b.clear = !b.clear; habBulkRender(); },
  habDay: e => { const b = habBulk[+e.i], d = +e.d; b.days = b.days.includes(d) ? b.days.filter(x => x !== d) : [...b.days, d].sort(); if (!b.days.length) b.days = [d]; habBulkRender(); },
  habStar: e => { habBulk[+e.i].energy = +e.n; habBulkRender(); },
  habMins: e => { habBulk[+e.i].mins = +e.m; habBulkRender(); },
  habBulkSave: () => {
    if (habBulk.some(b => !b.title.trim() || !b.task.trim() || !clrOk(b.task, b.clear) || !b.energy)) return habBulkRender(true);
    D().habits.push(...habBulk.map(b => ({ id: uid(), log: {}, title: b.title.trim(), task: b.task.trim(), days: b.days, mins: b.mins, energy: b.energy, visionId: '' })));
    habBulk = []; Store.save(); closeSheet(); render();
  },
  capture: () => captureSheet(),
  cheerCat: e => { state.cheerCat = e.c || ''; render(); },
  cheerAdd: () => cheerSheet(''),
  cheerEdit: e => cheerSheet(e.id),
  cheerDel: e => { const a = cheerAll(), i = a.findIndex(x => x.id === e.id); if (i < 0) return; state.cheerUndo = { it: a.splice(i, 1)[0], i }; Store.save(); render(); toast('<span>המשפט נמחק</span><button class="btn" data-act="cheerUndo">בטל</button><button data-act="toastClose">✕</button>', 6000); },
  cheerUndo: () => { const u = state.cheerUndo; if (u) { cheerAll().splice(u.i, 0, u.it); state.cheerUndo = null; Store.save(); } $('#toast').hidden = true; render(); },
  stuckCheer: () => { state.stuckShift = (state.stuckShift || 0) + 1; const el = $('#stuckCheer'); if (el) el.textContent = '💬 ' + stuckLine(); },
  nextReminder: () => { state.remShift = (state.remShift || 0) + 1; render(); },
  runBreakMin: e => runOpen(null, true, +e.m, e.l),
  focusMethod: e => focusMethod(e.k),
  noiseOff: () => toggleNoise(),
  aiConsent: () => {
    sheet(`<h1>🤖 הפעלת עוזר AI</h1>
      <p class="sub">כשתפעיל, מה שאתה כותב בשיחה עם העוזר נשלח דרך השרת של Do It למודל AI של Anthropic, כדי שיענה לך. אין שליחה כשהעוזר כבוי.</p>
      <ul class="sub" style="padding-inline-start:18px;line-height:1.6"><li>נשלח: ההודעות שלך בשיחה, והנושאים שכבר מיינת בה.</li><li>לא נשלח: שמך, האימייל, הנתונים האחרים באפליקציה.</li><li>המפתח של ה-AI נשמר רק בשרת ולא בטלפון. השרת לא שומר את השיחה.</li><li>לא משנה כלום ברשימות שלך בלי האישור שלך.</li><li>אין תחליף לאיש מקצוע במצוקה נפשית.</li></ul>
      <label class="row" style="color:var(--ink);margin:10px 0"><input type="checkbox" id="aiShare" style="width:22px;height:22px"><span>לשלוח גם שמות של הפעולות להיום ושל הנושאים השמורים בזיכרון (כדי שיציע עדכונים מדויקים. בלי זה, בעדכון להיום יוצעו רק פעולות חדשות)</span></label>
      <div class="actions"><button class="btn" data-act="aiConsentOn">אני מסכים, להפעיל</button><button class="btn ghost" data-act="close">לא עכשיו</button></div>`);
  },
  aiConsentOn: () => { const pf = asstPrefs(); pf.consent = true; pf.shareTitles = !!($('#aiShare') && $('#aiShare').checked); D().assist.prefs = pf; Store.save(); AI.status = ''; AI.fell = false; closeSheet(); render(); A.aiPing(); },
  aiOff: () => { const pf = asstPrefs(); pf.consent = false; D().assist.prefs = pf; Store.save(); AI.status = ''; render(); },
  aiPing: async () => { AI.status = 'busy'; render(); try { const r = await AI.invoke({ ping: true }); AI.status = r.configured ? 'ok' : 'nokey'; } catch (e) { AI.status = e.message === 'login' ? 'login' : 'error'; } render(); },
  aiWhat: () => {
    const c = AI.last, pf = asstPrefs();
    sheet(`<h1>מה נשלח ל-AI?</h1><p class="sub">בכל הודעה נשלחים: מצב השיחה, ההודעה שלך, עד 12 ההודעות האחרונות בשיחה, והנושאים שמיינת. ${pf.shareTitles ? 'בנוסף, שמות הפעולות להיום והנושאים השמורים.' : 'שמות הפעולות והנושאים השמורים לא נשלחים.'}</p>
      <p class="sub">הדוגמה האחרונה שנשלחה:</p><pre style="white-space:pre-wrap;direction:ltr;text-align:left;font-size:12px;max-height:40vh;overflow:auto">${c ? esc(JSON.stringify(c, null, 1)) : 'עוד לא נשלח כלום בסשן הזה.'}</pre>
      <div class="actions"><button class="btn ghost" data-act="close">סגור</button></div>`);
  },
  asstBegin: e => { state.asstHome = false; asstBegin(e.m); },
  asstToday: () => { state.asstHome = false; asstBegin('today'); },
  asstFromCapture: () => { closeSheet(); state.asstHome = false; asstBegin('order'); },
  asstResume: () => { const s = asstSess(); if (!s) return; s.status = 'active'; state.asstHome = false; asstSave(s); render(); window.scrollTo(0, 0); },
  asstDrop: () => { delete D().assist.session; Store.save(); render(); },
  asstArea: e => { const pf = asstPrefs(), i = pf.areas.indexOf(e.a); if (i >= 0) pf.areas.splice(i, 1); else pf.areas.push(e.a); D().assist.prefs = pf; Store.save(); render(); },
  asstChip: e => asstSend(e.c),
  asstSendBtn: () => asstSend($('#asstInput').value),
  asstSkip: () => asstSend('__skip__', '(דילגתי על השאלה)'),
  asstPause: () => { const s = asstSess(); if (s) { s.status = 'paused'; asstSave(s); } state.asstHome = true; render(); window.scrollTo(0, 0); },
  asstExit: () => { state.asstHome = true; render(); window.scrollTo(0, 0); },
  asstSummarize: () => { if (AI.on()) return asstSend('__sum__', '(ביקשתי לסכם)'); const s = asstSess(); Engine.summarize(s); asstSave(s); render(); window.scrollTo(0, 0); },
  asstBack: () => { const s = asstSess(); s.phase = 'chat'; s.stage = 'free'; s.question = 'מה עוד היית רוצה להוסיף או לתקן?'; s.chips = []; s.history.push({ role: 'a', text: s.question }); asstSave(s); render(); window.scrollTo(0, 0); },
  asstUp: e => { const s = asstSess(), i = +e.i; if (i > 0) { [s.priorities[i - 1], s.priorities[i]] = [s.priorities[i], s.priorities[i - 1]]; asstSave(s); render(); } },
  asstDown: e => { const s = asstSess(), i = +e.i; if (i < s.priorities.length - 1) { [s.priorities[i + 1], s.priorities[i]] = [s.priorities[i], s.priorities[i + 1]]; asstSave(s); render(); } },
  asstGroup: e => { const s = asstSess(), p = s.priorities[+e.i], k = GROUPS.findIndex(g => g[0] === p.group); p.group = GROUPS[(k + 1) % GROUPS.length][0]; asstSave(s); render(); },
  asstEditP: e => { const s = asstSess(), p = s.priorities[+e.i], t = (prompt('נסח את הנושא', p.text) || '').trim(); if (t) { p.text = t; asstSave(s); render(); } },
  asstDelP: e => { const s = asstSess(); s.priorities.splice(+e.i, 1); asstSave(s); render(); },
  asstToFocus: () => { const s = asstSess(); s.phase = 'focus'; s.focusIds = s.priorities.filter(p => p.group !== 'idea' && p.group !== 'worry').slice(0, 3).map(p => p.id); asstSave(s); render(); window.scrollTo(0, 0); },
  asstToSummary: () => { const s = asstSess(); s.phase = 'summary'; asstSave(s); render(); },
  asstPick: e => { const s = asstSess(), i = s.focusIds.indexOf(e.id); if (i >= 0) s.focusIds.splice(i, 1); else if (s.focusIds.length < 3) s.focusIds.push(e.id); asstSave(s); render(); },
  asstBuild: () => { const s = asstSess(); s.phase = 'steps'; s.stepIdx = 0; s.steps = []; asstSave(s); render(); window.scrollTo(0, 0); asstFetchSteps(); },
  asstStepChip: e => { const f = $('#stepText'); if (f) { f.value = e.c; f.focus(); } },
  asstStepNext: () => { const s = asstSess(), tops = stepsPerTopic(s), p = tops[s.stepIdx], t = ($('#stepText').value || '').trim(); if (t) s.steps.push({ id: uid(), topic: p.text, topicId: p.id, title: t, mins: 15, on: true, date: 'none' }); s.stepIdx++; asstSave(s); render(); window.scrollTo(0, 0); asstFetchSteps(); },
  asstStepSkip: () => { const s = asstSess(); s.stepIdx++; asstSave(s); render(); asstFetchSteps(); },
  asstStepOn: e => { const s = asstSess(), st = s.steps[+e.i]; st.on = !st.on; if (!st.on) st.force = false; asstSave(s); render(); },
  asstForce: e => { const s = asstSess(), st = s.steps[+e.i]; st.force = true; st.on = true; asstSave(s); render(); },
  asstDate: e => { const s = asstSess(); s.steps[+e.i].date = e.d; asstSave(s); render(); },
  asstCommit: () => { const s = asstSess(), r = asstCommit(s); asstEnd('נוספו ' + r.added + ' פעולות' + (r.skipped ? ', ' + r.skipped + ' דומות לקיימות לא נוספו' : '')); },
  asstStepSave: () => { const s = asstSess(), t = ($('#stepText').value || '').trim(); if (!t) return $('#stepText').focus(); const a = { id: uid(), title: t, date: TODAY(), done: false, priority: 0, energy: 2, mins: 10, brainless: false, print: false, visionId: '', projectId: '', notes: '', subs: [], jobId: '' }; D().tasks.push(a); asstEnd('נוספה פעולה להיום'); runOpen(a.id); },
  asstProp: e => { const s = asstSess(), p = s.proposals[+e.i]; p.on = !p.on; asstSave(s); render(); },
  asstApply: () => {
    const s = asstSess(), T = TODAY(); let n = 0;
    s.proposals.filter(p => p.on).forEach(p => {
      if (p.type === 'add') { D().tasks.push({ id: uid(), title: p.title, date: T, done: false, priority: 0, energy: 3, mins: 15, brainless: false, print: false, visionId: '', projectId: '', notes: '', subs: [], jobId: '' }); n++; }
      else { const t = findTask(p.taskId); if (!t) return; if (p.type === 'postpone') deferTo(t, addDays(T, 1)); else { t.date = null; t.parked = true; delete t.ord; } n++; }
    });
    asstEnd('עודכנו ' + n + ' פעולות');
  },
  asstWeek: e => { const s = asstSess(), i = s.focusIds.indexOf(e.id); s.touched = true; if (i >= 0) s.focusIds.splice(i, 1); else if (s.focusIds.length < 3) s.focusIds.push(e.id); asstSave(s); render(); },
  asstWeekGo: () => { const s = asstSess(), f = asstFocus(), ids = s.touched ? s.focusIds : (s.focusIds.length ? s.focusIds : f.week.slice()); s.focusIds = ids.slice(0, 3); s.priorities = s.focusIds.map(id => { const t = D().topics.find(x => x.id === id) || {}; return { id, text: t.title || '', group: t.group || 'long', area: t.area || '', reason: 'נבחר לשבוע' }; }); s.phase = 'steps'; s.stepIdx = 0; s.steps = []; asstSave(s); render(); window.scrollTo(0, 0); asstFetchSteps(); },
  memStatus: e => { const t = D().topics.find(x => x.id === e.id); if (t) { t.status = e.s; Store.save(); render(); } },
  memEdit: e => { const t = D().topics.find(x => x.id === e.id), n = (prompt('נסח את הנושא', t.title) || '').trim(); if (n) { t.title = n; Store.save(); render(); } },
  memDel: e => { D().topics = D().topics.filter(x => x.id !== e.id); const f = asstFocus(); f.month = f.month.filter(i => i !== e.id); f.week = f.week.filter(i => i !== e.id); D().assist.focus = f; Store.save(); render(); },
  memDelSess: e => { D().sessions = D().sessions.filter(x => x.id !== e.id); Store.save(); render(); },
  memClear: () => { if (confirm('למחוק את כל הזיכרון של העוזר (נושאים, מיקוד ושיחות)? הפעולות והפרויקטים שנוצרו נשארים.')) { D().topics = []; D().sessions = []; D().assist = {}; Store.save(); render(); } },

  upJump: e => { const c = document.querySelector('#uboard .ucol[data-drop="' + e.c + '"]'); if (c) c.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' }); },
  runMinimize: () => { Run.mini = true; runRender(); },
  runExpand: () => { Run.mini = false; runRender(); },
  setMode: e => { state.mode = e.m; try { localStorage.setItem('doit-mode', e.m); } catch (x) {} render(); window.scrollTo(0, 0); },
  chooseOther: () => chooseOther(),
  pickNow: e => { state.doId = e.id; closeSheet(); $('#toast').hidden = true; runOpen(e.id); },
  nextIdea: () => { Run.idea = pickIdea(Run.idea); runRender(); },
  ideaDel: e => { D().breakIdeas = D().breakIdeas.filter(x => x.id !== e.id); Store.save(); render(); },
  undoNest: () => { const u = RDrag.undoNest; if (!u) return; const p = findTask(u.pid); if (p) p.subs = (p.subs || []).filter(x => x.id !== u.task.id); if (!D().tasks.some(x => x.id === u.task.id)) D().tasks.push(u.task); RDrag.undoNest = null; Store.save(); render(); toast('<span>↩ הפעולה חזרה למקומה</span>', 2500); },
  undoMove: e => { const u = RDrag.undo; if (u && u.id === e.id) { const t = findTask(e.id); if (t) { t.date = u.date; Store.save(); } } $('#toast').hidden = true; render(); },
  setQuad: e => {
    if (!e.id) { const f = $('#f'), same = f.quad.value === e.q; f.quad.value = same ? '' : e.q; $('#quadBox').innerHTML = quadChips('', f.quad.value, ''); return; } // inside a form: just remember the choice
    const x = itemOf(e.k, e.id); if (!x) return; const same = x.quad === e.q; x.quad = same ? '' : e.q;
    if (!e.k) x.priority = same ? 0 : quadPri[e.q];
    Store.save(); render(); if (!e.k && !$('#sheet').hidden) menuSheet(e.id);
  },
  setWant: e => {
    if (!e.id) { const f = $('#f'), same = +f.want.value === +e.n; f.want.value = same ? 0 : e.n; $('#wantBox').innerHTML = wantStars('', +f.want.value, ''); return; }
    const x = itemOf(e.k, e.id); if (!x) return; x.want = (x.want === +e.n) ? 0 : +e.n;
    Store.save(); render(); if (!e.k && !$('#sheet').hidden) menuSheet(e.id);
  },
  toPool: e => { // take the action off its day and put it back in "כל הפעולות" (no date, parked so the daily organizing does not ask about it)
    const t = findTask(e.id); if (!t) return; const prev = t.date; t.date = null; t.parked = true; delete t.ord; Store.save(); closeSheet(); render();
    toast('<span>↩ הוחזרה לכל הפעולות</span><button class="btn ghost" data-act="undoPool" data-id="' + t.id + '" data-d="' + (prev || '') + '">בטל</button><button data-act="toastClose" aria-label="סגור">✕</button>', 6000);
  },
  undoPool: e => { const t = findTask(e.id); if (t) { t.date = e.d || null; t.parked = false; Store.save(); } $('#toast').hidden = true; render(); },
  undoSweep: () => { (state.sweepUndo || []).forEach(([id, d]) => { const t = findTask(id); if (t && !t.date) { t.date = d; delete t.from; } }); state.sweepUndo = null; Store.save(); $('#toast').hidden = true; render(); },
  carryOver: () => { // move everything left undone from yesterday to today, on request only
    const T = TODAY(), list = yesterdayLeft(); if (!list.length) return;
    list.forEach(t => deferTo(t, T)); Store.save(); render();
    const b = $('#carryBtn'); if (b) { b.textContent = '✓ הועברו ' + list.length + ' פעולות להיום'; b.disabled = true; b.removeAttribute('data-act'); } else toast('<span>⏩ הועברו ' + list.length + ' פעולות להיום</span><button data-act="toastClose" aria-label="סגור">✕</button>', 5000);
  },
  hideSyncHint: () => { try { localStorage.setItem('doit-sync-hint-off', '1'); } catch (e) {} render(); },
  refreshApp: async () => { try { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); for (const k of await caches.keys()) await caches.delete(k); } catch (e) {} location.href = location.pathname + '?' + (DEMO ? 'demo&' : '') + 'r=' + Date.now(); },
  clearOk: () => { const f = $('#f'); if (!f) return; f.dataset.ok = '1'; $('#clHint').innerHTML = '<div class="ok">✓ אישרת את הניסוח. אפשר לשמור.</div>'; },
  useSuggest: e => { const f = $('#f'); if (!f || !f.title) return; f.title.value = e.s; f.title.dispatchEvent(new Event('input')); f.title.focus(); },
  setEnergyTo: v => { $('#toast').hidden = true; const f = fo(TODAY()); f.energy = v; f.energyAt = new Date().toISOString(); Store.save(); render(); if (v) energyHelp(v); },
  energyHelpOpen: () => { const v = focusOn(TODAY()).energy; if (v) energyHelp(v); },
  resetOrder: () => { tasksOn(state.date).forEach(t => { delete t.ord; }); Store.save(); render(); },
  rewardOpen: () => { $('#toast').hidden = true; rewardSheet(); },
  rewardManage: () => { closeSheet(); state.tab = 'dayrewards'; render(); },
  rewardPick: e => { const r = D().dayRewards.find(x => x.id === e.id); if (r) setReward(r.title); },
  rewardRandom: () => { const L = D().dayRewards; if (L.length) setReward(L[Math.floor(Math.random() * L.length)].title); },
  rewardClaim: () => { fo(TODAY()).rewardClaimed = true; Store.save(); render(); celebrate(); },
  rewardDel: e => { D().dayRewards = D().dayRewards.filter(r => r.id !== e.id); Store.save(); render(); },
  victimSave: e => {
    const T = TODAY(), el = $(e.k === 'q' ? '#vThought' : '#vResp'), v = el.value.trim(); if (!v) return el.focus();
    const line = (e.k === 'q' ? '🥀 מחשבה ששאלתי עליה "האם זה באמת נכון?": ' : '🤝 האחריות שלי: ') + v;
    D().notes[T] = ((D().notes[T] || '') + (D().notes[T] ? '\n' : '') + line); Store.save(); el.value = ''; el.placeholder = 'נשמר ביומן ✓';
  },
  victimStep: () => {
    const v = ($('#vStep').value || '').trim(); if (!v) return $('#vStep').focus();
    const t = { id: uid(), title: v, date: TODAY(), done: false, priority: 1, energy: 2, mins: 10, brainless: false, print: false, visionId: '', projectId: '', notes: '', subs: [], jobId: '' };
    D().tasks.push(t); Store.save(); closeSheet(); render(); runOpen(t.id);
  },
  run2: e => { runOpen(e.id); Run.total = Run.left = 120; runStartTimer(); },
  breakLater: () => { const f = fo(TODAY()); f.workNext = (f.work || 0) + 15; Store.save(); $('#toast').hidden = true; },
  rhythmStart: e => { $('#toast').hidden = true; const r = D().rhythm.find(x => x.id === e.id); if (r) runOpen(null, true, r.mins, (r.kind === 'meal' ? '🍽 ' : '😌 ') + r.label, r.id); },
  rhythmDone: e => { $('#toast').hidden = true; const T = TODAY(), l = (D().rhythmLog[T] = D().rhythmLog[T] || {}); if (l[e.id]) delete l[e.id]; else l[e.id] = true; Store.save(); render(); },
  brainlessList: () => {
    const T = TODAY(), all = D().tasks.filter(t => !t.done && t.brainless), list = (all.filter(t => t.date === T).length ? all.filter(t => t.date === T) : all).slice(0, 12);
    sheet(`<h1>⚡ פעולות brainless</h1>${list.length ? '<p class="sub">פעולות פשוטות שאפשר להעיף ברגע. בחר אחת להתחלה:</p><div class="grid2" style="grid-template-columns:1fr">' + list.map(t => '<button class="btn ghost" data-act="runStart" data-id="' + t.id + '">◀ ' + esc(t.title) +  + '</button>').join('') + '</div>' : '<p class="sub">אין כרגע פעולות brainless פתוחות. אפשר לסמן פעולה כ-Brainless בעריכה שלה.</p>'}<div class="actions"><button class="btn ghost" data-act="close">סגור</button></div>`);
  },
  rhythmDoneRun: () => { const T = TODAY(); if (Run.rhythmId) { (D().rhythmLog[T] = D().rhythmLog[T] || {})[Run.rhythmId] = true; Store.save(); } runClose(); },
  rhythmDel: e => { D().rhythm = D().rhythm.filter(r => r.id !== e.id); Store.save(); render(); },
  dayStart: () => { D().dayLog[TODAY()] = { start: nowHM(), end: '' }; Store.save(); render(); },
  dayEnd: () => {
    const T = TODAY(), K = dayKey(), L = (D().dayLog[K] = D().dayLog[K] || { start: '', end: '' }); L.end = nowHM(); Store.save(); render();
    const ts = tasksOn(K); const wt = Math.round((D().focus[K] || {}).workTotal || 0) + (K !== T ? Math.round((D().focus[T] || {}).workTotal || 0) : 0); toast(`<span>🌙 לילה טוב. שעת הסיום נרשמה ב-${L.end}. משך ${fmtDur(dayDurMin(L))}${wt ? `, מתוכו עבודה בפועל ${fmtDur(wt)}` : ''}, ${ts.filter(t => t.done).length}/${ts.length} פעולות בוצעו.</span><button data-act="toastClose" aria-label="סגור">✕</button>`, 8000); celebrate();
  },
  dayReopen: () => { const L = D().dayLog[dayKey()]; if (L) { L.end = ''; Store.save(); render(); } },
  dayEdit: () => dayEditSheet(),
  reviewLater: () => { D().review[addDays(TODAY(), -1)] = { met: '', improve: '', skipped: true, at: new Date().toISOString() }; Store.save(); closeSheet(); setTimeout(askFocus, 250); },
  rewriteEdit: e => { const t = findTask(e.id); t.nudged = t.defers; Store.save(); taskForm(t.id); },
  rewriteSplit: e => { const t = findTask(e.id); t.nudged = t.defers; splitNameSheet(t, () => { Store.save(); closeSheet(); render(); }, 2); },
  rewriteDel: e => { if (confirm('למחוק את הפעולה?')) { D().tasks = D().tasks.filter(t => t.id !== e.id); Store.save(); closeSheet(); render(); } },
  rewriteKeep: e => { const t = findTask(e.id); t.nudged = t.defers; Store.save(); closeSheet(); },
  toggleShowAll: () => { state.showAll = !state.showAll; render(); },
  toastClose: () => { $('#toast').hidden = true; },
  runStart: e => {
    $('#toast').hidden = true; let id = e.id;
    if (!id) { const T = TODAY(), f = focusOn(T); if (!f.mit) return focusSheet(T);
      const t = { id: uid(), title: f.mit, date: T, done: false, priority: 0, energy: 3, mins: 15, brainless: false, print: false, visionId: '', projectId: '', notes: '', subs: [] };
      D().tasks.push(t); (D().focus[T] = D().focus[T] || {}).mitId = t.id; Store.save(); id = t.id; }
    runOpen(id);
  },
  runBreak: () => { $('#toast').hidden = true; runOpen(null, true, 10); },
  visStart: () => visOpen(),
  visLater: () => { visualSnooze = true; closeSheet(); setTimeout(askMorning, 250); },
  visClose: () => { visStop(); render(); },
  visAuto: () => { Vis.auto = !Vis.auto; visRender(); },
  visSpeak: () => { Vis.speak = !Vis.speak; visRender(); },
  visPrev: () => { if (Vis.i > 0) { Vis.i--; visRender(); } },
  visNext: () => { if (Vis.i < VISUALIZATION.length - 1) { Vis.i++; visRender(); } },
  visDone: () => { D().visual[TODAY()] = new Date().toISOString(); Store.save(); visStop(); render(); celebrate(); setTimeout(askMorning, 600); },

  runClose: () => runClose(),
  runMins: e => { if (Run.running) return; Run.total = Run.left = +e.m * 60; runRender(); },
  runToggle: () => {
    if (Run.running) { Run.left = Math.max(0, Math.round((Run.endAt - Date.now()) / 1000)); clearInterval(Run.tick); Run.running = false; runRender(); }
    else runStartTimer();
  },
  runMore: () => { Run.ended = false; Run.total = Run.left = 300; runStartTimer(); },
  runDone: () => {
    const id = Run.id, t = id && findTask(id), el = Run.running ? Run.total - Math.max(0, (Run.endAt - Date.now()) / 1000) : Run.total - Run.left; if (id && el >= 60 && !Run.ended) { addWork(el / 60); Work.skipId = id; } runClose();
    if (t && !t.done) A.toggleTask({ id }); else showNext(id);
  },
  runNext: () => { if (Run.brk) { if (Run.brkStarted || Run.ended) finishBreak(); else runClose(); return; } const n = nextTask(Run.id); if (n) runOpen(n.id); else runClose(); },
  stuck: () => stuckSheet(),
  stuckClose: () => closeSheet(),
  stuckTwo: () => { closeSheet(); Run.ended = false; Run.total = Run.left = 120; runStartTimer(); },
  stuckEasy: e => { closeSheet(); runOpen(e.id); },
  stuckSmall: () => {
    sheet(`<h1>צעד קטן יותר 🔹</h1><p class="sub">מה הדבר הקטן ביותר שאפשר לעשות עכשיו, אפילו 2 דקות?</p>
     <form id="smallForm" class="row"><input id="smallText" placeholder="למשל: לפתוח את הקובץ" autocomplete="off" autofocus><button class="btn">הוסף</button></form>
     <div class="actions"><button class="btn ghost" data-act="stuckClose">חזרה</button></div>`);
    $('#smallForm').onsubmit = ev => {
      ev.preventDefault(); const txt = $('#smallText').value.trim(), t = findTask(Run.id); if (!txt || !t) return;
      (t.subs = t.subs || []).unshift({ id: uid(), title: txt, done: false, mins: 5 }); t.first = txt; Store.save(); closeSheet(); runRender();
    };
  },
  stuckLater: () => {
    const T = TODAY();
    sheet(`<h1>לחזור אליה מתי?</h1><div class="grid2">${[['מחר', 1], ['בעוד יומיים', 2], ['בעוד שבוע', 7]].map(([l, n]) => `<button class="btn ghost" data-act="stuckMove" data-d="${addDays(T, n)}">${l}</button>`).join('')}</div>
     <div class="actions"><button class="btn ghost" data-act="stuckClose">חזרה</button></div>`);
  },
  stuckMove: e => { const t = findTask(Run.id); if (t) { deferTo(t, e.d); Store.save(); } closeSheet(); runClose(); if (t) setTimeout(() => nudgeAny([t.id]), 300); const n = nextTask(Run.id); if (n) toast(`<span>נדחה. אולי <b>${esc(n.title)}</b>?</span><button class="btn" data-act="runStart" data-id="${n.id}">התחל</button><button data-act="toastClose">✕</button>`); },
  orgPark: e => { const t = findTask(e.id); deferTo(t, null); t.parked = true; Store.save(); render(); orgStep1(); },
  orgOpen: () => orgOpen(),
  orgSuggest: () => orgSuggest(),
  orgSet: e => { const t = findTask(e.id); deferTo(t, e.d); classify(t); Store.save(); render(); orgStep1(); },
  orgNext: () => orgStep2(),
  orgBack: () => orgStep1(),
  orgMove: e => { const t = findTask(e.id); deferTo(t, e.d === 'none' ? null : e.d); if (t.date) classify(t); Store.save(); render(); orgStep2(); },
  orgAddTomorrow: () => taskForm(undefined, addDays(TODAY(), 1)),
  orgFinish: () => { D().org = D().org || {}; D().org[TODAY()] = { at: new Date().toISOString() }; Store.save(); closeSheet(); render(); celebrate(); setTimeout(() => nudgeAny(Org.ids), 900); },
  addBulk: () => bulkStart(),
  copyPrompt: async () => {
    const msg = $('#clipMsg');
    try { await navigator.clipboard.writeText('העתק את הרשימה שבתמונה, פעולה אחת בכל שורה, בלי מספור ובלי תבליטים, בלי הסברים ובלי טקסט נוסף.'); msg.textContent = 'ההנחיה הועתקה. הדבק אותה בצ\'אט של Claude עם צילום הרשימה.'; }
    catch (e) { msg.textContent = 'לא הצלחתי להעתיק. אפשר לכתוב ל-Claude: העתק את הרשימה שבתמונה, פעולה בכל שורה.'; }
  },
  pasteClip: async () => {
    const msg = $('#clipMsg');
    try {
      const txt = (await navigator.clipboard.readText()).trim();
      if (!txt) { msg.textContent = 'הלוח ריק.'; return; }
      const ta = $('#bulkText'); ta.value = ta.value ? ta.value.replace(/\s*$/, '\n') + txt : txt; msg.textContent = 'הודבק. אפשר לערוך את הטקסט ולהמשיך.';
    } catch (e) { msg.textContent = 'אין הרשאה לקרוא מהלוח. הדבק ידנית בתיבה למטה (לחיצה ארוכה ← הדבק).'; }
  },
  bulkNext: () => {
    const lines = $('#bulkText').value.split('\n').map(s => s.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean);
    if (!lines.length) return;
    bulk = lines.map(title => ({ title, date: undefined, energy: 0, mins: 15, brainless: false, clear: false })); bulkRender();
  },
  bulkAllDate: e => { const v = bulkDateOpts()[+e.j][1]; bulk.forEach(b => { b.date = v; }); bulkRender(); },
  bulkDate: e => { bulk[+e.i].date = bulkDateOpts()[+e.j][1]; bulkRender(); },
  bulkStar: e => { bulk[+e.i].energy = +e.n; bulkRender(); },
  bulkMins: e => { bulk[+e.i].mins = +e.m; bulkRender(); },
  bulkClear: e => { const b = bulk[+e.i]; b.clear = !b.clear; bulkRender(); },
  bulkBrain: e => { bulk[+e.i].brainless = !bulk[+e.i].brainless; bulkRender(); },
  bulkSave: () => {
    if (bulk.some(b => b.date === undefined || !b.energy || !clrOk(b.title, b.clear) || !b.title.trim())) return bulkRender(true);
    const created = bulk.map(b => ({ id: uid(), done: false, title: b.title.trim(), date: b.date, priority: 0, visionId: '', notes: '', print: false, projectId: bulkProject, brainless: b.brainless, energy: b.energy, mins: b.mins, subs: [] }));
    D().tasks.push(...created); bulk = []; resolveLong(created);
  },
  account: accountSheet,
  syncNow: () => { closeSheet(); Cloud.sync(); },
  logout: async () => { await Cloud.sb.auth.signOut(); closeSheet(); },
  signup: async () => {
    const f = $('#f'); if (!f.reportValidity()) return;
    const { data, error } = await Cloud.sb.auth.signUp({ email: f.email.value, password: f.password.value });
    $('#authMsg').style.color = error ? 'var(--danger)' : 'var(--brand)';
    $('#authMsg').textContent = error ? authErr(error.message) : (data.session ? 'נרשמת בהצלחה' : 'נשלח אימייל אימות. אשר אותו ואז היכנס.');
    if (data && data.session) closeSheet();
  },
  dayTog: (e, el) => el.classList.toggle('on'),
  shift: e => { state.date = addDays(state.date, +e.n); render(); },
  goToday: () => { state.date = TODAY(); render(); },
  filter: e => { state.taskFilter = e.f; render(); },
  allMode: e => { state.allMode = e.m; render(); },
  filterQuad: e => { state.fQuad = state.fQuad === e.q ? '' : e.q; render(); },
  filterWant: e => { state.fWant = state.fWant === +e.n ? 0 : +e.n; render(); },
  filterReset: () => { state.fQuad = ''; state.fWant = 0; render(); },
  printDay: () => printDayCore(false), printDayAll: () => printDayCore(true), printWeek, printSel,
  openList: e => { state.openList = e.id; render(); },
  backLists: () => { state.openList = null; render(); },
  delList: e => { if (confirm('למחוק את הרשימה?')) { D().lists = D().lists.filter(l => l.id !== e.id); Store.save(); render(); } },
  printList: e => { const l = D().lists.find(x => x.id === e.id); printHTML(`<h1>${esc(l.title)}</h1>${l.items.map(i => pRow(i.text)).join('')}`); },
  toggleItem: e => { forItem(e.id, (l, i) => { i.done = !i.done; }); },
  delItem: e => { forItem(e.id, (l, i) => { l.items = l.items.filter(x => x !== i); }); }
};
function forItem(id, fn) {
  for (const l of D().lists) { const i = l.items.find(x => x.id === id); if (i) { fn(l, i); state.openList = l.id; Store.save(); render(); return; } }
}

document.addEventListener('click', ev => {
  const el = ev.target.closest('[data-act]');
  if (el) { const fn = A[el.dataset.act]; if (fn) { ev.preventDefault(); fn({ ...el.dataset }, el); } return; }
  const nav = ev.target.closest('#nav button');
  if (nav) { state.pmIsle = null; state.tab = nav.dataset.tab; state.openList = null; state.openProject = null; state.openJob = null; state.pmOpen = null; state.pmReview = null; render(); window.scrollTo(0, 0); }
});
document.addEventListener('change', ev => {
  if (ev.target.id === 'notifySel') { try { localStorage.setItem('doit-notify', ev.target.value); } catch (e) {} const d = $('#notifyDesc'); if (d) d.textContent = (NOTIFY.find(x => x[0] === ev.target.value) || NOTIFY[1])[2]; return; }
  if (ev.target.id === 'energySel') { A.setEnergyTo(ev.target.value); return; }
  if (ev.target.id === 'upMonth') {
    const v = ev.target.value, first = v === TODAY().slice(0, 7) ? TODAY() : v + '-01';
    if (state.upMode === 'month') { state.upMonth = v; state.upSel = first; } else { state.upStart = first; state.upDays = 14; }
    render(); return;
  }
  if (ev.target.dataset && ev.target.dataset.bulkproj !== undefined) { // project for the whole bulk batch
    let v = ev.target.value;
    if (v === '__new__') { const p = newProject(); v = p ? p.id : ''; }
    bulkProject = v; bulkRender(); return;
  }
  const od = ev.target.dataset && ev.target.dataset.orgdate;
  if (od !== undefined) { const t = findTask(od); if (t && ev.target.value) { deferTo(t, ev.target.value); Store.save(); render(); orgStep1(); } return; }
  const i = ev.target.dataset && ev.target.dataset.bulkdate;
  if (i !== undefined) { bulk[+i].date = ev.target.value || undefined; bulkRender(); }
});
document.addEventListener('input', ev => {
  const wf = ev.target.dataset && ev.target.dataset.weekfield;
  if (wf !== undefined) { weekData(state.weekStart)[wf] = ev.target.value; Store.save(); return; } // weekly texts autosave
  const ht = ev.target.dataset && ev.target.dataset.habtitle;
  if (ht !== undefined) { habBulk[+ht].title = ev.target.value; return; }
  const hk = ev.target.dataset && ev.target.dataset.habtask;
  if (hk !== undefined) { // habit's generated task: live clarity check, needs a fresh "זה ברור" after edits
    const b = habBulk[+hk]; b.task = ev.target.value; b.clear = false;
    $('#hcl' + hk).innerHTML = clarityHTML(b.task);
    const btn = ev.target.closest('.bulkrow').querySelector('.clearbtn'); btn.classList.remove('on'); btn.textContent = '☐ זה ברור: ' + CLEAR_LABEL; btn.hidden = !clarity(b.task).length;
    return;
  }
  const bi = ev.target.dataset && ev.target.dataset.bulktitle;
  if (bi !== undefined) { // edit a bulk task title in place: re-check clarity and require a fresh "זה ברור"
    const b = bulk[+bi]; b.title = ev.target.value; b.clear = false;
    $('#cl' + bi).innerHTML = clarityHTML(b.title);
    const btn = ev.target.closest('.bulkrow').querySelector('.clearbtn'); btn.classList.remove('on'); btn.textContent = '☐ זה ברור: ' + CLEAR_LABEL; btn.hidden = !clarity(b.title).length;
    return;
  }
  if (ev.target.id === 'jnote') { D().notes[state.jDate] = ev.target.value; Store.save(); }
  if (ev.target.id === 'note') { D().notes[state.date] = ev.target.value; Store.save(); }
});

/* ---------- Reorder today's actions by dragging a row over another (mouse drag, or long-press on touch) ---------- */
const RDrag = { el: null, pid: 0, sx: 0, sy: 0, active: false, timer: null, target: null, before: true, suppress: false, mode: 'reorder', zone: '' };
const DRAG_TABS = ['today', 'tasks', 'projects', 'matrix'];
function rdClear() { document.querySelectorAll('.drop-before,.drop-after,.drop-into').forEach(r => r.classList.remove('drop-before', 'drop-after', 'drop-into')); }
function rdReset() { clearTimeout(RDrag.timer); rdClear(); if (RDrag.el) { RDrag.el.classList.remove('rdrag'); RDrag.el.style.transform = ''; } const bar = $('#dropbar'); if (bar) bar.remove(); RDrag.el = null; RDrag.active = false; RDrag.target = null; RDrag.nest = false; RDrag.zone = ''; document.body.classList.remove('dragging'); }
function rdStart() {
  RDrag.active = true; RDrag.el.classList.add('rdrag'); document.body.classList.add('dragging'); try { navigator.vibrate && navigator.vibrate(15); } catch (e) {}
  if (RDrag.mode === 'move') { // from the lists: two drop zones, today and tomorrow
    const bar = document.createElement('div'); bar.id = 'dropbar'; bar.innerHTML = '<div data-drop="today">📥 היום</div><div data-drop="tomorrow">📆 מחר</div>'; document.body.appendChild(bar);
  }
}
// the open action row under the pointer (centre band only when reordering), as the target for turning a dragged action into its sub-action
function nestRowAt(y, band) {
  return [...document.querySelectorAll('#view .grp[data-tid]')].find(r => {
    if (r === RDrag.el) return false; const t = findTask(r.dataset.tid); if (!t || t.done) return false;
    const b = r.getBoundingClientRect(), f = (y - b.top) / b.height; return band ? f > .3 && f < .7 : f >= 0 && f <= 1;
  });
}
function nestInto(id, pid) {
  const t = findTask(id), p = findTask(pid); if (!t || !p || t === p) return;
  if ((t.subs || []).length) { toast('<span>לפעולה "' + esc(t.title) + '" יש כבר תתי-פעולות, אז אי אפשר להכניס אותה לתוך פעולה אחרת</span><button data-act="toastClose" aria-label="סגור">✕</button>', 5000); return; }
  D().tasks = D().tasks.filter(x => x.id !== id);
  p.subs = p.subs || []; p.subs.push({ id: t.id, title: t.title, done: !!t.done, mins: t.mins || 0, notes: t.notes || '' });
  RDrag.undoNest = { task: t, pid };
  Store.save(); render();
  toast('<span>↳ נכנסה כתת-פעולה אל: <b>' + esc(p.title) + '</b></span><button class="btn ghost" data-act="undoNest">בטל</button><button data-act="toastClose" aria-label="סגור">✕</button>', 7000);
}
function rdMove(x, y) {
  if (RDrag.mode === 'move') {
    RDrag.el.style.transform = 'translate(' + (x - RDrag.sx) + 'px,' + (y - RDrag.sy) + 'px)'; RDrag.zone = '';
    document.querySelectorAll('#dropbar > div').forEach(z => { const r = z.getBoundingClientRect(), over = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; z.classList.toggle('over', over); if (over) RDrag.zone = z.dataset.drop; });
    rdClear(); RDrag.target = null; RDrag.nest = false;
    if (!RDrag.zone) { const hit = nestRowAt(y); if (hit) { hit.classList.add('drop-into'); RDrag.target = hit; RDrag.nest = true; } }
    if (y < 90) window.scrollBy(0, -12); else if (y > innerHeight - 240 && y < innerHeight - 160) window.scrollBy(0, 12);
    return;
  }
  RDrag.el.style.transform = 'translateY(' + (y - RDrag.sy) + 'px)'; rdClear();
  const rows = [...document.querySelectorAll('#view > .grp[data-tid]')].filter(r => r !== RDrag.el);
  if (!rows.length) return;
  RDrag.nest = false;
  const mid = nestRowAt(y, true); if (mid) { mid.classList.add('drop-into'); RDrag.target = mid; RDrag.nest = true; if (y < 90) window.scrollBy(0, -12); else if (y > innerHeight - 110) window.scrollBy(0, 12); return; }
  let t = rows.find(r => { const b = r.getBoundingClientRect(); return y < b.top + b.height / 2; }), before = true;
  if (!t) { t = rows[rows.length - 1]; before = false; }
  t.classList.add(before ? 'drop-before' : 'drop-after'); RDrag.target = t; RDrag.before = before;
  if (y < 90) window.scrollBy(0, -12); else if (y > innerHeight - 110) window.scrollBy(0, 12);
}
function rdEnd(commit) {
  const el = RDrag.el, target = RDrag.target, before = RDrag.before, was = RDrag.active, mode = RDrag.mode, zone = RDrag.zone, nest = RDrag.nest;
  rdReset();
  if (!was) return;
  RDrag.suppress = true; setTimeout(() => { RDrag.suppress = false; }, 350);
  if (!commit || !el) return;
  if (nest && target) { nestInto(el.dataset.tid, target.dataset.tid); return; }
  if (mode === 'move') { // drop on "today" / "tomorrow": schedule the action for that day
    const t = findTask(el.dataset.tid); if (!zone || !t) return;
    const nd = zone === 'today' ? TODAY() : addDays(TODAY(), 1); if (t.date === nd) return;
    t.date = nd; classify(t); delete t.ord; Store.save(); render();
    toast('<span>' + (zone === 'today' ? '📥 הועברה להיום' : '📆 הועברה למחר') + ': <b>' + esc(t.title) + '</b></span><button class="btn ghost" data-act="undoMove" data-id="' + t.id + '">בטל</button><button data-act="toastClose" aria-label="סגור">✕</button>', 6000);
    RDrag.undo = { id: t.id, date: el.dataset.prev || null };
    return;
  }
  if (!target) return;
  const ids = [...document.querySelectorAll('#view > .grp[data-tid]')].map(r => r.dataset.tid).filter(id => id !== el.dataset.tid);
  const at = ids.indexOf(target.dataset.tid) + (before ? 0 : 1); ids.splice(at, 0, el.dataset.tid);
  const d = state.date, rest = tasksOn(d).map(t => t.id).filter(id => !ids.includes(id));
  [...ids, ...rest].forEach((id, i) => { const t = findTask(id); if (t) t.ord = i; });
  Store.save(); render();
}
document.addEventListener('pointerdown', e => {
  if (!DRAG_TABS.includes(state.tab) || e.target.closest('button,input,textarea,select,summary,a,details')) return;
  const today = state.tab === 'today', row = e.target.closest(today ? '#view > .grp[data-tid]' : '#view .grp[data-tid]'); if (!row || (e.pointerType === 'mouse' && e.button !== 0)) return;
  const t = findTask(row.dataset.tid); if (!today && (!t || t.done)) return; // from the lists only open actions can be scheduled
  if (t) row.dataset.prev = t.date || '';
  Object.assign(RDrag, { el: row, pid: e.pointerId, sx: e.clientX, sy: e.clientY, active: false, target: null, mode: today ? 'reorder' : 'move', zone: '' });
  if (e.pointerType !== 'mouse') RDrag.timer = setTimeout(rdStart, 380);
});
document.addEventListener('pointermove', e => {
  if (!RDrag.el || e.pointerId !== RDrag.pid) return;
  if (RDrag.active) return rdMove(e.clientX, e.clientY);
  if (Math.hypot(e.clientX - RDrag.sx, e.clientY - RDrag.sy) > 8) { if (e.pointerType === 'mouse') { rdStart(); rdMove(e.clientX, e.clientY); } else rdReset(); } // touch moved first: let it scroll
});
document.addEventListener('pointerup', e => { if (RDrag.el && e.pointerId === RDrag.pid) rdEnd(true); });
document.addEventListener('pointercancel', e => { if (RDrag.el && e.pointerId === RDrag.pid) rdEnd(false); });
document.addEventListener('touchmove', e => { if (RDrag.active) e.preventDefault(); }, { passive: false });
document.addEventListener('click', e => { if (RDrag.suppress) { e.stopPropagation(); e.preventDefault(); } }, true);
/* ---------- Celebration (confetti) for finished days and achieved goals / claimed rewards ---------- */
function celebrate(x = innerWidth / 2, y = innerHeight / 3) {
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const colors = ['#1f6f5c', '#e8a33d', '#c0453a', '#3aa68c', '#f2c94c'];
  for (let i = 0; i < 28; i++) {
    const p = document.createElement('i'); p.className = 'confetti';
    p.style.cssText = `left:${x}px;top:${y}px;background:${colors[i % colors.length]};--dx:${(Math.random() - .5) * 320}px;--dy:${80 + Math.random() * 260}px;--rot:${Math.random() * 720}deg;animation-delay:${Math.random() * 60}ms`;
    document.body.appendChild(p); setTimeout(() => p.remove(), 1500);
  }
}

/* ---------- Drag & drop of task cards between day columns (mouse drag; touch long-press; RTL-safe) ---------- */
const Drag = { el: null, ghost: null, id: null, timer: null, raf: null, active: false, pid: null, over: null, sx: 0, sy: 0, x: 0, y: 0, offX: 0, offY: 0, suppressClick: false };
function dragReset() {
  clearTimeout(Drag.timer); cancelAnimationFrame(Drag.raf);
  if (Drag.ghost) Drag.ghost.remove();
  if (Drag.el) Drag.el.classList.remove('dragging');
  if (Drag.over) Drag.over.classList.remove('over');
  document.querySelectorAll('.nest-over').forEach(c => c.classList.remove('nest-over'));
  document.body.classList.remove('dragging-now');
  Object.assign(Drag, { nest: null, el: null, ghost: null, id: null, active: false, over: null, pid: null });
}
function dragStart(x, y) {
  clearTimeout(Drag.timer);
  if (!Drag.el) return;
  Drag.active = true;
  const r = Drag.el.getBoundingClientRect(), g = Drag.el.cloneNode(true);
  g.classList.add('ghost'); g.style.width = r.width + 'px';
  document.body.appendChild(g);
  Object.assign(Drag, { ghost: g, offX: x - r.left, offY: y - r.top });
  Drag.el.classList.add('dragging'); document.body.classList.add('dragging-now');
  if (navigator.vibrate) navigator.vibrate(12);
  dragMove(x, y); dragLoop();
}
function dragMove(x, y) {
  Drag.x = x; Drag.y = y;
  Drag.ghost.style.transform = `translate(${x - Drag.offX}px, ${y - Drag.offY}px)`;
  const under = document.elementFromPoint(x, y);
  // the centre band of another open card = turn the dragged action into its sub-action; elsewhere = the column / project / square under the pointer
  document.querySelectorAll('.nest-over').forEach(c => c.classList.remove('nest-over')); Drag.nest = null;
  const oc = under && under.closest('.ucard:not(.mini):not(.ghost)');
  if (oc && oc !== Drag.el && oc.dataset.task && oc.dataset.task !== Drag.id) { const ot = findTask(oc.dataset.task), b = oc.getBoundingClientRect(), f = (y - b.top) / b.height; if (ot && !ot.done && f > .3 && f < .7) { oc.classList.add('nest-over'); Drag.nest = oc.dataset.task; } }
  const col = Drag.nest ? null : under && under.closest('[data-drop]');
  if (Drag.over !== col) { if (Drag.over) Drag.over.classList.remove('over'); Drag.over = col; if (col) col.classList.add('over'); }
}
function dragLoop() { // auto-scroll the board sideways (works the same in RTL) and the page vertically near the edges
  if (!Drag.active) return;
  const b = $('#uboard');
  if (b) {
    const r = b.getBoundingClientRect(), edge = 56;
    if (Drag.x < r.left + edge) b.scrollBy({ left: -16 }); else if (Drag.x > r.right - edge) b.scrollBy({ left: 16 });
  }
  if (Drag.y < 80) window.scrollBy(0, -14); else if (Drag.y > innerHeight - 100) window.scrollBy(0, 14);
  dragMove(Drag.x, Drag.y);
  Drag.raf = requestAnimationFrame(dragLoop);
}
function dragEnd(drop) {
  const was = Drag.active, id = Drag.id, col = Drag.over, nest = Drag.nest;
  dragReset();
  if (!was) return;
  Drag.suppressClick = true; setTimeout(() => { Drag.suppressClick = false; }, 60);
  if (drop && nest) { nestInto(id, nest); return; }
  if (!drop || !col) return;
  const target = col.dataset.drop, t = findTask(id);
  if (!t || ['overdue', 'later', 'done'].includes(target)) return; // columns you cannot drop into
  if (target.startsWith('p:')) { const pid = target.slice(2) === 'none' ? '' : target.slice(2); if ((t.projectId || '') !== pid) { const j = t.jobId && findJob(t.jobId); t.projectId = pid; if (j && j.projectId !== pid) t.jobId = ''; Store.save(); render(); toast('<span>📁 ' + (pid ? 'שויכה לפרויקט: <b>' + esc((D().projects.find(p => p.id === pid) || {}).title || '') + '</b>' : 'הוצאה מהפרויקט') + '</span><button data-act="toastClose" aria-label="סגור">✕</button>', 3500); } return; } // projects board: drop on a project to assign the action
  if (target.startsWith('q:')) { const q = target.slice(2) === 'none' ? '' : target.slice(2); if ((t.quad || '') !== q) { t.quad = q; t.priority = q ? quadPri[q] : 0; Store.save(); render(); } return; } // the priority matrix: drop on a square to set urgent / important
  const nd = target === 'none' ? null : target;
  if (t.date !== nd) { deferTo(t, nd); Store.save(); render(); nudgeAny([t.id]); }
}
document.addEventListener('pointerdown', e => {
  const card = e.target.closest('.ucard');
  if (!card || e.target.closest('.check') || (e.pointerType === 'mouse' && e.button !== 0)) return;
  Object.assign(Drag, { el: card, id: card.dataset.task, sx: e.clientX, sy: e.clientY, pid: e.pointerId, active: false });
  if (e.pointerType !== 'mouse') Drag.timer = setTimeout(() => dragStart(Drag.sx, Drag.sy), 380);
});
document.addEventListener('pointermove', e => {
  if (!Drag.el || e.pointerId !== Drag.pid) return;
  if (Drag.active) return dragMove(e.clientX, e.clientY);
  if (Math.hypot(e.clientX - Drag.sx, e.clientY - Drag.sy) > 8) {
    if (e.pointerType === 'mouse') dragStart(e.clientX, e.clientY); else dragReset(); // touch moved before long-press: let it scroll
  }
});
document.addEventListener('pointerup', e => { if (Drag.el && e.pointerId === Drag.pid) dragEnd(true); });
document.addEventListener('pointercancel', e => { if (Drag.el && e.pointerId === Drag.pid) dragEnd(false); });
document.addEventListener('touchmove', e => { if (Drag.active) e.preventDefault(); }, { passive: false });
document.addEventListener('click', e => { if (Drag.suppressClick) { e.stopPropagation(); e.preventDefault(); } }, true);
document.addEventListener('contextmenu', e => { if (Drag.el && e.target.closest('.ucard')) e.preventDefault(); });

/* ---------- Demo mode (?demo): fictional data, own storage key, cloud disabled. The real data is never touched. ---------- */
function seedDemo() {
  const T = TODAY(), id = uid, ago = n => addDays(T, -n);
  const j1 = id(), j2 = id(), v1 = id(), v2 = id(), v3 = id(), p1 = id(), h1 = id(), h2 = id(), h3 = id();
  const task = (title, date, extra = {}) => ({ id: id(), title, date, done: false, priority: 0, energy: 3, mins: 15, brainless: false, print: false, visionId: '', projectId: '', notes: '', subs: [], ...extra });
  const d = empty();
  d.visions = [
    { id: v1, title: 'בריאות ואנרגיה לאורך היום', desc: 'להרגיש חזק ורגוע, עם שגרת תנועה קבועה.', area: 'בריאות' },
    { id: v2, title: 'עסק קטן שמצליח', desc: 'לקוחות מרוצים והכנסה יציבה בלי לחץ.', area: 'קריירה' },
    { id: v3, title: 'זמן איכות עם המשפחה', desc: 'ערבים בלי מסכים וטיול חודשי.', area: 'משפחה' }
  ];
  d.v = 3;
  d.dayRewards = [{ id: id(), title: 'קפה בבית קפה' }, { id: id(), title: 'פרק שוקולד' }, { id: id(), title: 'סרט בערב' }];
  d.rhythm = [{ id: id(), label: 'ארוחת צהריים', time: '13:00', mins: 30, kind: 'meal' }, { id: id(), label: 'מנוחה קצרה', time: '16:00', mins: 20, kind: 'rest' }];
  d.dayLog[ago(1)] = { start: '08:10', end: '18:40' }; d.dayLog[ago(2)] = { start: '08:30', end: '17:55' };
  d.projects = [{ id: p1, title: 'השקת האתר החדש', createdAt: ago(5), icon: '🚀', status: 'focus', why: 'כדי שאנשים יגיעו אליי בלי שאצטרך לרדוף אחריהם', outcome: 'אתר חי שמביא פניות', values: ['יצירתיות', 'חופש'], feel: 'רגוע וסקרן', due: addDays(TODAY(), 40), prio: 'high', hours: 4, area: 'a2' }, { id: j2, title: 'לפרסם פוסט על הפרויקט', createdAt: ago(2) }];
  d.jobs = [];
  d.habits = [
    { id: h1, title: 'פעילות גופנית', task: 'ללכת 15 דקות סביב הבלוק', days: [0, 1, 2, 3, 4, 5, 6], mins: 15, energy: 4, visionId: v1, log: { [ago(1)]: true, [ago(2)]: true, [ago(3)]: true, [ago(5)]: true } },
    { id: h2, title: 'קריאה', task: 'לקרוא 10 עמודים בספר', days: [0, 1, 2, 3, 4], mins: 10, energy: 2, visionId: '', log: { [ago(1)]: true, [ago(4)]: true } },
    { id: h3, title: 'סיכום יום', task: 'לכתוב 3 שורות על מה שהצליח היום', days: [0, 1, 2, 3, 4, 5, 6], mins: 5, energy: 1, visionId: '', log: {} }
  ];
  d.tasks = [
    task('לכתוב הצעת מחיר ללקוח חדש', T, { energy: 5, priority: 2, visionId: v2 }),
    task('להתקשר לאינסטלטור ולקבוע ביקור', T, { energy: 2, mins: 10, brainless: true }),
    task('לשלוח חשבונית ללקוח דנה', T, { energy: 1, mins: 5, brainless: true, done: true }),
    task('להכין רשימת קניות לשבת', T, { energy: 1, mins: 10, repeat: 'w1' }),
    task('לבדוק עם המעצבת את דף הבית', addDays(T, 1), { energy: 3, projectId: p1 }),
    task('לתאם ארוחת ערב משפחתית', addDays(T, 2), { energy: 2, mins: 10, visionId: v3 }),
    task('לבחור נושא אחד לפוסט', ago(1), { energy: 2, mins: 5, visionId: v2, projectId: j2, done: true }),
    task('לכתוב טיוטה של 3 משפטים לפוסט', addDays(T, 3), { energy: 4, mins: 10, visionId: v2, projectId: j2 }),
    task('להעלות את הפוסט ולשלוח קישור לדנה', addDays(T, 4), { energy: 2, mins: 5, projectId: j2 }),
    task('לסרוק ולארגן קבלות החודש', addDays(T, 5), { energy: 2, mins: 15, print: true }),
    task('לבחור תמונת שער לאתר', ago(1), { energy: 2, projectId: p1, done: true })
  ];
  d.goals = [
    { id: id(), title: 'ללכת 20 ימים החודש', type: 'habit', habitId: h1, target: 20, unit: 'ימים', start: T.slice(0, 8) + '01', deadline: '', visionId: v1, reward: 'ארוחה במסעדה', entries: [], claimed: false },
    { id: id(), title: 'לקרוא 300 עמודים', type: 'manual', habitId: '', target: 300, unit: 'עמודים', start: ago(14), deadline: addDays(T, 30), visionId: '', reward: 'ספר חדש', entries: [{ amt: 80, date: ago(10) }, { amt: 60, date: ago(3) }], claimed: false }
  ];
  d.lists = [{ id: id(), title: 'קניות לשבת', items: [{ id: id(), text: 'ירקות', done: true }, { id: id(), text: 'פירות', done: false }, { id: id(), text: 'לחם', done: false }] }];
  d.weeks[weekStart(T)] = { vision: 'שבוע של התקדמות רגועה', outcomes: [{ id: id(), text: 'לשלוח הצעת מחיר אחת', done: false }, { id: id(), text: 'ללכת ארבעה ימים', done: false }], visionIds: [v1, v2], worked: '', improve: '' };
  d.notes[T] = 'הבוקר התחלתי עם הליכה, ההרגשה טובה.';
  d.notes[ago(1)] = 'יום עמוס אבל סגרתי את מה שחשוב.';
  d.journal[ago(1)] = { photo: '', wins: [{ id: id(), text: 'סיימתי את עיצוב הלוגו' }, { id: id(), text: 'הלכתי למרות העייפות' }] };
  d.focus[T] = { mit: '', mitId: d.tasks[0].id, fun: 'קפה עם חברה בערב' };
  Store.data = d; Store.save();
}
if (DEMO && !localStorage.getItem(KEY)) seedDemo();

ensureDayStart();
render();
Cloud.init();
{ // intro splash, once per session (FitMe-style): the check mark draws itself, then fades out
  const sp = $('#splash');
  if (sp) {
    let seen = false; try { seen = !!sessionStorage.getItem('doit-splash'); sessionStorage.setItem('doit-splash', '1'); } catch (e) {}
    if (seen) sp.remove(); else { sp.addEventListener('animationend', e => { if (e.animationName === 'splash') sp.remove(); }); setTimeout(() => sp.remove(), 2200); }
  }
}
ensureDayStart(); setTimeout(() => { askMorning(); }, 2400); // after the splash and the first cloud sync
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  const hadController = !!navigator.serviceWorker.controller; // an update replaces an older worker: reload once so the new version is the one on screen
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !window.__swReloaded) { window.__swReloaded = true; location.reload(); } });
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
