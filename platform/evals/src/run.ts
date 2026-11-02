// Runs one eval case through the whole stack, the way phase 5 joined it: real core.js on a test host (FakeHost as the
// site), the real brain, and a model. The earlier turns of the case's conversation replay as saved (a FakeModel
// writes what the conversation's model wrote), then the case's message goes to the model under test. What comes back
// is a Trial: everything the graders need about the new turn, and nothing that depends on how it's graded.
import type { PresentationCall, ToolResult } from '../../contract/generated/types.ts';
import { validatorFor } from '../../core/src/shared/validate.ts';
import { runTurn, startSession } from '../../core/src/index.ts';
import type { UiComponent } from '../../core/src/present/present.ts';
import type { IdValue } from '../../core/src/boundary/ids.ts';
import { Brain } from '../../brain/src/agent/brain.ts';
import type { BrainLogEntry } from '../../brain/src/agent/types.ts';
import type { ModelAdapter, ModelEvent, ModelRequest } from '../../brain/src/model/model.ts';
import { loadSite, type SiteBundle } from '../../brain/src/prompt/site.ts';
import { loadConversations, type Conversation } from '../../testkit/src/conversations.ts';
import { inProcess } from '../../testkit/src/fake-client.ts';
import { FakeModel, scriptFromConversation, type FakeStep } from '../../testkit/src/fake-model.ts';
import { FakeSurface } from '../../testkit/src/fake-surface.ts';
import { loadFixtures, type Fixture } from '../../testkit/src/fixtures.ts';
import { LinkRecorder } from '../../testkit/src/link-recorder.ts';
import { loadSiteRuntime, type SiteRuntime } from '../../testkit/src/site-runtime.ts';
import { testHost } from '../../testkit/src/test-host.ts';
import { quickJsRunner } from '../../core/hosts/quickjs.ts';
import { editFixtures, type Category, type EvalCase } from './cases.ts';

/** Everything about one site that every case of it uses, loaded once. */
export interface SiteMaterials {
  id: string;
  bundle: SiteBundle;
  runtime: SiteRuntime;
  fixtures: Fixture[];
  conversations: Conversation[];
}

export async function loadSiteMaterials(id: string): Promise<SiteMaterials> {
  return { id, bundle: await loadSite(id), runtime: await loadSiteRuntime(id), fixtures: loadFixtures(id), conversations: loadConversations(id) };
}

export interface StepUsage {
  steps: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** What happened in a case's new turn. */
export interface Trial {
  site: string;
  caseId: string;
  category: Category;
  outcome: 'answer' | 'error' | 'none';
  answer: { text: string; present: PresentationCall[]; components: UiComponent[] } | null;
  /** The message the user saw when the turn failed. */
  errorMessage: string | null;
  /** Site tool calls the brain sent to core.js, in order. */
  calls: { name: string; args: unknown }[];
  progress: string[];
  /** Requests no fixture answers: the model took a path the recordings don't cover, so the case can't be judged. */
  fixtureMisses: string[];
  /** Messages on the link that break the protocol. */
  protocolProblems: string[];
  /** Calls and presentations the brain refused (the model may have recovered). */
  refusals: unknown[];
  /** Every tool output in the session and the page's data: the only sources a fact on screen may come from. */
  sources: unknown[];
  userMessages: string[];
  /** Every ID the session learned, of any kind: none of them belongs in the answer's text. */
  knownIds: IdValue[];
  usage: StepUsage;
  ms: number;
  /** What the model wrote in the new turn, step by step: replayable as a FakeModel script. */
  modelSteps: FakeStep[];
  /** Whether the device in this trial had a script sandbox. */
  scripts: boolean;
  /** A failure of the harness itself, not of the agent. */
  crash?: string;
}

/**
 * The device a case runs on. By default it matches the one users have today: no script sandbox, as in the Chrome
 * extension, so run_script isn't offered. With scripts on, core.js gets the QuickJS sandbox and the brain offers it.
 */
export interface Device {
  scripts: boolean;
}

export const USERS_DEVICE: Device = { scripts: false };

/**
 * The model for a case: it replays the conversation's model steps for the earlier turns, then hands each later
 * request to the model under test, keeping what that model writes.
 */
class ReplayThenModel implements ModelAdapter {
  readonly name: string;
  readonly written: FakeStep[] = [];
  private readonly replay: FakeModel;
  private readonly model: ModelAdapter;

  constructor(replay: FakeModel, model: ModelAdapter) {
    this.replay = replay;
    this.model = model;
    this.name = model.name;
  }

  async *stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
    if (this.replay.remaining > 0) {
      yield* this.replay.stream(request);
      return;
    }
    const step: FakeStep & { calls: NonNullable<FakeStep['calls']> } = { text: '', calls: [] };
    this.written.push(step);
    for await (const event of this.model.stream(request)) {
      if (event.type === 'text') step.text += event.text;
      else if (event.type === 'tool-call') step.calls.push({ name: event.name, input: event.input });
      yield event;
    }
  }
}

/** The conversation's model steps for its first `turns` user turns. */
function replayScript(conversation: Conversation, turns: number): FakeStep[] {
  let seen = 0;
  const end = conversation.messages.findIndex((message) => message.type === 'turn' && ++seen > turns);
  return scriptFromConversation({ ...conversation, messages: end < 0 ? conversation.messages : conversation.messages.slice(0, end) });
}

const NO_STEPS: StepUsage = { steps: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/**
 * Runs one case once. The surface sees every turn, the earlier ones too; pass one to keep what the user saw.
 *   1. The state: the conversation's earlier turns (if any), the clock, the page, and the fixtures with the case's edits.
 *   2. The brain, with the replaying model in front of the model under test, and a log.
 *   3. core.js on a test host (with the script sandbox when the device has one), its link to the brain recorded, and
 *      requests no fixture answers noted.
 *   4. The earlier turns, replayed; they must go as saved, or the harness is broken.
 *   5. The case's message, on its page, through runTurn.
 *   6. The Trial, from what crossed the link, what the user saw, and the brain's log, for the new turn only.
 */
export async function runCase(site: SiteMaterials, evalCase: EvalCase, model: ModelAdapter, surface = new FakeSurface(), device: Device = USERS_DEVICE): Promise<Trial> {
  // 1. The state.
  const conversation = evalCase.after ? site.conversations.find((candidate) => candidate.id === evalCase.after!.conversation) : undefined;
  if (evalCase.after && !conversation) throw new Error(`${evalCase.id}: no example conversation ${evalCase.after.conversation}`);
  const earlier = conversation ? conversation.messages.filter((message) => message.type === 'turn').slice(0, evalCase.after!.turns) : [];
  const now = Date.parse(evalCase.now ?? conversation?.now ?? '');
  const page = evalCase.page ?? earlier.at(-1)?.pageContext;
  if (Number.isNaN(now) || !page) throw new Error(`${evalCase.id}: no clock or no page`);
  const pageData = evalCase.pageData ?? conversation?.pageData ?? null;
  const fixtures = editFixtures(site.fixtures, evalCase.fixtures);

  // 2. The brain.
  const log: BrainLogEntry[] = [];
  const caseModel = new ReplayThenModel(new FakeModel(conversation ? replayScript(conversation, earlier.length) : [], { idPrefix: 'replay' }), model);
  const brain = new Brain({ site: site.bundle, model: caseModel, now: () => now, log: (entry) => log.push(entry) });

  // 3. core.js, its recorded link, and fixture misses.
  const recorder = new LinkRecorder(inProcess(brain));
  const harness = testHost({ site: site.id, fixtures, start: now, pageData, brain: recorder.send, ...(device.scripts ? { scripts: quickJsRunner() } : {}) });
  const fixtureMisses: string[] = [];
  const request = harness.host.request;
  harness.host.request = async (req) => {
    try {
      return await request(req);
    } catch (error) {
      const message = String((error as Error).message ?? error);
      if (message.startsWith('FakeHost: no ')) fixtureMisses.push(message.split('\n').slice(0, 2).join(' ').replace(/\s+/g, ' '));
      throw error;
    }
  };
  const { runtime } = site;
  const { session } = await startSession({ pack: runtime.pack, site: runtime.code, validators: runtime.validators, host: harness.host });

  // 4. The earlier turns, as saved.
  for (const turn of earlier) {
    session.setPage(turn.pageContext);
    const outcome = await runTurn(session, turn.message, surface);
    if (!outcome.ok) throw new Error(`${evalCase.id}: replaying ${conversation!.id} failed: ${outcome.reason}`);
  }

  // 5. The new turn.
  const trafficStart = recorder.traffic.length;
  const logStart = log.length;
  const surfaceStart = surface.events.length;
  const missesBefore = fixtureMisses.length;
  const started = performance.now();
  session.setPage(page);
  let crash: string | undefined;
  try {
    await runTurn(session, evalCase.message, surface);
  } catch (error) {
    crash = String(error);
  }
  const ms = Math.round(performance.now() - started);

  // 6. The Trial.
  const traffic = recorder.traffic.slice(trafficStart) as Record<string, any>[];
  const seen = surface.events.slice(surfaceStart);
  const shown = seen.find((event) => event.type === 'answer');
  const failed = seen.find((event) => event.type === 'error');
  const answerEvent = traffic.find((message) => message.type === 'answer');
  const validate = validatorFor(runtime.validators.platform, 'messages.json');
  const steps = log.slice(logStart).filter((entry) => entry.kind === 'model_step').map((entry) => entry.detail as Omit<StepUsage, 'steps'>);
  const usage = steps.reduce<StepUsage>((sum, step) => ({
    steps: sum.steps + 1, inputTokens: sum.inputTokens + step.inputTokens, outputTokens: sum.outputTokens + step.outputTokens,
    cacheReadTokens: sum.cacheReadTokens + step.cacheReadTokens, cacheWriteTokens: sum.cacheWriteTokens + step.cacheWriteTokens,
  }), NO_STEPS);
  const resultsMessages = (recorder.traffic as Record<string, any>[]).filter((message) => message.type === 'results');
  const knownIds = Object.keys(runtime.pack.entities).flatMap((kind) => session.ids.view().list(kind));
  return {
    site: site.id,
    caseId: evalCase.id,
    category: evalCase.category,
    outcome: shown ? 'answer' : failed ? 'error' : 'none',
    answer: shown?.type === 'answer' ? { text: shown.text, present: (answerEvent?.present ?? []) as PresentationCall[], components: shown.components } : null,
    errorMessage: failed?.type === 'error' ? failed.message : null,
    calls: traffic.filter((message) => message.type === 'tool_call').map((message) => ({ name: message.call.name as string, args: message.call.args as unknown })),
    progress: traffic.filter((message) => message.type === 'progress').map((message) => message.text as string),
    fixtureMisses: fixtureMisses.slice(missesBefore),
    protocolProblems: traffic.filter((message) => !validate(message)).map((message) => JSON.stringify(message).slice(0, 200)),
    refusals: log.slice(logStart).filter((entry) => entry.kind === 'call_refused' || entry.kind === 'presentation_refused').map((entry) => entry.detail),
    sources: [...resultsMessages.flatMap((message) => (message.results as ToolResult[]).flatMap((result) => (result.ok ? [result.output] : []))), pageData],
    userMessages: [...earlier.map((turn) => turn.message), evalCase.message],
    knownIds,
    usage,
    ms,
    modelSteps: caseModel.written,
    scripts: device.scripts,
    ...(crash ? { crash } : {}),
  };
}
