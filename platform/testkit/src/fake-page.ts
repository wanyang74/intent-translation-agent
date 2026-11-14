// FakePage: a site's page as page code sees it (PageControl, web/src/page-actions.ts), built from a small tree of
// elements, so a site's page actions can be tested in Node against the page's real structure and text. It records
// every click and scroll, and lets a test change the page when time passes (results arriving) or when something is
// clicked (a panel opening, the site taking a press). Platform code: nothing here names a site.
// Selectors: only what page code uses, a tag and attribute tests ([name], [name="value"], [name^="value"]), joined
// by spaces for descendants. Anything else throws, so a page action can't quietly rely on a selector this can't match.
import type { PageControl, PageElement } from '../../web/src/page-actions.ts';

/** One element: its tag, attributes, own text, children, and what clicking it does. */
export interface FakeNode {
  tag: string;
  attrs: Record<string, string>;
  /** Text of its own, before its children's. */
  text: string;
  children: FakeNode[];
  parent: FakeNode | null;
  onClick?: (clicked: FakeNode) => void;
}

/** An element; strings among the children are its own text, one line each. */
export function el(tag: string, attrs: Record<string, string> = {}, children: (FakeNode | string)[] = [], onClick?: (clicked: FakeNode) => void): FakeNode {
  const created: FakeNode = { tag, attrs, text: children.filter((child): child is string => typeof child === 'string').join('\n'), children: [], parent: null, ...(onClick ? { onClick } : {}) };
  for (const child of children) if (typeof child !== 'string') append(created, child);
  return created;
}

export function append(parentNode: FakeNode, child: FakeNode): void {
  child.parent = parentNode;
  parentNode.children.push(child);
}

export function remove(child: FakeNode): void {
  if (!child.parent) return;
  child.parent.children = child.parent.children.filter((candidate) => candidate !== child);
  child.parent = null;
}

/** The text as innerText would give it: own text, then each child's, a line each. */
export function textOf(node: FakeNode): string {
  return [node.text, ...node.children.map(textOf)].filter(Boolean).join('\n');
}

interface Compound {
  tag?: string;
  tests: { name: string; op?: '=' | '^='; value?: string }[];
}

function parseSelector(selector: string): Compound[] {
  return selector.trim().split(/\s+(?![^[]*\])/).map((part) => {
    const match = /^([a-z0-9]*)((?:\[[^\]]+\])*)$/i.exec(part);
    if (!match) throw new Error(`FakePage can't match the selector "${selector}"`);
    const tests = [...match[2]!.matchAll(/\[([\w-]+)(?:(\^?=)"([^"]*)")?\]/g)].map((test) => ({ name: test[1]!, ...(test[2] ? { op: test[2] as '=' | '^=', value: test[3]! } : {}) }));
    if (tests.length !== (match[2]!.match(/\[/g) ?? []).length) throw new Error(`FakePage can't match the selector "${selector}"`);
    return { ...(match[1] ? { tag: match[1].toLowerCase() } : {}), tests };
  });
}

function matchesCompound(node: FakeNode, compound: Compound): boolean {
  if (compound.tag && node.tag !== compound.tag) return false;
  return compound.tests.every((test) => {
    const value = node.attrs[test.name];
    if (value === undefined) return false;
    return test.op === '=' ? value === test.value : test.op === '^=' ? value.startsWith(test.value!) : true;
  });
}

/** Whether a node matches the whole selector: the last part itself, each earlier part on an ancestor, in order, below `scope`. */
function matches(node: FakeNode, parts: Compound[], scope: FakeNode | null): boolean {
  if (!matchesCompound(node, parts[parts.length - 1]!)) return false;
  let index = parts.length - 2;
  for (let ancestor = node.parent; ancestor && ancestor !== scope && index >= 0; ancestor = ancestor.parent) {
    if (matchesCompound(ancestor, parts[index]!)) index -= 1;
  }
  return index < 0;
}

function descendants(node: FakeNode): FakeNode[] {
  return node.children.flatMap((child) => [child, ...descendants(child)]);
}

export class FakePage implements PageControl {
  readonly root: FakeNode;
  address: string;
  /** Every click and scroll, by the element's label or text, in order. */
  readonly clicks: string[] = [];
  readonly scrolled: string[] = [];
  waits = 0;
  /** Called after each wait, with how many there have been: where a test makes results arrive. */
  onWait?: (waits: number) => void;

  constructor(root: FakeNode, address: string) {
    this.root = root;
    this.address = address;
  }

  /** What a click or scroll is recorded as: its aria-label, or else its first line of text. */
  static nameOf(node: FakeNode): string {
    return node.attrs['aria-label'] ?? textOf(node).split('\n')[0] ?? node.tag;
  }

  elementOf(node: FakeNode): PageElement {
    const page = this;
    return {
      get text() {
        return textOf(node);
      },
      attribute: (name) => node.attrs[name] ?? null,
      find: (selector) => page.query(node, selector)[0] ?? null,
      findAll: (selector) => page.query(node, selector),
      byId: (id) => page.byId(id),
      parent: () => (node.parent ? page.elementOf(node.parent) : null),
      click: () => {
        page.clicks.push(FakePage.nameOf(node));
        // A disabled button does nothing, as in a browser.
        if (node.attrs.disabled === undefined) node.onClick?.(node);
      },
      scrollIntoView: () => page.scrolled.push(FakePage.nameOf(node)),
    };
  }

  private query(scope: FakeNode, selector: string): PageElement[] {
    const parts = parseSelector(selector);
    return descendants(scope).filter((node) => matches(node, parts, scope)).map((node) => this.elementOf(node));
  }

  findAll(selector: string): PageElement[] {
    return this.query(this.root, selector);
  }

  byId(id: string): PageElement | null {
    const found = descendants(this.root).find((node) => node.attrs.id === id);
    return found ? this.elementOf(found) : null;
  }

  async wait(_ms: number): Promise<void> {
    this.waits += 1;
    this.onWait?.(this.waits);
  }

  url(): string {
    return this.address;
  }
}
