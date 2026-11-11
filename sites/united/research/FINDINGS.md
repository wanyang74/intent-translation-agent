# United: findings

From two signed-out HAR recordings made in the user's own Chrome on 2026-11-06 (a search, and a booking up to the
payment page), a fresh-load recording made for the token question, and five console checks the user ran on
united.com the same day. Phase 0 is not done yet: the open checks are at the end.

## The recordings

- 3,117 entries in all; 162 are United's own API calls, about 25 distinct endpoints. The rest is about 100 ad,
  analytics, session-replay and payment hosts, scripts, images and fonts.
- `/1B6QHz/…` calls are United's bot-protection sensor. We never call them.
- The checkout recording holds traveler and payment calls with personal data. No endpoint in the pack reads them, so
  the fixture builder never touches them.
- Fixtures come from the search and checkout recordings only. The fresh-load recording is for the token question.

## The token

- Every API call sends `X-Authorization-api: bearer <hash>`. Without it, United answers 405 (not 401).
- `GET /api/token/anonymous` answers `{ data: { token: { hash, expiresAt } } }`: a 200-character hash that lasts one
  hour. A token from this endpoint, fetched from the page, worked for a lookup and a search (console, 2026-11-06).
- United's page keeps its own token in IndexedDB (`localforage` / `keyvaluepairs` / `reduxPersist:global`: Immutable.js
  state in Transit encoding, found by position, with an `isAuthenticated` flag), restores it on load, and calls the
  token endpoint only when it's missing or near expiry. So no recording has a token call.
- Decision (user, 2026-11-06): fetch our own token from the endpoint. The page's saved token is readable but depends on
  United's internal storage format, isn't there in the apps, and would share the user's session.

## The search

- `POST /api/flight/FetchSSENestedFlights` answers as server-sent events, about 64 per search: `meta` (with the search
  session, `cartId`), one `flightOption` per flight option, then `filters`, `columns`, `warning` and others. Each event
  names its kind in a `type` field. 566 to 694 KB; 6 to 13 seconds.
- A round trip is searched one direction at a time. The outbound list prices each fare as the whole round trip;
  `SelectAndFetchSSENestedFlights` with the chosen fare (`BBXCellId` = its `productId`) lists the returns, priced as
  the round trip with it.
- `cartId` is a search session, not a cart: the nearby-dates answer gives the same value as `SessionId`. Nothing goes
  in a cart until `RegisterFlights`, which the pack doesn't use.
- A city's all-airports choice is sent by name: `SHANGHAI (ALL AIRPORTS)`, upper case, as the airport lookup names it.
- Prices: for each fare, `Fare.amount` = the base fare (`saleFareTotalPrice`) + `Taxes`, exactly ($2,178 + $900 =
  $3,078 for UA 857 in economy). The tools show `amountAllPax`: all travelers, taxes included.
- Economy Plus (`ECONOMY-MERCH-EPLUS`) is the Economy fare plus seat add-ons (`MERCH` prices per segment), and its total
  can't be rebuilt from what's sent ($3,078 + $285 is not the $3,665 shown). The tools leave it out.
- Each listed fare has `nestedProducts`: the same cabin's other fares (Standard, Flexible next to Base), named there.
  `NestedCabinEntitlements` lists all of them with their rules (bags, changes, refunds, seats, lounges).
- Placeholders: a cabin United shows without selling it on a flight has `productSubtype: NonExistingProductPlaceHolder`
  and no price.

## Other endpoints

| Endpoint | What | In the pack |
|---|---|---|
| `GET /api/airports/lookup/` | airport and city autocomplete | `find_airport` |
| `POST /api/FlexPricer/CalendarPricing` | lowest fare per date pair, 30 days | `fare_calendar` |
| `POST /api/flight/NestedCabinEntitlements` | what each fare includes | `fare_details` |
| `POST /api/flight/FetchSessionFareWheel` | fares on nearby dates, within a search | not yet |
| `POST /api/referenceData/carbonEmission` | CO2 per passenger | not yet |
| `POST /api/flight/MapPricing` | fares to many places within a budget, from the visitor's home airport | no: uses the visitor's location |
| `GET /api/flight/recentSearch` | the visitor's recent searches | no: the visitor's own data |
| `RegisterFlights`, `ShoppingCart/*`, `SeatMap/*`, `Payment/*` | booking, travelers, seats, payment | no: writes and personal data; seat maps need a traveler in a cart |

## Phase 0: open checks (in the user's Chrome)

1. The total United's results page shows for a fare is `Fare.amount` (taxes included), for one and two travelers.
2. How long a search's fares and session stay valid (the pack assumes 30 minutes).
3. A one-way search (`SearchTypeSelection: 1`, never recorded) and its results-page link (`tqp=O`).
4. Signed in to MileagePlus: the same search through the anonymous token and in United's own page, to see which prices
   or bag rules differ; and whether the token endpoint stays anonymous then (`isAuthenticated`).
5. Whether a search without `RecentSearchKey` works, so our searches needn't show in the user's recent searches.
