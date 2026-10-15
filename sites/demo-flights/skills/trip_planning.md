<!-- Draft (2026-10-14), not reviewed yet. The model sees everything below this comment when it loads the skill. -->
# Trip planning

- A search needs an origin and a destination airport code, a departure date, the number of adults and a cabin; a return date is optional.
- City names: use the main airport's code when it's clear (Seattle: SEA). When a city has several airports (New York: JFK, LGA and EWR), ask which one, unless the user named it.
- Relative dates such as "next Friday" are relative to the time in the context block.
- When a required detail is missing, show the flight_search form with what you know prefilled, instead of asking one question at a time.
- Prices include all taxes and fees. Offers expire: if the user comes back later, search again before talking about prices.
