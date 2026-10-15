// A Host for tests: requests go to FakeHost, time is virtual (sleepers wake in time order and the clock jumps to each,
// so rate limits cost no real time), IDs are predictable, and the page's data, the brain and the sandbox can be supplied.
import type { Host, LogEntry, ScriptRunner } from '../../core/src/host.ts';
import { FakeHost } from './fake-host.ts';
import type { Fixture } from './fixtures.ts';
import { VirtualClock } from './virtual-clock.ts';

export interface TestHostOptions {
  site: string;
  fixtures?: Fixture[];
  /** The clock's start: a time in ms, or an ISO date. */
  start?: number | string;
  pageData?: unknown;
  brain?: Host['brain'];
  scripts?: ScriptRunner;
  verifyConfig?: Host['verifyConfig'];
}

export interface TestHost {
  host: Host;
  fake: FakeHost;
  clock: VirtualClock;
  /** Every entry core.js wrote to the development log. */
  log: LogEntry[];
  /** Total virtual time spent waiting, in ms. */
  slept: () => number;
}

export function testHost(o: TestHostOptions): TestHost {
  const fake = new FakeHost(o.site, o.fixtures);
  const clock = new VirtualClock(typeof o.start === 'string' ? Date.parse(o.start) : o.start ?? Date.UTC(2026, 9, 14, 12));
  const log: LogEntry[] = [];
  let ids = 0;
  let slept = 0;
  const host: Host = {
    request: (req) => fake.request(req),
    now: () => clock.now(),
    sleep: (ms) => {
      slept += ms;
      return clock.sleep(ms);
    },
    randomId: () => `00000000-0000-4000-9000-${String(++ids).padStart(12, '0')}`,
    pageData: () => o.pageData ?? null,
    log: (entry) => log.push(entry),
  };
  if (o.brain) host.brain = o.brain;
  if (o.scripts) host.scripts = o.scripts;
  if (o.verifyConfig) host.verifyConfig = o.verifyConfig;
  return { host, fake, clock, log, slept: () => slept };
}
