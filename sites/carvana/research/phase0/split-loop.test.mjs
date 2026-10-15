// Phase 0 toy: the split agent loop.
// A toy agentic brain (server) drives the loop and streams tool calls as NDJSON;
// a toy client (standing in for core.js) runs each call as soon as it arrives and posts the results back.
// The model is scripted (FakeModel) and Carvana is replaced by inline fixtures (FakeHost).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- FakeHost: tiny fixture data shaped like Carvana's responses ----------
const FIXTURE_VEHICLES = [
  { vehicleId: 4773662, year: 2024, model: 'Model Y', price: { total: 34590, estimatedTaxesAndFees: 3736 } },
  { vehicleId: 4812031, year: 2023, model: 'Model Y', price: { total: 35590, estimatedTaxesAndFees: 3837 } },
  { vehicleId: 4811903, year: 2022, model: 'Model Y', price: { total: 34990, estimatedTaxesAndFees: 3776 } },
];
const FIXTURE_DATES = { 4773662: 'tomorrow', 4812031: 'Saturday', 4811903: 'Wednesday' };

// ---------- Toy client (core.js stand-in): tools + per-session ID set ----------
function makeClient() {
  const knownIds = new Set();
  const tools = {
    async search() {
      await sleep(30);
      FIXTURE_VEHICLES.forEach((v) => knownIds.add(v.vehicleId));
      return { vehicles: FIXTURE_VEHICLES };
    },
    async availability({ vehicleIds }) {
      await sleep(30);
      const unknown = vehicleIds.filter((id) => !knownIds.has(id));
      if (unknown.length) {
        throw new Error("This ID wasn't returned in this session. Use an ID from the search results.");
      }
      return { dates: vehicleIds.map((id) => ({ vehicleId: id, delivery: FIXTURE_DATES[id] })) };
    },
    async slow() { await sleep(250); return { ok: true }; },
    async fast() { await sleep(10); return { ok: true }; },
  };
  return { tools, knownIds };
}

async function* ndjson(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) yield JSON.parse(line);
    }
  }
}

// Runs one user turn: posts the goal, executes each tool call the moment it arrives, posts results, repeats.
async function runTurn(base, sessionId, message, client, { dropResults = false } = {}) {
  const timeline = [];
  const t0 = Date.now();
  let res = await fetch(`${base}/turn`, { method: 'POST', body: JSON.stringify({ sessionId, message }) });
  for (;;) {
    const running = [];
    let awaitIds = null;
    for await (const ev of ndjson(res)) {
      timeline.push({ at: Date.now() - t0, type: ev.type, name: ev.call?.name });
      if (ev.type === 'tool_call') {
        const { id, name, args } = ev.call;
        timeline.push({ at: Date.now() - t0, type: 'dispatch', name });
        running.push(
          client.tools[name](args).then(
            (output) => ({ id, ok: true, output }),
            (err) => ({ id, ok: false, error: err.message }),
          ),
        );
      } else if (ev.type === 'await_results') {
        awaitIds = ev.callIds;
      } else if (ev.type === 'answer') {
        return { answer: ev, timeline };
      }
    }
    if (!awaitIds) throw new Error('stream ended without an answer or a results request');
    const results = await Promise.all(running);
    if (dropResults) return { answer: null, timeline, pending: awaitIds };
    res = await fetch(`${base}/results`, { method: 'POST', body: JSON.stringify({ sessionId, results }) });
    if (res.status !== 200) return { answer: null, timeline, status: res.status, body: await res.json() };
  }
}

// ---------- Toy agentic brain: owns the loop, step budget, call IDs and timeouts ----------
function startBrain(fakeModel, { maxSteps = 4, resultTimeoutMs = 2000 } = {}) {
  const sessions = new Map();
  let nextCall = 1;

  async function streamStep(session, res) {
    session.steps += 1;
    if (session.steps > maxSteps) {
      res.write(JSON.stringify({ type: 'answer', text: 'Step budget reached. Here is what I found so far.', budgetReached: true }) + '\n');
      return res.end();
    }
    const calls = [];
    for await (const ev of fakeModel(session.history, session.steps)) {
      if (ev.type === 'tool_call') {
        const call = { id: `call_${nextCall++}`, name: ev.name, args: ev.args };
        calls.push(call);
        res.write(JSON.stringify({ type: 'tool_call', call }) + '\n'); // sent as soon as the call is complete
      } else if (ev.type === 'answer') {
        res.write(JSON.stringify({ type: 'answer', text: ev.text, present: ev.present ?? null }) + '\n');
        return res.end();
      }
    }
    session.pending = new Map(calls.map((c) => [c.id, c]));
    session.history.push({ role: 'assistant', calls });
    clearTimeout(session.timer);
    session.timer = setTimeout(() => { session.timedOut = true; session.pending = new Map(); }, resultTimeoutMs);
    res.write(JSON.stringify({ type: 'await_results', callIds: calls.map((c) => c.id) }) + '\n');
    res.end();
  }

  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const msg = body ? JSON.parse(body) : {};
    if (req.method === 'POST' && req.url === '/turn') {
      const session = { history: [{ role: 'user', text: msg.message }], steps: 0, pending: new Map(), timedOut: false };
      sessions.set(msg.sessionId, session);
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      return streamStep(session, res);
    }
    if (req.method === 'POST' && req.url === '/results') {
      const session = sessions.get(msg.sessionId);
      if (!session || session.timedOut) {
        res.writeHead(410, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'This turn timed out waiting for tool results.' }));
      }
      const unknown = msg.results.filter((r) => !session.pending.has(r.id));
      if (unknown.length) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Results for calls this brain did not issue', ids: unknown.map((r) => r.id) }));
      }
      clearTimeout(session.timer);
      session.pending = new Map();
      session.history.push({ role: 'tool', results: msg.results });
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      return streamStep(session, res);
    }
    res.writeHead(404).end();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({ base, sessions, close: () => new Promise((r) => { sessions.forEach((s) => clearTimeout(s.timer)); server.close(r); }) });
    });
  });
}

// ---------- Tests ----------
test('happy path: search, then bulk availability, then an answer that presents only known IDs', async () => {
  async function* model(history, step) {
    if (step === 1) { yield { type: 'tool_call', name: 'search', args: { model: 'Model Y' } }; return; }
    if (step === 2) {
      const ids = history.at(-1).results[0].output.vehicles.map((v) => v.vehicleId);
      yield { type: 'tool_call', name: 'availability', args: { vehicleIds: ids } };
      return;
    }
    const dates = history.at(-1).results[0].output.dates;
    const soon = dates.filter((d) => d.delivery !== 'Wednesday').map((d) => d.vehicleId);
    yield { type: 'answer', text: `${soon.length} cars arrive by Saturday.`, present: { tool: 'present_vehicles', rows: soon } };
  }
  const brain = await startBrain(model);
  const client = makeClient();
  try {
    const { answer } = await runTurn(brain.base, 's1', 'AWD Model Y by Saturday', client);
    assert.equal(answer.text, '2 cars arrive by Saturday.');
    assert.deepEqual(answer.present.rows, [4773662, 4812031]);
    assert.ok(answer.present.rows.every((id) => client.knownIds.has(id)), 'presented IDs must come from tool results');
  } finally { await brain.close(); }
});

test('tool calls are dispatched before the model finishes its step', async () => {
  async function* model(history, step) {
    if (step === 1) {
      yield { type: 'tool_call', name: 'slow', args: {} }; // the model writes the slow call first
      await sleep(150);
      yield { type: 'tool_call', name: 'fast', args: {} };
      await sleep(150); // the model is still "writing" after its last call
      return;
    }
    yield { type: 'answer', text: 'done' };
  }
  const brain = await startBrain(model);
  try {
    const { timeline } = await runTurn(brain.base, 's2', 'go', makeClient());
    const firstDispatch = timeline.find((e) => e.type === 'dispatch' && e.name === 'slow').at;
    const stepEnd = timeline.find((e) => e.type === 'await_results').at;
    assert.ok(stepEnd - firstDispatch >= 250, `first call should start ~300ms before the step ends (gap was ${stepEnd - firstDispatch}ms)`);
  } finally { await brain.close(); }
});

test('the step budget stops a model that keeps calling tools', async () => {
  async function* model() { yield { type: 'tool_call', name: 'fast', args: {} }; }
  const brain = await startBrain(model, { maxSteps: 3 });
  try {
    const { answer, timeline } = await runTurn(brain.base, 's3', 'loop forever', makeClient());
    assert.equal(answer.budgetReached, true);
    assert.equal(timeline.filter((e) => e.type === 'dispatch').length, 3);
  } finally { await brain.close(); }
});

test('the brain refuses results for calls it did not issue', async () => {
  async function* model(history, step) {
    if (step === 1) { yield { type: 'tool_call', name: 'fast', args: {} }; return; }
    yield { type: 'answer', text: 'done' };
  }
  const brain = await startBrain(model);
  try {
    const res = await fetch(`${brain.base}/turn`, { method: 'POST', body: JSON.stringify({ sessionId: 's4', message: 'go' }) });
    await res.text();
    const bad = await fetch(`${brain.base}/results`, { method: 'POST', body: JSON.stringify({ sessionId: 's4', results: [{ id: 'call_bogus', ok: true, output: {} }] }) });
    assert.equal(bad.status, 400);
    assert.deepEqual((await bad.json()).ids, ['call_bogus']);
  } finally { await brain.close(); }
});

test('a client that never returns results times out the turn', async () => {
  async function* model() { yield { type: 'tool_call', name: 'fast', args: {} }; }
  const brain = await startBrain(model, { resultTimeoutMs: 200 });
  try {
    const { pending } = await runTurn(brain.base, 's5', 'go', makeClient(), { dropResults: true });
    await sleep(300);
    const late = await fetch(`${brain.base}/results`, { method: 'POST', body: JSON.stringify({ sessionId: 's5', results: pending.map((id) => ({ id, ok: true, output: {} })) }) });
    assert.equal(late.status, 410);
  } finally { await brain.close(); }
});

test('an unknown vehicle ID from the model comes back as an actionable error, not a crash', async () => {
  async function* model(history, step) {
    if (step === 1) { yield { type: 'tool_call', name: 'availability', args: { vehicleIds: [9999999] } }; return; }
    const r = history.at(-1).results[0];
    yield { type: 'answer', text: r.ok ? 'unexpected' : `tool error: ${r.error}` };
  }
  const brain = await startBrain(model);
  try {
    const { answer } = await runTurn(brain.base, 's6', 'go', makeClient());
    assert.match(answer.text, /wasn't returned in this session/);
  } finally { await brain.close(); }
});
