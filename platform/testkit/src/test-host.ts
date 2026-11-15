// A Host for tests: requests go to FakeHost, time is virtual (sleepers wake in time order and the clock jumps to each,
// so rate limits cost no real time), IDs are predictable, and the page's data, the brain and the sandbox can be supplied.
import type { Host, LogEntry, ScriptRunner } from '../../core/src/runtime/host.ts';
import { FAKE_PAGE_TOKEN, FakeHost } from './fake-host.ts';
import type { Fixture } from './fixtures.ts';
import { VirtualClock } from './virtual-clock.ts';

export interface TestHostOptions {
  site: string;
  fixtures?: Fixture[];
  /** The clock's start: a time in ms, or an ISO date. */
  start?: number | string;
  pageData?: unknown;
  /** The signed-in token the page keeps (Host.pageToken); null for none. Default: a made-up one. */
  pageToken?: string | null;
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

export function testHost(options: TestHostOptions): TestHost {
  const fake = new FakeHost(options.site, options.fixtures);
  const clock = new VirtualClock(typeof options.start === 'string' ? Date.parse(options.start) : options.start ?? Date.UTC(2026, 9, 14, 12));
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
    pageData: () => options.pageData ?? null,
    pageToken: async () => (options.pageToken === undefined ? FAKE_PAGE_TOKEN : options.pageToken),
    log: (entry) => log.push(entry),
  };
  if (options.brain) host.brain = options.brain;
  if (options.scripts) host.scripts = options.scripts;
  if (options.verifyConfig) host.verifyConfig = options.verifyConfig;
  return { host, fake, clock, log, slept: () => slept };
}
