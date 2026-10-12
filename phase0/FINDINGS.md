# Phase 0 findings

Run on 2026-10-11. Gate: **passed**. Every assumption held, and seven findings change the design (listed at the end).

## Live checks on carvana.com

Run from inside a carvana.com page in Claude's built-in browser, as the Stage B spike. About 40 requests in total over about 10 minutes, never faster than one call per second. Higher rates were deliberately not probed.

| Endpoint | Works from the page | What it needs | Latency |
|---|---|---|---|
| search | Yes | Minimal body; no analytics fields or visitor ID needed | 0.65 s |
| facets | Yes | Minimal body | 0.38 s |
| suggest | Yes | `browserCookieId` plus `analyticsData.clientId` (`srp_ui`); fails with "Invalid Request" without them | 0.27 s |
| availability (bulk) | Yes | One call covered all 21 cars on a results page | 0.13 s |
| quote | Yes | `analyticsData.clientId` (`vdp_ui`); fails with "ClientId cannot be null" without it | 0.41 s |
| GAP waiver | Yes | `amountFinanced` = price + estimated taxes and fees, as the frontend computes it | 0.28 s |
| reviews | Yes | Minimal body | 0.33 s |
| vehicle page (`/vehicle/{id}`) | Yes | Plain same-origin GET of the HTML | 0.24 s, 164 KB |

Other live results:
- **Steady rate:** 20 calls at about one per second (search pages 2–11, each followed by one bulk availability call) all returned 200. Median 0.51 s, max 0.78 s, 230 cars with delivery dates in 28 s. No blocks or challenges.
- **Deep links:** a `cvnaid` built from our own filters opened the matching results page (540 AWD Model Y cars).
- **Zip code:** the browser's default location was 94087, not 94402. The zip must be passed explicitly.
- **Financing display:** Carvana's own results page shows "$640/mo estimated · $0 cash down" next to each car. That's useful input for the counsel review; the mini version still hides these figures.

## routeId

A routeId is gzip-compressed, base64-encoded JSON with no timestamp, for example:

```json
{"geo":209644,"loc":335,"act":2,"vdt":2,"prc":{"cli":301,"pym":1},"drm":36,"ver":2,"cst":"CA","czp":"94402"}
```

It encodes the zip code, the servicing location and the distance. A routeId recorded on 2026-10-08 still returned exactly the same quote three days later ($35,590 + $3,837), and a fresh routeId for a different car at the same location decoded to the same value.

## Vehicle detail page

The page is server-rendered with Next.js. Apart from analytics it calls only two small APIs (delivery zones and distance). The car's details are in the framework data embedded in the HTML (about 100–110 KB): VIN, feature categories, imperfections with descriptions and photos, options, packages and highlights. Fetching `/vehicle/{id}` from the page and parsing the embedded data worked for a second car (VIN, 16 features, highlights and packages found).

The data can be read from the page's DOM, which also works from an extension's isolated world where page JavaScript variables aren't visible.

## Local toys (`npm test`, `npm run engines`)

| Check | Result |
|---|---|
| Split loop (`split-loop.test.mjs`) | 6/6 pass: happy path, tool calls sent before the model finishes its step (first call started about 300 ms earlier), step budget, results for unknown call IDs refused, timeout when the client never answers, unknown vehicle ID returned as an actionable error |
| Sandbox (`sandbox.test.mjs`, QuickJS in WebAssembly) | 6/6 pass: only registered tools callable; no fetch, XMLHttpRequest, require, process, timers or WebSocket; a script can't add IDs; unknown IDs refused by the host; an endless loop stopped at the 300 ms deadline; memory capped |
| Engines (`engine/run-engines.mjs`) | The same file gives identical results in Node (a fresh context with no Node globals), QuickJS and JavaScriptCore, including the deep link checked live |

A bug in the toy itself was caught here: QuickJS only runs promise callbacks when the host asks, so scripts that finished without calling a tool hung until the runner called `executePendingJobs()`. The real sandbox runner needs the same step.

## Toolchain on this Mac

Node 24.18, npm 11.16, Swift 6.3 (command-line tools only), and macOS's command-line JavaScriptCore (`jsc`). Full Xcode isn't installed: JavaScriptCore engine tests work now, but the iOS Simulator (phase 8) will need Xcode.

## Findings that change the design

1. **Some endpoints need the frontend's analytics fields.** Quote needs `analyticsData.clientId`; suggest needs `browserCookieId` and `analyticsData.clientId`. Send only the fields an endpoint requires, with fresh random IDs per session. Never reuse a visitor ID recorded from a real user.
2. **routeIds don't expire.** They encode zip code and servicing location. Replace the "route expired" error with "route missing or for a different zip". Still accept only server-issued routeIds and never build one, even though the format is readable.
3. **Search results carry the quote's price and estimated taxes and fees.** The numbers matched exactly for the same car. The estimated total comes from search, and quote calls are only needed for the quote card and the GAP waiver.
4. **Exhaustive searches can hit the 60-call budget.** 694 matching cars is 29 pages, so pages plus availability is about 58 calls. Filter on search fields first and fetch availability only for candidates, or ask the user to narrow the search.
5. **New tool: `vehicle_details`.** It reads the vehicle page's embedded data (VIN, features, imperfections, packages, highlights). The format is the framework's internal one, so it gets contract validation and the change monitor from day one.
6. **Zip code must be explicit.** Use the page context's zip or ask the user; don't rely on the browser's location.
7. **iOS phase needs full Xcode installed;** JavaScriptCore checks can start now with `jsc`.

## How to rerun

```bash
npm install
npm test
npm run engines
```
