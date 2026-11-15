// Tests: every site pack has a page reader, and it reads each saved page the way the site's conversations and eval
// cases recorded it.
// How: each page reader gets a PageView with the saved URL and an empty page (no DOM text, no cookies).
// Passes when: the page type and the item on screen match the saved page context, and the page type is one the
// site pack lists; and a site whose account calls use the token its page keeps (token.signedIn: page, D7) has the page
// code that reads it, which finds none on an empty page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PageContext } from '../../contract/generated/types.ts';
import { listSites, readSite, sitesDir } from '../../contract/src/site-pack.ts';
import { hasEvals, loadCases } from '../../evals/src/cases.ts';
import { loadConversations } from '../../testkit/src/conversations.ts';
import type { PageReader, PageTokenReader } from '../src/page.ts';

for (const site of listSites()) {
  test(`${site}: the page reader finds the page type and the item on screen of every saved page`, async () => {
    const file = path.join(sitesDir, site, 'page.ts');
    assert.ok(existsSync(file), `${site} has no page.ts`);
    const readPage = (await import(pathToFileURL(file).href)).readPage as PageReader;
    const pageTypes = readSite(site).pack.site.pageTypes ?? [];
    const saved: PageContext[] = [
      ...loadConversations(site).flatMap((conversation) => conversation.messages.flatMap((message) => (message.type === 'turn' ? [message.pageContext] : []))),
      ...(hasEvals(site) ? loadCases(site).flatMap((evalCase) => (evalCase.page ? [evalCase.page] : [])) : []),
    ];
    assert.ok(saved.length);
    for (const page of saved) {
      const { context } = readPage({ url: page.url, text: () => null, cookie: '', scripts: () => [] });
      assert.deepEqual([context.pageType, context.entity], [page.pageType, page.entity], page.url);
      assert.ok(pageTypes.includes(context.pageType), `${context.pageType} isn't in site.pageTypes`);
    }
  });

  const signedIn = readSite(site).pack.token?.signedIn;
  test(`${site}: the page code reads the signed-in token the page keeps, where the site pack says the page keeps one`, { skip: !signedIn && 'its token rule has no signedIn' }, async () => {
    const pageModule = await import(pathToFileURL(path.join(sitesDir, site, 'page.ts')).href) as { pageToken?: PageTokenReader };
    assert.equal(typeof pageModule.pageToken, 'function', `${site}/page.ts exports no pageToken`);
    assert.equal(await pageModule.pageToken!({ cookie: '', stored: async () => null }), null, 'an empty page keeps no token');
  });
}
