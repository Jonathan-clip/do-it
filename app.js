'use strict';
/* ---------- Storage (local now; cloud adapter plugs in here later) ---------- */
const DEMO = /(^|[?&#])demo(\b|=)/.test(location.search + location.hash); // ?demo => fictional data, separate storage, no cloud
const KEY = DEMO ? 'doit-demo-v1' : 'doit-data-v1';
const empty = () => ({ visions: [], tasks: [], habits: [], lists: [], goals: [], projects: [], weeks: {}, notes: {}, journal: {}, focus: {}, org: {} });
const TS_KEY = DEMO ? 'doit-demo-updated-v1' : 'doit-updated-v1';
const SYNC_KEY = DEMO ? 'doit-demo-synced-v1' : 'doit-synced-v1';
const COLS = ['visions', 'tasks', 'habits', 'lists', 'goals', 'projects'], MAPS = ['weeks', 'notes', 'journal', 'focus', 'org'];
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
    this.resnap();
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
  return out;
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
      Store.data = Object.assign(empty(), row.data); Store.resnap();
      try { localStorage.setItem(KEY, JSON.stringify(Store.data)); localStorage.setItem(TS_KEY, row.updated_at); localStorage.setItem(SYNC_KEY, row.updated_at); } catch (e) {}
      this.status = 'ok'; render();
    } else if (row && cloudNew && dirty) { // both sides changed (e.g. phone and computer): merge, never overwrite
      Store.data = mergeData(Store.data, Object.assign(empty(), row.data)); Store.resnap();
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
const MORE_TABS = ['journal', 'tasks', 'projects', 'habits', 'goals', 'vision', 'lists'];
const state = { tab: 'today', date: TODAY(), upStart: TODAY(), upDays: 14, upMode: 'three', up3: TODAY(), upWeek: weekStart(TODAY()), upMonth: TODAY().slice(0, 7), upSel: TODAY(), taskFilter: 'open', jDate: TODAY(), openList: null, openProject: null, goalFilter: 'active', weekStart: weekStart(TODAY()) };
// Weekly vision data lives in D().weeks[<Sunday date>]; created lazily on first edit.
const weekData = ws => (D().weeks[ws] = D().weeks[ws] || { vision: '', outcomes: [], visionIds: [], worked: '', improve: '' });

/* ---------- Domain ---------- */
// High-energy tasks always come first in the day; then by priority.
const taskOrder = (d, a, b) => { // today's order follows the energy mode chosen by the user; unset keeps "high energy first"
  const m = d === TODAY() ? ((D().focus[d] || {}).energy || '') : '', e = x => x.energy || 3, p = x => x.priority || 0;
  if (m === 'low') return e(a) - e(b) || p(b) - p(a);
  if (m === 'mid') return p(b) - p(a) || e(b) - e(a);
  return (b.energy || 0) - (a.energy || 0) || p(b) - p(a);
};
const tasksOn = d => D().tasks.filter(t => t.date === d).sort((a, b) => taskOrder(d, a, b));
const stars = n => '★'.repeat(n || 0);
const logoMark = (s = 32) => `<svg class="logo" width="${s}" height="${s}" viewBox="0 0 512 512" role="img" aria-label="Do It"><rect width="512" height="512" rx="112" fill="#1f6f5c"/><path d="M130 270l90 90 170-190" fill="none" stroke="#fff" stroke-width="52" stroke-linecap="round" stroke-linejoin="round"/><circle cx="390" cy="170" r="36" fill="#e8a33d"/></svg>`;
/* Projects: a project groups several tasks (task.projectId). Deleting a project keeps its tasks. */
const projectName = id => (D().projects.find(p => p.id === id) || {}).title;
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
const ENERGY_MODES = [['low', '🪫 נמוכה'], ['mid', '🙂 בינונית'], ['high', '⚡ גבוהה']];
function energyBar(d) {
  if (d !== TODAY()) return '';
  const cur = focusOn(d).energy;
  return `<div class="ebar"><span class="sub">האנרגיה שלי עכשיו:</span>${ENERGY_MODES.map(([v, l]) => `<button class="${cur === v ? 'on' : ''}" data-act="setEnergy" data-v="${v}">${l}</button>`).join('')}</div>`;
}
function tasksBlock(d, ts) {
  const open = ts.filter(t => !t.done), f = focusOn(d);
  const rows = list => list.map(t => taskRow(t)).join('');
  if (!ts.length) return d === TODAY() ? '' : '<div class="empty">אין משימות ליום הזה</div>';
  if (state.showAll) return rows(ts) + (open.length > 3 ? '<button class="btn ghost more3" data-act="toggleShowAll">הצג רק שלוש</button>' : '');
  const first = open.filter(t => t.id === f.mitId), pick = [...first, ...open.filter(t => t.id !== f.mitId)].slice(0, 3);
  const hidden = ts.length - pick.length;
  return (pick.length ? rows(pick) : '<div class="empty">🎉 סיימת את כל המשימות להיום</div>')
    + (hidden > 0 ? `<button class="btn ghost more3" data-act="toggleShowAll">הצג את כל המשימות (${hidden} נוספות)</button>` : '');
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
  const n = nextTask(doneId);
  if (!n) { toast('<span>🎉 סיימת את משימות היום</span><button data-act="toastClose">✕</button>', 5000); return; }
  toast(`<span>מה הדבר הבא? <b>${esc(n.title)}</b></span><button class="btn" data-act="runStart" data-id="${n.id}">התחל</button><button class="btn ghost" data-act="runBreak">☕ הפסקה</button><button data-act="toastClose" aria-label="סגור">✕</button>`);
}
/* Quick capture: one field, no date/energy/priority; classified later in the daily "ארגון" */
let captured = 0;
function captureSheet() {
  sheet(`<h1>💭 זרוק מחשבה</h1><p class="sub">רק לכתוב. תארגן אחר כך בתהליך "ארגון".</p>
   <form id="capForm" class="row"><input id="capText" placeholder="מה עולה לך?" autocomplete="off" autofocus><button class="btn">הוסף</button></form>
   <div id="capDone" class="sub" style="margin-top:8px">${captured ? `נקלטו ${captured} ✓` : ''}</div>
   <div class="actions"><button class="btn ghost" data-act="close">סגור</button></div>`);
  $('#capForm').onsubmit = e => {
    e.preventDefault(); const txt = $('#capText').value.trim(); if (!txt) return;
    D().tasks.push({ id: uid(), title: txt, date: null, done: false, priority: 0, energy: 0, mins: 0, brainless: false, print: false, visionId: '', projectId: '', notes: '', subs: [], inbox: true });
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
function runOpen(id, brk) {
  clearInterval(Run.tick); closeSheet();
  Object.assign(Run, { id: brk ? null : id, brk: !!brk, running: false, ended: false });
  const t = findTask(id);
  const pick = brk ? 5 : [5, 15, 25].reduce((a, m) => Math.abs(m - ((t && t.mins) || 15)) < Math.abs(a - ((t && t.mins) || 15)) ? m : a, 15);
  Run.total = Run.left = pick * 60; runRender(); $('#run').hidden = false; document.body.classList.add('running');
}
function runClose() { clearInterval(Run.tick); Run.running = false; $('#run').hidden = true; document.body.classList.remove('running'); render(); }
function runRender() {
  const t = Run.brk ? null : findTask(Run.id), el = $('#run');
  if (!Run.brk && !t) return runClose();
  const step = t ? ((t.subs || []).find(s => !s.done) || {}).title || t.first || '' : '';
  const mins = Run.brk ? [5, 10] : [5, 15, 25];
  el.innerHTML = `<div class="runbox">
    <button class="iconbtn runx" data-act="runClose" aria-label="סגור">✕</button>
    <div class="sub">${Run.brk ? 'הפסקה' : 'עכשיו עובדים על'}</div>
    <h1>${Run.brk ? '☕ נושמים קצת' : esc(t.title)}</h1>
    ${Run.brk ? '' : `<label class="sub">הצעד הראשון</label><input id="runStep" value="${esc(step)}" placeholder="מה הדבר הראשון והקטן שעושים?" autocomplete="off" ${(t.subs || []).some(s => !s.done) ? 'readonly' : ''}>`}
    <div class="opt runmins">${mins.map(m => `<button class="${Run.total === m * 60 ? 'on' : ''}" data-act="runMins" data-m="${m}" ${Run.running ? 'disabled' : ''}>${m} ד׳</button>`).join('')}</div>
    <div class="runtime ${Run.ended ? 'end' : ''}" id="runTime">${mmss(Run.left)}</div>
    ${Run.ended ? `<div class="sub" style="text-align:center">${Run.brk ? 'ההפסקה נגמרה' : 'הזמן נגמר. איך הלך?'}</div>` : ''}
    <div class="grid2">
      ${Run.ended ? (Run.brk ? '<button class="btn" data-act="runNext">חזרה לעבודה</button>' : '<button class="btn" data-act="runDone">✓ סיימתי</button><button class="btn ghost" data-act="runMore">עוד 5 דקות</button>')
        : `<button class="btn" data-act="runToggle">${Run.running ? '⏸ השהה' : '▶ התחל'}</button>${Run.brk ? '<button class="btn ghost" data-act="runNext">דלג</button>' : '<button class="btn ghost" data-act="runDone">✓ סיימתי</button>'}`}
      ${Run.brk ? '' : '<button class="btn ghost" data-act="stuck">🤝 נתקעתי</button>'}
    </div></div>`;
  const si = $('#runStep'); if (si) si.oninput = () => { t.first = si.value; Store.save(); };
}
function runTick() {
  Run.left = Math.max(0, Math.round((Run.endAt - Date.now()) / 1000));
  const el = $('#runTime'); if (el) el.textContent = mmss(Run.left);
  if (Run.left <= 0) { clearInterval(Run.tick); Run.running = false; Run.ended = true; runBeep(); runRender(); }
}
function runStartTimer() { Run.endAt = Date.now() + Run.left * 1000; Run.running = true; clearInterval(Run.tick); Run.tick = setInterval(runTick, 250); runRender(); }
function stuckSheet() {
  const T = TODAY(), t = findTask(Run.id), easy = t && tasksOn(T).filter(x => !x.done && x.id !== t.id).sort((a, b) => (a.energy || 3) - (b.energy || 3))[0];
  sheet(`<h1>זה קורה 🤝</h1><p class="sub">בוא נקל על זה. בחר מה מתאים עכשיו:</p>
   <div class="grid2">
     <button class="btn ghost" data-act="stuckSmall">🔹 לפרק לצעד קטן יותר</button>
     <button class="btn ghost" data-act="stuckTwo">⏱ רק שתי דקות</button>
     ${easy ? `<button class="btn ghost" data-act="stuckEasy" data-id="${easy.id}">🍃 למשימה קלה: ${esc(easy.title)}</button>` : ''}
     <button class="btn ghost" data-act="stuckLater">📆 לחזור אליה אחר כך</button>
   </div><div class="actions"><button class="btn ghost" data-act="stuckClose">חזרה</button></div>`);
}
/* ---------- Daily focus: the most important task and the "fun" of the day; asked at the start of the day when missing ---------- */
const focusOn = d => { const f = D().focus[d] || {}, t = f.mitId ? D().tasks.find(x => x.id === f.mitId) : null; return { mit: t ? t.title : (f.mit || ''), mitId: t ? t.id : '', fun: f.fun || '', energy: f.energy || '' }; };
function focusCard(d) {
  const f = focusOn(d);
  if (!f.mit && !f.fun) return `<div class="card focus" data-act="focusEdit"><div class="t"><b>⭐ מה החשוב היום, ומה הפאן?</b></div><div class="sub">לחץ כדי לקבוע</div></div>`;
  return `<div class="card focus" data-act="focusEdit"><div class="frow"><span>⭐</span><div class="grow"><div class="sub">המשימה החשובה של היום</div><div class="t">${f.mit ? esc(f.mit) : '—'}</div></div></div>
    <div class="frow"><span>🎉</span><div class="grow"><div class="sub">הפאן של היום</div><div class="t">${f.fun ? esc(f.fun) : '—'}</div></div></div>
    ${f.mit && d === TODAY() && !(f.mitId && (D().tasks.find(x => x.id === f.mitId) || {}).done) ? `<button class="btn startnow" data-act="runStart" data-id="${f.mitId}">▶ התחל עכשיו</button>` : ''}</div>`;
}
let focusSnooze = false;
function focusSheet(d) {
  const f = focusOn(d), open = D().tasks.filter(t => !t.done && t.date === d).sort((a, b) => (b.energy || 0) - (a.energy || 0) || (b.priority || 0) - (a.priority || 0)).slice(0, 6);
  sheet(`<h1>${d === TODAY() ? 'בוקר טוב 👋' : 'מיקוד היום'}</h1>
  <form id="f">
   <label>⭐ מה המשימה החשובה ביותר היום?</label>
   <input name="mit" value="${esc(f.mit)}" autocomplete="off" placeholder="כתוב, או בחר ממשימות היום">
   <input type="hidden" name="mitId" value="${f.mitId}">
   ${open.length ? '<div class="opt" style="margin-top:6px">' + open.map(t => '<button type="button" data-act="focusPick" data-id="' + t.id + '">' + esc(t.title) + '</button>').join('') + '</div>' : ''}
   <label>🎉 מה הפאן של היום? (משהו שמשמח אותך לקראתו)</label>
   <input name="fun" value="${esc(f.fun)}" autocomplete="off" placeholder="למשל: קפה עם חברה, סרט בערב, הליכה בשקיעה">
   <label>🔋 איך האנרגיה שלך עכשיו?</label><div class="opt" id="enOpts">${ENERGY_MODES.map(([v, l]) => `<button type="button" class="${f.energy === v ? 'on' : ''}" onclick="const f=this.closest('form');f.energy.value='${v}';this.parentNode.querySelectorAll('button').forEach(b=>b.classList.remove('on'));this.classList.add('on')">${l}</button>`).join('')}</div><input type="hidden" name="energy" value="${f.energy}">
   <div class="actions"><button type="button" class="btn ghost" data-act="focusLater">אחר כך</button><button class="btn">שמור</button></div>
  </form>`);
  $('#f').mit.addEventListener('input', () => { $('#f').mitId.value = ''; });
  $('#f').onsubmit = e => {
    e.preventDefault(); const fd = new FormData(e.target);
    D().focus[d] = { mit: fd.get('mit').trim(), mitId: fd.get('mitId') || '', fun: fd.get('fun').trim(), energy: fd.get('energy') || '' };
    Store.save(); closeSheet(); render();
  };
}
function askFocus() { // start-of-day prompt: only for today, only if something is missing, never over another open sheet
  const f = focusOn(TODAY());
  if (focusSnooze || (f.mit && f.fun && f.energy) || !$('#sheet').hidden) return;
  focusSheet(TODAY());
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
  const subsHtml = (t.subs && t.subs.length && !t.collapsed) ? `<div class="subs">${t.subs.map(s => `<div class="row ${s.done ? 'done' : ''}"><button class="check ${s.done ? 'on' : ''}" data-act="subToggle" data-id="${t.id}" data-sid="${s.id}">${s.done ? '✓' : ''}</button><div class="t grow" data-act="taskMenu" data-id="${t.id}">${esc(s.title)}${s.mins ? ` <span class="sub">· ${s.mins} ד׳</span>` : ''}</div></div>`).join('')}</div>` : '';
  return `<div class="grp"><div class="card row p${t.priority} ${t.done ? 'done' : ''}">
    <button class="check ${t.done ? 'on' : ''}" data-act="toggleTask" data-id="${t.id}">${t.done ? '✓' : ''}</button>
    <div class="grow" data-act="taskMenu" data-id="${t.id}">
      <div class="t">${esc(t.title)}</div>
      <div class="meta">${t.brainless ? '<span class="chip" style="background:var(--warn-bg);color:var(--warn-ink)">⚡ Brainless</span>' : ''}${showDate && t.date ? `<span>${shortDate(t.date)}</span>` : ''}${t.energy ? `<span style="color:var(--accent)">${stars(t.energy)}</span>` : ''}${t.mins ? `<span>${t.mins} ד׳</span>` : ''}${subToggle(t)}${t.print ? '<span>🖨</span>' : ''}${t.inbox ? '<span>📥 נקלט</span>' : ''}${t.parked ? '<span>📦 מאגר</span>' : ''}${focusOn(t.date || '').mitId === t.id ? '<span class="chip" style="background:var(--warn-bg);color:var(--warn-ink)">⭐ החשובה</span>' : ''}${t.repeat ? `<span title="${repeatLabel(t.repeat)}">🔁 ${repeatLabel(t.repeat)}</span>` : ''}${projectChip(t)}${v ? `<span class="chip">${esc(v)}</span>` : ''}</div>
    </div></div>${subsHtml}</div>`;
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
function upCard(t, showDate) {
  const v = t.brainless ? '<span class="chip" style="background:var(--warn-bg);color:var(--warn-ink)">⚡ Brainless</span>' : '';
  const subs = (t.subs && t.subs.length && !t.collapsed) ? `<div class="usubs">${t.subs.map(s => `<div class="urow ${s.done ? 'done' : ''}"><button class="check ${s.done ? 'on' : ''}" data-act="subToggle" data-id="${t.id}" data-sid="${s.id}">${s.done ? '✓' : ''}</button><div class="t grow" data-act="taskMenu" data-id="${t.id}">${esc(s.title)}${s.mins ? ` <span class="sub">· ${s.mins} ד׳</span>` : ''}</div></div>`).join('')}</div>` : '';
  return `<div class="ucard p${t.priority} ${t.done ? 'done' : ''}" data-task="${t.id}"><div class="urow">
    <button class="check ${t.done ? 'on' : ''}" data-act="toggleTask" data-id="${t.id}">${t.done ? '✓' : ''}</button>
    <div class="grow" data-act="taskMenu" data-id="${t.id}"><div class="t">${esc(t.title)}</div>
    <div class="meta">${v}${showDate && t.date ? `<span style="color:var(--danger)">${shortDate(t.date)}</span>` : ''}${t.energy ? `<span style="color:var(--accent)">${stars(t.energy)}</span>` : ''}${t.mins ? `<span>${t.mins} ד׳</span>` : ''}${subToggle(t)}${projectChip(t)}</div></div></div>${subs}</div>`;
}
const upCol = (drop, head, count, body, extra = '') => `<section class="ucol" data-drop="${drop}"><div class="uhead"><b>${head}</b><span class="sub">${count}</span>${extra}</div>${body}</section>`;

const views = {
  today() {
    const d = state.date, ts = tasksOn(d), hs = habitsOn(d);
    const isToday = d === TODAY(); // the daily "ארגון" ritual counts as one item on today's list
    const total = ts.length + hs.length + (isToday ? 1 : 0), done = ts.filter(t => t.done).length + hs.filter(h => habitDone(h, d)).length + (isToday && orgDone(d) ? 1 : 0);
    const pct = total ? Math.round(done / total * 100) : 0;
    return `<div class="top"><div class="brand">${logoMark(36)}<div><h1>${d === TODAY() ? 'היום' : 'יום נבחר'}</h1><div class="sub">${longDate(d)}</div></div></div>
      <div class="sw"><button class="iconbtn" data-act="account" title="סנכרון וחשבון">${Cloud.status === 'ok' ? '☁️' : Cloud.status === 'syncing' ? '🔄' : Cloud.status === 'error' ? '⚠️' : '👤'}</button><button class="iconbtn" data-act="shift" data-n="-1" aria-label="היום הקודם">${chev('r')}</button><button class="iconbtn" data-act="goToday">היום</button><button class="iconbtn" data-act="shift" data-n="1" aria-label="היום הבא">${chev('l')}</button></div></div>
      <div class="card"><div class="row"><b class="grow">${done}/${total} הושלמו${(() => { const m = ts.filter(t => !t.done).reduce((s, t) => s + (t.mins || 0), 0) + hs.filter(h => !habitDone(h, d)).reduce((s, h) => s + (h.mins || 0), 0); return m ? ` · נותרו ${m} ד׳` : ''; })()}</b></div><div class="bar"><div style="width:${pct}%"></div></div></div>
      ${focusCard(d)}
      <div class="opt" style="margin-bottom:6px"><button data-act="printDayAll">🖨 הדפס את כל משימות היום</button><button data-act="printDay">🖨 רק פתוחות/מסומנות</button><button data-act="addBulk">📋 הזנה מרוכזת</button></div>
      ${energyBar(d)}
      <h2>משימות</h2>${isToday ? orgCard() : ''}${tasksBlock(d, ts)}
      ${hs.length ? `<h2>הרגלים</h2>${hs.map(h => habitRow(h, d)).join('')}` : ''}
      <h2>פתק יומי</h2><textarea id="note" placeholder="מחשבות, סיכום, דברים לזכור...">${esc(D().notes[d] || '')}</textarea>
      <button class="fab" data-act="addTask" aria-label="משימה חדשה">+</button>`;
  },
  upcoming() {
    // Todoist-style board in three modes: days (rolling), week, month. Everything is laid out right-to-left.
    const T = TODAY(), mode = state.upMode;
    const label = d => d === T ? 'היום' : d === addDays(T, 1) ? 'מחר' : 'יום ' + DAYN[parse(d).getDay()];
    const dayCol = d => { const ts = tasksOn(d); return upCol(d, `${shortDate(d)} · ${label(d)}`, ts.length, `<button class="uadd" data-act="addTaskOn" data-date="${d}">＋ הוסף משימה</button>${ts.map(t => upCard(t)).join('')}`); };
    const curYM = mode === 'month' ? state.upMonth : state.upStart.slice(0, 7);
    const ymList = Array.from({ length: 14 }, (_, i) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 2 + i); return fmt(d).slice(0, 7); });
    if (!ymList.includes(curYM)) { ymList.push(curYM); ymList.sort(); }
    const monthSel = `<select id="upMonth" style="width:auto">${ymList.map(v => { const [y, m] = v.split('-').map(Number); return `<option value="${v}" ${v === curYM ? 'selected' : ''}>${MONTHS[m - 1]} ${y}</option>`; }).join('')}</select>`;
    const navRow = lbl => `<div class="row" style="margin:6px 0 10px"><button class="iconbtn" data-act="upNav" data-n="-1" aria-label="הקודם">${chev('r')}</button><b class="grow" style="text-align:center">${lbl}</b><button class="iconbtn" data-act="upNav" data-n="1" aria-label="הבא">${chev('l')}</button><button class="iconbtn" data-act="upToday">היום</button></div>`;
    let nav = '', body = '';
    if (mode === 'week') {
      const ws = state.upWeek;
      nav = navRow(`${shortDate(ws)} – ${shortDate(addDays(ws, 6))}`);
      body = `<div class="uboard week" id="uboard">${Array.from({ length: 7 }, (_, i) => dayCol(addDays(ws, i))).join('')}</div>`;
    } else if (mode === 'three') {
      const s3 = state.up3;
      nav = navRow(`${shortDate(s3)} – ${shortDate(addDays(s3, 2))}`);
      body = `<div class="uboard three" id="uboard">${Array.from({ length: 3 }, (_, i) => dayCol(addDays(s3, i))).join('')}</div>`;
    } else if (mode === 'month') {
      const [y, m] = state.upMonth.split('-').map(Number), first = new Date(y, m - 1, 1), st = new Date(y, m - 1, 1 - first.getDay());
      let cells = DAYS.map(x => `<div class="mh">${x}</div>`).join('');
      for (let i = 0; i < 42; i++) {
        const c = new Date(st); c.setDate(st.getDate() + i);
        const s = fmt(c), ts = tasksOn(s);
        cells += `<div class="mcell ${c.getMonth() !== m - 1 ? 'out' : ''} ${s === T ? 'today' : ''} ${s === state.upSel ? 'sel' : ''}" data-drop="${s}" data-act="upPick" data-date="${s}"><span class="mnum">${c.getDate()}</span>${ts.slice(0, 3).map(t => `<div class="ucard mini ${t.done ? 'done' : ''}" data-task="${t.id}" data-act="taskMenu" data-id="${t.id}"><span class="t">${esc(t.title)}</span></div>`).join('')}${ts.length > 3 ? `<span class="mmore">+${ts.length - 3}</span>` : ''}</div>`;
      }
      const sel = state.upSel, sts = tasksOn(sel);
      nav = navRow(`${MONTHS[m - 1]} ${y}`);
      body = `<div class="mgrid">${cells}</div><h2>${longDate(sel)}</h2>
        <section class="ucol msel" data-drop="${sel}"><button class="uadd" data-act="addTaskOn" data-date="${sel}">＋ הוסף משימה</button>${sts.map(t => upCard(t)).join('') || '<div class="empty">אין משימות ליום הזה</div>'}</section>`;
    } else {
      const start = state.upStart, days = Array.from({ length: state.upDays }, (_, i) => addDays(start, i));
      const undated = D().tasks.filter(t => !t.date && !t.done);
      body = `<div class="uboard" id="uboard">
        ${days.map(dayCol).join('')}
        <section class="ucol umore"><button class="uadd" data-act="upMore">＋ עוד שבועיים</button></section>
        ${upCol('none', 'ללא תאריך', undated.length, `<button class="uadd" data-act="addTaskOn" data-date="">＋ הוסף משימה</button>${undated.map(t => upCard(t)).join('')}`)}
      </div>`;
    }
    return `<div class="top"><h1>בקרוב</h1><div class="sw">${mode === 'week' || mode === 'three' ? '' : monthSel}<button class="iconbtn" data-act="printWeek">🖨 שבוע</button></div></div>
      <div class="seg">${[['three', '3 ימים'], ['week', 'שבוע'], ['month', 'חודש'], ['days', 'כל הימים']].map(([k, l]) => `<button class="${mode === k ? 'on' : ''}" data-act="upMode" data-m="${k}">${l}</button>`).join('')}</div>
      ${nav}${body}
      <div class="sub" style="margin-top:6px">גרור משימה (במגע: לחיצה ארוכה) כדי להעביר אותה ליום אחר.</div>`;
  },
  tasks() {
    const f = state.taskFilter;
    let list = D().tasks.slice();
    if (f === 'open') list = list.filter(t => !t.done);
    if (f === 'done') list = list.filter(t => t.done);
    if (f === 'nodate') list = list.filter(t => !t.date && !t.done);
    if (f === 'brainless') list = list.filter(t => t.brainless && !t.done);
    list.sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999') || b.priority - a.priority);
    const F = [['open', 'פתוחות'], ['brainless', '⚡ Brainless'], ['nodate', 'ללא תאריך'], ['done', 'הושלמו'], ['all', 'הכל']];
    return `<div class="top"><h1>משימות</h1><div class="sw"><button class="iconbtn" data-act="addBulk">📋 הזנה מרוכזת</button><button class="iconbtn" data-act="printSel">🖨 נבחרות</button></div></div>
      <div class="seg">${F.map(([k, l]) => `<button class="${f === k ? 'on' : ''}" data-act="filter" data-f="${k}">${l}</button>`).join('')}</div>
      ${list.map(t => taskRow(t, true)).join('') || '<div class="empty">אין משימות</div>'}
      <button class="fab" data-act="addTask">+</button>`;
  },
  habits() {
    const d = TODAY(), last7 = Array.from({ length: 7 }, (_, i) => addDays(d, i - 6));
    return `<div class="top"><h1>הרגלים</h1><button class="iconbtn" data-act="addHabitBulk">📋 הזנה מרוכזת</button></div>
      ${D().habits.map(h => {
        const v = h.visionId ? visionName(h.visionId) : '';
        return `<div class="card"><div class="row"><div class="grow" data-act="editHabit" data-id="${h.id}"><div class="t"><b>${esc(h.title)}</b></div>${h.task ? `<div class="sub">המשימה: ${esc(h.task)}${h.mins ? ` · ${h.mins} ד׳` : ''}${h.energy ? ' ' + stars(h.energy) : ''}</div>` : ''}
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
        <div class="meta"><span>✅ ${dn}/${ts.length} משימות</span><span>🔁 ${hs.length} הרגלים</span><span>🎯 ${D().goals.filter(x => x.visionId === v.id).length} יעדים</span>${v.area ? `<span class="chip">${esc(v.area)}</span>` : ''}</div></div>`;
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
      <div class="card"><div class="row"><b class="grow">${wdone}/${wt.length} משימות · ${pct}%</b><span class="sub">${left} ד׳ נותרו</span></div><div class="bar"><div style="width:${pct}%"></div></div>
        <div class="row" style="margin-top:8px"><b class="grow">הרגלים: ${hDone}/${hPlan} · ${hp}%</b></div><div class="bar"><div style="width:${hp}%"></div></div>
        <div class="wbar" style="margin-top:12px">${days.map((d, i) => { const ts = tasksOn(d), dn = ts.filter(t => t.done).length; return `<div class="wcol" data-act="openDay" data-date="${d}"><div class="wfill" style="height:${Math.round(ts.length / maxN * 100)}%"><div class="wdone" style="height:${ts.length ? Math.round(dn / ts.length * 100) : 0}%"></div></div><span class="${d === T ? 'wtoday' : ''}">${DAYS[i]}</span><small>${ts.length}</small></div>`; }).join('')}</div></div>
      <h2>סיכום שבועי</h2>
      <label>מה עבד השבוע?</label><textarea data-weekfield="worked" placeholder="מה הלך טוב ורוצה להמשיך">${esc(W.worked)}</textarea>
      <label>מה לשפר בשבוע הבא?</label><textarea data-weekfield="improve" placeholder="מה לשנות, לפשט או להפסיק">${esc(W.improve)}</textarea>`;
  },
  projects() {
    if (state.openProject) {
      const p = D().projects.find(x => x.id === state.openProject);
      if (p) {
        const s = projState(p), open = s.ts.filter(t => !t.done), done = s.ts.filter(t => t.done);
        return `<div class="top"><div class="row"><button class="iconbtn" data-act="backProjects" aria-label="חזרה">${chev('r')}</button><h1>${esc(p.title)}</h1></div><div class="sw"><button class="iconbtn" data-act="renameProject" data-id="${p.id}" aria-label="שנה שם">✏️</button><button class="iconbtn" data-act="delProject" data-id="${p.id}" aria-label="מחק">🗑</button></div></div>
         <div class="card"><div class="row"><b class="grow">${s.done}/${s.total} משימות הושלמו</b><span class="sub">${s.mins} ד׳ נותרו</span></div><div class="bar"><div style="width:${s.pct}%"></div></div></div>
         <div class="opt" style="margin-bottom:10px"><button data-act="projAddTask" data-id="${p.id}">＋ משימה</button><button data-act="projBulk" data-id="${p.id}">📋 הזנה מרוכזת</button><button data-act="projAssign" data-id="${p.id}">🔗 שייך משימות קיימות</button></div>
         <h2>פתוחות (${open.length})</h2>${open.map(t => taskRow(t, true)).join('') || '<div class="empty">אין משימות פתוחות בפרויקט</div>'}
         ${done.length ? `<h2>הושלמו (${done.length})</h2>${done.map(t => taskRow(t, true)).join('')}` : ''}`;
      }
      state.openProject = null;
    }
    const ps = D().projects.map(p => ({ p, s: projState(p) }));
    return `<div class="top"><h1>פרויקטים</h1></div>
      ${ps.map(({ p, s }) => `<div class="card" data-act="openProject" data-id="${p.id}"><div class="row"><div class="grow"><div class="t"><b>📁 ${esc(p.title)}</b></div><div class="meta"><span>${s.done}/${s.total} משימות</span>${s.total && s.done === s.total ? '<span class="chip">✓ הושלם</span>' : ''}${s.mins ? `<span>${s.mins} ד׳ נותרו</span>` : ''}</div></div>${chev('l')}</div><div class="bar"><div style="width:${s.pct}%"></div></div></div>`).join('') || '<div class="empty">אגד משימות קשורות תחת פרויקט אחד, כדי לראות אותן ולהתקדם בהן יחד</div>'}
      <button class="fab" data-act="addProject">+</button>`;
  },
  more() {
    const gs = D().goals.map(goalState), activeG = gs.filter(s => !s.achieved && !s.missed).length;
    const wait = D().goals.filter(g => g.reward && !g.claimed && goalState(g).achieved).length;
    const item = (t, icon, title, sub) => `<div class="card row" data-act="goTab" data-t="${t}"><span style="font-size:26px">${icon}</span><div class="grow"><div class="t"><b>${title}</b></div><div class="meta">${sub}</div></div>${chev('l')}</div>`;
    return `<div class="top"><div class="brand">${logoMark(40)}<h1>Do It</h1></div></div>
      ${item('journal', '📓', 'יומן', `${journalDays().length} ימים עם רישום`)}
      ${item('tasks', '✅', 'כל המשימות', `${D().tasks.filter(t => !t.done).length} פתוחות`)}
      ${item('projects', '📁', 'פרויקטים', `${D().projects.filter(p => projState(p).done < projState(p).total).length} פעילים`)}
      ${item('habits', '🔁', 'הרגלים', `${D().habits.length} הרגלים`)}
      ${item('goals', '🎯', 'יעדים ותגמולים', `${activeG} פעילים${wait ? ` · 🎁 ${wait} ממתינים` : ''}`)}
      ${item('vision', '🌟', 'חזון', `${D().visions.length} פריטים`)}
      ${item('lists', '📝', 'רשימות', `${D().lists.length} רשימות`)}
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
  const board = $('#uboard'), boardScroll = board ? board.scrollLeft : null; // keep the board's horizontal position across re-renders
  document.body.classList.toggle('wide', state.tab === 'upcoming');
  $('#view').innerHTML = views[state.tab]();
  if (MORE_TABS.includes(state.tab) && !(state.tab === 'lists' && state.openList) && !(state.tab === 'projects' && state.openProject)) // back to the "עוד" menu
    $('#view').insertAdjacentHTML('afterbegin', `<button class="iconbtn backmore" data-act="goTab" data-t="more" aria-label="חזרה לעוד">${chev('r')}<span style="margin-inline-start:6px">עוד</span></button>`);
  if (DEMO) $('#view').insertAdjacentHTML('afterbegin', '<div class="demobar">מצב דמו · נתונים בדויים <button class="lnk" data-act="demoReset">אפס דמו</button></div>');
  if (boardScroll !== null && $('#uboard')) $('#uboard').scrollLeft = boardScroll;
  // Entrance animation (FitMe-style soft rise, staggered) only when the screen changes, not on every re-render.
  const view = $('#view'), key = state.tab + (state.tab === 'upcoming' ? state.upMode : '') + (state.openList || '');
  const enter = state.viewKey !== key; state.viewKey = key;
  view.classList.toggle('enter', enter);
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
    Store.save(); render(); $('#outText').focus();
  };
  const wf = $('#winForm');
  if (wf) wf.onsubmit = e => {
    e.preventDefault(); const txt = $('#winText').value.trim(); if (!txt) return;
    jSet(state.jDate).wins.push({ id: uid(), text: txt });
    Store.save(); render(); celebrate(); $('#winText').focus();
  };
  const ph = $('#jphoto');
  if (ph) ph.onchange = () => { const file = ph.files[0]; if (file) shrinkPhoto(file, url => { jSet(state.jDate).photo = url; Store.save(); render(); }); };
  const f = $('#itemForm');
  if (f) f.onsubmit = e => {
    e.preventDefault();
    const txt = $('#itemText').value.trim(); if (!txt) return;
    const l = D().lists.find(x => x.id === state.openList);
    l.items.push({ id: uid(), text: txt, done: false });
    Store.save(); render(); $('#itemText').focus();
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
  const t = id ? D().tasks.find(x => x.id === id) : { title: '', date: presetDate !== undefined ? presetDate : state.date, priority: 0, print: false, visionId: '', projectId: presetProject || '', notes: '', energy: 3, mins: 15, repeat: '', ...preset };
  const mo = [...new Set([5, 10, 15, 20, 30, 45, 60, 90, t.mins || 15])].sort((a, b) => a - b);
  sheet(`<h1>${id ? 'עריכת משימה' : 'משימה חדשה'}</h1>
  <form id="f">
   <label>מה לעשות (פעולה אחת, ברורה ומוחשית)</label><input name="title" required value="${esc(t.title)}" autofocus autocomplete="off">
   <div id="clHint" class="clarity">${id ? '' : clarityHTML('')}</div>
   <div id="clRow" hidden>
     <label class="row" style="color:var(--ink);font-weight:600;margin-top:6px"><input type="checkbox" name="clear" style="width:auto"> ✅ זה ברור: ${CLEAR_LABEL}</label>
     <div id="clMsg" class="sub" style="color:var(--danger)"></div>${CLARITY_EX}
   </div>
   <label>מתי?</label>
   <div class="opt" id="dateChips" style="margin-bottom:6px">${[['היום', TODAY()], ['מחר', addDays(TODAY(), 1)], ['ללא תאריך', '']].map(([l, v]) => `<button type="button" class="${(t.date || '') === v ? 'on' : ''}" onclick="const f=this.closest('form');f.elements.date.value='${v}';this.parentNode.querySelectorAll('button').forEach(b=>b.classList.remove('on'));this.classList.add('on')">${l}</button>`).join('')}</div>
   <details class="moreopts" ${id || t.repeat ? 'open' : ''}><summary>אפשרויות נוספות</summary>
   <label>תאריך אחר</label><input type="date" name="date" value="${t.date || ''}" oninput="document.querySelectorAll('#dateChips button').forEach(b=>b.classList.remove('on'))">
   <label>חוזרת? (בסיום נוצרת המשימה הבאה)</label><select name="repeat">${REPEATS.map(([v, l]) => `<option value="${v}" ${(t.repeat || '') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
   <label>כמה אנרגיה זה דורש ממך? (1 = קל, 5 = הכי מאמץ)</label>
   <div class="stars" id="stars">${[1, 2, 3, 4, 5].map(n => `<button type="button" class="${n <= (t.energy || 0) ? 'on' : ''}" data-act="star" data-n="${n}">★</button>`).join('')}</div>
   <input type="hidden" name="energy" value="${t.energy || 0}">
   <label>משך (עד 15 דקות; ארוך יותר יוצע לפיצול)</label>
   <select name="mins">${mo.map(m => `<option value="${m}" ${m == (t.mins || 15) ? 'selected' : ''}>${m} דקות</option>`).join('')}</select>
   <label>עדיפות</label><select name="priority"><option value="0" ${t.priority == 0 ? 'selected' : ''}>רגילה</option><option value="1" ${t.priority == 1 ? 'selected' : ''}>חשובה</option><option value="2" ${t.priority == 2 ? 'selected' : ''}>דחופה</option></select>
   <label>פרויקט (אופציונלי): לאגד משימות קשורות</label><select name="projectId">${projectOpts(t.projectId)}</select>
   <label>קישור לחזון (אופציונלי)</label><select name="visionId">${visionOpts(t.visionId)}</select>
   <label>הערות</label><textarea name="notes">${esc(t.notes || '')}</textarea>
   <label class="row" style="color:var(--ink)"><input type="checkbox" name="brainless" style="width:auto" ${t.brainless ? 'checked' : ''}> ⚡ Brainless (משימה פשוטה שאפשר להעיף ברגע)</label>
   <label class="row" style="color:var(--ink)"><input type="checkbox" name="print" style="width:auto" ${t.print ? 'checked' : ''}> סמן להדפסה</label>
   </details>
   <div class="actions">${id ? '<button type="button" class="btn danger" data-act="delTask" data-id="' + id + '">מחק</button>' : ''}<button type="button" class="btn ghost" data-act="close">ביטול</button><button class="btn">שמור</button></div>
  </form>`);
  // Clarity gate: new tasks (or a changed title) must be confirmed with "זה ברור" before they are saved.
  const form = $('#f'), origTitle = id ? t.title : null;
  form.projectId.addEventListener('change', () => { // "＋ פרויקט חדש" creates a project on the spot and selects it
    if (form.projectId.value !== '__new__') return;
    const p = newProject(); const sel = form.projectId;
    if (p) { sel.add(new Option(p.title, p.id), sel.options[sel.options.length - 1]); sel.value = p.id; } else sel.value = '';
  });
  // A clear-looking title is saved as is; only an unclear one is blocked until the user confirms it.
  const needClear = () => (!id || form.title.value.trim() !== origTitle) && clarity(form.title.value).length > 0;
  $('#clRow').hidden = true;
  form.title.addEventListener('input', () => {
    $('#clHint').innerHTML = clarityHTML(form.title.value);
    form.clear.checked = false; $('#clMsg').textContent = '';
    $('#clRow').hidden = !needClear();
  });
  $('#f').onsubmit = e => {
    e.preventDefault();
    if (needClear() && !form.clear.checked) { $('#clMsg').textContent = 'הניסוח לא ברור. תקן אותו, או סמן "זה ברור" כדי להוסיף בכל זאת.'; $('#clRow').hidden = false; return; }
    const f = new FormData(e.target);
    const obj = { title: f.get('title').trim(), date: f.get('date') || null, priority: +f.get('priority'), visionId: f.get('visionId') || '', projectId: f.get('projectId') === '__new__' ? '' : (f.get('projectId') || ''), notes: f.get('notes'), repeat: f.get('repeat') || '', print: f.get('print') === 'on', brainless: f.get('brainless') === 'on', energy: +f.get('energy'), mins: +f.get('mins') };
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
   <label>איזו משימה ההרגל מייצר? (פעולה קונקרטית, עד 15 דקות)</label><input name="task" required value="${esc(h.task || '')}" autocomplete="off" placeholder="למשל: ללכת 15 דקות סביב הבלוק">
   <div id="htHint" class="clarity">${clarityHTML(h.task || '')}</div>
   <label>כמה אנרגיה זה דורש? (1 = קל, 5 = הכי מאמץ)</label>
   <div class="stars" id="stars">${[1, 2, 3, 4, 5].map(n => `<button type="button" class="${n <= (h.energy || 0) ? 'on' : ''}" data-act="star" data-n="${n}">★</button>`).join('')}</div>
   <input type="hidden" name="energy" value="${h.energy || 0}">
   <label>משך</label><select name="mins">${mo.map(m => `<option value="${m}" ${m == (h.mins || 10) ? 'selected' : ''}>${m} דקות</option>`).join('')}</select>
   <label>באילו ימים</label><div class="days">${DAYS.map((x, i) => `<button type="button" class="${days.has(i) ? 'on' : ''}" data-act="dayTog" data-d="${i}">${x}</button>`).join('')}</div>
   <label>קישור לחזון (אופציונלי)</label><select name="visionId">${visionOpts(h.visionId)}</select>
   ${id ? `<button type="button" class="btn ghost" style="width:100%;margin-top:12px" data-act="habToTask" data-id="${id}">🔁 הפוך למשימה חוזרת</button><div class="sub">ההרגל נשאר. נוצרת משימה שאפשר לקבוע כל כמה זמן היא חוזרת.</div>` : ''}
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
  sheet(`<h1>הזנת הרגלים בבת אחת</h1><p class="sub">הרגל בכל שורה. בשלב הבא אשאל אותך, לכל הרגל, איזו משימה קונקרטית הוא מייצר, באילו ימים, וכמה אנרגיה וזמן היא דורשת.</p>
   <textarea id="habText" style="min-height:160px" placeholder="פעילות גופנית&#10;קריאה&#10;סדר בבית"></textarea>
   <div class="actions"><button class="btn ghost" data-act="close">ביטול</button><button class="btn" data-act="habBulkNext">המשך</button></div>`);
  setTimeout(() => $('#habText') && $('#habText').focus(), 50);
}
function habBulkRender(showMiss) {
  const old = $('#sheet .panel'), st = old ? old.scrollTop : 0;
  sheet(`<h1>איזו משימה כל הרגל מייצר?</h1>
   <p class="sub">${habBulk.length} הרגלים. כל הרגל הופך למשימה קטנה וברורה בכל יום שנבחר.</p>
   ${habBulk.map((b, i) => `<div class="bulkrow ${showMiss && (!b.task.trim() || !clrOk(b.task, b.clear) || !b.energy) ? 'miss' : ''}">
     <input data-habtitle="${i}" value="${esc(b.title)}" style="font-weight:700" autocomplete="off">
     <label>המשימה שההרגל מייצר (פעולה קונקרטית)</label>
     <input data-habtask="${i}" value="${esc(b.task)}" autocomplete="off" placeholder="למשל: ללכת 15 דקות סביב הבלוק">
     <div class="clarity" id="hcl${i}">${clarityHTML(b.task)}</div>
     <button class="clearbtn ${b.clear ? 'on' : ''}" ${clarity(b.task).length ? '' : 'hidden'} data-act="habClear" data-i="${i}">${b.clear ? '✅ זה ברור' : '☐ זה ברור: ' + CLEAR_LABEL}</button>
     <label>באילו ימים</label><div class="days">${DAYS.map((x, d) => `<button type="button" class="${b.days.includes(d) ? 'on' : ''}" data-act="habDay" data-i="${i}" data-d="${d}">${x}</button>`).join('')}</div>
     <label>אנרגיה</label><div class="stars">${[1, 2, 3, 4, 5].map(n => `<button type="button" class="${n <= b.energy ? 'on' : ''}" data-act="habStar" data-i="${i}" data-n="${n}">★</button>`).join('')}</div>
     <label>משך (דקות)</label><div class="opt">${[5, 10, 15].map(m => `<button class="${b.mins === m ? 'on' : ''}" data-act="habMins" data-i="${i}" data-m="${m}">${m}</button>`).join('')}</div></div>`).join('')}
   ${CLARITY_EX}
   ${showMiss ? '<div class="sub" style="color:var(--danger)">חסרה משימה, אנרגיה או אישור "זה ברור" בשורות המסומנות.</div>' : ''}
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
    <div class="grow"><div class="t">🗂 ארגון</div><div class="meta"><span>${undated} ללא תאריך</span><span>${late} באיחור</span><span>מחר: ${n} משימות · ${dayLoad(tm)} ד׳</span></div></div></div>`;
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
  sheet(`<h1>🗂 ארגון · שלב 1 מתוך 2</h1><p class="sub">יום חדש, מתחילים מחדש. לכל משימה שנשארה: להשאיר להיום, לדחות לתאריך אחר, או להעביר למאגר. שום דבר לא עובר אוטומטית. ${rows.length ? `נותרו ${left} לתארוך.` : ''}</p>
   ${rows.length ? `<div class="actions" style="margin:0 0 10px"><button class="btn ghost" data-act="orgSuggest">✨ הצע לי חלוקה לפי העומס</button></div>` : ''}
   ${rows.map(t => `<div class="bulkrow ${(!t.date && !t.parked) || (t.date && t.date < T) ? 'miss' : ''}"><div class="t"><b>${esc(t.title)}</b></div>
     <div class="meta">${Org.orig[t.id] ? `<span style="color:var(--danger)">היה ב-${shortDate(Org.orig[t.id])}</span>` : t.parked ? '<span>📦 במאגר</span>' : t.inbox ? '<span>📥 נקלט</span>' : '<span>ללא תאריך</span>'}${t.energy ? `<span style="color:var(--accent)">${stars(t.energy)}</span>` : ''}${t.mins ? `<span>${t.mins} ד׳</span>` : ''}</div>
     <div class="opt" style="margin-top:8px">${opts.map(([l, v]) => `<button class="${t.date === v ? 'on' : ''}" data-act="orgSet" data-id="${t.id}" data-d="${v}">${l}</button>`).join('')}<button class="${t.parked ? 'on' : ''}" data-act="orgPark" data-id="${t.id}">📦 למאגר</button><input type="date" style="width:auto" data-orgdate="${t.id}" value="${t.date && !opts.some(o => o[1] === t.date) ? t.date : ''}"></div></div>`).join('') || '<div class="empty">🎉 אין משימות ללא תאריך או באיחור</div>'}
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
    t.date = best; load[best] = get(best) + m;
  }
  Store.save(); render(); orgStep1();
}
function orgStep2() {
  const T = TODAY(), tm = addDays(T, 1), ts = tasksOn(tm), load = dayLoad(tm), old = $('#sheet .panel'), st = old ? old.scrollTop : 0;
  const warns = [];
  if (!ts.length) warns.push('אין משימות למחר. כדאי להוסיף לפחות משימה חשובה אחת.');
  if (load > DAY_CAP) warns.push(`מחר עמוס: ${load} דקות (מעל ${DAY_CAP}). כדאי להעביר משהו ליום אחר.`);
  const noEn = ts.filter(t => !t.energy).length; if (noEn) warns.push(noEn === 1 ? 'משימה אחת בלי דירוג אנרגיה.' : `${noEn} משימות בלי דירוג אנרגיה.`);
  const longs = ts.filter(t => (t.mins || 0) > 15 && !(t.subs && t.subs.length)).length; if (longs) warns.push(longs === 1 ? 'משימה אחת ארוכה מ-15 דקות בלי פיצול לתתי-משימות.' : `${longs} משימות ארוכות מ-15 דקות בלי פיצול לתתי-משימות.`);
  const unclear = ts.filter(t => clarity(t.title).length).length; if (unclear) warns.push(unclear === 1 ? 'משימה אחת בניסוח לא ברור.' : `${unclear} משימות בניסוח לא ברור.`);
  const first = ts.find(t => !t.done);
  const mv = [['מחרתיים', addDays(T, 2)], ['בעוד 3 ימים', addDays(T, 3)], ['ללא תאריך', 'none']];
  sheet(`<h1>🗂 ארגון · שלב 2 מתוך 2</h1><p class="sub">הלו"ז של מחר, ${longDate(tm)}</p>
   <div class="card" style="background:var(--soft)"><b>${ts.length} משימות · ${load} דקות</b>${first ? `<div class="sub">המשימה הראשונה: ${esc(first.title)}${first.energy ? ' ' + stars(first.energy) : ''}. משימות עם אנרגיה גבוהה תמיד בהתחלה.</div>` : ''}</div>
   ${warns.length ? warns.map(w => `<div class="clarity"><div class="w">⚠ ${esc(w)}</div></div>`).join('') : '<div class="clarity"><div class="ok">✓ הלו"ז של מחר נראה מאוזן וברור.</div></div>'}
   ${ts.map(t => { const cl = clarity(t.title); return `<div class="bulkrow"><div class="t"><b>${esc(t.title)}</b></div>
     <div class="meta">${t.energy ? `<span style="color:var(--accent)">${stars(t.energy)}</span>` : '<span>בלי אנרגיה</span>'}${t.mins ? `<span>${t.mins} ד׳</span>` : ''}${cl.length ? '<span style="color:var(--warn-ink)">⚠ ניסוח לא ברור</span>' : ''}</div>
     <div class="opt" style="margin-top:8px"><span class="sub">להעביר ל:</span>${mv.map(([l, v]) => `<button data-act="orgMove" data-id="${t.id}" data-d="${v}">${l}</button>`).join('')}</div></div>`; }).join('')}
   <div class="actions"><button class="btn ghost" data-act="orgAddTomorrow">＋ משימה למחר</button></div>
   <div class="actions"><button class="btn ghost" data-act="orgBack">חזרה</button><button class="btn" data-act="orgFinish">✅ סיימתי ארגון</button></div>`);
  $('#sheet .panel').scrollTop = st;
}

/* ---------- Clarity gate: a task is only entered after the user confirms "זה ברור" ---------- */
const VAGUE_VERBS = ['לקדם', 'לטפל', 'לסדר', 'לעבוד על', 'לחשוב על', 'להתכונן', 'לשפר', 'לנסות', 'לדאוג', 'לנהל', 'לארגן', 'ללמוד', 'להמשיך', 'לעשות', 'להתעסק'];
const VAGUE_WORDS = ['פרויקט', 'עניינים', 'דברים', 'משהו', 'הכל', 'כללי', 'וכו'];
const CONCRETE_VERBS = ['לכתוב', 'לשלוח', 'להתקשר', 'לפתוח', 'לשלם', 'לקנות', 'להזמין', 'לצלם', 'לערוך', 'להעלות', 'לחתום', 'לתאם', 'לקרוא', 'לצפות', 'לפרסם', 'להדפיס', 'לסרוק', 'למלא', 'להוריד', 'להעביר', 'לענות', 'להגיש', 'לבנות', 'לשרטט', 'להקליט', 'לקבוע', 'לרשום', 'לבדוק', 'לחפש', 'להכין', 'לנקות', 'לפנות', 'לשטוף', 'לקפל', 'להוציא', 'להכניס', 'לבחור', 'לסכם', 'לתרגל', 'לצלצל', 'להגדיר', 'ללכת', 'לרוץ', 'לצאת', 'לשתות', 'לאכול', 'לעשות', 'להתאמן', 'למתוח', 'לנשום', 'לשבת', 'לקום', 'לעלות', 'לרדת', 'לבשל', 'לכבס', 'לשטוף', 'לגהץ', 'להתקלח', 'לישון', 'לטעון', 'לחבר', 'לתלות'];
// Advisory only: the user always decides by ticking "זה ברור". Returns a list of problems (empty = looks clear).
function clarity(title) {
  const t = title.trim().replace(/\s+/g, ' '), words = t.split(' ').filter(Boolean), issues = [];
  if (!t) return issues;
  const hasNum = /\d/.test(t);
  if (words.length < 3) issues.push('קצר מדי. הוסף מה בדיוק, למי או כמה.');
  const vv = VAGUE_VERBS.find(v => t === v || t.startsWith(v + ' '));
  if (vv && !hasNum) issues.push(`"${vv}" הוא פועל מעורפל. כתוב את הפעולה הבאה המדויקת, למשל לכתוב, לשלוח, להתקשר או לפתוח.`);
  const vw = VAGUE_WORDS.find(w => t.includes(w));
  if (vw) issues.push(`"${vw}" היא מילה כללית. פרט למה הכוונה.`);
  if (!vv && !CONCRETE_VERBS.some(v => t.startsWith(v))) issues.push('לא זיהיתי פועל פעולה מוחשי בתחילת המשימה. התחל בפועל כמו "לכתוב", "לשלוח" או "להתקשר".');
  if (words.length > 14) issues.push('ארוכה מאוד. אולי אלה כמה משימות? פצל אותן.');
  return issues;
}
function clarityHTML(title) {
  if (!title.trim()) return '<div class="sub">כתוב את הפעולה הבאה, בצורה שאפשר להתחיל מיד.</div>';
  const issues = clarity(title);
  return issues.length ? issues.map(x => `<div class="w">⚠ ${esc(x)}</div>`).join('') : '<div class="ok">✓ נראית ברורה: יש פועל מוחשי ופעולה מוגדרת.</div>';
}
const CLARITY_EX = `<details class="clex"><summary>דוגמאות: ממשימה מעורפלת לפעולה הבאה</summary><table>
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
   <div class="meta" style="margin-bottom:10px">${t.brainless ? '<span class="chip" style="background:var(--warn-bg);color:var(--warn-ink)">⚡ Brainless</span>' : ''}${t.date ? `<span>${longDate(t.date)}</span>` : '<span>ללא תאריך</span>'}${t.energy ? `<span style="color:var(--accent)">${stars(t.energy)}</span>` : ''}${t.mins ? `<span>${t.mins} ד׳</span>` : ''}${projectChip(t)}${v ? `<span class="chip">${esc(v)}</span>` : ''}</div>
   ${t.notes ? `<p class="sub" style="white-space:pre-wrap">${esc(t.notes)}</p>` : ''}
   ${(t.subs || []).map(s => `<div class="row ${s.done ? 'done' : ''}" style="margin:6px 0"><button class="check ${s.done ? 'on' : ''}" data-act="subToggle" data-id="${t.id}" data-sid="${s.id}">${s.done ? '✓' : ''}</button><div class="t grow">${esc(s.title)}${s.mins ? ` <span class="sub">· ${s.mins} ד׳</span>` : ''}</div><button class="iconbtn" data-act="subDel" data-id="${t.id}" data-sid="${s.id}">✕</button></div>`).join('')}
   <form id="subForm" class="row" style="margin-top:8px" hidden><input id="subText" placeholder="תת משימה חדשה" autocomplete="off"><button class="btn">הוסף</button></form>
   <div class="grid2">
     ${t.done ? '' : `<button class="btn" data-act="runStart" data-id="${t.id}">▶ התחל עכשיו</button>`}
     <button class="btn ghost" data-act="menuDone" data-id="${t.id}">${t.done ? '↺ בטל ביצוע' : '✓ בוצע'}</button>
     <button class="btn ghost" data-act="moveSheet" data-id="${t.id}">📆 העבר</button>
     <button class="btn ghost" data-act="editTask" data-id="${t.id}">✏️ ערוך</button>
     <button class="btn ghost" data-act="subShow">➕ הוסף תת משימה</button>
   </div>
   <div class="actions"><button class="btn ghost" data-act="close">סגור</button></div>`);
  $('#subForm').onsubmit = e => {
    e.preventDefault(); const txt = $('#subText').value.trim(); if (!txt) return;
    (t.subs = t.subs || []).push({ id: uid(), title: txt, done: false });
    Store.save(); render(); menuSheet(id); $('#subForm').hidden = false; $('#subText').focus();
  };
}
function moveSheet(id) {
  const t = findTask(id), T = TODAY();
  const opts = [['מחר', addDays(T, 1)], ['מחרתיים', addDays(T, 2)], ['בעוד שבוע', addDays(T, 7)], ['ללא תאריך', 'none']];
  sheet(`<h1>להעביר ל...</h1><p class="sub">${esc(t.title)}</p>
   <div class="opt">${opts.map(([l, v]) => `<button data-act="moveTo" data-id="${id}" data-d="${v}">${l}${v !== 'none' ? ' · ' + shortDate(v) : ''}</button>`).join('')}</div>
   <label>או בחר תאריך</label><div class="row"><input type="date" id="moveDate" value="${t.date || ''}"><button class="btn" data-act="moveCustom" data-id="${id}">קבע</button></div>
   <div class="actions"><button class="btn ghost" data-act="close">ביטול</button></div>`);
}

/* ---------- Tasks must be <= 15 min: offer to split longer ones ---------- */
let splitCtx = null;
// Splitting keeps the task as the parent (with its total minutes) and creates clearly named subtasks of <= 15 min each.
function splitNameSheet(t, next) {
  const n = Math.ceil(t.mins / 15), each = Math.ceil(t.mins / n);
  sheet(`<h1>שמות לתתי-המשימות</h1>
   <p>"${esc(t.title)}" תתפצל ל-${n} שלבים של כ-${each} דקות. תן לכל שלב שם ברור, שיגיד מה בדיוק עושים בו.</p>
   <form id="f">${Array.from({ length: n }, (_, i) => `<label>שלב ${i + 1} (${each} ד׳)</label><input name="s${i}" required autocomplete="off" placeholder="מה עושים בשלב הזה?" ${i === 0 ? 'autofocus' : ''}>`).join('')}
   <div id="splitMsg" class="sub" style="color:var(--danger);margin-top:8px"></div>
   <div class="actions"><button type="button" class="btn ghost" data-act="keepLong">להשאיר כמו שהיא</button><button class="btn">שמור</button></div></form>`);
  $('#f').onsubmit = e => {
    e.preventDefault(); const f = new FormData(e.target);
    const names = Array.from({ length: n }, (_, i) => f.get('s' + i).trim());
    if (names.some(x => !x) || new Set(names.map(x => x.toLowerCase())).size !== names.length) { $('#splitMsg').textContent = 'לכל שלב צריך שם ברור, וכל השמות צריכים להיות שונים.'; return; }
    t.subs = (t.subs || []).concat(names.map(title => ({ id: uid(), title, done: false, mins: each })));
    next();
  };
}
function resolveLong(list) {
  const q = list.filter(t => (t.mins || 0) > 15 && !(t.subs && t.subs.length));
  const next = () => {
    const t = q.shift();
    if (!t) { Store.save(); closeSheet(); render(); return; }
    const n = Math.ceil(t.mins / 15);
    splitCtx = { t, next };
    sheet(`<h1>משימה ארוכה</h1><p>"${esc(t.title)}" נמשכת ${t.mins} דקות, ומשימה צריכה להיות עד 15 דקות. לפצל ל-${n} תתי-משימות של כ-${Math.ceil(t.mins / n)} דקות? אבקש ממך לתת שם ברור לכל אחת.</p>
     <div class="actions"><button class="btn ghost" data-act="keepLong">להשאיר כמו שהיא</button><button class="btn" data-act="doSplit">לפצל ל-${n}</button></div>`);
  };
  next();
}

/* ---------- Bulk entry ---------- */
let bulk = [], bulkProject = '';
function assignSheet(pid) {
  const p = D().projects.find(x => x.id === pid), cand = D().tasks.filter(t => !t.done && t.projectId !== pid);
  sheet(`<h1>שיוך משימות ל-${esc(p.title)}</h1><form id="f">
   ${cand.map(t => `<label class="row" style="color:var(--ink);margin:8px 0"><input type="checkbox" name="t" value="${t.id}" style="width:auto"><span class="grow">${esc(t.title)}${t.projectId && projectName(t.projectId) ? ` <span class="sub">(כרגע ב-${esc(projectName(t.projectId))})</span>` : ''}</span></label>`).join('') || '<div class="empty">אין משימות פתוחות לשייך</div>'}
   <div class="actions"><button type="button" class="btn ghost" data-act="close">ביטול</button><button class="btn">שייך</button></div></form>`);
  $('#f').onsubmit = e => {
    e.preventDefault(); new FormData(e.target).getAll('t').forEach(id => { const t = findTask(id); if (t) t.projectId = pid; });
    Store.save(); closeSheet(); render();
  };
}
const bulkDateOpts = () => { const T = TODAY(); return [['היום', T], ['מחר', addDays(T, 1)], ['מחרתיים', addDays(T, 2)], ['ללא', null]]; };
function bulkStart(project) {
  bulkProject = project || '';
  sheet(`<h1>הזנת משימות בבת אחת</h1><p class="sub">משימה בכל שורה. בשלב הבא אשאל אותך מתי לשלב כל אחת וכמה אנרגיה היא דורשת.</p>
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
   <p class="sub">${bulk.length} משימות. משימות עם אנרגיה גבוהה יופיעו תמיד בתחילת היום.</p>
   <label>פרויקט לכל המשימות (אופציונלי)</label><select data-bulkproj="1">${projectOpts(bulkProject)}</select>
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
   <div class="actions"><button class="btn ghost" data-act="close">ביטול</button><button class="btn" data-act="bulkSave">הוסף ${bulk.length} משימות</button></div>`);
  $('#sheet .panel').scrollTop = st;
}

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
    if (error) $('#authMsg').textContent = 'הכניסה נכשלה: ' + error.message; else closeSheet();
  };
}

/* ---------- Print ---------- */
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
  const orgRow = d === TODAY() && (all || !orgDone(d)) ? pRow('🗂 ארגון: לתארך משימות ולוודא את הלו"ז של מחר') : '';
  printHTML(`<h1>${longDate(d)}</h1><h2>משימות</h2>${orgRow}${ts.map(t => '<div>' + pRow((t.done ? '✓ ' : '') + (t.priority == 2 ? '‼ ' : t.priority == 1 ? '! ' : '') + t.title + (t.mins ? ` · ${t.mins} ד׳` : '') + (t.energy ? ' ' + stars(t.energy) : '')) + (t.subs || []).filter(s => all || !s.done).map(s => `<div style="margin-inline-start:26px">${pRow(s.title, true)}</div>`).join('') + '</div>').join('') || '<div class="pl">—</div>'}
   <h2>הרגלים</h2>${habitsOn(d).map(h => pRow(h.title)).join('') || '<div class="pl">—</div>'}
   <h2>הערות</h2><div class="lines">${'<div></div>'.repeat(8)}</div>`);
}
function printWeek() {
  const ws = weekStart(state.date);
  printHTML(`<h1>שבוע ${shortDate(ws)} – ${shortDate(addDays(ws, 6))}</h1><div class="wk">${Array.from({ length: 7 }, (_, i) => {
    const s = addDays(ws, i);
    return `<div class="wd"><b>יום ${DAYN[i]} · ${shortDate(s)}</b>${tasksOn(s).map(t => pRow(t.title, true)).join('')}${habitsOn(s).map(h => pRow('🔁 ' + h.title, true)).join('')}</div>`;
  }).join('')}</div>`);
}
function printSel() {
  const ts = D().tasks.filter(t => t.print && !t.done);
  printHTML(`<h1>משימות להדפסה</h1>${ts.map(t => pRow(t.title + (t.date ? ' (' + shortDate(t.date) + ')' : ''))).join('') || '<div class="pl">אין משימות מסומנות להדפסה</div>'}`);
}

/* ---------- Events ---------- */
const A = {
  toggleTask: e => {
    const t = D().tasks.find(x => x.id === e.id); t.done = !t.done;
    if (t.repeat) {
      if (t.done && !t.spawned) { const n = { ...t, id: uid(), done: false, date: nextRepeatDate(t), spawned: '', subs: (t.subs || []).map(x => ({ ...x, id: uid(), done: false })) }; D().tasks.push(n); t.spawned = n.id; }
      else if (!t.done && t.spawned) { const n = D().tasks.find(x => x.id === t.spawned); if (n && !n.done) D().tasks = D().tasks.filter(x => x !== n); t.spawned = ''; }
    }
    Store.save(); state.pop = { id: e.id }; render();
    if (t.done && t.date === TODAY()) showNext(t.id);
    if (t.done && t.date) { const day = D().tasks.filter(x => x.date === t.date); if (day.length >= 2 && day.every(x => x.done)) celebrate(); }
    if (t.done && t.projectId) { const pt = D().tasks.filter(x => x.projectId === t.projectId); if (pt.length >= 2 && pt.every(x => x.done)) celebrate(); }
  },
  toggleHabit: e => { const h = D().habits.find(x => x.id === e.id); if (h.log[e.date]) delete h.log[e.date]; else h.log[e.date] = true; Store.save(); state.pop = { id: e.id, date: e.date }; render(); },
  editTask: e => taskForm(e.id), addTask: () => taskForm(),
  habToTask: e => { const h = D().habits.find(x => x.id === e.id); taskForm(undefined, TODAY(), '', { title: h.task || h.title, energy: h.energy || 3, mins: h.mins || 15, visionId: h.visionId || '', repeat: 'd1' }); },
  focusEdit: () => focusSheet(state.date),
  focusPick: e => { const t = D().tasks.find(x => x.id === e.id), f = $('#f'); if (t) { f.mit.value = t.title; f.mitId.value = t.id; } },
  focusLater: () => { focusSnooze = true; closeSheet(); },
  demoReset: () => { if (confirm('לאפס את הדמו לנתונים ההתחלתיים?')) { seedDemo(); render(); } },
  editHabit: e => habitForm(e.id), addHabit: () => habitForm(),
  editVision: e => visionForm(e.id), addVision: () => visionForm(),
  addList: () => listForm(),
  delTask: e => { if (confirm('למחוק את המשימה?')) { D().tasks = D().tasks.filter(x => x.id !== e.id); Store.save(); closeSheet(); render(); } },
  delHabit: e => { if (confirm('למחוק את ההרגל?')) { D().habits = D().habits.filter(x => x.id !== e.id); Store.save(); closeSheet(); render(); } },
  delVision: e => { if (confirm('למחוק את פריט החזון? קישורים אליו יוסרו.')) { D().visions = D().visions.filter(x => x.id !== e.id); D().tasks.forEach(t => { if (t.visionId === e.id) t.visionId = ''; }); D().habits.forEach(h => { if (h.visionId === e.id) h.visionId = ''; }); D().goals.forEach(g => { if (g.visionId === e.id) g.visionId = ''; }); Store.save(); closeSheet(); render(); } },
  close: closeSheet,
  addTaskOn: e => taskForm(undefined, e.date || ''),
  rescheduleOverdue: () => { const o = overdue(); if (o.length && confirm(`להעביר ${o.length} משימות באיחור להיום?`)) { o.forEach(t => { t.date = TODAY(); }); Store.save(); render(); } },
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
  menuDone: e => { const t = findTask(e.id); t.done = !t.done; Store.save(); closeSheet(); render(); if (t.done && t.date === TODAY()) showNext(t.id); },
  moveSheet: e => moveSheet(e.id),
  moveTo: e => { findTask(e.id).date = e.d === 'none' ? null : e.d; Store.save(); closeSheet(); render(); },
  moveCustom: e => { const v = $('#moveDate').value; if (!v) return; findTask(e.id).date = v; Store.save(); closeSheet(); render(); },
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
      <h2>משימות פתוחות השבוע</h2>${wt.map(t => pRow(`${shortDate(t.date)} · ${t.title}${t.mins ? ` · ${t.mins} ד׳` : ''}${t.energy ? ' ' + stars(t.energy) : ''}`, true)).join('') || '<div class="pl">—</div>'}
      <h2>סיכום: מה עבד? מה לשפר?</h2><div class="lines">${'<div></div>'.repeat(5)}</div>`);
  },
  jShift: e => { const n = addDays(state.jDate, +e.n); if (n <= TODAY()) { state.jDate = n; render(); } },
  jToday: () => { state.jDate = TODAY(); render(); },
  jOpen: e => { state.jDate = e.d; render(); window.scrollTo(0, 0); },
  jPhotoPick: () => $('#jphoto').click(),
  jPhotoDel: () => { jSet(state.jDate).photo = ''; Store.save(); render(); },
  jWinDel: e => { const J = jSet(state.jDate); J.wins = J.wins.filter(w => w.id !== e.id); Store.save(); render(); },
  goTab: e => { state.tab = e.t; state.openList = null; state.openProject = null; render(); window.scrollTo(0, 0); },
  addProject: () => { const p = newProject(); if (p) { state.openProject = p.id; render(); } },
  openProject: e => { state.openProject = e.id; render(); window.scrollTo(0, 0); },
  backProjects: () => { state.openProject = null; render(); },
  renameProject: e => { const p = D().projects.find(x => x.id === e.id), n = (prompt('שם הפרויקט', p.title) || '').trim(); if (n) { p.title = n; Store.save(); render(); } },
  delProject: e => { if (confirm('למחוק את הפרויקט? המשימות שלו יישארו, בלי פרויקט.')) { D().tasks.forEach(t => { if (t.projectId === e.id) t.projectId = ''; }); D().projects = D().projects.filter(p => p.id !== e.id); state.openProject = null; Store.save(); render(); } },
  projAddTask: e => taskForm(undefined, null, e.id),
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
  setEnergy: e => { const T = TODAY(), f = (D().focus[T] = D().focus[T] || {}); f.energy = f.energy === e.v ? '' : e.v; Store.save(); render(); },
  toggleShowAll: () => { state.showAll = !state.showAll; render(); },
  toastClose: () => { $('#toast').hidden = true; },
  runStart: e => {
    $('#toast').hidden = true; let id = e.id;
    if (!id) { const T = TODAY(), f = focusOn(T); if (!f.mit) return focusSheet(T);
      const t = { id: uid(), title: f.mit, date: T, done: false, priority: 0, energy: 3, mins: 15, brainless: false, print: false, visionId: '', projectId: '', notes: '', subs: [] };
      D().tasks.push(t); (D().focus[T] = D().focus[T] || {}).mitId = t.id; Store.save(); id = t.id; }
    runOpen(id);
  },
  runBreak: () => { $('#toast').hidden = true; runOpen(null, true); },
  runClose: () => runClose(),
  runMins: e => { if (Run.running) return; Run.total = Run.left = +e.m * 60; runRender(); },
  runToggle: () => {
    if (Run.running) { Run.left = Math.max(0, Math.round((Run.endAt - Date.now()) / 1000)); clearInterval(Run.tick); Run.running = false; runRender(); }
    else runStartTimer();
  },
  runMore: () => { Run.ended = false; Run.total = Run.left = 300; runStartTimer(); },
  runDone: () => {
    const id = Run.id, t = id && findTask(id); runClose();
    if (t && !t.done) A.toggleTask({ id }); else showNext(id);
  },
  runNext: () => { const n = nextTask(Run.id); if (n) runOpen(n.id); else runClose(); },
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
  stuckMove: e => { const t = findTask(Run.id); if (t) { t.date = e.d; Store.save(); } closeSheet(); runClose(); const n = nextTask(Run.id); if (n) toast(`<span>נדחה. אולי <b>${esc(n.title)}</b>?</span><button class="btn" data-act="runStart" data-id="${n.id}">התחל</button><button data-act="toastClose">✕</button>`); },
  orgPark: e => { const t = findTask(e.id); t.date = null; t.parked = true; Store.save(); render(); orgStep1(); },
  orgOpen: () => orgOpen(),
  orgSuggest: () => orgSuggest(),
  orgSet: e => { const t = findTask(e.id); t.date = e.d; classify(t); Store.save(); render(); orgStep1(); },
  orgNext: () => orgStep2(),
  orgBack: () => orgStep1(),
  orgMove: e => { const t = findTask(e.id); t.date = e.d === 'none' ? null : e.d; if (t.date) classify(t); Store.save(); render(); orgStep2(); },
  orgAddTomorrow: () => taskForm(undefined, addDays(TODAY(), 1)),
  orgFinish: () => { D().org = D().org || {}; D().org[TODAY()] = { at: new Date().toISOString() }; Store.save(); closeSheet(); render(); celebrate(); },
  addBulk: () => bulkStart(),
  copyPrompt: async () => {
    const msg = $('#clipMsg');
    try { await navigator.clipboard.writeText('העתק את הרשימה שבתמונה, משימה אחת בכל שורה, בלי מספור ובלי תבליטים, בלי הסברים ובלי טקסט נוסף.'); msg.textContent = 'ההנחיה הועתקה. הדבק אותה בצ\'אט של Claude עם צילום הרשימה.'; }
    catch (e) { msg.textContent = 'לא הצלחתי להעתיק. אפשר לכתוב ל-Claude: העתק את הרשימה שבתמונה, משימה בכל שורה.'; }
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
    $('#authMsg').textContent = error ? 'ההרשמה נכשלה: ' + error.message : (data.session ? 'נרשמת בהצלחה' : 'נשלח אימייל אימות. אשר אותו ואז היכנס.');
    if (data && data.session) closeSheet();
  },
  dayTog: (e, el) => el.classList.toggle('on'),
  shift: e => { state.date = addDays(state.date, +e.n); render(); },
  goToday: () => { state.date = TODAY(); render(); },
  filter: e => { state.taskFilter = e.f; render(); },
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
  if (nav) { state.tab = nav.dataset.tab; state.openList = null; state.openProject = null; render(); window.scrollTo(0, 0); }
});
document.addEventListener('change', ev => {
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
  if (od !== undefined) { const t = findTask(od); if (t && ev.target.value) { t.date = ev.target.value; Store.save(); render(); orgStep1(); } return; }
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
  document.body.classList.remove('dragging-now');
  Object.assign(Drag, { el: null, ghost: null, id: null, active: false, over: null, pid: null });
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
  const under = document.elementFromPoint(x, y), col = under && under.closest('[data-drop]');
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
  const was = Drag.active, id = Drag.id, col = Drag.over;
  dragReset();
  if (!was) return;
  Drag.suppressClick = true; setTimeout(() => { Drag.suppressClick = false; }, 60);
  if (!drop || !col) return;
  const target = col.dataset.drop, t = findTask(id);
  if (!t || target === 'overdue') return;
  const nd = target === 'none' ? null : target;
  if (t.date !== nd) { t.date = nd; Store.save(); render(); }
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
  const v1 = id(), v2 = id(), v3 = id(), p1 = id(), h1 = id(), h2 = id(), h3 = id();
  const task = (title, date, extra = {}) => ({ id: id(), title, date, done: false, priority: 0, energy: 3, mins: 15, brainless: false, print: false, visionId: '', projectId: '', notes: '', subs: [], ...extra });
  const d = empty();
  d.visions = [
    { id: v1, title: 'בריאות ואנרגיה לאורך היום', desc: 'להרגיש חזק ורגוע, עם שגרת תנועה קבועה.', area: 'בריאות' },
    { id: v2, title: 'עסק קטן שמצליח', desc: 'לקוחות מרוצים והכנסה יציבה בלי לחץ.', area: 'קריירה' },
    { id: v3, title: 'זמן איכות עם המשפחה', desc: 'ערבים בלי מסכים וטיול חודשי.', area: 'משפחה' }
  ];
  d.projects = [{ id: p1, title: 'השקת האתר החדש', createdAt: ago(5) }];
  d.habits = [
    { id: h1, title: 'פעילות גופנית', task: 'ללכת 15 דקות סביב הבלוק', days: [0, 1, 2, 3, 4, 5, 6], mins: 15, energy: 4, visionId: v1, log: { [ago(1)]: true, [ago(2)]: true, [ago(3)]: true, [ago(5)]: true } },
    { id: h2, title: 'קריאה', task: 'לקרוא 10 עמודים בספר', days: [0, 1, 2, 3, 4], mins: 10, energy: 2, visionId: '', log: { [ago(1)]: true, [ago(4)]: true } },
    { id: h3, title: 'סיכום יום', task: 'לכתוב 3 שורות על מה שהצליח היום', days: [0, 1, 2, 3, 4, 5, 6], mins: 5, energy: 1, visionId: '', log: {} }
  ];
  d.tasks = [
    task('לכתוב הצעת מחיר ללקוח חדש', T, { energy: 5, priority: 2, visionId: v2, projectId: p1 }),
    task('להתקשר לאינסטלטור ולקבוע ביקור', T, { energy: 2, mins: 10, brainless: true }),
    task('לשלוח חשבונית ללקוח דנה', T, { energy: 1, mins: 5, brainless: true, done: true }),
    task('להכין רשימת קניות לשבת', T, { energy: 1, mins: 10, repeat: 'w1' }),
    task('לבדוק עם המעצבת את דף הבית', addDays(T, 1), { energy: 3, projectId: p1 }),
    task('לתאם ארוחת ערב משפחתית', addDays(T, 2), { energy: 2, mins: 10, visionId: v3 }),
    task('לכתוב 3 נקודות לפוסט על הפרויקט', addDays(T, 3), { energy: 4, visionId: v2, subs: [{ id: id(), title: 'לבחור נושא אחד', done: true, mins: 5 }, { id: id(), title: 'לכתוב טיוטה של 3 משפטים', done: false, mins: 10 }] }),
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

render();
Cloud.init();
{ // intro splash, once per session (FitMe-style): the check mark draws itself, then fades out
  const sp = $('#splash');
  if (sp) {
    let seen = false; try { seen = !!sessionStorage.getItem('doit-splash'); sessionStorage.setItem('doit-splash', '1'); } catch (e) {}
    if (seen) sp.remove(); else { sp.addEventListener('animationend', e => { if (e.animationName === 'splash') sp.remove(); }); setTimeout(() => sp.remove(), 2200); }
  }
}
setTimeout(askFocus, 2400); // after the splash and the first cloud sync
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
