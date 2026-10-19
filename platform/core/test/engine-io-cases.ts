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
  for (const ioCase of cases) {
    const fakeBrain = new FakeBrain(ioCase.conversation);
    const host = recordedHost(ioCase.pack, ioCase.recorded, Date.parse(ioCase.conversation.now!), ioCase.conversation.pageData);
    host.brain = fakeBrain.brain;
    const { session } = await startSession({ pack: ioCase.pack, site: ioCase.code, validators: { platform: platformValidators, site: ioCase.siteValidators }, host });
    const surface = new FakeSurface();
    const outcomes: unknown[] = [];
    for (const entry of ioCase.conversation.messages) {
      if (entry.type !== 'turn') continue;
      session.setPage(entry.pageContext);
      outcomes.push(await runTurn(session, entry.message, surface));
    }
    out.push({ conversation: ioCase.conversation.id, outcomes, differences: fakeBrain.differences, finished: fakeBrain.finished, events: surface.events, calls: host.calls });
  }
  return out;
}
