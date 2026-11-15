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

/**
 * What a site's page code may read to find the signed-in token the page keeps (D7): the page's cookies, and one value
 * from its IndexedDB. Read only when a tool that needs sign-in runs; the token goes to core.js and nowhere else.
 */
export interface PageStorage {
  cookie: string;
  /** The value at a key in one of the page's IndexedDB stores; null when the database, store or key isn't there. */
  stored(database: string, store: string, key: string): Promise<unknown>;
}

/** A site's way to read the signed-in token its page keeps: page.ts exports it as pageToken. */
export type PageTokenReader = (storage: PageStorage) => Promise<string | null>;

/** The parts of IndexedDB storageOf uses, typed by use like Nodes below. */
interface Databases {
  open(name: string): IdbRequest<{
    objectStoreNames: ArrayLike<string> & { contains(name: string): boolean };
    transaction(store: string): { objectStore(store: string): { get(key: string): IdbRequest<unknown> } };
    close(): void;
  }>;
}
// The handlers take `never` so the browser's own types, whose handlers take an event, fit.
interface IdbRequest<T> {
  result: T;
  onsuccess: ((event: never) => unknown) | null;
  onerror: ((event: never) => unknown) | null;
  onupgradeneeded?: ((event: never) => unknown) | null;
}

/**
 * PageStorage of a live page:
 *   1. Open the database; a request is answered through its onsuccess and onerror callbacks, so each becomes a promise.
 *   2. Opening a database that doesn't exist would create it, empty: onupgradeneeded fires only then, so it marks one
 *      that isn't there. The page never sees an empty database of ours, since nothing is written to it (no store is
 *      made) and the open is closed at once.
 *   3. Read the key from the store, if the store is there.
 */
export function storageOf(doc: { cookie: string }, databases: Databases): PageStorage {
  const answer = <T>(request: IdbRequest<T>) => new Promise<T | null>((resolve) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
  return {
    cookie: doc.cookie,
    async stored(database, store, key) {
      // 1. Open
      const opening = databases.open(database);
      let created = false;
      // 2. A database that wasn't there
      opening.onupgradeneeded = () => { created = true; };
      const db = await answer(opening);
      if (!db) return null;
      try {
        if (created || !db.objectStoreNames.contains(store)) return null;
        // 3. Read
        return await answer(db.transaction(store).objectStore(store).get(key));
      } finally {
        db.close();
      }
    },
  };
}

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
