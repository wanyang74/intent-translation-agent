# United: the signed-in recording (sign-in mode, phase 0)

One HAR recording, made by the user in their own Chrome while signed in to MileagePlus, to learn which endpoints serve
the account and how United's token behaves once signed in. Fixtures are built from it only after scrub rules for every
personal field are in the site pack; the raw file stays in `recordings/` (git-ignored) and nobody prints its values.

## What the scripts suggest (offline scan, 2026-11-15)

`npm run scan-api` over the signed-out recordings lists these account addresses in United's own scripts, none of them
seen live yet:

| Address | Likely holds |
|---|---|
| `/api/myunited/user/balances` | miles and other balances |
| `/api/myunited/account/Activities` | miles activity |
| `/api/mytrips/MyTripsByMileagePlus` | the member's trips |
| `/api/auth/refresh-token`, `/api/auth/validate-token`, `/api/auth/sso-token` | the signed-in token |

## Steps

1. **Sign in first, with DevTools closed.** The sign-in request carries the password, so it must never be in the
   recording.
2. Open DevTools → Network. Tick **Preserve log** and **Disable cache** (so the page's scripts are recorded whole).
   Clear the list.
3. Reload the united.com home page, signed in.
4. Open the MileagePlus account overview (miles balance and status).
5. Open the miles activity list.
6. Open My Trips. If a trip is listed, open its details; if there's a past trip, open one too.
7. Search a round trip (any route), then switch the results to **Book with miles**, and open one flight's fare details.
   Don't press Select.
8. Right-click the request list → **Save all as HAR (sanitized)**. Save it as
   `recordings/www.united.com.signedin.har`.
9. Close DevTools. Signing out is up to you.

Don't open: Profile, Wallet or payment methods, travel documents, or anything that edits the account. Those pages hold
the address, birth date, passport and card details, and no tool will read them.

## After the recording

- A shape-only look (`node platform/testkit/scripts/har-shapes.ts`): each United API call's address and status, and
  the names and types of its fields, never their values.
- The scrub list in `site.yaml` (`recording.scrubFields`) gets every personal field before `npm run fixtures` runs;
  the fixture builder then refuses to write anything a recorded value survives in.
- The token question (open check 4 in FINDINGS.md) is answered from the recording, and D7 records the choice.
