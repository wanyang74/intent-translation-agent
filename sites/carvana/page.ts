// Carvana's page reader for the web surface. The page type comes from the URL: a vehicle page puts its car on screen
// (/vehicle/<id>), and search results live under /cars. On a vehicle page, the car's details come from the data the
// page embeds for itself: Carvana's pages are Next.js App Router pages, which stream their data as
// `self.__next_f.push([1, "<chunk>"])` scripts, read by flight.ts. The car is the object in that data with its
// vehicle ID, make, model and mileage (found live on 2026-10-20). The visitor's location comes from Carvana's own cookies (CVCurrentZip,
// CVCurrentState): Carvana's guess from the visitor's network, or the zip they set on the site. Either way the agent
// says which zip it used, so the user can correct it.
import type { PageContext } from '../../platform/contract/generated/types.ts';
import type { PageReader } from '../../platform/web/src/page.ts';
import { flightData, objectAround } from './flight.ts';

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
