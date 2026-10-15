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
  notes?: string[];
  messages: Message[];
}

export const conversationDir = (site: string) => path.join(sitesDir, site, 'conversations');

export function loadConversations(site: string): Conversation[] {
  const dir = conversationDir(site);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as Conversation);
}

type Entity = NonNullable<SitePack['entities'][string]>;
type IdPath = { kind: string; path: string; expiresAt?: string };

/** IDs at the given paths, each with its expiry when the path declares one (paired by position). */
function idsWithExpiry(value: unknown, idPaths: IdPath[] | undefined) {
  return (idPaths ?? []).flatMap(({ kind, path: p, expiresAt }) => {
    const ids = valuesAt(value, p);
    const expiries = expiresAt ? valuesAt(value, expiresAt) : [];
    return ids.map((id, i) => ({ kind, id: id as string | number, expiresAt: typeof expiries[i] === 'string' ? (expiries[i] as string) : undefined }));
  });
}

/** Fields a presentation call puts on screen: the card's fields, or a comparison's attributes. */
function fieldsShown(p: PresentationCall, entity: Entity | undefined): string[] {
  if (p.name === 'present_comparison') return p.args.attributes;
  if (p.name === 'present_items' || p.name === 'present_options' || p.name === 'present_detail') return entity?.card?.fields ?? [];
  return [];
}

/**
 * Problems with a conversation, or none. Checks that every message matches the platform protocol, that tools
 * exist in the site pack and get valid arguments and results, that presentation calls name entity kinds, fields,
 * sections, forms and notices the site pack declares, that every ID used or shown came from an earlier tool
 * result or the page context (and hadn't expired), that notices appear with the fields they explain, and that
 * calls, awaits and results line up.
 */
export function checkConversation(contract: Contract, c: Conversation): string[] {
  const problems: string[] = [];
  const add = (where: string, msg: string) => problems.push(`${c.site}/${c.id}: ${where}: ${msg}`);
  const site = contract.sites[c.site];
  if (!site) return [`${c.id}: unknown site ${c.site}`];
  const { pack } = site;
  const validateMessage = contract.validator('messages.json');
  const now = c.now ? Date.parse(c.now) : null;
  if (c.now !== undefined && Number.isNaN(now)) add('now', `${c.now} isn't a date`);

  const fixtureIds = new Set(hasFixtures(c.site) ? loadFixtures(c.site).map((f) => f.id) : []);
  for (const id of c.fixtures) if (!fixtureIds.has(id)) add('fixtures', `no fixture ${id}`);

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

  c.messages.forEach((m, i) => {
    const where = `message ${i} (${(m as { type?: string }).type ?? '?'})`;
    if (!validateMessage(m)) return add(where, `doesn't match the protocol: ${describeErrors(validateMessage.errors)}`);
    if (m.type !== 'turn' && m.traceId !== traceId) add(where, `trace ${m.traceId} isn't the current turn's (${traceId})`);
    if (m.type !== 'turn' && m.type !== 'results' && !open) add(where, 'comes after the turn was answered');

    switch (m.type) {
      case 'turn': {
        if (open) add(where, 'a new turn before the previous one was answered');
        if (m.site !== c.site) add(where, `site is ${m.site}, not ${c.site}`);
        if (sessionId && m.sessionId !== sessionId) add(where, 'the session changed mid-conversation');
        if (traces.has(m.traceId)) add(where, `trace ${m.traceId} was used before`);
        sessionId = m.sessionId; traceId = m.traceId; open = true; page = m.pageContext; callsThisTurn = 0;
        traces.add(m.traceId);
        if (!pack.site.pageTypes?.includes(page.pageType)) add(where, `page type ${page.pageType} isn't one of the site's`);
        if (!pack.site.origins.some((o) => page!.url.startsWith(o))) add(where, `page ${page.url} isn't on the site`);
        if (page.entity) {
          if (!pack.entities[page.entity.kind]) add(where, `unknown entity kind ${page.entity.kind}`);
          checkIdShape(where, page.entity.kind, page.entity.id);
          learn(page.entity.kind, page.entity.id);
        }
        break;
      }
      case 'tool_call': {
        const { id, name, args } = m.call;
        if (calls.has(id)) add(where, `call id ${id} was used before`);
        calls.set(id, { name, traceId: m.traceId, awaited: false, answered: false });
        if (++callsThisTurn > pack.policies.callBudget.perTask) add(where, `more tool calls than the per-task budget (${pack.policies.callBudget.perTask})`);
        const tool = pack.tools[name];
        if (!tool) {
          add(where, PRESENTATION_TOOLS.includes(name) ? `${name} is a presentation tool; it belongs in an answer` : `${name} isn't a ${c.site} tool`);
          break;
        }
        const validate = contract.siteValidator(c.site, tool.input);
        if (!validate(args)) add(where, `${name} arguments: ${describeErrors(validate.errors)}`);
        for (const x of idsWithExpiry(args, tool.ids?.input)) checkKnown(where, `${name} uses`, x.kind, x.id);
        if (tool.sideEffect === 'write' && pack.policies.writes === 'none') add(where, `${name} writes, and the site pack allows no writes`);
        break;
      }
      case 'progress':
        break;
      case 'await_results': {
        if (pending.length) add(where, 'awaits again before the previous results arrived');
        for (const id of m.callIds) {
          const call = calls.get(id);
          if (!call) add(where, `awaits ${id}, which was never called`);
          else if (call.answered || call.awaited) add(where, `awaits ${id} twice`);
          else if (call.traceId !== m.traceId) add(where, `awaits ${id} from another turn`);
          else call.awaited = true;
        }
        pending = [...m.callIds];
        break;
      }
      case 'results': {
        if (m.sessionId !== sessionId) add(where, `session ${m.sessionId} isn't the conversation's`);
        const answered = m.results.map((r) => r.id);
        if ([...answered].sort().join() !== [...pending].sort().join()) add(where, `answers [${answered}] but the server awaited [${pending}]`);
        pending = [];
        for (const r of m.results) {
          const call = calls.get(r.id);
          if (!call) continue;
          call.answered = true;
          const tool = pack.tools[call.name];
          if (!tool) continue;
          if (r.ok) {
            const validate = contract.siteValidator(c.site, tool.output);
            if (!validate(r.output)) add(where, `${call.name} output: ${describeErrors(validate.errors)}`);
            for (const x of idsWithExpiry(r.output, tool.ids?.output)) learn(x.kind, x.id, x.expiresAt);
            if (tool.signIn && page?.signedIn !== true) add(where, `${call.name} needs sign-in and the user isn't signed in: expect an auth_required error`);
          } else if (r.error.reason) {
            const declared = tool.errors?.[r.error.reason];
            if (!declared) add(where, `${call.name} has no error ${r.error.reason}`);
            else if (declared.code !== r.error.code) add(where, `${call.name} error ${r.error.reason} has code ${declared.code}, not ${r.error.code}`);
          }
        }
        break;
      }
      case 'answer': {
        if (pending.length) add(where, `answers while results for [${pending}] are pending`);
        const present = m.present ?? [];
        const notices = new Set(present.flatMap((p) => (p.name === 'present_notice' ? [p.args.notice] : [])));
        const shown = new Set<string>();
        for (const [j, p] of present.entries()) {
          const at = `${where} present[${j}] ${p.name}`;
          if (p.name === 'present_notice') {
            if (!pack.notices?.[p.args.notice]) add(at, `unknown notice ${p.args.notice}`);
            continue;
          }
          if (p.name === 'present_form') {
            const form = pack.forms?.[p.args.form];
            if (!form) { add(at, `unknown form ${p.args.form}`); continue; }
            for (const f of Object.keys(p.args.prefill ?? {})) if (!form.fields[f]) add(at, `form ${p.args.form} has no field ${f}`);
            continue;
          }
          const kind = p.args.entity;
          const entity = pack.entities[kind];
          if (!entity) { add(at, `unknown entity kind ${kind}`); continue; }
          if (entity.internal) add(at, `${kind} is internal and is never shown`);
          if (entity.requiresSignIn && page?.signedIn !== true) add(at, `${kind} needs sign-in and the user isn't signed in`);
          const ids = p.name === 'present_detail' ? [p.args.id] : p.args.ids;
          for (const id of ids) { checkIdShape(at, kind, id); checkKnown(at, 'shows', kind, id); }
          if (p.name === 'present_comparison') for (const a of p.args.attributes) if (!entity.fields?.[a]) add(at, `${kind} has no field ${a}`);
          if (p.name === 'present_detail') for (const s of p.args.sections ?? []) if (!entity.sections?.includes(s)) add(at, `${kind} has no section ${s}`);
          for (const f of fieldsShown(p, entity)) shown.add(f);
        }
        for (const [name, n] of Object.entries(pack.notices ?? {})) {
          const needed = n?.showWith?.filter((f) => shown.has(f)) ?? [];
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
