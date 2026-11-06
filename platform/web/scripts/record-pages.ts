// Records a site's page endpoints (responseFormat: html, such as a product page) into a HAR, without a person
// clicking through DevTools: it opens a page of the site in Chrome, finds links to the endpoint there (or takes the
// IDs given), and fetches each from inside the page, same-origin, as the site's own frontend would, at the site
// pack's rate limit.
//   npm run record-pages -- --site <id> --endpoint <name> --from <page url> [--count 5] [--headed]
//   npm run record-pages -- --site <id> --endpoint <name> --from <page url> --id <id> [--id <id>] [--headed]
// The HAR goes to recordings/ (git-ignored: a page can hold the visitor's location and IDs); fixtures are made from
// it later, with identifiers scrubbed. It stops at the first answer that isn't a 200 page, and at any bot check.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadContract } from '../../contract/src/load.ts';
import { endpointOf, repoRoot } from '../../contract/src/site-pack.ts';
import { HUMAN_CHECK, openSitePage, pacer, settle } from '../build/site-page.ts';

const { values: options } = parseArgs({
  options: {
    site: { type: 'string' }, endpoint: { type: 'string' }, from: { type: 'string' }, id: { type: 'string', multiple: true },
    count: { type: 'string', default: '5' }, headed: { type: 'boolean', default: false },
  },
});
if (!options.site || !options.endpoint || !options.from) {
  console.error('Pass --site, --endpoint and --from (a page of the site to start on), and optionally --id or --count.');
  process.exit(1);
}
const { pack } = loadContract({ sites: [options.site] }).sites[options.site]!;
const endpoint = pack.endpoints[options.endpoint];
if (!endpoint || endpoint.method !== 'GET' || endpoint.responseFormat !== 'html') {
  console.error(`${options.endpoint} isn't a page endpoint of ${options.site} (a GET with responseFormat: html).`);
  process.exit(1);
}
const [paramName, ...extraParams] = [...endpoint.url.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((match) => match[1]!);
if (!paramName || extraParams.length) {
  console.error(`${options.endpoint}'s URL needs exactly one {parameter} to record by ID.`);
  process.exit(1);
}
const urlFor = (id: string) => endpoint.url.replace(`{${paramName}}`, encodeURIComponent(id));
const pace = pacer(pack.policies.rateLimitPerSecond);

/**
 * One recording:
 *   1. Open the start page (a person answers a bot check, headed).
 *   2. The IDs: the ones given, or the first --count distinct links on the page that belong to the endpoint.
 *   3. Fetch each page from inside the site's page, paced; stop at the first that isn't a 200 page.
 *   4. Write the HAR and say what was kept.
 */
// 1. The start page.
const page = await openSitePage(options.from, { headed: options.headed });
const entries: object[] = [];
try {
  // 2. The IDs. Result lists often draw their links after the load event, so look for a few seconds.
  let ids = options.id ?? [];
  if (!ids.length) {
    for (let i = 0; i < 10 && !ids.length; i++) {
      await settle(page, 1000);
      const links = await page.evaluate<string[]>(`[...document.querySelectorAll('a[href]')].map((anchor) => anchor.href)`);
      ids = [...new Set(links.map((link) => endpointOf(pack, link)).filter((match) => match?.name === options.endpoint).map((match) => match!.params[paramName]!))];
    }
    ids = ids.slice(0, Number(options.count));
    if (!ids.length) throw new Error(`no links to ${options.endpoint} on ${options.from}`);
  }
  console.log(`recording ${ids.length} ${options.endpoint} page(s): ${ids.join(', ')}`);

  // 3. The pages, fetched in the page so they carry what the site's own frontend would (its cookies, its origin).
  for (const id of ids) {
    await pace();
    const url = urlFor(id);
    const started = new Date();
    const answer = await page.evaluate<{ status: number; headers: [string, string][]; text: string }>(`fetch(${JSON.stringify(url)}, { headers: { accept: 'text/html' }, credentials: 'same-origin' })
      .then(async (response) => ({ status: response.status, headers: [...response.headers.entries()], text: await response.text() }))`);
    const blocked = /Verify you are human|Just a moment|security verification/i.test(answer.text.slice(0, 5000)) && answer.text.length < 50_000;
    console.log(`${id}: ${answer.status}, ${Math.round(answer.text.length / 1024)} KB${blocked ? ', a bot check' : ''}`);
    if (answer.status !== 200 || blocked) {
      console.log('stopping: the site answered with something other than the page');
      break;
    }
    entries.push({
      startedDateTime: started.toISOString(), time: Date.now() - started.getTime(),
      request: { method: 'GET', url, httpVersion: 'HTTP/1.1', headers: [{ name: 'accept', value: 'text/html' }], queryString: [], cookies: [], headersSize: -1, bodySize: 0 },
      response: {
        status: answer.status, statusText: '', httpVersion: 'HTTP/1.1', cookies: [], redirectURL: '', headersSize: -1, bodySize: answer.text.length,
        headers: answer.headers.map(([name, value]) => ({ name, value })),
        content: { size: answer.text.length, mimeType: answer.headers.find(([name]) => name === 'content-type')?.[1] ?? 'text/html', text: answer.text },
      },
      cache: {}, timings: { send: 0, wait: 0, receive: 0 },
    });
  }
  if (await page.evaluate<boolean>(HUMAN_CHECK)) console.log('note: the start page now shows a bot check');
} finally {
  await page.close();
}

// 4. The HAR.
if (!entries.length) {
  console.error('Nothing recorded.');
  process.exit(1);
}
const file = path.join(repoRoot, 'recordings', `${options.site}-${new Date().toISOString().slice(0, 10)}-${options.endpoint}.har`);
mkdirSync(path.dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify({ log: { version: '1.2', creator: { name: 'record-pages', version: '1' }, entries } }, null, 1));
console.log(`wrote ${entries.length} page(s) to ${path.relative(process.cwd(), file)} (git-ignored)`);
