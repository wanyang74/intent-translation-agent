// Carvana's page reader for the web surface. The page type comes from the URL: a vehicle page puts its car on screen
// (/vehicle/<id>), and search results live under /cars. On a vehicle page, the car's details come from the data the
// page embeds for itself: Carvana's pages are Next.js App Router pages, which stream their data as
// `self.__next_f.push([1, "<chunk>"])` scripts. The car is the object in that data with its vehicle ID, make, model
// and mileage (found live on 2026-10-20). The visitor's location comes from Carvana's own cookies (CVCurrentZip,
// CVCurrentState): Carvana's guess from the visitor's network, or the zip they set on the site. Either way the agent
// says which zip it used, so the user can correct it.
import type { PageContext } from '../../platform/contract/generated/types.ts';
import type { PageReader } from '../../platform/web/src/page.ts';

const FLIGHT = 'self.__next_f.push(';

/** The page's streamed data, joined: each script's chunk is the string in its pushed [1, "..."] array. */
function flightData(scripts: string[]): string {
  return scripts.filter((text) => text.startsWith(FLIGHT)).map((text) => {
    try {
      const entry = JSON.parse(text.slice(FLIGHT.length, text.lastIndexOf(')')));
      return Array.isArray(entry) && typeof entry[1] === 'string' ? entry[1] : '';
    } catch {
      return '';
    }
  }).join('');
}

/**
 * The JSON object around position `at`:
 *   1. Walk back to the brace that opens the object holding `at`, counting the braces of objects that close in between.
 *   2. Walk forward to its closing brace, skipping braces inside strings.
 *   3. Parse it; null if it isn't JSON.
 */
function objectAround(data: string, at: number): Record<string, unknown> | null {
  // 1. The opening brace. A brace inside a string before `at` could mislead this; step 3 rejects what doesn't parse.
  let depth = 0;
  let start = -1;
  for (let i = at; i >= 0; i--) {
    if (data[i] === '}') depth++;
    else if (data[i] === '{') {
      if (depth === 0) {
        start = i;
        break;
      }
      depth--;
    }
  }
  if (start < 0) return null;
  // 2. The closing brace.
  let inString = false;
  depth = 0;
  for (let i = start; i < data.length; i++) {
    const char = data[i];
    if (inString) {
      if (char === '\\') i++;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      // 3. Parse.
      try {
        return JSON.parse(data.slice(start, i + 1)) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** The car's record as the tools keep it (the same fields a search result gives), or null if the page has none. */
function carOnPage(scripts: string[], vehicleId: number): Record<string, unknown> | null {
  const data = flightData(scripts);
  const key = `"vehicleId":${vehicleId}`;
  for (let at = data.indexOf(key); at >= 0; at = data.indexOf(key, at + 1)) {
    const car = objectAround(data, at);
    if (!car || typeof car.make !== 'string' || typeof car.model !== 'string' || typeof car.mileage !== 'number') continue;
    const location = car.location as { locationId?: unknown } | undefined;
    if (typeof location?.locationId !== 'number' || typeof car.year !== 'number') continue;
    return {
      vehicleId, year: car.year, make: car.make, model: car.model, trim: car.trim, mileage: car.mileage, color: car.exteriorColor,
      ...(typeof car.price === 'number' ? { price: car.price } : {}),
      // Search results number the inventory type (1 is Carvana's own stock); the vehicle page names it.
      vehicleInventoryType: car.inventoryType === 'Core' ? 1 : 2,
      locationId: location.locationId,
    };
  }
  return null;
}

/** One cookie's value, or null. */
function cookieValue(cookie: string, name: string): string | null {
  const pair = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  if (!pair) return null;
  try {
    return decodeURIComponent(pair.slice(name.length + 1));
  } catch {
    return null;
  }
}

/** The visitor's location as Carvana has it, marked as a guess; nothing unless the zip is five digits. */
function visitorLocation(cookie: string): { location?: NonNullable<PageContext['location']> } {
  const zip = cookieValue(cookie, 'CVCurrentZip');
  if (!zip || !/^\d{5}$/.test(zip)) return {};
  const state = cookieValue(cookie, 'CVCurrentState');
  return { location: { postalCode: zip, ...(state && /^[A-Z]{2}$/.test(state) ? { region: state } : {}), country: 'US', estimated: true } };
}

export const readPage: PageReader = (view) => {
  const url = new URL(view.url);
  const where = visitorLocation(view.cookie);
  const vehicle = url.pathname.match(/^\/vehicle\/(\d+)(?:\/|$)/);
  if (vehicle) {
    const vehicleId = Number(vehicle[1]);
    return { context: { url: view.url, pageType: 'vehicle', entity: { kind: 'vehicle', id: vehicleId }, ...where, locale: 'en-US' }, data: carOnPage(view.scripts(), vehicleId) };
  }
  const pageType = /^\/cars(\/|$)/.test(url.pathname) ? 'search' : 'other';
  return { context: { url: view.url, pageType, ...where, locale: 'en-US' }, data: null };
};
