// Respond (phase 4 on the flow chart): turns presentation calls into UI components the surface renders natively.
// A call carries only an entity kind, IDs and a layout; every value shown comes from this session's tool results,
// through the site pack's card templates and field definitions. A notice is added whenever a field it explains is on
// screen. A call that fails the boundary checks is left out, never shown half-checked.
import type { PresentationCall, SitePack, ToolError } from '../../contract/generated/types.ts';
import { select } from '../../contract/src/paths.ts';
import { checkPresentation, withRequiredNotices } from './checks.ts';
import { checkContext } from './execute.ts';
import { deepLink } from './links.ts';
import type { Session } from './session.ts';
import type { EntityView, SectionContent } from './site-code.ts';
import { fill } from './text.ts';

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
  | { type: 'notice'; notice: string; text: string; version?: string };

export interface Presented {
  components: UiComponent[];
  /** Calls left out, and why. */
  refused: { call: PresentationCall; error: ToolError }[];
}

// ---------------------------------------------------------------- values as the user reads them

/** Digits grouped by thousands, without Intl (QuickJS has none). */
export function groupDigits(n: number): string {
  const [whole, fraction] = Math.abs(n).toString().split('.');
  return (n < 0 ? '-' : '') + whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction ? `.${fraction}` : '');
}

export function formatMoney(n: number): string {
  const cents = Math.round(Math.abs(n) * 100);
  const whole = Math.floor(cents / 100);
  const rest = cents % 100;
  return `${n < 0 ? '-' : ''}$${groupDigits(whole)}${rest ? `.${String(rest).padStart(2, '0')}` : ''}`;
}

export const NOT_AVAILABLE = 'not available';

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
export function fieldValue(pack: SitePack, kind: string, key: string, view: EntityView): unknown {
  const from = pack.entities[kind]?.fields?.[key]?.from;
  if (from && from !== 'derived') {
    const dot = from.indexOf('.');
    const tool = dot < 0 ? from : from.slice(0, dot);
    if (pack.tools[tool]) {
      const record = view.byTool[tool];
      if (record === undefined || record === null) return undefined;
      return dot < 0 ? (record as Record<string, unknown>)[key] : select(record, from.slice(dot + 1));
    }
    if (view.values[from] !== undefined) return view.values[from];
  }
  return view.values[key];
}

function fieldView(pack: SitePack, kind: string, key: string, view: EntityView): FieldView {
  const field = pack.entities[kind]?.fields?.[key];
  const value = fieldValue(pack, kind, key, view);
  return {
    key,
    label: field?.label ?? key,
    value: value ?? null,
    text: formatValue(field, value),
    ...(field?.estimate ? { estimate: true } : {}),
  };
}

/** Values for card templates: numbers with a unit are grouped (the template adds the unit), money is formatted. */
function templateValues(entity: Entity, view: EntityView): Record<string, unknown> {
  const out: Record<string, unknown> = { ...view.values };
  for (const [key, field] of Object.entries(entity.fields ?? {})) {
    const v = view.values[key];
    if (typeof v !== 'number' || !field) continue;
    if (field.type === 'money') out[key] = formatMoney(v);
    else if (field.unit) out[key] = groupDigits(v);
  }
  return out;
}

const SEPARATOR = /( · | \| | — | - |, )/;
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const hasValue = (v: unknown) => v !== undefined && v !== null && v !== '';

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
    const names = [...part.matchAll(PLACEHOLDER)].map((m) => m[1]!);
    if (names.length && !names.some((n) => hasValue(values[n]))) continue;
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
      const fields = Object.keys(entity.fields ?? {}).map((key) => fieldView(pack, kind, key, view)).filter((f) => f.value !== null);
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
          cells: views.map((v) => fieldView(pack, kind, key, v)),
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
        fields: Object.entries(form.fields).map(([key, f]) => ({
          key, label: f!.label, type: f!.type, required: f!.required === true,
          ...(f!.options ? { options: f!.options } : {}),
          ...(f!.min !== undefined ? { min: f!.min } : {}),
          ...(f!.max !== undefined ? { max: f!.max } : {}),
          ...(prefill[key] !== undefined ? { value: prefill[key] } : {}),
        })),
      };
    }
    case 'present_notice': {
      const notice = pack.notices![call.args.notice]!;
      return { type: 'notice', notice: call.args.notice, text: notice.text, ...(notice.version ? { version: notice.version } : {}) };
    }
  }
}

/** UI components for an answer: every call checked, filled from tool results, with required notices added. */
export function present(session: Session, calls: readonly PresentationCall[]): Presented {
  const ctx = checkContext(session);
  const refused: Presented['refused'] = [];
  const accepted: PresentationCall[] = [];
  for (const call of calls) {
    const error = checkPresentation(ctx, call);
    if (error) refused.push({ call, error });
    else accepted.push(call);
  }
  if (refused.length) session.log('presentation_refused', refused);
  return { components: withRequiredNotices(session.pack, accepted).map((c) => componentFor(session, c)), refused };
}

/**
 * The fast path: a tool result shown before the brain's answer, using the presentation tool the site pack names for
 * the tool, with every item of the tool's first output kind. Empty when the tool has nothing to show this way.
 */
export function presentToolResult(session: Session, tool: string, output: Record<string, unknown>): UiComponent[] {
  const t = session.pack.tools[tool];
  const first = t?.ids?.output?.[0];
  if (!t?.presentation || !first) return [];
  const ids = [...new Set(selectIds(output, first.path))];
  if (!ids.length) return [];
  const kind = first.kind;
  const p = t.presentation;
  if (p !== 'present_detail' && p !== 'present_options' && p !== 'present_items') return [];
  // The generated types spell out list lengths as tuples; present() checks every call at run time anyway.
  const call = (p === 'present_detail'
    ? { name: p, args: { entity: kind, id: ids[0] } }
    : { name: p, args: { entity: kind, ids: ids.slice(0, p === 'present_options' ? 10 : 50) } }) as unknown as PresentationCall;
  return present(session, [call]).components;
}

function selectIds(output: unknown, path: string): (string | number)[] {
  const v = select(output, path);
  const list = Array.isArray(v) ? v : [v];
  return list.filter((x): x is string | number => typeof x === 'string' || typeof x === 'number');
}
