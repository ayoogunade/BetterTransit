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
const clock = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const etaText = (t) => { const m = Math.round((t - Date.now() / 1000) / 60); return m <= 0 ? 'Due' : m + ' min'; };
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
  window.scrollTo(0, 0);
}
$$('.tabs button').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));

// ---------- search box (shared by Pinned and Plan) ----------
const ICON = { route: '🚌', stop: '🚏', dest: '🏁', place: '📍', here: '🎯', recent: '🕘' };
const titleOf = (it) => (it.kind === 'route' ? `Route ${it.short}` : it.kind === 'here' ? 'Use my location' : it.name);
const subOf = (it) => (it.kind === 'route' ? it.long : it.sub);

// Typing shows matching routes, stops, bus destinations and (optionally) addresses/places.
// onPick(item, ctx): ctx.close(), ctx.coords(item) -> item with lat/lon, ctx.drill(route, onStop) -> browse a route's stops
function searchBox({ input, box, kinds, empty, onPick }) {
  let items = [], seq = 0, timer, drilling = false;
  let session = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()); // groups keystrokes for Google billing
  const render = (list) => {
    items = list;
    box.innerHTML = list.map((it, i) => `<div class="sg" data-i="${i}"><span class="ico">${ICON[it.kind]}</span><span class="t"><b>${esc(titleOf(it))}</b><small>${esc(subOf(it))}</small></span>${onPick.pinsOnly ? '<span class="add">＋</span>' : ''}</div>`).join('');
  };
  const localKinds = kinds.split(',').filter((k) => k !== 'place').join(','), wantPlaces = kinds.includes('place');
  const get = (k, q) => api(`/api/suggest?q=${encodeURIComponent(q)}&kinds=${k}&session=${session}`);
  // Routes/stops/destinations are instant, so show them first; addresses (a network call to Google) are appended when they arrive.
  const run = async () => {
    drilling = false;
    const q = input.value.trim(), id = ++seq;
    if (!q) return render(empty ? empty() : []);
    let local = [];
    try {
      if (localKinds) local = await get(localKinds, q);
      if (id !== seq) return; // a newer keystroke superseded this one
      if (local.length) render(local);
      else if (wantPlaces && q.length >= 3) box.innerHTML = '<div class="empty" style="padding:12px">Searching…</div>';
      if (wantPlaces && q.length >= 3) {
        const places = await get('place', q).catch(() => []);
        if (id !== seq) return;
        local = [...local, ...places];
      }
    } catch { if (id === seq) box.innerHTML = '<div class="empty" style="padding:12px">Search needs a connection</div>'; return; }
    if (id !== seq) return;
    local.length ? render(local) : (box.innerHTML = '<div class="empty" style="padding:12px">No matches</div>');
  };
  const close = () => { seq++; drilling = false; box.innerHTML = ''; };
  const ctx = {
    close,
    coords: async (it) => (it.lat != null || !it.placeId ? it : { ...it, ...(await api(`/api/place?id=${encodeURIComponent(it.placeId)}&session=${session}`)) }),
    drill: (route, onStop) => { drilling = true; drawRouteStops(box, route, onStop, run); },
  };
  const pick = async (it) => {
    await onPick(it, ctx);
    if (it.kind === 'place') session = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()); // session ends once a place is chosen
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 180); });
  input.addEventListener('focus', run);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && items[0] && !drilling) { e.preventDefault(); pick(items[0]); } });
  box.addEventListener('click', (e) => { const el = !drilling && e.target.closest('[data-i]'); if (el) pick(items[+el.dataset.i]); });
  document.addEventListener('click', (e) => { if (!input.parentElement.contains(e.target)) close(); });
  return ctx;
}

// A route's stops, one tab per direction; used when you pick a bus line as a place or want to pin a stop on it
async function drawRouteStops(el, route, onStop, onBack) {
  el.innerHTML = '<div class="empty" style="padding:12px">Loading stops…</div>';
  let dirs, sel = 0;
  try { dirs = await api(`/api/route/${encodeURIComponent(route.short)}/stops`); }
  catch { el.innerHTML = '<div class="empty" style="padding:12px">Could not load stops</div>'; return; }
  const draw = () => {
    el.innerHTML = `<div class="sg-head"><span>Route ${esc(route.short)}: choose a stop</span><button data-back>‹ Back</button></div>
      <div class="dirs">${dirs.map((d, i) => `<button data-d="${i}" class="${i === sel ? 'on' : ''}">→ ${esc(d.headsign)}</button>`).join('')}</div>
      <div class="rs-list">${dirs[sel].stops.map((s, i) => `<div class="sg" data-s="${i}"><span class="ico">🚏</span><span class="t"><b>${esc(s.name)}</b><small>${esc(s.sub)}</small></span></div>`).join('')}</div>`;
  };
  draw();
  el.onclick = (e) => {
    if (e.target.closest('[data-back]')) { el.onclick = null; return onBack(); }
    const d = e.target.closest('[data-d]');
    if (d) { sel = +d.dataset.d; return draw(); }
    const s = e.target.closest('[data-s]');
    if (s) { el.onclick = null; onStop(dirs[sel].stops[+s.dataset.s]); }
  };
}

// ---------- pinned ----------
const addStopPin = (s) => {
  if (!pins.some((p) => p.id === s.id)) pins.push({ id: s.id, name: s.name, lat: s.lat, lon: s.lon });
  store.set('pins', pins); $('#pin-search').value = ''; refreshPins();
};
const addRoutePin = (r) => {
  if (!routePins.some((p) => p.short === r.short)) routePins.push({ short: r.short, long: r.long, color: r.color });
  store.set('routePins', routePins); $('#pin-search').value = ''; refreshPins();
};
const pinSearch = searchBox({
  input: $('#pin-search'), box: $('#pin-suggest'), kinds: 'route,stop',
  onPick: Object.assign((it, ctx) => { it.kind === 'route' ? addRoutePin(it) : addStopPin(it); ctx.close(); }, { pinsOnly: true }),
});

const watchKey = (stop, trip) => stop + '|' + trip;
function stopCard(p, list) {
  const rows = list.length ? list.slice(0, 6).map((a, i) => `
    <div class="row ${i ? '' : 'first'}">
      <button class="bell ${watching.has(watchKey(p.id, a.trip)) ? 'on' : ''}" data-stop="${esc(p.id)}" data-name="${esc(p.name)}" data-trip="${esc(a.trip)}" data-route="${esc(a.route)}" data-hs="${esc(a.headsign)}">🔔</button>
      ${badge(a.route, a.color)}
      <span class="hs">${esc(a.headsign)}</span>
      <span class="eta ${etaText(a.time) === 'Due' || (a.time - Date.now() / 1000) < 180 ? 'soon' : ''}">${etaText(a.time)}${a.live ? '' : '<span class="sched">scheduled</span>'}</span>
    </div>`).join('') : '<div class="empty">No upcoming buses</div>';
  return `<div class="card"><h2><span class="name">${esc(p.name)}</span><button data-unpin="${esc(p.id)}" aria-label="Unpin">✕</button></h2>${rows}</div>`;
}

function routeCard(r, buses) {
  const mine = buses.filter((b) => b.route === r.short);
  const groups = new Map();
  for (const b of mine) (groups.get(b.headsign) || groups.set(b.headsign, []).get(b.headsign)).push(b);
  const body = groups.size ? [...groups].map(([hs, list]) => `<div class="dirhead">→ ${esc(hs)}</div>` + list
    .sort((a, b) => (a.next ? a.next.time : Infinity) - (b.next ? b.next.time : Infinity)).slice(0, 5).map((b, i) => `
    <div class="row ${i ? '' : 'first'}">
      <span class="dirarrow" style="transform:rotate(${b.bearing == null ? 0 : b.bearing - 90}deg)">➤</span>
      <span class="fleet">#${esc(b.label)}</span>
      <span class="hs">${b.next ? 'Next: ' + esc(b.next.stop) : 'In service'}</span>
      <span class="eta">${b.next ? etaText(b.next.time) : ''}</span>
    </div>`).join('')).join('') : '<div class="empty">No buses in service right now</div>';
  return `<div class="card"><h2>${badge(r.short, r.color)}<span class="name">${esc(r.long)}</span>
    <button data-maproute="${esc(r.short)}" aria-label="Show on map">🗺️</button><button data-unroute="${esc(r.short)}" aria-label="Unpin">✕</button></h2>
    ${body}<div class="btnrow"><button class="btn" data-addstop="${esc(r.short)}">＋ Pin a stop on this route</button></div></div>`;
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
      || '<div class="empty" style="padding:24px 4px">Search above for a route (like <b>60</b>) or a stop, then tap it to pin it here. Pins show up wherever you are.</div>';
    $('#updated').textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch { $('#updated').textContent = 'Offline: showing last data'; }
}

async function toggleWatch(btn) {
  const w = { stopId: btn.dataset.stop, stopName: btn.dataset.name, tripId: btn.dataset.trip, route: btn.dataset.route, headsign: btn.dataset.hs, minutes: +$('#mins').value };
  const k = watchKey(w.stopId, w.tripId);
  try {
    if (!('serviceWorker' in navigator && 'PushManager' in window)) return toast('Notifications need HTTPS or localhost');
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (watching.has(k)) {
      if (sub) await post('/api/push/unwatch', { sub, stopId: w.stopId, tripId: w.tripId });
      watching.delete(k);
    } else {
      if ((await within(Notification.requestPermission(), 15000)) !== 'granted') return toast('Notifications blocked');
      const b64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
      sub ||= await within(reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64((await api('/api/push/key')).key) }), 10000);
      await post('/api/push/watch', { ...w, sub });
      watching.add(k);
      toast(`Will notify at ${w.minutes} min`);
    }
    store.set('watching', [...watching]);
    btn.classList.toggle('on', watching.has(k));
  } catch (err) { toast(err.message === 'timeout' ? 'Notifications unavailable here' : 'Could not set notification'); }
}

$('#pins').onclick = (e) => {
  const t = e.target.closest('button'); if (!t) return;
  if (t.classList.contains('bell')) return toggleWatch(t);
  if (t.dataset.unpin) { pins = pins.filter((p) => p.id !== t.dataset.unpin); store.set('pins', pins); return refreshPins(); }
  if (t.dataset.unroute) { routePins = routePins.filter((r) => r.short !== t.dataset.unroute); store.set('routePins', routePins); return refreshPins(); }
  if (t.dataset.maproute) { showTab('map'); $('#maproute').value = t.dataset.maproute; fitNext = true; return refreshMap(); }
  if (t.dataset.addstop) {
    const r = routePins.find((x) => x.short === t.dataset.addstop);
    window.scrollTo(0, 0); $('#pin-search').value = '';
    pinSearch.drill(r, (s) => { addStopPin(s); pinSearch.close(); });
  }
};

// ---------- plan ----------
const place = { from: null, to: null };
const recents = () => store.get('recents', []);
const remember = (p) => store.set('recents', [p, ...recents().filter((r) => !(r.name === p.name && r.sub === p.sub))].slice(0, 6));

function planBox(key) {
  const input = $('#' + key);
  async function choose(it, ctx) {
    try {
      const p = it.kind === 'here' ? { ...(await here()), name: 'My location' } : await ctx.coords(it);
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
$('#now').onclick = () => { $('#when').value = ''; planTrip(); };

async function planTrip() {
  if (!place.from || !place.to) return;
  $('#trip').innerHTML = '<div class="empty">Planning…</div>';
  const depart = $('#when').value ? Math.floor(new Date($('#when').value).getTime() / 1000) : 0;
  let r;
  try { r = await api(`/api/plan?from=${place.from.lat},${place.from.lon}&to=${place.to.lat},${place.to.lon}&depart=${depart}`); }
  catch { return ($('#trip').innerHTML = '<div class="empty">Planning needs a connection.</div>'); }
  if (!r) return ($('#trip').innerHTML = '<div class="empty">No route found. Try a different time or place.</div>');
  const legs = r.legs.map((l, i) => `<div class="leg ${i ? '' : 'first'}">` + (l.type === 'walk'
    ? `🚶 Walk ${l.mins} min${l.to ? ' to ' + esc(l.to) : ''}`
    : `${badge(l.route, l.color)} ${esc(l.headsign)} ${l.live ? '<span class="live">● live</span>' : ''}<br>${clock(l.dep)} ${esc(l.from)} → ${clock(l.arr)} ${esc(l.to)} <span class="sched">${l.stops} stops</span>`) + '</div>').join('');
  $('#trip').innerHTML = `<div class="card"><div class="summary">Arrive ${clock(r.arrive)}</div>${legs}${r.finalWalkMins ? `<div class="leg">🚶 Walk ${r.finalWalkMins} min to destination</div>` : ''}<div class="sched">● live = adjusted for current delays; otherwise scheduled times.</div></div>`;
}

// ---------- map ----------
let map, busLayer, stopLayer, meMarker, fitNext = false;
let mapMode = store.get('mapMode', 'all');
const markers = new Map(); // vehicle id -> marker, updated in place so buses glide instead of flickering

const busIcon = (b) => L.divIcon({
  className: '', iconSize: [52, 52], iconAnchor: [26, 26],
  html: `<div class="bus" style="--c:#${esc(b.color || '444')}">${b.bearing == null ? '' : `<div class="arrow" style="transform:rotate(${b.bearing}deg)"></div>`}<div class="dot"><small>${esc(b.label)}</small><b>${esc(b.route || '?')}</b></div></div>`,
});
const busPopup = (b) => `<b>Route ${esc(b.route)} → ${esc(b.headsign)}</b><br>Bus #${esc(b.label)}${b.next ? `<br>Next: ${esc(b.next.stop)} · ${etaText(b.next.time)}` : ''}`;

function syncSeg() { $$('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mapMode && !$('#maproute').value)); }
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
  const show = all.filter((b) => (rq ? num(b.route) === num(rq) : mapMode === 'pins' ? b.route && pinRoutes.has(b.route) : true));
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
  const yours = (x) => x.routes.some((r) => pinRoutes.has(r));
  a.sort((x, y) => yours(y) - yours(x)); // alerts for your pinned routes first, then newest
  $('#alerts').innerHTML = a.length ? a.map((x) => `<div class="card"><h2><span class="name" style="white-space:normal">${esc(x.header || 'Alert')}</span>${yours(x) ? '<span class="chip">Your route</span>' : ''}</h2>
    <div class="sched">Since ${new Date(x.start * 1000).toLocaleDateString()}${x.routes.length ? ' · Routes ' + esc([...new Set(x.routes)].join(', ')) : ''}</div>
    <p>${esc(x.description).replace(/\r?\n/g, '<br>')}</p></div>`).join('') : '<div class="empty">No active alerts.</div>';
}

refreshPins();
setInterval(() => { refreshPins(); if (map && !$('#map').hidden) refreshMap(); }, 20000);
