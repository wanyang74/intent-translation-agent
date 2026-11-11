// Builds the Chrome extension for one site: a Manifest V3 folder with the content script (core.js, the site's pack,
// code, validators and page reader, and the overlay), the background worker, and a manifest whose content script
// runs on the site's pages (site.pages) and whose only host permission is the brain. Load the folder unpacked in
// chrome://extensions, or in the extension's tests.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'esbuild';
import { readSite, sitesDir } from '../../contract/src/site-pack.ts';

const extensionDir = fileURLToPath(new URL('../extension/', import.meta.url));
const contractGenerated = fileURLToPath(new URL('../../contract/generated/', import.meta.url));

/** Resolves 'site:bundle' to the site's materials (see extension/site-bundle.d.ts). */
function siteBundle(site: string): Plugin {
  const siteDir = path.join(sitesDir, site);
  const contents = [
    `export { default as pack } from ${JSON.stringify(path.join(siteDir, 'generated', 'site.json'))};`,
    `export { site as code } from ${JSON.stringify(path.join(siteDir, 'tools.ts'))};`,
    `export { readPage } from ${JSON.stringify(path.join(siteDir, 'page.ts'))};`,
    `export * as siteValidators from ${JSON.stringify(path.join(siteDir, 'generated', 'validators.js'))};`,
    // The platform's validators without the site-pack format's, which only build tools check.
    `export * as platformValidators from ${JSON.stringify(path.join(contractGenerated, 'runtime-validators.js'))};`,
  ].join('\n');
  return {
    name: 'site-bundle',
    setup(builder) {
      builder.onResolve({ filter: /^site:bundle$/ }, () => ({ path: 'site:bundle', namespace: 'site-bundle' }));
      builder.onLoad({ filter: /.*/, namespace: 'site-bundle' }, () => ({ contents, loader: 'js', resolveDir: siteDir }));
    },
  };
}

export interface ExtensionOptions {
  site: string;
  /** The brain's base URL, such as http://localhost:8787. */
  brainUrl: string;
  outDir: string;
}

/**
 * Builds the extension into `outDir`:
 *   1. The content script, with the site bundled in; the background worker, with the brain's URL compiled in.
 *   2. The manifest.
 */
export async function buildExtension(options: ExtensionOptions): Promise<void> {
  const { pack } = readSite(options.site);
  const brainUrl = options.brainUrl.replace(/\/+$/, '');
  rmSync(options.outDir, { recursive: true, force: true });
  mkdirSync(options.outDir, { recursive: true });

  // 1. The scripts.
  const common = { bundle: true, format: 'iife', platform: 'browser', target: 'es2022', logLevel: 'silent' } as const;
  await build({ ...common, entryPoints: [path.join(extensionDir, 'content.ts')], outfile: path.join(options.outDir, 'content.js'), plugins: [siteBundle(options.site)] });
  await build({ ...common, entryPoints: [path.join(extensionDir, 'background.ts')], outfile: path.join(options.outDir, 'background.js'), define: { BRAIN_URL: JSON.stringify(brainUrl) } });

  // 2. The manifest.
  const manifest = {
    manifest_version: 3,
    name: `Intent Agent for ${pack.site.name}`,
    version: '0.1.0',
    description: `Ask for what you want on ${pack.site.name}; the agent searches and compares for you. Read-only.`,
    background: { service_worker: 'background.js' },
    content_scripts: [{ matches: pack.site.pages, js: ['content.js'], run_at: 'document_idle' }],
    // storage: the saved conversation, so it follows the user from page to page of the site (session storage only).
    permissions: ['storage'],
    host_permissions: [`${new URL(brainUrl).origin}/*`],
  };
  writeFileSync(path.join(options.outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}
