'use strict';
/* Tareas — PWA de tareas del hogar para dos. JS sin dependencias ni build. */

// ------------------------------------------------------------ utilidades --
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const plural = (n, a, b) => `${n} ${n === 1 ? a : b}`;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 12)).replace(/[^\w-]/g, '');

const store = {
  get(k, d) { try { const v = localStorage.getItem('tareas.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('tareas.' + k, JSON.stringify(v)); } catch { /* modo privado */ } },
};

const ICON = {
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  tag: '<svg viewBox="0 0 24 24"><path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><circle cx="7.5" cy="7.5" r="1.3"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 8 13"><path d="m1 1 6 5.5L1 12"/></svg>',
  left: '<svg viewBox="0 0 24 24"><path d="m15 5-7 7 7 7"/></svg>',
  right: '<svg viewBox="0 0 24 24"><path d="m9 5 7 7-7 7"/></svg>',
};

// ---------------------------------------------------------------- fechas ---
// Fechas como texto 'YYYY-MM-DD' en hora local (como el servidor).
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseISO = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const todayISO = () => iso(new Date());
const wd = (d) => (d.getDay() + 6) % 7; // 0 = lunes
const diffDays = (a, b) => Math.round((parseISO(b) - parseISO(a)) / 864e5);
const DOW = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
const DOW1 = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
const DOW3 = ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'];
const MON3 = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function fmtDay(s) { const d = parseISO(s); return `${DOW3[wd(d)]} ${d.getDate()} ${MON3[d.getMonth()]}`; }
function relDay(s) {
  const n = diffDays(todayISO(), s);
  if (n === 0) return 'hoy';
  if (n === 1) return 'mañana';
  if (n === -1) return 'ayer';
  if (n < 0) return `hace ${-n} días`;
  if (n < 7) return `el ${DOW[wd(parseISO(s))]}`;
  return `el ${fmtDay(s)}`;
}
function fmtTime(ts) { const d = new Date(ts * 1000); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }

// ------------------------------------------------------------ calendario ---
// Misma lógica que server.py (occurrence_after / next_due / first_due).
function weekdayList(t, anchor) {
  const days = String(t.weekdays || '').split(',').filter((x) => /^\d$/.test(x.trim())).map(Number);
  return days.length ? days : [wd(anchor)];
}
function occurrenceAfter(t, after, anchor) {
  const n = Math.max(1, t.every || 1);
  if (t.freq === 'weekly') {
    const days = weekdayList(t, anchor);
    const monday = addDays(anchor, -wd(anchor));
    for (let i = 1; i < 7 * n + 8; i++) {
      const d = addDays(after, i);
      const w = Math.floor(Math.round((d - monday) / 864e5) / 7);
      if (((w % n) + n) % n === 0 && days.includes(wd(d))) return d;
    }
  } else if (t.freq === 'monthly') {
    const md = t.month_day || anchor.getDate();
    for (let k = 0; k < 1200; k += n) {
      const y = anchor.getFullYear(); const m = anchor.getMonth() + k;
      const last = new Date(y, m + 1, 0).getDate();
      const d = new Date(y, m, Math.min(md, last));
      if (d > after) return d;
    }
  } else if (t.freq === 'days') {
    return addDays(after, n);
  }
  return addDays(after, 1);
}
function nextDue(t, doneISO) {
  if (t.freq === 'once') return null;
  const done = parseISO(doneISO);
  if (t.freq === 'days') return iso(addDays(done, Math.max(1, t.every || 1)));
  const due = t.due ? parseISO(t.due) : done;
  return iso(occurrenceAfter(t, done > due ? done : due, due));
}
function firstDue(t, startISO) {
  if (t.freq === 'once') return null;
  if (t.freq === 'days') return startISO;
  const s = parseISO(startISO);
  return iso(occurrenceAfter(t, addDays(s, -1), s));
}
function skipDue(t) {
  const td = todayISO();
  return nextDue(t, t.due && t.due > td ? t.due : td);
}

// ----------------------------------------------------------------- estado --
const S = {
  base: store.get('state', null), // última copia recibida del servidor
  data: null, // base + cambios pendientes de enviar
  me: store.get('me', null),
  tab: store.get('tab', 'hoy'),
  ui: {
    fWho: store.get('fWho', 'todas'), qTareas: '', fTareas: 'todas', week: 0, period: 'semana',
    markWho: null, markWhen: 'hoy', hist: null,
  },
  outbox: store.get('outbox', []),
  online: true,
  sheet: null, // { kind, id, live }
  es: null,
};
let IDX = {};

function derive() {
  S.data = S.base ? JSON.parse(JSON.stringify(S.base)) : null;
  if (!S.data) return;
  index(); // applyOp necesita las personas
  for (const op of S.outbox) applyOp(S.data, op);
  index();
}

function index() {
  const d = S.data;
  const tasks = new Map(d.tasks.map((t) => [t.id, t]));
  const rooms = new Map(d.rooms.map((r) => [r.id, r]));
  const roomPos = new Map(d.rooms.map((r, i) => [r.id, i]));
  const people = d.people || [{ id: 'carlos', name: 'Carlos' }, { id: 'zoe', name: 'Zoe' }];
  IDX = { tasks, rooms, roomPos, people };
}

const personName = (id) => ({ both: 'Los dos', any: 'Cualquiera' }[id] || IDX.people?.find((p) => p.id === id)?.name || id);
const otherOf = (id) => (IDX.people[0].id === id ? IDX.people[1].id : IDX.people[0].id);
const initial = (id) => (id === 'both' ? IDX.people.map((p) => p.name[0]).join('') : personName(id)[0] || '?');
const roomName = (id) => (id && IDX.rooms.get(id)?.name) || '';
const activeTasks = () => S.data.tasks.filter((t) => t.active);
const EFFORT = { 1: 'Ligera', 2: 'Normal', 3: 'Pesada' };
const pts = (n) => plural(n, 'punto', 'puntos');

function rotated(t, who) {
  if (!t.rotate) return t.assignee;
  if (who === 'both') return IDX.people.some((p) => p.id === t.assignee) ? otherOf(t.assignee) : IDX.people[0].id;
  return otherOf(who);
}

// Cambios rápidos (hecha, deshacer, saltar, posponer…): se aplican al momento
// sobre la copia local y se envían en orden. Sin red se quedan en cola.
function applyOp(d, op) {
  const t = op.task_id != null ? d.tasks.find((x) => x.id === op.task_id) : null;
  if (op.kind === 'done') {
    if (!t || !t.active || (t.due ?? null) !== (op.seen_due ?? null)) return;
    const next = nextDue(t, op.date);
    d.completions.unshift({
      uid: op.uid, task_id: t.id, task_name: t.name, room_name: d.rooms.find((r) => r.id === t.room_id)?.name || '',
      who: op.who, done_date: op.date, done_at: op.at, prev_due: t.due, prev_assignee: t.assignee, next_due: next, points: t.effort || 2, pending: true,
    });
    if (t.freq === 'once') t.active = 0;
    else { t.due = next; t.assignee = rotated(t, op.who); }
  } else if (op.kind === 'undo') {
    const i = d.completions.findIndex((c) => c.uid === op.uid);
    if (i < 0) return;
    const c = d.completions[i];
    const tt = d.tasks.find((x) => x.id === c.task_id);
    if (tt && d.completions.find((x) => x.task_id === c.task_id) === c) {
      if (!tt.active) tt.active = 1;
      else if (c.next_due && tt.due === c.next_due) { tt.due = c.prev_due; tt.assignee = c.prev_assignee || tt.assignee; }
    }
    d.completions.splice(i, 1);
  } else if (op.kind === 'who') {
    const c = d.completions.find((x) => x.uid === op.uid);
    if (c) c.who = op.who;
  } else if (op.kind === 'skip') {
    if (t && t.due === op.seen_due) t.due = skipDue(t);
  } else if (op.kind === 'snooze') {
    if (t) t.due = op.due;
  }
}

function opRequest(op) {
  switch (op.kind) {
    case 'done': return ['POST', `/api/tasks/${op.task_id}/done`, { uid: op.uid, who: op.who, date: op.date, at: op.at, seen_due: op.seen_due }];
    case 'undo': return ['DELETE', `/api/completions/${op.uid}`];
    case 'who': return ['PATCH', `/api/completions/${op.uid}`, { who: op.who }];
    case 'skip': return ['POST', `/api/tasks/${op.task_id}/skip`, { seen_due: op.seen_due }];
    case 'snooze': return ['POST', `/api/tasks/${op.task_id}/snooze`, { due: op.due }];
    default: return null;
  }
}

function saveOutbox() { store.set('outbox', S.outbox.map(({ sending, ...o }) => o)); }

function queue(op) {
  if (op.kind === 'undo') {
    // Si aún no se había enviado, basta con olvidarlo.
    const i = S.outbox.findIndex((o) => o.kind === 'done' && o.uid === op.uid && !o.sending);
    if (i >= 0) { S.outbox.splice(i, 1); saveOutbox(); refresh(); return; }
  }
  S.outbox.push(op);
  saveOutbox();
  refresh();
  sync();
}

function refresh() {
  derive();
  render();
  if (S.sheet?.live) S.sheet.live();
  updateBanner();
}

// ------------------------------------------------------------------- red ---
class ApiError extends Error {}

async function api(method, url, body, opts = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    setOnline(false);
    if (!opts.silent) toast('Sin conexión. Esto necesita red: inténtalo cuando vuelva.');
    throw e;
  }
  setOnline(true);
  if (res.status === 401 && url !== '/api/login') { showLogin(); throw new ApiError('No autenticado'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new ApiError(data.error || 'Error ' + res.status);
    if (!opts.silent) toast(err.message);
    throw err;
  }
  if (method !== 'GET') scheduleRefresh();
  return data;
}

let flushing = null;
function flushOutbox() {
  if (flushing) return flushing;
  flushing = (async () => {
    while (S.outbox.length) {
      const op = S.outbox[0];
      const [method, url, body] = opRequest(op) || [];
      if (!method) { S.outbox.shift(); continue; }
      op.sending = true;
      let res;
      try {
        res = await fetch(url, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      } catch { op.sending = false; setOnline(false); return false; }
      setOnline(true);
      if (res.status === 401) { op.sending = false; await res.text().catch(() => {}); showLogin(); return false; }
      if (res.status >= 500) { op.sending = false; return false; }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) toast(data.error || 'No se pudo guardar un cambio');
      else if (data.message) toast(data.message);
      const i = S.outbox.indexOf(op);
      if (i >= 0) S.outbox.splice(i, 1);
      saveOutbox();
    }
    return true;
  })().finally(() => { flushing = null; updateBanner(); });
  return flushing;
}

let loading = null;
function loadState() {
  if (loading) return loading;
  loading = (async () => {
    let sent = false;
    try {
      sent = await flushOutbox();
      const d = await api('GET', '/api/state', null, { silent: true });
      announce(S.base, d);
      S.base = d;
      store.set('state', d);
      refresh();
    } catch { /* sin red: seguimos con la copia local */ } finally {
      loading = null;
      // Algo se quedó en cola mientras cargaba: se envía ya. Si falló, lo reintenta el temporizador.
      if (sent && S.outbox.length && S.online && !document.body.classList.contains('logged-out')) scheduleRefresh();
    }
  })();
  return loading;
}
const sync = () => loadState();

// Aviso cuando el otro termina algo (lo que llega nuevo y no se ha marcado en este móvil).
const MINE = new Set(S.outbox.map((o) => o.uid).filter(Boolean));
function announce(prev, next) {
  if (!prev || !S.me) return;
  const seen = new Set(prev.completions.map((c) => c.uid));
  const fresh = next.completions.filter((c) => !seen.has(c.uid) && !MINE.has(c.uid) && c.who !== S.me && c.done_date >= iso(addDays(new Date(), -1)));
  if (!fresh.length) return;
  const c = fresh[0];
  const who = c.who === 'both' ? 'Entre los dos' : personName(c.who);
  toast(fresh.length === 1
    ? `${who === 'Entre los dos' ? 'Hecha entre los dos' : `${who} ha hecho`}: ${c.task_name} ✓`
    : `${who} ha hecho ${fresh.length} tareas ✓`);
}

let refreshTimer;
function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(loadState, 120); }

function connectEvents() {
  if (S.es) S.es.close();
  const es = new EventSource('/api/events');
  es.onmessage = (e) => {
    setOnline(true);
    try { const { version } = JSON.parse(e.data); if (!S.base || version !== S.base.version) scheduleRefresh(); } catch { /* ping */ }
  };
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) setTimeout(() => { if (S.es === es) connectEvents(); }, 5000);
  };
  S.es = es;
}

function setOnline(v) {
  if (S.online === v) return;
  S.online = v;
  updateBanner();
  if (v) loadState();
}

function updateBanner() {
  const b = $('#banner');
  const n = S.outbox.length;
  b.hidden = S.online && !n;
  const pend = n ? plural(n, 'cambio pendiente', 'cambios pendientes') : '';
  b.textContent = S.online ? `Enviando ${pend}…` : `Sin conexión · ${pend || 'mostrando la última copia'}`;
}

// Sin red, reintenta cada 15 s por si vuelve (iOS no siempre avisa).
setInterval(() => { if ((!S.online || S.outbox.length) && !document.body.classList.contains('logged-out')) loadState(); }, 15000);

// ----------------------------------------------------------------- render --
function render() {
  if (!S.data) return;
  if (!S.me) return showWhoPicker();
  const view = $('#view');
  const active = document.activeElement;
  const keep = active && active.id && view.contains(active) ? { id: active.id, s: active.selectionStart, e: active.selectionEnd } : null;
  view.innerHTML = VIEWS[S.tab]();
  if (keep) {
    const el = document.getElementById(keep.id);
    if (el) { el.focus(); try { el.setSelectionRange(keep.s, keep.e); } catch { /* no es texto */ } }
  }
  $$('#tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.tab));
  const td = todayISO();
  const pending = activeTasks().filter((t) => t.due && t.due <= td && (t.assignee === S.me || t.assignee === 'any')).length;
  const badge = $('#badge-hoy');
  badge.hidden = !pending;
  badge.textContent = pending;
}

function header(title, sub, button = '') {
  return `<header class="header"><div><h1>${esc(title)}</h1>${sub ? `<div class="sub">${sub}</div>` : ''}</div>${button}</header>`;
}

function empty(title, text, action = '') {
  return `<div class="card empty"><b>${esc(title)}</b>${esc(text)}${action ? `<div class="spacer"></div>${action}` : ''}</div>`;
}

function freqText(t) {
  const n = Math.max(1, t.every || 1);
  if (t.freq === 'once') return 'Una vez';
  if (t.freq === 'days') return n === 1 ? 'Cada día' : `Cada ${n} días`;
  if (t.freq === 'weekly') {
    const days = weekdayList(t, t.due ? parseISO(t.due) : new Date()).map((d) => DOW3[d]).join(', ');
    return `${n === 1 ? 'Cada semana' : `Cada ${n} semanas`} · ${days}`;
  }
  if (t.freq === 'monthly') {
    const md = t.month_day >= 31 ? 'último día' : `día ${t.month_day}`;
    return `${n === 1 ? 'Cada mes' : `Cada ${n} meses`} · ${md}`;
  }
  return '';
}

function whoChip(id, turn = false) {
  if (!id || id === 'any') return '';
  return `<span class="who ${esc(id)}${turn ? ' turn' : ''}" title="${esc(personName(id))}">${esc(initial(id))}</span>`;
}

function whoMatch(assignee) {
  const f = S.ui.fWho;
  if (f === 'mias') return assignee === S.me || assignee === 'any';
  if (f === 'otro') return assignee === otherOf(S.me) || assignee === 'any';
  return true;
}
function whoMatchDone(who) {
  const f = S.ui.fWho;
  if (f === 'mias') return who === S.me || who === 'both';
  if (f === 'otro') return who === otherOf(S.me) || who === 'both';
  return true;
}
function whoSegment() {
  const opts = [['todas', 'Todas'], ['mias', 'Mías'], ['otro', `De ${personName(otherOf(S.me))}`]];
  return `<div class="segmented">${opts.map(([k, l]) => `<button data-act="f-who" data-f="${k}" class="${S.ui.fWho === k ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>`;
}

const byRoom = (a, b) => (IDX.roomPos.get(a.room_id) ?? 999) - (IDX.roomPos.get(b.room_id) ?? 999) || a.name.localeCompare(b.name);

function taskRow(t, o = {}) {
  const td = todayISO();
  const late = t.due && t.due < td ? diffDays(t.due, td) : 0;
  const bits = [roomName(t.room_id), o.freq === false ? '' : freqText(t), o.when && t.due ? `${t.due < td ? 'tocaba' : 'toca'} ${relDay(t.due)}` : '']
    .filter(Boolean).map(esc).join(' · ');
  const lateTxt = late && !o.when ? `<span class="late">${late === 1 ? 'desde ayer' : `hace ${late} días`}</span>` : '';
  return `<div class="row" data-act="open-task" data-id="${t.id}">
    ${o.check === false ? '' : `<button class="check" data-act="done" data-id="${t.id}" aria-label="Marcar «${esc(t.name)}» como hecha">${ICON.check}</button>`}
    <span class="main"><div class="title">${esc(t.name)}</div><div class="meta">${[bits, lateTxt].filter(Boolean).join(' · ')}</div></span>
    ${whoChip(t.assignee, t.rotate)}${ICON.chev}</div>`;
}

function doneRow(c, o = {}) {
  const meta = [o.room !== false ? c.room_name : '', `${personName(c.who)}${o.date ? ' · ' + fmtDay(c.done_date) : ''} · ${fmtTime(c.done_at)}`, c.pending ? 'pendiente de enviar' : '']
    .filter(Boolean).join(' · ');
  return `<div class="row done" data-act="open-done" data-uid="${esc(c.uid)}">
    ${o.check === false ? '' : `<button class="check on" data-act="undo" data-uid="${esc(c.uid)}" aria-label="Deshacer">${ICON.check}</button>`}
    <span class="main"><div class="title">${esc(c.task_name)}</div><div class="meta">${esc(meta)}</div></span>
    ${whoChip(c.who)}</div>`;
}

function card(rowsHtml) { return `<div class="card"><div class="list">${rowsHtml}</div></div>`; }

// ------------------------------------------------------------------- hoy ---
function viewHoy() {
  const td = todayISO();
  const tasks = activeTasks().filter((t) => whoMatch(t.assignee));
  const overdue = tasks.filter((t) => t.due && t.due < td).sort((a, b) => a.due.localeCompare(b.due) || byRoom(a, b));
  const today = tasks.filter((t) => t.due === td).sort(byRoom);
  const undated = tasks.filter((t) => !t.due).sort((a, b) => a.created_at - b.created_at);
  const done = S.data.completions.filter((c) => c.done_date === td && whoMatchDone(c.who)).sort((a, b) => b.done_at - a.done_at);
  const tomorrow = tasks.filter((t) => t.due === iso(addDays(new Date(), 1))).length;
  const pending = overdue.length + today.length;

  let h = header('Hoy', cap(new Date().toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' })),
    `<div class="hbtns"><button class="avatar ${esc(S.me)}" data-act="settings" aria-label="Ajustes (eres ${esc(personName(S.me))})">${esc(initial(S.me))}</button>
     <button class="icon-btn" data-act="new-task" aria-label="Nueva tarea">${ICON.plus}</button></div>`);
  h += `<form class="quick" data-form="quick" autocomplete="off"><input id="quick-name" name="name" maxlength="120" placeholder="Tarea suelta: llamar al fontanero…" enterkeyhint="done">
    <button class="btn primary" type="submit">Añadir</button></form>`;
  h += whoSegment();

  if (!activeTasks().length && !done.length) {
    return h + empty('Empezad en cero', 'Aún no hay tareas. Añadid las sugeridas (limpiar el baño, fregar, sacar la basura…) con un toque, o cread las vuestras.',
      `<button class="btn primary" data-act="templates">Ver tareas sugeridas</button> <button class="btn" data-act="new-task">Nueva tarea</button>`);
  }
  if (!pending && !undated.length) {
    h += empty(done.length ? '¡Todo hecho por hoy!' : 'Nada para hoy',
      tomorrow ? `Mañana: ${plural(tomorrow, 'tarea', 'tareas')}.` : 'Disfrutad del día.');
  }
  if (overdue.length) h += `<div class="section-title">Atrasadas (${overdue.length})</div>${card(overdue.map((t) => taskRow(t)).join(''))}`;
  if (today.length) h += `<div class="section-title">Para hoy (${today.length})</div>${card(today.map((t) => taskRow(t)).join(''))}`;
  if (undated.length) h += `<div class="section-title">Sueltas, cuando se pueda (${undated.length})</div>${card(undated.map((t) => taskRow(t, { freq: false })).join(''))}`;
  if (done.length) h += `<div class="section-title">Hechas hoy (${done.length})</div>${card(done.map((c) => doneRow(c)).join(''))}`;
  if (pending || undated.length) h += '<p class="hint">Toca el círculo para marcarla como hecha por ti. Para decir que la hizo otro, la fecha o posponerla, abre la tarea.</p>';
  if (tomorrow && (pending || undated.length || done.length)) h += `<button class="more-link" data-tab-go="semana">Mañana: ${plural(tomorrow, 'tarea', 'tareas')} ›</button>`;
  return h;
}

// ---------------------------------------------------------------- semana ---
// Qué toca cada día: lo atrasado aparece hoy y las repeticiones se proyectan.
function occurrences(t, fromISO, toISO) {
  const td = todayISO();
  if (!t.due) return [];
  let d = t.due < td ? td : t.due;
  const out = [];
  for (let i = 0; d && d <= toISO && i < 400; i++) {
    if (d >= fromISO) out.push(d);
    if (t.freq === 'once') break;
    d = nextDue(t, d);
  }
  return out;
}

function viewSemana() {
  const td = todayISO();
  const now = new Date();
  const monday = addDays(now, -wd(now) + 7 * S.ui.week);
  const days = [...Array(7)].map((_, i) => iso(addDays(monday, i)));
  const from = days[0]; const to = days[6];
  const plan = Object.fromEntries(days.map((d) => [d, []]));
  for (const t of activeTasks().filter((x) => whoMatch(x.assignee))) {
    for (const d of occurrences(t, from, to)) plan[d].push(t);
  }
  const done = {};
  for (const c of S.data.completions) if (c.done_date >= from && c.done_date <= to && whoMatchDone(c.who)) (done[c.done_date] ||= []).push(c);
  const title = S.ui.week === 0 ? 'Esta semana' : S.ui.week === 1 ? 'Semana que viene' : S.ui.week === -1 ? 'Semana pasada' : 'Semana';
  const d0 = parseISO(from); const d6 = parseISO(to);
  const range = `${d0.getDate()}${d0.getMonth() !== d6.getMonth() ? ' ' + MON3[d0.getMonth()] : ''} – ${d6.getDate()} ${MON3[d6.getMonth()]}`;
  let h = header(title, range, `<div class="week-nav">
    ${S.ui.week !== 0 ? '<button class="icon-btn ghost small-txt" data-act="week" data-d="0">Hoy</button>' : ''}
    <button class="icon-btn ghost" data-act="week" data-d="-1" aria-label="Semana anterior">${ICON.left}</button>
    <button class="icon-btn ghost" data-act="week" data-d="1" aria-label="Semana siguiente">${ICON.right}</button></div>`);
  h += whoSegment();
  if (S.ui.week < 0 && S.base && from < iso(addDays(new Date(), -60))) h += '<p class="hint">Para semanas más antiguas, mira el historial en «Reparto».</p>';
  for (const d of days) {
    const p = plan[d].sort(byRoom);
    const dn = (done[d] || []).sort((a, b) => a.done_at - b.done_at);
    const date = parseISO(d);
    const past = d < td;
    h += `<div class="day-title ${past ? 'past' : ''}">${cap(DOW[wd(date)])} ${date.getDate()}${d === td ? ' <span class="pill ok">Hoy</span>' : ''}
      <span class="count">${[dn.length ? `${dn.length} ✓` : '', p.length ? plural(p.length, 'pendiente', 'pendientes') : ''].filter(Boolean).join(' · ')}</span></div>`;
    const rowsHtml = p.map((t) => taskRow(t, { check: d === td, when: false })).join('') + dn.map((c) => doneRow(c, { check: d === td })).join('');
    h += rowsHtml ? card(rowsHtml) : `<div class="card"><div class="day-empty">${past ? 'Nada hecho' : 'Nada previsto'}</div></div>`;
  }
  h += '<p class="hint">Lo atrasado aparece en el día de hoy. Las tareas que se repiten se muestran en los días que tocarán si se hacen a su hora.</p>';
  return h;
}

// ---------------------------------------------------------------- tareas ---
function viewTareas() {
  const all = activeTasks();
  return header('Tareas', `${plural(all.length, 'tarea', 'tareas')} · ${plural(S.data.rooms.length, 'habitación', 'habitaciones')}`,
    `<div class="hbtns"><button class="icon-btn ghost" data-act="rooms" aria-label="Habitaciones">${ICON.tag}</button>
    <button class="icon-btn" data-act="new-task" aria-label="Nueva tarea">${ICON.plus}</button></div>`)
    + `<input id="q-tareas" class="search" type="search" placeholder="Buscar tarea o habitación" value="${esc(S.ui.qTareas)}" data-input="q-tareas" autocomplete="off">`
    + `<div class="segmented">${[['todas', 'Todas'], ['rep', 'Se repiten'], ['sueltas', 'Sueltas']].map(([k, l]) => `<button data-act="f-tareas" data-f="${k}" class="${S.ui.fTareas === k ? 'on' : ''}">${l}</button>`).join('')}</div>`
    + `<div id="list-area">${tareasList()}</div>`;
}

function tareasList() {
  const q = norm(S.ui.qTareas);
  const f = S.ui.fTareas;
  const list = activeTasks().filter((t) => (!q || norm(t.name).includes(q) || norm(roomName(t.room_id)).includes(q))
    && (f === 'todas' || (f === 'rep' && t.freq !== 'once') || (f === 'sueltas' && t.freq === 'once')));
  if (!activeTasks().length) {
    return empty('Sin tareas', 'Crea las tareas de casa o añade algunas sugerencias.',
      `<button class="btn primary" data-act="new-task">Nueva tarea</button> <button class="btn" data-act="templates">Sugerencias</button>`);
  }
  let h = '';
  if (!list.length) h = empty('Nada encontrado', 'Prueba con otro nombre o filtro.');
  const groups = new Map();
  for (const t of list) { const k = t.room_id && IDX.rooms.has(t.room_id) ? t.room_id : 0; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); }
  const keys = [...groups.keys()].sort((a, b) => (a ? IDX.roomPos.get(a) : 999) - (b ? IDX.roomPos.get(b) : 999));
  for (const k of keys) {
    const items = groups.get(k).sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999') || a.name.localeCompare(b.name));
    h += `<div class="section-title">${esc(k ? roomName(k) : 'Sin habitación')}</div>${card(items.map((t) => taskRow(t, { check: false, when: true })).join(''))}`;
  }
  return h + `<button class="more-link" data-act="templates">Añadir tareas sugeridas ›</button>`;
}

// --------------------------------------------------------------- reparto ---
function viewReparto() {
  const td = todayISO();
  const now = new Date();
  const week = S.ui.period === 'semana';
  const from = week ? iso(addDays(now, -wd(now))) : iso(new Date(now.getFullYear(), now.getMonth(), 1));
  const comps = S.data.completions.filter((c) => c.done_date >= from && c.done_date <= td);
  const [A, B] = IDX.people.map((p) => p.id);
  // Puntos = esfuerzo de cada tarea hecha. Lo hecho entre los dos cuenta para ambos.
  const n = { [A]: 0, [B]: 0, both: 0 }; const p = { [A]: 0, [B]: 0, both: 0 };
  for (const c of comps) { n[c.who] = (n[c.who] || 0) + 1; p[c.who] = (p[c.who] || 0) + (c.points || 2); }
  const tot = { [A]: p[A] + p.both, [B]: p[B] + p.both };
  const cnt = { [A]: n[A] + n.both, [B]: n[B] + n.both };
  const all = p[A] + p[B] + p.both;

  let h = header('Reparto', week ? 'Esta semana (desde el lunes)' : `Este mes (${now.toLocaleDateString('es-ES', { month: 'long' })})`);
  h += `<div class="segmented">${[['semana', 'Semana'], ['mes', 'Mes']].map(([k, l]) => `<button data-act="period" data-p="${k}" class="${S.ui.period === k ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  if (!all) {
    h += empty('Aún no hay nada hecho', week ? 'Cuando marquéis tareas como hechas veréis aquí el reparto de la semana.' : 'Todavía no hay tareas hechas este mes.');
  } else {
    h += `<div class="duo">${[A, B].map((x) => `<div class="stat"><div class="label">${whoChip(x)} ${esc(personName(x))}</div><div class="value">${tot[x]}</div>
      <div class="small muted">${pts(tot[x]).replace(/^\d+ /, '')} · ${plural(cnt[x], 'tarea', 'tareas')}</div></div>`).join('')}</div>
      <div class="split" aria-hidden="true"><i class="c" style="width:${(100 * p[A]) / all}%"></i><i class="b" style="width:${(100 * p.both) / all}%"></i><i class="z" style="width:${(100 * p[B]) / all}%"></i></div>`;
    const diff = tot[A] - tot[B];
    h += `<p class="verdict">${Math.abs(diff) <= 2 ? 'Muy igualado 👌' : `${esc(personName(diff > 0 ? A : B))} lleva ${pts(Math.abs(diff))} más`}</p>`;
    h += `<p class="hint" style="text-align:center">Cada tarea suma según su esfuerzo: ligera 1, normal 2, pesada 3.${n.both ? ` ${plural(n.both, 'tarea hecha', 'tareas hechas')} entre los dos (cuenta para ambos).` : ''}</p>`;

    const byTask = new Map();
    for (const c of comps) {
      const k = c.task_name;
      if (!byTask.has(k)) byTask.set(k, { name: k, room: c.room_name, [A]: 0, [B]: 0, both: 0, total: 0 });
      const e = byTask.get(k); e[c.who]++; e.total++;
    }
    const tasks = [...byTask.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    h += `<div class="section-title">Quién hace qué (veces)</div>${card(tasks.map((e) => `<div class="row static"><span class="main"><div class="title">${esc(e.name)}</div>${e.room ? `<div class="meta">${esc(e.room)}</div>` : ''}</span>
      <span class="counts">${e[A] ? `<span class="name-${A}">${esc(initial(A))} ${e[A]}</span>` : ''}${e[B] ? `<span class="name-${B}">${esc(initial(B))} ${e[B]}</span>` : ''}${e.both ? `<span class="muted">juntos ${e.both}</span>` : ''}</span></div>`).join(''))}`;
  }

  const turns = activeTasks().filter((t) => t.rotate).sort(byRoom);
  if (turns.length) {
    h += `<div class="section-title">Turnos</div>${card(turns.map((t) => `<div class="row" data-act="open-task" data-id="${t.id}">
      <span class="main"><div class="title">${esc(t.name)}</div><div class="meta">Le toca a ${esc(personName(t.assignee))}${t.due ? ' · ' + esc(relDay(t.due)) : ''}</div></span>${whoChip(t.assignee, true)}${ICON.chev}</div>`).join(''))}`;
  }

  const last = S.data.completions.slice().sort((a, b) => b.done_date.localeCompare(a.done_date) || b.done_at - a.done_at).slice(0, 8);
  if (last.length) {
    h += `<div class="section-title">Últimas hechas <button class="btn small link" data-act="history">Historial</button></div>${card(last.map((c) => doneRow(c, { check: false, date: true })).join(''))}`;
    h += '<button class="more-link" data-act="history">Ver todo el historial ›</button>';
  }
  return h;
}

const VIEWS = { hoy: viewHoy, semana: viewSemana, tareas: viewTareas, reparto: viewReparto };

// ---------------------------------------------------------------- hojas ----
function openSheet(html, meta) {
  const sh = $('#sheet');
  const same = S.sheet && meta && S.sheet.kind === meta.kind && S.sheet.id === meta.id;
  const y = same ? sh.scrollTop : 0;
  sh.innerHTML = html;
  sh.hidden = false;
  $('#sheet-backdrop').hidden = false;
  sh.scrollTop = y;
  S.sheet = meta || { kind: 'x' };
  document.body.style.overflow = 'hidden';
}
function closeSheet() {
  $('#sheet').hidden = true;
  $('#sheet-backdrop').hidden = true;
  $('#sheet').innerHTML = '';
  S.sheet = null;
  document.body.style.overflow = '';
}
function sheetHead(title, left = 'Cerrar', right = '', rightAct = '') {
  return `<div class="sheet-head"><button data-act="close-sheet">${esc(left)}</button><h2>${esc(title)}</h2>
    <button ${rightAct ? `data-act="${rightAct}"` : 'style="visibility:hidden"'}>${esc(right)}</button></div>`;
}
function seg(name, options, value, act = 'seg') {
  return `<div class="segmented" data-seg="${name}">${options.map(([v, l]) => `<button type="button" data-act="${act}" data-name="${name}" data-v="${esc(v)}" class="${String(value) === String(v) ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>`;
}

// Tarea: ficha
function openTask(id) {
  const t = IDX.tasks.get(id);
  if (!t) return closeSheet();
  if (S.sheet?.kind !== 'task' || S.sheet.id !== id) { S.ui.markWho = S.me; S.ui.markWhen = 'hoy'; }
  const last = S.data.completions.filter((c) => c.task_id === id).slice(0, 6);
  const resp = t.rotate ? `Por turnos · le toca a ${personName(t.assignee)}` : personName(t.assignee);
  const td = todayISO();
  let html = sheetHead(t.name, 'Cerrar', t.active ? 'Editar' : '', t.active ? 'edit-task' : '') + `
    <div class="card">
      <div class="info-row"><span>Habitación</span><span>${esc(roomName(t.room_id) || 'Sin habitación')}</span></div>
      <div class="info-row"><span>Responsable</span><span>${esc(resp)}</span></div>
      <div class="info-row"><span>Frecuencia</span><span>${esc(freqText(t))}</span></div>
      <div class="info-row"><span>Esfuerzo</span><span>${esc(EFFORT[t.effort] || 'Normal')} · ${pts(t.effort || 2)}</span></div>
      ${t.active ? `<div class="info-row"><span>${t.freq === 'once' ? 'Fecha' : 'Próxima vez'}</span><span class="${t.due && t.due < td ? 'late' : ''}">${t.due ? `${esc(cap(relDay(t.due)))} · ${esc(fmtDay(t.due))}` : 'Sin fecha'}</span></div>` : '<div class="info-row"><span>Estado</span><span>Hecha ✓</span></div>'}
      ${t.notes ? `<div class="info-row"><span>Notas</span><span class="notes">${esc(t.notes)}</span></div>` : ''}
    </div>`;
  if (t.active) {
    html += `<div class="section-title">Marcar como hecha</div><div class="card pad">
      <span class="sub-label" style="margin-top:0">¿Quién?</span>${seg('markWho', [...IDX.people.map((p) => [p.id, p.name]), ['both', 'Los dos']], S.ui.markWho, 'mark-opt')}
      <span class="sub-label">¿Cuándo?</span>${seg('markWhen', [['hoy', 'Hoy'], ['ayer', 'Ayer']], S.ui.markWhen, 'mark-opt')}
      <div class="spacer"></div><button class="btn primary block" data-act="mark-done" data-id="${t.id}">Marcar como hecha</button></div>
      <div class="section-title">Cambiar fecha</div>
      <div class="btn-row wrap">
        <button class="btn" data-act="snooze" data-id="${t.id}" data-days="1">Mañana</button>
        <label class="btn date-btn">Elegir fecha<input type="date" data-change="snooze-date" data-id="${t.id}" value="${esc(t.due || td)}"></label>
        ${t.freq !== 'once' ? `<button class="btn" data-act="skip" data-id="${t.id}">Saltar esta vez</button>` : ''}
        ${t.freq === 'once' && t.due ? `<button class="btn" data-act="snooze" data-id="${t.id}" data-days="none">Sin fecha</button>` : ''}
      </div>
      ${t.freq !== 'once' && t.due ? `<p class="hint">«Saltar esta vez» la pasa a ${esc(fmtDay(skipDue(t)))} sin contarla como hecha.</p>` : ''}`;
  }
  if (last.length) html += `<div class="section-title">Últimas veces</div>${card(last.map((c) => doneRow(c, { room: false, check: false, date: true })).join(''))}`;
  html += `<div class="btn-row"><button class="btn danger" data-act="delete-task" data-id="${t.id}">Eliminar tarea</button></div>`;
  openSheet(html, { kind: 'task', id, live: () => (IDX.tasks.has(id) ? openTask(id) : closeSheet()) });
}

// Tarea: formulario (todo se rellena al crearla)
const FREQ_UI = [['once', 'Una vez'], ['daily', 'Cada día'], ['days', 'Cada X días'], ['weekly', 'Cada semana (elegir días)'], ['monthly', 'Cada mes']];

function editTask(id) {
  const t = id ? IDX.tasks.get(id) : null;
  const now = new Date();
  const v = t ? { ...t } : { name: '', room_id: null, assignee: 'any', rotate: 0, freq: 'weekly', every: 1, weekdays: String(wd(now)), month_day: now.getDate(), due: todayISO(), notes: '', effort: 2 };
  const ui = v.freq === 'days' && (v.every || 1) === 1 ? 'daily' : v.freq;
  const resp = v.rotate ? 'turnos' : v.assignee;
  const n = v.every || 1;
  const wds = weekdayList(v, v.due ? parseISO(v.due) : now);
  const html = sheetHead(t ? 'Editar tarea' : 'Nueva tarea', 'Cancelar', 'Guardar', 'submit-task') + `
    <form id="task-form" data-form="task" data-id="${t ? t.id : ''}" autocomplete="off">
      <label class="field"><span>Tarea</span><input name="name" required maxlength="120" value="${esc(v.name)}" placeholder="Limpiar el baño" list="dl-templates" data-change="task-name"></label>
      <label class="field"><span>Habitación o zona</span>${roomSelect(v.room_id)}</label>
      <div class="field"><span>Responsable</span>${seg('resp', [['any', 'Cualquiera'], ...IDX.people.map((p) => [p.id, p.name]), ['turnos', 'Por turnos']], resp)}
        <input type="hidden" name="resp" value="${esc(resp)}">
        <div data-show-resp="turnos"><span class="sub-label">Le toca ahora</span>${seg('start', IDX.people.map((p) => [p.id, p.name]), v.rotate ? v.assignee : S.me)}
          <input type="hidden" name="start" value="${esc(v.rotate ? v.assignee : S.me)}">
          <p class="hint">Cada vez que uno la haga, le tocará al otro.</p></div></div>
      <div class="field"><span>Esfuerzo</span>${seg('effort', [[1, 'Ligera · 1'], [2, 'Normal · 2'], [3, 'Pesada · 3']], v.effort || 2)}
        <input type="hidden" name="effort" value="${v.effort || 2}">
        <p class="hint">Puntos que suma en el reparto cada vez que se hace.</p></div>
      <label class="field"><span>Frecuencia</span><select name="freq" data-change="form-sched">${FREQ_UI.map(([k, l]) => `<option value="${k}" ${k === ui ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <div data-show="days"><label class="field"><span>Cada cuántos días</span><select name="every_days" data-change="form-sched">${[...Array(29)].map((_, i) => i + 2).map((d) => `<option value="${d}" ${ui === 'days' && n === d ? 'selected' : ''}>Cada ${d} días</option>`).join('')}</select></label>
        <p class="hint" style="margin-top:-6px;margin-bottom:12px">Se cuenta desde el día en que se hace.</p></div>
      <div data-show="weekly"><div class="field"><span>Qué días</span><div class="wd-chips">${DOW1.map((l, i) => `<button type="button" data-act="wd" data-d="${i}" class="${wds.includes(i) ? 'on' : ''}" aria-label="${DOW[i]}">${l}</button>`).join('')}</div>
        <input type="hidden" name="weekdays" value="${wds.join(',')}"></div>
        <label class="field"><span>Repetir</span><select name="every_weeks" data-change="form-sched">${[1, 2, 3, 4].map((w) => `<option value="${w}" ${ui === 'weekly' && n === w ? 'selected' : ''}>${w === 1 ? 'Todas las semanas' : `Cada ${w} semanas`}</option>`).join('')}</select></label></div>
      <div data-show="monthly"><div class="grid2">
        <label class="field"><span>Día del mes</span><select name="month_day" data-change="form-sched">${[...Array(28)].map((_, i) => i + 1).map((d) => `<option value="${d}" ${v.month_day === d ? 'selected' : ''}>Día ${d}</option>`).join('')}<option value="31" ${v.month_day >= 29 ? 'selected' : ''}>Último día</option></select></label>
        <label class="field"><span>Repetir</span><select name="every_months" data-change="form-sched">${[1, 2, 3, 4, 6, 12].map((m) => `<option value="${m}" ${ui === 'monthly' && n === m ? 'selected' : ''}>${m === 1 ? 'Todos los meses' : `Cada ${m} meses`}</option>`).join('')}</select></label></div></div>
      <div class="field"><span data-due-label>${ui === 'once' ? 'Fecha (opcional)' : 'Próxima vez'}</span>
        <input type="date" name="due" value="${esc(v.due || '')}" data-change="due-touched">
        <div data-show="once"><button type="button" class="link-btn" data-act="clear-due">Sin fecha (cuando se pueda)</button></div></div>
      <label class="field"><span>Notas</span><textarea name="notes" style="min-height:70px" maxlength="2000" placeholder="Productos, trucos, dónde está…">${esc(v.notes)}</textarea></label>
      <button class="btn primary block" type="submit">${t ? 'Guardar' : 'Crear tarea'}</button>
      <datalist id="dl-templates">${(S.data.templates || []).map((x) => `<option value="${esc(x.name)}">`).join('')}</datalist>
    </form>`;
  openSheet(html, { kind: 'task-edit', id });
  formUpdate($('#task-form'), false);
}

function roomSelect(current) {
  return `<select name="room_id" data-change="room-select" data-prev="${esc(current || '')}">
    <option value="">Sin habitación</option>
    ${S.data.rooms.map((r) => `<option value="${r.id}" ${r.id === current ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}
    <option value="__new__">＋ Nueva habitación…</option></select>`;
}

// Lee la programación del formulario en el mismo formato que una tarea.
function formSchedule(f) {
  const ui = f.freq.value;
  const t = { freq: ui === 'daily' ? 'days' : ui, every: 1, weekdays: f.weekdays.value, month_day: Number(f.month_day.value) };
  if (ui === 'days') t.every = Number(f.every_days.value);
  if (ui === 'weekly') t.every = Number(f.every_weeks.value);
  if (ui === 'monthly') t.every = Number(f.every_months.value);
  return t;
}

// Muestra los campos de la frecuencia elegida y propone la próxima fecha.
function formUpdate(f, schedChanged = true) {
  if (!f) return;
  const ui = f.freq.value;
  $$('[data-show]', f).forEach((el) => { el.hidden = el.dataset.show !== ui; });
  $$('[data-show-resp]', f).forEach((el) => { el.hidden = el.dataset.showResp !== f.resp.value; });
  $('[data-due-label]', f).textContent = ui === 'once' ? 'Fecha (opcional)' : 'Próxima vez';
  if (schedChanged && f.dataset.dueTouched !== '1') {
    const t = formSchedule(f);
    if (t.freq !== 'once') f.due.value = firstDue(t, todayISO());
  }
}

async function saveTask(f) {
  const t = formSchedule(f);
  const resp = f.resp.value;
  const body = {
    name: f.name.value, room_id: f.room_id.value && f.room_id.value !== '__new__' ? Number(f.room_id.value) : null,
    rotate: resp === 'turnos', assignee: resp === 'turnos' ? f.start.value : resp,
    ...t, due: f.due.value || null, notes: f.notes.value, effort: Number(f.effort.value) || 2,
  };
  if (!body.name.trim()) return toast('Ponle un nombre a la tarea');
  if (t.freq === 'weekly' && !t.weekdays) return toast('Elige al menos un día de la semana');
  const id = f.dataset.id ? Number(f.dataset.id) : null;
  const res = id ? await api('PUT', `/api/tasks/${id}`, body) : await api('POST', '/api/tasks', body);
  await loadState();
  if (id) openTask(id); else closeSheet();
  toast(id ? 'Guardada' : `«${body.name.trim()}» creada`);
  return res;
}

// Hecha / deshacer
function doTask(id, who = S.me, date = todayISO(), rowEl = null) {
  const t = IDX.tasks.get(id);
  if (!t || !t.active) return;
  const u = uid();
  MINE.add(u);
  const go = () => {
    queue({ kind: 'done', task_id: id, uid: u, who, date, at: Math.floor(Date.now() / 1000), seen_due: t.due ?? null });
    const nt = IDX.tasks.get(id);
    const next = nt && nt.active && nt.due ? ` · vuelve ${relDay(nt.due)}` : '';
    toast(`Hecha: ${t.name}${next}`, 'Deshacer', () => queue({ kind: 'undo', uid: u }));
  };
  if (rowEl) { rowEl.classList.add('leaving'); setTimeout(go, 230); } else go();
}

function findCompletion(u) {
  return S.data.completions.find((c) => c.uid === u) || S.ui.hist?.items.find((c) => c.uid === u);
}

function openDone(u) {
  const c = findCompletion(u);
  if (!c) return closeSheet();
  const d = parseISO(c.done_date);
  const html = sheetHead('Hecha', 'Cerrar') + `
    <div class="card">
      <div class="info-row"><span>Tarea</span><span>${esc(c.task_name)}</span></div>
      ${c.room_name ? `<div class="info-row"><span>Habitación</span><span>${esc(c.room_name)}</span></div>` : ''}
      <div class="info-row"><span>Cuándo</span><span>${esc(cap(d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' })))} · ${fmtTime(c.done_at)}</span></div>
    </div>
    <div class="section-title">¿Quién la hizo?</div>
    ${seg('doneWho', [...IDX.people.map((p) => [p.id, p.name]), ['both', 'Los dos']], c.who, 'done-who')}
    ${c.task_id && IDX.tasks.has(c.task_id) ? `<div class="btn-row"><button class="btn" data-act="open-task" data-id="${c.task_id}">Ver la tarea</button></div>` : ''}
    <div class="btn-row"><button class="btn danger" data-act="delete-done" data-uid="${esc(c.uid)}">${c.done_date === todayISO() ? 'Deshacer' : 'Borrar del historial'}</button></div>
    <p class="hint">Si es la última vez que se hizo, la tarea vuelve a quedar pendiente como estaba.</p>`;
  openSheet(html, { kind: 'done', id: u, live: () => (findCompletion(u) ? openDone(u) : closeSheet()) });
}

// Historial completo (del servidor, por páginas)
async function loadHistory(reset) {
  const h = S.ui.hist;
  const offset = reset ? 0 : h.items.length;
  try {
    const r = await api('GET', `/api/history?offset=${offset}&who=${h.who}`, null, { silent: true });
    h.items = reset ? r.items : h.items.concat(r.items);
    h.more = r.more;
    h.error = false;
  } catch { h.error = true; }
  if (S.sheet?.kind === 'history') openHistory();
}

function openHistory() {
  const h = S.ui.hist;
  let items = h.items;
  if (h.error && !items.length) items = S.data.completions.filter((c) => !h.who || c.who === h.who || c.who === 'both');
  const groups = new Map();
  for (const c of items.slice().sort((a, b) => b.done_date.localeCompare(a.done_date) || b.done_at - a.done_at)) {
    if (!groups.has(c.done_date)) groups.set(c.done_date, []);
    groups.get(c.done_date).push(c);
  }
  let html = sheetHead('Historial', 'Cerrar') + seg('histWho', [['', 'Todos'], ...IDX.people.map((p) => [p.id, p.name])], h.who, 'hist-who');
  if (h.error) html += '<p class="hint">Sin conexión: se muestran solo las últimas semanas.</p>';
  if (!items.length) html += empty(h.loading ? 'Cargando…' : 'Nada todavía', h.loading ? '' : 'Aquí aparecerá todo lo que vayáis haciendo.');
  for (const [d, list] of groups) {
    html += `<div class="section-title">${esc(cap(parseISO(d).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: d.slice(0, 4) !== todayISO().slice(0, 4) ? 'numeric' : undefined })))}</div>${card(list.map((c) => doneRow(c, { check: false })).join(''))}`;
  }
  if (h.more) html += '<div class="btn-row"><button class="btn" data-act="history-more">Cargar más</button></div>';
  openSheet(html, { kind: 'history', live: () => loadHistory(true) });
}

// Habitaciones
function openRooms() {
  const count = {};
  for (const t of activeTasks()) count[t.room_id] = (count[t.room_id] || 0) + 1;
  const html = sheetHead('Habitaciones y zonas', 'Listo') + `
    <form data-form="add-room" class="quick" autocomplete="off"><input name="name" maxlength="60" placeholder="Nueva habitación o zona"><button class="btn primary" type="submit">Añadir</button></form>
    ${S.data.rooms.length ? card(S.data.rooms.map((r) => `<div class="row static">
      <span class="main"><input class="input" value="${esc(r.name)}" data-change="rename-room" data-id="${r.id}" aria-label="Nombre"><div class="meta">${plural(count[r.id] || 0, 'tarea', 'tareas')}</div></span>
      <button class="row-btn danger" data-act="delete-room" data-id="${r.id}" data-n="${count[r.id] || 0}" aria-label="Borrar ${esc(r.name)}">×</button></div>`).join('')) : empty('Sin habitaciones', 'Añade las habitaciones o zonas de casa.')}
    <p class="hint">Al renombrar se actualizan todas sus tareas y el historial. Si borras una, sus tareas quedan «Sin habitación».</p>`;
  openSheet(html, { kind: 'rooms', live: () => openRooms() });
}

// Sugerencias
function openTemplates() {
  const exists = (x) => activeTasks().some((t) => norm(t.name) === norm(x.name) && norm(roomName(t.room_id)) === norm(x.room));
  const list = S.data.templates || [];
  const missing = list.filter((x) => !exists(x)).length;
  const html = sheetHead('Tareas sugeridas', 'Listo') + `<p class="hint" style="margin-top:0">Toca para añadirla con su frecuencia habitual. Después puedes cambiarla o borrarla.</p>
    ${missing > 1 ? `<div class="btn-row" style="margin:10px 0 12px"><button class="btn primary" data-act="add-all-templates">Añadir las ${missing}</button></div>` : '<div class="spacer"></div>'}
    ${card(list.map((x) => {
    const has = exists(x);
    return `<button class="row" ${has ? 'disabled' : `data-act="add-template" data-name="${esc(x.name)}"`}>
      <span class="check ${has ? 'on' : ''}">${ICON.check}</span>
      <span class="main"><div class="title">${esc(x.name)}</div><div class="meta">${esc(x.room)} · ${esc(freqText({ ...x, due: null }))} · ${esc(EFFORT[x.effort].toLowerCase())}${x.rotate ? ' · por turnos' : ''}</div></span></button>`;
  }).join(''))}`;
  openSheet(html, { kind: 'templates', live: () => openTemplates() });
}

// Ajustes
function openSettings() {
  const html = sheetHead('Ajustes', 'Listo') + `
    <div class="section-title">¿Quién eres en este móvil?</div>
    ${seg('me', IDX.people.map((p) => [p.id, p.name]), S.me, 'set-me')}
    <p class="hint">Se usa para marcar las tareas como hechas por ti. Se guarda solo en este dispositivo.</p>
    <div class="section-title">Casa</div>
    ${card(`<button class="row" data-act="rooms"><span class="main">Habitaciones y zonas</span>${ICON.chev}</button>
      <button class="row" data-act="templates"><span class="main">Tareas sugeridas</span>${ICON.chev}</button>
      <button class="row" data-act="history"><span class="main">Historial completo</span>${ICON.chev}</button>
      <a class="row" href="/api/export" download style="color:inherit;text-decoration:none"><span class="main">Descargar copia de seguridad</span>${ICON.chev}</a>`)}
    <div class="btn-row"><button class="btn danger" data-act="logout">Cerrar sesión</button></div>`;
  openSheet(html, { kind: 'settings', live: () => openSettings() });
}

// ¿Quién eres? (la primera vez en cada móvil)
function showWhoPicker() {
  closeSheet();
  document.body.classList.add('picking');
  const people = IDX.people || [{ id: 'carlos', name: 'Carlos' }, { id: 'zoe', name: 'Zoe' }];
  $('#view').innerHTML = `<div class="login"><div class="login-card">
    <img src="/icons/icon-192.png" alt="" width="72" height="72"><h1>¿Quién eres?</h1>
    <p class="muted">Lo recordaremos en este móvil. Se puede cambiar en Ajustes.</p>
    <div class="who-pick">${people.map((p) => `<button class="${esc(p.id)}" data-act="pick-me" data-v="${esc(p.id)}"><b>${esc(p.name[0])}</b>Soy ${esc(p.name)}</button>`).join('')}</div>
  </div></div>`;
}

// -------------------------------------------------------------- acciones ---
const ACTIONS = {
  'close-sheet': () => closeSheet(),
  'open-task': (t) => openTask(Number(t.dataset.id)),
  'new-task': () => editTask(null),
  'edit-task': () => editTask(S.sheet.id),
  'submit-task': () => $('#task-form')?.requestSubmit(),
  'done': (t) => doTask(Number(t.dataset.id), S.me, todayISO(), t.closest('.row')),
  'mark-done': (t) => {
    const id = Number(t.dataset.id);
    const date = S.ui.markWhen === 'ayer' ? iso(addDays(new Date(), -1)) : todayISO();
    closeSheet();
    doTask(id, S.ui.markWho || S.me, date);
  },
  'mark-opt': (t) => { S.ui[t.dataset.name] = t.dataset.v; openTask(S.sheet.id); },
  'undo': (t) => {
    const c = findCompletion(t.dataset.uid);
    t.closest('.row')?.classList.add('leaving');
    setTimeout(() => { queue({ kind: 'undo', uid: t.dataset.uid }); if (c) toast(`Deshecho: ${c.task_name}`); }, 200);
  },
  'open-done': (t) => openDone(t.dataset.uid),
  'done-who': (t) => {
    const u = S.sheet.id;
    queue({ kind: 'who', uid: u, who: t.dataset.v });
    const hc = S.ui.hist?.items.find((c) => c.uid === u); if (hc) hc.who = t.dataset.v;
    openDone(u);
  },
  'delete-done': (t) => {
    const c = findCompletion(t.dataset.uid);
    if (c && c.done_date !== todayISO() && !confirm('¿Borrar esta vez del historial?')) return;
    if (S.ui.hist) S.ui.hist.items = S.ui.hist.items.filter((x) => x.uid !== t.dataset.uid);
    closeSheet();
    queue({ kind: 'undo', uid: t.dataset.uid });
    toast('Borrada');
  },
  'skip': (t) => {
    const x = IDX.tasks.get(Number(t.dataset.id));
    queue({ kind: 'skip', task_id: x.id, seen_due: x.due });
    closeSheet();
    toast(`${x.name}: pasa a ${relDay(IDX.tasks.get(x.id)?.due || '')}`);
  },
  'snooze': (t) => {
    const id = Number(t.dataset.id);
    const due = t.dataset.days === 'none' ? null : iso(addDays(new Date(), Number(t.dataset.days)));
    queue({ kind: 'snooze', task_id: id, due });
    closeSheet();
    toast(due ? `Pospuesta a ${relDay(due)}` : 'Sin fecha');
  },
  'delete-task': async (t) => {
    const x = IDX.tasks.get(Number(t.dataset.id));
    if (!confirm(`¿Eliminar «${x.name}»? Lo ya hecho se queda en el historial.`)) return;
    await api('DELETE', `/api/tasks/${x.id}`);
    closeSheet();
    toast('Tarea eliminada');
  },

  'f-who': (t) => { S.ui.fWho = t.dataset.f; store.set('fWho', S.ui.fWho); render(); },
  'f-tareas': (t) => { S.ui.fTareas = t.dataset.f; render(); },
  'period': (t) => { S.ui.period = t.dataset.p; render(); },
  'week': (t) => { const d = Number(t.dataset.d); S.ui.week = d === 0 ? 0 : S.ui.week + d; render(); window.scrollTo(0, 0); },

  // formulario de tarea
  'seg': (t) => {
    const f = t.closest('form');
    $$(`[data-seg="${t.dataset.name}"] button`, f).forEach((b) => b.classList.toggle('on', b === t));
    f[t.dataset.name].value = t.dataset.v;
    formUpdate(f, false);
  },
  'wd': (t) => {
    const f = t.closest('form');
    t.classList.toggle('on');
    f.weekdays.value = $$('.wd-chips button.on', f).map((b) => b.dataset.d).join(',');
    formUpdate(f);
  },
  'clear-due': (t) => { const f = t.closest('form'); f.due.value = ''; f.dataset.dueTouched = '1'; },

  'rooms': () => openRooms(),
  'delete-room': async (t) => {
    const n = Number(t.dataset.n);
    if (!confirm(n ? `${plural(n, 'tarea quedará', 'tareas quedarán')} sin habitación. ¿Borrar?` : '¿Borrar esta habitación?')) return;
    await api('DELETE', `/api/rooms/${t.dataset.id}`);
    await loadState();
  },
  'templates': () => openTemplates(),
  'add-template': async (t) => {
    const r = await api('POST', '/api/templates', { names: [t.dataset.name] });
    await loadState();
    toast(r.added ? `«${t.dataset.name}» añadida` : 'Ya la teníais');
  },
  'add-all-templates': async () => {
    const r = await api('POST', '/api/templates', { names: (S.data.templates || []).map((x) => x.name) });
    await loadState();
    toast(`${plural(r.added, 'tarea añadida', 'tareas añadidas')}`);
  },
  'history': () => { S.ui.hist = { who: '', items: [], more: false, loading: true }; openHistory(); loadHistory(true); },
  'history-more': () => loadHistory(false),
  'hist-who': (t) => { S.ui.hist.who = t.dataset.v; S.ui.hist.items = []; S.ui.hist.loading = true; openHistory(); loadHistory(true); },
  'settings': () => openSettings(),
  'set-me': (t) => { S.me = t.dataset.v; store.set('me', S.me); render(); openSettings(); toast(`Ahora eres ${personName(S.me)} en este móvil`); },
  'pick-me': (t) => { S.me = t.dataset.v; store.set('me', S.me); document.body.classList.remove('picking'); render(); toast(`¡Hola, ${personName(S.me)}!`); },
  'logout': async () => {
    if (!confirm('¿Cerrar sesión en este móvil?')) return;
    await api('POST', '/api/logout');
    showLogin();
  },
};

const CHANGES = {
  'form-sched': (t) => formUpdate(t.form),
  'due-touched': (t) => { t.form.dataset.dueTouched = '1'; },
  'task-name': (t) => {
    // Si se elige una sugerencia al crear, se rellena lo demás (se puede cambiar).
    const f = t.form;
    if (f.dataset.id || f.dataset.filled) return;
    const x = (S.data.templates || []).find((y) => norm(y.name) === norm(t.value));
    if (!x) return;
    f.dataset.filled = '1';
    const room = S.data.rooms.find((r) => norm(r.name) === norm(x.room));
    if (room) f.room_id.value = room.id;
    const ui = x.freq === 'days' && x.every === 1 ? 'daily' : x.freq;
    f.freq.value = ui;
    if (ui === 'days') f.every_days.value = x.every;
    if (ui === 'weekly') {
      f.every_weeks.value = x.every; f.weekdays.value = x.weekdays;
      $$('.wd-chips button', f).forEach((b) => b.classList.toggle('on', x.weekdays.split(',').includes(b.dataset.d)));
    }
    if (ui === 'monthly') { f.every_months.value = x.every; f.month_day.value = x.month_day; }
    f.effort.value = x.effort;
    $$('[data-seg="effort"] button', f).forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === x.effort));
    if (x.rotate) {
      f.resp.value = 'turnos';
      $$('[data-seg="resp"] button', f).forEach((b) => b.classList.toggle('on', b.dataset.v === 'turnos'));
    }
    formUpdate(f);
  },
  'room-select': async (t) => {
    if (t.value !== '__new__') { t.dataset.prev = t.value; return; }
    const name = (prompt('Nombre de la nueva habitación o zona') || '').trim();
    if (!name) { t.value = t.dataset.prev || ''; return; }
    let r;
    try { r = await api('POST', '/api/rooms', { name }); } catch { t.value = t.dataset.prev || ''; return; }
    if (!t.querySelector(`option[value="${r.id}"]`)) {
      const opt = document.createElement('option');
      opt.value = r.id; opt.textContent = r.name;
      t.insertBefore(opt, t.querySelector('option[value="__new__"]'));
    }
    t.value = String(r.id); t.dataset.prev = t.value;
    if (r.existed) toast(`Ya existía «${r.name}»: la hemos elegido`);
  },
  'rename-room': (t) => { if (t.value.trim()) api('PATCH', `/api/rooms/${t.dataset.id}`, { name: t.value }).catch(() => loadState()); },
  'snooze-date': (t) => {
    if (!t.value) return;
    queue({ kind: 'snooze', task_id: Number(t.dataset.id), due: t.value });
    closeSheet();
    toast(`Pasa a ${relDay(t.value)}`);
  },
};

const INPUTS = {
  'q-tareas': (t) => { S.ui.qTareas = t.value; $('#list-area').innerHTML = tareasList(); },
};

const FORMS = {
  'task': (f) => saveTask(f),
  'quick': async (f) => {
    const name = f.name.value.trim();
    if (!name) return;
    await api('POST', '/api/tasks', { name, freq: 'once', assignee: 'any' });
    f.name.value = '';
    await loadState();
    toast(`«${name}» añadida a sueltas`);
  },
  'add-room': async (f) => {
    const r = await api('POST', '/api/rooms', { name: f.name.value });
    if (r.existed) toast(`Ya existe «${r.name}»`);
    await loadState();
    $('#sheet input[name="name"]')?.focus();
  },
};

document.addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab], [data-tab-go]');
  if (tab) { switchTab(tab.dataset.tab || tab.dataset.tabGo); return; }
  const t = e.target.closest('[data-act]');
  if (!t || t.disabled) return;
  if (t.tagName === 'LABEL' || e.target.closest('input, textarea, select')) return;
  e.preventDefault();
  Promise.resolve(ACTIONS[t.dataset.act]?.(t, e)).catch(() => {});
});
document.addEventListener('change', (e) => { const h = CHANGES[e.target.dataset.change]; if (h) Promise.resolve(h(e.target)).catch(() => {}); });
document.addEventListener('input', (e) => { const h = INPUTS[e.target.dataset.input]; if (h) h(e.target); });
document.addEventListener('submit', (e) => {
  const f = e.target.closest('[data-form]');
  if (!f || !FORMS[f.dataset.form]) return;
  e.preventDefault();
  const btn = f.querySelector('[type=submit]');
  if (btn) btn.disabled = true;
  Promise.resolve(FORMS[f.dataset.form](f)).catch(() => {}).finally(() => { if (btn) btn.disabled = false; });
});
$('#sheet-backdrop').addEventListener('click', closeSheet);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.sheet) closeSheet(); });
$('#toast-btn').addEventListener('click', () => { const fn = toastAction; hideToast(); if (fn) fn(); });

function switchTab(tab) {
  if (!VIEWS[tab]) return;
  if (tab === 'semana' && S.tab !== 'semana') S.ui.week = 0;
  S.tab = tab;
  store.set('tab', tab);
  render();
  window.scrollTo(0, 0);
}

// ----------------------------------------------------------------- avisos --
let toastTimer; let toastAction = null;
function toast(msg, label = '', fn = null) {
  $('#toast-msg').textContent = msg;
  const b = $('#toast-btn');
  b.hidden = !label; b.textContent = label;
  toastAction = fn;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, label ? 5000 : 2600);
}
function hideToast() { $('#toast').hidden = true; toastAction = null; }

// ----------------------------------------------------------------- acceso --
function showLogin() {
  if (S.es) { S.es.close(); S.es = null; }
  document.body.classList.add('logged-out');
  document.body.classList.remove('picking');
  closeSheet();
  $('#view').innerHTML = $('#login-tpl').innerHTML;
  const form = $('#login-form');
  form.querySelector('input').focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      await api('POST', '/api/login', { password: new FormData(form).get('password') });
      start();
    } catch { btn.disabled = false; }
  });
}

async function start() {
  document.body.classList.remove('logged-out');
  if (S.base) refresh();
  const ok = await fetch('/api/state', { credentials: 'same-origin' }).then((r) => r.status !== 401).catch(() => true);
  if (!ok) return showLogin();
  await loadState();
  connectEvents();
}

document.addEventListener('visibilitychange', () => {
  // iOS corta las conexiones al pasar la app a segundo plano: reconectamos al volver.
  // (Y si ha cambiado el día, se vuelve a pintar «Hoy».)
  if (document.visibilityState === 'visible' && !document.body.classList.contains('logged-out')) { refresh(); loadState(); connectEvents(); }
});
window.addEventListener('online', () => loadState());
window.addEventListener('offline', () => setOnline(false));

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
start();
