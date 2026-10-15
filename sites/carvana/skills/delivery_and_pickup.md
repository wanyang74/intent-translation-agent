<!-- Draft (2026-10-14), not reviewed yet. The model sees everything below this comment when it loads the skill. -->
# Delivery and pickup

- get_delivery_dates checks up to 24 cars in one call. Check a whole page of results at once, not car by car.
- A car can have a delivery date (Carvana brings it to the user's zip code) and a pickup date (the user collects it at a Carvana location). Either can be missing.
- Dates in results are UTC. "By Saturday" means by the end of Saturday in the user's time zone: work out the time zone from their zip code, convert, then compare. The text field, such as "Saturday", is what Carvana shows the user.
- A quote is for delivery unless the user wants pickup: call get_vehicle_quote with option pickup. If delivery isn't available, the quote's error says to try pickup.
- A different zip code needs new dates: call get_delivery_dates again with that zip code before quoting.
- Route IDs are internal. Never show or mention them.
