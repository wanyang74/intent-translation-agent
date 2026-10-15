// Derived fields. A site pack names each one with a formula, such as "price.total + price.estimatedTaxesAndFees".
// A small parser instead of eval: numbers, field paths, + - * / and parentheses. A missing or non-numeric value,
// or a division by zero, gives no value rather than a wrong one.
import type { SitePack } from '../../contract/generated/types.ts';
import { select } from '../../contract/src/paths.ts';

export class FormulaError extends Error {}

type Token = { t: 'num'; v: number; at: number } | { t: 'path'; p: string; at: number } | { t: '+' | '-' | '*' | '/' | '(' | ')'; at: number };
type Node =
  | { k: 'num'; v: number }
  | { k: 'path'; p: string }
  | { k: 'neg'; a: Node }
  | { k: 'bin'; op: '+' | '-' | '*' | '/'; a: Node; b: Node };

export interface Formula {
  source: string;
  /** The field paths the formula reads. */
  paths: string[];
  /** The value for one item, or undefined when an input is missing or the result isn't a finite number. */
  evaluate(item: unknown): number | undefined;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const re = /(\d+(?:\.\d+)?)|([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)|([-+*/()])/y;
  let i = 0;
  while (i < source.length) {
    const c = source.charAt(i);
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    re.lastIndex = i;
    const m = re.exec(source);
    if (!m) throw new FormulaError(`"${source}": unexpected "${c}" at ${i}`);
    if (m[1] !== undefined) tokens.push({ t: 'num', v: Number(m[1]), at: i });
    else if (m[2] !== undefined) tokens.push({ t: 'path', p: m[2], at: i });
    else tokens.push({ t: m[3] as '+' | '-' | '*' | '/' | '(' | ')', at: i });
    i = re.lastIndex;
  }
  return tokens;
}

export function parseFormula(source: string): Formula {
  const tokens = tokenize(source);
  if (!tokens.length) throw new FormulaError(`"${source}": empty formula`);
  let i = 0;
  const peek = () => tokens[i];
  const unexpected = (tk: Token | undefined) =>
    new FormulaError(tk ? `"${source}": unexpected ${tk.t === 'num' ? 'number' : tk.t === 'path' ? 'field' : `"${tk.t}"`} at ${tk.at}` : `"${source}": ends too early`);

  function expr(): Node {
    let a = term();
    for (;;) {
      const tk = peek();
      if (!tk || (tk.t !== '+' && tk.t !== '-')) return a;
      i++;
      a = { k: 'bin', op: tk.t as '+' | '-', a, b: term() };
    }
  }
  function term(): Node {
    let a = factor();
    for (;;) {
      const tk = peek();
      if (!tk || (tk.t !== '*' && tk.t !== '/')) return a;
      i++;
      a = { k: 'bin', op: tk.t as '*' | '/', a, b: factor() };
    }
  }
  function factor(): Node {
    const tk = tokens[i++];
    if (!tk) throw unexpected(undefined);
    if (tk.t === 'num') return { k: 'num', v: tk.v };
    if (tk.t === 'path') return { k: 'path', p: tk.p };
    if (tk.t === '-') return { k: 'neg', a: factor() };
    if (tk.t === '(') {
      const inner = expr();
      const close = tokens[i++];
      if (!close || close.t !== ')') throw close ? unexpected(close) : new FormulaError(`"${source}": missing ")"`);
      return inner;
    }
    throw unexpected(tk);
  }

  const root = expr();
  if (i < tokens.length) throw unexpected(tokens[i]);
  const paths: string[] = [];
  (function collect(n: Node): void {
    if (n.k === 'path') { if (!paths.includes(n.p)) paths.push(n.p); }
    else if (n.k === 'neg') collect(n.a);
    else if (n.k === 'bin') { collect(n.a); collect(n.b); }
  })(root);

  function run(n: Node, item: unknown): number | undefined {
    switch (n.k) {
      case 'num': return n.v;
      case 'path': {
        const v = select(item, n.p);
        return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
      }
      case 'neg': {
        const a = run(n.a, item);
        return a === undefined ? undefined : -a;
      }
      case 'bin': {
        const a = run(n.a, item), b = run(n.b, item);
        if (a === undefined || b === undefined) return undefined;
        if (n.op === '+') return a + b;
        if (n.op === '-') return a - b;
        if (n.op === '*') return a * b;
        return b === 0 ? undefined : a / b;
      }
    }
  }
  return {
    source,
    paths,
    evaluate(item) {
      const v = run(root, item);
      return v !== undefined && Number.isFinite(v) ? v : undefined;
    },
  };
}

export interface DerivedField {
  name: string;
  label: string;
  estimate: boolean;
  formula: Formula;
  /** Money values are rounded to cents. */
  money: boolean;
}

const cache = new WeakMap<SitePack, Map<string, DerivedField[]>>();

/** The derived fields that apply to an entity kind: those for that kind, and those with no kind given. */
export function derivedFields(pack: SitePack, kind: string): DerivedField[] {
  let byKind = cache.get(pack);
  if (!byKind) cache.set(pack, (byKind = new Map()));
  let fields = byKind.get(kind);
  if (!fields) {
    fields = Object.entries(pack.policies.derivedFields ?? {})
      .filter(([, d]) => d && (!d.appliesTo || d.appliesTo === kind))
      .map(([name, d]) => ({
        name,
        label: d!.label,
        estimate: d!.estimate === true,
        formula: parseFormula(d!.formula),
        money: pack.entities[kind]?.fields?.[name]?.type === 'money',
      }));
    byKind.set(kind, fields);
  }
  return fields;
}

/** The derived values for one item of an entity kind. A field whose inputs are missing is left out. */
export function computeDerived(pack: SitePack, kind: string, item: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of derivedFields(pack, kind)) {
    const v = f.formula.evaluate(item);
    if (v !== undefined) out[f.name] = f.money ? Math.round(v * 100) / 100 : v;
  }
  return out;
}
