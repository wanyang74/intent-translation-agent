// United's page reader: the page type from the URL's path. The results page (/fsr/choose-flights) is a search's;
// the home page is where searches start; anything else (trips, check-in, help) is "other". United's pages carry
// nothing the agent reads about the item on screen.
import type { PageReader } from '../../platform/web/src/page.ts';

export const readPage: PageReader = (view) => {
  const path = new URL(view.url).pathname.replace(/\/+$/, '');
  const pageType = /\/fsr\/choose-flights$/.test(path) ? 'results' : /^(\/[a-z]{2}\/[a-z]{2})?$/.test(path) ? 'home' : 'other';
  return { context: { url: view.url, pageType, locale: 'en-US' }, data: null };
};
