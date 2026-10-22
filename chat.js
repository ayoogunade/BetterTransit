// "Ask" chat: Gemini answers transit questions by calling the app's own data (planner, live arrivals, timetables, alerts, weather)
// as tools, and is told to answer only from what they return. The conversation lives on the device: each request sends the
// history back and gets the extended one, so nothing is stored here. Tools named propose_* don't change anything: they hand the
// app a button the user taps to confirm (pin, commute alert, bus alert).
const API = process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta/models'; // override to point at a local fake in tests
const MAX_STEPS = 8; // model <-> tool round trips per question
const MAX_TURNS = 12; // user questions kept in the history sent to the model

const S = (type, description, extra = {}) => ({ type, description, ...extra });
const LATLON = { lat: S('NUMBER', 'Latitude'), lon: S('NUMBER', 'Longitude'), name: S('STRING', 'Short name for the place') };
const PLACE = (what) => S('OBJECT', what, { properties: LATLON, required: ['lat', 'lon'] });
const fn = (name, description, properties = {}, required = []) => ({ name, description, parameters: { type: 'OBJECT', properties, required } });

const DECLS = [
  fn('find_place', 'Resolve a place, address, landmark, bus stop or saved place (home, work) to coordinates. Call this before planning to or from anything except the user\'s current location.',
    { query: S('STRING', 'What to look for, e.g. "home", "University of Saskatchewan", "8th Street / Preston"') }, ['query']),
  fn('plan_trip', 'Best bus trips between two points, with live delays applied. Leave now unless depart_time or arrive_by is given.',
    { from: PLACE('Start'), to: PLACE('Destination'), depart_time: S('STRING', 'Leave at this local time, HH:MM 24h'), arrive_by: S('STRING', 'Arrive by this local time, HH:MM 24h'),
      date: S('STRING', 'YYYY-MM-DD, default today'), accessible: S('BOOLEAN', 'Accessible trips only') }, ['from', 'to']),
  fn('compare_departures', 'For "when is the best time to leave" questions: plans the trip for every departure in a time window and lists each distinct option (leave, arrive, travel time, transfers, walking, how reliable the transfer is, last bus).',
    { from: PLACE('Start'), to: PLACE('Destination'), window_start: S('STRING', 'Earliest leave time, HH:MM 24h'), window_end: S('STRING', 'Latest leave time, HH:MM 24h (max 3 hours after the start)'),
      date: S('STRING', 'YYYY-MM-DD, default today') }, ['from', 'to', 'window_start', 'window_end']),
  fn('stop_arrivals', 'Next buses at a stop: live predictions, delay, stops away, how late this bus usually runs, cancellations, last bus of the day.',
    { stop_id: S('STRING', 'Stop id from find_place or my_stuff') }, ['stop_id']),
  fn('stop_timetable', 'Scheduled departures at a stop for a day, optionally one route and only after a time.',
    { stop_id: S('STRING', 'Stop id'), date: S('STRING', 'YYYY-MM-DD, default today'), route: S('STRING', 'Route number, e.g. "60"'), after: S('STRING', 'Only departures at or after this local time, HH:MM 24h') }, ['stop_id']),
  fn('route_buses', 'Where every bus on a route is right now: fleet number, direction, next stop and when it gets there.', { route: S('STRING', 'Route number') }, ['route']),
  fn('service_alerts', 'Current city service alerts (detours, closures), optionally only for one route.', { route: S('STRING', 'Route number') }),
  fn('weather', 'Current Saskatoon temperature, feels-like and wind (deg F).'),
  fn('my_stuff', 'The user\'s pinned stops and routes, saved places (home, work) and commute alerts.'),
  fn('propose_pin_stop', 'Offer to pin a stop. The user confirms with a button.', { stop_id: S('STRING', 'Stop id') }, ['stop_id']),
  fn('propose_pin_route', 'Offer to pin a route. The user confirms with a button.', { route: S('STRING', 'Route number') }, ['route']),
  fn('propose_bus_alert', 'Offer a push notification before one specific bus reaches a stop. trip_id comes from stop_arrivals or a plan.',
    { stop_id: S('STRING', 'Stop where they board'), trip_id: S('STRING', 'The bus trip') }, ['stop_id', 'trip_id']),
  fn('propose_commute', 'Offer a commute alert: on the chosen days, during the window, the app pushes "leave in N min" for the next good bus.',
    { from: PLACE('Start'), to: PLACE('Destination'), name: S('STRING', 'Short name, e.g. "Home from work"'), days: S('ARRAY', 'Days, 0=Sun..6=Sat', { items: { type: 'INTEGER' } }),
      start: S('STRING', 'Window start, HH:MM 24h'), end: S('STRING', 'Window end, HH:MM 24h'), minutes_before: S('INTEGER', 'Notify this many minutes before leaving: 3, 5, 10 or 15') },
    ['from', 'to', 'days', 'start', 'end']),
];

const system = (ctx) => `You are the assistant inside BetterTransit, a personal Saskatoon Transit app. Right now it is ${ctx.now} in Saskatoon (${ctx.today}).
${ctx.here ? `The user is at lat ${ctx.here.lat}, lon ${ctx.here.lon}: use that as the start when they don't say where from.` : 'The user\'s location is unknown: ask where they are starting from if it matters, or use a saved place.'}
Rules:
- Answer ONLY from tool results. Never guess or recall times, routes, stops or delays. If the tools don't give the answer, say you don't know.
- Resolve places with find_place first ("home" and "work" are saved places). Use HH:MM 24h local times in tool calls.
- Make independent calls together in one turn (e.g. look up both places at once): every extra round makes the user wait.
- "Best time to leave/go" questions: use compare_departures, then recommend one option and say why (arrival time, waiting, transfers, reliability).
- Only use propose_* tools when the user asks you to set something up; then say they can tap the button to confirm.
- Reply for a phone screen: short, plain sentences, a short list at most, no tables. Write times like 5:52 PM and routes like "Route 60".`;

module.exports = function createChat({ key = process.env.GEMINI_API_KEY, model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite', tools, fetch: get = fetch, retryMs = 1500 } = {}) {
  async function generate(contents, ctx) {
    const body = JSON.stringify({ systemInstruction: { parts: [{ text: system(ctx) }] }, tools: [{ functionDeclarations: DECLS }], contents,
      generationConfig: { thinkingConfig: { thinkingLevel: 'low' } } }); // the tools do the reasoning; deep thinking only adds seconds
    let res;
    for (let attempt = 0; attempt < 3; attempt++) { // "high demand" 503s, rate limits and the odd hung request are usually gone a second later
      if (attempt) await new Promise((ok) => setTimeout(ok, retryMs * attempt));
      try { res = await get(`${API}/${model}:generateContent`, { method: 'POST', signal: AbortSignal.timeout(15000), headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body }); }
      catch (e) { if (attempt === 2) throw e; continue; } // a normal reply takes 1-3 s
      if (![429, 500, 503].includes(res.status)) break;
    }
    if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const c = ((await res.json()).candidates || [])[0];
    return c && c.content && c.content.parts ? c.content : { role: 'model', parts: [{ text: 'Sorry, I could not answer that.' }] };
  }

  // Keep the last MAX_TURNS questions. Cut only at a typed question, so a tool call is never separated from its result.
  const trim = (h) => {
    const starts = h.map((c, i) => (c.role === 'user' && c.parts.some((p) => p.text != null) ? i : -1)).filter((i) => i >= 0);
    return starts.length > MAX_TURNS ? h.slice(starts[starts.length - MAX_TURNS]) : h;
  };

  return {
    enabled: !!key,
    // history: the contents returned last time ([] to start). ctx: {now, today, here?}. Returns {reply, history, actions}.
    async ask(history, message, ctx) {
      const contents = trim([...(Array.isArray(history) ? history : []), { role: 'user', parts: [{ text: String(message).slice(0, 2000) }] }]);
      const actions = [];
      for (let step = 0; step < MAX_STEPS; step++) {
        const content = await generate(contents, ctx);
        contents.push(content); // as received: Gemini needs its own parts (and their thought signatures) back unchanged
        const calls = content.parts.filter((p) => p.functionCall);
        if (!calls.length) return { reply: content.parts.map((p) => p.text || '').join('').trim(), history: contents, actions };
        const parts = await Promise.all(calls.map(async ({ functionCall: { name, args } }) => {
          let response;
          try {
            if (!tools[name]) throw new Error('unknown tool');
            const out = await tools[name](args || {}, ctx);
            if (out && out.action) { actions.push(out.action); response = { result: out.result }; } else response = { result: out };
          } catch (e) { response = { error: e.message }; }
          return { functionResponse: { name, response } };
        }));
        contents.push({ role: 'user', parts });
      }
      return { reply: 'That took too many steps. Try asking more specifically.', history: contents, actions };
    },
  };
};
module.exports.DECLS = DECLS;
