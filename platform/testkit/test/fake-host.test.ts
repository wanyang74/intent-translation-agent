// FakeHost, on every site's fixtures: replays them exactly, ignores per-call IDs, enforces the contract,
// fails loudly on a request it can't answer, and injects faults. Site-specific behavior (the errors a site
// returned live) is tested in sites/<id>/test/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadContract } from '../../contract/src/load.ts';
import { entriesOf, matchKey, requestValue } from '../../contract/src/site-pack.ts';
import { FakeHost } from '../src/fake-host.ts';
import { type Fixture, hasFixtures, loadFixtures, toHostRequest } from '../src/fixtures.ts';

const contract = loadContract();
const sites = Object.keys(contract.sites).filter(hasFixtures);
const json = (s: string) => JSON.parse(s);

for (const site of sites) {
  const { pack, schemas } = contract.sites[site]!;
  const fixtures = loadFixtures(site);
  const answering = fixtures.filter((f) => !f.trigger);
  const keyOf = (f: Fixture) => `${f.endpoint} ${matchKey(pack.endpoints[f.endpoint]!, requestValue(pack, f.request))}`;

  test(`${site}: every fixture is the one that answers its own request, exactly`, async () => {
    const host = new FakeHost(site, fixtures);
    for (const f of answering) {
      const res = await host.request(toHostRequest(f));
      assert.equal(host.calls.at(-1)?.fixtureId, f.id, `${f.id} is shadowed by a fixture with the same match key`);
      assert.equal(res.status, f.response.status, f.id);
      const body = typeof f.response.body === 'string' ? res.body : json(res.body);
      assert.deepEqual(body, f.response.body, f.id);
    }
  });

  test(`${site}: fresh per-call IDs don't change which fixture answers`, async () => {
    const host = new FakeHost(site, fixtures);
    const fields = new Set(pack.recording.scrubFields);
    let n = 0;
    const fresh = () => `ffffffff-0000-4000-8000-${String(++n).padStart(12, '0')}`;
    const freshen = (v: unknown): unknown => Array.isArray(v) ? v.map(freshen)
      : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fields.has(k) && typeof x === 'string' ? fresh() : freshen(x)]))
      : v;
    for (const f of answering.filter((x) => x.request.body)) {
      const body = freshen(f.request.body);
      if (JSON.stringify(body) === JSON.stringify(f.request.body)) continue;
      await host.request(toHostRequest(f, body));
      assert.equal(host.calls.at(-1)?.fixtureId, f.id, f.id);
    }
  });

  test(`${site}: a request that breaks the contract gets a 400, never a recorded success`, async () => {
    const host = new FakeHost(site, fixtures);
    let checked = 0;
    for (const [name, endpoint] of entriesOf(pack.endpoints)) {
      const required = (schemas.find((s) => s.rel === endpoint.request)?.doc.required ?? []) as string[];
      const f = answering.find((x) => x.endpoint === name && required.length);
      if (!f) continue;
      const field = required[0]!;
      let req = toHostRequest(f);
      if (f.request.method === 'POST') {
        const body = structuredClone(f.request.body) as Record<string, unknown>;
        delete body[field];
        req = toHostRequest(f, body);
      } else {
        const url = new URL(f.request.url);
        if (!url.searchParams.has(field)) continue;
        url.searchParams.delete(field);
        req = { ...req, url: url.toString() };
      }
      const res = await host.request(req);
      assert.equal(res.status, 400, `${name} without ${field}`);
      checked++;
    }
    assert.ok(checked > 0, 'no endpoint to check');
  });

  test(`${site}: a request with no matching fixture fails loudly and names the endpoint`, async () => {
    const f = answering[0]!;
    const others = fixtures.filter((x) => x.trigger || keyOf(x) !== keyOf(f));
    const host = new FakeHost(site, others);
    await assert.rejects(host.request(toHostRequest(f)), (err: Error) => {
      assert.match(err.message, new RegExp(`no ${f.endpoint} fixture matches`));
      for (const o of others.filter((x) => x.endpoint === f.endpoint && !x.trigger)) {
        assert.ok(err.message.includes(keyOf(o).slice(f.endpoint.length + 1)), `lists ${o.id}`);
      }
      return true;
    });
  });

  test(`${site}: a URL outside the site pack is an error, not a guess`, async () => {
    const host = new FakeHost(site, fixtures);
    const origin = pack.site.origins[0]!;
    await assert.rejects(host.request({ method: 'GET', url: `${origin}/no/such/endpoint` }), /no .* endpoint matches/);
  });

  test(`${site}: injected faults apply to the next matching calls only`, async () => {
    const host = new FakeHost(site, fixtures);
    const a = answering[0]!;
    const b = answering.find((x) => x.endpoint !== a.endpoint);

    host.inject({ endpoint: a.endpoint, status: 429, headers: { 'retry-after': '30' } });
    if (b) assert.equal((await host.request(toHostRequest(b))).status, b.response.status, 'a fault on one endpoint must not hit others');
    assert.equal((await host.request(toHostRequest(a))).status, 429);
    assert.equal((await host.request(toHostRequest(a))).status, a.response.status, 'the fault applies once by default');

    host.inject({ endpoint: a.endpoint, networkError: 'socket hang up', times: 2 });
    await assert.rejects(host.request(toHostRequest(a)), /socket hang up/);
    await assert.rejects(host.request(toHostRequest(a)), /socket hang up/);
    assert.equal((await host.request(toHostRequest(a))).status, a.response.status);

    host.inject({ delayMs: 120 });
    const t0 = Date.now();
    await host.request(toHostRequest(a));
    assert.ok(Date.now() - t0 >= 110, 'delay applies');
  });

  test(`${site}: the call log records each call and which fixture answered it`, async () => {
    const host = new FakeHost(site, fixtures);
    const picks = answering.slice(0, 2);
    for (const f of picks) await host.request(toHostRequest(f));
    assert.deepEqual(host.calls.map((c) => [c.endpoint, c.fixtureId, c.status]), picks.map((f) => [f.endpoint, f.id, f.response.status]));
  });
}
