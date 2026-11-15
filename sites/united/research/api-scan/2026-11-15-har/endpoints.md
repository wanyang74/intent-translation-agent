# united: API addresses in the frontend code

Collected 2026-11-15 from 3 pages and 545 scripts by `npm run scan-api`. A map for reading, not part of the site pack: nothing here is called or trusted.

- **in pack**: the site pack already has this endpoint. **live**: the browser called it (while a scanned page loaded, or in the recording); the others are only written in the code.
- **methods**: written near the address in the code, so a guess. **flags**: words in the address suggesting it changes something or needs an account; check before any use.
- Not here: calls the site's servers make while building a page (their results come inside the HTML), addresses built from pieces at run time, and request or response shapes. `endpoints.json` has two short stretches of code around each address, for parameter names.

## Pages scanned

- www.united.com.searchflight.har (recording, 2026-11-07): 162 scripts, 101 calls
- www.united.com.allthewayToCheckout.har (recording, 2026-11-07): 316 scripts, 159 calls
- www.united.oneSearch.har (recording, 2026-11-07): 300 scripts, 107 calls

Not read: 7 more scripts the site's bundler can load later (for flows not opened, such as financing or selling a car). Their addresses aren't here.

## www.united.com (93)

| address | methods | query | in pack | live | flags | files |
|---|---|---|---|---|---|---|
| `/1B6QHz/HpqEr/n1ccr/Jw/{id}/AVEzIQ/VCInIlw/pLG8` | POST |  |  | yes |  | 0 |
| `/1B6QHz/HpqEr/n1ccr/Jw/Xb3bQf7i/Ckw2IQ/KjAKV0c/RJncc` | POST |  |  | yes |  | 0 |
| `/1B6QHz/HpqEr/n1ccr/Jw/Xb3bQf7i/Ckw2IQ/LD40Hg8/8NHkc` | POST |  |  | yes |  | 0 |
| `/api/airports/lookup/` | GET | airport, allAirports, matches | airports | yes |  | 1 |
| `/api/CCEProducts/GetCCEContent` | POST |  |  | yes |  | 0 |
| `/api/CheckIn/SaveTravelDocuments` |  |  |  |  | save | 1 |
| `/api/content/resources` | POST |  |  | yes |  | 0 |
| `/api/FlexPricer/CalendarPricing` | POST |  | calendar | yes |  | 0 |
| `/api/flight/FetchSessionFareWheel` | POST |  |  | yes |  | 0 |
| `/api/flight/FetchSSENestedFlights` | POST |  | flights | yes |  | 0 |
| `/api/flight/GetFareColumns` |  |  |  |  |  | 1 |
| `/api/flight/GetSpecialMealsEligibility` | POST |  |  | yes |  | 0 |
| `/api/flight/MapPricing` | POST |  |  | yes |  | 0 |
| `/api/flight/NestedCabinEntitlements` | POST |  | fare_details | yes |  | 0 |
| `/api/flight/recentSearch` | GET |  |  | yes |  | 0 |
| `/api/flight/RegisterFlights` | POST |  |  | yes | register | 0 |
| `/api/flight/SelectAndFetchSSENestedFlights` | POST |  | return_flights | yes |  | 0 |
| `/api/Flight/ValidateShopRequest` | POST |  |  | yes |  | 0 |
| `/api/home/advisories` | GET |  |  | yes |  | 0 |
| `/api/Home/get-hemi-btf-carousel` | POST |  |  | yes |  | 0 |
| `/api/Home/HeroCarouselbyCCE` | POST |  |  | yes |  | 1 |
| `/api/myunited/user/balances` |  |  |  |  | user | 1 |
| `/api/Payment/GetCreditsFromSession` | POST |  |  | yes | payment | 0 |
| `/api/payment/GetEligibleFOP` | POST |  |  | yes | payment | 0 |
| `/api/payment/GetProductEligibility` | POST |  |  | yes | payment | 0 |
| `/api/Payment/GetTermsAndConditions` | POST |  |  | yes | payment | 0 |
| `/api/Products/booking/offers` | POST |  |  | yes |  | 0 |
| `/api/Products/OfferDetail` | POST |  |  | yes |  | 0 |
| `/api/referenceData/carbonEmission` | POST |  |  | yes |  | 0 |
| `/api/referenceData/countries` | GET |  |  | yes |  | 0 |
| `/api/referenceData/loyaltyPrograms/` | GET |  |  | yes |  | 0 |
| `/api/referenceData/messages/Error/ecd` | GET |  |  | yes |  | 0 |
| `/api/referenceData/multicall` | POST |  |  | yes |  | 0 |
| `/api/referenceData/nationalityResidenceCountries` | GET |  |  | yes |  | 0 |
| `/api/referenceData/nearestAirport/{number}/{number}/4/{id}` | GET |  |  | yes |  | 0 |
| `/api/referenceData/PointOfSale` |  |  |  |  |  | 1 |
| `/api/sdl/getmodelservicepage` | GET | page |  | yes |  | 0 |
| `/api/sdl/getmodelservicepage/` | GET | encryptedusername, page |  | yes |  | 0 |
| `/api/sdl/GetPageAlerts` | POST |  |  | yes |  | 1 |
| `/api/sdl/GetSDLPage/` | GET | doRemoveNullProps, encryptedUserName, page |  | yes |  | 0 |
| `/api/sdl/GetSDLRawContent` | GET | page |  | yes |  | 0 |
| `/api/sdl/MessagesByGroup` | POST |  |  | yes |  | 0 |
| `/api/Sdl/TravelNotice` | GET |  |  | yes |  | 0 |
| `/api/SeatMap/Retrieve` | POST |  |  | yes |  | 0 |
| `/api/seatmap/v1/registerseats` | POST |  |  | yes | register | 0 |
| `/api/ShoppingCart/LoadReservationAndCart` | GET | cartId, clearBundles, clearInPathCoupon, clearSeats, isConfirmationPage, workFlowType |  | yes |  | 0 |
| `/api/ShoppingCart/RegisterTravelers` | POST |  |  | yes | register | 0 |
| `/api/User/IsEmployee` | GET |  |  | yes | user | 0 |
| `/api/User/PublicKeyNonPCI` | GET |  |  | yes | user | 0 |
| `/CMS/en-US/content/deals/offers/Pages/flights-to-China.aspx` |  |  |  |  |  | 1 |
| `/en-us/flights` |  |  |  |  |  | 1 |
| `/en-us/flights-to-beijing` |  |  |  |  |  | 1 |
| `/en-us/flights-to-chicago` |  |  |  |  |  | 1 |
| `/en-us/flights-to-denver` |  |  |  |  |  | 1 |
| `/en-us/flights-to-fort-lauderdale` |  |  |  |  |  | 1 |
| `/en-us/flights-to-houston` |  |  |  |  |  | 1 |
| `/en-us/flights-to-london` |  |  |  |  |  | 1 |
| `/en-us/flights-to-los-angeles` |  |  |  |  |  | 1 |
| `/en-us/flights-to-munich` |  |  |  |  |  | 1 |
| `/en-us/flights-to-national-parks` |  |  |  |  |  | 1 |
| `/en-us/flights-to-new-york` |  |  |  |  |  | 1 |
| `/en-us/flights-to-orlando` |  |  |  |  |  | 1 |
| `/en-us/flights-to-paris` |  |  |  |  |  | 1 |
| `/en-us/flights-to-san-francisco` |  |  |  |  |  | 1 |
| `/en-us/flights-to-tokyo` |  |  |  |  |  | 1 |
| `/en-us/flights-to-washington` |  |  |  |  |  | 1 |
| `/en-us/sitemap/city-to-city-flights/page-1` |  |  |  |  |  | 1 |
| `/en/us` | GET HEAD |  |  | yes |  | 0 |
| `/en/us/account/enroll/profile` |  |  |  |  | account, profile | 1 |
| `/en/us/bagdelivery/start/` |  |  |  |  |  | 1 |
| `/en/us/baggage-tracing` |  |  |  |  |  | 1 |
| `/en/us/baggage-tracing/` |  |  |  |  |  | 1 |
| `/en/us/baggage/bag-help` |  |  |  |  |  | 1 |
| `/en/us/bagtracker/` |  |  |  |  |  | 1 |
| `/en/us/book-flight/checkout/{id}` |  |  |  |  | checkout | 1 |
| `/en/us/book-flight/united-reservations` |  |  |  |  |  | 1 |
| `/en/us/claimform/checkstatus` |  |  |  |  |  | 1 |
| `/en/us/claimform/login` |  |  |  |  | login | 1 |
| `/en/us/destination-map` |  |  |  |  |  | 1 |
| `/en/us/fly/company/company-info/military-verification.html` |  |  |  |  |  | 1 |
| `/en/us/fly/mileageplus/mileageplus-service-center.html` |  |  |  |  |  | 1 |
| `/en/us/manageRes/tripDetails/AABBCCDDEEFF/bookingconfirmation` |  |  |  |  |  | 1 |
| `/en/us/travelreadycenter` |  |  |  |  |  | 1 |
| `/JTPoiQ/M/d/Q-VXWJQDzQ/{id}/QQcBPRwrSQ0/Qy/UtHGMHLGA` |  |  |  |  |  | 1 |
| `/JTPoiQ/M/d/Q-VXWJQDzQ/Dcp3fz9Y/Om8LPRwrSQ0/O3/{id}` |  |  |  |  |  | 1 |
| `/public/{id}` |  |  |  |  |  | 1 |
| `/public/{id}/collect` | POST | ah, bv, c, d, fsp, p, pbc, pfu, phe, pi, pl, ple, pnc, pnr, pnu, pp, ppu, psd, psl, pue, pwl, r, rh, s, sd, sm, sp, ss, st, t, tr, u, v |  | yes |  | 0 |
| `/ual/{locale}/fly/account/travelbank.html` |  |  |  |  | account | 1 |
| `/ual/{locale}/fly/travel/documentation-requirements.html` |  |  |  |  | document | 1 |
| `/ual/en/us/` |  |  |  |  |  | 1 |
| `/ual/en/us/subscription/economyplus` |  |  |  |  |  | 1 |
| `/web/en-US/apps/vendors/out.aspx` |  | i |  |  |  | 1 |
| `/web/en-US/content/mileageplus/default.aspx` |  |  |  |  |  | 1 |

## Relative addresses (on the page’s own origin or a base URL set elsewhere) (277)

| address | methods | query | in pack | live | flags | files |
|---|---|---|---|---|---|---|
| `/api` |  |  |  |  |  | 1 |
| `/api/account/` |  |  |  |  | account | 3 |
| `/api/airports/lookup` |  |  |  |  |  | 1 |
| `/api/auth/anonymous-token` | GET |  |  |  | auth, token | 2 |
| `/api/auth/refresh-token` |  |  |  |  | auth, token | 1 |
| `/api/auth/signInAfterEnroll` |  |  |  |  | signin, auth, sign | 1 |
| `/api/auth/signout` |  |  |  |  | auth, sign | 1 |
| `/api/auth/sso-token` |  |  |  |  | auth, token | 1 |
| `/api/auth/validate-token` |  |  |  |  | auth, token | 1 |
| `/api/CCEProducts/GetCCEContent` |  |  |  |  |  | 1 |
| `/api/CCEProducts/SendPersonalizationFeedback` |  |  |  |  |  | 1 |
| `/api/CCEProducts/SendTravelerStatustoUCD` |  |  |  |  |  | 1 |
| `/api/changeflight/UpdateChangeFlight` |  |  |  |  | update | 1 |
| `/api/checkin` |  |  |  |  |  | 1 |
| `/api/checkin/airportmessage` |  |  |  |  |  | 1 |
| `/api/checkin/CouponEmail` |  |  |  |  |  | 1 |
| `/api/checkin/domesticinfant` |  |  |  |  |  | 1 |
| `/api/checkin/emailboardingpass` |  |  |  |  |  | 1 |
| `/api/checkin/frequentflyerprogram` |  |  |  |  |  | 1 |
| `/api/checkin/frequentflyerprograms` |  |  |  |  |  | 1 |
| `/api/checkin/IrropValidate` |  |  |  |  |  | 1 |
| `/api/checkin/mobileboardingpassdata` |  |  |  |  |  | 1 |
| `/api/checkin/pdfboardingpass` |  |  |  |  |  | 1 |
| `/api/checkin/petInCabinAvailability` |  |  |  |  |  | 1 |
| `/api/checkin/secureflightpassengers` |  |  |  |  |  | 1 |
| `/api/checkin/setcustomers` |  |  |  |  |  | 1 |
| `/api/checkin/textboardingpass` |  |  |  |  |  | 1 |
| `/api/checkin/UnregisterSeats` |  |  |  |  |  | 1 |
| `/api/checkin/update-secure-flight-passengers` |  |  |  |  | update | 1 |
| `/api/content/query/query-by-ctx` |  |  |  |  |  | 1 |
| `/api/Content/resources` |  |  |  |  |  | 1 |
| `/api/coupons/applycoupons` |  |  |  |  | apply | 1 |
| `/api/coupons/removecoupons` |  |  |  |  | remove | 1 |
| `/api/CustomerCare` |  |  |  |  | customer | 1 |
| `/api/CustomerCare/StateCode` |  |  |  |  | customer | 1 |
| `/api/deeplink/validate` |  |  |  |  |  | 1 |
| `/api/emailutility/SendEmail/MyTripsCalendar` |  |  |  |  |  | 1 |
| `/api/Feedback/{id}` |  |  |  |  |  | 1 |
| `/api/FlexPricer/CalendarPricing` |  |  | calendar |  |  | 1 |
| `/api/flight/ApplyTravelCredits` | GET |  |  |  | apply | 1 |
| `/api/flight/FetchFareColumnEntitlement` |  |  |  |  |  | 1 |
| `/api/Flight/FetchFareRules` |  |  |  |  |  | 1 |
| `/api/flight/MapAwardPricing` |  |  |  |  |  | 1 |
| `/api/flight/MapPricing` |  |  |  |  |  | 1 |
| `/api/flight/recentSearch` |  |  |  |  |  | 1 |
| `/api/flight/RecommendedFlights` |  |  |  |  |  | 1 |
| `/api/flight/RemoveTravelCredits` | GET |  |  |  | remove | 1 |
| `/api/flight/ValidateOADisservice` |  |  |  |  |  | 1 |
| `/api/flightstatus/amenities` |  |  |  |  |  | 1 |
| `/api/flightstatus/status` |  |  |  |  |  | 1 |
| `/api/flightstatus/upgradeListExtended` |  |  |  |  |  | 1 |
| `/api/Home/get-hemi-btf-carousel` |  |  |  |  |  | 1 |
| `/api/Home/HeroCarouselbyCCE` |  |  |  |  |  | 1 |
| `/api/Home/Search` |  |  |  |  |  | 1 |
| `/api/Home/SendFeedbackCCE` |  |  |  |  |  | 1 |
| `/api/Home/SendHemiFeedbackCCE` |  |  |  |  |  | 1 |
| `/api/loggos/log/` |  |  |  |  |  | 1 |
| `/api/myTrips/EmailReceiptQueue` |  |  |  |  |  | 1 |
| `/api/mytrips/getfarerules` |  |  |  |  |  | 1 |
| `/api/myTrips/lookup` |  |  |  |  |  | 1 |
| `/api/myTrips/modifyfrequentflyerprogram` |  |  |  |  |  | 1 |
| `/api/myTrips/modifyssr/` |  |  |  |  |  | 1 |
| `/api/mytrips/MyTripsByMileagePlus` |  |  |  |  |  | 4 |
| `/api/mytrips/MyTripsByMileagePlusForSoftLoggedInUser` |  |  |  |  |  | 1 |
| `/api/mytrips/MyTripsCancelUpgradeWaitListed` |  |  |  |  |  | 1 |
| `/api/myTrips/MyTripsOffers` |  |  |  |  |  | 1 |
| `/api/mytrips/PlusPointsMyTripsByMileagePlus` |  |  |  |  |  | 1 |
| `/api/mytrips/PlusPointsMyTripsByMileagePlusForSoftLoggedInUser` |  |  |  |  |  | 1 |
| `/api/myTrips/renameTrip` |  |  |  |  |  | 1 |
| `/api/myTrips/SaveToMyAccount` |  |  |  |  | save | 1 |
| `/api/myTrips/ScheduleChange` |  |  |  |  |  | 1 |
| `/api/myTrips/SsrCapacities` |  |  |  |  |  | 1 |
| `/api/mytrips/UpdateCreditCardForAPDTax` |  |  |  |  | update | 1 |
| `/api/myunited/account/Activities` |  |  |  |  | account | 1 |
| `/api/myunited/unitedclubpass` |  |  |  |  |  | 1 |
| `/api/myunited/user/ActivityStatements` |  |  |  |  | user | 1 |
| `/api/myunited/user/balances` |  |  |  |  | user | 1 |
| `/api/myunited/user/DayOfTravelNotification` |  |  |  |  | user | 1 |
| `/api/myunited/User/FavouriteDestination` |  |  |  |  | user | 1 |
| `/api/myunited/user/FlexPqpActivitySummary` |  |  |  |  | user | 1 |
| `/api/myunited/User/get-sms-optin-status` |  |  |  |  | user | 1 |
| `/api/myunited/user/marketingCommunicationPreferences` |  |  |  |  | user | 2 |
| `/api/myunited/user/petByKey` |  |  |  |  | user | 1 |
| `/api/myunited/user/petInCabin` |  |  |  |  | user | 1 |
| `/api/myunited/user/PmdPreferences` |  |  |  |  | user | 1 |
| `/api/myunited/user/Preferences` |  |  |  |  | user | 1 |
| `/api/myunited/user/PremierBenefits` |  |  |  |  | user | 1 |
| `/api/myunited/user/saveTraveler` |  |  |  |  | save, user | 1 |
| `/api/myunited/user/serviceAnimal` |  |  |  |  | user | 1 |
| `/api/myunited/user/serviceAnimals` |  |  |  |  | user | 1 |
| `/api/myunited/user/travelerInfo` |  |  |  |  | user | 1 |
| `/api/myunited/User/UnsubscribeEmailMarketingPreferences` |  |  |  |  | user | 1 |
| `/api/Payment/AlipayUrl` |  |  |  |  | payment | 1 |
| `/api/Payment/AltPayCheckout` |  |  |  |  | payment | 1 |
| `/api/Payment/AltPayCheckoutUrl` |  |  |  |  | payment | 1 |
| `/api/Payment/ApplyETC` |  |  |  |  | apply, payment | 1 |
| `/api/Payment/ApplyMilesAndMoneyOptions` |  |  |  |  | apply, payment | 1 |
| `/api/Payment/BalanceEnquiry` |  |  |  |  | payment | 3 |
| `/api/Payment/ChaseCardInfo` |  |  |  |  | payment | 1 |
| `/api/Payment/CreateProvisionRequest` |  |  |  |  | create, payment | 1 |
| `/api/Payment/DecryptEphemeralKey` |  |  |  |  | payment | 1 |
| `/api/Payment/DecryptPazeToken` |  |  |  |  | payment | 1 |
| `/api/payment/EncryptPIIDataUsingPartnerSingleSignOn` |  |  |  |  | payment | 1 |
| `/api/Payment/FFCRLookupByPnr` |  |  |  |  | payment | 1 |
| `/api/Payment/GetApplePaySession` |  |  |  |  | payment | 1 |
| `/api/payment/GetCreditCardType` |  |  |  |  | payment | 1 |
| `/api/payment/GetCurrencyExchangeRate/USD/CAD` |  |  |  |  | payment | 1 |
| `/api/payment/GetProductEligibility` |  |  |  |  | payment | 1 |
| `/api/Payment/GetSecureCardToken` |  |  |  |  | payment | 2 |
| `/api/Payment/GetTermsAndConditions` |  |  |  |  | payment | 1 |
| `/api/Payment/InquirePayment` |  |  |  |  | payment | 1 |
| `/api/Payment/IsPartnerProvisionEnabled` |  |  |  |  | payment | 1 |
| `/api/Payment/Lookup3DS` |  |  |  |  | payment | 2 |
| `/api/Payment/MilesAndMoneyOptions` |  |  |  |  | payment | 1 |
| `/api/Payment/OnTheflyOfferEligibility` |  |  |  |  | payment | 1 |
| `/api/Payment/ProvisionDetails` |  |  |  |  | payment | 1 |
| `/api/Payment/SecureCardAuthenticate` |  |  |  |  | payment | 2 |
| `/api/Payment/TCLookupByPinOrPNR` |  | doCurrencyConversion |  |  | payment | 1 |
| `/api/Payment/UndoMilesAndMoneyOptions` |  |  |  |  | payment | 1 |
| `/api/Payment/UpdateProvisionLinkStatus` |  |  |  |  | update, payment | 1 |
| `/api/pnrlinking/Encrypt` |  |  |  |  |  | 1 |
| `/api/Products/ancillary-edge/offers` |  |  |  |  |  | 1 |
| `/api/Products/Baggage/BaggagePricing` |  |  |  |  |  | 1 |
| `/api/Products/Baggage/BaggagePricingForMyTrip` |  |  |  |  |  | 4 |
| `/api/Products/booking/offers` |  |  |  |  |  | 3 |
| `/api/Products/Hotels/suggest` |  | text |  |  |  | 1 |
| `/api/Products/OfferDetail` |  |  |  |  |  | 1 |
| `/api/Products/Offers` |  |  |  |  |  | 1 |
| `/api/ReferenceData/` |  |  |  |  |  | 1 |
| `/api/referenceData/cabinBranding` |  |  |  |  |  | 1 |
| `/api/referenceData/carriers` |  | onlyPartners |  |  |  | 1 |
| `/api/referenceData/countries` |  |  |  |  |  | 1 |
| `/api/referenceData/disserviceAirlinesLookup` |  |  |  |  |  | 1 |
| `/api/referenceData/getByCityCode` |  |  |  |  |  | 1 |
| `/api/referenceData/getCollectionImagesAllPages` |  |  |  |  |  | 1 |
| `/api/referenceData/loyaltyPrograms/` |  |  |  |  |  | 1 |
| `/api/referenceData/messages` |  |  |  |  |  | 1 |
| `/api/referenceData/MilitaryOrganizations` |  |  |  |  |  | 1 |
| `/api/referenceData/multicall` |  |  |  |  |  | 1 |
| `/api/referenceData/Multicall` |  |  |  |  |  | 1 |
| `/api/referenceData/nationalityResidenceCountries` |  |  |  |  |  | 1 |
| `/api/referenceData/nearestAirport/{lat}/{long}/4/{id}` |  |  |  |  |  | 1 |
| `/api/referenceData/PointOfSale` |  |  |  |  |  | 2 |
| `/api/referenceData/SsrCodes` |  |  |  |  |  | 1 |
| `/api/referenceData/StateFilter` |  |  |  |  |  | 1 |
| `/api/referenceData/weatherForecast` |  |  |  |  |  | 1 |
| `/api/referenceData/WheelChairAirportMessages` |  |  |  |  |  | 1 |
| `/api/Refund/OARecordsReshopEligibility` |  |  |  |  |  | 1 |
| `/api/Refund/RefundETCEligibility` |  |  |  |  |  | 1 |
| `/api/Refund/Subscriptions` |  |  |  |  |  | 1 |
| `/api/rtd/TriggerInterestedEvent/` |  |  |  |  |  | 1 |
| `/api/sdl/BaggageClaimToken` |  |  |  |  |  | 1 |
| `/api/sdl/case/submit` |  |  |  |  | submit | 1 |
| `/api/sdl/EmailEtcDetails` |  |  |  |  |  | 1 |
| `/api/sdl/EmailTravelCredits` |  |  |  |  |  | 1 |
| `/api/Sdl/EmailTravelCredits` |  |  |  |  |  | 2 |
| `/api/sdl/GetETCDetails` |  |  |  |  |  | 1 |
| `/api/sdl/GetFormUtilityDataAirports` |  |  |  |  |  | 1 |
| `/api/sdl/GetFormUtilityDataBaggageDetail` |  |  |  |  |  | 1 |
| `/api/sdl/GetFormUtilityDataCarriers` |  |  |  |  |  | 1 |
| `/api/sdl/GetFormUtilityDataFeaturedSaveRawards` |  |  |  |  |  | 1 |
| `/api/sdl/GetFormUtilityDataItineraryDetail` |  |  |  |  |  | 1 |
| `/api/sdl/GetFormUtilityDataPrograms` |  |  |  |  |  | 1 |
| `/api/sdl/getmodelservicepage` | GET | page |  |  |  | 5 |
| `/api/sdl/getmodelservicepage/` |  | page |  |  |  | 1 |
| `/api/sdl/GetModelServicePage/` |  |  |  |  |  | 1 |
| `/api/sdl/GetSDLPage/` |  |  |  |  |  | 1 |
| `/api/sdl/GetSDLRawContent` |  |  |  |  |  | 1 |
| `/api/sdl/GetSDLTIRefinedPage/` |  |  |  |  |  | 1 |
| `/api/sdl/getTargetedContent` |  |  |  |  |  | 1 |
| `/api/sdl/GetXmlData` |  |  |  |  |  | 1 |
| `/api/sdl/NewsRoomAnnouncements` |  |  |  |  |  | 1 |
| `/api/sdl/NewsRoomMedia` |  |  |  |  |  | 1 |
| `/api/sdl/ProcessFormSubmission` |  |  |  |  |  | 1 |
| `/api/sdl/ProcessTCDFormsubmission` |  |  |  |  |  | 1 |
| `/api/Sdl/TravelCredits` |  |  |  |  |  | 1 |
| `/api/Sdl/TravelNotice` |  |  |  |  |  | 1 |
| `/api/sdl/unitedinstagrammedia` |  |  |  |  |  | 1 |
| `/api/seatmap/v1/registerseats` |  |  |  |  | register | 1 |
| `/api/SendEmail/SendTemplateEmail` |  |  |  |  |  | 1 |
| `/api/ServiceAnimal/Create` |  |  |  |  | create | 2 |
| `/api/ServiceAnimal/Delete` |  |  |  |  | delete | 1 |
| `/api/ServiceAnimal/Update` |  |  |  |  | update | 1 |
| `/api/ShareItinerary/ShareItinerary` |  |  |  |  |  | 1 |
| `/api/ShoppingCart/ApplyMilesAndMoneyOptions` |  |  |  |  | apply | 1 |
| `/api/ShoppingCart/ApplyTravelCredits` |  |  |  |  | apply | 1 |
| `/api/ShoppingCart/GetPersistentSession` |  |  |  |  |  | 1 |
| `/api/ShoppingCart/LoadReservationAndCart` |  |  |  |  |  | 4 |
| `/api/ShoppingCart/ModifyUpgrades` |  |  |  |  |  | 1 |
| `/api/ShoppingCart/RegisterLoyaltyCertificate` |  |  |  |  | register | 1 |
| `/api/ShoppingCart/RegisterOffers` |  |  |  |  | register | 5 |
| `/api/ShoppingCart/RegisterReservation` |  |  |  |  | register | 1 |
| `/api/ShoppingCart/RegisterSpecialServices` |  |  |  |  | register | 1 |
| `/api/ShoppingCart/RegisterTravelers` |  |  |  |  | register | 2 |
| `/api/ShoppingCart/RegisterUMNRInfo` |  |  |  |  | register | 1 |
| `/api/ShoppingCart/UpdateTravellers` |  |  |  |  | update | 1 |
| `/api/Subscription/ActivateGift` |  |  |  |  |  | 1 |
| `/api/subscription/UpdateAutoRenewSubscription` |  |  |  |  | update | 1 |
| `/api/Subscription/ValidateGiftCode` |  |  |  |  |  | 1 |
| `/api/test` |  |  |  |  |  | 1 |
| `/api/token/anonymous` |  |  | token |  | token | 1 |
| `/api/TravelCenter` |  |  |  |  |  | 1 |
| `/api/Upgrade/Eligibility` | GET |  |  |  |  | 1 |
| `/api/user/accountNumberTokenOAEP` |  |  |  |  | account, user | 2 |
| `/api/user/accountStatus` |  |  |  |  | account, user | 2 |
| `/api/user/address` |  |  |  |  | user | 1 |
| `/api/user/addresses` |  |  |  |  | user | 1 |
| `/api/user/chasecardbenefitsdetails` |  |  |  |  | user | 1 |
| `/api/user/CheckDuplicateEmail` |  |  |  |  | user | 1 |
| `/api/user/checkDuplicatePhone` |  |  |  |  | user | 1 |
| `/api/user/clearsavedtrip` |  |  |  |  | user | 1 |
| `/api/User/ComplexIdentityChanges` |  |  |  |  | user | 1 |
| `/api/user/confirmVerificationLink` |  |  |  |  | user | 1 |
| `/api/user/confirmVerifyEmailLink` |  |  |  |  | user | 1 |
| `/api/user/creditCard` |  |  |  |  | user | 1 |
| `/api/user/creditCards` |  |  |  |  | user | 1 |
| `/api/user/creditCardsByAddressKey` |  |  |  |  | user | 1 |
| `/api/user/creditCardsByCreditCardKey` |  |  |  |  | user | 1 |
| `/api/User/diningEnrollCard` |  |  |  |  | user | 1 |
| `/api/user/duplicateCheck` |  |  |  |  | user | 1 |
| `/api/User/ElectronicTravelCertificates` |  |  |  |  | user | 1 |
| `/api/user/emailAddress` |  |  |  |  | user | 1 |
| `/api/user/emailAddresses` |  |  |  |  | user | 1 |
| `/api/user/forgotMileagePlus` |  |  |  |  | user | 1 |
| `/api/User/FutureFlightCredits` |  |  |  |  | user | 1 |
| `/api/user/GetAllSecurityQuestions` |  |  |  |  | user | 1 |
| `/api/user/GetEmployeeTravelers` |  |  |  |  | user | 1 |
| `/api/User/IdentityChangeRequiresProof` |  |  |  |  | user | 2 |
| `/api/user/LivePersonChat` |  | client_id, grant_type |  |  | user | 1 |
| `/api/user/pet` |  |  |  |  | user | 1 |
| `/api/user/phoneNumber` |  |  |  |  | user | 1 |
| `/api/user/phoneNumbers` |  |  |  |  | user | 1 |
| `/api/User/PublicKeyNonPCI` |  |  |  |  | user | 1 |
| `/api/user/savedtrip` |  |  |  |  | save, user | 1 |
| `/api/user/savedtripurl` |  |  |  |  | save, user | 1 |
| `/api/user/SendVerifyEmailLink` |  |  |  |  | user | 1 |
| `/api/user/sendVerifyPhoneLink` |  |  |  |  | user | 1 |
| `/api/user/tcdalertbympnumbers` |  |  |  |  | user | 1 |
| `/api/user/trips` |  |  |  |  | user | 4 |
| `/api/user/trips/checkin` |  |  |  |  | user | 1 |
| `/api/user/validateAddress` |  |  |  |  | user | 1 |
| `/api/user/ValidateMileagePlusNames` |  |  |  |  | user | 1 |
| `/api/user/ValidateRewardPrograms` |  |  |  |  | user | 1 |
| `/api/v1/logging/logEvent` |  |  |  |  |  | 1 |
| `/api/v2/pixel` |  |  |  |  |  | 1 |
| `/core/v1/utils/geo/location` |  |  |  |  |  | 1 |
| `/lptag/api/account/` |  |  |  |  | account | 1 |
| `/maps/api/js` |  |  |  |  |  | 1 |
| `/maps/api/js/ApplicationService.GetEntityDetails` |  |  |  |  |  | 1 |
| `/maps/api/js/AuthenticationService.Authenticate` |  |  |  |  | auth | 1 |
| `/maps/api/js/QuotaService.RecordEvent` |  |  |  |  |  | 1 |
| `/maps/api/js/StaticMapService.GetMapImage` | GET |  |  |  |  | 1 |
| `/maps/api/mapsjs/gen_204` |  | csp_test |  |  |  | 1 |
| `/privaci/v1/consent/` |  |  |  |  |  | 1 |
| `/privaci/v1/consent/cookie/status` |  |  |  |  |  | 1 |
| `/service/acCdnDomain/baseURI.json` |  | version |  |  |  | 1 |
| `/v1/` |  |  |  |  |  | 1 |
| `/v1/{value}` | GET POST |  |  |  |  | 1 |
| `/v1/child-ready` | GET POST |  |  |  |  | 1 |
| `/v1/connect` | GET |  |  |  |  | 1 |
| `/v1/enable-replay` | POST |  |  |  |  | 1 |
| `/v1/enable-session` | POST |  |  |  |  | 1 |
| `/v1/frame-id` | GET POST |  |  |  |  | 1 |
| `/v1/new-page` | DELETE GET POST |  |  |  |  | 1 |
| `/v1/new-session` | POST |  |  |  |  | 1 |
| `/v1/page-freeze` | POST |  |  |  |  | 1 |
| `/v1/reset` | POST |  |  |  |  | 1 |
| `/v1/scores/engagement` |  |  |  |  |  | 1 |
| `/v1/set-child-frame-id` | POST |  |  |  |  | 1 |
| `/v1/set-context` | DELETE GET POST |  |  |  |  | 1 |
| `/v1/set-parent-id` | GET POST |  |  |  |  | 1 |
| `/v1/snapshot` | GET |  |  |  |  | 1 |
| `/v1/stop` | GET POST |  |  |  |  | 1 |
| `/v1/voc/destroy` | POST |  |  |  |  | 1 |
| `/v1/voc/dismiss` | POST |  |  |  |  | 1 |
| `/v1/voc/hide` | POST |  |  |  |  | 1 |
| `/v1/voc/show` | POST |  |  |  |  | 1 |

## business.united.com (1)

| address | methods | query | in pack | live | flags | files |
|---|---|---|---|---|---|---|
| `/en/us/index` |  |  |  |  |  | 1 |

## flights.united.com (1)

| address | methods | query | in pack | live | flags | files |
|---|---|---|---|---|---|---|
| `/en-us/` |  |  |  |  |  | 1 |

## jetstream.united.com (1)

| address | methods | query | in pack | live | flags | files |
|---|---|---|---|---|---|---|
| `/#/public-landing` |  |  |  |  |  | 1 |

## media.united.com (1)

| address | methods | query | in pack | live | flags | files |
|---|---|---|---|---|---|---|
| `/images/Media%20Database/SDL/travel-inspiration/` |  |  |  |  |  | 1 |

## mileageplustravel.united.com (1)

| address | methods | query | in pack | live | flags | files |
|---|---|---|---|---|---|---|
| `/explore/car-rentals` |  | refp, utm_campaign, utm_medium, utm_source |  |  |  | 1 |

## mpenroll.united.com (1)

| address | methods | query | in pack | live | flags | files |
|---|---|---|---|---|---|---|
| `/enroll/liteenroll` |  |  |  |  |  | 1 |

## packages.united.com (2)

| address | methods | query | in pack | live | flags | files |
|---|---|---|---|---|---|---|
| `/svcs/ac/index` | GET |  |  |  |  | 2 |
| `/vacationpackages/` |  | refclickid, refid, utm_campaign, utm_content, utm_medium, utm_source |  |  |  | 1 |

## united-app.quantummetric.com (1)

| address | methods | query | in pack | live | flags | files |
|---|---|---|---|---|---|---|
| `/q3` |  |  |  |  |  | 1 |

## united.business (3)

| address | methods | query | in pack | live | flags | files |
|---|---|---|---|---|---|---|
| `/meetings-group` |  |  |  |  |  | 1 |
| `/perksplus` |  |  |  |  |  | 1 |
| `/uatp` |  |  |  |  |  | 1 |

## united.chase-stage3.archer-group.com (1)

| address | methods | query | in pack | live | flags | files |
|---|---|---|---|---|---|---|
| `/rewards-cards/explorer-card` |  | CELL |  |  |  | 1 |

## us.hotels.united.com (3)

| address | methods | query | in pack | live | flags | files |
|---|---|---|---|---|---|---|
| `/{id}` |  |  |  |  |  | 1 |
| `/cl/2x2.json` |  |  |  |  |  | 1 |
| `/lp/b/coupon-code` |  |  |  |  |  | 1 |

## www.unitedexplorercard.com (1)

| address | methods | query | in pack | live | flags | files |
|---|---|---|---|---|---|---|
| `/{id}` |  | asset_position, asset_type, int_campaign, int_content, int_medium, int_source, launch_date, mode, partner_category, partner_name, promo_code, targeting |  |  |  | 1 |

## Other hosts (165)

Hosts outside the site: analytics, ads, consent, fonts, partners and links in comments. Addresses are in endpoints.json.

- 20831572p.rfihub.com: `/ca.html`
- 35.160.46.251: `/is` (live)
- 35.85.84.151: `/is` (live)
- 44.228.85.26: `/is` (live)
- 52.22.50.55: `/is` (live)
- 52.71.121.170: `/is` (live)
- a9972578858.cdn.optimizely.com: `/client_storage/a9972578858.html`
- aax.amazon-adsystem.com: `/e/dtb/bid`
- account.ext.live.venmo.com: `/go/web`
- account.venmo.com: `/go/web`
- ad.360yield.com: `/match`
- ad.doubleclick.net: `/activity;{params}` (live), `/ccm/s/collect` (live), `/ddm/activity/src=13875981;{params}`, and 2 more
- ads.tiktok.com: `/help/article/custom-events`, `/help/article/standard-events-parameters`, `/marketing_api/docs`
- adservice.google.com: `/pagead/regclk`
- alb.reddit.com: `/rp` (live)
- ams.creativecdn.com: `/tags/v2` (live)
- analytics-ipv6.tiktokw.us: `/ipv6/enrich_ipv6` (live)
- analytics.google.com: `/g/collect` (live)
- analytics.tiktok.com: `/api/v2`, `/api/v2/monitor` (live), `/api/v2/pixel` (live), and 5 more
- analytics.twitter.com: `/i/adsct`
- api.liveperson.net: `/api/account/`
- app.securiti.ai: `/core/v1/utils/geo/location` (live), `/privaci/v1/consent/cookie/singleupload` (live)
- apps.apple.com: `/us/app/united-airlines/id449945214`
- bf80269wzu.bf.dynatrace.com: `/bf` (live)
- bid.g.doubleclick.net: `/xbbe/pixel`
- buymiles.mileageplus.com: `/united/united_landing_page/`
- c.amazon-adsystem.com: `/cdn/prod/config`
- c.aps.amazon-adsystem.com: `/e/placements`
- c.go-mpulse.net: `/api/config.json` (live)
- cbks0.googleapis.com: `/cbk`
- cbks1.googleapis.com: `/cbk`
- cdn-prod.securiti.ai: `/consent/cookie_banner/{id}/{id}/config_active.json` (live), `/consent/cookie_banner/{id}/{id}/en.json` (live)
- cdn.lpsnmedia.net: `/api/account/{id}/configuration/engagement-window/window-confs/{id}` (live), `/api/account/{id}/configuration/le-campaigns/campaigns/{id}/engagements/{id}/revision/{id}` (live), `/api/account/{id}/configuration/le-campaigns/zones` (live), and 1 more
- cdn.optimizely.com: `/datafiles/%s.json`, `/public/{id}/data`
- cdn.uplift.com: `/client/modal/v2/latest/index.html`, `/client/pos/v2/latest/index.html`
- checkout.paze.com: `/api/v1/logging/logEvent` (live), `/web/communicator`, `/web/ghost-layer` (live)
- client.cardinaltrusted.com: `/centinelapi/V2/Cruise/Collect`
- connect.facebook.net: `/log/fbevents_telemetry/`
- consultas-publicas.anac.gob.ar: `/formularios-dnta`
- contextual.media.net: `/cksync.php`
- credapi.credify.tech: `/api/bnplapplication`
- credapi.upgrade.com: `/api/bnplapplication`, `/api/marketing-offer`, `/api/marketing-offer/v1/marketing/from` (live)
- criteo-sync.teads.tv: `/um`
- ct.pinterest.com: `/stats/` (live), `/user/` (live), `/v3/` (live)
- d.agkn.com: `/pixel/{id}/`
- d9.flashtalking.com: `/lgc` (live)
- develrc-app.optimizely.com: `/dist/visual-editor/pull-request/`
- di.rlcdn.com: `/api/segment` (live)
- dpm.demdex.net: `/ibs`
- dv-c3e594c6d429469e90b54478358619c3.ecs.us-east-1.on.aws: `/events` (live)
- e-mtag.mountain.com: `/m`
- eb2.3lift.com: `/xuid`
- ep1.adtrafficquality.google: `/getconfig/sodar` (live)
- ep2.adtrafficquality.google: `/sodar/`
- events.api.boomtrain.com: `/event/track` (live)
- flo.io: `/DVSK`, `/DXDD`, `/JZYQ`
- fonts.googleapis.com: `/css`
- fundingchoicesmessages.google.com: `/i/{a}`
- g.co: `/dev/maps-no-account`
- geo0.ggpht.com: `/cbk`
- geo1.ggpht.com: `/cbk`
- geo2.ggpht.com: `/cbk`
- geo3.ggpht.com: `/cbk`
- github.com: `/zloirock/core-js`, `/zloirock/core-js/blob/v3.32.2/LICENSE`, `/zloirock/core-js/blob/v3.43.0/LICENSE`, and 1 more
- googleads.g.doubleclick.net: `/pagead/html/{c}/{d}/zrt_lookup{b}.html`, `/pagead/managed/dict/{a}/adsbygoogle`
- googleads6.g.doubleclick.net: `/map/v6`
- gum.criteo.com: `/sync`, `/syncframe`
- h.online-metrix.net: `/{id}`, `/fp/check.js;{params}`
- icl.visa.com: `/vba/api/js/async/token`
- ingest.quantummetric.com: `/horizon/d` (live), `/horizon/united` (live), `/resource-loader/united`, and 1 more
- insight.adsrvr.org: `/track/pxl/`
- jadserve.postrelease.com: `/suid/{id}`
- json-schema.org: `/draft-07/schema#`
- khms.googleapis.com: `/mz`
- khms0.google.com: `/kh`
- khms0.googleapis.com: `/kh`
- khms1.google.com: `/kh`
- khms1.googleapis.com: `/kh`
- lh3.ggpht.com: `/jsapi2/a/b/c/`
- lh4.ggpht.com: `/jsapi2/a/b/c/`
- lh5.ggpht.com: `/jsapi2/a/b/c/`
- lh6.ggpht.com: `/jsapi2/a/b/c/`
- live.rezync.com: `/sync`
- logx.optimizely.com: `/v1/events` (live)
- lp-gai-tgi.us-east1.prod.int.gw.lpcloud.io: `/v1/ray/cbner/api/v1.0/predictions`, `/v1/ray/encoder2/api/v1.0/predictions`, `/v1/ray/nvx/api/v1.0/predictions`, and 2 more
- lpcdn.lpsnmedia.net: `/le_secure_storage/3.33.3-release_1982870847/storage.secure.min.html`
- m1.openfpcdn.io: `/fingerprintjs/v`
- maps.googleapis.com: `/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/GetViewportInfo` (live), `/maps_api_js_slo/log`, `/maps-api-v3/api/js/66/13d`, and 6 more
- maps.gstatic.com: `/mapfiles/`, `/maps-api-v3/api/images/`
- match.adsrvr.org: `/track/cmf/generic`
- measurement-api.criteo.com: `/register-trigger`
- mm-prerendering-static-prod.airtrfx.com: `/em-assets/module-manager/ua/packages-carousel/2.50.4/index.html`
- mts.googleapis.com: `/maps/vt/icon`
- onsiterecs.api.boomtrain.com: `/api/v1/osrs`, `/api/v1/selectors` (live)
- pagead2.googlesyndication.com: `/bg/`, `/gampad/ads`, `/getconfig/abg_config`, and 10 more
- pay-api2.uplift.com: `/prequal`, `/return`
- payments.braintree-api.com: `/graphql`
- payments.sandbox.braintree-api.com: `/graphql`
- people.api.zetaglobal.net: `/identify/resolve` (live)
- pixel-config.reddit.com: `/pixels/t2_3xxwutlw/config` (live)
- pixel.quantcount.com: `/tag/error`
- pixel.quantserve.com: `/cs` (live), `/token`
- pixel.rubiconproject.com: `/tap.php`
- pixel.sitescout.com: `/up/{id}`
- pixel.sojern.com: `/pixel/img/{id}`
- pixel.tapad.com: `/idsync/ex/receive`
- play.google.com: `/log`, `/store/apps/details`
- prediction.cmab.optimizely.com: `/predict`
- prod.accdab.net: `/beacon`, `/beacon/bf/bf.html`
- prod.tahoe-analytics.publishers.advertising.a2z.com: `/logevent/postEquinoxEvent`, `/logevent/putRecord`, `/logevent/putRecords`
- px.ads.linkedin.com: `/collect`
- px.mountain.com: `/st`, `/sti`
- r.casalemedia.com: `/rum`
- r.turn.com: `/r/beacon`
- react.dev: `/errors/`
- reactjs.org: `/docs/error-decoder.html`
- rtb-csync.smartadserver.com: `/redir/`
- rules.quantcount.com: `/rules-`
- rum.optimizely.com: `/rum`
- s.qualtrics.com: `/spoke/all/jam`
- s.yimg.com: `/wi/config/10086194.json` (live)
- schema.org: `/aggregateoffer`, `/aggregaterating`, `/brand`, and 2 more
- secure.adnxs.com: `/px`
- securepubads.g.doubleclick.net: `/gampad/ads` (live), `/pagead/managed/dict/`, `/pagead/managed/js/gpt/`, and 4 more
- simage2.pubmatic.com: `/AdServer/Pug`
- siteintercept.qualtrics.com: `/dxjsmodule/`, `/WRSiteInterceptEngine/` (live), `/WRSiteInterceptEngine/Asset.php` (live), and 1 more
- sp.analytics.yahoo.com: `/collect`, `/sp.pl`, `/spp.pl`
- static.panoramio.com.storage.googleapis.com: `/photos/`
- streetviewpixels-pa.googleapis.com: `/v1/thumbnail`, `/v1/tile`
- support.apple.com: `/downloads/safari`
- support.google.com: `/admanager/answer/`
- sync-t1.taboola.com: `/sg/criteortb-network/1/rtb-h/`
- sync.1rx.io: `/usersync/criteodsp/{id}`
- sync.targeting.unrulymedia.com: `/csync/{id}`
- t.co: `/i/adsct`
- tapestry.tapad.com: `/tapestry/1`
- thm.visa.com: `/{id}`
- tpc.googlesyndication.com: `/safeframe/`, `/sodar/`
- tr.snapchat.com: `/p` (live)
- tr6.snapchat.com: `/p` (live)
- va.seldon-core-ambassador.int.liveperson.net: `/seldon/lp-encoder-mdl/api/v1.0/predictions`
- venmo.com: `/braintree/checkout`, `/go/checkout`
- viba.visa.com: `/api/js/async/token`
- web-banner.ads.aps.amazon-adsystem.com: `/e/dtb/bid` (live)
- web-video.ads.aps.amazon-adsystem.com: `/e/dtb/bid`
- webportal.edicomgroup.com: `/customers/united/pasaje/search.htm`
- www.canada.ca: `/canadian-travel-number`
- www.facebook.com: `/privacy_sandbox/topics/registration/`, `/tr`, `/tr/` (live)
- www.google-analytics.com: `/privacy-sandbox/register-conversion`
- www.google.com: `/ccm/collect` (live), `/ccm/geo`, `/chrome/`, and 26 more
- www.googletagmanager.com: `/gtag/js`
- www.instagram.com: `/tr/`
- www.linkedin.com: `/px/li_sync`
- www.microsoft.com: `/en-us/windows/microsoft-edge`
- www.mozilla.org: `/en-US/firefox/`
- www.paypal.com: `/checkoutnow/error`, `/xoplatform/logger/api/logger`
- www.redditstatic.com: `/campaign-management/`
- www.theexplorercard.com: `/consumer-cards/explorer`, `/MPExplorerSpecialOffer`, `/rewards-cards/explorer-card`
- www.tiktok.com: `/@united`
- www.upgrade.com: `/flex-pay/funnel/latest/application/`, `/flex-pay/lenders`, `/flex-pay/terms`
- www.uplift-platform.com: `/c` (live)
- www.uplift.com: `/lenders`
- www.w3.org: `/{id}/Math/MathML`, `/{id}/svg`, `/{id}/xhtml`, and 2 more
- x.bidswitch.net: `/sync`, `/ul_cb/sync`
- xmt.paze.com: `/{id}`
