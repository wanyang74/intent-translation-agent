# Intent Translation Agent: how we build it

An agent layer for consumer websites and apps. A person states a goal; the agent asks only the follow-ups it needs,
calls the site's existing frontend APIs, and shows results as cards, comparisons, forms and confirmations. The mini
version is read-only and does only what a person could do on the site's frontend. Carvana is the first site; airlines
and brokerages come next, so nothing in the platform may assume Carvana.

The design doc is the source of truth for the plan: the artifact "Intent Agent Mini"
(https://claude.ai/artifact/WCm8a1Dj7h2nWatcV7rwLR), with a local copy at `docs/intent-agent-mini.html`. Read the
relevant section before changing a module, and keep both copies in sync when the doc changes.

## Layout

```
platform/                  never names a site; a test fails if it does
  contract/                JSON Schemas (protocol, presentation tools, errors, config, site-pack format), checks, generator
  testkit/                 fixtures, FakeHost, FakeModel, FakeBrain, FakeClient, FakeSurface, conversation checker
  core/src/                core.js, the client tool runtime, by layer: boundary, execute, link, present, runtime, shared
  brain/src/               the agentic brain (server), by layer: agent, model, prompt, server, system
  evals/                   snapshot evals: the runner (real core.js + real brain + a model), graders, gates, CLI
sites/<id>/                one site pack per site: site.yaml, schemas, fixtures, conversations, skills, tools.ts,
                           evals (cases by category, baseline.json, references/), research
docs/                      local copy of the design doc
```

## Architecture rules (hard)

- **The platform never names a site.** Everything site-specific is data or small adapters in `sites/<id>/`. A second,
  made-up site pack (`demo-flights`) runs through every platform test, so a Carvana-only assumption fails a test.
  Propose platform changes in terms of any site, with Carvana as the example.
- **The contract is the source of truth.** Types and validators are generated from the JSON Schemas
  (`npm run generate`); never edit `platform/contract/generated/` by hand.
- **The client runs the tools; the server runs the loop.** API keys never reach a device. The brain never calls the
  site (D1).
- **core.js has no Node dependencies.** It touches the outside world only through the Host interface, so one bundle
  runs in a page, QuickJS, JavaScriptCore and later the gateway. The engine tests enforce this.
- **Presentation tools take IDs, not content.** core.js fills every displayed field from tool results, so the model
  can't put a made-up price on screen. Only IDs a tool returned in this session, of the right kind and not expired,
  are accepted.
- **Client checks guard against the model; servers guard money and state** (D3). Anything that protects us or the
  enterprise runs on a server.
- **One brain per site.** Each site deploys its own brain. Several sites in one process means one Brain per site
  behind a router, never a multi-site Brain.
- Settled decisions are in the design doc's decision log (D1 to D5). Don't reverse one silently; propose it. The log
  is for decisions with a real alternative worth revisiting; obvious ones (such as one brain per site) get no entry.

## Data structures and isolation

- **Each level of state is its own class in its own file, owned where its lifetime is.** The brain's levels are
  `Brain` (one per site, always on, `agent/brain.ts`) → `AgentSession` (one per conversation, `agent/session.ts`) →
  `Turn` (one per user message, `agent/turn.ts`) → `ModelStep` (one per model call) → `CallRecord` (one per tool
  call). Don't mix levels in one file or one class: a reader should see the hierarchy from the file list.
- **Pass shared services down; don't reach up.** A parent hands its children one read-only services object
  (`BrainServices`: site, model, limits, quotas, clock, log). Children never touch a parent's private fields; when a
  child must tell the parent something, the parent gives it a narrow callback (`onUse`).
- **Data lives at the level that outlives its users.** The conversation history belongs to the session, not the
  turn; a step exists only while its model call runs, and is kept on the turn only while the client runs its tools.
- **Keep the model's history valid at every moment.** Every tool call gets a result, even when refused, replaced or
  timed out. A step is written to the history all at once, between two `yield`s, never half.
- **Keep the two ID spaces apart.** The model's call ID stays in the history; the brain's call ID (`call_1`, …) is
  the only one the client sees, and results are accepted only for IDs the brain issued.
- **Errors are data.** Tools and checks return platform error codes with a site-supplied reason and message the
  model can act on; exceptions are for real failures. User-facing messages are plain, with no internals, and kept
  together (`MESSAGES`).

## Naming

- **Descriptive names, always.** No single-letter or abbreviated names (`session`, not `s`; `event`, `message`,
  `call`, `part`, `turn` in callbacks and tests). Loop counters `i` and `j` are the only exception. Generated code is
  exempt.
- **No repeated name in a chain or across nesting levels.** No `session.site.site`, `results.results`,
  `turn.abort.abort()`, and no callback parameter that shadows the variable it fills or an outer one. Name the
  relationship instead: a site's materials are a `bundle`, the serving state is `ServedSite`, a results message is
  `resultsMessage`, a `find` callback's parameter is `candidate`, an AbortController is named for what it stops
  (`modelCall`).
- Names the user chose stay: `AgentSession`, `ModelStep`.

## Comments

- **Every file starts with a header comment**: what the file is for, where it sits among its neighbors, and the
  rules it keeps. Interfaces and non-obvious fields get one-line `/** … */` comments.
- **Functions with real logic get an outline.** The doc comment lists the steps, numbered; the body repeats the
  numbers at each step (`// 1. …`). Follow `run()`, `startTurn()`, `takeResults()` and `sendClientCall()` in
  `platform/brain/src/agent/`.
- **Explain why, and the non-obvious how.** Say why a check exists, why an order matters, and what a language
  mechanism is doing where it isn't obvious (generators and `yield`, `await` and the event loop, closures, abort
  signals). Don't narrate what the code plainly says.
- Plain English, short sentences, match the surrounding density. Technical docs and comments are in English.

## Code style

- TypeScript, strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), ES modules
  run directly by Node with `.ts` import paths. `import type` for types.
- Tests use Node's built-in runner (`node --test`), with test names that state the behavior in a sentence.
- Never type invisible characters (such as `​`) straight into a file: write them through a script with escaped
  backslashes. `platform/contract/test/no-invisible-characters.test.ts` fails on any raw invisible character.

## Testing

- Every dependency has a fake (FakeHost, FakeModel, FakeBrain, FakeClient, FakeSurface), so each module is tested
  alone and deterministically. Code paths are tested with FakeModel; answer quality only with evals.
- Every platform test runs on every site pack. Every bug becomes a test at the lowest level that could have caught it.
- Before calling work done: `npm test` and `npm run typecheck` both pass. Live tests are opt-in (`npm run test:live`).
- Integration (L5) swaps one fake at a time: `platform/brain/test/integration.test.ts` runs every example conversation
  through real core.js and the real brain (FakeHost, FakeModel), in process and over HTTP, and the link's traffic must
  equal the saved conversation. `test:live` then runs the same turns with the real model.
- Evals judge answer quality with the real model, so they cost money and run only on request: `npm run evals`
  (`--quick` for what each change runs, `--gate` for CI, `--trials`, `--case`, `--site`). Cases grade the outcome, not
  the path. A trial whose request no fixture answers is *unrecorded*: the case needs a recording, not a looser
  expectation. Never weaken a case to make a model pass; fix the case only when the case itself is wrong.
- A passing model run can be kept as a reference (`--save-references`); `npm test` replays every reference with a
  FakeModel, so a code change that breaks a known-good answer fails deterministically.

## Live sites

- Live calls to a real site go at human pace, about one per second at most. No rate probing, no getting around
  Cloudflare or other bot protection, and fresh random tracking IDs, never a real visitor's (D4).
- Raw HAR recordings stay out of git (`recordings/*.har`); fixtures are built from them with identifiers scrubbed.
  Prefer FakeHost and fixtures; go live only when a check needs it.
- The API key lives in `.env.local` (git-ignored). Never print it.

## Working with the user

- **Design changes are proposed first.** For any change to the plan or the design doc, lay out a table (change, why,
  what I'd do) and wait for approval; then apply exactly what was approved. New ideas found along the way go into a
  new table.
- **Commits only when asked.** Keep a refactor as its own diff, separate from behavior changes.
- **Design doc updates:** edit the publish source (the artifact's HTML without the doctype/head/body skeleton),
  publish it to the artifact's URL, then apply the same change to `docs/intent-agent-mini.html` and check the two
  match apart from the skeleton.
