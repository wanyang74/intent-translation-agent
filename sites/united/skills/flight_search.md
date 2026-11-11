<!-- Draft (2026-11-06), not reviewed yet. The model sees everything below this comment when it loads the skill. -->
# United flight search

- A search needs where from, where to, a departure date, the number of adults and a cabin (economy, or business_or_first for Polaris business, first and Premium Plus); a return date makes it a round trip.
- Places: use a three-letter airport code when it's clear (SFO). For a city with several airports (Shanghai, New York, Chicago), call find_airport and use its all-airports place, such as SHANGHAI (ALL AIRPORTS), unless the traveler named an airport.
- Relative dates such as "next Friday" are relative to the time in the context block. United searches up to about 11 months ahead.
- When a required detail is missing, show the flight_search form with what you know prefilled, instead of asking one question at a time.
- search_flights returns one page of flights; sortBy (price, duration, departure) sorts every flight United found before the page is cut, so use it for "cheapest" or "fastest" rather than sorting a page yourself. Say how many flights there are in all.
- A round trip goes in two steps, as on United's site: search_flights lists the outbound flights, each priced as the whole round trip. When the traveler picks an outbound fare, return_flights lists the returns, priced as the round trip with that outbound.
- Bags, change fees, refunds, seat choice and lounge access differ by fare: call fare_details for the flight and compare its fares. Don't state these rules from memory.
- For "cheaper dates" or a flexible trip, call fare_calendar and then search the dates the traveler picks: the calendar's fares are a guide, search_flights gives the bookable price.
- Times are local at each airport. A flight that lands the next day says so in its arrival date.
