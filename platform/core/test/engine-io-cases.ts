// core.js's I/O written to run in any engine: every example conversation, played through runTurn with FakeBrain as
// the brain, FakeSurface as the surface, and the site's recorded responses as the network. engines.test.ts runs this
// in a bare Node context, QuickJS and JavaScriptCore; each must give exactly what Node gives.
import type { SitePack } from '../../contract/generated/types.ts';
import type { Conversation } from '../../testkit/src/conversations.ts';
import { FakeBrain } from '../../testkit/src/fake-brain.ts';
import { FakeSurface } from '../../testkit/src/fake-surface.ts';
import { runTurn, startSession, type SiteCode } from '../src/index.ts';
import { recordedHost, type RecordedResponse } from './engine-host.ts';

export interface IoCase {
  pack: SitePack;
  code: SiteCode;
  siteValidators: Record<string, unknown>;
  conversation: Conversation;
  recorded: RecordedResponse[];
}

export async function runIoCases(cases: IoCase[], platformValidators: Record<string, unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const c of cases) {
    const brain = new FakeBrain(c.conversation);
    const host = recordedHost(c.pack, c.recorded, Date.parse(c.conversation.now!), c.conversation.pageData);
    host.brain = brain.brain;
    const { session } = await startSession({ pack: c.pack, site: c.code, validators: { platform: platformValidators, site: c.siteValidators }, host });
    const surface = new FakeSurface();
    const outcomes: unknown[] = [];
    for (const m of c.conversation.messages) {
      if (m.type !== 'turn') continue;
      session.setPage(m.pageContext);
      outcomes.push(await runTurn(session, m.message, surface));
    }
    out.push({ conversation: c.conversation.id, outcomes, differences: brain.differences, finished: brain.finished, events: surface.events, calls: host.calls });
  }
  return out;
}
