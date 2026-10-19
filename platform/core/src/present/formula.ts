// Derived fields. A site pack names each one with a formula, such as "price.total + price.estimatedTaxesAndFees".
// A small parser instead of eval: numbers, field paths, + - * / and parentheses. A missing or non-numeric value,
// or a division by zero, gives no value rather than a wrong one.
import type { SitePack } from '../../../contract/generated/types.ts';
import { select } from '../../../contract/src/paths.ts';

export class FormulaError extends Error {}

type Token = { type: 'num'; value: number; at: number } | { type: 'path'; path: string; at: number } | { type: '+' | '-' | '*' | '/' | '(' | ')'; at: number };
type Node =
  | { kind: 'num'; value: number }
  | { kind: 'path'; path: string }
  | { kind: 'neg'; operand: Node }
  | { kind: 'bin'; op: '+' | '-' | '*' | '/'; left: Node; right: Node };

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
    const char = source.charAt(i);
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      i++;
      continue;
    }
    re.lastIndex = i;
    const match = re.exec(source);
    if (!match) throw new FormulaError(`"${source}": unexpected "${char}" at ${i}`);
    if (match[1] !== undefined) tokens.push({ type: 'num', value: Number(match[1]), at: i });
    else if (match[2] !== undefined) tokens.push({ type: 'path', path: match[2], at: i });
    else tokens.push({ type: match[3] as '+' | '-' | '*' | '/' | '(' | ')', at: i });
    i = re.lastIndex;
  }
  return tokens;
}

export function parseFormula(source: string): Formula {
  const tokens = tokenize(source);
  if (!tokens.length) throw new FormulaError(`"${source}": empty formula`);
  let i = 0;
  const peek = () => tokens[i];
  const unexpected = (token: Token | undefined) =>
    new FormulaError(token ? `"${source}": unexpected ${token.type === 'num' ? 'number' : token.type === 'path' ? 'field' : `"${token.type}"`} at ${token.at}` : `"${source}": ends too early`);

  function expr(): Node {
    let node = term();
    for (;;) {
      const token = peek();
      if (!token || (token.type !== '+' && token.type !== '-')) return node;
      i++;
      node = { kind: 'bin', op: token.type as '+' | '-', left: node, right: term() };
    }
  }
  function term(): Node {
    let node = factor();
    for (;;) {
      const token = peek();
      if (!token || (token.type !== '*' && token.type !== '/')) return node;
      i++;
      node = { kind: 'bin', op: token.type as '*' | '/', left: node, right: factor() };
    }
  }
  function factor(): Node {
    const token = tokens[i++];
    if (!token) throw unexpected(undefined);
    if (token.type === 'num') return { kind: 'num', value: token.value };
    if (token.type === 'path') return { kind: 'path', path: token.path };
    if (token.type === '-') return { kind: 'neg', operand: factor() };
    if (token.type === '(') {
      const inner = expr();
      const close = tokens[i++];
      if (!close || close.type !== ')') throw close ? unexpected(close) : new FormulaError(`"${source}": missing ")"`);
      return inner;
    }
    throw unexpected(token);
  }

  const root = expr();
  if (i < tokens.length) throw unexpected(tokens[i]);
  const paths: string[] = [];
  (function collect(node: Node): void {
    if (node.kind === 'path') { if (!paths.includes(node.path)) paths.push(node.path); }
    else if (node.kind === 'neg') collect(node.operand);
    else if (node.kind === 'bin') { collect(node.left); collect(node.right); }
  })(root);

  function run(node: Node, item: unknown): number | undefined {
    switch (node.kind) {
      case 'num': return node.value;
      case 'path': {
        const value = select(item, node.path);
        return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
      }
      case 'neg': {
        const operand = run(node.operand, item);
        return operand === undefined ? undefined : -operand;
      }
      case 'bin': {
        const left = run(node.left, item), right = run(node.right, item);
        if (left === undefined || right === undefined) return undefined;
        if (node.op === '+') return left + right;
        if (node.op === '-') return left - right;
        if (node.op === '*') return left * right;
        return right === 0 ? undefined : left / right;
      }
    }
  }
  return {
    source,
    paths,
    evaluate(item) {
      const value = run(root, item);
      return value !== undefined && Number.isFinite(value) ? value : undefined;
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
      .filter(([, derived]) => derived && (!derived.appliesTo || derived.appliesTo === kind))
      .map(([name, derived]) => ({
        name,
        label: derived!.label,
        estimate: derived!.estimate === true,
        formula: parseFormula(derived!.formula),
        money: pack.entities[kind]?.fields?.[name]?.type === 'money',
      }));
    byKind.set(kind, fields);
  }
  return fields;
}

/** The derived values for one item of an entity kind. A field whose inputs are missing is left out. */
export function computeDerived(pack: SitePack, kind: string, item: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const derived of derivedFields(pack, kind)) {
    const value = derived.formula.evaluate(item);
    if (value !== undefined) out[derived.name] = derived.money ? Math.round(value * 100) / 100 : value;
  }
  return out;
}
