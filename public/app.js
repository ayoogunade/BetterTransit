const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const api = (p) => fetch(p).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
const post = (p, body) => fetch(p, { method: 'POST', body: JSON.stringify(body) });
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
const toast = (msg) => { $('#updated').textContent = msg; setTimeout(refreshPins, 4000); };
const within = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('timeout')), ms))]);
const here = () => new Promise((ok, no) => navigator.geolocation.getCurrentPosition((p) => ok({ lat: p.coords.latitude, lon: p.coords.longitude }), no, { enableHighAccuracy: true, timeout: 10000 }));

let pins = store.get('pins', []);            // stops: {id, name, lat, lon}. Shown everywhere, regardless of location
let routePins = store.get('routePins', []);  // routes: {short, long, color}
let watching = new Set(store.get('watching', []));
let pinRoutes = new Set();                   // routes serving pinned stops, plus pinned routes

// ---------- tabs ----------
function showTab(t) {
  $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  ['pinned', 'plan', 'map', 'alerts'].forEach((x) => ($('#' + x).hidden = x !== t));
  if (t === 'map') { initMap(); map.invalidateSize(); refreshMap(); }
  if (t === 'alerts') refreshAlerts();
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
    box.innerHTML = list.map((it, i) => `<div class="sg" data-i="${i}"><span class="ico">${KIND_ICON[it.kind]()}</span><span class="t"><b>${esc(titleOf(it))}</b><small>${esc(subOf(it))}</small></span>${onPick.pinsOnly ? `<span class="add">${icon('plus')}</span>` : ''}</div>`).join('');
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

// Full-screen list of every stop on a route (one tab per direction, with a filter box). One scroll area only, so it scrolls
// reliably on iOS. multi: stays open so you can pin several stops (onStop toggles); otherwise picking a stop closes it.
function sheetShell(html) {
  const el = document.createElement('div');
  el.className = 'sheet';
  el.innerHTML = html;
  document.body.append(el);
  document.body.classList.add('noscroll');
  const close = () => { el.remove(); document.body.classList.remove('noscroll'); };
  return { el, close };
}
async function openStopSheet(route, { multi = false, isPinned = () => false, onStop }) {
  const { el, close } = sheetShell('<div class="sheet-bar"><b></b><button data-close class="done">Done</button></div><div class="empty" style="padding:16px">Loading stops…</div>');
  el.querySelector('b').textContent = `Route ${route.short}`;
  let dirs, sel = 0, q = '';
  try { dirs = await api(`/api/route/${encodeURIComponent(route.short)}/stops`); }
  catch { el.querySelector('.empty').textContent = 'Could not load stops. Check your connection.'; el.onclick = (e) => e.target.closest('[data-close]') && close(); return; }
  // a stop may only exist in the other direction: say so, and let one tap switch there
  const otherMatches = () => '<div class="empty" style="padding:16px">No stops match in this direction.</div>' + dirs
    .map((d, k) => [k, d, d.stops.filter((st) => st.name.toLowerCase().includes(q)).length]).filter(([k, , n]) => k !== sel && n)
    .map(([k, d, n]) => `<div class="sg" data-d="${k}"><span class="t"><b>${n} match${n > 1 ? 'es' : ''} going ${icon('arrow-right')} ${esc(d.headsign)}</b><small>Tap to view</small></span></div>`).join('');
  const rows = () => dirs[sel].stops.map((st, i) => ({ st, i })).filter(({ st }) => !q || st.name.toLowerCase().includes(q))
    .map(({ st, i }) => `<div class="sg" data-s="${i}"><span class="ico">${icon('signpost')}</span><span class="t"><b>${esc(st.name)}</b><small>${esc(st.sub)}</small></span><span class="mark ${multi && isPinned(st) ? 'on' : ''}">${multi ? icon(isPinned(st) ? 'check' : 'plus') : ''}</span></div>`).join('')
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
  const { el, close } = sheetShell('<div class="sheet-bar"><b>Routes to show</b><button data-close class="done">Done</button></div><div class="empty" style="padding:16px">Loading routes…</div>');
  const done = () => { close(); applyRouteFilter(); };
  try { allRoutes ||= await api('/api/routes'); }
  catch { el.querySelector('.empty').textContent = 'Could not load routes. Check your connection.'; el.onclick = (e) => e.target.closest('[data-close]') && done(); return; }
  const sel = new Set(shown || allRoutes.map((r) => r.short));
  let q = '';
  const save = () => { shown = sel.size === allRoutes.length ? null : [...sel]; store.set('shownRoutes', shown); };
  const rows = () => allRoutes.filter((r) => !q || `${r.short} ${r.long}`.toLowerCase().includes(q))
    .map((r) => `<div class="sg ${sel.has(r.short) ? '' : 'off'}" data-r="${esc(r.short)}">${badge(r.short, r.color)}<span class="t"><b>${esc(r.long)}</b></span><span class="mark ${sel.has(r.short) ? 'on' : ''}">${sel.has(r.short) ? icon('check') : ''}</span></div>`).join('')
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
    if (e.target.closest('[data-close]')) return done();
    const act = e.target.closest('[data-act]');
    if (act) {
      sel.clear();
      (act.dataset.act === 'all' ? allRoutes.map((r) => r.short) : act.dataset.act === 'pinned' ? routePins.map((r) => r.short) : []).forEach((x) => sel.add(x));
      return redraw();
    }
    const row = e.target.closest('[data-r]'); if (!row) return;
    const k = row.dataset.r, on = !sel.has(k);
    on ? sel.add(k) : sel.delete(k); save();
    row.classList.toggle('off', !on); // update just this row so the scroll position stays put
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
function stopCard(p, list, nearby = false) {
  list = list.filter((a) => routeOn(a.route));
  const items = list.slice(0, nearby ? 4 : 6).map((a, i) => `
    <div class="row ${i ? '' : 'first'}" data-open="${esc(a.trip)}" data-stop="${esc(p.id)}">
      <button class="bell ${watching.has(watchKey(p.id, a.trip)) ? 'on' : ''}" data-stop="${esc(p.id)}" data-name="${esc(p.name)}" data-trip="${esc(a.trip)}" data-route="${esc(a.route)}" data-hs="${esc(a.headsign)}" aria-label="Alert me">${icon('bell')}</button>
      ${badge(a.route, a.color)}
      <span class="hs">${esc(a.headsign)}</span>
      <span class="eta ${etaText(a.time) === 'Due' || (a.time - Date.now() / 1000) < 180 ? 'soon' : ''}">${etaText(a.time)}<span class="sched">${clock(a.time)}${a.live ? '' : ` · ${icon('clock')} sched.`}</span></span>
    </div>`);
  // pinned stops show only the next bus; the rest sit behind a chevron
  const rows = !items.length ? `<div class="empty">No upcoming buses${shown ? ' on your routes' : ''}</div>`
    : nearby || items.length === 1 ? items.join('')
    : items[0] + `<div class="more">${items.slice(1).join('')}</div><button class="morebtn" data-more="${esc(p.id)}">${icon('chevron-down')} <span>${items.length - 1} more</span></button>`;
  const mins = stopAlerts[p.id];
  const act = nearby
    ? `<small class="dist">${p.dist} m</small><button data-pin="${esc(p.id)}" data-name="${esc(p.name)}" data-lat="${p.lat}" data-lon="${p.lon}" class="${isStopPinned(p) ? 'on' : ''}" aria-label="${isStopPinned(p) ? 'Unpin' : 'Pin'} stop">${icon('pin')}</button>`
    : `${mins ? `<select class="amins" data-amins="${esc(p.id)}" aria-label="Minutes before a bus">${ALERT_MINS.map((n) => `<option ${n === mins ? 'selected' : ''}>${n}</option>`).join('')}</select><small class="dist">min</small>` : ''}<button class="stopbell ${mins ? 'on' : ''}" data-stopalert="${esc(p.id)}" aria-label="${mins ? 'Stop alerts for' : 'Alert me about every bus at'} ${esc(p.name)}">${icon('bell')}</button><button data-unpin="${esc(p.id)}" aria-label="Unpin">${icon('x')}</button>`;
  return `<div class="card ${openStops.has(p.id) ? 'open' : ''}"><h2><span class="name">${esc(p.name)}</span>${act}</h2>${rows}</div>`;
}

function routeCard(r, buses) {
  const mine = buses.filter((b) => b.route === r.short);
  const groups = new Map();
  for (const b of mine) (groups.get(b.headsign) || groups.set(b.headsign, []).get(b.headsign)).push(b);
  const body = groups.size ? [...groups].map(([hs, list]) => `<div class="dirhead">${icon('arrow-right')} ${esc(hs)}</div>` + list
    .sort((a, b) => (a.next ? a.next.time : Infinity) - (b.next ? b.next.time : Infinity)).slice(0, 5).map((b, i) => `
    <div class="row ${i ? '' : 'first'}" data-open="${esc(b.trip)}">
      <span class="dirarrow" style="transform:rotate(${b.bearing == null ? 0 : b.bearing}deg)">${icon('navigation-2')}</span>
      <span class="fleet">#${esc(b.label)}</span>
      <span class="hs">${b.next ? 'Next: ' + esc(b.next.stop) : 'In service'}</span>
      <span class="eta">${b.next ? etaText(b.next.time) : ''}${b.age == null ? '' : `<span class="sched" title="Position updated ${ageText(b.age)} ago">${icon('radio')} ${ageText(b.age)}</span>`}</span>
    </div>`).join('')).join('') : '<div class="empty">No buses in service right now</div>';
  return `<div class="card"><h2>${badge(r.short, r.color)}<span class="name">${esc(r.long)}</span>
    <button data-maproute="${esc(r.short)}" aria-label="Show on map">${icon('map')}</button><button data-unroute="${esc(r.short)}" aria-label="Unpin">${icon('x')}</button></h2>
    ${body}<div class="btnrow"><button class="btn" data-addstop="${esc(r.short)}">${icon('plus')} Pin stops on this route</button></div></div>`;
}

async function refreshPins() {
  try {
    const [lists, buses] = await Promise.all([
      Promise.all(pins.map((p) => api('/api/arrivals/' + encodeURIComponent(p.id)))),
      routePins.length ? api('/api/vehicles?routes=' + routePins.map((r) => encodeURIComponent(r.short)).join(',')) : [],
    ]);
    pinRoutes = new Set([...lists.flat().map((a) => a.route), ...routePins.map((r) => r.short)]);
    $('#pins').innerHTML = (routePins.length ? '<div class="section-title">Routes</div>' + routePins.map((r) => routeCard(r, buses)).join('') : '')
      + (pins.length ? '<div class="section-title">Stops</div>' + pins.map((p, i) => stopCard(p, lists[i])).join('') : '')
      || '<div class="empty" style="padding:24px 4px">Search a route (like <b>60</b>) or a stop, then tap to pin it ' + icon('pin') + '</div>';
    $('#updated').textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch { $('#updated').textContent = 'Offline: showing last data'; }
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
  try {
    const me = await here();
    nearbyData = shown && !shown.length ? [] : await api(`/api/nearby?lat=${me.lat}&lon=${me.lon}${shown ? '&routes=' + shown.map(encodeURIComponent).join(',') : ''}`);
  }
  catch { if (ask) toast('Location unavailable'); }
  renderNearby();
}

// Push subscription for this device. create: ask permission and subscribe if there isn't one yet. Returns null (with a toast) if unavailable.
async function getSub(create) {
  if (!('serviceWorker' in navigator && 'PushManager' in window)) { toast('Notifications need HTTPS or localhost'); return null; }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub || !create) return sub;
  if ((await within(Notification.requestPermission(), 15000)) !== 'granted') { toast('Notifications blocked'); return null; }
  const b64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  return within(reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64((await api('/api/push/key')).key) }), 10000);
}
const pushFail = (err) => toast(err.message === 'timeout' ? 'Notifications unavailable here' : 'Could not set notification');

// One bus: alert N min before it arrives (N is the stop's alert minutes, else 5)
async function toggleWatch(btn) {
  const w = { stopId: btn.dataset.stop, stopName: btn.dataset.name, tripId: btn.dataset.trip, route: btn.dataset.route, headsign: btn.dataset.hs, minutes: stopAlerts[btn.dataset.stop] || 5 };
  const k = watchKey(w.stopId, w.tripId);
  try {
    const sub = await getSub(!watching.has(k));
    if (!sub) return;
    if (watching.has(k)) { await post('/api/push/unwatch', { sub, stopId: w.stopId, tripId: w.tripId }); watching.delete(k); }
    else { await post('/api/push/watch', { ...w, sub }); watching.add(k); toast(`Will notify at ${w.minutes} min`); }
    store.set('watching', [...watching]);
    btn.classList.toggle('on', watching.has(k));
  } catch (err) { pushFail(err); }
}

// Every bus at a pinned stop (only the routes you chose in Routes to show): alert N min before each one until turned off
let stopAlerts = store.get('stopAlerts', {}); // stopId -> minutes
const stopWatch = (id) => ({ stopId: id, stopName: (pins.find((p) => p.id === id) || {}).name, standing: true, minutes: stopAlerts[id], routes: shown });
async function toggleStopAlert(id) {
  try {
    const on = id in stopAlerts, sub = await getSub(!on);
    if (!sub) return;
    if (on) { await post('/api/push/unwatch', { sub, stopId: id }); delete stopAlerts[id]; }
    else { stopAlerts[id] = 5; await post('/api/push/watch', { ...stopWatch(id), sub }); toast(`Alerts on: 5 min before every bus`); }
    store.set('stopAlerts', stopAlerts); refreshPins();
  } catch (err) { pushFail(err); }
}
async function syncStopAlerts(ids = Object.keys(stopAlerts)) { // push the current minutes / route filter to the server
  if (!ids.length) return;
  try { const sub = await getSub(false); if (sub) for (const id of ids) await post('/api/push/watch', { ...stopWatch(id), sub }); } catch {}
}

$('#pins').onclick = $('#nearby').onclick = (e) => {
  const t = e.target.closest('button');
  if (!t) { const row = e.target.closest('[data-open]'); return row && openTripSheet(row.dataset.open, row.dataset.stop); }
  if (t.classList.contains('bell')) return toggleWatch(t);
  if (t.dataset.stopalert) return toggleStopAlert(t.dataset.stopalert);
  if (t.dataset.more) { const open = t.closest('.card').classList.toggle('open'); return open ? openStops.add(t.dataset.more) : openStops.delete(t.dataset.more); }
  if (t.dataset.locate !== undefined) return refreshNearby(true);
  if (t.dataset.pin) { toggleStopPin({ id: t.dataset.pin, name: t.dataset.name, lat: +t.dataset.lat, lon: +t.dataset.lon }); return renderNearby(); }
  if (t.dataset.unpin) { if (t.dataset.unpin in stopAlerts) toggleStopAlert(t.dataset.unpin); pins = pins.filter((p) => p.id !== t.dataset.unpin); store.set('pins', pins); return refreshPins(); }
  if (t.dataset.unroute) { routePins = routePins.filter((r) => r.short !== t.dataset.unroute); store.set('routePins', routePins); return refreshPins(); }
  if (t.dataset.maproute) { showTab('map'); $('#maproute').value = t.dataset.maproute; fitNext = true; syncSeg(); return refreshMap(); }
  if (t.dataset.addstop) {
    const r = routePins.find((x) => x.short === t.dataset.addstop);
    openStopSheet(r, { multi: true, isPinned: isStopPinned, onStop: toggleStopPin });
  }
};

$('#pins').onchange = (e) => { const id = e.target.dataset.amins; if (!id) return; stopAlerts[id] = +e.target.value; store.set('stopAlerts', stopAlerts); syncStopAlerts([id]); };

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
const setLeave = (later) => { // "Leave now" vs a chosen time; the picker only appears for the latter, so it's never a blank box
  $('#now').classList.toggle('on', !later); $('#later').classList.toggle('on', later); $('#when').hidden = !later;
  if (later && !$('#when').value) { // default to the next half hour, in local time
    const d = new Date(Math.ceil((Date.now() + 60000) / 1800000) * 1800000);
    $('#when').value = new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }
  if (!later) $('#when').value = '';
  planTrip();
};
$('#now').onclick = () => setLeave(false);
$('#later').onclick = () => setLeave(true);

async function planTrip() {
  if (!place.from || !place.to) return;
  $('#trip').innerHTML = '<div class="empty">Planning…</div>';
  const depart = $('#when').value ? Math.floor(new Date($('#when').value).getTime() / 1000) : 0;
  let r;
  try { r = await api(`/api/plan?from=${place.from.lat},${place.from.lon}&to=${place.to.lat},${place.to.lon}&depart=${depart}`); }
  catch { return ($('#trip').innerHTML = '<div class="empty">Planning needs a connection.</div>'); }
  if (!r || !r.length) return ($('#trip').innerHTML = '<div class="empty">No route found. Try a different time or place.</div>');
  $('#trip').innerHTML = r.map((o, i) => tripCard(o, i === 0)).join('');
}
$('#trip').onclick = (e) => { const c = e.target.closest('.trip-opt'); if (c) c.classList.toggle('open'); }; // tap an option to expand/collapse its steps

// One itinerary: leave -> arrive, route badges, and a timeline (clock time + stop at each boarding/alighting, a coloured rail per ride)
function tripCard(r, open) {
  const rides = r.legs.filter((l) => l.type === 'ride');
  const walk = r.legs.filter((l) => l.type === 'walk').reduce((n, l) => n + l.mins, 0) + (r.finalWalkMins || 0);
  const stopRow = (t, name) => `<div class="tr"><time>${clock(t)}</time><i class="dot"></i><b>${esc(name)}</b></div>`;
  const legs = r.legs.map((l) => l.type === 'walk'
    ? `<div class="tw">${icon('footprints')} ${l.mins} min</div>`
    : `<div class="ride" style="--c:#${esc(l.color || '444')}">${stopRow(l.dep, l.from)}
        <div class="tb">${badge(l.route, l.color)}<span class="hs">${esc(l.headsign)}</span>${l.live ? `<span class="live"><i></i>live</span>` : ''}<small>${Math.round((l.arr - l.dep) / 60)} min · ${l.stops} ${icon('signpost')}</small></div>
        ${stopRow(l.arr, l.to)}</div>`).join('');
  return `<div class="card trip-opt ${open ? 'open' : ''}"><div class="summary"><span>${icon('clock')} ${clock(r.leave)}</span><span class="to">${icon('arrow-right')}</span><span>${icon('flag')} ${clock(r.arrive)}</span><span class="chev">${icon('chevron-down')}</span></div>
    <div class="meta"><span>${icon('timer')} ${Math.round((r.arrive - r.leave) / 60)} min</span>${rides.length > 1 ? `<span>${icon('repeat')} ${rides.length - 1}</span>` : ''}<span>${icon('footprints')} ${walk} min</span><span class="rb">${rides.map((l) => badge(l.route, l.color)).join('')}</span></div>
    <div class="legs">${legs}${r.finalWalkMins ? `<div class="tw">${icon('footprints')} ${r.finalWalkMins} min</div>` : ''}</div></div>`;
}

// ---------- map ----------
let map, busLayer, stopLayer, meMarker, fitNext = false;
let mapMode = store.get('mapMode', 'all');
const markers = new Map(); // vehicle id -> marker, updated in place so buses glide instead of flickering

const busIcon = (b) => L.divIcon({
  className: '', iconSize: [52, 52], iconAnchor: [26, 26],
  html: `<div class="bus" style="--c:#${esc(b.color || '444')}">${b.bearing == null ? '' : `<div class="arrow" style="transform:rotate(${b.bearing}deg)"></div>`}<div class="dot"><small>${esc(b.label)}</small><b>${esc(b.route || '?')}</b></div></div>`,
});
const busPopup = (b) => `<b>Route ${esc(b.route)} ${icon('arrow-right')} ${esc(b.headsign)}</b><br>Bus #${esc(b.label)}${b.next ? `<br>Next: ${esc(b.next.stop)} · ${etaText(b.next.time)}` : ''}${b.age == null ? '' : `<br>Updated ${ageText(b.age)} ago`}`;

function syncSeg() {
  $('.seg [data-mode=all]').textContent = shown ? 'My routes' : 'All';
  $$('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mapMode && !$('#maproute').value)); }
function initMap() {
  if (map) return;
  map = L.map('mapbox').setView([52.13, -106.65], 12);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(map);
  busLayer = L.layerGroup().addTo(map);
  stopLayer = L.layerGroup().addTo(map);
  const far = () => $('#mapbox').classList.toggle('far', map.getZoom() < 13);
  map.on('zoomend', far); far();
  $$('.seg button').forEach((b) => (b.onclick = () => { mapMode = b.dataset.mode; store.set('mapMode', mapMode); $('#maproute').value = ''; fitNext = mapMode === 'pins'; syncSeg(); refreshMap(); }));
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
    if (m) { m.setLatLng([b.lat, b.lon]); m.setIcon(busIcon(b)); m.getPopup() ? m.setPopupContent(busPopup(b)) : m.bindPopup(busPopup(b)); }
    else markers.set(b.id, L.marker([b.lat, b.lon], { icon: busIcon(b) }).bindPopup(busPopup(b)).addTo(busLayer));
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
async function refreshAlerts() {
  let a;
  try { a = await api('/api/alerts'); } catch { return ($('#alerts').innerHTML = '<div class="empty">Alerts need a connection.</div>'); }
  const vis = a.filter((x) => !x.routes.length || x.routes.some(routeOn)), hidden = a.length - vis.length; // alerts with no route are system-wide: always shown
  a = vis;
  const bar = `<div class="filterbar">${icon('sliders-horizontal')}<span>${shown ? `${shown.length} route${shown.length === 1 ? '' : 's'} shown${hidden ? ` · ${hidden} alert${hidden === 1 ? '' : 's'} hidden` : ''}` : 'Showing all routes'}</span><button data-editroutes>${shown ? 'Edit' : 'Customize'}</button></div>`;
  const yours = (x) => x.routes.some((r) => pinRoutes.has(r));
  a.sort((x, y) => yours(y) - yours(x)); // alerts for your pinned routes first, then newest
  $('#alerts').innerHTML = bar + (a.length ? a.map((x) => `<div class="card"><h2><span class="name" style="white-space:normal">${esc(x.header || 'Alert')}</span>${yours(x) ? '<span class="chip">Your route</span>' : ''}</h2>
    <div class="sched">Since ${new Date(x.start * 1000).toLocaleDateString()}${x.routes.length ? ' · Routes ' + esc([...new Set(x.routes)].join(', ')) : ''}</div>
    <p>${esc(x.description).replace(/\r?\n/g, '<br>')}</p></div>`).join('') : `<div class="empty">No active alerts${hidden ? ' for your routes' : ''}.</div>`);
}
$('#alerts').onclick = (e) => e.target.closest('[data-editroutes]') && openRoutesSheet();

refreshPins(); refreshNearby();
setInterval(() => { refreshPins(); refreshNearby(); if (map && !$('#map').hidden) refreshMap(); }, 20000);
