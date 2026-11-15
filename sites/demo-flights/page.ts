// Demo Flights' page code (a made-up site, for tests): the page reader, with the page type from the URL's path, and the
// signed-in token the page keeps in a cookie once the traveler signs in (D7), read only when a trips call needs it.
import type { PageReader, PageTokenReader } from '../../platform/web/src/page.ts';

/** The page's signed-in token, from its demo_auth cookie; null when signed out. */
export const pageToken: PageTokenReader = async (storage) => {
  const cookie = storage.cookie.split('; ').find((part) => part.startsWith('demo_auth='));
  return cookie ? decodeURIComponent(cookie.slice('demo_auth='.length)) || null : null;
};

export const readPage: PageReader = (view) => {
  const path = new URL(view.url).pathname;
  return { context: { url: view.url, pageType: path.startsWith('/trips') ? 'trips' : path.startsWith('/results') ? 'results' : 'home', locale: 'en-US' }, data: null };
};
