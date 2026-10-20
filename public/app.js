const $ = (s) => document.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
// Settings in SYNCED are mirrored to the server (last write wins per key) so every device sees the same pins and saved places.
const SYNCED = ['pins', 'routePins', 'saved', 'recents', 'shownRoutes', 'stopAlerts', 'stopSort', 'seenAlerts', 'commutes', 'accessible', 'routeAlerts'];
const stamps = (() => { try { return JSON.parse(localStorage.getItem('sync:t')) || {}; } catch { return {}; } })();
SYNCED.forEach((k) => { if (!stamps[k] && localStorage.getItem(k) !== null) stamps[k] = Date.now(); }); // pre-sync data counts as a change so it uploads once
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
    if (SYNCED.includes(k)) { stamps[k] = Date.now(); try { localStorage.setItem('sync:t', JSON.stringify(stamps)); } catch {} clearTimeout(store.timer); store.timer = setTimeout(syncNow, 800); }
  },
};
let syncing = false;
try { localStorage.setItem('sync:t', JSON.stringify(stamps)); } catch {}
async function syncNow() {
  if (syncing) return; syncing = true;
  try {
    const out = {};
    SYNCED.forEach((k) => { if (stamps[k]) out[k] = { v: store.get(k, null), t: stamps[k] }; });
    const remote = await fetch('/api/sync', { method: 'POST', body: JSON.stringify(out) }).then((r) => r.json());
    let changed = false;
    for (const k of SYNCED) {
      const r = remote[k];
      if (r && r.t > (stamps[k] || 0)) { localStorage.setItem(k, JSON.stringify(r.v)); stamps[k] = r.t; changed = true; }
    }
    if (changed) { localStorage.setItem('sync:t', JSON.stringify(stamps)); applySynced(); }
  } catch {} finally { syncing = false; }
}
const signedOut = (r) => { if (r.status === 401) location.href = '/login'; return r; }; // the server's sign-in cookie is gone
const api = (p) => fetch(p).then(signedOut).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
const post = (p, body) => fetch(p, { method: 'POST', body: JSON.stringify(body) }).then(signedOut);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (s) => parseInt(s, 10);
// Lucide icons as inline SVG (paths generated into icons-data.js by `npm run icons`). They follow the text colour and size (1em).
const icon = (name) => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`;
const hydrateIcons = (root = document) => root.querySelectorAll('[data-icon]').forEach((el) => { el.innerHTML = icon(el.dataset.icon); });
hydrateIcons();
const clock = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const etaText = (t) => { const m = Math.round((t - Date.now() / 1000) / 60); return m <= 0 ? 'Due' : m + ' min'; };
const ageText = (sec) => (sec < 90 ? sec + 's' : Math.round(sec / 60) + 'm'); // how stale a bus position is
const geoGranted = () => (navigator.permissions ? navigator.permissions.query({ name: 'geolocation' }).then((r) => r.state === 'granted', () => false) : Promise.resolve(false));
const badge = (short, color) => `<span class="badge" style="background:#${esc(color || '444')}">${esc(short)}</span>`;
// Snackbar above the tab bar, with an optional action (e.g. Undo)
let snackTimer;
const toast = (msg, action, onAction) => {
  const el = $('#snack');
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button>${esc(action)}</button>` : ''}`;
  if (action) el.querySelector('button').onclick = () => { el.classList.remove('on'); onAction(); };
  el.classList.add('on');
  clearTimeout(snackTimer); snackTimer = setTimeout(() => el.classList.remove('on'), action ? 8000 : 3000);
};
const WALK_MPS = 1.2; // same walking speed as the planner
const walkMins = (m) => Math.max(1, Math.round(m / WALK_MPS / 60));
const leaveText = (t) => { const m = Math.round((t - Date.now() / 1000) / 60); return m < 0 ? 'Too late' : m === 0 ? 'Leave now' : m < 60 ? `Leave in ${m} min` : `Leave at ${clock(t)}`; };
// countdown with its clock time under it; data-eta lets tick() keep it current between fetches
const etaHtml = (t, sub = '', cls = '') => `<span class="eta ${cls} ${t - Date.now() / 1000 < 180 ? 'soon' : ''}" data-eta="${t}"><span class="n">${etaText(t)}</span>${sub}</span>`;
const liveDot = '<i class="pulse" role="img" aria-label="Live"></i>';
const skeleton = (n) => Array.from({ length: n }, () => '<div class="card skel" aria-hidden="true"><i></i><i></i></div>').join('');

// Countdowns and "Updated 40s ago" move on their own between the 20s fetches
let updatedAt = 0, offline = false;
const ago = (s) => (s < 10 ? 'just now' : s < 60 ? s + 's ago' : Math.round(s / 60) + ' min ago');
function tick() {
  const now = Date.now() / 1000;
  $$('[data-eta]').forEach((el) => { const t = +el.dataset.eta; el.querySelector('.n').textContent = etaText(t); el.classList.toggle('soon', t - now < 180); });
  $$('[data-leavein]').forEach((el) => (el.textContent = leaveText(+el.dataset.leavein)));
  const s = Math.round(now - updatedAt), u = $('#updated');
  u.textContent = offline ? 'Offline' + (updatedAt ? ' · ' + ago(s) : '') : updatedAt ? 'Updated ' + ago(s) : '';
  u.classList.toggle('stale', offline || s > 60);
}
setInterval(tick, 5000);
const within = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('timeout')), ms))]);
// a fix up to a minute old is fine (this runs every 20s); the long timeout covers someone taking a while to answer the permission prompt
const here = () => new Promise((ok, no) => navigator.geolocation.getCurrentPosition((p) => ok({ lat: p.coords.latitude, lon: p.coords.longitude }), no, { enableHighAccuracy: true, timeout: 30000, maximumAge: 60000 }));

let pins = store.get('pins', []);            // stops: {id, name, lat, lon}. Shown everywhere, regardless of location
let routePins = store.get('routePins', []);  // routes: {short, long, color}
let watching = new Set(store.get('watching', []));
let pinRoutes = new Set();                   // routes serving pinned stops, plus pinned routes

// ---------- tabs ----------
// The open tab lives in the URL hash, so a reload or Home Screen relaunch comes back to it.
const TABS = ['pinned', 'plan', 'map', 'alerts'];
function showTab(t) {
  $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  TABS.forEach((x) => ($('#' + x).hidden = x !== t));
  history.replaceState(history.state, '', '#' + t);
  if (t === 'map') loadLeaflet().then(() => { initMap(); map.invalidateSize(); refreshMap(); }, () => toast('Map unavailable'));
  if (t === 'alerts') refreshAlerts();
  showLiveBar();
  if (t === 'plan') loadSlotMins();
  window.scrollTo(0, 0);
}
$$('.tabs button').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));

// ---------- search box (shared by Pinned and Plan) ----------
const KIND_ICON = { route: () => icon('bus'), stop: () => icon('signpost'), dest: () => icon('flag'), place: () => icon('map-pin'), here: () => icon('crosshair'), recent: () => icon('history') };
const titleOf = (it) => (it.kind === 'route' ? `Route ${it.short}` : it.kind === 'here' ? 'Use my location' : it.name);
const subOf = (it) => (it.kind === 'route' ? it.long : it.sub);

// Typing shows matching routes, stops, bus destinations and (optionally) addresses/places.
// onPick(item, ctx): ctx.close(), ctx.coords(item) -> item with lat/lon, ctx.drill(route, onStop) -> browse a route's stops
function searchBox({ input, box, kinds, empty, onPick }) {
  let items = [], seq = 0, timer;
  let session = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()); // groups keystrokes for Google billing
  const render = (list) => {
    items = list;
    box.innerHTML = list.map((it, i) => `<div class="sg" role="button" tabindex="0" data-i="${i}"><span class="ico">${KIND_ICON[it.kind]()}</span><span class="t"><b>${esc(titleOf(it))}</b><small>${esc(subOf(it))}</small></span>${onPick.pinsOnly ? `<span class="add">${icon('plus')}</span>` : ''}</div>`).join('');
  };
  // Typing a number means a route/stop number, so those come first. Typing words usually means a place, so places lead and bus lines trail (max 2).
  const rank = (list, q) => {
    const pri = /^\d{1,3}$/.test(q) ? { route: 0, stop: 1, dest: 2, place: 3 } : { place: 0, stop: 1, dest: 2, route: 3 };
    let routes = 0;
    return list.filter((it) => it.kind !== 'route' || /^\d/.test(q) || ++routes <= 2).sort((a, b) => pri[a.kind] - pri[b.kind]).slice(0, 9);
  };
  const localKinds = kinds.split(',').filter((k) => k !== 'place').join(','), wantPlaces = kinds.includes('place');
  const get = (k, q) => api(`/api/suggest?q=${encodeURIComponent(q)}&kinds=${k}&session=${session}`);
  // Routes/stops/destinations are instant, so show them first; addresses (a network call to Google) are appended when they arrive.
  const run = async () => {
    const q = input.value.trim(), id = ++seq;
    if (!q) return render(empty ? empty() : []);
    let local = [];
    try {
      if (localKinds) local = await get(localKinds, q);
      if (id !== seq) return; // a newer keystroke superseded this one
      if (local.length) render(rank(local, q));
      else if (wantPlaces && q.length >= 3) box.innerHTML = '<div class="empty" style="padding:12px">Searching…</div>';
      if (wantPlaces && q.length >= 3) {
        const places = await get('place', q).catch(() => []);
        if (id !== seq) return;
        local = [...local, ...places];
      }
    } catch { if (id === seq) box.innerHTML = '<div class="empty" style="padding:12px">Search needs a connection</div>'; return; }
    if (id !== seq) return;
    local.length ? render(rank(local, q)) : (box.innerHTML = '<div class="empty" style="padding:12px">No matches</div>');
  };
  const close = () => { seq++; box.innerHTML = ''; };
  const ctx = {
    close,
    coords: async (it) => (it.lat != null || !it.placeId ? it : { ...it, ...(await api(`/api/place?id=${encodeURIComponent(it.placeId)}&session=${session}`)) }),
    drill: (route, onStop) => openStopSheet(route, { onStop: (st) => { close(); onStop(st); } }),
  };
  const pick = async (it) => {
    await onPick(it, ctx);
    if (it.kind === 'place') session = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()); // session ends once a place is chosen
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 180); });
  input.addEventListener('focus', () => { document.body.classList.add('typing'); setTimeout(() => input.scrollIntoView({ block: 'start', behavior: 'smooth' }), 250); run(); });
  input.addEventListener('blur', () => setTimeout(() => document.body.classList.remove('typing'), 400));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && items[0]) { e.preventDefault(); pick(items[0]); } });
  box.addEventListener('click', (e) => { const el = e.target.closest('[data-i]'); if (el) pick(items[+el.dataset.i]); });
  document.addEventListener('click', (e) => { if (!input.parentElement.contains(e.target)) close(); });
  return ctx;
}

// Sheets: full screen, or mini (a bottom panel over a dimmed backdrop; tapping the backdrop closes it). Each one adds a history
// entry, so the back gesture / Android back button closes the sheet instead of leaving the app. onClose runs however it closes.
const sheets = [];
let popSkip = 0; // history.back() calls we made ourselves (closing via Done), whose popstate must not close another sheet
addEventListener('popstate', () => { if (popSkip) return void popSkip--; sheets.at(-1)?.close(true); });
function sheetShell(html, { mini = false, onClose } = {}) {
  const root = document.createElement('div');
  root.className = 'sheet' + (mini ? ' mini' : '');
  root.innerHTML = mini ? `<div class="panel">${html}</div>` : html;
  const el = mini ? root.firstChild : root;
  document.body.append(root);
  document.body.classList.add('noscroll');
  history.pushState({ sheet: true }, '');
  const s = {
    el,
    close: (fromBack) => {
      if (!root.isConnected) return;
      root.remove(); sheets.splice(sheets.indexOf(s), 1);
      if (!sheets.length) document.body.classList.remove('noscroll');
      if (!fromBack) { popSkip++; history.back(); }
      onClose?.();
    },
  };
  sheets.push(s);
  if (mini) root.addEventListener('click', (e) => e.target === root && s.close());
  return s;
}

// Full-screen list of every stop on a route (one tab per direction, with a filter box). One scroll area only, so it scrolls
// reliably on iOS. multi: stays open so you can pin several stops (onStop toggles); otherwise picking a stop closes it.
async function openStopSheet(route, { multi = false, isPinned = () => false, onStop }) {
  const { el, close } = sheetShell('<div class="sheet-bar"><b></b><button data-close class="done">Done</button></div><div class="empty" style="padding:16px">Loading stops…</div>');
  el.querySelector('b').textContent = `Route ${route.short}`;
  let dirs, sel = 0, q = '';
  try { dirs = await api(`/api/route/${encodeURIComponent(route.short)}/stops`); }
  catch { el.querySelector('.empty').textContent = 'Could not load stops. Check your connection.'; el.onclick = (e) => e.target.closest('[data-close]') && close(); return; }
  // a stop may only exist in the other direction: say so, and let one tap switch there
  const otherMatches = () => '<div class="empty" style="padding:16px">No stops match in this direction.</div>' + dirs
    .map((d, k) => [k, d, d.stops.filter((st) => st.name.toLowerCase().includes(q)).length]).filter(([k, , n]) => k !== sel && n)
    .map(([k, d, n]) => `<div class="sg" role="button" tabindex="0" data-d="${k}"><span class="t"><b>${n} match${n > 1 ? 'es' : ''} going ${icon('arrow-right')} ${esc(d.headsign)}</b><small>Tap to view</small></span></div>`).join('');
  const rows = () => dirs[sel].stops.map((st, i) => ({ st, i })).filter(({ st }) => !q || st.name.toLowerCase().includes(q))
    .map(({ st, i }) => `<div class="sg" role="button" tabindex="0" data-s="${i}"><span class="ico">${icon('signpost')}</span><span class="t"><b>${esc(st.name)}</b><small>${esc(st.sub)}</small></span><span class="mark ${multi && isPinned(st) ? 'on' : ''}">${multi ? icon(isPinned(st) ? 'check' : 'plus') : ''}</span></div>`).join('')
    || otherMatches();
  const draw = () => {
    el.innerHTML = `<div class="sheet-bar"><div><b>Route ${esc(route.short)}</b><small>${esc(route.long || '')}${multi ? ' · tap stops to pin' : ' · choose a stop'}</small></div><button data-close class="done">Done</button></div>
      <div class="dirs">${dirs.map((d, i) => `<button data-d="${i}" class="${i === sel ? 'on' : ''}">${icon('arrow-right')} ${esc(d.headsign)} <small>(${d.stops.length})</small></button>`).join('')}</div>
      <div class="sheet-filter"><input type="search" placeholder="Filter ${dirs[sel].stops.length} stops" value="${esc(q)}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"></div>
      <div class="sheet-list">${rows()}</div>`;
    const input = el.querySelector('input');
    input.oninput = () => { q = input.value.trim().toLowerCase(); el.querySelector('.sheet-list').innerHTML = rows(); };
  };
  draw();
  el.onclick = (e) => {
    if (e.target.closest('[data-close]')) return close();
    const d = e.target.closest('[data-d]');
    if (d) { sel = +d.dataset.d; return draw(); } // the filter text carries over to the other direction
    const row = e.target.closest('[data-s]');
    if (!row) return;
    const st = dirs[sel].stops[+row.dataset.s];
    if (!multi) { close(); return onStop(st); }
    onStop(st); // toggle the pin, then update just this row so the scroll position stays put
    const on = isPinned(st), mark = row.querySelector('.mark');
    mark.innerHTML = icon(on ? 'check' : 'plus'); mark.classList.toggle('on', on);
  };
}

// Full-screen timeline of one trip: clock time and "+N min" (from the next stop) at every stop. stopId highlights the stop you tapped from.
async function openTripSheet(tripId, stopId) {
  const { el, close } = sheetShell('<div class="sheet-bar"><b>Trip</b><button data-close class="done">Done</button></div><div class="empty" style="padding:16px">Loading trip…</div>');
  el.onclick = (e) => e.target.closest('[data-close]') && close();
  let t;
  try { t = await api('/api/trip/' + encodeURIComponent(tripId)); }
  catch { el.querySelector('.empty').textContent = 'Could not load this trip.'; return; }
  const now = Date.now() / 1000;
  const next = t.stops.findIndex((x) => x.time > now - 30), first = next < 0 ? t.stops.length - 1 : next, base = t.stops[first].time;
  const rows = t.stops.map((x, i) => `<div class="sg ${i < first ? 'past' : ''} ${x.id === stopId ? 'here' : ''}" ${i === first ? 'data-first' : ''}><span class="t"><b>${esc(x.name)}</b></span>
    <span class="when"><b>${clock(x.time)}</b>${i < first ? '' : `<small>+${Math.round((x.time - base) / 60)} min</small>`}</span></div>`).join('');
  el.innerHTML = `<div class="sheet-bar"><div><b>${badge(t.route, t.color)} ${icon('arrow-right')} ${esc(t.headsign)}</b><small>${t.cancelled ? 'Cancelled' : t.live ? 'Live times' : 'Scheduled times'} · from next stop</small></div><button data-close class="done">Done</button></div>
    <div class="sheet-list">${rows}</div>`;
  const list = el.querySelector('.sheet-list'), row = list.querySelector('[data-first]');
  if (row) list.scrollTop = row.getBoundingClientRect().top - list.getBoundingClientRect().top;
}

// Full-screen timetable of one stop for a day: departures grouped by route + headsign as time grids. Today greys the past and scrolls to now.
const ymd = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Regina' }); // Saskatoon's date: the server's service days are local
function openTimetableSheet(stop) {
  const { el, close } = sheetShell('');
  const today = ymd(Date.now()), tomorrow = ymd(Date.now() + 864e5);
  el.innerHTML = `<div class="sheet-bar"><div><b>Timetable</b><small>${esc(stop.name)}</small></div><button data-close class="done">Done</button></div>
    <div class="dirs"><button data-day="${today}">Today</button><button data-day="${tomorrow}">Tomorrow</button><input type="date" value="${today}" aria-label="Pick a date"></div>
    <div class="sheet-list"></div>`;
  const list = el.querySelector('.sheet-list'), pick = el.querySelector('input');
  let seq = 0;
  async function load(d) {
    const id = ++seq, now = Date.now() / 1000;
    $$('.dirs [data-day]', el).forEach((b) => b.classList.toggle('on', b.dataset.day === d)); pick.value = d;
    list.innerHTML = '<div class="empty" style="padding:16px">Loading…</div>';
    let g;
    try { g = await api(`/api/timetable/${encodeURIComponent(stop.id)}?date=${d}`); }
    catch { if (id === seq) list.innerHTML = '<div class="empty" style="padding:16px">Could not load the timetable. Check your connection.</div>'; return; }
    if (id !== seq) return; // a newer day was picked meanwhile
    list.innerHTML = g.map((x) => { const nx = d === today ? x.times.findIndex((t) => t >= now) : -1; return `<div class="ttgroup"><div class="tthead">${badge(x.route, x.color)}<b>${esc(x.headsign)}</b></div>
      <div class="ttgrid">${x.times.map((t, i) => `<span class="${d === today && t < now ? 'past' : ''} ${i === nx ? 'next' : ''}">${clock(t)}</span>`).join('')}</div></div>`; }).join('') || '<div class="empty" style="padding:16px">No buses stop here on this day.</div>';
    const first = d === today && list.querySelector('.ttgrid span:not(.past)');
    if (first) list.scrollTop = first.closest('.ttgroup').getBoundingClientRect().top - list.getBoundingClientRect().top;
  }
  el.onclick = (e) => {
    if (e.target.closest('[data-close]')) return close();
    const b = e.target.closest('[data-day]'); if (b) load(b.dataset.day);
  };
  pick.onchange = () => pick.value && load(pick.value);
  load(today);
}

// ---------- routes to show (map + alerts) ----------
// null = every route; otherwise the short names the user cares about. Pinned routes/stops and an explicit map route search always show.
let shown = store.get('shownRoutes', null), allRoutes = null;
const routeOn = (short) => !shown || shown.includes(short);
function applyRouteFilter() {
  syncSeg(); refreshPins(); refreshNearby(); syncStopAlerts();
  if (map) refreshMap();
  if (!$('#alerts').hidden) refreshAlerts();
}
async function openRoutesSheet() {
  const { el, close } = sheetShell('<div class="sheet-bar"><b>Routes to show</b><button data-close class="done">Done</button></div><div class="empty" style="padding:16px">Loading routes…</div>', { onClose: applyRouteFilter });
  el.onclick = (e) => e.target.closest('[data-close]') && close();
  try { allRoutes ||= await api('/api/routes'); }
  catch { el.querySelector('.empty').textContent = 'Could not load routes. Check your connection.'; return; }
  const sel = new Set(shown || allRoutes.map((r) => r.short));
  let q = '';
  const save = () => { shown = sel.size === allRoutes.length ? null : [...sel]; store.set('shownRoutes', shown); };
  const rows = () => allRoutes.filter((r) => !q || `${r.short} ${r.long}`.toLowerCase().includes(q))
    .map((r) => `<div class="sg ${sel.has(r.short) ? '' : 'off'}" role="button" tabindex="0" aria-pressed="${sel.has(r.short)}" data-r="${esc(r.short)}">${badge(r.short, r.color)}<span class="t"><b>${esc(r.long)}</b></span><span class="mark ${sel.has(r.short) ? 'on' : ''}">${sel.has(r.short) ? icon('check') : ''}</span></div>`).join('')
    || '<div class="empty" style="padding:16px">No routes match.</div>';
  const count = () => `${sel.size} of ${allRoutes.length} routes shown on the map and in alerts`;
  el.innerHTML = `<div class="sheet-bar"><div><b>Routes to show</b><small id="rcount">${count()}</small></div><button data-close class="done">Done</button></div>
    <div class="dirs"><button data-act="all">Show all</button><button data-act="none">Hide all</button>${routePins.length ? '<button data-act="pinned">Only pinned routes</button>' : ''}</div>
    <div class="sheet-filter"><input type="search" placeholder="Filter routes" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"></div>
    <div class="sheet-list">${rows()}</div>`;
  const list = el.querySelector('.sheet-list');
  const redraw = () => { list.innerHTML = rows(); el.querySelector('#rcount').textContent = count(); save(); };
  el.querySelector('input').oninput = (e) => { q = e.target.value.trim().toLowerCase(); list.innerHTML = rows(); };
  el.onclick = (e) => {
    if (e.target.closest('[data-close]')) return close();
    const act = e.target.closest('[data-act]');
    if (act) {
      sel.clear();
      (act.dataset.act === 'all' ? allRoutes.map((r) => r.short) : act.dataset.act === 'pinned' ? routePins.map((r) => r.short) : []).forEach((x) => sel.add(x));
      return redraw();
    }
    const row = e.target.closest('[data-r]'); if (!row) return;
    const k = row.dataset.r, on = !sel.has(k);
    on ? sel.add(k) : sel.delete(k); save();
    row.classList.toggle('off', !on); row.setAttribute('aria-pressed', on); // update just this row so the scroll position stays put
    const mark = row.querySelector('.mark'); mark.classList.toggle('on', on); mark.innerHTML = on ? icon('check') : '';
    el.querySelector('#rcount').textContent = count();
  };
}
$('#routes-btn').onclick = openRoutesSheet;

// ---------- pinned ----------
const isStopPinned = (s) => pins.some((p) => p.id === s.id);
const toggleStopPin = (s) => {
  pins = isStopPinned(s) ? pins.filter((p) => p.id !== s.id) : [...pins, { id: s.id, name: s.name, lat: s.lat, lon: s.lon }];
  store.set('pins', pins); refreshPins();
};
const addStopPin = (s) => { if (!isStopPinned(s)) toggleStopPin(s); $('#pin-search').value = ''; };
const addRoutePin = (r) => {
  if (!routePins.some((p) => p.short === r.short)) routePins.push({ short: r.short, long: r.long, color: r.color });
  store.set('routePins', routePins); $('#pin-search').value = ''; refreshPins();
};
const pinSearch = searchBox({
  input: $('#pin-search'), box: $('#pin-suggest'), kinds: 'route,stop',
  onPick: Object.assign((it, ctx) => { it.kind === 'route' ? addRoutePin(it) : addStopPin(it); ctx.close(); }, { pinsOnly: true }),
});

const watchKey = (stop, trip) => stop + '|' + trip;
const openStops = new Set(); // pinned stop cards the user has expanded (kept across the 20s refresh)
const ALERT_MINS = [3, 5, 10, 15];
// How sure we are about a bus, in words: cancelled / detour / just left / signal lost / not tracked, else stops away and late/early/on time
const isComing = (a) => !a.cancelled && !a.skipped && !a.gone;
const canBoard = (a) => isComing(a) && !a.ends; // a trip ending at this stop only drops off
const contText = (c) => `Continues as Route ${esc(c.route)} to ${esc(c.headsign)}`; // the same bus carries on as another trip
// From the history: how this bus tends to run at this stop at this hour
const usualText = (a) => {
  const u = a.usual;
  return !u ? '' : u.late >= 30 ? `late ${u.late}% of the time here` : Math.abs(u.avg) < 1 ? 'usually on time' : u.avg > 0 ? `usually ${u.avg} min late` : `usually ${-u.avg} min early`;
};
const lastBus = `<span class="lastbus">${icon('moon')} Last bus</span>`; // the last scheduled trip of the day on this route and direction
function statusOf(a) {
  if (a.cancelled) return '<em class="bad">Cancelled</em>';
  if (a.skipped) return '<em class="bad">Not stopping here (detour)</em>';
  if (a.gone) return 'Just left';
  if (a.stale) return 'Signal lost · last prediction';
  const ends = a.ends ? (a.continuesAs ? contText(a.continuesAs) : 'Drop-off only') : '';
  if (!a.tracked) return [ends, 'Not tracked yet', usualText(a), a.last ? lastBus : ''].filter(Boolean).join(' · ');
  const d = Math.round((a.delay || 0) / 60);
  return [ends, a.stopsAway == null ? '' : a.stopsAway === 0 ? 'Your stop is next' : `${a.stopsAway} stop${a.stopsAway === 1 ? '' : 's'} away`,
    d > 0 ? `${d} min late` : d < 0 ? `<em class="early">${-d} min early</em>` : 'On time', a.usual && a.usual.late >= 30 ? usualText(a) : '', a.last ? lastBus : ''].filter(Boolean).join(' · '); // a live bus only gets the history when it is often late
}
const arrivalEta = (a) => (!isComing(a)
  ? `<span class="eta off">${a.gone ? 'Gone' : `<s>${clock(a.sched)}</s>`}${a.gone ? `<span class="sched">${clock(a.time)}</span>` : ''}</span>`
  : etaHtml(a.time, `<span class="sched">${a.tracked && !a.stale ? liveDot : ''}${clock(a.time)}</span>`, a.tracked && !a.stale ? '' : 'muted'));

// "Walk 6 min · Leave in 3 min for the 45 at 3:42", from where you are (only when the stop is within walking distance)
let myPos = null;
const metres = (a, b) => Math.hypot((a.lat - b.lat) * 111200, (a.lon - b.lon) * 111200 * Math.cos((a.lat * Math.PI) / 180));
function catchLine(p, list, dist) {
  if (dist == null || dist > 1500) return '';
  const walk = walkMins(dist), now = Date.now() / 1000, a = list.find((x) => canBoard(x) && x.time - walk * 60 - 60 >= now); // a minute to spare
  if (!a) return '';
  const at = a.time - walk * 60 - 60;
  return `<div class="catch">${icon('footprints')} ${walk} min walk · <b data-leavein="${at}">${leaveText(at)}</b> for the ${esc(a.route)} at ${clock(a.time)}</div>`;
}

function stopCard(p, list, nearby = false) {
  list = list.filter((a) => routeOn(a.route));
  const items = list.slice(0, nearby ? 4 : 6).map((a, i) => `
    <div class="row ${i ? '' : 'first'} ${isComing(a) ? '' : 'off'} ${a.ends ? 'dropoff' : ''}" role="button" tabindex="0" data-open="${esc(a.trip)}" data-stop="${esc(p.id)}">
      ${badge(a.route, a.color)}
      <span class="hs">${esc(a.headsign)}<small>${statusOf(a)}</small></span>
      ${watching.has(watchKey(p.id, a.trip)) ? `<span class="watched" role="img" aria-label="Alert set">${icon('bell')}</span>` : ''}
      ${arrivalEta(a)}
    </div>`);
  // pinned stops show the next bus you can board (and any cancelled / drop-off one before it); the rest sit behind a chevron
  const lead = Math.max(1, list.slice(0, items.length).findIndex(canBoard) + 1);
  const rows = !items.length ? `<div class="empty">No upcoming buses${shown ? ' on your routes' : ''}</div>`
    : nearby || items.length <= lead ? items.join('')
    : items.slice(0, lead).join('') + `<div class="more">${items.slice(lead).join('')}</div><button class="morebtn" data-more="${esc(p.id)}">${icon('chevron-down')} <span>${items.length - lead} more</span></button>`;
  const mins = stopAlerts[p.id], belled = mins || list.some((a) => watching.has(watchKey(p.id, a.trip)));
  const bell = `<button class="stopbell ${belled ? 'on' : ''}" data-alerts="${esc(p.id)}" data-nearby="${nearby ? 1 : ''}" aria-label="Alerts for ${esc(p.name)}">${icon(mins ? 'bell-ring' : 'bell')}</button>`;
  const tt = `<button data-tt="${esc(p.id)}" data-name="${esc(p.name)}" aria-label="Timetable for ${esc(p.name)}">${icon('calendar-clock')}</button>`;
  const act = nearby
    ? `${tt}${bell}<button data-pin="${esc(p.id)}" data-name="${esc(p.name)}" data-lat="${p.lat}" data-lon="${p.lon}" class="${isStopPinned(p) ? 'on' : ''}" aria-label="${isStopPinned(p) ? 'Unpin' : 'Pin'} stop">${icon('pin')}</button>`
    : `${mins ? `<small class="dist">${mins} min</small>` : ''}${tt}${bell}<button data-unpin="${esc(p.id)}" aria-label="Unpin">${icon('x')}</button>`;
  const dist = nearby ? p.dist : myPos && p.lat ? metres(myPos, p) : null;
  return `<div class="card ${openStops.has(p.id) ? 'open' : ''}"><h2><span class="name">${esc(p.name)}</span>${act}</h2>${catchLine(p, list, dist)}${rows}</div>`;
}

function routeCard(r, buses) {
  const mine = buses.filter((b) => b.route === r.short);
  const groups = new Map();
  for (const b of mine) (groups.get(b.headsign) || groups.set(b.headsign, []).get(b.headsign)).push(b);
  // a bus on a trip that isn't in the timetable has no destination to show
  const body = groups.size ? [...groups].map(([hs, list]) => `<div class="dirhead">${hs ? `${icon('arrow-right')} ${esc(hs)}` : 'Destination not given'}</div>` + list
    .sort((a, b) => (a.next ? a.next.time : Infinity) - (b.next ? b.next.time : Infinity)).slice(0, 5).map((b, i) => {
      const age = b.age == null ? '' : `<span class="sched" title="Position updated ${ageText(b.age)} ago">${icon('radio')} ${ageText(b.age)}</span>`;
      return `
    <div class="row ${i ? '' : 'first'}" role="button" tabindex="0" data-open="${esc(b.trip)}">
      <span class="dirarrow" style="transform:rotate(${b.bearing == null ? 0 : b.bearing}deg)">${icon('navigation-2')}</span>
      <span class="hs">${b.next ? 'Next: ' + esc(b.next.stop) : 'In service'}</span>
      ${b.next ? etaHtml(b.next.time, age) : `<span class="eta">${age}</span>`}
    </div>`;
    }).join('')).join('') : '<div class="empty">No buses in service right now</div>';
  return `<div class="card"><h2>${badge(r.short, r.color)}<span class="name">${esc(r.long)}</span>
    <button data-maproute="${esc(r.short)}" aria-label="Show on map">${icon('map')}</button><button data-unroute="${esc(r.short)}" aria-label="Unpin">${icon('x')}</button></h2>
    ${body}<div class="btnrow"><button class="btn" data-addstop="${esc(r.short)}">${icon('plus')} Pin stops on this route</button></div></div>`;
}

// Pinned stops can be shown in your own order (arrows in reorder mode), by next bus, or by name.
// Both the sort choice and "My order" (the pins list itself) sync between devices.
let pinLists = new Map(), pinBuses = [], reordering = false, stopSort = store.get('stopSort', 'mine');
const SORTS = { mine: 'My order', next: 'Next bus', name: 'Name' };
const nextTime = (p) => { const a = (pinLists.get(p.id) || []).find((x) => routeOn(x.route) && canBoard(x) && x.time > Date.now() / 1000 - 30); return a ? a.time : Infinity; }; // ignore buses already gone
const sortedPins = () => (stopSort === 'next' ? [...pins].sort((a, b) => nextTime(a) - nextTime(b)) : stopSort === 'name' ? [...pins].sort((a, b) => a.name.localeCompare(b.name)) : pins);
const stopsHeader = () => `<div class="section-title sorthead"><span>Stops</span>${pins.length > 1 ? `<span class="sortbox">${stopSort === 'mine' ? `<button data-reorder class="${reordering ? 'on' : ''}" aria-label="Reorder stops">${icon('arrow-up-down')}</button>` : ''}<select id="stopsort" aria-label="Sort stops">${Object.entries(SORTS).map(([k, v]) => `<option value="${k}" ${k === stopSort ? 'selected' : ''}>${v}</option>`).join('')}</select></span>` : ''}</div>`;
const reorderList = () => `<div class="card">${pins.map((p, i) => `<div class="sg reorder"><span class="t"><b>${esc(p.name)}</b></span>
  <button data-move="${i}" data-dir="-1" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>${icon('chevron-up')}</button><button data-move="${i}" data-dir="1" aria-label="Move down" ${i === pins.length - 1 ? 'disabled' : ''}>${icon('chevron-down')}</button></div>`).join('')}</div>`;

function renderPins() {
  $('#pins').innerHTML = (shown ? filterBar() : '') + ((pins.length ? stopsHeader() + (reordering && stopSort === 'mine' ? reorderList() : sortedPins().map((p) => stopCard(p, pinLists.get(p.id) || [])).join('')) : '')
    + (routePins.length ? '<div class="section-title">Routes</div>' + routePins.map((r) => routeCard(r, pinBuses)).join('') : '')
    || '<div class="empty" style="padding:24px 4px">Search a route (like <b>60</b>) or a stop, then tap to pin it ' + icon('pin') + '</div>');
}
async function refreshPins() {
  try {
    const [lists, buses] = await Promise.all([
      Promise.all(pins.map((p) => api('/api/arrivals/' + encodeURIComponent(p.id)))),
      routePins.length ? api('/api/vehicles?routes=' + routePins.map((r) => encodeURIComponent(r.short)).join(',')) : [],
    ]);
    pinRoutes = new Set([...lists.flat().map((a) => a.route), ...routePins.map((r) => r.short)]);
    syncRouteAlerts(); // no-op unless the routes or stops changed
    pinLists = new Map(pins.map((p, i) => [p.id, lists[i]])); pinBuses = buses;
    renderPins();
    updatedAt = Date.now() / 1000; offline = false;
  } catch { offline = true; if (!updatedAt) renderPins(); } // never fetched: drop the loading placeholders
  tick();
}

// "Near you": stops within 800 m with their next buses. Loads by itself once location is allowed; until then a button asks for it.
let nearbyData = null;
function renderNearby() {
  $('#nearby').innerHTML = '<div class="section-title">Near you</div>' + (nearbyData
    ? nearbyData.map((p) => stopCard(p, p.arrivals, true)).join('') || '<div class="empty">No buses near you right now</div>'
    : `<div class="card"><button class="btn" data-locate>${icon('locate-fixed')} Show buses near me</button></div>`);
}
async function refreshNearby(ask = false) {
  if (!ask && !(await geoGranted())) return renderNearby();
  if (!nearbyData) $('#nearby').innerHTML = '<div class="section-title">Near you</div>' + skeleton(2);
  try {
    const me = await here();
    myPos = me; renderPins(); // pinned cards can now say when to leave (no refetch)
    nearbyData = shown && !shown.length ? [] : await api(`/api/nearby?lat=${me.lat}&lon=${me.lon}${shown ? '&routes=' + shown.map(encodeURIComponent).join(',') : ''}`);
  }
  catch { if (ask) toast('Location unavailable'); }
  renderNearby();
}

// Push subscription for this device. create: ask permission and subscribe if there isn't one yet. Returns null (with a toast) if unavailable.
async function getSub(create) {
  if (!('serviceWorker' in navigator && 'PushManager' in window)) { // only say so when you asked for one, not on background syncs
    if (create) toast(/iPhone|iPad/.test(navigator.userAgent) ? 'Add to Home Screen to get notifications' : 'Notifications need HTTPS or localhost');
    return null;
  }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub || !create) return sub;
  if ((await within(Notification.requestPermission(), 15000)) !== 'granted') { toast('Notifications blocked'); return null; }
  const b64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  return within(reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64((await api('/api/push/key')).key) }), 10000);
}
const pushFail = (err) => toast(err.message === 'timeout' ? 'Notifications unavailable here' : 'Could not set notification');

// One bus at one stop, w = {stopId, stopName, tripId, route, headsign, minutes?}: alert N min before it arrives
// (N defaults to the stop's alert minutes, else 5). Toggles; returns once done.
// A ride watch ({ride: true, alightStopId, ...}, see rideWatch) is the same toggle: "your stop is next" while you are on that bus.
const rideKey = (w) => (w.ride ? 'ride|' : '') + watchKey(w.alightStopId || w.stopId, w.tripId);
async function toggleWatch(w) {
  const k = rideKey(w), on = watching.has(k), minutes = w.minutes || stopAlerts[w.stopId] || 5;
  try {
    const sub = await getSub(!on);
    if (!sub) return;
    if (on) { await post('/api/push/unwatch', { sub, stopId: w.stopId, alightStopId: w.alightStopId, ride: w.ride, tripId: w.tripId }); watching.delete(k); }
    else { await post('/api/push/watch', { ...w, minutes, sub }); watching.add(k); toast(w.ride ? `Will tell you when ${w.stopName} is next` : `Will notify ${minutes} min before`); }
    store.set('watching', [...watching]);
  } catch (err) { pushFail(err); }
}

// Every bus at a pinned stop (only the routes you chose in Routes to show): alert N min before each one until turned off
let stopAlerts = store.get('stopAlerts', {}); // stopId -> minutes
const stopWatch = (id) => ({ stopId: id, stopName: (pins.find((p) => p.id === id) || {}).name, standing: true, minutes: stopAlerts[id], routes: shown });
// mins: turn on (or change) at that many minutes; null: turn off
async function setStopAlert(id, mins) {
  try {
    const sub = await getSub(!!mins);
    if (!sub && mins) return;
    if (!mins) { if (sub) await post('/api/push/unwatch', { sub, stopId: id }); delete stopAlerts[id]; } // no sub here: the alert came from another device, just drop it
    else { const was = stopAlerts[id]; await post('/api/push/watch', { ...stopWatch(id), minutes: mins, sub }); stopAlerts[id] = mins; if (!was) toast(`Alerts on: ${mins} min before every bus`); }
    store.set('stopAlerts', stopAlerts); store.set('alertsHere', Object.keys(stopAlerts));
  } catch (err) { pushFail(err); }
}
// Alerts are synced between devices but each device has its own push subscription, so make the server's watches for THIS device
// match the shared list: drop the ones removed elsewhere, (re)register the rest with the current minutes / route filter.
// wanted: id -> the watch for it; gone(id): what identifies a watch to remove. hereKey remembers which ids this device has registered.
// Returns true once this device's watches are registered.
async function mirrorWatches(hereKey, wanted, gone, create = false) {
  try {
    const sub = await getSub(create);
    if (!sub) return false;
    for (const id of store.get(hereKey, [])) if (!(id in wanted)) await post('/api/push/unwatch', { sub, ...gone(id) });
    for (const w of Object.values(wanted)) await post('/api/push/watch', { ...w, sub });
    store.set(hereKey, Object.keys(wanted));
    return true;
  } catch { return false; }
}
const syncStopAlerts = () => mirrorWatches('alertsHere', Object.fromEntries(Object.keys(stopAlerts).map((id) => [id, stopWatch(id)])), (id) => ({ stopId: id }));

// Push new service alerts on your routes (routes of pinned stops and pinned routes, plus pinned stops). Synced on/off; each device
// registers its own watch, re-sent only when the routes or stops change (the server re-primes then, so old alerts are not announced).
let routeAlerts = store.get('routeAlerts', false), routeAlertsSig = null;
const alertsWatch = () => ({ alerts: true, routes: [...pinRoutes], stopIds: pins.map((p) => p.id), minutes: 1 });
async function syncRouteAlerts(create = false) {
  const w = alertsWatch(), sig = routeAlerts && JSON.stringify([w.routes, w.stopIds]);
  if (!create && sig === routeAlertsSig) return true;
  const ok = await mirrorWatches('routeAlertsHere', routeAlerts ? { alerts: w } : {}, () => ({ alerts: true }), create);
  if (ok) routeAlertsSig = sig;
  return ok;
}
// One bell per stop opens this: how many minutes ahead, every bus at the stop (pinned stops only), or just one of the next buses.
function openAlertSheet(stop, arrivals) {
  let mins = stopAlerts[stop.id] || 5, busy = false;
  const pinned = isStopPinned(stop);
  const { el, close } = sheetShell('', { mini: true, onClose: () => { renderPins(); if (nearbyData) renderNearby(); } });
  const draw = () => {
    const list = arrivals().filter((a) => routeOn(a.route) && isComing(a) && a.time > Date.now() / 1000 - 30).slice(0, 6), standing = stop.id in stopAlerts;
    el.innerHTML = `<div class="sheet-bar"><div><b>Alerts</b><small>${esc(stop.name)}</small></div><button data-close class="done">Done</button></div>
      <div class="sheet-list">
        <div class="alabel">Notify me before the bus arrives</div>
        <div class="seg wide" role="group" aria-label="Minutes before">${ALERT_MINS.map((n) => `<button data-mins="${n}" class="${n === mins ? 'on' : ''}" aria-pressed="${n === mins}">${n} min</button>`).join('')}</div>
        ${pinned ? `<div class="sg" role="switch" tabindex="0" aria-checked="${standing}" data-standing><span class="ico">${icon('bell-ring')}</span><span class="t"><b>Every bus at this stop</b><small>On the routes you show, until you turn it off</small></span><span class="switch ${standing ? 'on' : ''}"></span></div>` : ''}
        <div class="alabel">${pinned ? 'Or just one bus' : 'Pick a bus'}</div>
        ${list.map((a, i) => { const on = watching.has(watchKey(stop.id, a.trip)); return `<div class="sg" role="button" tabindex="0" aria-pressed="${on}" data-w="${i}">${badge(a.route, a.color)}<span class="t"><b>${esc(a.headsign)}</b><small>${clock(a.time)} · ${etaText(a.time)}</small></span><span class="mark ${on ? 'on' : ''}">${icon(on ? 'check' : 'bell')}</span></div>`; }).join('') || '<div class="empty" style="padding:12px 14px">No upcoming buses</div>'}
      </div>`;
    return list;
  };
  let list = draw();
  el.onclick = async (e) => {
    if (e.target.closest('[data-close]')) return close();
    if (busy) return;
    const m = e.target.closest('[data-mins]'), sw = e.target.closest('[data-standing]'), w = e.target.closest('[data-w]');
    busy = true;
    if (m) { mins = +m.dataset.mins; if (stop.id in stopAlerts) await setStopAlert(stop.id, mins); }
    else if (sw) await setStopAlert(stop.id, stop.id in stopAlerts ? null : mins);
    else if (w) { const a = list[+w.dataset.w]; await toggleWatch({ stopId: stop.id, stopName: stop.name, tripId: a.trip, route: a.route, headsign: a.headsign, minutes: mins }); }
    busy = false;
    if (el.isConnected) list = draw();
  };
}

$('#pins').onclick = $('#nearby').onclick = (e) => {
  const t = e.target.closest('button');
  if (!t) { const row = e.target.closest('[data-open]'); return row && openTripSheet(row.dataset.open, row.dataset.stop); }
  if (t.dataset.tt) return openTimetableSheet({ id: t.dataset.tt, name: t.dataset.name });
  if (t.dataset.editroutes !== undefined) return openRoutesSheet();
  if (t.dataset.reorder !== undefined) { reordering = !reordering; return renderPins(); }
  if (t.dataset.move) { // swap with the neighbour; no refetch, so it's instant
    const i = +t.dataset.move, k = i + +t.dataset.dir;
    if (k >= 0 && k < pins.length) { [pins[i], pins[k]] = [pins[k], pins[i]]; store.set('pins', pins); renderPins(); }
    return;
  }
  if (t.dataset.alerts) {
    const id = t.dataset.alerts, near = t.dataset.nearby && nearbyData.find((p) => p.id === id);
    return openAlertSheet(near || pins.find((p) => p.id === id), () => (near ? near.arrivals : pinLists.get(id) || []));
  }
  if (t.dataset.more) { const open = t.closest('.card').classList.toggle('open'); return open ? openStops.add(t.dataset.more) : openStops.delete(t.dataset.more); }
  if (t.dataset.locate !== undefined) return refreshNearby(true);
  if (t.dataset.pin) { toggleStopPin({ id: t.dataset.pin, name: t.dataset.name, lat: +t.dataset.lat, lon: +t.dataset.lon }); return renderNearby(); }
  if (t.dataset.unpin) { // no refetch (the arrivals are still in pinLists), and Undo puts it back where it was, alerts included
    const i = pins.findIndex((p) => p.id === t.dataset.unpin), p = pins[i], mins = stopAlerts[p.id];
    if (mins) setStopAlert(p.id, null);
    pins.splice(i, 1); store.set('pins', pins); renderPins();
    return toast(`Unpinned ${p.name}`, 'Undo', () => { pins.splice(Math.min(i, pins.length), 0, p); store.set('pins', pins); if (mins) setStopAlert(p.id, mins); renderPins(); });
  }
  if (t.dataset.unroute) {
    const i = routePins.findIndex((r) => r.short === t.dataset.unroute), r = routePins[i];
    routePins.splice(i, 1); store.set('routePins', routePins); renderPins();
    return toast(`Unpinned Route ${r.short}`, 'Undo', () => { routePins.splice(Math.min(i, routePins.length), 0, r); store.set('routePins', routePins); renderPins(); });
  }
  if (t.dataset.maproute) { showTab('map'); $('#maproute').value = t.dataset.maproute; fitNext = true; syncSeg(); return refreshMap(); }
  if (t.dataset.addstop) {
    const r = routePins.find((x) => x.short === t.dataset.addstop);
    openStopSheet(r, { multi: true, isPinned: isStopPinned, onStop: toggleStopPin });
  }
};

$('#pins').onchange = (e) => {
  if (e.target.id === 'stopsort') { stopSort = e.target.value; store.set('stopSort', stopSort); reordering = false; renderPins(); }
};
syncStopAlerts();

// ---------- plan ----------
const place = { from: null, to: null };
// Home / Work: one tap plans a trip there from where you are. Saved on this device only.
const SLOTS = [['home', 'Home'], ['work', 'Work']];
let saved = store.get('saved', {}), pendingSlot = null, slotMins = {}, slotAt = 0;
const TO_HINT = $('#to').placeholder;
function renderPlaces() {
  $('#places').innerHTML = SLOTS.map(([k, label]) => `<div class="place"><button class="go" data-go="${k}">${icon(k === 'home' ? 'house' : 'briefcase')}<span><b>${label}${slotMins[k] ? ` <em>${slotMins[k]} min</em>` : ''}</b><small>${saved[k] ? esc(saved[k].name) : 'Tap to set'}</small></span></button>${saved[k] ? `<button class="edit" data-edit="${k}" aria-label="Change ${label}">${icon('pencil')}</button>` : ''}</div>`).join('');
}
function startSet(k) {
  pendingSlot = k;
  $('#to').value = ''; place.to = null;
  $('#to').placeholder = `Search for your ${k}`;
  $('#to').focus();
}
async function goTo(k) {
  place.to = { lat: saved[k].lat, lon: saved[k].lon }; $('#to').value = saved[k].name;
  if (!place.from) {
    try { place.from = await here(); $('#from').value = 'My location'; }
    catch { toast('Location unavailable'); return $('#from').focus(); }
  }
  planTrip();
}
async function loadSlotMins() { // travel time from here to each saved place, shown on its chip
  if (Date.now() - slotAt < 60000 || !Object.keys(saved).length || !(await geoGranted())) return;
  slotAt = Date.now();
  let me; try { me = await here(); } catch { return; }
  for (const k of Object.keys(saved)) api(`/api/plan?from=${me.lat},${me.lon}&to=${saved[k].lat},${saved[k].lon}&depart=0`)
    .then((r) => { slotMins[k] = r && r.length ? Math.round((r[0].arrive - Date.now() / 1000) / 60) : null; renderPlaces(); }).catch(() => {});
}
$('#places').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.edit) return startSet(b.dataset.edit);
  saved[b.dataset.go] ? goTo(b.dataset.go) : startSet(b.dataset.go);
};
renderPlaces();
const recents = () => store.get('recents', []);
const remember = (p) => store.set('recents', [p, ...recents().filter((r) => !(r.name === p.name && r.sub === p.sub))].slice(0, 6));

function planBox(key) {
  const input = $('#' + key);
  async function choose(it, ctx) {
    try {
      const p = it.kind === 'here' ? { ...(await here()), name: 'My location' } : await ctx.coords(it);
      if (key === 'to' && pendingSlot) { // this pick is being saved as Home/Work
        const k = pendingSlot; pendingSlot = null; input.placeholder = TO_HINT;
        saved[k] = { name: p.name, lat: p.lat, lon: p.lon }; store.set('saved', saved); slotMins[k] = null; slotAt = 0;
        ctx.close(); renderPlaces(); loadSlotMins();
        return goTo(k);
      }
      place[key] = { lat: p.lat, lon: p.lon };
      input.value = p.name;
      if (it.kind !== 'here') remember({ name: p.name, sub: p.sub || '', lat: p.lat, lon: p.lon });
      ctx.close();
      planTrip();
    } catch { toast(it.kind === 'here' ? 'Location unavailable' : 'Could not load that place'); }
  }
  searchBox({
    input, box: $('#' + key + '-suggest'), kinds: 'route,stop,dest,place',
    empty: () => [{ kind: 'here' }, ...recents().map((r) => ({ ...r, kind: 'recent' }))],
    onPick: (it, ctx) => (it.kind === 'route' ? ctx.drill(it, (s) => choose(s, ctx)) : choose(it, ctx)),
  });
  input.addEventListener('input', () => (place[key] = null));
}
planBox('from'); planBox('to');
$('#swap').onclick = () => {
  [place.from, place.to] = [place.to, place.from];
  [$('#from').value, $('#to').value] = [$('#to').value, $('#from').value];
  planTrip();
};
$('#when').onchange = () => planTrip();
let accessible = store.get('accessible', false); // synced like the other plan prefs
const showAccessible = () => { $('#acc').classList.toggle('on', accessible); $('#acc').setAttribute('aria-pressed', accessible); };
$('#acc').onclick = () => { accessible = !accessible; store.set('accessible', accessible); showAccessible(); planTrip(); };
showAccessible();
// Leave now, depart at a time, or arrive by a time; the picker only appears for the last two, so it's never a blank box
let leaveMode = 'now';
const setLeave = (mode) => {
  leaveMode = mode;
  $$('#leave [data-when]').forEach((b) => b.classList.toggle('on', b.dataset.when === mode)); $('#when').hidden = mode === 'now';
  if (mode !== 'now' && !$('#when').value) { // default to the next half hour (arrive by: the one after, so there's time to get there), in local time
    const d = new Date(Math.ceil((Date.now() + (mode === 'arrive' ? 1800000 : 0) + 60000) / 1800000) * 1800000);
    $('#when').value = new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }
  if (mode === 'now') $('#when').value = '';
  planTrip();
};
$$('#leave [data-when]').forEach((b) => (b.onclick = () => setLeave(b.dataset.when)));

async function planTrip() {
  if (!place.from || !place.to) return;
  clearTripMap();
  $('#trip').innerHTML = '<div class="empty">Planning…</div>';
  const t = $('#when').value ? Math.floor(new Date($('#when').value).getTime() / 1000) : 0;
  let r, wx;
  try { [r, wx] = await Promise.all([api(`/api/plan?from=${place.from.lat},${place.from.lon}&to=${place.to.lat},${place.to.lon}&${leaveMode === 'arrive' ? 'arrive' : 'depart'}=${t}${accessible ? '&accessible=1' : ''}`), api('/api/weather').catch(() => null)]); }
  catch { return ($('#trip').innerHTML = '<div class="empty">Planning needs a connection.</div>'); }
  if (!r || !r.length) return ($('#trip').innerHTML = `<div class="empty">${leaveMode === 'arrive' && t ? `Nothing gets there by ${clock(t)}. Try a later time.` : 'No route found. Try a different time or place.'}</div>`);
  trips = r; planEnds = { from: place.from, to: place.to }; // what "Show on map" draws walks to (place can change before the next plan)
  $('#trip').innerHTML = (wx && wx.cold ? `<div class="wx">${icon('snowflake')} ${wx.temp}°C feels like ${wx.feels}°C · fewer walks, less waiting outside</div>` : '') + r.map((o, i) => tripCard(o, i)).join('') + `<div class="btnrow"><button class="btn" data-savecommute>${icon('route')} Alert me when to leave for this trip</button></div>`;
}
let trips = [], planEnds = null;
const firstRide = (i) => trips[i].legs.find((l) => l.type === 'ride');
// l: a ride leg, nl: the ride leg after it (if any) and the walk between them, so a missed connection can be rescued
const rideWatch = (l, nl, walkMins) => ({ ride: true, tripId: l.trip, alightStopId: l.alight.id, alightIdx: l.alight.idx, stopName: l.alight.name, route: l.route, headsign: l.headsign, minutes: 1,
  ...(nl && { next: { tripId: nl.trip, boardStopId: nl.board.id, boardIdx: nl.boardIdx, walkSecs: walkMins * 60, route: nl.route, stopName: nl.board.name }, to: { lat: place.to.lat, lon: place.to.lon }, alightAt: { lat: l.alight.lat, lon: l.alight.lon } }) });
const rideLabel = (l) => (watching.has(rideKey({ ride: true, alightStopId: l.alight.id, tripId: l.trip })) ? `${icon('bell-ring')} Stop alert on` : `${icon('bus')} I'm on this bus`);
// the native share sheet when there is one, else copy the link
async function shareLink(url) {
  if (navigator.share) return void (await navigator.share({ title: 'My arrival', url }).catch(() => {}));
  await navigator.clipboard.writeText(url);
  toast('Link copied');
}
const tripPinLabel = (l) => `${icon('pin')} ${isStopPinned(l.board) ? 'Stop pinned' : 'Pin this stop'}`;
$('#trip').onclick = async (e) => {
  const b = e.target.closest('button');
  if (b?.dataset.savecommute !== undefined) return openCommuteSheet();
  if (b?.dataset.tpin) { const l = firstRide(+b.dataset.tpin); toggleStopPin(l.board); b.classList.toggle('on', isStopPinned(l.board)); return void (b.innerHTML = tripPinLabel(l)); }
  if (b?.dataset.ride) {
    const [o, j] = b.dataset.ride.split(':').map(Number), legs = trips[o].legs, l = legs[j], after = legs.slice(j + 1), ni = after.findIndex((x) => x.type === 'ride');
    await toggleWatch(rideWatch(l, ni < 0 ? null : after[ni], after.slice(0, Math.max(ni, 0)).reduce((n, x) => n + x.mins, 0)));
    b.classList.toggle('on', watching.has(rideKey({ ride: true, alightStopId: l.alight.id, tripId: l.trip })));
    return void (b.innerHTML = rideLabel(l));
  }
  if (b?.dataset.share) {
    const [o, j] = b.dataset.share.split(':').map(Number), l = trips[o].legs[j];
    try { const { url } = await post('/api/share', { tripId: l.trip, alightIdx: l.alight.idx, toName: l.alight.name }).then((r) => r.json()); await shareLink(url); }
    catch { toast('Could not share'); }
    return;
  }
  if (b?.dataset.twatch) {
    const l = firstRide(+b.dataset.twatch);
    await toggleWatch({ stopId: l.board.id, stopName: l.board.name, tripId: l.trip, route: l.route, headsign: l.headsign });
    return void b.classList.toggle('on', watching.has(watchKey(l.board.id, l.trip)));
  }
  if (b?.dataset.showmap) return showTripOnMap(+b.dataset.showmap);
  const c = e.target.closest('.trip-opt'); // tap an option to expand/collapse its steps
  if (c) { c.classList.toggle('open'); c.querySelector('.summary').setAttribute('aria-expanded', c.classList.contains('open')); }
};

// One itinerary: leave -> arrive, route badges, and a timeline (clock time + stop at each boarding/alighting, a coloured rail per ride)
function tripCard(r, i) {
  const open = i === 0, rides = r.legs.filter((l) => l.type === 'ride');
  const walk = r.legs.filter((l) => l.type === 'walk').reduce((n, l) => n + l.mins, 0) + (r.finalWalkMins || 0);
  const stopRow = (t, name) => `<div class="tr"><time>${clock(t)}</time><i class="dot"></i><b>${esc(name)}</b></div>`;
  const legs = r.legs.map((l, j) => l.type === 'walk'
    ? `<div class="tw">${icon('footprints')} ${l.mins} min</div>`
    : `${l.stayOn ? `<div class="tw">${icon('repeat')} Stay on: becomes Route ${esc(l.route)} to ${esc(l.headsign)}</div>` : ''}${l.risk ? `<div class="tw warn">${icon('triangle-alert')} Tight transfer: the ${esc(l.risk.route)} is 3+ min late ${l.risk.late}% of the time here</div>` : ''}<div class="ride" style="--c:#${esc(l.color || '444')}">${stopRow(l.dep, l.from)}
        <div class="tb">${badge(l.route, l.color)}<span class="hs">${esc(l.headsign)}</span>${l.live ? `<span class="live">${liveDot}live</span>` : ''}${l.last ? lastBus : ''}<small>${Math.round((l.arr - l.dep) / 60)} min · ${l.stops} ${icon('signpost')}</small>
          ${l.alight ? `<button class="btn rbtn ${watching.has(rideKey({ ride: true, alightStopId: l.alight.id, tripId: l.trip })) ? 'on' : ''}" data-ride="${i}:${j}">${rideLabel(l)}</button><button class="btn rbtn" data-share="${i}:${j}">${icon('share-2')} Share arrival</button>` : ''}</div>
        ${stopRow(l.arr, l.to)}</div>`).join('');
  // the bus you catch first: pin its stop or get an alert before it arrives there
  const first = rides[0], act = first && first.trip ? `<div class="btnrow"><button class="btn ${isStopPinned(first.board) ? 'on' : ''}" data-tpin="${i}">${tripPinLabel(first)}</button>
    <button class="btn ${watching.has(watchKey(first.board.id, first.trip)) ? 'on' : ''}" data-twatch="${i}">${icon('bell')} Alert for this bus</button></div>` : '';
  const onMap = `<div class="btnrow"><button class="btn" data-showmap="${i}">${icon('map')} Show on map</button></div>`;
  return `<div class="card trip-opt ${open ? 'open' : ''}"><div class="summary" role="button" tabindex="0" aria-expanded="${open}"><span>${icon('clock')} ${clock(r.leave)}</span><span class="to">${icon('arrow-right')}</span><span>${icon('flag')} ${clock(r.arrive)}</span><span class="chev">${icon('chevron-down')}</span></div>
    <div class="meta"><span class="leavein" data-leavein="${r.leave}">${leaveText(r.leave)}</span><span>${icon('timer')} ${Math.round((r.arrive - r.leave) / 60)} min</span>${rides.length > 1 ? `<span>${icon('repeat')} ${rides.length - 1}</span>` : ''}<span>${icon('footprints')} ${walk} min</span><span class="rb">${rides.map((l) => badge(l.route, l.color)).join('')}</span></div>
    <div class="legs">${legs}${r.finalWalkMins ? `<div class="tw">${icon('footprints')} ${r.finalWalkMins} min</div>` : ''}${act}${onMap}</div></div>`;
}

// ---------- commutes ----------
// A saved trip that pushes "leave in N min" while its time window is open. Synced like pins; each device registers its own push watch.
let commutes = store.get('commutes', []); // {id, name, from: {lat, lon, name}, to: {lat, lon, name}, days: [0-6], startMin, endMin, minutes, off}
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const minText = (m) => new Date(2000, 0, 1, 0, m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const fromHhmm = (v) => { const [h, m] = v.split(':').map(Number); return h * 60 + m; };
const daysText = (d) => { const k = [...d].sort().join(); return k === '1,2,3,4,5' ? 'Weekdays' : k === '0,6' ? 'Weekends' : d.length === 7 ? 'Every day' : [...d].sort().map((x) => DAYS[x]).join(' '); };
const commuteWatch = (c) => ({ commute: true, commuteId: c.id, name: c.name, from: { lat: c.from.lat, lon: c.from.lon }, to: { lat: c.to.lat, lon: c.to.lon }, minutes: c.minutes, days: c.days, startMin: c.startMin, endMin: c.endMin });
const syncCommutes = (create = false) => mirrorWatches('commutesHere', Object.fromEntries(commutes.filter((c) => !c.off).map((c) => [c.id, commuteWatch(c)])), (id) => ({ commuteId: id }), create);
const saveCommutes = (create) => { store.set('commutes', commutes); renderCommutes(); return syncCommutes(create); };
function renderCommutes() {
  $('#commutes').innerHTML = commutes.length ? '<div class="section-title">Commutes</div><div class="card">' + commutes.map((c) => `<div class="sg" role="button" tabindex="0" data-cid="${esc(c.id)}"><span class="ico">${icon('route')}</span>
    <span class="t"><b>${esc(c.name)}</b><small>${daysText(c.days)} · ${minText(c.startMin)}–${minText(c.endMin)} · ${c.off ? 'alerts off' : `${c.minutes} min before leaving`}</small></span>
    <button class="cbtn ${c.off ? '' : 'on'}" data-cid="${esc(c.id)}" data-act="bell" aria-label="${c.off ? 'Turn alerts on for' : 'Turn alerts off for'} ${esc(c.name)}">${icon(c.off ? 'bell-off' : 'bell-ring')}</button>
    <button class="cbtn" data-cid="${esc(c.id)}" data-act="del" aria-label="Remove ${esc(c.name)}">${icon('x')}</button></div>`).join('') + '</div>' : '';
}
$('#commutes').onclick = (e) => {
  const el = e.target.closest('[data-cid]'), act = e.target.closest('[data-act]')?.dataset.act, c = el && commutes.find((x) => x.id === el.dataset.cid);
  if (!c) return;
  if (act === 'bell') { c.off = !c.off; return void saveCommutes(!c.off); }
  if (act === 'del') {
    const i = commutes.indexOf(c); commutes.splice(i, 1); saveCommutes();
    return toast(`Removed ${c.name}`, 'Undo', () => { commutes.splice(Math.min(i, commutes.length), 0, c); saveCommutes(); });
  }
  place.from = { lat: c.from.lat, lon: c.from.lon }; place.to = { lat: c.to.lat, lon: c.to.lon }; // tap the row to plan it now
  $('#from').value = c.from.name; $('#to').value = c.to.name;
  planTrip();
};
// Save the trip on screen as a commute: which days and hours to watch, and how long before you need to leave to be told
function openCommuteSheet() {
  const from = { ...place.from, name: $('#from').value }, to = { ...place.to, name: $('#to').value };
  const c = { name: `To ${to.name}`, days: [1, 2, 3, 4, 5], startMin: 420, endMin: 540, minutes: 5 };
  const { el, close } = sheetShell('', { mini: true });
  const draw = () => {
    el.innerHTML = `<div class="sheet-bar"><div><b>Commute alerts</b><small>${esc(from.name)} ${icon('arrow-right')} ${esc(to.name)}</small></div><button data-close class="done">Cancel</button></div>
      <div class="sheet-list cform">
        <label class="alabel" for="cname">Name</label><input id="cname" type="text" value="${esc(c.name)}" maxlength="40" autocomplete="off">
        <div class="alabel">Days</div>
        <div class="seg wide" role="group" aria-label="Days">${[1, 2, 3, 4, 5, 6, 0].map((d) => `<button data-day="${d}" class="${c.days.includes(d) ? 'on' : ''}" aria-pressed="${c.days.includes(d)}">${DAYS[d]}</button>`).join('')}</div>
        <div class="alabel">Alert me between</div>
        <div class="trow"><input id="cstart" type="time" value="${hhmm(c.startMin)}" aria-label="From"><span>and</span><input id="cend" type="time" value="${hhmm(c.endMin)}" aria-label="Until"></div>
        <div class="alabel">Tell me before I need to leave</div>
        <div class="seg wide" role="group" aria-label="Minutes before leaving">${ALERT_MINS.map((n) => `<button data-mins="${n}" class="${n === c.minutes ? 'on' : ''}" aria-pressed="${n === c.minutes}">${n} min</button>`).join('')}</div>
        <div class="btnrow"><button class="btn primary" data-save>${icon('bell-ring')} Save commute</button></div>
      </div>`;
    el.querySelector('#cname').oninput = (e) => { c.name = e.target.value; };
    el.querySelector('#cstart').onchange = (e) => { if (e.target.value) c.startMin = fromHhmm(e.target.value); };
    el.querySelector('#cend').onchange = (e) => { if (e.target.value) c.endMin = fromHhmm(e.target.value); };
  };
  draw();
  el.onclick = async (e) => {
    if (e.target.closest('[data-close]')) return close();
    const day = e.target.closest('[data-day]'), m = e.target.closest('[data-mins]');
    if (day) { const d = +day.dataset.day; c.days = c.days.includes(d) ? c.days.filter((x) => x !== d) : [...c.days, d]; return draw(); }
    if (m) { c.minutes = +m.dataset.mins; return draw(); }
    if (!e.target.closest('[data-save]')) return;
    if (!c.days.length) return toast('Pick at least one day');
    if (c.endMin <= c.startMin) return toast('The end time must be after the start');
    commutes.push({ id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()), ...c, name: c.name.trim() || `To ${to.name}`, from, to });
    close();
    if (await saveCommutes(true)) toast(`Alerts on: ${c.minutes} min before you need to leave`);
  };
}
renderCommutes(); syncCommutes();

// ---------- signed-in devices ----------
// Every sign-in is its own session on the server, so a lost phone can be signed out from here without changing the password.
// The header button only appears when the server has a login at all (it doesn't in local dev).
const daysAgo = (ms) => { const d = Math.floor((Date.now() - ms) / 864e5); return d < 1 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`; };
async function openDevicesSheet() {
  const bar = '<div class="sheet-bar"><b>Signed-in devices</b><button data-close class="done">Done</button></div>';
  const { el, close } = sheetShell(bar + '<div class="empty" style="padding:16px">Loading…</div>');
  let list = [];
  const draw = async () => {
    try { list = (await api('/api/sessions')).sessions; } catch { return void (el.querySelector('.empty').textContent = 'Could not load devices.'); }
    el.innerHTML = `<div class="sheet-bar"><div><b>Signed-in devices</b><small>Sign one out if you lose it</small></div><button data-close class="done">Done</button></div>
      <div class="sheet-list">${list.map((s) => `<div class="sg"><span class="ico">${icon('smartphone')}</span><span class="t"><b>${esc(s.label)}${s.current ? '<span class="chip">This device</span>' : ''}</b><small>Signed in ${new Date(s.created).toLocaleDateString()} · active ${daysAgo(s.lastSeen)}</small></span>
        <button class="cbtn" data-revoke="${esc(s.id)}" aria-label="Sign out ${s.current ? 'this device' : esc(s.label)}">${icon('log-out')}</button></div>`).join('')}</div>`;
  };
  el.onclick = async (e) => {
    if (e.target.closest('[data-close]')) return close();
    const b = e.target.closest('[data-revoke]'); if (!b) return;
    if (!b.dataset.sure) { b.dataset.sure = 1; b.classList.add('sure'); b.textContent = 'Sign out?'; return; } // a second tap confirms
    const me = list.find((s) => s.id === b.dataset.revoke)?.current;
    try { await post('/api/sessions/revoke', { id: b.dataset.revoke }); } catch { return toast('Could not sign out that device'); }
    if (me) location.href = '/login'; else draw();
  };
  draw();
}
$('#devices-btn').onclick = openDevicesSheet;
api('/api/sessions').then((r) => { $('#devices-btn').hidden = !r.enabled; }).catch(() => {});

// ---------- map ----------
let map, lineLayer, dotLayer, tripLayer, busLayer, stopLayer, meMarker, fitNext = false;
// Leaflet (public/vendor, from `npm run vendor`) loads the first time the map opens, so it never holds up the app's first paint
let leaflet;
const loadLeaflet = () => (leaflet ||= new Promise((ok, no) => {
  document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: 'vendor/leaflet.css' }));
  document.head.append(Object.assign(document.createElement('script'), { src: 'vendor/leaflet.js', onload: ok, onerror: () => { leaflet = null; no(); } }));
}));
let mapMode = store.get('mapMode', pins.length || routePins.length ? 'pins' : 'all'); // riders mostly care about their own buses
const markers = new Map(); // vehicle id -> marker, updated in place so buses glide instead of flickering

const busIcon = (b) => L.divIcon({
  className: '', iconSize: [52, 52], iconAnchor: [26, 26],
  html: `<div class="bus" style="--c:#${esc(b.color || '444')}">${b.bearing == null ? '' : `<div class="arrow" style="transform:rotate(${b.bearing}deg)"></div>`}<div class="dot"><small>${esc(b.label)}</small><b>${esc(b.route || '?')}</b></div></div>`,
});
const busPopup = (b) => `<b>Route ${esc(b.route)} ${icon('arrow-right')} ${esc(b.headsign)}</b><br>Bus #${esc(b.label)}${b.next ? `<br>Next: ${esc(b.next.stop)} · ${etaText(b.next.time)}` : ''}${b.age == null ? '' : `<br>Updated ${ageText(b.age)} ago`}`;

function syncSeg() {
  $('.mapbar [data-mode=all]').textContent = shown ? 'My routes' : 'All';
  $$('.mapbar .seg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mapMode && !$('#maproute').value)); }
function initMap() {
  if (map) return;
  const CITY = L.latLngBounds([52.05, -106.80], [52.23, -106.50]); // the map can't be panned or zoomed out beyond Saskatoon
  // tapHold: Leaflet only synthesizes a long-press "contextmenu" when it sees Safari in the UA, which a Home Screen app doesn't
  // have, so turn it on for any iOS touch device (Android fires a native contextmenu itself, which would double up)
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Mac/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  map = L.map('mapbox', { preferCanvas: true, maxBounds: CITY, maxBoundsViscosity: 1, minZoom: 10, tapHold: ios }).setView([52.13, -106.65], 12);
  const fitCity = () => map.setMinZoom(Math.max(10, map.getBoundsZoom(CITY))); // zoomed out just far enough to see the whole city
  fitCity(); window.addEventListener('resize', fitCity);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(map);
  lineLayer = L.layerGroup().addTo(map);
  dotLayer = L.layerGroup().addTo(map);
  tripLayer = L.layerGroup().addTo(map);
  busLayer = L.layerGroup().addTo(map);
  stopLayer = L.layerGroup().addTo(map);
  const far = () => $('#mapbox').classList.toggle('far', map.getZoom() < 13);
  map.on('zoomend', far); far();
  map.on('moveend', drawDots);
  // Tapping a bus shows its route line and stops; they go away when its popup closes. A stop dot's popup keeps them up meanwhile.
  let selBus = null, dotOpen = false;
  map.on('popupopen', (e) => { const src = e.popup._source; if (src && src._route) { selBus = e.popup; drawRouteLines([src._route]).catch(() => {}); } else dotOpen = true; });
  map.on('popupclose', (e) => {
    const src = e.popup._source;
    if (src && src._route) { if (selBus === e.popup) selBus = null; } else dotOpen = false;
    setTimeout(() => { if (!selBus && !dotOpen) drawRouteLines([]).catch(() => {}); }); // next tick: switching buses opens the new popup first
  });
  // long-press (right-click on desktop) drops a pin: plan a trip from or to that spot
  map.on('contextmenu', (e) => {
    const box = document.createElement('div');
    box.className = 'pinpop';
    box.innerHTML = `<button data-k="from">${icon('map-pin')} Plan from here</button><button data-k="to">${icon('flag')} Plan to here</button>`;
    box.onclick = (ev) => { const k = ev.target.closest('button')?.dataset.k; if (k) { map.closePopup(); planFromMap(k, e.latlng); } };
    L.popup({ closeButton: false }).setLatLng(e.latlng).setContent(box).openOn(map);
  });
  $$('.mapbar .seg button').forEach((b) => (b.onclick = () => { mapMode = b.dataset.mode; store.set('mapMode', mapMode); $('#maproute').value = ''; fitNext = mapMode === 'pins'; syncSeg(); refreshMap(); }));
  let t;
  $('#maproute').oninput = () => { clearTimeout(t); t = setTimeout(() => { fitNext = true; syncSeg(); refreshMap(); }, 250); };
  $('#locate').onclick = async () => {
    try {
      const p = await here(), ll = [p.lat, p.lon];
      meMarker ||= L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me"></div>', iconSize: [16, 16] }) }).addTo(map);
      meMarker.setLatLng(ll); map.setView(ll, 15);
    } catch { toast('Location unavailable'); }
  };
  syncSeg();
}

// Set From/To to a map spot (named after a stop within 150 m, else "Dropped pin"), then plan like any other pick
async function planFromMap(key, ll) {
  let name = 'Dropped pin';
  try { const s = (await api(`/api/stops?lat=${ll.lat}&lon=${ll.lng}`))[0]; if (s && metres({ lat: ll.lat, lon: ll.lng }, s) <= 150) name = `${s.name} area`; } catch {}
  place[key] = { lat: ll.lat, lon: ll.lng }; $('#' + key).value = name;
  showTab('plan'); planTrip();
}

// A planned trip on the map: dashed walks between the origin, each ride's stops and the destination, each ride in its route colour.
// A ride is drawn through its stops (from /api/trip), or straight board -> alight if that can't be fetched.
async function showTripOnMap(i) {
  const o = trips[i], ends = planEnds;
  if (!o || !ends) return;
  showTab('map');
  const rides = o.legs.filter((l) => l.type === 'ride');
  const lines = await Promise.all(rides.map((l) => api('/api/trip/' + encodeURIComponent(l.trip))
    .then((t) => t.stops.slice(l.boardIdx, l.alight.idx + 1).filter((x) => x.lat != null).map((x) => [x.lat, x.lon])).catch(() => [])));
  try { await loadLeaflet(); initMap(); } catch { return; }
  clearTripMap(); map.invalidateSize();
  const pt = (x) => [x.lat, x.lon], dot = (ll, c, fill) => L.circleMarker(ll, { radius: 6, color: c, weight: 3, fillColor: fill, fillOpacity: 1 }).addTo(tripLayer);
  const walk = (a, b) => metres({ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] }) > 15 && L.polyline([a, b], { color: '#6b7280', weight: 4, dashArray: '2 8', lineCap: 'round' }).addTo(tripLayer);
  let at = pt(ends.from);
  rides.forEach((l, k) => {
    const c = '#' + (l.color || '444'), path = lines[k].length > 1 ? lines[k] : [pt(l.board), pt(l.alight)];
    walk(at, path[0]);
    L.polyline(path, { color: c, weight: 6, opacity: 0.9, lineJoin: 'round' }).bindPopup(`<b>Route ${esc(l.route)}</b><br>${esc(l.from)} ${icon('arrow-right')} ${esc(l.to)}`).addTo(tripLayer);
    dot(path[0], c, '#fff'); dot(path.at(-1), c, '#fff');
    at = path.at(-1);
  });
  walk(at, pt(ends.to));
  dot(pt(ends.from), '#0a7d3c', '#0a7d3c'); dot(pt(ends.to), '#dc2626', '#dc2626');
  map.fitBounds(tripLayer.getLayers().reduce((b, m) => b.extend(m.getBounds ? m.getBounds() : m.getLatLng()), L.latLngBounds([pt(ends.from)])).pad(0.2), { maxZoom: 16 });
  $('#tripbar').hidden = false;
}
function clearTripMap() { tripLayer?.clearLayers(); $('#tripbar').hidden = true; }
$('#tripclose').onclick = clearTripMap;

// Route line + stop dots for the bus you tapped. Geometry comes from /api/routemap and is cached per route.
const routeGeo = new Map(); // short -> {color, lines: [[lat, lon]...], stops: [[id, name, lat, lon]...]}
let geoKey = '', geoSeq = 0, geoStops = new Map();
async function drawRouteLines(shorts) {
  shorts = [...shorts].sort();
  const key = shorts.join(','), mine = ++geoSeq;
  if (key === geoKey) return;
  const need = shorts.filter((x) => !routeGeo.has(x));
  if (need.length) {
    const d = await api('/api/routemap?routes=' + need.map(encodeURIComponent).join(','));
    for (const x of need) routeGeo.set(x, d[x] || { lines: [], stops: [] });
  }
  if (mine !== geoSeq) return; // a newer selection superseded this one
  geoKey = key; lineLayer.clearLayers(); dotLayer.clearLayers(); dotMarks.clear(); geoStops = new Map();
  for (const x of shorts) {
    const g = routeGeo.get(x), c = '#' + (g.color || '444');
    for (const pts of g.lines) L.polyline(pts, { color: c, weight: shorts.length === 1 ? 5 : 3.5, opacity: shorts.length === 1 ? 0.85 : 0.55, lineJoin: 'round' }).addTo(lineLayer);
    for (const [id, name, lat, lon] of g.stops) if (!geoStops.has(id)) geoStops.set(id, { name, lat, lon, c });
  }
  drawDots();
}
// Stop dots: always for a few routes, otherwise only once zoomed in (they're too dense for the whole network). Only those in view are drawn,
// updated in place so a dot whose popup is open is never rebuilt (panning to show the popup would otherwise close it).
const dotMarks = new Map(); // stop id -> circleMarker
function drawDots() {
  const wanted = new Map();
  if (map.getZoom() >= 14 || geoKey.split(',').length <= 3) { const view = map.getBounds().pad(0.1); for (const [id, s] of geoStops) if (view.contains([s.lat, s.lon])) wanted.set(id, s); }
  for (const [id, m] of dotMarks) if (!wanted.has(id) && !m.isPopupOpen()) { dotLayer.removeLayer(m); dotMarks.delete(id); }
  const r = map.getZoom() >= 15 ? 5 : 3.5;
  for (const [id, s] of wanted) {
    const m = dotMarks.get(id);
    if (m) m.setRadius(r);
    else dotMarks.set(id, L.circleMarker([s.lat, s.lon], { radius: r, color: s.c, weight: 2, fillColor: '#fff', fillOpacity: 1 }).bindPopup(`<b>${esc(s.name)}</b><br>Stop ${esc(id)}`).addTo(dotLayer));
  }
}

async function refreshMap() {
  if (!map) return;
  let all;
  try { all = await api('/api/vehicles'); } catch { return; }
  const rq = $('#maproute').value.trim();
  const show = all.filter((b) => (rq ? num(b.route) === num(rq) : mapMode === 'pins' ? b.route && pinRoutes.has(b.route) : routeOn(b.route)));
  const seen = new Set();
  for (const b of show) {
    seen.add(b.id);
    const m = markers.get(b.id);
    if (m) { m._route = b.route; m.setLatLng([b.lat, b.lon]); m.setIcon(busIcon(b)); m.getPopup() ? m.setPopupContent(busPopup(b)) : m.bindPopup(busPopup(b)); }
    else { const mk = L.marker([b.lat, b.lon], { icon: busIcon(b) }).bindPopup(busPopup(b)).addTo(busLayer); mk._route = b.route; markers.set(b.id, mk); }
  }
  for (const [id, m] of markers) if (!seen.has(id)) { busLayer.removeLayer(m); markers.delete(id); }

  stopLayer.clearLayers();
  for (const p of pins) {
    if (!p.lat) { // pins saved before coordinates were stored get them filled in once
      const hit = (await api('/api/suggest?kinds=stop&q=' + encodeURIComponent(p.id)).catch(() => [])).find((x) => x.id === p.id);
      if (hit) { p.lat = hit.lat; p.lon = hit.lon; store.set('pins', pins); }
    }
    if (p.lat) L.marker([p.lat, p.lon], { icon: L.divIcon({ className: '', html: '<div class="stopdot"></div>', iconSize: [14, 14] }) }).bindPopup(esc(p.name)).addTo(stopLayer);
  }
  if (fitNext && show.length) { map.fitBounds(L.latLngBounds(show.map((b) => [b.lat, b.lon])).pad(0.25), { maxZoom: 15 }); fitNext = false; }
}

// ---------- alerts ----------
// Fetched with every refresh. The tab badge counts alerts on your routes you haven't opened the tab to see yet (synced, so
// reading them on one device clears the badge on the others). Each alert shows its headline; tap to read the whole notice.
let alertList = null, seenAlerts = new Set(store.get('seenAlerts', []));
const yours = (x) => x.routes.some((r) => pinRoutes.has(r));
const alertKey = (x) => `${x.start}|${x.header}`;
const filterBar = (extra = '') => `<div class="filterbar">${icon('sliders-horizontal')}<span>${shown ? `${shown.length} route${shown.length === 1 ? '' : 's'} shown${extra}` : 'Showing all routes'}</span><button data-editroutes>${shown ? 'Edit' : 'Customize'}</button></div>`;
async function loadAlerts() {
  try { alertList = await api('/api/alerts'); } catch {}
  const n = (alertList || []).filter((x) => yours(x) && x.routes.some(routeOn) && !seenAlerts.has(alertKey(x))).length;
  $('#alert-badge').textContent = n || '';
  $('[data-tab=alerts]').setAttribute('aria-label', n ? `Alerts, ${n} new on your routes` : 'Alerts');
}
async function refreshAlerts() {
  await loadAlerts();
  if (!alertList) return ($('#alerts').innerHTML = '<div class="empty">Alerts need a connection.</div>');
  const a = alertList.filter((x) => !x.routes.length || x.routes.some(routeOn)), hidden = alertList.length - a.length; // alerts with no route are system-wide: always shown
  a.sort((x, y) => yours(y) - yours(x)); // alerts for your pinned routes first, then newest
  const ra = `<div class="card"><div class="sg" role="switch" tabindex="0" aria-checked="${routeAlerts}" data-routealerts><span class="ico">${icon('bell')}</span><span class="t"><b>Notify me about new alerts on my routes</b><small>Pinned routes and the routes at your pinned stops</small></span><span class="switch ${routeAlerts ? 'on' : ''}"></span></div></div>`;
  $('#alerts').innerHTML = ra + filterBar(hidden ? ` · ${hidden} alert${hidden === 1 ? '' : 's'} hidden` : '') + (a.length ? a.map((x) => `<div class="card alert" role="button" tabindex="0" aria-expanded="false">
    <h2><span class="name" style="white-space:normal">${esc(x.header || 'Alert')}</span>${seenAlerts.has(alertKey(x)) ? '' : '<span class="chip new">New</span>'}${yours(x) ? '<span class="chip">Your route</span>' : ''}</h2>
    <div class="sched">Since ${new Date(x.start * 1000).toLocaleDateString()}${x.routes.length ? ' · Routes ' + esc([...new Set(x.routes)].join(', ')) : ''}</div>
    <p class="peek">${esc((x.description || '').replace(/\s+/g, ' '))}</p><p class="desc">${esc(x.description).replace(/\r?\n/g, '<br>')}</p><span class="readmore">${icon('chevron-down')}</span></div>`).join('') : `<div class="empty">No active alerts${hidden ? ' for your routes' : ''}.</div>`);
  seenAlerts = new Set(alertList.map(alertKey)); // everything listed now counts as seen (and old keys drop off)
  store.set('seenAlerts', [...seenAlerts]);
  loadAlerts();
}
$('#alerts').onclick = (e) => {
  if (e.target.closest('[data-editroutes]')) return openRoutesSheet();
  if (e.target.closest('[data-routealerts]')) return toggleRouteAlerts();
  const c = e.target.closest('.alert');
  if (c) c.setAttribute('aria-expanded', c.classList.toggle('open'));
};

async function toggleRouteAlerts() {
  routeAlerts = !routeAlerts;
  if (!(await syncRouteAlerts(routeAlerts)) && routeAlerts) { routeAlerts = false; return refreshAlerts(); } // no permission / no subscription: stay off
  store.set('routeAlerts', routeAlerts); refreshAlerts();
  toast(routeAlerts ? 'You will be notified of new alerts on your routes' : 'Alert notifications off');
}

// ---------- live data status ----------
// The server says how old its realtime feeds are; if trip updates or vehicles are over ~2 min old the times shown are the schedule.
// (When the app itself is offline the header already says Offline, so no second message.)
let liveDown = false;
function showLiveBar() { $('#livebar').hidden = !liveDown || offline || $('#alerts').hidden === false; }
async function checkLive() {
  try { const s = await api('/api/status'); liveDown = [s.tripUpdates, s.vehicles].some((a) => a === null || a > 120); } catch { liveDown = false; }
  showLiveBar();
}

// ---------- refreshing ----------
const refreshAll = () => Promise.all([refreshPins().then(loadAlerts).then(checkLive), refreshNearby(), map && !$('#map').hidden && refreshMap()]);
// Another device changed a synced setting: re-read them in place (no reload, so the tab, open sheets and the map stay put)
function applySynced() {
  pins = store.get('pins', []); routePins = store.get('routePins', []); saved = store.get('saved', {}); commutes = store.get('commutes', []);
  accessible = store.get('accessible', false); showAccessible(); shown = store.get('shownRoutes', null); stopAlerts = store.get('stopAlerts', {}); stopSort = store.get('stopSort', 'mine');
  seenAlerts = new Set(store.get('seenAlerts', [])); loadAlerts(); routeAlerts = store.get('routeAlerts', false); syncRouteAlerts();
  renderPlaces(); renderCommutes(); syncCommutes(); applyRouteFilter();
}
$('#updated').onclick = () => { $('#updated').textContent = 'Refreshing…'; refreshAll(); };
// Pull down at the top of Pinned to refresh
(() => {
  const ptr = $('#ptr'), PULL = 110;
  let y0 = null, dy = 0;
  addEventListener('touchstart', (e) => {
    const ok = !$('#pinned').hidden && scrollY <= 0 && !document.body.matches('.noscroll, .typing');
    y0 = ok ? e.touches[0].clientY : null; dy = 0;
  }, { passive: true });
  addEventListener('touchmove', (e) => {
    if (y0 == null) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    ptr.style.height = Math.min(dy * 0.5, 64) + 'px'; ptr.classList.toggle('ready', dy > PULL);
  }, { passive: true });
  addEventListener('touchend', async () => {
    if (y0 == null) return;
    y0 = null;
    if (dy > PULL) { ptr.classList.add('spin'); await refreshAll(); }
    ptr.classList.remove('spin', 'ready'); ptr.style.height = '';
  });
})();
// Rows that act as buttons (role=button / switch) work from the keyboard too
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[role=button], [role=switch]')) { e.preventDefault(); e.target.click(); }
});

if (pins.length || routePins.length) $('#pins').innerHTML = skeleton(Math.min(4, pins.length + routePins.length)); // until the first fetch lands
const startTab = location.hash.slice(1);
if (TABS.includes(startTab) && startTab !== 'pinned') showTab(startTab);
refreshPins().then(loadAlerts).then(checkLive); refreshNearby();
setInterval(refreshAll, 20000);
syncNow(); setInterval(syncNow, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { syncNow(); refreshAll(); } });
