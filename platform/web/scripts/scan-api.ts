// Maps the APIs a site's frontend can call, for a person to read before any of them goes into the site pack. It reads
// the site's own JavaScript, as every visitor's browser downloads it, and lists the API addresses written in it; it
// calls none of them. Two parts:
//   collect: from HAR recordings a person made (no site calls at all: the scripts and the calls their browser made
//            are in them), or live: open each page given in Chrome (a person answers a bot check, headed), note the
//            API calls the page makes as it loads, and download the scripts it loaded, plus the ones its bundler can
//            load later, paced at the site pack's rate limit. Into dist/scan/<site>/<name>/ (git-ignored)
//   analyze: read those files offline and write sites/<site>/research/api-scan/<name>/endpoints.md and .json
//   npm run scan-api -- --site <id> --har <file> [--har <file>]                from recordings
//   npm run scan-api -- --site <id> --url <page> [--url <page>] [--headed]     live
//   npm run scan-api -- --site <id> --analyze dist/scan/<site>/<name>          analyze again, offline
// What it can't see: calls the site's servers make for a page (their results arrive inside the HTML), request and
// response shapes beyond the names written near each address, and addresses built at run time from pieces. Nothing
// in the site pack changes; the report marks which addresses the pack already uses.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadContract } from '../../contract/src/load.ts';
import { endpointOf, entriesOf, repoRoot } from '../../contract/src/site-pack.ts';
import type { ChromePage } from '../build/chrome.ts';
import { addressesIn, FLAG_WORDS, isStatic, laterChunks, maskIds } from '../build/api-addresses.ts';
import { openSitePage, pacer, passCheck, settle } from '../build/site-page.ts';

const { values: options } = parseArgs({
  options: {
    site: { type: 'string' }, url: { type: 'string', multiple: true }, har: { type: 'string', multiple: true }, analyze: { type: 'string' }, headed: { type: 'boolean', default: false },
  },
});
if (!options.site || (!options.url?.length && !options.har?.length && !options.analyze)) {
  console.error('Pass --site and at least one --har or --url to collect, or --analyze <folder> to analyze a collection again.');
  process.exit(1);
}
const site = options.site;
const { pack } = loadContract({ sites: [site] }).sites[site]!;
const today = new Date().toISOString().slice(0, 10);

/** What collect leaves for analyze. */
interface Collection {
  collected: string;
  /** Pages scanned live, or one entry per HAR. Calls carry their method when it's known (HARs have it). */
  pages: { url: string; title: string; scripts: string[]; calls: { method: string | null; url: string }[] }[];
  /** Script URL → its file name in js/. */
  scripts: Record<string, string>;
  /** Scripts the bundler can load later that weren't collected: the scan didn't read them. */
  notCollected: string[];
}

const fileNameOf = (url: string) => {
  const address = new URL(url);
  return `${address.host}${address.pathname}`.replace(/[^A-Za-z0-9._-]/g, '_').slice(-150);
};
const withoutValues = (url: string) => {
  const address = new URL(url);
  const names = [...new Set(address.searchParams.keys())].sort();
  return `${address.origin}${address.pathname}${names.length ? `?${names.join('&')}` : ''}`;
};

// ---------------------------------------------------------------- collect

/** The page's loaded scripts and the API calls it made, from the browser's own resource timing list. */
const RESOURCES = `(() => {
  const entries = performance.getEntriesByType('resource');
  return {
    title: document.title,
    scripts: entries.filter((entry) => entry.initiatorType === 'script' || /\\.m?js(\\?|$)/.test(entry.name)).map((entry) => entry.name),
    calls: entries.filter((entry) => ['fetch', 'xmlhttprequest', 'beacon'].includes(entry.initiatorType)).map((entry) => entry.name),
  };
})()`;


/**
 * Collects:
 *   1. Open the first page; each later page in the same tab. A bot check on any page waits for a person (headed);
 *      if a page can't be read, the scan goes on with the scripts already found.
 *   2. On each page: wait, scroll to the end so lazy parts load, and keep its scripts and API calls.
 *   3. Download every script, then the later chunks its bundler runtime lists, paced; keep each file.
 *   4. Write collection.json beside them.
 */
async function collect(urls: string[]): Promise<string> {
  const dir = path.join(repoRoot, 'dist', 'scan', site, today);
  mkdirSync(path.join(dir, 'js'), { recursive: true });
  const pace = pacer(pack.policies.rateLimitPerSecond);
  const collection: Collection = { collected: new Date().toISOString(), pages: [], scripts: {}, notCollected: [] };
  // 1. The first page.
  const page: ChromePage = await openSitePage(urls[0]!, { headed: options.headed });
  try {
    for (const [i, url] of urls.entries()) {
      if (i > 0) {
        await pace();
        await page.goto(url);
        await settle(page, 2000);
        try {
          await passCheck(page, options.headed);
        } catch (error) {
          console.log(`${url}: ${(error as Error).message}; stopping at the pages read so far`);
          break;
        }
      }
      // 2. Let it finish, scroll through it, and read what it loaded.
      await settle(page, 3000);
      await page.evaluate(`new Promise((resolve) => { let y = 0; const step = () => { y += innerHeight; scrollTo(0, y); y < document.documentElement.scrollHeight ? setTimeout(step, 400) : setTimeout(resolve, 2000); }; step(); })`);
      const loaded = await page.evaluate<{ title: string; scripts: string[]; calls: string[] }>(RESOURCES);
      collection.pages.push({ url: withoutValues(url), title: loaded.title, scripts: [...new Set(loaded.scripts)], calls: [...new Set(loaded.calls.map(withoutValues))].sort().map((call) => ({ method: null, url: call })) });
      console.log(`${url}: ${loaded.scripts.length} scripts, ${loaded.calls.length} API calls while loading`);
    }

    // 3. The scripts. Ones already loaded come from the browser's cache; later chunks are new downloads.
    const queue = [...new Set(collection.pages.flatMap((loaded) => loaded.scripts))];
    const download = async (url: string) => {
      if (collection.scripts[url] !== undefined) return null;
      await pace();
      const text = await page.evaluate<string | null>(`fetch(${JSON.stringify(url)}, { cache: 'force-cache' }).then((response) => response.ok ? response.text() : null, () => null)`);
      if (text === null) return null;
      const name = fileNameOf(url);
      writeFileSync(path.join(dir, 'js', name), text);
      collection.scripts[url] = name;
      return text;
    };
    for (const url of queue) {
      const text = await download(url);
      if (text && /\/webpack-[^/]*\.js$/.test(new URL(url).pathname)) queue.push(...laterChunks(url, text).filter((chunk) => !queue.includes(chunk)));
    }
    console.log(`downloaded ${Object.keys(collection.scripts).length} scripts (${queue.length - collection.pages.flatMap((loaded) => loaded.scripts).length} found through the bundler)`);
  } finally {
    await page.close();
  }
  // 4. What was collected.
  writeFileSync(path.join(dir, 'collection.json'), JSON.stringify(collection, null, 1));
  return dir;
}

/**
 * Collects from HAR recordings, calling nothing:
 *   1. Each HAR is one "page": its scripts (with their text, base64 or not) and its API calls with their methods.
 *   2. Later chunks the bundler runtime lists but the recording doesn't hold are noted as not collected.
 *   3. Write collection.json beside the scripts.
 */
function collectFromHars(files: string[]): string {
  const dir = path.join(repoRoot, 'dist', 'scan', site, `${today}-har`);
  mkdirSync(path.join(dir, 'js'), { recursive: true });
  const collection: Collection = { collected: new Date().toISOString(), pages: [], scripts: {}, notCollected: [] };
  const later = new Set<string>();
  for (const file of files) {
    // 1. Scripts and calls.
    const entries: any[] = JSON.parse(readFileSync(file, 'utf8')).log.entries;
    const scripts: string[] = [];
    const calls = new Map<string, { method: string; url: string }>();
    for (const entry of entries) {
      const url: string = entry.request.url;
      const mimeType: string = entry.response.content?.mimeType ?? '';
      if (/javascript/.test(mimeType) || /\.m?js(\?|$)/.test(url)) {
        const content = entry.response.content;
        if (!content?.text) continue;
        const text = content.encoding === 'base64' ? Buffer.from(content.text, 'base64').toString('utf8') : content.text;
        const name = fileNameOf(url);
        writeFileSync(path.join(dir, 'js', name), text);
        collection.scripts[url] = name;
        scripts.push(url);
        if (/\/webpack-[^/]*\.js$/.test(new URL(url).pathname)) for (const chunk of laterChunks(url, text)) later.add(chunk);
      } else if (['xhr', 'fetch', 'beacon', 'ping'].includes(entry._resourceType) || (entry.request.method !== 'GET' && !/html/.test(mimeType))) {
        const call = { method: entry.request.method as string, url: withoutValues(url) };
        calls.set(`${call.method} ${call.url}`, call);
      }
    }
    collection.pages.push({ url: path.basename(file), title: `recording, ${String(entries[0]?.startedDateTime ?? '').slice(0, 10)}`, scripts, calls: [...calls.values()].sort((left, right) => left.url.localeCompare(right.url)) });
    console.log(`${path.basename(file)}: ${scripts.length} scripts with their text, ${calls.size} distinct API calls`);
  }
  // 2. What the bundler could load that the recordings don't hold.
  collection.notCollected = [...later].filter((url) => collection.scripts[url] === undefined).sort();
  // 3. What was collected.
  writeFileSync(path.join(dir, 'collection.json'), JSON.stringify(collection, null, 1));
  return dir;
}

// ---------------------------------------------------------------- analyze

/** One API address found in the code or seen while a page loaded. */
interface Found {
  host: string;
  path: string;
  methods: string[];
  queryNames: string[];
  /** The site pack's endpoint at this address, if any. */
  inPack: string | null;
  /** Seen called while a scanned page loaded (not just written in the code). */
  seenLive: boolean;
  files: string[];
  /** Words in the address that suggest it changes something or needs an account. */
  flags: string[];
  /** Up to two short stretches of code around the address, for reading parameter names. */
  context: string[];
}


/** The pack's endpoint that a found address belongs to; IDs and placeholders stand in for the pack's {params}. */
function packEndpoint(host: string, foundPath: string): string | null {
  const sample = foundPath.replace(/\{[^}]*\}/g, '1');
  for (const origin of host === '(relative)' ? pack.site.origins : [`https://${host}`]) {
    const match = endpointOf(pack, `${origin}${sample}`);
    if (match) return match.name;
  }
  // Addresses written in the code often end at the API's base, before a version or a final segment.
  for (const [name, endpoint] of entriesOf(pack.endpoints)) {
    const endpointPath = new URL(endpoint.url.replace(/\{[^}]*\}/g, '1')).pathname;
    if (endpointPath === sample || (sample.length > 8 && endpointPath.endsWith(sample))) return name;
  }
  return null;
}

/**
 * Analyzes a collection:
 *   1. For each script: every string literal that is an API address, with methods and code nearby.
 *   2. Add the calls seen while pages loaded.
 *   3. Mark which ones the pack uses, and the flags.
 *   4. Write endpoints.json (everything) and endpoints.md (for reading), grouped by host.
 */
function analyze(dir: string): void {
  const collection = JSON.parse(readFileSync(path.join(dir, 'collection.json'), 'utf8')) as Collection;
  const found = new Map<string, Found>();
  const add = (address: { host: string; path: string; queryNames: string[] }, file: string | null, methods: string[], context: string | null, seenLive: boolean) => {
    const key = `${address.host} ${address.path}`;
    const entry = found.get(key) ?? { host: address.host, path: address.path, methods: [], queryNames: [], inPack: null, seenLive: false, files: [], flags: [], context: [] };
    entry.methods = [...new Set([...entry.methods, ...methods])].sort();
    entry.queryNames = [...new Set([...entry.queryNames, ...address.queryNames])].sort();
    if (file && !entry.files.includes(file)) entry.files.push(file);
    if (context && entry.context.length < 2 && !entry.context.includes(context)) entry.context.push(context);
    entry.seenLive ||= seenLive;
    found.set(key, entry);
  };
  // 1. The code.
  for (const [url, name] of Object.entries(collection.scripts)) {
    const file = path.join(dir, 'js', name);
    if (!existsSync(file)) continue;
    const code = readFileSync(file, 'utf8');
    for (const found of addressesIn(code)) add(found.address, new URL(url).pathname.split('/').pop()!, found.methods, found.context, false);
  }
  // 2. The calls the pages made.
  for (const loaded of collection.pages) {
    for (const call of loaded.calls) {
      const address = new URL(call.url);
      if (isStatic(address.pathname)) continue;
      add({ host: address.host, path: maskIds(address.pathname), queryNames: [...address.searchParams.keys()] }, null, call.method ? [call.method] : [], null, true);
    }
  }
  // 3. The pack, and the flags.
  for (const entry of found.values()) {
    entry.inPack = packEndpoint(entry.host, entry.path);
    entry.flags = FLAG_WORDS.filter((word) => new RegExp(`(^|[^a-z])${word}`, 'i').test(entry.path));
  }
  // 4. The report. Recorded calls appear only as masked endpoints, never as the raw URLs (they hold visitors' IDs).
  // Hosts the site pack lists come first; the rest are mostly analytics and third parties.
  const packHosts = new Set(pack.site.origins.map((origin) => new URL(origin).host));
  const siteWord = new URL(pack.site.origins[0]!).host.split('.').slice(-2)[0]!;
  const rank = (host: string) => (packHosts.has(host) ? 0 : host === '(relative)' ? 1 : host.includes(siteWord) ? 2 : 3);
  const all = [...found.values()].sort((left, right) => rank(left.host) - rank(right.host) || left.host.localeCompare(right.host) || left.path.localeCompare(right.path));
  const outDir = path.join(repoRoot, 'sites', site, 'research', 'api-scan', path.basename(dir));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'endpoints.json'), JSON.stringify({ collected: collection.collected, pages: collection.pages.map((loaded) => ({ url: loaded.url, title: loaded.title, scripts: loaded.scripts.length, calls: loaded.calls.length })), scripts: Object.keys(collection.scripts).length, notCollected: collection.notCollected.length, endpoints: all }, null, 1) + '\n');

  const lines = [
    `# ${site}: API addresses in the frontend code`,
    '',
    `Collected ${collection.collected.slice(0, 10)} from ${collection.pages.length} pages and ${Object.keys(collection.scripts).length} scripts by \`npm run scan-api\`. A map for reading, not part of the site pack: nothing here is called or trusted.`,
    '',
    '- **in pack**: the site pack already has this endpoint. **live**: the browser called it (while a scanned page loaded, or in the recording); the others are only written in the code.',
    "- **methods**: written near the address in the code, so a guess. **flags**: words in the address suggesting it changes something or needs an account; check before any use.",
    "- Not here: calls the site's servers make while building a page (their results come inside the HTML), addresses built from pieces at run time, and request or response shapes. `endpoints.json` has two short stretches of code around each address, for parameter names.",
    '',
    '## Pages scanned',
    '',
    ...collection.pages.map((loaded) => `- ${loaded.url} (${loaded.title}): ${loaded.scripts.length} scripts, ${loaded.calls.length} calls`),
    ...(collection.notCollected.length ? ['', `Not read: ${collection.notCollected.length} more scripts the site's bundler can load later (for flows not opened, such as financing or selling a car). Their addresses aren't here.`] : []),
  ];
  // The site's own hosts get a table each; other hosts (analytics, ads, fonts, documentation links) one line each.
  const hosts = [...new Set(all.map((entry) => entry.host))];
  const otherHosts = hosts.filter((host) => rank(host) === 3);
  for (const host of hosts.filter((candidate) => rank(candidate) < 3)) {
    const rows = all.filter((entry) => entry.host === host);
    lines.push('', `## ${host === '(relative)' ? 'Relative addresses (on the page’s own origin or a base URL set elsewhere)' : host} (${rows.length})`, '', '| address | methods | query | in pack | live | flags | files |', '|---|---|---|---|---|---|---|');
    for (const entry of rows) {
      lines.push(`| \`${entry.path.replace(/\|/g, '\\|')}\` | ${entry.methods.join(' ')} | ${entry.queryNames.join(', ')} | ${entry.inPack ?? ''} | ${entry.seenLive ? 'yes' : ''} | ${entry.flags.join(', ')} | ${entry.files.length} |`);
    }
  }
  if (otherHosts.length) {
    lines.push('', `## Other hosts (${otherHosts.length})`, '', 'Hosts outside the site: analytics, ads, consent, fonts, partners and links in comments. Addresses are in endpoints.json.', '');
    for (const host of otherHosts) {
      const rows = all.filter((entry) => entry.host === host);
      lines.push(`- ${host}: ${rows.map((entry) => `\`${entry.path}\`${entry.seenLive ? ' (live)' : ''}`).slice(0, 3).join(', ')}${rows.length > 3 ? `, and ${rows.length - 3} more` : ''}`);
    }
  }
  writeFileSync(path.join(outDir, 'endpoints.md'), lines.join('\n') + '\n');
  const inPack = all.filter((entry) => entry.inPack).length;
  console.log(`${all.length} addresses on ${hosts.length} hosts (${inPack} already in the site pack, ${all.filter((entry) => entry.seenLive).length} seen live); wrote ${path.relative(process.cwd(), outDir)}/endpoints.md and endpoints.json`);
}

const collectionDir = options.analyze ? path.resolve(options.analyze)
  : options.har?.length ? collectFromHars(options.har.map((file) => path.resolve(file)))
  : await collect(options.url!);
analyze(collectionDir);
