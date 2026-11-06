# carvana: API addresses in the frontend code

Collected 2026-11-05 from 2 pages and 31 scripts by `npm run scan-api`. A map for reading, not part of the site pack: nothing here is called or trusted.

- **in pack**: the site pack already has this endpoint. **live**: the browser called it (while a scanned page loaded, or in the recording); the others are only written in the code.
- **methods**: written near the address in the code, so a guess. **flags**: words in the address suggesting it changes something or needs an account; check before any use.
- Not here: calls the site's servers make while building a page (their results come inside the HTML), addresses built from pieces at run time, and request or response shapes. `endpoints.json` has two short stretches of code around each address, for parameter names.

## Pages scanned

- www.carvana.com.har (recording, 2026-10-08): 8 scripts, 57 calls
- carvana-10-19.har (recording, 2026-10-20): 56 scripts, 80 calls

Not read: 286 more scripts the site's bundler can load later (for flows not opened, such as financing or selling a car). Their addresses aren't here.

## apik.carvana.io (29)

| address | methods | query | in pack | live | flags | files |
|---|---|---|---|---|---|---|
| `/core/address/api/v1/address/validate-zip5/{e}` |  |  |  |  |  | 2 |
| `/core/consent-api/api/v1/consent/users/{value}` |  |  |  |  | user | 2 |
| `/core/contacts/api/v1/details/addresses/validate-zip5/{e}` |  |  |  |  |  | 2 |
| `/core/contacts/api/v2/details/email/verify` |  |  |  |  |  | 2 |
| `/core/headerapi/api/v2/header` | GET | keys, partnerUrlName |  | yes |  | 0 |
| `/core/headerapi/api/v3/trade` |  |  |  |  |  | 2 |
| `/core/leadcapture` | GET |  |  |  |  | 1 |
| `/core/user-orchestrator/api/v1/account/post-creation-phone-capture` |  |  |  |  | account, user | 2 |
| `/core/user-profile-api/api/graph` |  |  |  |  | profile, user | 2 |
| `/core/userorchestrator` |  |  |  |  | user | 1 |
| `/merch/buffering/api/v1/soonestavailabilitybulk` | POST |  | availability | yes |  | 0 |
| `/merch/carvanamerchcontextapi/api/v2/delivery/location` | GET | zip5 |  | yes |  | 0 |
| `/merch/carvanamerchcontextapi/api/v3/distance` | GET | zip5 |  | yes |  | 0 |
| `/merch/reviews/api/review/sv` | POST |  | reviews | yes |  | 0 |
| `/merch/search/api/v1/Delivery` | GET | Zip5 |  | yes |  | 0 |
| `/merch/search/api/v1/recommendations/personalized-recs` | POST |  |  | yes |  | 0 |
| `/merch/search/api/v1/suggest/filters` | POST |  | suggest | yes |  | 0 |
| `/merch/search/api/v2/pricing` | POST |  |  | yes |  | 0 |
| `/merch/search/api/v2/pricing/vehicle` | POST |  | pricing | yes |  | 0 |
| `/merch/search/api/v2/search` | POST |  | search | yes |  | 0 |
| `/merch/search/api/v2/search/facets` | POST |  | facets | yes |  | 0 |
| `/merch/search/api/v2/search/should` | POST |  |  | yes |  | 0 |
| `/merch/search/api/v4/suggest` | GET | query |  | yes |  | 0 |
| `/ngcp/chatmcpapps` |  |  |  |  |  | 2 |
| `/oec/checkoutsoftpull` |  |  |  |  | checkout | 2 |
| `/stc/offer` |  |  |  |  |  | 1 |
| `/stc/trades` | DELETE |  |  |  |  | 2 |
| `/stc/trades/api/v4/analytics` | POST |  |  |  |  | 1 |
| `/vex/gateway/api/vehicles/spinner` |  |  |  |  |  | 1 |

## apimpub.carvana.com (1)

| address | methods | query | in pack | live | flags | files |
|---|---|---|---|---|---|---|
| `/ancillary-products-api/api/v2/GapWaiver/availability` | GET | amountFinanced, homeState, institutionName, paymentType, vehicleId | gap | yes |  | 0 |

## Relative addresses (on the page’s own origin or a base URL set elsewhere) (15)

| address | methods | query | in pack | live | flags | files |
|---|---|---|---|---|---|---|
| `/api` |  |  |  |  |  | 1 |
| `/api/v1` |  |  |  |  |  | 1 |
| `/api/v1/leadcapture/profile` | GET PUT |  |  |  | profile | 1 |
| `/api/v2` |  |  |  |  |  | 1 |
| `/api/v2/buckets` | POST |  |  |  |  | 4 |
| `/api/v2/buckets/bundle` | POST |  |  |  |  | 4 |
| `/api/v3` |  |  |  |  |  | 1 |
| `/api/v3/buckets/alt-id` | POST |  |  |  |  | 3 |
| `/api/v4` |  |  |  |  |  | 1 |
| `/api/v5` |  |  |  |  |  | 1 |
| `/api/v6` |  |  |  |  |  | 1 |
| `/graphql/` | GET POST |  |  |  |  | 1 |
| `/splittest/api/v2/buckets` | POST |  |  |  |  | 1 |
| `/splittest/api/v2/buckets/bundle` | POST |  |  |  |  | 1 |
| `/v2/user-create` |  |  |  |  | create, user | 4 |

## analytics.carvana.io (3)

| address | methods | query | in pack | live | flags | files |
|---|---|---|---|---|---|---|
| `/edge/device-detection/api/v1/devicedetection` | GET |  |  | yes |  | 0 |
| `/edge/split-test/api/v2/buckets/bundle` | POST |  |  | yes |  | 0 |
| `/edge/web-eventable/api/graph` | POST | SPT Data, mega-srp-user-info, mega-srp-vehicle-data, mega-vdp, ui-rendered |  | yes |  | 6 |

## analytics.carvanatech.com (1)

| address | methods | query | in pack | live | flags | files |
|---|---|---|---|---|---|---|
| `/edge/web-eventable/api/graph` |  |  |  |  |  | 6 |

## apik.carvanatech.com (1)

| address | methods | query | in pack | live | flags | files |
|---|---|---|---|---|---|---|
| `/vex/gateway/api/vehicles/spinner` |  |  |  |  |  | 1 |

## assets.fastly.carvana.io (1)

| address | methods | query | in pack | live | flags | files |
|---|---|---|---|---|---|---|
| `/spinner/standalone/64/latest/version.txt` | GET | v |  | yes |  | 0 |

## spinnerdata.carvana.io (1)

| address | methods | query | in pack | live | flags | files |
|---|---|---|---|---|---|---|
| `/spinnerdata/{id}/spinnerData.json` | GET |  |  | yes |  | 0 |

## static.fastly.carvana.io (1)

| address | methods | query | in pack | live | flags | files |
|---|---|---|---|---|---|---|
| `/stc-appraisal-ui/modules/` |  |  |  |  |  | 1 |

## vexgateway.fastly.carvana.io (3)

| address | methods | query | in pack | live | flags | files |
|---|---|---|---|---|---|---|
| `/executions/{id}/INTERIOR_TILING/tiles/config.json` | GET |  |  | yes |  | 0 |
| `/executions/{id}/THE_3D_STABILIZER/cameras.gltf` | GET | v |  | yes |  | 0 |
| `/executions/{id}/THE_3D/cameras.glb` | GET | v |  | yes |  | 0 |

## vexstockimages.fastly.carvana.io (1)

| address | methods | query | in pack | live | flags | files |
|---|---|---|---|---|---|---|
| `/stockimages` |  |  |  |  |  | 1 |

## Other hosts (31)

Hosts outside the site: analytics, ads, consent, fonts, partners and links in comments. Addresses are in endpoints.json.

- aa.agkn.com: `/adscores/g.pixel` (live)
- accounts.google.com: `/gsi/client`, `/gsi/status` (live)
- ad.doubleclick.net: `/ccm/s/collect` (live)
- analytics.google.com: `/g/collect` (live)
- analytics.zagforward.com: `/edge/web-eventable/api/graph`
- apik.zagforward.com: `/vex/gateway/api/vehicles/spinner`
- browser-intake-datadoghq.com: `/api/v2/replay` (live), `/api/v2/rum` (live)
- cdn.cookielaw.org: `/consent/{id}/{id}/en.json` (live), `/consent/{id}/019e943c-ca67-78f0-992c-28c0dfd3c06c.json` (live), `/scripttemplates/202608.1.0/assets/v2/otPcTab.json` (live), and 1 more
- chat-backend.ngcp.prod.nosidelines.io: `/api/v1/handraiser` (live)
- cvnashareableasset.blob.core.windows.net: `/shareableasset`
- cvnavexpreview.blob.core.windows.net: `/$web/featurebranch`
- descartes-external.ngcp.prod.nosidelines.io: `/vehicle-questions/` (live)
- f.fontdeck.com: `/s/css/js/`
- fast.fonts.net: `/jsapi`
- geolocation.onetrust.com: `/cookieconsentpub/v1/geo/location` (live)
- github.com: `/syntax-tree/hast-util-to-jsx-runtime`, `/zloirock/core-js`, `/zloirock/core-js/blob/v3.37.0/LICENSE`, and 2 more
- googleads.g.doubleclick.net: `/pagead/viewthroughconversion/{id}/` (live)
- json-schema.org: `/draft-04/schema#`, `/draft-07/schema#`, `/draft/2020-12/schema`
- pixels.spotify.com: `/v1/config/{id}` (live), `/v1/ingest` (live)
- react.dev: `/errors/`
- rum.browser-intake-datadoghq.com: `/api/v2/rum`
- storage.googleapis.com: `/chat-ui-ngcp-prod`, `/chat-ui-ngcp-prod/build/`
- t.getletterpress.com: `/com.snowplowanalytics.snowplow/tp2` (live)
- unpkg.com: `/detect-gpu@4.0.5/dist/benchmarks`
- www.experian.com: `/help/credit-freeze/`
- www.google.com: `/ccm/collect` (live), `/pagead/1p-conversion/{id}/` (live), `/rmkt/collect/{id}/` (live)
- www.googleadservices.com: `/pagead/conversion/{id}/` (live)
- www.gstatic.com: `/draco/versioned/decoders/1.5.7/`
- www.joinroot.com: `/fcra/`
- www.jumio.com: `/legal-information/privacy-notices/online-services-notice/`
- www.w3.org: `/{id}/Math/MathML`, `/{id}/svg`, `/{id}/xhtml`, and 2 more
