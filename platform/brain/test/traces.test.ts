// Tests: real-session traces (brain/src/server/traces.ts), written by the brain's HTTP server as a real client talks to it.
// How: a real HTTP server on a local port with FakeModel and FakeClient, tracing into a temporary folder; a fixed
// clock for retention.
// Passes when: each session's file holds every message on the link, both ways, in order, with the brain's log entries
// in place; refusals are kept; a session the brain forgot while idle and reopened stays in its one file; date folders
// past the retention period go and nothing else does; session IDs can't leave the folder; and a trace that can't be
// written never stops serving.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { ClientMessage } from '../../contract/generated/types.ts';
import { webHost } from '../../core/hosts/web.ts';
import { FakeClient } from '../../testkit/src/fake-client.ts';
import { FakeModel, type FakeScript } from '../../testkit/src/fake-model.ts';
import { Brain } from '../src/agent/brain.ts';
import { createBrainServer } from '../src/server/server.ts';
import { traceFileName, TraceWriter, type TraceLine } from '../src/server/traces.ts';
import { HOME, NOW, shopResults, shopSite, validateMessage } from './example-brain.ts';

const TODAY = new Date('2026-11-05T20:00:00Z');

async function serve(script: FakeScript[], dir: string, clock: { now: number } = { now: NOW }) {
  const traces = new TraceWriter({ dir, site: 'example-shop', keepDays: 30, now: () => TODAY });
  const brain = new Brain({ site: shopSite(), model: new FakeModel(script), now: () => clock.now, limits: { sessionIdleMs: 60_000 }, log: (entry) => traces.log(entry) });
  const server = createBrainServer({ brain, allowedOrigins: [], tap: traces });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const send = webHost({ brainUrl: base }).brain!.bind(null) as (message: ClientMessage) => AsyncIterable<unknown>;
  return { base, send, traces, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const readLines = (file: string) => readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as TraceLine);
const kindOf = (line: TraceLine) => ('in' in line ? `in:${(line.in as { type: string }).type}`
  : 'out' in line ? `out:${(line.out as { type: string }).type}`
    : 'refused' in line ? 'refused' : `log:${line.log.kind}`);

test("a session's file holds every message on the link, both ways, in order, with the brain's log entries in place", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'traces-'));
  const server = await serve([
    { text: 'Searching…', calls: [{ name: 'search_products', input: { query: 'red' } }] },
    { text: 'One shoe.', calls: [{ name: 'present_items', input: { entity: 'product', ids: [1] } }] },
  ], dir);
  try {
    const client = new FakeClient(server.send, { site: 'example-shop', validate: validateMessage, results: shopResults });
    const turn = await client.turn('red shoes', HOME);
    assert.equal(turn.answer?.text, 'One shoe.');
    const sessionFiles = readdirSync(path.join(dir, 'example-shop', '2026-11-05'));
    assert.equal(sessionFiles.length, 1);
    const lines = readLines(path.join(dir, 'example-shop', '2026-11-05', sessionFiles[0]!));
    const kinds = lines.map(kindOf);
    // The message comes before anything the brain logs about it.
    assert.deepEqual(kinds.slice(0, 2), ['in:turn', 'log:session_start']);
    const link = kinds.filter((kind) => !kind.startsWith('log:'));
    assert.deepEqual(link, ['in:turn', 'out:tool_call', 'out:progress', 'out:await_results', 'in:results', 'out:answer']);
    assert.ok(kinds.includes('log:model_step') && kinds.includes('log:turn_end'));
    assert.ok(lines.every((line) => line.at === TODAY.toISOString()));
  } finally {
    await server.close();
  }
});

test('a refused message is kept with its refusal; one with no session ID goes to unmatched.jsonl', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'traces-'));
  const server = await serve([], dir);
  try {
    const response = await fetch(`${server.base}/v1/turn`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'turn' }) });
    assert.equal(response.status, 400);
    const lines = readLines(path.join(dir, 'example-shop', '2026-11-05', 'unmatched.jsonl'));
    assert.deepEqual(lines.map(kindOf), ['in:turn', 'refused']);
    assert.ok('refused' in lines[1]! && lines[1].refused.status === 400 && /protocol/.test(lines[1].refused.error));
  } finally {
    await server.close();
  }
});

test('a session the brain forgot while idle and reopened under the same ID keeps every line in its own file', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'traces-'));
  const clock = { now: NOW };
  const server = await serve([{ text: 'Hello.' }, { text: 'Hello again.' }], dir, clock);
  try {
    const client = new FakeClient(server.send, { site: 'example-shop', validate: validateMessage, results: shopResults });
    assert.equal((await client.turn('hi', HOME)).answer?.text, 'Hello.');
    clock.now += 2 * 60_000;
    assert.equal((await client.turn('still there?', HOME)).answer?.text, 'Hello again.');
    const files = readdirSync(path.join(dir, 'example-shop', '2026-11-05'));
    assert.deepEqual(files.filter((file) => file !== 'unmatched.jsonl').length, 1);
    assert.ok(!files.includes('unmatched.jsonl'), 'nothing lost its session');
    const kinds = readLines(path.join(dir, 'example-shop', '2026-11-05', files[0]!)).map(kindOf);
    assert.deepEqual(kinds.filter((kind) => !kind.startsWith('log:') || kind === 'log:session_forgotten'), ['in:turn', 'out:answer', 'in:turn', 'log:session_forgotten', 'out:answer']);
  } finally {
    await server.close();
  }
});

test('retention: date folders older than the limit are deleted at start; newer ones and other folders stay', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'traces-'));
  for (const name of ['2026-09-01', '2026-10-05', '2026-10-06', '2026-11-05', 'drafts']) {
    mkdirSync(path.join(dir, 'example-shop', name), { recursive: true });
    writeFileSync(path.join(dir, 'example-shop', name, 'sess_x.jsonl'), '{}\n');
  }
  new TraceWriter({ dir, site: 'example-shop', keepDays: 30, now: () => TODAY });
  assert.deepEqual(readdirSync(path.join(dir, 'example-shop')).sort(), ['2026-10-06', '2026-11-05', 'drafts']);
});

test("file names: a session ID the client made up can't leave the traces folder", () => {
  assert.equal(traceFileName('sess_48206878-8af2'), 'sess_48206878-8af2.jsonl');
  assert.equal(traceFileName('../../etc/passwd'), '______etc_passwd.jsonl');
  assert.equal(traceFileName(undefined), 'unmatched.jsonl');
});

test("a trace that can't be written never stops serving", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'traces-'));
  writeFileSync(path.join(dir, 'example-shop'), 'a file where the site folder should be');
  const originalError = console.error;
  const reported: string[] = [];
  console.error = (message: string) => reported.push(message);
  const server = await serve([{ text: 'Hello.' }], dir);
  try {
    const client = new FakeClient(server.send, { site: 'example-shop', validate: validateMessage, results: shopResults });
    const turn = await client.turn('hi', HOME);
    assert.equal(turn.answer?.text, 'Hello.');
    assert.equal(reported.length, 1, 'reported once');
  } finally {
    console.error = originalError;
    await server.close();
  }
});
