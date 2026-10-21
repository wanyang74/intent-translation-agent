// The site's materials, bundled into the content script by build/extension.ts (a virtual module, 'site:bundle').
declare module 'site:bundle' {
  import type { SitePack } from '../../contract/generated/types.ts';
  import type { SiteCode } from '../../core/src/execute/site-code.ts';
  import type { PageReader } from '../src/page.ts';
  export const pack: SitePack;
  export const code: SiteCode;
  export const platformValidators: Record<string, unknown>;
  export const siteValidators: Record<string, unknown>;
  export const readPage: PageReader;
}
