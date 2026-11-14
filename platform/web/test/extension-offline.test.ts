// Tests: the Chrome extension works end to end with nothing live (L5, the surface step): the built extension in
// headless Chrome, its content script on the site's page, its background worker carrying the brain link, and the
// real brain over HTTP.
// How: the brain runs in this process with a FakeModel that writes what an example conversation's model wrote.
// Chrome's requests to the site are intercepted: the site's pages get an empty page, and its API calls are answered
// by FakeHost from the fixtures. The user's turns are typed into the overlay. Skipped without Chrome.
// The page is loaded again before every turn after the first, as when the user follows a link on the site, so the
// conversation must carry over: the overlay draws it again and the next turn goes on in the same brain session.
// Where a turn shows a card with a link to the site and another turn follows, its link is pressed (the new tab it would
// open is cancelled, so nothing goes live).
// Passes when: each answer shows in the overlay with no error, the conversation survives every page load in one
// brain session, the site was called for exactly the fixtures the conversation lists, and a pressed card shows in the
// conversation and reaches the brain with the next message only. Conversations whose page
// carries data the page reader can't read yet are left out.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Brain } from '../../brain/src/agent/brain.ts';
import { loadSite } from '../../brain/src/prompt/site.ts';
import { createBrainServer } from '../../brain/src/server/server.ts';
import { endpointOf, listSites, readSite } from '../../contract/src/site-pack.ts';
import { loadConversations, type Conversation } from '../../testkit/src/conversations.ts';
import { FakeHost } from '../../testkit/src/fake-host.ts';
import { fakeModelFor } from '../../testkit/src/fake-model.ts';
import { hasFixtures, loadFixtures } from '../../testkit/src/fixtures.ts';
import { chromePath, openChrome, type InterceptedRequest } from '../build/chrome.ts';
import { buildExtension } from '../build/extension.ts';

const skip = !chromePath() && 'Chrome not installed';
const workDir = mkdtempSync(path.join(os.tmpdir(), 'extension-test-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

/** Waits in the page until the overlay's latest reply is finished: an answer or an error, no progress line. */
const AWAIT_REPLY = `new Promise((resolve, reject) => {
  const started = Date.now();
  const check = () => {
    const root = document.querySelector('#intent-agent-overlay')?.shadowRoot;
    const replies = root ? [...root.querySelectorAll('.agent')] : [];
    const last = replies.at(-1);
    if (last && !last.querySelector('.progress') && last.childNodes.length) return resolve(true);
    if (Date.now() - started > 30000) return reject(new Error('no reply within 30 s'));
    setTimeout(check, 100);
  };
  check();
})`;

/** Waits for the content script, which starts at document_idle, a moment after the load event. */
const OVERLAY_READY = `new Promise((resolve) => { const wait = () => document.querySelector('#intent-agent-overlay') ? resolve(true) : setTimeout(wait, 50); wait(); })`;

/** Types a message into the overlay and presses Enter, the way a user would. */
const typeMessage = (message: string) => `(() => {
  const root = document.querySelector('#intent-agent-overlay').shadowRoot;
  root.querySelector('.launcher').click();
  const input = root.querySelector('textarea');
  input.value = ${JSON.stringify(message)};
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
})()`;

const squash = (text: string) => text.replace(/\*\*/g, '').replace(/^\s*[-*•]\s+/gm, '').replace(/\s+/g, ' ').trim();

/**
 * The site's API calls answered from fixtures, with the CORS headers a cross-origin call from the page needs. Like
 * the live site's API, they don't allow credentials, so a request that sends cookies cross-origin fails here as it
 * did live. A site whose API is on its pages' own host (a token call, a search) gets its endpoints from fixtures
 * too: only addresses that are no endpoint of the site pack are pages.
 */
function siteAnswers(site: string, fake: FakeHost, pageOrigin: string) {
  const cors = { 'access-control-allow-origin': pageOrigin, 'access-control-allow-methods': 'GET, POST' };
  const { pack } = readSite(site);
  const pages = pack.site.pages.map((page) => new RegExp(`^${page.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`));
  return async (request: InterceptedRequest) => {
    // The preflight: it allows exactly the headers asked for.
    const asked = Object.entries(request.headers).find(([name]) => name.toLowerCase() === 'access-control-request-headers')?.[1];
    if (request.method === 'OPTIONS') return { status: 204, headers: { ...cors, ...(asked ? { 'access-control-allow-headers': asked } : {}) }, body: '' };
    if (request.method === 'GET' && !endpointOf(pack, request.url) && pages.some((page) => page.test(request.url)) && !new URL(request.url).pathname.includes('.')) {
      return { status: 200, headers: { 'content-type': 'text/html' }, body: '<!doctype html><html><head><title>site page</title></head><body><h1>A page on the site</h1></body></html>' };
    }
    const response = await fake.request({ method: request.method as 'GET' | 'POST', url: request.url, headers: request.headers, body: request.body });
    return { status: response.status, headers: { ...response.headers, ...cors }, body: response.body };
  };
}

/** A conversation the extension can play today: every turn on a page whose data the page reader doesn't need. */
const playable = (conversation: Conversation) => conversation.pageData === undefined || conversation.pageData === null;

for (const site of listSites().filter(hasFixtures)) {
  for (const conversation of loadConversations(site).filter(playable)) {
    test(`${site}/${conversation.id}: the extension plays the conversation in Chrome, with the brain over HTTP`, { skip, timeout: 90_000 }, async () => {
      // The brain, with the conversation's model steps, on a free port.
      const now = Date.parse(conversation.now!);
      const brain = new Brain({ site: await loadSite(site), model: fakeModelFor(conversation), now: () => now });
      // Every session the brain is asked about: a conversation that survived its page loads uses one.
      const sessionIds = new Set<string>();
      // The presses each user message carried, in order.
      const pressesSent: unknown[] = [];
      const accept = brain.accept.bind(brain);
      brain.accept = (message, options) => {
        sessionIds.add((message as { sessionId: string }).sessionId);
        const turnMessage = message as { type: string; pageContext?: { pressed?: unknown } };
        if (turnMessage.type === 'turn') pressesSent.push(turnMessage.pageContext?.pressed ?? null);
        return accept(message, options);
      };
      const server = createBrainServer({ brain, allowedOrigins: [] });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const outDir = path.join(workDir, `${site}-${conversation.id}`);
      await buildExtension({ site, brainUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, outDir });

      const fake = new FakeHost(site, loadFixtures(site));
      const turns = conversation.messages.flatMap((message) => (message.type === 'turn' ? [message] : []));
      const firstPage = turns[0]!.pageContext.url;
      const page = await openChrome({ width: 1200, height: 900, extension: outDir });
      try {
        await page.intercept(readSite(site).pack.site.origins.map((origin) => `${origin}/*`), siteAnswers(site, fake, new URL(firstPage).origin));
        await page.goto(firstPage);
        await page.evaluate(OVERLAY_READY);
        const answers = conversation.messages.flatMap((message) => (message.type === 'answer' ? [message] : []));
        // The turn whose message should carry a press, and the press.
        let pressedBefore = null as { turn: number; title: string } | null;
        for (const [i, turn] of turns.entries()) {
          if (i > 0) {
            // A new page of the site: the overlay comes back with the conversation so far, open as it was.
            await page.goto(turn.pageContext.url);
            await page.evaluate(OVERLAY_READY);
            const restored = await page.evaluate<{ users: number; open: boolean; atEnd: boolean }>(`(() => { const root = document.querySelector('#intent-agent-overlay').shadowRoot; const log = root.querySelector('.log'); return { users: root.querySelectorAll('.user').length, open: !root.querySelector('.panel').hidden, atEnd: log.scrollHeight - log.clientHeight - log.scrollTop <= 2 }; })()`);
            // atEnd: the panel opens at the latest message, not scrolled back to the first turn.
            assert.deepEqual(restored, { users: i, open: true, atEnd: true }, `before turn ${i + 1}: the conversation carried over to the new page`);
            if (pressedBefore?.turn === i) {
              const lines = await page.evaluate<string[]>(`[...document.querySelector('#intent-agent-overlay').shadowRoot.querySelectorAll('.pressed')].map((line) => line.textContent)`);
              assert.equal(lines.length, 1, 'the pressed card shows in the conversation after the page load');
              assert.ok(lines[0]!.includes(pressedBefore.title), lines[0]);
            }
          }
          await page.evaluate(typeMessage(turn.message));
          await page.evaluate(AWAIT_REPLY);
          const shown = await page.evaluate<{ text: string; errors: string[] }>(`(() => { const root = document.querySelector('#intent-agent-overlay').shadowRoot; const last = [...root.querySelectorAll('.agent')].at(-1); return { text: last.innerText, errors: [...root.querySelectorAll('.error')].map((node) => node.textContent) }; })()`);
          assert.deepEqual(shown.errors, [], `turn ${i + 1}; console:\n${page.console.slice(-20).join('\n')}`);
          assert.ok(squash(shown.text).includes(squash(answers[i]!.text)), `turn ${i + 1}: the answer isn't shown:\n${shown.text}`);
          // A card with a link, and a turn after it: press the first one, cancelling the tab it would open.
          if (!pressedBefore && i + 1 < turns.length) {
            const title = await page.evaluate<string | null>(`(() => {
              const root = document.querySelector('#intent-agent-overlay').shadowRoot;
              const link = root.querySelector('.card a.card-btn');
              if (!link) return null;
              root.addEventListener('click', (event) => event.preventDefault(), { capture: true, once: true });
              link.click();
              return link.closest('.card').querySelector('.t').textContent;
            })()`);
            if (title) pressedBefore = { turn: i + 1, title };
          }
        }
        if (pressedBefore) {
          // Only the next message carries the press; the ones before and after carry none.
          pressesSent.forEach((pressed, index) => {
            if (index !== pressedBefore!.turn) assert.equal(pressed, null, `message ${index + 1} carries no press`);
          });
          const [press] = pressesSent[pressedBefore.turn] as { button: string; title: string; kind: string; id: unknown }[];
          assert.equal(press?.button, 'card');
          assert.equal(press?.title, pressedBefore.title);
          assert.ok(press?.kind && press.id !== undefined, 'the press names the item');
        }
        assert.deepEqual([...new Set(fake.calls.map((call) => call.fixtureId))].sort(), [...conversation.fixtures].sort(), 'calls exactly the fixtures the conversation lists');
        assert.equal(sessionIds.size, 1, 'one brain session for the whole conversation');
      } finally {
        await page.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  }
}
