// The page reader's contract: each site pack's page.ts tells the web surface which page the user is on and what the
// page shows about the item on screen. The platform can't know a site's URLs or markup, so this is the site's code.
// Readers see the page only through PageView, a small slice of the DOM, so they can be tested in Node with a fake.
import type { PageContext } from '../../contract/generated/types.ts';

/** What a page reader may look at. */
export interface PageView {
  url: string;
  /** The text of the first element matching a CSS selector, or null. */
  text(selector: string): string | null;
  /** The page's cookies, as document.cookie gives them. */
  cookie: string;
  /** The text of every inline script, in page order: where frameworks embed a page's data. */
  scripts(): string[];
}

export interface PageReading {
  /** The page context for the turn: the page type, the item on screen, the user's location when the page shows it. */
  context: PageContext;
  /** What the page carries about the item on screen, for the site's tools (Host.pageData); null if nothing. */
  data: unknown;
}

export type PageReader = (view: PageView) => PageReading;

interface Nodes {
  querySelector(selector: string): { textContent: string | null } | null;
  querySelectorAll(selector: string): ArrayLike<{ textContent: string | null }>;
  cookie: string;
}

/** A PageView of a live document (typed by what it uses, so this file also compiles where there's no DOM). */
export function viewOf(doc: Nodes, url: string): PageView {
  return {
    url,
    text: (selector) => doc.querySelector(selector)?.textContent ?? null,
    cookie: doc.cookie,
    scripts: () => Array.from(doc.querySelectorAll('script:not([src])'), (script) => script.textContent ?? ''),
  };
}
