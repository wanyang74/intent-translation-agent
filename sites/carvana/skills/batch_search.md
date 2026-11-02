<!-- Draft (2026-10-14), not reviewed yet. The model sees everything below this comment when it loads the skill; the part
     between the script markers only on a device that can run scripts. -->
# Batch search

Requests that need many calls: checking every page of a search, or delivery dates for many cars.

## Plan the calls
- Narrow with filters first: make, model, year, mileage, price, colors, drive type. A filter costs nothing; every page is a call.
- search_vehicles returns 24 cars a page; totalPages says how many pages match. get_delivery_dates takes up to 24 cars per call.
- Each task can make 60 calls to Carvana, one per second. A search with 29 pages plus delivery dates for every car would use about 58 of them and take about a minute.
- When more than 4 pages match, ask the user to narrow the search, or check the first pages and say how many you checked.
- Always say how many cars you checked out of how many match, such as "I checked 24 of 1,871".

<!-- scripts -->
## Write a script
Use run_script when the work needs more than a few calls. For example, the first three pages of a search and delivery dates for every car on them:

```js
const filters = { zip5: '94402', make: 'Tesla', drive_types: ['Awd'] };
const first = await tools.search_vehicles(filters);
let cars = first.vehicles;
for (let page = 2; page <= Math.min(first.totalPages, 3); page++) {
  const next = await tools.search_vehicles({ ...filters, page });
  cars = cars.concat(next.vehicles);
}
const ready = [];
for (let i = 0; i < cars.length; i += 24) {
  const { dates } = await tools.get_delivery_dates({ vehicleIds: cars.slice(i, i + 24).map((car) => car.vehicleId), zip5: filters.zip5 });
  for (const date of dates) if (date.delivery && date.delivery.date <= '2026-10-11T06:59:59Z') ready.push(date.vehicleId);
}
return { ids: ready, checked: cars.length, matches: first.totalMatches };
```

- Return IDs and counts, never whole results. Then show the IDs with present_items.
- A tool's error reaches the script as an exception. Catch it if the script can go on without that call.
<!-- /scripts -->
