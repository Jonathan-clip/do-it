'use strict';
/* ---------- Storage (local now; cloud adapter plugs in here later) ---------- */
const KEY = 'doit-data-v1';
const empty = () => ({ visions: [], tasks: [], habits: [], lists: [], goals: [], notes: {} });
const TS_KEY = 'doit-updated-v1';
const Store = {
  data: empty(),
  load() {
    try { this.data = Object.assign(empty(), JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) { this.data = empty(); }
  },
  save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); localStorage.setItem(TS_KEY, new Date().toISOString()); } catch (e) {}
    Cloud.schedulePush();
  }
};

/* ---------- Cloud sync (Supabase: table doit_data, one row per user, RLS) ---------- */
const SB_URL = 'https://enzcazdpviwehxonnbrk.supabase.co';
const SB_KEY = 'sb_publishable_w7OeOyy4SoQAJHhEzVpajw_HghVFed-';
const Cloud = {
  sb: null, user: null, status: 'offline', timer: null,
  init() {
    if (!window.supabase) return;
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
    const lt = this.localTs();
    if (row && (!lt || row.updated_at > lt)) {
      Store.data = Object.assign(empty(), row.data);
      try { localStorage.setItem(KEY, JSON.stringify(Store.data)); localStorage.setItem(TS_KEY, row.updated_at); } catch (e) {}
      this.status = 'ok'; render();
    } else await this.push();
  },
  schedulePush() { if (!this.user) return; clearTimeout(this.timer); this.timer = setTimeout(() => this.push(), 800); },
  async push() {
    if (!this.user) return;
    const ts = this.localTs() || new Date().toISOString();
    const { error } = await this.sb.from('doit_data').upsert({ user_id: this.user.id, data: Store.data, updated_at: ts });
    this.status = error ? 'error' : 'ok'; render();
  }
};
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

const state = { tab: 'today', date: TODAY(), upStart: TODAY(), upDays: 14, upMode: 'three', up3: TODAY(), upWeek: weekStart(TODAY()), upMonth: TODAY().slice(0, 7), upSel: TODAY(), taskFilter: 'open', openList: null, goalFilter: 'active' };

/* ---------- Domain ---------- */
// High-energy tasks always come first in the day; then by priority.
const tasksOn = d => D().tasks.filter(t => t.date === d).sort((a, b) => (b.energy || 0) - (a.energy || 0) || b.priority - a.priority);
const stars = n => '★'.repeat(n || 0);
const subProg = t => (t.subs && t.subs.length) ? `${t.subs.filter(s => s.done).length}/${t.subs.length}` : '';
const overdue = () => D().tasks.filter(t => !t.done && t.date && t.date < TODAY());
const habitsOn = d => D().habits.filter(h => h.days.includes(parse(d).getDay()));
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
    : s.missed ? '<span class="chip" style="background:#f6dcd9;color:var(--danger)">עבר המועד</span>'
    : s.status === 'behind' ? '<span class="chip" style="background:#f9ead0;color:#9a6a12">מאחר בלוח הזמנים</span>' : '<span class="chip">בדרך</span>';
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
function taskRow(t, showDate) {
  const v = t.visionId ? visionName(t.visionId) : '';
  // Parent task; its subtasks are nested right under it.
  const subsHtml = (t.subs && t.subs.length) ? `<div class="subs">${t.subs.map(s => `<div class="row ${s.done ? 'done' : ''}"><button class="check ${s.done ? 'on' : ''}" data-act="subToggle" data-id="${t.id}" data-sid="${s.id}">${s.done ? '✓' : ''}</button><div class="t grow" data-act="taskMenu" data-id="${t.id}">${esc(s.title)}</div></div>`).join('')}</div>` : '';
  return `<div class="grp"><div class="card row p${t.priority} ${t.done ? 'done' : ''}">
    <button class="check ${t.done ? 'on' : ''}" data-act="toggleTask" data-id="${t.id}">${t.done ? '✓' : ''}</button>
    <div class="grow" data-act="taskMenu" data-id="${t.id}">
      <div class="t">${esc(t.title)}</div>
      <div class="meta">${t.brainless ? '<span class="chip" style="background:#fdf0d5;color:#9a6a12">⚡ Brainless</span>' : ''}${showDate && t.date ? `<span>${shortDate(t.date)}</span>` : ''}${t.energy ? `<span style="color:var(--accent)">${stars(t.energy)}</span>` : ''}${t.mins ? `<span>${t.mins} ד׳</span>` : ''}${subProg(t) ? `<span>☰ ${subProg(t)}</span>` : ''}${t.print ? '<span>🖨</span>' : ''}${v ? `<span class="chip">${esc(v)}</span>` : ''}</div>
    </div></div>${subsHtml}</div>`;
}
function habitRow(h, d) {
  const on = habitDone(h, d), v = h.visionId ? visionName(h.visionId) : '';
  return `<div class="card row ${on ? 'done' : ''}">
    <button class="check ${on ? 'on' : ''}" data-act="toggleHabit" data-id="${h.id}" data-date="${d}">${on ? '✓' : ''}</button>
    <div class="grow" data-act="editHabit" data-id="${h.id}"><div class="t">${esc(h.title)}</div>
    <div class="meta"><span>🔥 ${streak(h)}</span>${v ? `<span class="chip">${esc(v)}</span>` : ''}</div></div></div>`;
}

/* ---------- Upcoming board helpers ---------- */
const shiftMonth = (ym, n) => { const [y, m] = ym.split('-').map(Number); return fmt(new Date(y, m - 1 + n, 1)).slice(0, 7); };
function upCard(t, showDate) {
  const v = t.brainless ? '<span class="chip" style="background:#fdf0d5;color:#9a6a12">⚡ Brainless</span>' : '';
  return `<div class="ucard p${t.priority} ${t.done ? 'done' : ''}" data-task="${t.id}">
    <button class="check ${t.done ? 'on' : ''}" data-act="toggleTask" data-id="${t.id}">${t.done ? '✓' : ''}</button>
    <div class="grow" data-act="taskMenu" data-id="${t.id}"><div class="t">${esc(t.title)}</div>
    <div class="meta">${v}${showDate && t.date ? `<span style="color:var(--danger)">${shortDate(t.date)}</span>` : ''}${t.energy ? `<span style="color:var(--accent)">${stars(t.energy)}</span>` : ''}${t.mins ? `<span>${t.mins} ד׳</span>` : ''}${subProg(t) ? `<span>☰ ${subProg(t)}</span>` : ''}</div></div></div>`;
}
const upCol = (drop, head, count, body, extra = '') => `<section class="ucol" data-drop="${drop}"><div class="uhead"><b>${head}</b><span class="sub">${count}</span>${extra}</div>${body}</section>`;

const views = {
  today() {
    const d = state.date, ts = tasksOn(d), hs = habitsOn(d), od = d === TODAY() ? overdue() : [];
    const total = ts.length + hs.length, done = ts.filter(t => t.done).length + hs.filter(h => habitDone(h, d)).length;
    const pct = total ? Math.round(done / total * 100) : 0;
    return `<div class="top"><div><h1>${d === TODAY() ? 'היום' : 'יום נבחר'}</h1><div class="sub">${longDate(d)}</div></div>
      <div class="sw"><button class="iconbtn" data-act="account" title="סנכרון וחשבון">${Cloud.status === 'ok' ? '☁️' : Cloud.status === 'syncing' ? '🔄' : Cloud.status === 'error' ? '⚠️' : '👤'}</button><button class="iconbtn" data-act="shift" data-n="-1">›</button><button class="iconbtn" data-act="goToday">היום</button><button class="iconbtn" data-act="shift" data-n="1">‹</button></div></div>
      <div class="card"><div class="row"><b class="grow">${done}/${total} הושלמו${(() => { const m = ts.filter(t => !t.done).reduce((s, t) => s + (t.mins || 0), 0); return m ? ` · נותרו ${m} ד׳` : ''; })()}</b></div><div class="bar"><div style="width:${pct}%"></div></div></div>
      <div class="opt" style="margin-bottom:6px"><button data-act="printDayAll">🖨 הדפס את כל משימות היום</button><button data-act="printDay">🖨 רק פתוחות/מסומנות</button><button data-act="addBulk">📋 הזנה מרוכזת</button></div>
      ${od.length ? `<h2>באיחור</h2>${od.map(t => taskRow(t, true)).join('')}` : ''}
      <h2>משימות</h2>${ts.map(t => taskRow(t)).join('') || '<div class="empty">אין משימות ליום הזה</div>'}
      <h2>הרגלים</h2>${hs.map(h => habitRow(h, d)).join('') || '<div class="empty">אין הרגלים ליום הזה</div>'}
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
    const navRow = lbl => `<div class="row" style="margin:6px 0 10px"><button class="iconbtn" data-act="upNav" data-n="-1">›</button><b class="grow" style="text-align:center">${lbl}</b><button class="iconbtn" data-act="upNav" data-n="1">‹</button><button class="iconbtn" data-act="upToday">היום</button></div>`;
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
      const od = start === T ? overdue().sort((a, b) => a.date.localeCompare(b.date)) : [];
      const undated = D().tasks.filter(t => !t.date && !t.done);
      body = `<div class="uboard" id="uboard">
        ${od.length ? upCol('overdue', 'באיחור', od.length, od.map(t => upCard(t, true)).join(''), '<button class="lnk" data-act="rescheduleOverdue">העבר להיום</button>') : ''}
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
    return `<div class="top"><h1>הרגלים</h1></div>
      ${D().habits.map(h => {
        const v = h.visionId ? visionName(h.visionId) : '';
        return `<div class="card"><div class="row"><div class="grow" data-act="editHabit" data-id="${h.id}"><div class="t"><b>${esc(h.title)}</b></div>
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
      if (l) return `<div class="top"><div class="row"><button class="iconbtn" data-act="backLists">›</button><h1>${esc(l.title)}</h1></div><div class="sw"><button class="iconbtn" data-act="printList" data-id="${l.id}">🖨</button><button class="iconbtn" data-act="delList" data-id="${l.id}">🗑</button></div></div>
        ${l.items.map(i => `<div class="card row ${i.done ? 'done' : ''}"><button class="check ${i.done ? 'on' : ''}" data-act="toggleItem" data-id="${i.id}">${i.done ? '✓' : ''}</button><div class="t grow">${esc(i.text)}</div><button class="iconbtn" data-act="delItem" data-id="${i.id}">✕</button></div>`).join('') || '<div class="empty">הרשימה ריקה</div>'}
        <form id="itemForm" class="row" style="margin-top:10px"><input id="itemText" placeholder="פריט חדש" autocomplete="off"><button class="btn">הוסף</button></form>`;
      state.openList = null;
    }
    return `<div class="top"><h1>רשימות</h1></div>
      ${D().lists.map(l => `<div class="card row" data-act="openList" data-id="${l.id}"><div class="grow"><div class="t"><b>${esc(l.title)}</b></div><div class="meta">${l.items.filter(i => i.done).length}/${l.items.length} פריטים</div></div><span class="sub">‹</span></div>`).join('') || '<div class="empty">עדיין אין רשימות</div>'}
      <button class="fab" data-act="addList">+</button>`;
  }
};

function render() {
  const board = $('#uboard'), boardScroll = board ? board.scrollLeft : null; // keep the board's horizontal position across re-renders
  document.body.classList.toggle('wide', state.tab === 'upcoming');
  $('#view').innerHTML = views[state.tab]();
  if (boardScroll !== null && $('#uboard')) $('#uboard').scrollLeft = boardScroll;
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === state.tab));
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
  const s = $('#sheet'); s.innerHTML = `<div class="panel">${html}</div>`; s.hidden = false;
  s.onclick = e => { if (e.target === s) closeSheet(); };
}
function closeSheet() { $('#sheet').hidden = true; $('#sheet').innerHTML = ''; }
const visionOpts = sel => `<option value="">ללא קישור</option>` + D().visions.map(v => `<option value="${v.id}" ${v.id === sel ? 'selected' : ''}>${esc(v.title)}</option>`).join('');

function taskForm(id, presetDate) {
  const t = id ? D().tasks.find(x => x.id === id) : { title: '', date: presetDate !== undefined ? presetDate : state.date, priority: 0, print: false, visionId: '', notes: '', energy: 3, mins: 15 };
  const mo = [...new Set([5, 10, 15, 20, 30, 45, 60, 90, t.mins || 15])].sort((a, b) => a - b);
  sheet(`<h1>${id ? 'עריכת משימה' : 'משימה חדשה'}</h1>
  <form id="f">
   <label>מה לעשות</label><input name="title" required value="${esc(t.title)}" autofocus>
   <label>תאריך</label><input type="date" name="date" value="${t.date || ''}">
   <label>כמה אנרגיה זה דורש ממך? (1 = קל, 5 = הכי מאמץ)</label>
   <div class="stars" id="stars">${[1, 2, 3, 4, 5].map(n => `<button type="button" class="${n <= (t.energy || 0) ? 'on' : ''}" data-act="star" data-n="${n}">★</button>`).join('')}</div>
   <input type="hidden" name="energy" value="${t.energy || 0}">
   <label>משך (עד 15 דקות; ארוך יותר יוצע לפיצול)</label>
   <select name="mins">${mo.map(m => `<option value="${m}" ${m == (t.mins || 15) ? 'selected' : ''}>${m} דקות</option>`).join('')}</select>
   <label>עדיפות</label><select name="priority"><option value="0" ${t.priority == 0 ? 'selected' : ''}>רגילה</option><option value="1" ${t.priority == 1 ? 'selected' : ''}>חשובה</option><option value="2" ${t.priority == 2 ? 'selected' : ''}>דחופה</option></select>
   <label>קישור לחזון (אופציונלי)</label><select name="visionId">${visionOpts(t.visionId)}</select>
   <label>הערות</label><textarea name="notes">${esc(t.notes || '')}</textarea>
   <label class="row" style="color:var(--ink)"><input type="checkbox" name="brainless" style="width:auto" ${t.brainless ? 'checked' : ''}> ⚡ Brainless (משימה פשוטה שאפשר להעיף ברגע)</label>
   <label class="row" style="color:var(--ink)"><input type="checkbox" name="print" style="width:auto" ${t.print ? 'checked' : ''}> סמן להדפסה</label>
   <div class="actions">${id ? '<button type="button" class="btn danger" data-act="delTask" data-id="' + id + '">מחק</button>' : ''}<button type="button" class="btn ghost" data-act="close">ביטול</button><button class="btn">שמור</button></div>
  </form>`);
  $('#f').onsubmit = e => {
    e.preventDefault(); const f = new FormData(e.target);
    const obj = { title: f.get('title').trim(), date: f.get('date') || null, priority: +f.get('priority'), visionId: f.get('visionId') || '', notes: f.get('notes'), print: f.get('print') === 'on', brainless: f.get('brainless') === 'on', energy: +f.get('energy'), mins: +f.get('mins') };
    let saved = t;
    if (id) Object.assign(t, obj); else { saved = { id: uid(), done: false, subs: [], ...obj }; D().tasks.push(saved); }
    resolveLong([saved]);
  };
}
function habitForm(id) {
  const h = id ? D().habits.find(x => x.id === id) : { title: '', days: [0, 1, 2, 3, 4, 5, 6], visionId: '' };
  const days = new Set(h.days);
  sheet(`<h1>${id ? 'עריכת הרגל' : 'הרגל חדש'}</h1>
  <form id="f"><label>שם ההרגל</label><input name="title" required value="${esc(h.title)}">
   <label>באילו ימים</label><div class="days">${DAYS.map((x, i) => `<button type="button" class="${days.has(i) ? 'on' : ''}" data-act="dayTog" data-d="${i}">${x}</button>`).join('')}</div>
   <label>קישור לחזון (אופציונלי)</label><select name="visionId">${visionOpts(h.visionId)}</select>
   <div class="actions">${id ? '<button type="button" class="btn danger" data-act="delHabit" data-id="' + id + '">מחק</button>' : ''}<button type="button" class="btn ghost" data-act="close">ביטול</button><button class="btn">שמור</button></div></form>`);
  $('#f').onsubmit = e => {
    e.preventDefault();
    const sel = [...document.querySelectorAll('.days .on')].map(b => +b.dataset.d);
    const obj = { title: new FormData(e.target).get('title').trim(), days: sel.length ? sel : [0, 1, 2, 3, 4, 5, 6], visionId: new FormData(e.target).get('visionId') || '' };
    if (id) Object.assign(h, obj); else D().habits.push({ id: uid(), log: {}, ...obj });
    Store.save(); closeSheet(); render();
  };
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
    (g.entries = g.entries || []).push({ id: uid(), date: d.get('date'), amt: +d.get('amt') });
    Store.save(); render(); goalProgressSheet(id);
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

/* ---------- Task menu, move, subtasks ---------- */
const findTask = id => D().tasks.find(x => x.id === id);
function menuSheet(id) {
  const t = findTask(id); if (!t) return closeSheet();
  const v = t.visionId ? visionName(t.visionId) : '';
  sheet(`<h1>${esc(t.title)}</h1>
   <div class="meta" style="margin-bottom:10px">${t.brainless ? '<span class="chip" style="background:#fdf0d5;color:#9a6a12">⚡ Brainless</span>' : ''}${t.date ? `<span>${longDate(t.date)}</span>` : '<span>ללא תאריך</span>'}${t.energy ? `<span style="color:var(--accent)">${stars(t.energy)}</span>` : ''}${t.mins ? `<span>${t.mins} ד׳</span>` : ''}${v ? `<span class="chip">${esc(v)}</span>` : ''}</div>
   ${t.notes ? `<p class="sub" style="white-space:pre-wrap">${esc(t.notes)}</p>` : ''}
   ${(t.subs || []).map(s => `<div class="row ${s.done ? 'done' : ''}" style="margin:6px 0"><button class="check ${s.done ? 'on' : ''}" data-act="subToggle" data-id="${t.id}" data-sid="${s.id}">${s.done ? '✓' : ''}</button><div class="t grow">${esc(s.title)}</div><button class="iconbtn" data-act="subDel" data-id="${t.id}" data-sid="${s.id}">✕</button></div>`).join('')}
   <form id="subForm" class="row" style="margin-top:8px" hidden><input id="subText" placeholder="תת משימה חדשה" autocomplete="off"><button class="btn">הוסף</button></form>
   <div class="grid2">
     <button class="btn" data-act="menuDone" data-id="${t.id}">${t.done ? '↺ בטל ביצוע' : '✓ בוצע'}</button>
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
function splitParts(t) {
  const n = Math.ceil(t.mins / 15), each = Math.ceil(t.mins / n);
  return Array.from({ length: n }, (_, i) => ({ ...t, id: uid(), title: `${t.title} (${i + 1}/${n})`, mins: each, subs: i === 0 ? (t.subs || []) : [] }));
}
function resolveLong(list) {
  const q = list.filter(t => (t.mins || 0) > 15);
  const next = () => {
    const t = q.shift();
    if (!t) { Store.save(); closeSheet(); render(); return; }
    const n = Math.ceil(t.mins / 15);
    splitCtx = { t, next };
    sheet(`<h1>משימה ארוכה</h1><p>"${esc(t.title)}" נמשכת ${t.mins} דקות, ומשימה צריכה להיות עד 15 דקות. לפצל ל-${n} חלקים של כ-${Math.ceil(t.mins / n)} דקות?</p>
     <div class="actions"><button class="btn ghost" data-act="keepLong">להשאיר כמו שהיא</button><button class="btn" data-act="doSplit">לפצל ל-${n}</button></div>`);
  };
  next();
}

/* ---------- Bulk entry ---------- */
let bulk = [];
const bulkDateOpts = () => { const T = TODAY(); return [['היום', T], ['מחר', addDays(T, 1)], ['מחרתיים', addDays(T, 2)], ['ללא', null]]; };
function bulkStart() {
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
   <div class="sub">קבע תאריך לכולן:</div><div class="opt" style="margin:6px 0 12px">${dopts.map(([l], j) => `<button data-act="bulkAllDate" data-j="${j}">${l}</button>`).join('')}</div>
   ${bulk.map((b, i) => `<div class="bulkrow ${showMiss && (b.date === undefined || !b.energy) ? 'miss' : ''}"><div class="t"><b>${esc(b.title)}</b></div>
     <label>מתי?</label><div class="opt">${dopts.map(([l, v], j) => `<button class="${b.date === v ? 'on' : ''}" data-act="bulkDate" data-i="${i}" data-j="${j}">${l}</button>`).join('')}<input type="date" style="width:auto" data-bulkdate="${i}" value="${b.date && !dopts.some(o => o[1] === b.date) ? b.date : ''}"></div>
     <label>אנרגיה</label><div class="stars">${[1, 2, 3, 4, 5].map(n => `<button type="button" class="${n <= b.energy ? 'on' : ''}" data-act="bulkStar" data-i="${i}" data-n="${n}">★</button>`).join('')}</div>
     <label>משך (דקות)</label><div class="opt">${[5, 10, 15, 20, 30, 45, 60].map(m => `<button class="${b.mins === m ? 'on' : ''}" data-act="bulkMins" data-i="${i}" data-m="${m}">${m}</button>`).join('')}</div>
     <div class="opt" style="margin-top:8px"><button class="${b.brainless ? 'on' : ''}" data-act="bulkBrain" data-i="${i}">⚡ Brainless (פשוטה, אפשר להעיף ברגע)</button></div></div>`).join('')}
   ${showMiss ? '<div class="sub" style="color:var(--danger)">חסר תאריך או אנרגיה בשורות המסומנות.</div>' : ''}
   <div class="actions"><button class="btn ghost" data-act="close">ביטול</button><button class="btn" data-act="bulkSave">הוסף ${bulk.length} משימות</button></div>`);
  $('#sheet .panel').scrollTop = st;
}

function accountSheet() {
  if (!Cloud.sb) { sheet(`<h1>סנכרון</h1><p class="sub">לא ניתן לטעון את שירות הענן (בדוק חיבור לאינטרנט). הנתונים נשמרים בינתיים בטלפון.</p><div class="actions"><button class="btn ghost" data-act="close">סגור</button></div>`); return; }
  if (Cloud.user) {
    const st = { ok: 'מסונכרן ✓', syncing: 'מסנכרן...', error: 'שגיאת סנכרון', offline: '' }[Cloud.status];
    sheet(`<h1>החשבון שלי</h1><p>${esc(Cloud.user.email)}</p><p class="sub">${st}</p>
      <div class="actions"><button class="btn ghost" data-act="syncNow">סנכרן עכשיו</button><button class="btn danger" data-act="logout">התנתק</button></div>
      <div class="actions"><button class="btn ghost" data-act="close">סגור</button></div>`);
    return;
  }
  sheet(`<h1>כניסה וסנכרון</h1><p class="sub">התחבר כדי לשמור את הנתונים בענן ולראות אותם בכל המכשירים.</p>
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
  let ts = tasksOn(d).concat(d === TODAY() ? overdue() : []);
  if (!all) {
    ts = ts.filter(t => !t.done);
    const flagged = ts.filter(t => t.print);
    if (flagged.length) ts = flagged;
  }
  printHTML(`<h1>${longDate(d)}</h1><h2>משימות</h2>${ts.map(t => '<div>' + pRow((t.done ? '✓ ' : '') + (t.priority == 2 ? '‼ ' : t.priority == 1 ? '! ' : '') + t.title + (t.mins ? ` · ${t.mins} ד׳` : '') + (t.energy ? ' ' + stars(t.energy) : '')) + (t.subs || []).filter(s => all || !s.done).map(s => `<div style="margin-inline-start:26px">${pRow(s.title, true)}</div>`).join('') + '</div>').join('') || '<div class="pl">—</div>'}
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
  toggleTask: e => { const t = D().tasks.find(x => x.id === e.id); t.done = !t.done; Store.save(); render(); },
  toggleHabit: e => { const h = D().habits.find(x => x.id === e.id); if (h.log[e.date]) delete h.log[e.date]; else h.log[e.date] = true; Store.save(); render(); },
  editTask: e => taskForm(e.id), addTask: () => taskForm(),
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
  goalClaim: e => { const g = D().goals.find(x => x.id === e.id); g.claimed = true; g.claimedAt = TODAY(); Store.save(); render(); },
  goalEntryDel: e => { const g = D().goals.find(x => x.id === e.id); g.entries = g.entries.filter(x => x.id !== e.eid); Store.save(); render(); goalProgressSheet(e.id); },
  delGoal: e => { if (confirm('למחוק את היעד?')) { D().goals = D().goals.filter(x => x.id !== e.id); Store.save(); closeSheet(); render(); } },
  star: e => { const n = +e.n; document.querySelectorAll('#stars button').forEach((b, i) => b.classList.toggle('on', i < n)); document.querySelector('input[name=energy]').value = n; },
  taskMenu: e => menuSheet(e.id),
  menuDone: e => { const t = findTask(e.id); t.done = !t.done; Store.save(); closeSheet(); render(); },
  moveSheet: e => moveSheet(e.id),
  moveTo: e => { findTask(e.id).date = e.d === 'none' ? null : e.d; Store.save(); closeSheet(); render(); },
  moveCustom: e => { const v = $('#moveDate').value; if (!v) return; findTask(e.id).date = v; Store.save(); closeSheet(); render(); },
  subShow: () => { const f = $('#subForm'); f.hidden = false; $('#subText').focus(); },
  subToggle: e => { const s = findTask(e.id).subs.find(x => x.id === e.sid); s.done = !s.done; Store.save(); render(); if (!$('#sheet').hidden) menuSheet(e.id); },
  subDel: e => { const t = findTask(e.id); t.subs = t.subs.filter(x => x.id !== e.sid); Store.save(); render(); menuSheet(e.id); },
  keepLong: () => splitCtx.next(),
  doSplit: () => { const { t, next } = splitCtx; D().tasks.splice(D().tasks.indexOf(t), 1, ...splitParts(t)); next(); },
  addBulk: bulkStart,
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
    bulk = lines.map(title => ({ title, date: undefined, energy: 0, mins: 15, brainless: false })); bulkRender();
  },
  bulkAllDate: e => { const v = bulkDateOpts()[+e.j][1]; bulk.forEach(b => { b.date = v; }); bulkRender(); },
  bulkDate: e => { bulk[+e.i].date = bulkDateOpts()[+e.j][1]; bulkRender(); },
  bulkStar: e => { bulk[+e.i].energy = +e.n; bulkRender(); },
  bulkMins: e => { bulk[+e.i].mins = +e.m; bulkRender(); },
  bulkBrain: e => { bulk[+e.i].brainless = !bulk[+e.i].brainless; bulkRender(); },
  bulkSave: () => {
    if (bulk.some(b => b.date === undefined || !b.energy)) return bulkRender(true);
    const created = bulk.map(b => ({ id: uid(), done: false, title: b.title, date: b.date, priority: 0, visionId: '', notes: '', print: false, brainless: b.brainless, energy: b.energy, mins: b.mins, subs: [] }));
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
  if (nav) { state.tab = nav.dataset.tab; state.openList = null; render(); window.scrollTo(0, 0); }
});
document.addEventListener('change', ev => {
  if (ev.target.id === 'upMonth') {
    const v = ev.target.value, first = v === TODAY().slice(0, 7) ? TODAY() : v + '-01';
    if (state.upMode === 'month') { state.upMonth = v; state.upSel = first; } else { state.upStart = first; state.upDays = 14; }
    render(); return;
  }
  const i = ev.target.dataset && ev.target.dataset.bulkdate;
  if (i !== undefined) { bulk[+i].date = ev.target.value || undefined; bulkRender(); }
});
document.addEventListener('input', ev => {
  if (ev.target.id === 'note') { D().notes[state.date] = ev.target.value; Store.save(); }
});

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

render();
Cloud.init();
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
