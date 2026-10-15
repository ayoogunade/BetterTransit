const $ = (s) => document.querySelector(s);
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const api = (p) => fetch(p).then((r) => r.json());
let pinRoutes = new Set();
let pins = store.get('pins', []); // [{id, name}] shown everywhere, regardless of location

// ---- tabs ----
document.querySelectorAll('nav button').forEach((b) => b.onclick = () => {
  document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('on', x === b));
  ['pinned', 'plan', 'map', 'alerts'].forEach((t) => $('#' + t).hidden = t !== b.dataset.tab);
  if (b.dataset.tab === 'map') { initMap(); refreshMap(); }
  if (b.dataset.tab === 'alerts') refreshAlerts();
});

// ---- pinned stops ----
const eta = (t) => {
  const m = Math.round((t - Date.now() / 1000) / 60);
  return m <= 0 ? 'Due' : m + ' min';
};
const watchKey = (stop, trip) => stop + '|' + trip;
let watching = new Set(store.get('watching', []));
function renderPin(p, list) {
  const rows = list.length ? list.slice(0, 6).map((a) => `
    <div class="row">
      <button class="bell ${watching.has(watchKey(p.id, a.trip)) ? 'on' : ''}" data-stop="${p.id}" data-name="${p.name}" data-trip="${a.trip}" data-route="${a.route}" data-hs="${a.headsign || ''}">🔔</button>
      <span class="badge" style="background:#${a.color || '444'}">${a.route}</span>
      <span class="hs">${a.headsign || ''}</span>
      <span class="eta">${eta(a.time)}${a.live ? '' : ' <span class="sched">scheduled</span>'}</span>
    </div>`).join('') : '<div class="empty">No upcoming buses</div>';
  return `<div class="card" data-id="${p.id}"><h2>${p.name} <button data-unpin="${p.id}">✕</button></h2>${rows}</div>`;
}
async function refreshPins() {
  const lists = await Promise.all(pins.map((p) => api('/api/arrivals/' + encodeURIComponent(p.id)).catch(() => [])));
  pinRoutes = new Set(lists.flat().map((a) => a.route));
  $('#pins').innerHTML = pins.length ? pins.map((p, i) => renderPin(p, lists[i])).join('') : '<div class="empty">Search below to pin your stops.</div>';
  $('#updated').textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
const toast = (msg) => { $('#updated').textContent = msg; setTimeout(refreshPins, 4000); };
const b64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const post = (p, body) => fetch(p, { method: 'POST', body: JSON.stringify(body) });
const within = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('timeout')), ms))]);
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
  if (e.target.classList.contains('bell')) return toggleWatch(e.target);
  const id = e.target.dataset.unpin;
  if (id) { pins = pins.filter((p) => p.id !== id); store.set('pins', pins); refreshPins(); }
};
let debounce;
$('#search').oninput = (e) => {
  clearTimeout(debounce);
  debounce = setTimeout(async () => {
    const q = e.target.value.trim();
    if (!q) return ($('#results').innerHTML = '');
    const r = await api('/api/stops?q=' + encodeURIComponent(q));
    $('#results').innerHTML = r.map((s) => `<div class="res" data-id="${s.id}" data-name="${s.name}" data-lat="${s.lat}" data-lon="${s.lon}">${s.name} <span class="sched">#${s.id}</span></div>`).join('');
  }, 250);
};
$('#results').onclick = (e) => {
  const el = e.target.closest('.res'); if (!el) return;
  if (!pins.some((p) => p.id === el.dataset.id)) pins.push({ id: el.dataset.id, name: el.dataset.name, lat: +el.dataset.lat, lon: +el.dataset.lon });
  store.set('pins', pins);
  $('#search').value = ''; $('#results').innerHTML = '';
  refreshPins();
};

// ---- trip planner ----
const place = { from: null, to: null };
const clock = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function placePicker(key) {
  const input = $('#' + key), box = $('#' + key + '-results');
  let timer;
  input.oninput = () => {
    clearTimeout(timer); place[key] = null;
    timer = setTimeout(async () => {
      const q = input.value.trim();
      if (q.length < 3) return (box.innerHTML = '');
      const r = await api('/api/geocode?q=' + encodeURIComponent(q + ' Saskatoon'));
      box.innerHTML = r.map((x, i) => `<div class="res" data-i="${i}">${x.name}</div>`).join('') || '<div class="empty">No matches</div>';
      box.onclick = (e) => {
        const el = e.target.closest('.res'); if (!el) return;
        const x = r[el.dataset.i];
        place[key] = { lat: x.lat, lon: x.lon }; input.value = x.name; box.innerHTML = ''; planTrip();
      };
    }, 400);
  };
}
placePicker('from'); placePicker('to');
$('#when').onchange = planTrip;
$('#now').onclick = () => { $('#when').value = ''; planTrip(); };
$('#here').onclick = () => navigator.geolocation.getCurrentPosition((p) => {
  place.from = { lat: p.coords.latitude, lon: p.coords.longitude };
  $('#from').value = 'My location'; planTrip();
}, () => ($('#trip').innerHTML = '<div class="empty">Location permission denied.</div>'));
async function planTrip() {
  if (!place.from || !place.to) return;
  $('#trip').innerHTML = '<div class="empty">Planning…</div>';
  const depart = $('#when').value ? Math.floor(new Date($('#when').value).getTime() / 1000) : 0;
  const r = await api(`/api/plan?from=${place.from.lat},${place.from.lon}&to=${place.to.lat},${place.to.lon}&depart=${depart}`);
  if (!r) return ($('#trip').innerHTML = '<div class="empty">No route found. Try a different time.</div>');
  const legs = r.legs.map((l) => l.type === 'walk'
    ? `<div class="leg">🚶 Walk ${l.mins} min${l.to ? ' to ' + l.to : ''}</div>`
    : `<div class="leg"><span class="badge" style="background:#${l.color || '444'}">${l.route}</span> ${l.headsign || ''}<br>${clock(l.dep)} ${l.from} → ${clock(l.arr)} ${l.to} <span class="sched">(${l.stops} stops)</span> ${l.live ? '<span class="live">● live</span>' : ''}</div>`).join('');
  $('#trip').innerHTML = `<div class="card"><div class="summary">Arrive ${clock(r.arrive)}</div>${legs}${r.finalWalkMins ? `<div class="leg">🚶 Walk ${r.finalWalkMins} min to destination</div>` : ''}<div class="sched">● live = adjusted for current delays; otherwise scheduled times.</div></div>`;
}

// ---- map ----
let map, layer, stopLayer;
function initMap() {
  if (map) return;
  map = L.map('mapbox').setView([52.13, -106.65], 12);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(map);
  layer = L.layerGroup().addTo(map);
  stopLayer = L.layerGroup().addTo(map);
  $('#mine').checked = store.get('mine', false);
  $('#mine').onchange = () => { store.set('mine', $('#mine').checked); refreshMap(); };
}
async function refreshMap() {
  if (!map) return;
  const mine = $('#mine').checked;
  const v = (await api('/api/vehicles')).filter((b) => !mine || (b.route && pinRoutes.has(b.route)));
  layer.clearLayers();
  stopLayer.clearLayers();
  for (const p of pins) { // old pins saved before coords existed get them filled in once
    if (!p.lat) { const hit = (await api('/api/stops?q=' + encodeURIComponent(p.id))).find((x) => x.id === p.id); if (hit) { p.lat = hit.lat; p.lon = hit.lon; store.set('pins', pins); } }
    if (p.lat) L.marker([p.lat, p.lon], { icon: L.divIcon({ className: '', html: '<div class="stopdot"></div>', iconSize: [14, 14] }) }).bindPopup(p.name).addTo(stopLayer);
  }
  v.forEach((b) => L.marker([b.lat, b.lon], {
    icon: L.divIcon({ className: '', html: `<span class="badge" style="background:#${b.color || '444'}">${b.route || '?'}</span>`, iconSize: [40, 22] }),
  }).bindPopup(b.headsign || '').addTo(layer));
}

// ---- alerts ----
async function refreshAlerts() {
  const a = await api('/api/alerts');
  $('#alerts').innerHTML = a.length ? a.map((x) => `<div class="card"><h2>${x.header || 'Alert'}</h2><div class="sched">Since ${new Date(x.start * 1000).toLocaleDateString()}</div>${x.routes.length ? '<div class="sched">Routes: ' + [...new Set(x.routes)].join(', ') + '</div>' : ''}<p>${x.description || ''}</p></div>`).join('') : '<div class="empty">No active alerts.</div>';
}

refreshPins();
setInterval(() => { refreshPins(); if (map && !$('#map').hidden) refreshMap(); }, 20000);
