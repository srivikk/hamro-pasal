# Hamro Pasal — Backend Build Sheet

Priorities: **P0** = the app has a visible gap or a money/correctness risk today. **P1** = the app works locally but data doesn't survive the device, or it over-fetches. **P2** = hardening.

## Ground rules

- [ ] Every request and response shape lives in `packages/shared-types` as a **strict** Zod schema. The app rejects unknown keys, so a new response field must land in shared-types first and ship in an app build together with the API. Run `pnpm build` after touching any package.
- [ ] Errors use the existing envelope `{ error: { code, message, details? } }`. The app branches on `code`.
- [ ] Field names are snake_case; money has the `_npr` suffix; phones are strict `+9779XXXXXXXXX`.
- [ ] Each service, transaction and state change gets a unit or integration test (project rule).
- [ ] Column changes update the Drizzle schema, the Zod entity and `packages/db/src/schema/contract.ts` together, or `tsc` fails.

## Already done — verify, don't rebuild

- [ ] `GET /api/vendors` and `GET /api/vendors/:id/products` are public (no token). The change is in the working tree (`apps/api/src/app.ts`), **uncommitted**. Commit and deploy it, or guest browsing breaks.
- [ ] Order-status push notifications are sent by the worker (see section 3).

---

## 1. Database schema updates

### P0

- [ ] **`order_addresses`: recipient columns.**
  - Add `recipient_name text NULL` (1–80 chars, non-blank) and `recipient_phone text NULL` (`^\+9779[0-9]{9}$`).
  - CHECK: both null or both set.
- [ ] **`orders_placed_at_check`: allow an abandoned order.**
  - Today: `PENDING_PAYMENT ⇒ placed_at NULL`, `FAILED ⇒ either`, everything else `NOT NULL`.
  - An abandoned order goes `PENDING_PAYMENT → CANCELED` without ever being placed, so `CANCELED` must also accept `NULL`.

### P1

- [ ] **`users`: profile fields.**
  - Add `email text NULL`, stored lower-cased.
  - Decide uniqueness; if unique, use a partial unique index `WHERE email IS NOT NULL`.
  - The app sends one `full_name`. The table has `first_name` / `last_name`, and the dispute-chat privacy filter strips `last_name`. Either split on the server or add a `full_name` column; don't break that filter.
- [ ] **`customer_addresses`: address book.** The table exists (`user_id`, the Nepal hierarchy, pin) and has no routes. Add:
  - `label` (`HOME` | `WORK` | `OTHER`, NOT NULL).
  - `recipient_name`, `recipient_phone` (nullable, same rules as above).
  - `is_default boolean NOT NULL DEFAULT false`.
  - CHECK: recipient set if and only if `label = 'OTHER'`.
  - Partial unique index `(user_id, label) WHERE label IN ('HOME','WORK')` — one Home, one Work per customer.
  - Partial unique index `(user_id) WHERE is_default` — one default.
  - Max 10 rows per customer, enforced in the service.
- [ ] **Category mapping: no new table.**
  - `products.category_id` already exists with `(vendor_id, is_active)` and `(category_id, is_active)` indexes.
  - A shop's root categories are a query: distinct root ancestor of each active product's category.
  - Only materialise if the feed query gets slow.

---

## 2. Core API endpoints

### P0

- [ ] **`POST /api/cart/checkout`: reject an address outside the shop's delivery scope.**
  - Reuse the CatalogService serviceability SQL (nation-wide, city-wide Palika match, radius × 1.1) against `delivery_address`.
  - Answer `422 OUTSIDE_DELIVERY_AREA` before pricing or locking.
  - The app only checks this client-side today, so any other client can bypass it.
  - Test: 5.4 km vs 5.501 km on a 5 km radius; Palika mismatch on a city-wide shop.
- [ ] **`POST /api/cart/checkout`: accept the recipient.**
  - New optional key `delivery_recipient: { name, phone } | null` beside `delivery_address`.
  - Store it on `order_addresses`.
- [ ] **Expose the recipient to shop and rider.**
  - `orderAddressViewSchema` gains `recipient_name` and `recipient_phone` (nullable).
  - It flows into the customer order detail, `VendorOrderView` and `DeliveryView`.
- [ ] **`POST /api/orders/:id/abandon`** (customer, order owner, no body).
  - `200 { order_id, state: "CANCELED" }`, also on repeat.
  - `404 ORDER_NOT_FOUND` for someone else's or unknown order.
  - `409 ORDER_STATE_CONFLICT` (`details.state`) when the order is no longer `PENDING_PAYMENT`.
  - One transaction under `SELECT … FOR UPDATE`; write `order.state_changed`.
  - After commit, release the Redis reservation and its holds. No stock to restore (stock is only decremented at the claim).
  - Test: 5 concurrent abandons → one event; abandon racing a payment webhook → exactly one wins.
- [ ] **Late payment for an abandoned or expired order sets `refund_required`.**
  - The `PAID_AFTER_SESSION_EXPIRED` path does not set the flag today.
  - Treat a payment arriving for a `CANCELED`-by-abandon order the same way.

### P1

- [ ] **`GET /api/me`, `PATCH /api/me`** (any signed-in role).
  - Response: `{ user: { id, phone, role, full_name | null, email | null, profile_complete } }`.
  - PATCH body: `{ full_name (2–80), email | null }`.
  - `profile_complete` means "has a name"; email is optional.
  - `409 EMAIL_TAKEN` if you chose unique emails.
- [ ] **`POST /api/auth/otp/verify`: add `profile_complete`** (or `full_name`) to the `user` object.
  - `authUserSchema` is strict, so this ships with an app build.
- [ ] **`POST /api/cart/checkout`: `422 PROFILE_INCOMPLETE`** when the customer has no name. Only after the two items above are live.
- [ ] **`GET /api/orders`** (customer, own orders).
  - Not yet specified in STATE_HANDOFF.md; proposed shape.
  - `?limit=&cursor=`, newest first, keyset on `(created_at, id)`.
  - Each row: `OrderView` plus `placed_at`, `delivered_at`, `vendor_business_name`, `item_count`.
  - `400 INVALID_CURSOR`.
  - The app's "Your Orders" currently lists only orders tracked on that phone.
- [ ] **Address book: `GET / POST /api/addresses`, `PUT / DELETE /api/addresses/:id`.**
  - Body: the Nepal address fields plus `label`, `recipient_name`, `recipient_phone`, `is_default?`.
  - `POST` with a Home/Work tag that already exists: `409 ADDRESS_LABEL_TAKEN` (the app confirms, then sends a `PUT` to the existing id).
  - `422 ADDRESS_LIMIT_REACHED` (`details.max: 10`).
  - `404 ADDRESS_NOT_FOUND` — also for another customer's id.
  - `400 VALIDATION_FAILED` for the recipient rule.
- [ ] **Feed: `category_ids` on each vendor.**
  - `GET /api/vendors` → `vendor.category_ids: uuid[]` (root categories the shop sells in).
  - Optional server-side filter `?category_id=`.
  - Removes the app's client-side scan and its 250-product cap.
- [ ] **Menu: category on each product.**
  - `GET /api/vendors/:id/products` → each product gains `category_id | null` and `category_name | null`.
  - Removes the extra product-list requests per shop visit.

- [ ] **User lifecycle (STATE_HANDOFF.md §8Z.10).**
  - `users`: `language_preference`, `terms_accepted_at`, `whatsapp_opt_in`, `account_status` (`ACTIVE` | `DELETED_REQUESTED` | `SUSPENDED`), `deletion_requested_at`.
  - `PATCH /api/me` also accepts `language_preference`, `whatsapp_opt_in` and `accept_terms: true` (the server stamps the time).
  - `GET /api/user/deletion-eligibility`, `POST /api/user/deletion-request` (`409 ACCOUNT_HAS_PENDING_ORDERS`). Both app stores require account deletion to work.
- [ ] **Favourites: `user_favourites (user_id, vendor_id)`** with `GET /api/me/favourites`, `PUT / DELETE /api/me/favourites/:vendor_id` (STATE_HANDOFF.md §8Z.8). The app keeps favourites on the phone until this exists.

### P2

- [ ] **Palika for a point.** With GPS as the default browse location the app sends no Palika, so city-wide shops show as "doesn't deliver". Resolve it from PostGIS polygons inside the feed query, or expose `GET /api/geo/palika?lat=&lng=`.
- [ ] **`DELETE /api/notifications/device-token`** on sign-out. Today the last account to register on a phone keeps receiving its pushes.
- [ ] **Rate limiting** on the public reads (`/api/vendors`, `/api/products`, `/api/categories`) and per IP on `/api/auth/*`.

---

## 3. Third-party integrations

### P0

- [ ] **Expo push: credentials, not code.**
  - Upload FCM V1 credentials (Android) and an APNs key (iOS) to the EAS project; add `google-services.json`.
  - No push has reached a real device yet.
  - The payload the app expects is already what the worker sends:

```jsonc
// POST https://exp.host/--/api/v2/push/send   (array, ≤ 100 per request)
{
  "to": "ExponentPushToken[…]",
  "title": "Order accepted", // omitted on data-only pushes
  "body": "The shop is preparing order #4FA5B6.",
  "sound": "default",
  "priority": "high",
  "channelId": "orders",
  "_contentAvailable": true, // data-only pushes only
  "data": {
    "type": "order.state_changed",
    "notification_id": "<event uuid>",
    "order_id": "<order uuid>", // the app opens /track-order?id= with this
    "state": "PREPARING",
    "audience": "CUSTOMER", // or "VENDOR"
    "data_only": false,
    "title": "Order accepted",
    "body": "…",
  },
}
```

- States and recipients: `PLACED` → vendor (data-only); `PREPARING` ("accepted") → customer; `OUT_FOR_DELIVERY` → customer (data-only); `DELIVERED`, `FAILED` → customer; `CANCELED` → customer, plus vendor if it was placed.
- There is no `ACCEPTED` state.
- Verify on a device that data-only pushes wake the app on budget Android.

### P1

- [ ] **WhatsApp OTP.**
  - `POST /api/auth/otp/send` accepts optional `channel: "SMS" | "WHATSAPP"` (default `SMS`).
  - Add a WhatsApp adapter beside the SMS ones (WhatsApp Business authentication template, or the SMS vendor's WhatsApp product).
  - `503 OTP_CHANNEL_UNAVAILABLE` when none is configured.
  - Same code rules for both channels: 6 digits, 2-minute TTL, 60-second cooldown per phone, 5 attempts.
  - Honour `MOCK_SERVICES=true` with a log line, like SMS.
  - Until this ships, the app shows "WhatsApp codes aren't available yet".
- [ ] **Refund payouts (eSewa / Khalti).**
  - A consumer for `order.canceled_refund_due`, and the same for late-paid abandoned or expired orders.
  - The app already tells customers "Escrow refund initiated"; nothing pays it.

### P2

- [ ] **Geocoding provider.**
  - Place search and reverse geocoding call the public Nominatim server from the device.
  - That server disallows autocomplete traffic and rate-limits to about 1 request/second.
  - Put a keyed provider behind `GET /api/geo/search?q=` and `GET /api/geo/reverse?lat=&lng=`, or give the app a provider key.
  - Search results must be shaped as `{ id, lat, lng, title, subtitle, label }`.
- [ ] **Map tiles.** The pin-drop map uses OpenStreetMap's public tiles, which are not for production traffic.
- [ ] **Expo push receipts.** Poll receipts and delete tokens that fail there; today only `DeviceNotRegistered` at ticket time is handled.

---

## 4. Premium Home and shop page (mock data in the app today)

Full schemas and contracts: STATE_HANDOFF.md §8Z.3. The app shows these from mock data in development builds only; a production build shows none of it until the API serves it.

### P1

- [ ] **Menu products: `description`, `unit`, `image_urls`** on `GET /api/vendors/:id/products` (columns exist; contract change only), plus `distance_km` on the response.
- [ ] **Shop fields on `vendors`:** `cover_image_url`, `prep_time_minutes`, `rating_average`, `rating_count`, `average_cost_npr`; all in the feed and menu vendor object, with `estimated_delivery_minutes` per feed entry.
  - `average_cost_npr` = median price of the shop's active, in-stock products, refreshed on product writes and by a nightly `VENDOR_STATS_REFRESH` task. Never averaged inside the feed query.
  - `rating_*` = public CUSTOMER_TO_VENDOR reviews only (the double blind must hold).
- [ ] **`GET /api/vendors?sort=`** `relevance | delivery_time | rating | cost_low_to_high | cost_high_to_low`, applied in SQL inside each section before the 100 cap, unknown values last.
- [ ] **`home_promotions` table, public `GET /api/home/promotions`, admin CRUD + image upload, a Promotions tab in the admin app.** Contract in STATE_HANDOFF.md §8Z.4:
  - `placement`: `CAROUSEL` | `FEATURED`.
  - `target_type`: `SHOP` | `CATEGORY` | `DISCOUNT_TAG` | null, with `target_value` = vendor id, category slug, or offer label.
  - Validate SHOP (LIVE vendor) and CATEGORY (active slug) on write: `422 PROMOTION_TARGET_NOT_FOUND`. Drop promotions with a dead target from the public read.
- [ ] **`vendors.offer_tags text[]` and `vendors.top_offer`**, written by a Super Admin, in the feed and menu vendor object. Labels only: they filter shops and change no price. Optional `GET /api/vendors?offer_tag=`.

### Discount engine

- [ ] Specified later on 2026-10-07: see section 5. Until section 5 step 2 ships, promotions and offer labels stay visual and change no price.

---

## 5. Business and settlement architecture (specified 2026-10-07, nothing built)

Schemas, formulas and contracts: STATE_HANDOFF.md §8Z.5. Rules: SPEC.md core sections 4, 5, 7, 8, 9. This replaces the "Deferred to Phase 2" note in section 4. Build in this order; each step is shippable on its own.

**Decided 2026-10-07:** Models A and B are the Phase 1 / 2 targets. **Model C is Phase 3 / deferred** (see the last block of this section). The Model B ad guard and the two-shop sponsored feed are required, not optional.

### Step 1 — foundations (no customer-visible change)

- [ ] **`audit_logs`**, append-only (trigger refuses UPDATE / DELETE), written in the same transaction as the change it records.
- [ ] **`ledger_entries.line_type`** (+ `ad_purchase_id`), backfilled for existing postings; new account types `AD_REVENUE`, `AD_BUDGET_CLEARING`, `PROMO_EXPENSE`, `REFUND_CLEARING`. New enum values need their own migration before first use (see migration 0019).
- [ ] **`vendors.settlement_model`** (all existing vendors `PLATFORM_ESCROW`) and **`vendor_ledgers`** as a projection written only by the posting trigger. No direct balance writes.
- [ ] **`orders`**: discount, ad premium and `settlement_model_locked` columns with their CHECKs; Drizzle schema, Zod entity and `contract.ts` together.

### Step 2 — cart math and the payment session

- [ ] **`vendor_offers`** (immutable rules; only `ended_at` may be set) and vendor routes; audit rows.
- [ ] **Pricing in `CheckoutService`**: `T = S - Dv - Dp + F`, commission on `S - Dv - Dpv`, integer paisa, the invariants, the snapshot. Test: SPEC verification 5 (total 860, commission 85.50).
- [ ] **`planSettlement`, reconciliation, eSewa / Khalti amount checks** read the order snapshot; platform share of a campaign posts to `PROMO_EXPENSE`.
- [ ] **`POST /api/cart/quote`** (priced cart + `payment_options`).
- [ ] **`payment_session` in the checkout response**, created for the discounted total before answering; `initiate` kept for retries; Khalti failure keeps no order.
- [ ] App: cart renders the quote lines and only the returned payment methods (strict schemas: ship together).

### Step 3 — platform campaigns

- [ ] **`platform_campaigns`, `campaign_opt_ins`** with the triggers: only the shop's own user can opt in; terms version must be current; a raised version closes old opt-ins.
- [ ] Admin campaign CRUD (**no admin opt-in route**), vendor invite / opt-in / opt-out routes, audit rows.
- [ ] Test: SPEC verification 6.

### Step 4 — settlement Model A (Model B is what runs today)

- [ ] **Payment routing** by model and ledger, in quote and checkout (`422 PAYMENT_METHOD_UNAVAILABLE`).
- [ ] **`WalletService.applyThreshold` per model**; same events and SMS. `DIRECT_PREPAID` exists in the enum but cannot be selected: `422 SETTLEMENT_MODEL_UNAVAILABLE`.
- [ ] **Ledger recharge** through eSewa / Khalti (replaces the mock top-up).
- [ ] Settlement model change request + admin approval, audited.
- [ ] Test: SPEC verification 8.

### Step 5 — Ad Marketplace

- [ ] **`ad_products`, `ad_purchases`**; `home_promotions.is_sponsored` + `ad_purchase_id` with the CHECK; `is_sponsored` on the feed entry.
- [ ] Purchase flow per model: taken or held at purchase (A; `422 LEDGER_RECHARGE_REQUIRED`), netted from payouts (B). Per-order premium as its own posting; pause on exhausted budget; release on end.
- [ ] **Model B guard (required):** refuse a `FLAT_RATE` purchase when `balance + pending_escrow < ad_price` → `422 AD_EXCEEDS_PENDING_PAYOUT`, checked under the vendor row lock. Test both sides of the boundary and two concurrent purchases.
- [ ] **Sponsored feed (required):** `GET /api/vendors` puts up to two ACTIVE `FEED_LISTING` shops first in "Delivers to you", nearest first, with `is_sponsored: true` on exactly those entries; never a shop that does not deliver here. Test: SPEC verification 9.
- [ ] Admin promo payload accepts `is_sponsored` + `ad_purchase_id` (`422 AD_PURCHASE_REQUIRED`, `AD_PURCHASE_MISMATCH`).
- [ ] Test: SPEC verification 7.

### Step 6 — vendor and admin screens

- [ ] Vendor "Marketing" tab: **My Offers** and **Campaign Invites** as separate sections; Ad Marketplace; ledger screen with Layer 1 and Layer 2 lines apart and Recharge.
- [ ] Admin: campaigns, ad products, audit log viewer, settlement model approvals.

### Phase 3 / deferred — Model C (`DIRECT_PREPAID`). Do not start in Phases 1–2

- [ ] **Preconditions:** written confirmation that eSewa and Khalti merchant terms allow the platform to operate a vendor's credentials; a managed encryption key for those secrets.
- [ ] **Fixed Reserve:** `vendor_ledgers.prepaid_floor_npr`, minimum and default 5000 NPR. Orders and ads only while the balance stays at or above it; below it the shop is suspended; restored at the reserve.
- [ ] `vendor_gateway_accounts`, sessions signed and verified with the vendor's credentials, `ORDER_FEE_DEBIT` at PLACED, `ORDER_REFUND` from the prepaid balance.
- [ ] Decide how a refund larger than the reserve is prevented (cap the order total at the reserve, or size the reserve per shop).

---

## Suggested build order

1. Commit and deploy the public vendor routes.
2. Checkout: delivery-area validation, recipient, and the recipient in order views.
3. Abandon endpoint, the `placed_at` check, and the late-payment refund flag.
4. Push credentials and a real-device delivery.
5. Profile (`/api/me`, verify response, `PROFILE_INCOMPLETE`).
6. `GET /api/orders`, address book CRUD.
7. Feed `category_ids` and menu categories.
8. WhatsApp OTP, refunds.
9. P2 items.
