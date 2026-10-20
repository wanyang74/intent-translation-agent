// Tests: FakeHost (testkit/src/fake-host.ts), the stand-in for a real site, on every site's fixtures.
// How: sends each fixture's own request, then variants: fresh per-call IDs, contract breaks, unknown requests and
// URLs, and injected faults.
// Passes when: fixtures replay exactly, per-call IDs are ignored, the contract is enforced, a request it can't answer
// fails loudly, and faults apply only where injected. Site-specific behavior (the errors a site returned live) is
// tested in sites/<id>/test/fake-host.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadContract } from '../../contract/src/load.ts';
import { entriesOf, matchKey, requestValue } from '../../contract/src/site-pack.ts';
import { FakeHost } from '../src/fake-host.ts';
import { type Fixture, hasFixtures, loadFixtures, toHostRequest } from '../src/fixtures.ts';

const contract = loadContract();
const sites = Object.keys(contract.sites).filter(hasFixtures);
const json = (text: string) => JSON.parse(text);

for (const site of sites) {
  const { pack, schemas } = contract.sites[site]!;
  const fixtures = loadFixtures(site);
  const answering = fixtures.filter((fixture) => !fixture.trigger);
  const keyOf = (fixture: Fixture) => `${fixture.endpoint} ${matchKey(pack.endpoints[fixture.endpoint]!, requestValue(pack, fixture.request))}`;

  test(`${site}: replay: each fixture answers its own request, exactly`, async () => {
    const host = new FakeHost(site, fixtures);
    for (const fixture of answering) {
      const res = await host.request(toHostRequest(fixture));
      assert.equal(host.calls.at(-1)?.fixtureId, fixture.id, `${fixture.id} is shadowed by a fixture with the same match key`);
      assert.equal(res.status, fixture.response.status, fixture.id);
      const body = typeof fixture.response.body === 'string' ? res.body : json(res.body);
      assert.deepEqual(body, fixture.response.body, fixture.id);
    }
  });

  test(`${site}: matching: fresh per-call IDs don't change which fixture answers`, async () => {
    const host = new FakeHost(site, fixtures);
    const fields = new Set(pack.recording.scrubFields);
    let count = 0;
    const fresh = () => `ffffffff-0000-4000-8000-${String(++count).padStart(12, '0')}`;
    const freshen = (value: unknown): unknown => Array.isArray(value) ? value.map(freshen)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, fields.has(key) && typeof child === 'string' ? fresh() : freshen(child)]))
      : value;
    for (const fixture of answering.filter((candidate) => candidate.request.body)) {
      const body = freshen(fixture.request.body);
      if (JSON.stringify(body) === JSON.stringify(fixture.request.body)) continue;
      await host.request(toHostRequest(fixture, body));
      assert.equal(host.calls.at(-1)?.fixtureId, fixture.id, fixture.id);
    }
  });

  test(`${site}: contract: a request that breaks it gets a 400, never a recorded success`, async () => {
    const host = new FakeHost(site, fixtures);
    let checked = 0;
    for (const [name, endpoint] of entriesOf(pack.endpoints)) {
      const required = (schemas.find((schema) => schema.rel === endpoint.request)?.doc.required ?? []) as string[];
      const fixture = answering.find((candidate) => candidate.endpoint === name && required.length);
      if (!fixture) continue;
      const field = required[0]!;
      let req = toHostRequest(fixture);
      if (fixture.request.method === 'POST') {
        const body = structuredClone(fixture.request.body) as Record<string, unknown>;
        delete body[field];
        req = toHostRequest(fixture, body);
      } else {
        const url = new URL(fixture.request.url);
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

  test(`${site}: no match: the request fails loudly and names the endpoint`, async () => {
    const recorded = answering[0]!;
    const others = fixtures.filter((fixture) => fixture.trigger || keyOf(fixture) !== keyOf(recorded));
    const host = new FakeHost(site, others);
    await assert.rejects(host.request(toHostRequest(recorded)), (err: Error) => {
      assert.match(err.message, new RegExp(`no ${recorded.endpoint} fixture matches`));
      for (const fixture of others.filter((candidate) => candidate.endpoint === recorded.endpoint && !candidate.trigger)) {
        assert.ok(err.message.includes(keyOf(fixture).slice(recorded.endpoint.length + 1)), `lists ${fixture.id}`);
      }
      return true;
    });
  });

  test(`${site}: unknown URL: one outside the site pack is an error, not a guess`, async () => {
    const host = new FakeHost(site, fixtures);
    const origin = pack.site.origins[0]!;
    await assert.rejects(host.request({ method: 'GET', url: `${origin}/no/such/endpoint` }), /no .* endpoint matches/);
  });

  test(`${site}: faults: injected ones apply to the next matching calls only`, async () => {
    const host = new FakeHost(site, fixtures);
    const recorded = answering[0]!;
    const fixture = answering.find((candidate) => candidate.endpoint !== recorded.endpoint);

    host.inject({ endpoint: recorded.endpoint, status: 429, headers: { 'retry-after': '30' } });
    if (fixture) assert.equal((await host.request(toHostRequest(fixture))).status, fixture.response.status, 'a fault on one endpoint must not hit others');
    assert.equal((await host.request(toHostRequest(recorded))).status, 429);
    assert.equal((await host.request(toHostRequest(recorded))).status, recorded.response.status, 'the fault applies once by default');

    host.inject({ endpoint: recorded.endpoint, networkError: 'socket hang up', times: 2 });
    await assert.rejects(host.request(toHostRequest(recorded)), /socket hang up/);
    await assert.rejects(host.request(toHostRequest(recorded)), /socket hang up/);
    assert.equal((await host.request(toHostRequest(recorded))).status, recorded.response.status);

    host.inject({ delayMs: 120 });
    const t0 = Date.now();
    await host.request(toHostRequest(recorded));
    assert.ok(Date.now() - t0 >= 110, 'delay applies');
  });

  test(`${site}: call log: records each call and which fixture answered it`, async () => {
    const host = new FakeHost(site, fixtures);
    const picks = answering.slice(0, 2);
    for (const fixture of picks) await host.request(toHostRequest(fixture));
    assert.deepEqual(host.calls.map((call) => [call.endpoint, call.fixtureId, call.status]), picks.map((fixture) => [fixture.endpoint, fixture.id, fixture.response.status]));
  });
}
