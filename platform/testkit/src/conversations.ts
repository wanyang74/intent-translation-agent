// Example conversations: a site's user turns and the protocol messages that should follow, with the fixtures
// that answer the tool calls. They live in sites/<id>/conversations/*.json. Phase 1 checks that they are
// well formed against the platform protocol and the site pack; later phases replay them (core.js runs the tool
// calls against FakeHost and must produce the same results; the brain is scored on the same turns).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { Message, PageContext, PresentationCall } from '../../contract/generated/types.ts';
import { describeErrors, type Contract } from '../../contract/src/load.ts';
import { valuesAt } from '../../contract/src/paths.ts';
import { PRESENTATION_TOOLS, sitesDir, type SitePack } from '../../contract/src/site-pack.ts';
import { hasFixtures, loadFixtures } from './fixtures.ts';

export interface Conversation {
  id: string;
  site: string;
  description: string;
  /** The time the brain is told it is (ISO 8601). Relative dates ("by Saturday") are relative to it, and IDs that expired before it can't be used. */
  now?: string;
  /** The fixtures that answer the tool calls. */
  fixtures: string[];
  /** What the page the user is on carries about the item on screen, as the host's page reader would return it. */
  pageData?: unknown;
  notes?: string[];
  messages: Message[];
}

export const conversationDir = (site: string) => path.join(sitesDir, site, 'conversations');

export function loadConversations(site: string): Conversation[] {
  const dir = conversationDir(site);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((file) => file.endsWith('.json')).sort()
    .map((file) => JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as Conversation);
}

type Entity = NonNullable<SitePack['entities'][string]>;
type IdPath = { kind: string; path: string; expiresAt?: string };

/** IDs at the given paths, each with its expiry when the path declares one (paired by position). */
function idsWithExpiry(value: unknown, idPaths: IdPath[] | undefined) {
  return (idPaths ?? []).flatMap(({ kind, path: valuePath, expiresAt }) => {
    const ids = valuesAt(value, valuePath);
    const expiries = expiresAt ? valuesAt(value, expiresAt) : [];
    return ids.map((id, i) => ({ kind, id: id as string | number, expiresAt: typeof expiries[i] === 'string' ? (expiries[i] as string) : undefined }));
  });
}

/** Fields a presentation call puts on screen: the card's fields, or a comparison's attributes. */
function fieldsShown(presentation: PresentationCall, entity: Entity | undefined): string[] {
  if (presentation.name === 'present_comparison') return presentation.args.attributes;
  if (presentation.name === 'present_items' || presentation.name === 'present_options' || presentation.name === 'present_detail') return entity?.card?.fields ?? [];
  return [];
}

/**
 * Problems with a conversation, or none. Checks that every message matches the platform protocol, that tools
 * exist in the site pack and get valid arguments and results, that presentation calls name entity kinds, fields,
 * sections, forms and notices the site pack declares, that every ID used or shown came from an earlier tool
 * result or the page context (and hadn't expired), that notices appear with the fields they explain, and that
 * calls, awaits and results line up.
 */
export function checkConversation(contract: Contract, conversation: Conversation): string[] {
  const problems: string[] = [];
  const add = (where: string, msg: string) => problems.push(`${conversation.site}/${conversation.id}: ${where}: ${msg}`);
  const site = contract.sites[conversation.site];
  if (!site) return [`${conversation.id}: unknown site ${conversation.site}`];
  const { pack } = site;
  const validateMessage = contract.validator('messages.json');
  const now = conversation.now ? Date.parse(conversation.now) : null;
  if (conversation.now !== undefined && Number.isNaN(now)) add('now', `${conversation.now} isn't a date`);

  const fixtureIds = new Set(hasFixtures(conversation.site) ? loadFixtures(conversation.site).map((fixture) => fixture.id) : []);
  for (const id of conversation.fixtures) if (!fixtureIds.has(id)) add('fixtures', `no fixture ${id}`);

  // IDs the session has seen, by kind, with their expiry if they have one.
  const known = new Map<string, string | null>();
  const key = (kind: string, id: unknown) => `${kind}:${String(id)}`;
  const learn = (kind: string, id: unknown, expiresAt?: string) => known.set(key(kind, id), expiresAt ?? null);
  const checkKnown = (where: string, what: string, kind: string, id: unknown) => {
    if (!known.has(key(kind, id))) return add(where, `${what} ${kind} ${JSON.stringify(id)}, which no earlier tool result or page context gave`);
    const expiresAt = known.get(key(kind, id));
    if (expiresAt && now !== null && Date.parse(expiresAt) <= now) add(where, `${what} ${kind} ${JSON.stringify(id)}, which expired at ${expiresAt}`);
  };
  const checkIdShape = (where: string, kind: string, id: unknown) => {
    const spec = pack.entities[kind]?.id;
    if (!spec) return;
    const ok = spec.type === 'integer' ? Number.isInteger(id) : typeof id === 'string' && (!spec.pattern || new RegExp(spec.pattern).test(id));
    if (!ok) add(where, `${JSON.stringify(id)} isn't a valid ${kind} id`);
  };

  let sessionId: string | undefined;
  let traceId: string | undefined;
  let open = false;
  let page: PageContext | undefined;
  let pending: string[] = [];
  let callsThisTurn = 0;
  const traces = new Set<string>();
  const calls = new Map<string, { name: string; traceId: string; awaited: boolean; answered: boolean }>();

  conversation.messages.forEach((message, i) => {
    const where = `message ${i} (${(message as { type?: string }).type ?? '?'})`;
    if (!validateMessage(message)) return add(where, `doesn't match the protocol: ${describeErrors(validateMessage.errors)}`);
    if (message.type !== 'turn' && message.traceId !== traceId) add(where, `trace ${message.traceId} isn't the current turn's (${traceId})`);
    if (message.type !== 'turn' && message.type !== 'results' && message.type !== 'amend' && message.type !== 'amended' && !open) add(where, 'comes after the turn was answered');

    switch (message.type) {
      case 'turn': {
        if (open) add(where, 'a new turn before the previous one was answered');
        if (message.site !== conversation.site) add(where, `site is ${message.site}, not ${conversation.site}`);
        if (sessionId && message.sessionId !== sessionId) add(where, 'the session changed mid-conversation');
        if (traces.has(message.traceId)) add(where, `trace ${message.traceId} was used before`);
        sessionId = message.sessionId; traceId = message.traceId; open = true; page = message.pageContext; callsThisTurn = 0;
        traces.add(message.traceId);
        if (!pack.site.pageTypes?.includes(page.pageType)) add(where, `page type ${page.pageType} isn't one of the site's`);
        if (!pack.site.origins.some((origin) => page!.url.startsWith(origin))) add(where, `page ${page.url} isn't on the site`);
        if (page.entity) {
          if (!pack.entities[page.entity.kind]) add(where, `unknown entity kind ${page.entity.kind}`);
          checkIdShape(where, page.entity.kind, page.entity.id);
          learn(page.entity.kind, page.entity.id);
        }
        break;
      }
      case 'tool_call': {
        const { id, name, args } = message.call;
        if (calls.has(id)) add(where, `call id ${id} was used before`);
        calls.set(id, { name, traceId: message.traceId, awaited: false, answered: false });
        if (++callsThisTurn > pack.policies.callBudget.perTask) add(where, `more tool calls than the per-task budget (${pack.policies.callBudget.perTask})`);
        const tool = pack.tools[name];
        if (!tool) {
          add(where, PRESENTATION_TOOLS.includes(name) ? `${name} is a presentation tool; it belongs in an answer` : `${name} isn't a ${conversation.site} tool`);
          break;
        }
        const validate = contract.siteValidator(conversation.site, tool.input);
        if (!validate(args)) add(where, `${name} arguments: ${describeErrors(validate.errors)}`);
        for (const found of idsWithExpiry(args, tool.ids?.input)) checkKnown(where, `${name} uses`, found.kind, found.id);
        if (tool.sideEffect === 'write' && pack.policies.writes === 'none') add(where, `${name} writes, and the site pack allows no writes`);
        break;
      }
      case 'progress':
      case 'amend':
      case 'amended':
        break;
      case 'await_results': {
        if (pending.length) add(where, 'awaits again before the previous results arrived');
        for (const id of message.callIds) {
          const call = calls.get(id);
          if (!call) add(where, `awaits ${id}, which was never called`);
          else if (call.answered || call.awaited) add(where, `awaits ${id} twice`);
          else if (call.traceId !== message.traceId) add(where, `awaits ${id} from another turn`);
          else call.awaited = true;
        }
        pending = [...message.callIds];
        break;
      }
      case 'results': {
        if (message.sessionId !== sessionId) add(where, `session ${message.sessionId} isn't the conversation's`);
        const answered = message.results.map((result) => result.id);
        if ([...answered].sort().join() !== [...pending].sort().join()) add(where, `answers [${answered}] but the server awaited [${pending}]`);
        pending = [];
        for (const result of message.results) {
          const call = calls.get(result.id);
          if (!call) continue;
          call.answered = true;
          const tool = pack.tools[call.name];
          if (!tool) continue;
          if (result.ok) {
            const validate = contract.siteValidator(conversation.site, tool.output);
            if (!validate(result.output)) add(where, `${call.name} output: ${describeErrors(validate.errors)}`);
            for (const found of idsWithExpiry(result.output, tool.ids?.output)) learn(found.kind, found.id, found.expiresAt);
            if (tool.signIn && page?.signedIn !== true) add(where, `${call.name} needs sign-in and the user isn't signed in: expect an auth_required error`);
          } else if (result.error.reason) {
            const declared = tool.errors?.[result.error.reason];
            if (!declared) add(where, `${call.name} has no error ${result.error.reason}`);
            else if (declared.code !== result.error.code) add(where, `${call.name} error ${result.error.reason} has code ${declared.code}, not ${result.error.code}`);
          }
        }
        break;
      }
      case 'answer': {
        if (pending.length) add(where, `answers while results for [${pending}] are pending`);
        const present = message.present ?? [];
        const notices = new Set(present.flatMap((presentation) => (presentation.name === 'present_notice' ? [presentation.args.notice] : [])));
        const shown = new Set<string>();
        for (const [j, presentation] of present.entries()) {
          const at = `${where} present[${j}] ${presentation.name}`;
          if (presentation.name === 'present_notice') {
            if (!pack.notices?.[presentation.args.notice]) add(at, `unknown notice ${presentation.args.notice}`);
            continue;
          }
          if (presentation.name === 'present_form') {
            const form = pack.forms?.[presentation.args.form];
            if (!form) { add(at, `unknown form ${presentation.args.form}`); continue; }
            for (const field of Object.keys(presentation.args.prefill ?? {})) if (!form.fields[field]) add(at, `form ${presentation.args.form} has no field ${field}`);
            continue;
          }
          const kind = presentation.args.entity;
          const entity = pack.entities[kind];
          if (!entity) { add(at, `unknown entity kind ${kind}`); continue; }
          if (entity.internal) add(at, `${kind} is internal and is never shown`);
          if (entity.requiresSignIn && page?.signedIn !== true) add(at, `${kind} needs sign-in and the user isn't signed in`);
          const ids = presentation.name === 'present_detail' ? [presentation.args.id] : presentation.args.ids;
          for (const id of ids) { checkIdShape(at, kind, id); checkKnown(at, 'shows', kind, id); }
          if (presentation.name === 'present_comparison') for (const attribute of presentation.args.attributes) if (!entity.fields?.[attribute]) add(at, `${kind} has no field ${attribute}`);
          if (presentation.name === 'present_detail') for (const section of presentation.args.sections ?? []) if (!entity.sections?.includes(section)) add(at, `${kind} has no section ${section}`);
          for (const field of fieldsShown(presentation, entity)) shown.add(field);
        }
        for (const [name, notice] of Object.entries(pack.notices ?? {})) {
          const needed = notice?.showWith?.filter((field) => shown.has(field)) ?? [];
          if (needed.length && !notices.has(name)) add(where, `shows ${needed.join(', ')} without the ${name} notice`);
        }
        open = false;
        break;
      }
      case 'error':
        open = false;
        break;
    }
  });
  if (open) add('end', 'the last turn has no answer');
  for (const [id, call] of calls) if (!call.answered) add('end', `call ${id} (${call.name}) never got a result`);
  return problems;
}
