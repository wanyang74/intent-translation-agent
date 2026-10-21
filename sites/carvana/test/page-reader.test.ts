// Tests: Carvana's page reader reads a vehicle page the way the live site embeds its data (Next.js streamed
// chunks, seen live on 2026-10-20), and only the car on screen.
// How: a made-up page in the live format: the car split across two chunks, next to other objects that carry the same
// vehicle ID (the site's own request bodies), escaped quotes and braces inside strings.
// Passes when: the car's record has the fields the tools use, and a page without the car gives no data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPage } from '../page.ts';

const push = (chunk: string) => `self.__next_f.push(${JSON.stringify([1, chunk])})`;
const car = {
  vehicleId: 4812031, make: 'Tesla', model: 'Model Y', year: 2023, trim: 'Long Range', mileage: 27689, exteriorColor: 'Gray', inventoryType: 'Core', price: 35590,
  location: { city: 'San Jose', locationId: 300 }, highlights: ['Says "hi" {not a brace}'],
};
const flight = `c:["$","div",{"vehicleId":4812031,"page":"vdp"}]\n9:{"car":${JSON.stringify(car)},"request":{"vehicleId":4812031,"zip5":"00000"}}`;
const view = (url: string, scripts: string[]) => ({ url, text: () => null, cookie: '', scripts: () => scripts });

test("vehicle page: the car's record comes from the page's streamed data", () => {
  const half = Math.floor(flight.length / 2);
  const { context, data } = readPage(view('https://www.carvana.com/vehicle/4812031', ['var unrelated = 1;', push(flight.slice(0, half)), push(flight.slice(half))]));
  assert.deepEqual(context.entity, { kind: 'vehicle', id: 4812031 });
  assert.deepEqual(data, { vehicleId: 4812031, year: 2023, make: 'Tesla', model: 'Model Y', trim: 'Long Range', mileage: 27689, color: 'Gray', price: 35590, vehicleInventoryType: 1, locationId: 300 });
});

test('vehicle page: no data for a car the page does not carry, or on other pages', () => {
  assert.equal(readPage(view('https://www.carvana.com/vehicle/999', [push(flight)])).data, null);
  assert.equal(readPage(view('https://www.carvana.com/cars/tesla', [push(flight)])).data, null);
});
