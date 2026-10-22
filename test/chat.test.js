const test = require('node:test');
const assert = require('node:assert');
const createChat = require('../chat');

const ctx = { now: '5:20 PM', today: 'Thursday, October 22, 2026, 2026-10-22', here: null };
// a fake Gemini that answers with the scripted model contents in order and records each request body
const fake = (...replies) => {
  const sent = [];
  return { sent, fetch: async (url, init) => { sent.push(JSON.parse(init.body)); const content = replies.shift(); return { ok: true, json: async () => ({ candidates: [{ content }] }) }; } };
};
const say = (text) => ({ role: 'model', parts: [{ text }] });
const call = (name, args, extra = {}) => ({ role: 'model', parts: [{ functionCall: { name, args }, ...extra }] });

test('runs the tools the model asks for and returns its final answer', async () => {
  const g = fake(call('weather', {}), say('It is -3 °F.'));
  const chat = createChat({ key: 'k', tools: { weather: async () => ({ temp: -3 }) }, fetch: g.fetch });
  const r = await chat.ask([], 'how cold is it', ctx);
  assert.strictEqual(r.reply, 'It is -3 °F.');
  assert.deepStrictEqual(g.sent[1].contents.at(-1), { role: 'user', parts: [{ functionResponse: { name: 'weather', response: { result: { temp: -3 } } } }] });
  assert.match(g.sent[0].systemInstruction.parts[0].text, /5:20 PM/);
  assert.ok(g.sent[0].tools[0].functionDeclarations.some((d) => d.name === 'compare_departures'));
});

test('sends the model its own parts back unchanged (thought signatures)', async () => {
  const c = call('weather', {}, { thoughtSignature: 'sig123' });
  const g = fake(c, say('ok'));
  await createChat({ key: 'k', tools: { weather: () => 1 }, fetch: g.fetch }).ask([], 'q', ctx);
  assert.deepStrictEqual(g.sent[1].contents[1], c);
});

test('collects actions from propose tools and hides them from the model', async () => {
  const action = { type: 'pin_stop', stop: { id: '1' } };
  const g = fake(call('propose_pin_stop', { stop_id: '1' }), say('Tap to pin.'));
  const r = await createChat({ key: 'k', tools: { propose_pin_stop: () => ({ result: 'shown', action }) }, fetch: g.fetch }).ask([], 'pin it', ctx);
  assert.deepStrictEqual(r.actions, [action]);
  assert.deepStrictEqual(g.sent[1].contents.at(-1).parts[0].functionResponse.response, { result: 'shown' });
});

test('tool errors and unknown tools go back to the model as errors', async () => {
  const g = fake({ role: 'model', parts: [{ functionCall: { name: 'stop_arrivals', args: {} } }, { functionCall: { name: 'nope', args: {} } }] }, say('Sorry.'));
  await createChat({ key: 'k', tools: { stop_arrivals: () => { throw new Error('unknown stop'); } }, fetch: g.fetch }).ask([], 'q', ctx);
  assert.deepStrictEqual(g.sent[1].contents.at(-1).parts.map((p) => p.functionResponse.response), [{ error: 'unknown stop' }, { error: 'unknown tool' }]);
});

test('continues a conversation and keeps only the last 12 questions, cut at a question', async () => {
  let history = [];
  const chat = createChat({ key: 'k', tools: { weather: () => 1 }, fetch: async () => ({ ok: true, json: async () => ({ candidates: [{ content: say('a') }] }) }) });
  for (let i = 0; i < 14; i++) history = (await chat.ask(history, `q${i}`, ctx)).history;
  assert.strictEqual(history.length, 24);
  assert.deepStrictEqual(history[0], { role: 'user', parts: [{ text: 'q2' }] });
});

test('stops after too many tool rounds, and is disabled without a key', async () => {
  const chat = createChat({ key: 'k', tools: { weather: () => 1 }, fetch: async () => ({ ok: true, json: async () => ({ candidates: [{ content: call('weather', {}) }] }) }) });
  assert.match((await chat.ask([], 'q', ctx)).reply, /too many steps/);
  assert.strictEqual(createChat({ key: '', tools: {} }).enabled, false);
});

test('retries a busy model, then gives up with the error', async () => {
  let n = 0;
  const busy = (times) => async () => (n++ < times ? { ok: false, status: 503, text: async () => 'high demand' } : { ok: true, status: 200, json: async () => ({ candidates: [{ content: say('ok') }] }) });
  assert.strictEqual((await createChat({ key: 'k', tools: {}, fetch: busy(2), retryMs: 1 }).ask([], 'q', ctx)).reply, 'ok');
  n = 0;
  await assert.rejects(createChat({ key: 'k', tools: {}, fetch: busy(3), retryMs: 1 }).ask([], 'q', ctx), /gemini 503/);
  assert.strictEqual(n, 3);
});
