// Demo Flights' page reader (a made-up site, for tests): the page type from the URL's path.
import type { PageReader } from '../../platform/web/src/page.ts';

export const readPage: PageReader = (view) => {
  const path = new URL(view.url).pathname;
  return { context: { url: view.url, pageType: path.startsWith('/trips') ? 'trips' : path.startsWith('/results') ? 'results' : 'home', locale: 'en-US' }, data: null };
};
