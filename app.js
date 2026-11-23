'use strict';
/* ---------- Storage (local now; cloud adapter plugs in here later) ---------- */
const KEY = 'doit-data-v1';
const empty = () => ({ visions: [], tasks: [], habits: [], lists: [], notes: {} });
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

const state = { tab: 'today', date: TODAY(), calMode: 'month', calMonth: TODAY().slice(0, 7), taskFilter: 'open', openList: null };

/* ---------- Domain ---------- */
const tasksOn = d => D().tasks.filter(t => t.date === d).sort((a, b) => b.priority - a.priority);
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

/* ---------- Rendering ---------- */
function taskRow(t, showDate) {
  const v = t.visionId ? visionName(t.visionId) : '';
  return `<div class="card row p${t.priority} ${t.done ? 'done' : ''}">
    <button class="check ${t.done ? 'on' : ''}" data-act="toggleTask" data-id="${t.id}">${t.done ? '✓' : ''}</button>
    <div class="grow" data-act="editTask" data-id="${t.id}">
      <div class="t">${esc(t.title)}</div>
      <div class="meta">${showDate && t.date ? `<span>${shortDate(t.date)}</span>` : ''}${t.print ? '<span>🖨</span>' : ''}${v ? `<span class="chip">${esc(v)}</span>` : ''}</div>
    </div></div>`;
}
function habitRow(h, d) {
  const on = habitDone(h, d), v = h.visionId ? visionName(h.visionId) : '';
  return `<div class="card row ${on ? 'done' : ''}">
    <button class="check ${on ? 'on' : ''}" data-act="toggleHabit" data-id="${h.id}" data-date="${d}">${on ? '✓' : ''}</button>
    <div class="grow" data-act="editHabit" data-id="${h.id}"><div class="t">${esc(h.title)}</div>
    <div class="meta"><span>🔥 ${streak(h)}</span>${v ? `<span class="chip">${esc(v)}</span>` : ''}</div></div></div>`;
}

const views = {
  today() {
    const d = state.date, ts = tasksOn(d), hs = habitsOn(d), od = d === TODAY() ? overdue() : [];
    const total = ts.length + hs.length, done = ts.filter(t => t.done).length + hs.filter(h => habitDone(h, d)).length;
    const pct = total ? Math.round(done / total * 100) : 0;
    return `<div class="top"><div><h1>${d === TODAY() ? 'היום' : 'יום נבחר'}</h1><div class="sub">${longDate(d)}</div></div>
      <div class="sw"><button class="iconbtn" data-act="account" title="סנכרון וחשבון">${Cloud.status === 'ok' ? '☁️' : Cloud.status === 'syncing' ? '🔄' : Cloud.status === 'error' ? '⚠️' : '👤'}</button><button class="iconbtn" data-act="shift" data-n="-1">›</button><button class="iconbtn" data-act="goToday">היום</button><button class="iconbtn" data-act="shift" data-n="1">‹</button></div></div>
      <div class="card"><div class="row"><b class="grow">${done}/${total} הושלמו</b><button class="iconbtn" data-act="printDay">🖨 הדפסה</button></div><div class="bar"><div style="width:${pct}%"></div></div></div>
      ${od.length ? `<h2>באיחור</h2>${od.map(t => taskRow(t, true)).join('')}` : ''}
      <h2>משימות</h2>${ts.map(t => taskRow(t)).join('') || '<div class="empty">אין משימות ליום הזה</div>'}
      <h2>הרגלים</h2>${hs.map(h => habitRow(h, d)).join('') || '<div class="empty">אין הרגלים ליום הזה</div>'}
      <h2>פתק יומי</h2><textarea id="note" placeholder="מחשבות, סיכום, דברים לזכור...">${esc(D().notes[d] || '')}</textarea>
      <button class="fab" data-act="addTask" aria-label="משימה חדשה">+</button>`;
  },
  calendar() {
    const sel = state.date;
    let body = '', title = '';
    if (state.calMode === 'month') {
      const [y, m] = state.calMonth.split('-').map(Number);
      title = `${MONTHS[m - 1]} ${y}`;
      const first = new Date(y, m - 1, 1), start = new Date(y, m - 1, 1 - first.getDay());
      let cells = DAYS.map(x => `<div class="h">${x}</div>`).join('');
      for (let i = 0; i < 42; i++) {
        const c = new Date(start); c.setDate(start.getDate() + i);
        const s = fmt(c), n = tasksOn(s).length;
        cells += `<button class="cell ${c.getMonth() !== m - 1 ? 'out' : ''} ${s === TODAY() ? 'today' : ''} ${s === sel ? 'sel' : ''}" data-act="pickDay" data-date="${s}">${c.getDate()}<span class="dot">${n ? '●'.repeat(Math.min(n, 3)) : '&nbsp;'}</span></button>`;
      }
      body = `<div class="grid">${cells}</div>`;
    } else {
      const ws = weekStart(sel);
      title = `${shortDate(ws)} – ${shortDate(addDays(ws, 6))}`;
      body = Array.from({ length: 7 }, (_, i) => {
        const s = addDays(ws, i), ts = tasksOn(s), hs = habitsOn(s);
        return `<div class="card ${s === TODAY() ? 'today' : ''}"><div class="row" data-act="openDay" data-date="${s}"><b class="grow">יום ${DAYN[i]} · ${shortDate(s)}</b><span class="sub">${ts.filter(t => t.done).length}/${ts.length} · 🔁${hs.length}</span></div>
        ${ts.map(t => `<div class="row ${t.done ? 'done' : ''}" style="margin-top:6px"><button class="check ${t.done ? 'on' : ''}" style="width:20px;height:20px;font-size:11px" data-act="toggleTask" data-id="${t.id}">${t.done ? '✓' : ''}</button><div class="t grow" data-act="editTask" data-id="${t.id}" style="font-size:14px">${esc(t.title)}</div></div>`).join('')}</div>`;
      }).join('');
    }
    const dayTs = tasksOn(sel);
    return `<div class="top"><h1>יומן</h1><div class="sw"><button class="iconbtn" data-act="calPrev">›</button><button class="iconbtn" data-act="calNext">‹</button></div></div>
      <div class="seg"><button class="${state.calMode === 'month' ? 'on' : ''}" data-act="calMode" data-m="month">חודש</button><button class="${state.calMode === 'week' ? 'on' : ''}" data-act="calMode" data-m="week">שבוע</button><button data-act="printWeek" style="margin-inline-start:auto">🖨 שבוע</button></div>
      <div class="sub" style="margin-bottom:8px"><b>${title}</b></div>${body}
      ${state.calMode === 'month' ? `<h2>${longDate(sel)}</h2>${dayTs.map(t => taskRow(t)).join('') || '<div class="empty">אין משימות</div>'}<div class="actions"><button class="btn ghost" data-act="openDay" data-date="${sel}">פתח ביום</button><button class="btn" data-act="addTask">+ משימה</button></div>` : '<button class="fab" data-act="addTask">+</button>'}`;
  },
  tasks() {
    const f = state.taskFilter;
    let list = D().tasks.slice();
    if (f === 'open') list = list.filter(t => !t.done);
    if (f === 'done') list = list.filter(t => t.done);
    if (f === 'nodate') list = list.filter(t => !t.date && !t.done);
    list.sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999') || b.priority - a.priority);
    const F = [['open', 'פתוחות'], ['nodate', 'ללא תאריך'], ['done', 'הושלמו'], ['all', 'הכל']];
    return `<div class="top"><h1>משימות</h1><button class="iconbtn" data-act="printSel">🖨 נבחרות</button></div>
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
        <div class="meta"><span>✅ ${dn}/${ts.length} משימות</span><span>🔁 ${hs.length} הרגלים</span>${v.area ? `<span class="chip">${esc(v.area)}</span>` : ''}</div></div>`;
      }).join('') || '<div class="empty">כתוב כאן את החזון שלך, תחומי חיים ויעדים גדולים</div>'}
      <button class="fab" data-act="addVision">+</button>`;
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
  $('#view').innerHTML = views[state.tab]();
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

function taskForm(id) {
  const t = id ? D().tasks.find(x => x.id === id) : { title: '', date: state.date, priority: 0, print: false, visionId: '', notes: '' };
  sheet(`<h1>${id ? 'עריכת משימה' : 'משימה חדשה'}</h1>
  <form id="f">
   <label>מה לעשות</label><input name="title" required value="${esc(t.title)}" autofocus>
   <label>תאריך</label><input type="date" name="date" value="${t.date || ''}">
   <label>עדיפות</label><select name="priority"><option value="0" ${t.priority == 0 ? 'selected' : ''}>רגילה</option><option value="1" ${t.priority == 1 ? 'selected' : ''}>חשובה</option><option value="2" ${t.priority == 2 ? 'selected' : ''}>דחופה</option></select>
   <label>קישור לחזון (אופציונלי)</label><select name="visionId">${visionOpts(t.visionId)}</select>
   <label>הערות</label><textarea name="notes">${esc(t.notes || '')}</textarea>
   <label class="row" style="color:var(--ink)"><input type="checkbox" name="print" style="width:auto" ${t.print ? 'checked' : ''}> סמן להדפסה</label>
   <div class="actions">${id ? '<button type="button" class="btn danger" data-act="delTask" data-id="' + id + '">מחק</button>' : ''}<button type="button" class="btn ghost" data-act="close">ביטול</button><button class="btn">שמור</button></div>
  </form>`);
  $('#f').onsubmit = e => {
    e.preventDefault(); const f = new FormData(e.target);
    const obj = { title: f.get('title').trim(), date: f.get('date') || null, priority: +f.get('priority'), visionId: f.get('visionId') || '', notes: f.get('notes'), print: f.get('print') === 'on' };
    if (id) Object.assign(t, obj); else D().tasks.push({ id: uid(), done: false, ...obj });
    Store.save(); closeSheet(); render();
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
function listForm() {
  sheet(`<h1>רשימה חדשה</h1><form id="f"><label>שם הרשימה</label><input name="title" required autofocus>
   <div class="actions"><button type="button" class="btn ghost" data-act="close">ביטול</button><button class="btn">צור</button></div></form>`);
  $('#f').onsubmit = e => {
    e.preventDefault(); const l = { id: uid(), title: new FormData(e.target).get('title').trim(), items: [] };
    D().lists.push(l); Store.save(); closeSheet(); state.openList = l.id; render();
  };
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
function printDay() {
  const d = state.date;
  let ts = tasksOn(d).concat(d === TODAY() ? overdue() : []);
  const flagged = ts.filter(t => t.print);
  if (flagged.length) ts = flagged;
  ts = ts.filter(t => !t.done);
  printHTML(`<h1>${longDate(d)}</h1><h2>משימות</h2>${ts.map(t => pRow((t.priority == 2 ? '‼ ' : t.priority == 1 ? '! ' : '') + t.title)).join('') || '<div class="pl">—</div>'}
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
  delVision: e => { if (confirm('למחוק את פריט החזון? קישורים אליו יוסרו.')) { D().visions = D().visions.filter(x => x.id !== e.id); D().tasks.forEach(t => { if (t.visionId === e.id) t.visionId = ''; }); D().habits.forEach(h => { if (h.visionId === e.id) h.visionId = ''; }); Store.save(); closeSheet(); render(); } },
  close: closeSheet,
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
  pickDay: e => { state.date = e.date; render(); },
  openDay: e => { state.date = e.date; state.tab = 'today'; render(); },
  calMode: e => { state.calMode = e.m; render(); },
  calPrev: () => calMove(-1), calNext: () => calMove(1),
  filter: e => { state.taskFilter = e.f; render(); },
  printDay, printWeek, printSel,
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
function calMove(n) {
  if (state.calMode === 'month') {
    const [y, m] = state.calMonth.split('-').map(Number), d = new Date(y, m - 1 + n, 1);
    state.calMonth = fmt(d).slice(0, 7); state.date = fmt(d);
  } else { state.date = addDays(state.date, 7 * n); state.calMonth = state.date.slice(0, 7); }
  render();
}

document.addEventListener('click', ev => {
  const el = ev.target.closest('[data-act]');
  if (el) { const fn = A[el.dataset.act]; if (fn) { ev.preventDefault(); fn({ ...el.dataset }, el); } return; }
  const nav = ev.target.closest('#nav button');
  if (nav) { state.tab = nav.dataset.tab; state.openList = null; render(); window.scrollTo(0, 0); }
});
document.addEventListener('input', ev => {
  if (ev.target.id === 'note') { D().notes[state.date] = ev.target.value; Store.save(); }
});

render();
Cloud.init();
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
