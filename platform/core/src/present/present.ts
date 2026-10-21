// Respond (phase 4 on the flow chart): turns presentation calls into UI components the surface renders natively.
// A call carries only an entity kind, IDs and a layout; every value shown comes from this session's tool results,
// through the site pack's card templates and field definitions. A notice is added whenever a field it explains is on
// screen. A call that fails the boundary checks is left out, never shown half-checked.
import type { PresentationCall, SitePack, ToolError } from '../../../contract/generated/types.ts';
import { platformError } from '../boundary/errors.ts';
import { select } from '../../../contract/src/paths.ts';
import { checkPresentation, withRequiredNotices } from '../boundary/checks.ts';
import { checkContext } from '../execute/execute.ts';
import { buildLink, deepLink } from './links.ts';
import type { Session } from '../runtime/session.ts';
import type { EntityView, SectionContent } from '../execute/site-code.ts';
import { fill } from '../shared/text.ts';

type Entity = NonNullable<SitePack['entities'][string]>;
type Field = NonNullable<NonNullable<Entity['fields']>[string]>;

export interface FieldView {
  key: string;
  label: string;
  /** The value as the tools returned it; null when no tool returned one. */
  value: unknown;
  /** The value as the user reads it. */
  text: string;
  estimate?: boolean;
}

export interface CardView {
  id: string | number;
  title: string;
  subtitle?: string;
  fields: FieldView[];
  link?: string;
}

export interface DetailSection extends SectionContent {
  name: string;
  fields?: FieldView[];
}

export interface FormFieldView {
  key: string;
  label: string;
  type: string;
  required: boolean;
  options?: string[];
  min?: number;
  max?: number;
  value?: unknown;
}

export type UiComponent =
  | { type: 'items'; entity: string; heading?: string; layout: 'list' | 'cards' | 'carousel'; items: CardView[] }
  | { type: 'options'; entity: string; heading?: string; options: CardView[] }
  | { type: 'comparison'; entity: string; items: { id: string | number; title: string; link?: string }[]; rows: { key: string; label: string; cells: FieldView[] }[] }
  | { type: 'detail'; entity: string; card: CardView; sections: DetailSection[] }
  | { type: 'form'; form: string; heading?: string; submitTool?: string; fields: FormFieldView[] }
  | { type: 'notice'; notice: string; text: string; version?: string }
  /** A Take me there button: a page on the site, and the app's own route to it when the site pack has one. */
  | { type: 'destination'; destination: string; title: string; url: string; appRoute?: string };

export interface Presented {
  components: UiComponent[];
  /** Calls left out, and why. */
  refused: { call: PresentationCall; error: ToolError }[];
}

// ---------------------------------------------------------------- values as the user reads them

/** Digits grouped by thousands, without Intl (QuickJS has none). */
export function groupDigits(amount: number): string {
  const [whole, fraction] = Math.abs(amount).toString().split('.');
  return (amount < 0 ? '-' : '') + whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction ? `.${fraction}` : '');
}

export function formatMoney(amount: number): string {
  const cents = Math.round(Math.abs(amount) * 100);
  const whole = Math.floor(cents / 100);
  const rest = cents % 100;
  return `${amount < 0 ? '-' : ''}$${groupDigits(whole)}${rest ? `.${String(rest).padStart(2, '0')}` : ''}`;
}

export const NOT_AVAILABLE = 'not available';
/** A field whose tools haven't been called for this item yet: "not available" would read as a no. */
export const NOT_CHECKED = 'not checked';

export function formatValue(field: Field | undefined, value: unknown): string {
  if (value === undefined || value === null || value === '') return NOT_AVAILABLE;
  if (typeof value === 'number' && field) {
    if (field.type === 'money') return formatMoney(value);
    if (field.unit) return `${groupDigits(value)} ${field.unit}`;
  }
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

// ---------------------------------------------------------------- one item, from every tool that returned it

export function viewOf(session: Session, kind: string, id: string | number): EntityView {
  const byTool: Record<string, unknown> = {};
  for (const [tool, record] of session.recordsFor(kind, id) ?? []) byTool[tool] = record;
  const values: Record<string, unknown> = { id };
  for (const record of Object.values(byTool)) if (record && typeof record === 'object') Object.assign(values, record);
  return { kind, id, values, byTool };
}

/** A field's value: from the tool its definition names (tool or tool.path), from the record field it names, or by key. */
/** One source's value for a field: a tool's output path, or a key of the item's merged record. */
function sourceValue(pack: SitePack, key: string, from: string, view: EntityView): unknown {
  const dot = from.indexOf('.');
  const tool = dot < 0 ? from : from.slice(0, dot);
  if (pack.tools[tool]) {
    const record = view.byTool[tool];
    if (record === undefined || record === null) return undefined;
    return dot < 0 ? (record as Record<string, unknown>)[key] : select(record, from.slice(dot + 1));
  }
  return view.values[from];
}

/**
 * A field's value for one item. A field may name several sources, in order: the first that has a value wins, so a
 * value more than one tool returns (a delivery date from a dates lookup or from a quote) shows whichever was called.
 * When none has one: nothing if a source is a tool (that tool's answer is the only one that counts), otherwise the
 * item's merged record under the field's own key.
 */
export function fieldValue(pack: SitePack, kind: string, key: string, view: EntityView): unknown {
  const from = pack.entities[kind]?.fields?.[key]?.from;
  const sources = (typeof from === 'string' ? [from] : from ?? []).filter((candidate) => candidate !== 'derived');
  for (const source of sources) {
    const value = sourceValue(pack, key, source, view);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return sources.some((source) => pack.tools[source.split('.')[0]!]) ? undefined : view.values[key];
}

/** The tools a field's value comes from; empty when it comes from the item's record. */
function sourceTools(pack: SitePack, from: string | string[] | undefined): string[] {
  return (typeof from === 'string' ? [from] : from ?? []).map((source) => source.split('.')[0]!).filter((tool) => !!pack.tools[tool]);
}

/**
 * A field as the user reads it:
 *   1. Its value, from the first source that has one.
 *   2. With no value: "not checked" when it comes from tools and none of them has been called for this item, so the
 *      user doesn't read an unfetched delivery date as "can't be delivered"; otherwise "not available".
 */
function fieldView(pack: SitePack, kind: string, key: string, view: EntityView): FieldView {
  const field = pack.entities[kind]?.fields?.[key];
  // 1. The value.
  const value = fieldValue(pack, kind, key, view);
  // 2. Why there's none.
  const tools = sourceTools(pack, field?.from);
  const unchecked = !hasValue(value) && tools.length > 0 && tools.every((tool) => view.byTool[tool] === undefined || view.byTool[tool] === null);
  return {
    key,
    label: field?.label ?? key,
    value: value ?? null,
    text: unchecked ? NOT_CHECKED : formatValue(field, value),
    ...(field?.estimate ? { estimate: true } : {}),
  };
}

/** Values for card templates: numbers with a unit are grouped (the template adds the unit), money is formatted. */
function templateValues(entity: Entity, view: EntityView): Record<string, unknown> {
  const out: Record<string, unknown> = { ...view.values };
  for (const [key, field] of Object.entries(entity.fields ?? {})) {
    const value = view.values[key];
    if (typeof value !== 'number' || !field) continue;
    if (field.type === 'money') out[key] = formatMoney(value);
    else if (field.unit) out[key] = groupDigits(value);
  }
  return out;
}

const SEPARATOR = /( · | \| | — | - |, )/;
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const hasValue = (value: unknown) => value !== undefined && value !== null && value !== '';

/**
 * A card template filled for display. Templates split into parts at separators such as " · ". A part whose values
 * are all missing is dropped ("{rating} stars" with no rating); a part with some values keeps them ("{year} {make}
 * {model}" with no year reads "Tesla Model Y"). A placeholder is never shown as {name}.
 */
export function displayText(template: string, values: Record<string, unknown>): string {
  const pieces = template.split(SEPARATOR);
  let out = '';
  for (let i = 0; i < pieces.length; i += 2) {
    const part = pieces[i]!;
    const names = [...part.matchAll(PLACEHOLDER)].map((match) => match[1]!);
    if (names.length && !names.some((name) => hasValue(values[name]))) continue;
    const text = fill(part, values).replace(PLACEHOLDER, '').replace(/\s{2,}/g, ' ').trim();
    if (!text) continue;
    out += (out ? pieces[i - 1] ?? ' ' : '') + text;
  }
  return out;
}

export function cardOf(session: Session, kind: string, id: string | number): CardView {
  const { pack } = session;
  const entity = pack.entities[kind]!;
  const view = viewOf(session, kind, id);
  const values = templateValues(entity, view);
  const card: CardView = {
    id,
    title: (entity.card ? displayText(entity.card.title, values) : '') || String(id),
    fields: (entity.card?.fields ?? []).map((key) => fieldView(pack, kind, key, view)),
  };
  const subtitle = entity.card?.subtitle ? displayText(entity.card.subtitle, values) : '';
  if (subtitle) card.subtitle = subtitle;
  if (entity.card?.link) {
    const link = deepLink(pack, entity.card.link, view.values);
    if (link.ok) card.link = link.url;
  }
  return card;
}

function detailOf(session: Session, kind: string, id: string | number, sections: string[] | undefined): UiComponent {
  const { pack } = session;
  const entity = pack.entities[kind]!;
  const view = viewOf(session, kind, id);
  const out: DetailSection[] = [];
  for (const name of sections ?? entity.sections ?? ['overview']) {
    if (name === 'overview') {
      const fields = Object.keys(entity.fields ?? {}).map((key) => fieldView(pack, kind, key, view)).filter((field) => field.value !== null);
      out.push({ name, fields });
      continue;
    }
    const content = session.site.sections?.[name]?.(view);
    if (content) out.push({ name, ...content });
  }
  return { type: 'detail', entity: kind, card: cardOf(session, kind, id), sections: out };
}

function componentFor(session: Session, call: PresentationCall): UiComponent {
  const { pack } = session;
  switch (call.name) {
    case 'present_items':
      return {
        type: 'items', entity: call.args.entity, layout: call.args.layout ?? 'cards',
        ...(call.args.heading ? { heading: call.args.heading } : {}),
        items: call.args.ids.map((id) => cardOf(session, call.args.entity, id)),
      };
    case 'present_options':
      return {
        type: 'options', entity: call.args.entity,
        ...(call.args.heading ? { heading: call.args.heading } : {}),
        options: call.args.ids.map((id) => cardOf(session, call.args.entity, id)),
      };
    case 'present_comparison': {
      const kind = call.args.entity;
      const ids = call.args.ids as (string | number)[];
      const views = ids.map((id) => viewOf(session, kind, id));
      return {
        type: 'comparison', entity: kind,
        items: ids.map((id) => {
          const card = cardOf(session, kind, id);
          return { id, title: card.title, ...(card.link ? { link: card.link } : {}) };
        }),
        rows: call.args.attributes.map((key) => ({
          key,
          label: pack.entities[kind]?.fields?.[key]?.label ?? key,
          cells: views.map((view) => fieldView(pack, kind, key, view)),
        })),
      };
    }
    case 'present_detail':
      return detailOf(session, call.args.entity, call.args.id, call.args.sections);
    case 'present_form': {
      const form = pack.forms![call.args.form]!;
      const prefill = (call.args.prefill ?? {}) as Record<string, unknown>;
      return {
        type: 'form', form: call.args.form,
        ...(call.args.heading ? { heading: call.args.heading } : {}),
        ...(form.submitTool ? { submitTool: form.submitTool } : {}),
        fields: Object.entries(form.fields).map(([key, field]) => ({
          key, label: field!.label, type: field!.type, required: field!.required === true,
          ...(field!.options ? { options: field!.options } : {}),
          ...(field!.min !== undefined ? { min: field!.min } : {}),
          ...(field!.max !== undefined ? { max: field!.max } : {}),
          ...(prefill[key] !== undefined ? { value: prefill[key] } : {}),
        })),
      };
    }
    case 'present_notice': {
      const notice = pack.notices![call.args.notice]!;
      return { type: 'notice', notice: call.args.notice, text: notice.text, ...(notice.version ? { version: notice.version } : {}) };
    }
    case 'present_destination':
      // Built and checked in present(), which never sends a destination here.
      throw new Error('a destination is built in present()');
  }
}

/** Whether a URL is one of the pages where the agent appears (the site pack's Chrome-style match patterns). */
function onSitePages(pack: SitePack, url: string): boolean {
  return pack.site.pages.some((page) => new RegExp(`^${page.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(url));
}

/**
 * A destination's button, from checked params:
 *   1. The URL: the destination's deep link, or the site code's builder when a template can't express it.
 *   2. Only a page where the agent appears is accepted, so the button never leaves the site and the conversation
 *      carries over to the page it opens.
 *   3. The app's route, when the site pack has one.
 */
function destinationOf(session: Session, name: string, params: Record<string, unknown>): UiComponent | ToolError {
  const { pack } = session;
  const destination = pack.destinations![name]!;
  const unavailable = platformError('destination_unavailable', { destination: name });
  // 1. The URL.
  const linkOf = (link: string, values: Record<string, unknown>) => {
    const built = deepLink(pack, link, values);
    return built.ok ? built.url : undefined;
  };
  const url = destination.link ? linkOf(destination.link, params) : session.site.destinations?.[name]?.(params, linkOf);
  // 2. On the site.
  if (!url || !onSitePages(pack, url)) return unavailable;
  // 3. The app's route.
  const appRoute = destination.app ? buildLink(destination.app, params) : undefined;
  return { type: 'destination', destination: name, title: destination.title, url, ...(appRoute?.ok ? { appRoute: appRoute.url } : {}) };
}

/**
 * UI components for an answer:
 *   1. Check every call; a destination is also refused when its URL can't be built on the site.
 *   2. Fill the rest from tool results, with required notices added.
 */
export function present(session: Session, calls: readonly PresentationCall[]): Presented {
  // 1. Check.
  const ctx = checkContext(session);
  const refused: Presented['refused'] = [];
  const accepted: PresentationCall[] = [];
  const destinations = new Map<PresentationCall, UiComponent>();
  for (const call of calls) {
    const error = checkPresentation(ctx, call);
    if (error) {
      refused.push({ call, error });
      continue;
    }
    if (call.name === 'present_destination') {
      const built = destinationOf(session, call.args.destination, (call.args.params ?? {}) as Record<string, unknown>);
      if ('code' in built) {
        refused.push({ call, error: built });
        continue;
      }
      destinations.set(call, built);
    }
    accepted.push(call);
  }
  if (refused.length) session.log('presentation_refused', refused);
  // 2. Fill.
  return { components: withRequiredNotices(session.pack, accepted).map((presentation) => destinations.get(presentation) ?? componentFor(session, presentation)), refused };
}

/**
 * The fast path: a tool result shown before the brain's answer, using the presentation tool the site pack names for
 * the tool, with every item of the tool's first output kind. Empty when the tool has nothing to show this way.
 */
export function presentToolResult(session: Session, tool: string, output: Record<string, unknown>): UiComponent[] {
  const definition = session.pack.tools[tool];
  const first = definition?.ids?.output?.[0];
  if (!definition?.presentation || !first) return [];
  const ids = [...new Set(selectIds(output, first.path))];
  if (!ids.length) return [];
  const kind = first.kind;
  const presentation = definition.presentation;
  if (presentation !== 'present_detail' && presentation !== 'present_options' && presentation !== 'present_items') return [];
  // The generated types spell out list lengths as tuples; present() checks every call at run time anyway.
  const call = (presentation === 'present_detail'
    ? { name: presentation, args: { entity: kind, id: ids[0] } }
    : { name: presentation, args: { entity: kind, ids: ids.slice(0, presentation === 'present_options' ? 10 : 50) } }) as unknown as PresentationCall;
  return present(session, [call]).components;
}

function selectIds(output: unknown, path: string): (string | number)[] {
  const value = select(output, path);
  const list = Array.isArray(value) ? value : [value];
  return list.filter((item): item is string | number => typeof item === 'string' || typeof item === 'number');
}
