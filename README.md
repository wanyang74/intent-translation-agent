# Intent Agent

An agent layer for consumer websites. A person types what they want ("a gray AWD Tesla under 42k miles that I can get
by Saturday, cheapest first"); the agent asks only the follow-ups it needs, calls the site's own frontend APIs from the
person's browser, and shows the results as cards, comparisons and buttons that take them to the right page.

The mini version is **read-only**: it does only what a person could do on the site's frontend, sends only requests
the frontend already sends, and never gets around bot protection. The one exception is United's add to cart (D6), which
the person confirms.

The full design, with every decision and its alternatives, is in [`docs/intent-agent-mini.html`](docs/intent-agent-mini.html).

## Supported sites

| Site | What the agent can do | Status |
|---|---|---|
| **Carvana** (carvana.com) | Search cars from a plain-language goal; suggest filters to narrow down; delivery dates; all-in quotes; compare cars side by side; owner reviews; a car's details and condition; take you to a search or car page | Works live in your own Chrome |
| **United Airlines** (united.com) | Find airports; search one-way and round-trip flights; fare details (bags, seats, changes); a fare calendar for cheaper dates; open a flight's details or fare options on the page; add a fare to the cart, after you confirm. Signed in: your MileagePlus balance and recent activity, only after you allow account access | Works live in your own Chrome; signed-in tools are new |
| Demo Flights | A made-up airline that runs through every platform test, so nothing in the platform can quietly assume a real site | Tests only |

## Features

- **Plain-language goals.** The model turns a goal into searches, loops over filter combinations, and filters on
  conditions the site's own filters can't express ("under $40k all in and available before the weekend").
- **Grounded answers.** Cards, tables and prices are filled from tool results by code, never typed by the model, so it
  can't put a made-up price on screen.
- **Take me there.** Buttons open the matching page on the site; the panel and the conversation carry across pages.
- **The page you're on.** The agent knows which page you're looking at ("what would *this one* cost me?").
- **Sign-in mode (United first).** Account tools use the sign-in the page already has. Nothing is read from the
  account before your yes; personal data is never kept, account data is kept in the session's memory but not in logs.
- **Memory.** A conversation survives a page load, a 30-minute pause or a brain restart (condensed, kept 24 hours).
- **A movable panel.** Move, resize and fold it; it remembers its place per site.
- **Traces and evals.** Every local session is traced for review (`npm run traces`), and answer quality is measured
  with snapshot evals against recorded site responses.

## Architecture

```
 Browser (the person's own Chrome)                                 Server
┌──────────────────────────────────────────────────┐            ┌──────────────────────────┐
│  site page  ──  content script                   │            │  Brain (one per site)    │
│                 ├─ Overlay (panel UI)            │   HTTP     │  ├─ agent loop           │
│                 ├─ page reader (page.ts)         │ ◄────────► │  ├─ prompt + skills      │
│                 └─ core.js: runs the tools,      │  messages  │  ├─ session memory       │
│                    calls the site's APIs,        │  (contract)│  └─ model adapter ──► Claude
│                    checks every model request    │            │                          │
└──────────────────────────────────────────────────┘            └──────────────────────────┘
```

- **The server runs the loop; the client runs the tools** (D1). The brain decides what to call; core.js in the page
  makes the call with the person's own session, as the site's frontend would. API keys never reach the device, and the
  brain never calls the site.
- **Platform and site packs** (D5). `platform/` knows nothing about any one site. Everything site-specific (endpoints,
  tools, schemas, rules, page readers, recorded fixtures) lives in `sites/<id>/`. Adding a site means writing a site
  pack, not changing the platform.

```
platform/
  contract/   JSON Schemas for the protocol, presentation tools, errors and the site-pack format; generated types
  core/       core.js, the client tool runtime (no Node dependencies: runs in a page, QuickJS or JavaScriptCore)
  brain/      the agentic brain: Brain → AgentSession → Turn → ModelStep → CallRecord
  web/        the overlay, the Chrome extension build, a headless Chrome driver
  testkit/    fakes for every dependency: FakeHost, FakeModel, FakeBrain, FakeClient, FakeSurface
  evals/      snapshot evals and real-session trace tools
sites/<id>/   site.yaml, schemas, tools.ts, page.ts, fixtures, example conversations, eval cases, research
docs/         the design doc
```

### Principles

1. **The platform never names a site.** A test fails if it does, and the made-up site pack runs through every test.
2. **The contract is the source of truth.** Types and validators are generated from the JSON Schemas
   (`npm run generate`), never written by hand.
3. **Presentation tools take IDs, not content.** Only IDs a tool returned in this session are accepted.
4. **Client checks guard against the model; servers guard money and state** (D3).
5. **Errors are data.** Tools return error codes with a reason and a message the model can act on.
6. **Respect the site.** Human pace (about one call a second), fresh tracking IDs, no getting around Cloudflare or other
   bot protection (D4). Raw recordings never enter git; fixtures are scrubbed.
7. **Privacy by level.** Each signed-in tool marks its account, personal and card-only fields; the platform decides
   what reaches the model, the memory and the traces (D7).
8. **Every dependency has a fake**, so every module is tested alone and deterministically; answer quality is judged
   only by evals with the real model.

## Try it on your laptop

You need macOS, Linux or Windows with **Node.js 24 or newer** (`node --version`), **Google Chrome**, and an
**Anthropic API key**.

1. **Get the code and install.**
   ```sh
   git clone <this repository> intent-agent
   cd intent-agent
   npm install
   ```

2. **Check that everything builds and passes.** No API key needed; nothing calls a real site or model.
   ```sh
   npm run typecheck
   npm test
   ```
   Tests that drive headless Chrome are skipped if Chrome isn't installed.

3. **Add your API key.** Create `.env.local` in the repo root (it's git-ignored):
   ```sh
   echo 'ANTHROPIC_API_KEY=sk-ant-...' > .env.local
   ```

4. **Build the extension and start the brain for one site.** Pick `carvana` or `united`:
   ```sh
   npm run carvana     # or: npm run united
   ```
   This builds the extension into `dist/extension/<site>/` and starts the brain. Leave it running; it prints a
   line starting `brain on http://localhost:8787 for <site>`. One brain serves one site: to switch sites, stop it (Ctrl-C) and run
   the other command.

5. **Load the extension in Chrome.** Open `chrome://extensions`, turn on **Developer mode** (top right), click **Load
   unpacked**, and pick `dist/extension/<site>`. After a rebuild, click the extension's reload arrow.

6. **Open the site and ask.** Go to carvana.com or united.com and click **Ask Carvana** / **Ask United Airlines** at the
   bottom right. Things to try:
   - Carvana: "A gray AWD Tesla with a black interior, under 42,100 miles, that I can get by Saturday. Cheapest first."
   - Carvana, on a car's page: "What would this one cost me all in, and how soon can I get it?"
   - United: "Cheapest nonstop from SFO to Seattle next Friday, back Sunday."
   - United, signed in: "How many miles do I have?" (the agent asks for your OK first)

7. **Look at what happened** (optional).
   ```sh
   npm run traces                           # every local session, one line per turn
   npm run traces -- show <session id>      # one session turn by turn; add --turn 3 for every event of a turn
   ```

**If something goes wrong**
- No "Ask …" button: check the extension is on in `chrome://extensions`, then reload the site's page.
- "Couldn't reach the agent": the brain isn't running; check its terminal.
- Logs: the page's DevTools console shows `[intent-agent]` lines with each site call and its status; the brain logs each
  turn in its terminal.
- A site's "are you human" check: answer it yourself. The agent never does. Headless Chrome is often stopped by it, so
  use your normal Chrome window.

### Other useful commands

| Command | What it does |
|---|---|
| `npm run gallery` | Builds `dist/gallery/`: every UI state of the panel, one page per site, to open in a browser |
| `npm run evals -- --quick` | Answer-quality evals with the real model. **Costs money**; run only when you mean to |
| `npm run test:live` | The example conversations with the real model (needs the API key) |
| `npm run test:screenshots` | Screenshot comparisons of the panel in headless Chrome |
| `npm run generate` | Regenerates types and validators after a schema or `site.yaml` change |
| `npm run fixtures` | Rebuilds a site's fixtures from its recordings (`recordings/*.har`, not in git) |

Brain settings, in the environment or `.env.local`: `BRAIN_MODEL` (default `claude-sonnet-5-5`), `PORT` (8787),
`BRAIN_TRACE_DIR` (`off` to stop tracing), `BRAIN_TRACE_DAYS` (30), `BRAIN_MEMORY_HOURS` (24, or `off`).

## TODO

**Site-specific features**
- **United, signed in:** a past-trips and receipt tool (needs a signed-in recording), richer activity lines (qualifying
  points, award markers) and paging back through older activity.
- **Carvana:** more pages (financing, selling or trading a car, help articles) and sold or pending car pages.
- **More sites:** a brokerage next.

**General functionality**
- **Script sandbox in the extension:** QuickJS in an offscreen document, so the model can batch tool calls there too.
- **Answers from outside the site** (for example, a Tesla's HW3 or HW4), with the person's consent and labeled as such.

**Privacy and safety**
- **Traces:** hide later answers once a session has read account data (they can repeat it today).

**Supported devices**
- **iOS, then Android:** the same core.js in JavaScriptCore and QuickJS behind a native panel.

**Testing and evaluation**
- **Raw site responses beside traces**, so a real session can be replayed as fixtures.
- **CI:** run the eval gate in a workflow (needs the API key as a repository secret).

**Operations**
- Off switches, a monitor for site API changes, and gradual rollout.
