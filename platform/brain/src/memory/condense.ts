// Session memory: a condensed record of one conversation, kept after the brain forgets the session (30 minutes idle,
// or a restart), so the conversation can pick up where it left off when the same session ID comes back.
// condense() builds it from the session's own history, by code rather than by the model: no extra model call, and IDs,
// VINs and prices come through exactly. describeMemory() writes it out for the model at the start of the reopened
// session. store.ts keeps it on disk.
// What a memory keeps, per turn: the user's message (and anything they added while it ran), each tool call with its
// arguments, every ID the result carried (never cut: the IDs are what let the model act on earlier items without
// searching again), one line per returned item (its card title and short values, at most ITEM_LINES per call), the
// rest of the result in short form, what was shown, and the answer cut to ANSWER_CHARS. Fenced third-party text, such
// as reviews, is never copied. Personal data (sign-in mode) isn't kept either: a tool's personal fields become a
// placeholder, a script that read any becomes one whole, and so does the answer of a turn that read them, since the
// model's words repeat what it read.
// Rules: pure functions over data, no I/O. The memory is built on the server from the brain's own history and never
// comes from the device, so a tampered client can't invent earlier tool results.
import { valuesAt } from '../../../contract/src/paths.ts';
import { PERSONAL_PLACEHOLDER, redactPersonal } from '../../../contract/src/privacy.ts';
import { PRESENTATION_TOOLS } from '../../../contract/src/site-pack.ts';
import type { IdValue, KnownId } from '../../../core/src/boundary/ids.ts';
import { displayText } from '../../../core/src/present/present.ts';
import type { ChatMessage, ToolCallPart } from '../model/model.ts';
import { SCRIPT_TOOL, SKILL_TOOL } from '../prompt/prompt.ts';
import type { SiteBundle } from '../prompt/site.ts';
import type { SessionUsage } from '../system/quotas.ts';

export const MEMORY_VERSION = 1;
/** Item lines kept per tool call; the IDs past this are still listed, without their values. */
export const ITEM_LINES = 30;
export const ANSWER_CHARS = 300;
const MESSAGE_CHARS = 500;
const ITEM_CHARS = 300;
const DETAIL_CHARS = 1200;
const VALUE_CHARS = 120;
/** Turns kept; older ones are dropped, and their IDs stay valid through knownIds. */
const MAX_TURNS = 20;
/** The memory as the model reads it; past this, the oldest turns are written in short form. */
const MAX_TEXT_CHARS = 40_000;
/** The tag that marks the memory in a user message, so condense() can tell it from the user's words. */
export const MEMORY_TAG = '<earlier-conversation>';

/** One tool call in a memory. */
export interface MemoryCall {
  tool: string;
  args: unknown;
  /** Why the call failed, when it did: the error's reason or code. */
  error?: string;
  /** Every ID the result carried, in order, by kind. Never cut. */
  ids: { kind: string; id: IdValue }[];
  /** One line per returned item (at most ITEM_LINES): its card title and other short values, under its kind and ID. */
  items: { kind: string; id: IdValue; line: string }[];
  /** The rest of the result in short form: short values, lists cut, third-party text left out. */
  details: string;
}

/** One user message to its answer. */
export interface MemoryTurn {
  /** When the turn started, from its context block; null if unknown. */
  at: string | null;
  message: string;
  /** Messages the user sent while the turn ran. */
  amendments: string[];
  calls: MemoryCall[];
  /** What the answer showed: each presentation call in a few words. */
  shown: string[];
  /** The answer's text, cut to ANSWER_CHARS; null when the turn ended without one. */
  answer: string | null;
}

export interface SessionMemory {
  version: typeof MEMORY_VERSION;
  sessionId: string;
  site: string;
  /** When the memory was written, and when the conversation was last active (ms since the epoch). */
  savedAt: number;
  lastSeen: number;
  /** Usage so far, carried over so a reopened session still counts toward its quotas. */
  usage: SessionUsage;
  /** Every ID the conversation had, with expiries, to put back into the reopened session's checks. */
  knownIds: KnownId[];
  turns: MemoryTurn[];
  /** How many earlier turns were dropped to stay under MAX_TURNS. */
  droppedTurns: number;
}

export interface CondenseInput {
  sessionId: string;
  bundle: SiteBundle;
  history: readonly ChatMessage[];
  knownIds: KnownId[];
  usage: SessionUsage;
  /** The memory this session was reopened from, if any: its turns come first. */
  previous: SessionMemory | null;
  lastSeen: number;
  now: number;
}

const FENCED = /^<untrusted source=/;
const CONTEXT_TAG = '<context>';
const REMINDER_TAG = '<system-reminder>';
const AMENDMENT = /The user sent a new message while you were working:\n([\s\S]*?)(?=\n\nThe user sent a new message while you were working:|\n\nTake it into account)/g;

const cut = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/**
 * A value in short form, for the model to read: `key: value; key: [a, b, … +3 more]; key: {k: v}`. Third-party
 * (fenced) text and empty values are left out, long strings are cut, and the whole is cut to `max` characters.
 * `skip` leaves out top-level keys; `drop` leaves out keys at any depth (internal IDs such as routing tokens).
 */
export function compact(value: unknown, max: number, skip: ReadonlySet<string> = new Set(), drop: ReadonlySet<string> = new Set()): string {
  const write = (node: unknown, depth: number): string | null => {
    if (node === null || node === undefined) return null;
    if (typeof node === 'string') return FENCED.test(node) || node === '' ? null : cut(node, VALUE_CHARS);
    if (typeof node !== 'object') return String(node);
    if (depth >= 3) return '…';
    if (Array.isArray(node)) {
      const shown = node.slice(0, 5).map((item) => write(item, depth + 1)).filter((item): item is string => item !== null);
      if (!shown.length) return null;
      return `[${shown.join(', ')}${node.length > 5 ? `, … +${node.length - 5} more` : ''}]`;
    }
    const parts = Object.entries(node).filter(([key]) => !drop.has(key) && (depth > 0 || !skip.has(key)))
      .map(([key, child]) => [key, write(child, depth + 1)] as const).filter(([, child]) => child !== null).map(([key, child]) => `${key}: ${child}`);
    if (!parts.length) return null;
    return depth === 0 ? parts.join('; ') : `{${parts.join('; ')}}`;
  };
  return cut(write(value, 0) ?? '', max);
}

/** The keys a card template reads, such as year, make and model in "{year} {make} {model}". */
const templateKeys = (template: string | undefined) => new Set([...(template ?? '').matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((match) => match[1]!));

/** One returned item as a line: its kind and ID, its card title when the site pack gives one, then (in a list) its other short values. */
function itemLine(bundle: SiteBundle, kind: string, idKey: string, item: Record<string, unknown>, withValues: boolean, drop: ReadonlySet<string>): MemoryCall['items'][number] {
  const card = bundle.pack.entities[kind]?.card;
  const title = card ? displayText(card.title, item) : '';
  const skip = new Set([idKey, ...templateKeys(card?.title)]);
  const rest = withValues ? compact(item, ITEM_CHARS, skip, drop) : '';
  const id = item[idKey] as IdValue;
  return { kind, id, line: cut(`${kind} ${String(id)}${title ? `: ${title}` : ''}${rest ? ` — ${rest}` : ''}`, ITEM_CHARS) };
}

/**
 * One tool call and its result, condensed:
 *   1. A failed call keeps only why it failed.
 *   2. A script's result lists its IDs itself; everything else is short form.
 *   3. A site tool: every ID at the tool's output ID paths; a line per item those IDs sit in (internal kinds, such as
 *      routing tokens, get none); and the result's other fields in short form, leaving out the item lists.
 */
export function condenseCall(bundle: SiteBundle, tool: string, args: unknown, output: unknown, isError: boolean): MemoryCall {
  // 1. Failed.
  if (isError) {
    const error = output as { reason?: unknown; code?: unknown } | null;
    return { tool, args, error: String(error?.reason ?? error?.code ?? 'failed'), ids: [], items: [], details: '' };
  }
  // 2. A script.
  if (tool === SCRIPT_TOOL) {
    const script = output as { result?: unknown; knownIds?: Record<string, unknown[]> };
    const ids = Object.entries(script.knownIds ?? {}).flatMap(([kind, list]) => list.map((id) => ({ kind, id: id as IdValue })));
    return { tool, args, ids, items: [], details: compact(script.result, DETAIL_CHARS) };
  }
  // 3. A site tool. Internal IDs are listed but never written out, wherever they sit; nor is the platform's next-step
  //    hint, which is an instruction, not a result.
  const ids: MemoryCall['ids'] = [];
  const items: MemoryCall['items'] = [];
  const itemLists = new Set<string>(['nextStep']);
  const idPaths = bundle.pack.tools[tool]?.ids?.output ?? [];
  const drop = new Set(idPaths.filter((idPath) => bundle.pack.entities[idPath.kind]?.internal).map((idPath) => idPath.path.split('.').at(-1)!.replace(/\[\]$/, '')));
  for (const idPath of idPaths) {
    for (const id of valuesAt(output, idPath.path)) ids.push({ kind: idPath.kind, id: id as IdValue });
    // The item lists (vehicles[], coupons[]) are written as item and ID lines, so they're left out of the details.
    if (idPath.path.includes('[]')) itemLists.add(idPath.path.split('[]')[0]!.split('.')[0]!);
    // A path ending in [] lists bare IDs (coupons[]): there's no item to describe. Internal kinds are never described.
    const dot = idPath.path.lastIndexOf('.');
    const idKey = idPath.path.slice(dot + 1);
    if (idKey.endsWith('[]') || bundle.pack.entities[idPath.kind]?.internal) continue;
    const parent = dot < 0 ? '' : idPath.path.slice(0, dot);
    const holders = parent ? valuesAt(output, parent) : [output];
    for (const holder of holders) {
      if (items.length >= ITEM_LINES) break;
      if (holder && typeof holder === 'object' && !Array.isArray(holder) && (holder as Record<string, unknown>)[idKey] !== undefined) {
        // An ID at the top of the result (a details tool) is the result itself: its values are in the details.
        items.push(itemLine(bundle, idPath.kind, idKey, holder as Record<string, unknown>, parent !== '', drop));
      }
    }
  }
  return { tool, args, ids, items, details: compact(output, DETAIL_CHARS, itemLists, drop) };
}

/** A presentation call in a few words: what it showed, by ID, and its heading. */
function describeShown(call: ToolCallPart): string {
  const input = (call.input ?? {}) as { entity?: string; ids?: unknown[]; id?: unknown; heading?: string; notice?: string; form?: string; destination?: string };
  const what = input.ids ? `${input.entity} ${input.ids.join(', ')}` : input.id !== undefined ? `${input.entity} ${String(input.id)}` : input.notice ?? input.form ?? input.destination ?? '';
  return `${call.name} ${what}${input.heading ? ` ("${input.heading}")` : ''}`.trim();
}

/**
 * Condenses a session:
 *   1. Walk the history. A user message ending in a context block starts a turn; a reminder carries amendments; the
 *      memory a reopened session started from is skipped (its turns come from `previous`).
 *   2. Each tool call is matched to its result by the model's call ID. Skill loads are left out; presentation calls
 *      that were accepted become "shown"; the rest are condensed with condenseCall.
 *   3. A turn's answer is the text of its last model step, when that step called no site tool; a placeholder when the
 *      turn read personal data.
 *   4. The previous memory's turns come first; beyond MAX_TURNS, the oldest are dropped.
 */
export function condense(input: CondenseInput): SessionMemory {
  const { bundle } = input;
  const turns: MemoryTurn[] = [];
  let turn: MemoryTurn | null = null;
  let lastStep: { text: string; siteCalls: boolean } | null = null;
  const pending = new Map<string, ToolCallPart>();
  // Whether the current turn read personal data: then its answer isn't kept.
  let personal = false;
  const closeTurn = () => {
    if (turn && lastStep && !lastStep.siteCalls && lastStep.text) turn.answer = personal ? PERSONAL_PLACEHOLDER : cut(lastStep.text, ANSWER_CHARS);
  };
  // 1. The history.
  for (const message of input.history) {
    if (message.role === 'user') {
      const texts = message.content.map((part) => part.text);
      const context = texts.find((text) => text.startsWith(CONTEXT_TAG));
      if (context !== undefined) {
        closeTurn();
        const words = texts.filter((text) => !text.startsWith(CONTEXT_TAG) && !text.startsWith(MEMORY_TAG)).join('\n');
        turn = { at: /Time: (\S+)/.exec(context)?.[1] ?? null, message: cut(words, MESSAGE_CHARS), amendments: [], calls: [], shown: [], answer: null };
        turns.push(turn);
        lastStep = null;
        personal = false;
      } else if (turn) {
        for (const text of texts.filter((candidate) => candidate.startsWith(REMINDER_TAG))) {
          for (const match of text.matchAll(AMENDMENT)) turn.amendments.push(cut(match[1]!.trim(), MESSAGE_CHARS));
        }
      }
    } else if (message.role === 'assistant') {
      // 2. The calls, kept until their results arrive.
      const text = message.content.filter((part) => part.type === 'text').map((part) => part.text).join('').trim();
      const calls = message.content.filter((part): part is ToolCallPart => part.type === 'tool-call');
      for (const call of calls) pending.set(call.id, call);
      lastStep = { text, siteCalls: calls.some((call) => call.name !== SKILL_TOOL && !PRESENTATION_TOOLS.includes(call.name)) };
    } else if (turn) {
      for (const result of message.content) {
        const call = pending.get(result.id);
        pending.delete(result.id);
        if (!call || call.name === SKILL_TOOL) continue;
        if (PRESENTATION_TOOLS.includes(call.name)) {
          if (!result.isError) turn.shown.push(describeShown(call));
          continue;
        }
        // Personal fields are replaced before anything is condensed from the result.
        const tool = bundle.pack.tools[call.name];
        const script = call.name === SCRIPT_TOOL ? (result.output as { personal?: unknown } | null) : null;
        let output = result.output;
        if (!result.isError && tool?.privacy) {
          personal = true;
          output = redactPersonal(bundle.pack, call.name, output);
        } else if (!result.isError && script?.personal === true) {
          personal = true;
          output = { ...script, result: { personal: PERSONAL_PLACEHOLDER } };
        }
        turn.calls.push(condenseCall(bundle, call.name, call.input, output, result.isError));
      }
    }
  }
  // 3. The last turn's answer.
  closeTurn();
  // 4. Earlier memory first, then the cap.
  const all = [...(input.previous?.turns ?? []), ...turns];
  const dropped = Math.max(0, all.length - MAX_TURNS);
  return {
    version: MEMORY_VERSION, sessionId: input.sessionId, site: bundle.pack.site.id, savedAt: input.now, lastSeen: input.lastSeen,
    usage: { ...input.usage }, knownIds: input.knownIds.map((entry) => ({ ...entry })),
    turns: all.slice(dropped), droppedTurns: (input.previous?.droppedTurns ?? 0) + dropped,
  };
}

/** One turn as the model reads it; `short` keeps only the words and the IDs, for when the memory runs long. */
function describeTurn(bundle: SiteBundle, memoryTurn: MemoryTurn, number: number, short: boolean): string {
  const lines = [`Turn ${number}${memoryTurn.at ? ` (${memoryTurn.at})` : ''}. User: ${JSON.stringify(memoryTurn.message)}`];
  for (const amendment of memoryTurn.amendments) lines.push(`  The user added: ${JSON.stringify(amendment)}`);
  for (const call of memoryTurn.calls) {
    lines.push(`  ${call.tool} ${JSON.stringify(call.args)}${call.error ? ` → failed: ${call.error}` : ''}`);
    const listed = new Set<string>();
    if (!short) {
      for (const item of call.items) {
        lines.push(`    ${item.line}`);
        listed.add(`${item.kind} ${String(item.id)}`);
      }
    }
    // Every ID not already on an item line, by kind, so none is lost; internal kinds are only counted.
    const byKind = new Map<string, IdValue[]>();
    for (const { kind, id } of call.ids) if (!listed.has(`${kind} ${String(id)}`)) byKind.set(kind, [...(byKind.get(kind) ?? []), id]);
    for (const [kind, ids] of byKind) {
      const unique = [...new Set(ids)];
      lines.push(bundle.pack.entities[kind]?.internal ? `    (${unique.length} ${kind} IDs, internal)` : `    ${kind} IDs: ${unique.join(', ')}`);
    }
    if (!short && call.details) lines.push(`    other values: ${call.details}`);
  }
  if (memoryTurn.shown.length) lines.push(`  Shown: ${memoryTurn.shown.join('; ')}`);
  lines.push(`  Answer: ${memoryTurn.answer === null ? '(none: the turn ended without one)' : JSON.stringify(short ? cut(memoryTurn.answer, 120) : memoryTurn.answer)}`);
  return lines.join('\n');
}

/**
 * The memory as the model reads it, at the start of the reopened session:
 *   1. What this is and how old it is, and the two rules: the IDs still work, and values may have changed.
 *   2. Each turn in full; if that runs past MAX_TEXT_CHARS, the oldest turns in short form, one by one, until it fits.
 */
export function describeMemory(bundle: SiteBundle, memory: SessionMemory, now: number): string {
  // 1. The header.
  const minutes = Math.max(0, Math.round((now - memory.lastSeen) / 60_000));
  const header = [
    MEMORY_TAG,
    `This conversation started earlier. The brain kept this condensed record of it when it went idle; the full messages are gone. Last activity: ${new Date(memory.lastSeen).toISOString().replace(/\.\d{3}Z$/, 'Z')}, ${minutes} minutes before this message.`,
    "- The IDs below are still valid. Use them directly, for example to check items shown earlier, instead of searching again.",
    '- Prices, dates, availability and other values may have changed since: call the tools again before stating them.',
    '- Third-party text, such as reviews, was left out.',
    ...(memory.droppedTurns ? [`- ${memory.droppedTurns} earlier turns were left out for space; their IDs are still valid.`] : []),
  ].join('\n');
  // 2. The turns, shortened from the oldest while too long.
  const first = memory.droppedTurns + 1;
  const short = memory.turns.map(() => false);
  const write = () => [header, ...memory.turns.map((memoryTurn, i) => describeTurn(bundle, memoryTurn, first + i, short[i]!)), '</earlier-conversation>'].join('\n\n');
  let text = write();
  for (let i = 0; i < short.length && text.length > MAX_TEXT_CHARS; i++) {
    short[i] = true;
    text = write();
  }
  return text;
}
