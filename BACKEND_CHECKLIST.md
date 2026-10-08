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
- [x] **Strict CORS and request ids (2026-10-07).** `CORS_ALLOWED_ORIGINS` is an exact allowlist, empty by default (the admin dashboard is same-origin and the mobile apps are not browsers); an unlisted origin’s preflight is `403 CORS_ORIGIN_NOT_ALLOWED`. Every response carries `X-Request-Id`. Set the variable only if the dashboard is hosted on another origin (https only in production).
- [x] **`audit_logs` and its writer (2026-10-07)**: section 5 step 1. Run `pnpm db:migrate` (migration 0021) on every database.

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

- [x] **`POST /api/cart/checkout`: reject an address outside the shop's delivery scope.** **Built 2026-10-08**: `422 OUTSIDE_DELIVERY_AREA`, plus `422 DELIVERY_UNAVAILABLE` during the Emergency Stop.
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
- [x] **`home_promotions` table and the admin CRUD (2026-10-08, migration 0025, STATE_HANDOFF.md §8Z.24):** `GET / POST /api/admin/promotions`, `PUT / DELETE /api/admin/promotions/:id`, each write audited. `target_value` by type (SHOP a uuid of a LIVE vendor, CATEGORY the slug of a category active with all its ancestors, DISCOUNT_TAG a label of 1–40 characters); `422 PROMOTION_TARGET_NOT_FOUND`. **No promotion can be sponsored yet:** `ad_purchases` does not exist, so a purchase id is `422 AD_PURCHASE_MISMATCH` and the database refuses one too. Still open on the line below: the public `GET /api/home/promotions` and the image upload. The admin tab is wired (2026-10-08, §8Z.25), with a Delete button and **no sponsorship input** until `ad_purchases` exists.
- [ ] **`home_promotions` table, public `GET /api/home/promotions`, admin CRUD + image upload, a Promotions tab in the admin app.** Contract in STATE_HANDOFF.md §8Z.4:
  - `placement`: `CAROUSEL` | `FEATURED`.
  - `target_type`: `SHOP` | `CATEGORY` | `DISCOUNT_TAG` | null, with `target_value` = vendor id, category slug, or offer label.
  - Validate SHOP (LIVE vendor) and CATEGORY (active slug) on write: `422 PROMOTION_TARGET_NOT_FOUND`. Drop promotions with a dead target from the public read.
  - **Admin contract (the Promotions tab is built on it, sample data; STATE_HANDOFF.md §8Z.17):** `GET /api/admin/promotions` (every promotion, hidden and ended included, with `created_at` / `updated_at`), `POST /api/admin/promotions` and `PUT /api/admin/promotions/:id` `{ placement, image_url, title, subtitle, target_type, target_value, display_order, is_active, starts_at, ends_at, is_sponsored, ad_purchase_id }` (PUT replaces every field), `DELETE /api/admin/promotions/:id` (the app has no Delete button yet), `POST /api/admin/promotions/image`.
  - The order field is **`display_order`** (the customer app reads it), not `sort_order`. `target_value` by type: SHOP = a vendor uuid, CATEGORY = a category **slug**, DISCOUNT_TAG = a label of 1–40 characters.
  - `is_sponsored` exactly when `ad_purchase_id` is set, and then the target is that purchase’s shop (`422 AD_PURCHASE_REQUIRED`, `AD_PURCHASE_MISMATCH`; section 5 step 5). Each write gets an audit row.
- [ ] **`vendors.offer_tags text[]` and `vendors.top_offer`**, written by a Super Admin, in the feed and menu vendor object. Labels only: they filter shops and change no price. Optional `GET /api/vendors?offer_tag=`.

### Discount engine

- [ ] Specified later on 2026-10-07: see section 5. Until section 5 step 2 ships, promotions and offer labels stay visual and change no price.

---

## 5. Business and settlement architecture (specified 2026-10-07, nothing built)

Schemas, formulas and contracts: STATE_HANDOFF.md §8Z.5. Rules: SPEC.md core sections 4, 5, 7, 8, 9. This replaces the "Deferred to Phase 2" note in section 4. Build in this order; each step is shippable on its own.

**Decided 2026-10-07:** Models A and B are the Phase 1 / 2 targets. **Model C is Phase 3 / deferred** (see the last block of this section). The Model B ad guard and the two-shop sponsored feed are required, not optional.

### Step 1 — foundations (no customer-visible change)

- [x] **`audit_logs`**, append-only, written in the same transaction as the change it records. **Built 2026-10-07** (STATE_HANDOFF.md §8Z.18): migration `0021_audit_logs` (triggers refuse UPDATE, DELETE and TRUNCATE), the contract in shared-types `audit/audit-log.ts`, and the one writer, `recordAuditLog(tx, entry)` in `@hamro-pasal/db` (it takes a transaction, never the pooled database). SPEC verification 24.
  - [ ] **Use it:** every write listed in this file as "audit row" calls `recordAuditLog` inside its own transaction, with `auditActorOf(req)` and `auditContextOf(req, res)` (`apps/api/src/http/request-context.ts`); a worker job passes `{ kind: 'SYSTEM', job }`. A new action is added to `AUDIT_ACTION_ENTITY_TYPES` first.
  - [x] **Migrated 2026-10-08:** the vendor Suspend / Restore overrides and the payout decisions write `audit_logs` entries (`VENDOR_SUSPENDED_BY_ADMIN`, `VENDOR_RESTORED_BY_ADMIN`, `PAYOUT_APPROVED`, `PAYOUT_REJECTED`) inside their own transactions; the `console.warn` lines are gone.
  - [ ] **Deployment:** set Express `trust proxy` for the load balancer, or every entry records the balancer’s address as `ip_address`.
  - [x] **`GET /api/admin/audit-logs?vendor_id=&actor_user_id=&entity_type=&entity_id=&action=&limit=&cursor=`** (SUPER_ADMIN, `no-store`). **Built 2026-10-08** (STATE_HANDOFF.md §8Z.22). Newest first, keyset on `(occurred_at, id)`, limit 1–100 (default 50). Each row: the table’s columns (`before_state` / `after_state` exactly as stored) plus `actor_name` (a vendor’s business name, an admin’s name, or the job) and `vendor_name`; a job’s entry has `actor_user_id` and `actor_role` null and `system_actor` set. `400 INVALID_CURSOR`. **No write route of any kind** (tested). The contract is in shared-types `api/admin-governance.ts`.
    - [x] **Admin app:** the Audit log tab reads this route with `useInfiniteQuery`: the action and record type filters are query parameters, "Load older" pages with `next_cursor`, and the search box narrows the loaded entries (the route has no text search). **Wired 2026-10-08** (STATE_HANDOFF.md §8Z.25).
  - Actions the admin screens imply beyond the list of §8Z.5: `PAN_VERIFIED`, `PAN_VERIFICATION_CLEARED`, `PAYOUT_PROCESSED`, `PRICING_PLAN_CREATED`, `PRICING_PLAN_UPDATED`, `AD_PRODUCT_CREATED`, `AD_PRODUCT_UPDATED`, `LOGISTICS_SETTINGS_CHANGED`, `PROMOTION_CREATED`, `PROMOTION_UPDATED`, `PROMOTION_DELETED`, `SETTLEMENT_MODEL_CHANGE_REJECTED`. `action` is `text`, so none needs an enum migration.
  - `before_state` / `after_state` are JSON objects of the fields that matter for the change (the app diffs them by path). Never store a secret, a token or a delivery code in them.
- [ ] **`ledger_entries.line_type`** (+ `ad_purchase_id`), backfilled for existing postings; new account types `AD_REVENUE`, `AD_BUDGET_CLEARING`, `PROMO_EXPENSE`, `REFUND_CLEARING`. New enum values need their own migration before first use (see migration 0019).
- [x] **`vendors.settlement_model`** (migration 0025, 2026-10-08): enum `COD_CREDIT | PLATFORM_ESCROW | DIRECT_PREPAID`, NOT NULL, default `PLATFORM_ESCROW` for every existing and new shop; in `vendorSchema` and `contract.ts`. The settlement list and payout read it (`422 SETTLEMENT_MODEL_NOT_ESCROW`). Nothing can change it yet (the model change request flow of step 4). `vendor_ledgers`, on the line below, is still open.
- [ ] **`vendors.settlement_model`** (all existing vendors `PLATFORM_ESCROW`) and **`vendor_ledgers`** as a projection written only by the posting trigger. No direct balance writes.
- [ ] **`orders`**: discount, ad premium and `settlement_model_locked` columns with their CHECKs; Drizzle schema, Zod entity and `contract.ts` together.

### Step 2 — cart math and the payment session

- [ ] **`vendor_offers`** (immutable rules; only `ended_at` may be set) and vendor routes; audit rows.
- [ ] **Pricing in `CheckoutService`**: `T = S - Dv - Dp + F`, commission on `S - Dv - Dpv`, integer paisa, the invariants, the snapshot. Test: SPEC verification 5 (total 860, commission 85.50).
- [ ] **`planSettlement`, reconciliation, eSewa / Khalti amount checks** read the order snapshot; platform share of a campaign posts to `PROMO_EXPENSE`.
- [x] **`POST /api/cart/quote`** (priced cart + `payment_options`). **Built 2026-10-08** (STATE_HANDOFF.md §8Z.21), without discounts: no offers or campaigns exist yet.
- [ ] **`payment_session` in the checkout response**, created for the discounted total before answering; `initiate` kept for retries; Khalti failure keeps no order.
- [ ] App: cart renders the quote lines and only the returned payment methods (strict schemas: ship together).

### Step 3 — platform campaigns

- [x] **`platform_campaigns`, `campaign_opt_ins`** with the triggers: only the shop's own user can opt in; terms version must be current; a raised version closes old opt-ins. **Built 2026-10-08** (migration 0024, §8Z.22): tables, CHECKs and triggers only. An opt-in has `opt_in_terms_version`, `terms_snapshot` and `status` `ACTIVE | OPTED_OUT | VOIDED`; it is never updated except to close it once, and never deleted.
- [x] Admin campaign CRUD (**no admin opt-in route**) and the vendor opt-in, audit rows. **Built 2026-10-08** (§8Z.24): `GET / POST /api/admin/campaigns`, `PUT /api/admin/campaigns/:id`, `POST /api/vendor/campaigns/:id/opt-in { terms_version }` (`409 CAMPAIGN_TERMS_CHANGED` with `details.terms_version`, `404 CAMPAIGN_NOT_FOUND` for an unknown or unpublished campaign, `422 CAMPAIGN_ENDED`; 200 on repeat).
  - [x] **Built 2026-10-08 (§8Z.26):** `GET /api/vendor/campaigns` (published, not ended campaigns with the shop's latest opt-in: `opt_in_status`, `opt_in_terms_version`, `opted_in_at`) and `POST …/:id/opt-out` (200 also on repeat; `409 CAMPAIGN_NOT_OPTED_IN`). The Vendor App's Campaigns section still runs on samples.
- [x] **Dates are terms (decided 2026-10-07).** The terms trigger covers seven fields: `kind`, `value`, `max_discount_npr`, `min_cart_npr`, `vendor_share_percent`, **`starts_at`, `ends_at`**. Any of them may change only together with `terms_version + 1`, which closes every live opt-in. `name` and `is_active` are not terms. Test: shortening a campaign by one day voids its opt-ins; unpublishing it does not. **Enforced by the database since migration 0024** (both tests pass on PostgreSQL).
- [x] **Admin contract (the Campaigns tab is built on it, sample data):** `GET /api/admin/campaigns` → each campaign with `terms_version` and a read-only `opt_in_count` (live opt-ins on the current version); `POST / PUT /api/admin/campaigns { name, kind, value, max_discount_npr, min_cart_npr, vendor_share_percent, starts_at, ends_at, is_active }`, strict: a `vendor_id`, an opt-in key or a `terms_version` in the body is `400 VALIDATION_FAILED`. The server sets the version. Shapes: STATE_HANDOFF.md §8Z.15. **Built 2026-10-08**; the schemas are in shared-types `api/admin-marketing.ts`.
- [ ] Test: SPEC verification 6.

### Step 4 — settlement Model A (Model B is what runs today)

- [ ] **Payment routing** by model and ledger, in quote and checkout (`422 PAYMENT_METHOD_UNAVAILABLE`).
- [ ] **`WalletService.applyThreshold` per model**; same events and SMS. `DIRECT_PREPAID` exists in the enum but cannot be selected: `422 SETTLEMENT_MODEL_UNAVAILABLE`.
- [ ] **Ledger recharge** through eSewa / Khalti (replaces the mock top-up).
- [x] Settlement model change request + admin approval, audited. **Built 2026-10-08** (migration 0026, STATE_HANDOFF.md §8Z.26): `POST /api/vendor/ledger/settlement-model { model }` (201; `409 SETTLEMENT_MODEL_REQUEST_PENDING`, `422 SETTLEMENT_MODEL_UNAVAILABLE`, `422 SETTLEMENT_MODEL_UNCHANGED`), the admin list / approve / reject below, and the `#/approvals` tab wired. It sets `vendors.settlement_model` only (`vendor_ledgers` does not exist). The Vendor App has no screen for the request.
  - **Admin contract (the Vendor requests tab, `#/approvals`, is built on it, sample data):** `GET /api/admin/settlement-model-requests?status=` → each `{ id, vendor_id, business_name, phone, current_model, from_model, requested_model, status: PENDING | APPROVED | REJECTED, requested_at, open_order_count, ledger_balance_npr, active_ad_count, decided_at, rejection_reason }`; `POST …/:id/approve` (no body) and `POST …/:id/reject { reason? ≤ 500 }` → `200 { request }`, also on repeat.
  - Approve, under the vendor row lock: `409 SETTLEMENT_CHANGE_BLOCKED` (`details.blockers`: `OPEN_ORDERS`, `NEGATIVE_BALANCE`, `ACTIVE_AD`), `422 SETTLEMENT_MODEL_UNAVAILABLE` (Model C), `409 REQUEST_ALREADY_DECIDED`. It sets `vendors.settlement_model` and `vendor_ledgers.settlement_model` together and writes the audit row. **The body carries no model:** an admin decides the request as asked.
  - Table `settlement_model_change_requests` (one PENDING row per vendor, partial unique index; FKs to vendors and twice to users, each indexed).
- [ ] Test: SPEC verification 8.

### Step 5 — Ad Marketplace

- [x] **`ad_products`** (migration 0024, 2026-10-08): slot `CAROUSEL | FEED_LISTING`, billing model, `price_npr`, `duration_days` 1–90, `is_active`. A trigger refuses any change to the slot, billing model, price or duration. No route yet. `FEATURED` is not a slot: adding it later is one `ALTER TYPE … ADD VALUE` migration.
- [x] **`ad_purchases` table (migration 0026, 2026-10-08, §8Z.26): schema only.** Status `ACTIVE | PAUSED | ENDED | CANCELLED`; a trigger refuses a purchase the shop's own account did not agree to and any later change of its terms. `home_promotions.ad_purchase_id` is now a foreign key (the pending CHECK is dropped).
- [ ] **No route buys an ad yet**, so the table is empty: the vendor marketplace routes, the purchase flow per model, `is_sponsored` on the feed entry, `active_purchase_count` on the admin price list (still 0) and real validation of a sponsored promotion (the service still answers `422 AD_PURCHASE_MISMATCH`; the admin form's `SPONSORSHIP_AVAILABLE` stays false).
- [ ] Purchase flow per model: taken or held at purchase (A; `422 LEDGER_RECHARGE_REQUIRED`), netted from payouts (B). Per-order premium as its own posting; pause on exhausted budget; release on end.
- [ ] **Model B guard (required):** refuse a `FLAT_RATE` purchase when `balance + pending_escrow < ad_price` → `422 AD_EXCEEDS_PENDING_PAYOUT`, checked under the vendor row lock. Test both sides of the boundary and two concurrent purchases.
- [ ] **Sponsored feed (required):** `GET /api/vendors` puts up to two ACTIVE `FEED_LISTING` shops first in "Delivers to you", nearest first, with `is_sponsored: true` on exactly those entries; never a shop that does not deliver here. Test: SPEC verification 9.
- [ ] Admin promo payload accepts `is_sponsored` + `ad_purchase_id` (`422 AD_PURCHASE_REQUIRED`, `AD_PURCHASE_MISMATCH`).
- [x] **Admin price list (the Ad products tab is built on it, sample data):** `GET /api/admin/ads/products` (each with a read-only `active_purchase_count`), `POST /api/admin/ads/products { name, slot, billing_model, price_npr, duration_days, is_active }`, `PATCH /api/admin/ads/products/:id { name, is_active }`. **A published product’s slot, billing model, price and duration never change:** any of them in a PATCH is `400 VALIDATION_FAILED`. `price_npr` is an NPR amount under both billing models (a fixed fee per delivered order, never a percentage). No body names a vendor. **Built 2026-10-08** (§8Z.24), each write audited. `active_purchase_count` is 0 until `ad_purchases` exists. The slot is `CAROUSEL | FEED_LISTING` (the admin app’s list no longer has `FEATURED`).
- [ ] Test: SPEC verification 7.

### Step 6 — vendor and admin screens

- [ ] Vendor "Marketing" tab: **My Offers** and **Campaign Invites** as separate sections; Ad Marketplace; ledger screen with Layer 1 and Layer 2 lines apart and Recharge.
- [x] Admin: **eight of the nine sample screens are wired to their routes (2026-10-08, STATE_HANDOFF.md §8Z.25):** Compliance, Logistics, Pricing plans, Settlements, Campaigns, Ad products, Promotions, Audit log. Their `*-samples.ts` files are deleted.
  - [x] **Vendor requests (`#/approvals`) wired (2026-10-08, §8Z.26).** No admin screen runs on sample data any more; `lib/sample-data.ts` is deleted.
  - [ ] Delete the legacy Payouts tab with the vendor payout request route (6.11).
  - [ ] None of the wired screens has been opened in a browser or run against a live API yet.

### Phase 3 / deferred — Model C (`DIRECT_PREPAID`). Do not start in Phases 1–2

- [ ] **Preconditions:** written confirmation that eSewa and Khalti merchant terms allow the platform to operate a vendor's credentials; a managed encryption key for those secrets.
- [ ] **Fixed Reserve:** `vendor_ledgers.prepaid_floor_npr`, minimum and default 5000 NPR. Orders and ads only while the balance stays at or above it; below it the shop is suspended; restored at the reserve.
- [ ] `vendor_gateway_accounts`, sessions signed and verified with the vendor's credentials, `ORDER_FEE_DEBIT` at PLACED, `ORDER_REFUND` from the prepaid balance.
- [ ] Decide how a refund larger than the reserve is prevented (cap the order total at the reserve, or size the reserve per shop).

---

## 6. Vendor operations and IRD compliance (specified 2026-10-07, nothing built)

Rules: SPEC.md Dual-Fulfillment "Delivery Modularity", Vendor Pricing "Billing Cycle Lock", core section 10 "Fiscal Invoicing", Nepal section 5. Schemas, triggers and decisions: STATE_HANDOFF.md §8Z.11 (start with "Final decisions"). What the Vendor App already shows from sample data: §8Z.12 and §8Z.13. Every new or changed response shape lands in `packages/shared-types` first (strict schemas).

**Decided 2026-10-07:** every discount lowers the taxable amount and the Grand Total equals `total_npr`; the Billing Cycle is the BS calendar month, first cycle and first fee prorated by days; an expired Free plan reverts to the default Commission plan with a 7-day notice; a LIVE vendor without a PAN becomes `SUSPENDED_COMPLIANCE`; vendors see the customer's first name only; a fleet order stays "Ready" until its rider confirms the pickup; CBMS is a later phase.

### 6.1 Shared building blocks (do these first)

- [x] **P0 `localization/bikram-sambat.ts` in shared-types.** A BS month-length table (lookup, no formula), AD ↔ BS in `Asia/Kathmandu`, `fiscalYearOf(date)` → `"2082/083"` (the year starts on 1 Shrawan), `nextBsMonthStart(date)`, `daysInBsMonth`. Pin known date pairs in tests (7 October 2025 = 21 Ashwin 2082). **Partly built 2026-10-08** (STATE_HANDOFF.md §8Z.20): `nextBsMonthStart`, `bsDateOf`, `bsMonthStart` in `@hamro-pasal/ledger`, on the `nepali-date-converter` library (decided: no hand-kept table). Still to do: `fiscalYearOf`, `daysInBsMonth`.
- [ ] **P0 `amountInWords(npr)` in shared-types** (thousand / lakh / crore, "and Paisa … Only"). A working version with tests is in `apps/mobile/src/features/vendor/invoice-math.ts`; move it, do not rewrite it.
- [ ] **P0 The canonical Palika list in shared-types** (753 municipalities with province and district), exported for the API's validation and the app's picker. The app uses a 10-name stand-in today (`mock-palikas.ts`).
- [ ] **P1 `audit_logs`** (BACKEND_CHECKLIST section 5 step 1). The billing queue and the compliance sweep write to it.

### 6.2 PAN compliance and tax identity — P0

- [x] **Enum value `SUSPENDED_COMPLIANCE`** (migration 0022, 2026-10-08). It is in the same file as the columns: nothing there uses the value as an enum (the two CHECKs compare the status as text), which is what PostgreSQL requires inside one transaction.
- [x] **Migration B:** `vendors.legal_name`, `registered_address`, `tax_id` (`^[0-9]{9}$`), `is_vat_registered`, `status_before_compliance_suspension`; `vendors_compliance_suspension_check`. **Built 2026-10-08** (migration 0022), with one difference: the CHECK is one-way (`SUSPENDED_COMPLIANCE` needs a remembered status), so a debt or admin suspension can be laid on top of a compliance one without failing a delivery. Drizzle schema, `vendorSchema` and `contract.ts` together.
- [x] **`PUT /api/vendor/tax-identity`** (VENDOR, own shop, any status). **Built 2026-10-08** (STATE_HANDOFF.md §8Z.19): the PAN save, the compliance lift in the same transaction, the verification cleared on a changed PAN, audit entries `TAX_IDENTITY_SAVED` and `PAN_VERIFICATION_CLEARED`. The response also carries `legal_name`, `registered_address`, `compliance_suspension_lifted`, `pan_verified_at`.
  - [ ] **Not built with it:** the `vendor.restored` event (its payload is the debt restore’s: it needs its own event and SMS / push template), and issuing the invoices that were waiting (6.4 does not exist yet).
  - [ ] **Not built: uploading the PAN document itself.** The endpoint stores the number. A document vault (R2, KYC uploads) does not exist, so today a Super Admin has nothing to open when verifying.
  - Body `{ tax_id, is_vat_registered, legal_name?, registered_address? }` → `200 { vendor_id, tax_id, is_vat_registered, status }`.
  - `400 VALIDATION_FAILED` for anything but nine digits.
  - Same transaction, vendor row lock: a `SUSPENDED_COMPLIANCE` shop returns to `status_before_compliance_suspension`; write `vendor.restored`; issue the invoices its delivered orders were waiting for (6.4).
- [x] **Compliance sweep.** One-off run, then nightly `VENDOR_COMPLIANCE_SWEEP` on `midnight-maintenance`: every `LIVE` vendor with `tax_id IS NULL` → `SUSPENDED_COMPLIANCE`, outbox `vendor.suspended_for_compliance` (SMS + push), audit row. Only after it has run: add `vendors_live_tax_identity_check`. **Built 2026-10-08** (nightly `VENDOR_COMPLIANCE_SWEEP`, audited with the job as actor). Not built: the `vendor.suspended_for_compliance` event and its SMS / push, and `vendors_live_tax_identity_check`.
- [ ] **One gate for LIVE.** Go-live, `WalletService`'s debt restore and the admin Restore each send a vendor without a PAN to `SUSPENDED_COMPLIANCE` instead of `LIVE`.
- [ ] **Worker:** SMS + push templates for `vendor.suspended_for_compliance`.
- [ ] **Admin vendor list:** show the new status and suspension kind `COMPLIANCE`; Restore is refused while the PAN is missing.
- [ ] **No admin route lifts a compliance suspension (confirmed 2026-10-07).** Only the PAN-saving transaction does.
- [ ] **PAN verification (decided 2026-10-07; gates payouts, not LIVE).**
  - [x] Migration (0022, 2026-10-08): `vendors.pan_verified_at timestamptz NULL`, `pan_verified_by_user_id uuid NULL → users` (+ its partial index); CHECK both null or both set, and never set without a `tax_id`. Drizzle schema, `vendorSchema` and `contract.ts` together.
  - [x] **`GET /api/admin/compliance/vendors`** (SUPER_ADMIN): every vendor (at most 500) with `status`, `restore_status`, `compliance_suspended_at`, `legal_name`, `tax_id`, `is_vat_registered`, `pan_verified_at`, **grouped by PAN standing, worst first** (suspended for compliance, PAN missing, awaiting verification, verified; `PAN_STANDINGS` / `panStandingOf` in shared-types). **Built 2026-10-08** (STATE_HANDOFF.md §8Z.23).
    - [x] **Admin app:** the Compliance tab reads this route through the shared `complianceVendorViewSchema` / `panStandingOf` and verifies through `POST …/pan-verification`. A LIVE shop without a PAN is shown as "PAN missing", not refused. **Wired 2026-10-08** (STATE_HANDOFF.md §8Z.25).
  - [x] **`POST /api/admin/vendors/:id/pan-verification`** (no body) → `200 { vendor }`, also on repeat (the first stamp is kept); `409 PAN_MISSING`; `404 VENDOR_NOT_FOUND`. Vendor row lock; audit row `PAN_VERIFIED`; never changes `status`. **Built 2026-10-08** (§8Z.22).
  - `PUT /api/vendor/tax-identity` with a different `tax_id` sets `pan_verified_at` to null in its transaction (**confirmed 2026-10-07**): payouts freeze until the new PAN is verified; the shop stays LIVE.
  - The gate itself: section 6.11.
- [ ] Test: SPEC verification 13.

### 6.3 Shop settings: availability, delivery mode, scope, charges — P0 / P1

- [ ] **P0 `vendors.accepting_orders boolean NOT NULL DEFAULT true`** and **`PUT /api/vendor/availability { accepting_orders }`** → `200 { vendor_id, accepting_orders, status }` (also on repeat).
  - Never changes `status`. Feed entry gains `accepting_orders` (app shows the shop closed, carts disabled). Checkout: `422 VENDOR_UNAVAILABLE`.
  - Orders already placed are untouched. Test: SPEC verification 14.
- [ ] **P0 `GET /api/vendor/profile`** (VENDOR): `{ vendor_id, business_name, status, suspension: NONE | DEBT | ADMIN | COMPLIANCE, accepting_orders, tax_id, is_vat_registered, settlement_model, fulfillment_mode, delivery_scope, radius_km, serviceable_palikas, base_delivery_fee_npr, delivery_fee_per_km_npr, free_delivery_above_npr, billing_cycle_ends_at }`. One call replaces the app's local copies of the Online switch and Shop settings.
- [x] **P1 Migration:** `vendors.serviceable_palikas text[]` (backfilled with the shop's own Palika, GIN index, size and own-Palika CHECKs), `delivery_fee_per_km_npr`, `free_delivery_above_npr`, `base_delivery_fee_npr` default 0; `platform_settings.self_delivery_enabled`, `platform_fleet_enabled`, `platform_delivery_fee_npr`. **Built 2026-10-08** (migration 0022; a `BEFORE INSERT` trigger gives a new shop its own Palika).
- [x] **P1 `GET / PUT /api/vendor/delivery-settings`.** **Built 2026-10-08** (§8Z.19), with audit entry `DELIVERY_SETTINGS_CHANGED`. The response adds `municipality_palika_string`, `platform { self_delivery_enabled, platform_fleet_enabled, platform_delivery_fee_npr }` and `fulfillment_mode_enabled`.
  - [ ] **Not built: `422 PALIKA_UNKNOWN`.** There is no canonical Palika list (6.1), so a municipality name is only checked for shape. Add the check when the list exists.
  - [ ] **Stored, not yet used:** the feed and checkout still match a CITY_WIDE shop by its own Palika and charge `base_delivery_fee_npr` only (the serviceability SQL and delivery charge items below).
  - Body `{ fulfillment_mode, delivery_scope, radius_km, serviceable_palikas, base_delivery_fee_npr, delivery_fee_per_km_npr, free_delivery_above_npr }`.
  - `422 DELIVERY_MODE_DISABLED`; `422 PALIKA_UNKNOWN` (`details.palikas`) for a name not in the canonical list; `400 VALIDATION_FAILED` for a fee under `PLATFORM_FLEET` or a radius out of range.
- [x] **P1 Serviceability SQL** (`CatalogService`, shared with the checkout check of section 2): `CITY_WIDE` = `:palika = ANY (serviceable_palikas)`. `feedVendorSchema` gains `serviceable_palikas`, `is_national`. **Built 2026-10-08** (`deliversTo`, shared by the feed, the menu and checkout; the feed fields `serviceable_palikas` / `is_national` are not added yet).
- [x] **P1 Delivery charge in `CheckoutService`:** self delivery = base + `ceil(km)` × per-km (Radius scope only), 0 at or above the free-delivery threshold; fleet = `platform_delivery_fee_npr`. **Built 2026-10-08** (`checkout/delivery-fee.ts`, shared with the quote).
- [x] **P1 `PUT /api/admin/settings/logistics`** (the two mode switches and the platform fee). **Built 2026-10-08** (§8Z.22), with `GET`. The audit entry is `LOGISTICS_SETTINGS_CHANGED` on `platform_settings` (`entity_id` = `PLATFORM_SETTINGS_ENTITY_ID`). The two counts are LIVE shops. Not built: `forced_offline_reason` on the vendor profile. The admin tab is wired (2026-10-08, §8Z.25): the Emergency Stop needs a second press.
  - The Logistics tab is built on it (sample data). `GET /api/admin/settings/logistics` → `{ self_delivery_enabled, platform_fleet_enabled, platform_delivery_fee_npr, self_delivery_vendor_count, platform_fleet_vendor_count, updated_at }`; `PUT` takes the first three (fee 0–10000, whole paisa) and writes an audit row.
  - **Both switches may be off: the global Emergency Stop (decided 2026-10-07).** `PUT` accepts it (the admin app asks for a second confirmation). While it is on: the feed and the menu mark every shop closed, `POST /api/cart/quote` and checkout answer `422 VENDOR_UNAVAILABLE`, and `GET /api/vendors` (and the quote) carry **`delivery_available: false`** so the customer app can show "Delivery Unavailable". Orders already placed are untouched. Nothing is written per vendor: shops return when a mode is enabled again.
  - [x] **`delivery_available` (2026-10-08, §8Z.23):** on `GET /api/vendors` (the response: false during the Emergency Stop; each entry: false while that shop’s own mode is off), on `GET /api/vendors/:id/products`, and on `POST /api/cart/quote`. Derived on every read. **The quote no longer answers 422 for a delivery stop:** it prices the cart with `delivery_available: false` and every payment option unavailable (`reason: DELIVERY_UNAVAILABLE`); checkout still refuses (422). The field defaults to true in the schemas, so an app build reads an older API as "available".
  - [ ] **Customer app (one change to the frozen app, with this field):** a "Delivery Unavailable" banner on Home and in the cart when `delivery_available` is false. `feedResponseSchema` is strict: API and app ship together.
  - **A vendor cannot be without a delivery mode (decided 2026-10-07).** `fulfillment_mode` stays NOT NULL and `PUT /api/vendor/delivery-settings` has no "none". A shop whose mode is disabled is **forced Offline** as a derived state (`mode enabled AND accepting_orders AND status = LIVE` decides orderable); its own `accepting_orders` switch and its `status` are not written, so it comes back when it picks an enabled mode or the Admin re-enables its mode. `GET /api/vendor/profile` gains `forced_offline_reason: DELIVERY_MODE_DISABLED | null` for the Vendor App’s banner.
- [ ] Test: SPEC verification 10.

### 6.4 Fiscal invoicing — P0

- [ ] **Migration:** `fiscal_document_type`, `cbms_sync_status`; `invoice_sequences`, `invoices`, `invoice_lines`, `invoice_access_log` with every CHECK and index of §8Z.11; `products.hs_code`, `is_imported`, `is_vat_exempt`.
- [ ] **Immutability triggers:** `invoices` refuses DELETE / TRUNCATE and any UPDATE outside `print_count`, `first_printed_at`, `cbms_*`; lines and the access log are append-only; `invoice_sequences` only counts up by 1; lines only in the creating transaction; totals equal the lines at COMMIT.
- [ ] **`InvoiceService.issueForOrder(tx, order)`**, called by `DeliveryHandoff.handOver` (both the rider's and the vendor's handoff).
  - Counter row locked `FOR UPDATE` in the delivery transaction (never a SEQUENCE).
  - Discount spread over the lines (largest remainder), VAT split per line `taxable = round_half_up(g × 100 / 113)`, the shop's own delivery charge as a taxed `DELIVERY` line, a fleet charge outside its taxable sales.
  - **Assert `grand_total_npr = orders.total_npr` before insert**; a mismatch aborts the delivery.
  - Reference arithmetic with tests: `apps/mobile/src/features/vendor/invoice-math.ts#buildInvoice`.
- [ ] **A shop swept for compliance:** deliveries of its open orders succeed without an invoice; the PAN upload issues them (6.2).
- [ ] **`GET /api/orders/:id/invoice`** (customer, order owner): the invoice and its notes; logs VIEW; `404 INVOICE_NOT_FOUND` before delivery.
- [ ] **`GET /api/vendor/invoices?fiscal_year=&document_type=&limit=&cursor=`** (newest first, keyset) and **`GET /api/vendor/invoices/:id`** (header, metadata, lines, totals, `print_count`; logs VIEW). Another shop's is 404.
- [ ] **Printing is server-side only (confirmed 2026-10-07):** the app has no Print button until this route exists, so every copy is numbered.
- [ ] **`POST /api/vendor/invoices/:id/print`** → `{ copy_number, label }` (`ORIGINAL`, then `COPY OF ORIGINAL (n)`); under the row lock: `print_count + 1` and a PRINT log row.
- [ ] **`POST /api/vendor/invoices/:id/notes { document_type, reason, lines[] }`** (Credit / Debit Note, own gap-free sequence; a credit may not exceed what is left uncredited). Automatic Credit Note when a refund is paid after delivery (needs dispute resolution).
- [ ] **`GET /api/admin/invoices?vendor_id=&fiscal_year=&cursor=`** (read only; logs VIEW).
- [ ] **Vendor product routes** accept `hs_code`, `is_imported`, `is_vat_exempt` (`400` for an imported product without an HS code).
- [ ] **P2 CBMS** (deferred): a worker consumer of `invoice.issued` posting `PENDING` rows with the seller's CBMS credentials. Schema is ready; do not start.
- [ ] Test: SPEC verification 12, including 20 concurrent deliveries → bill numbers 1–20, a rolled-back delivery consuming none, the first invoice after 1 Shrawan being number 1, and UPDATE / DELETE refused for every role.

### 6.5 Billing cycles and pricing plans — P1

**Blocked on 6.1 (noted 2026-10-08).** A queued change takes effect at `billing_cycle_ends_at`, the first instant of the next BS month, and nothing can compute that without the BS month-length table. That table is reference data that must come from a verified source (it is not derivable and must not be guessed): supply it, or approve a maintained library for it, and the queue (`POST /api/vendor/billing/changes`) can be built.

- [ ] **Migration A (own file):** `ALTER TYPE pricing_model ADD VALUE 'FREE'`.
- [ ] **Migration B:** `pricing_plans` (+ `is_default`, one default, a Commission plan); `vendors.pricing_plan_id`, `accepted_payment_methods`, `billing_cycle_started_at`, `billing_cycle_ends_at`; `vendor_setting`, `setting_change_status`, `vendor_setting_changes` (one PENDING row per vendor and setting); drop `vendors.scheduled_downgrade`.
- [ ] **Going LIVE starts the first cycle:** `ends_at` = 00:00 Asia/Kathmandu on the 1st of the next BS month. A subscription's first fee = `monthly_fee × days left ÷ days in that BS month`, half-up to the paisa (confirmed 2026-10-07).
- [ ] **`GET /api/vendor/billing`**: active plan, accepted methods, cycle dates, pending changes, plans on offer.
- [x] **`POST /api/vendor/billing/changes { setting: PRICING_PLAN | PAYMENT_METHODS, value }`** → **202** with `effective_from`. Supersedes an earlier pending change of that setting; audit row. **Built 2026-10-08** (§8Z.20); `PAYMENT_METHOD_NOT_ALLOWED` waits for settlement models.
  - `422 PRICING_PLAN_NOT_OFFERED`; `409 LOCK_IN_ACTIVE` (`details.lock_in_expiry`); `422 PAYMENT_METHOD_NOT_ALLOWED` (`details.allowed`); `400 VALIDATION_FAILED` for an empty list.
- [x] **`DELETE /api/vendor/billing/changes/:id`** → 204 (withdraw; also on repeat); `409 SETTING_CHANGE_CLOSED`. **Built 2026-10-08.**
- [x] **`GET / POST /api/admin/pricing-plans`, `PATCH /api/admin/pricing-plans/:id { name, is_offered, is_default }`** (the Pricing plans tab is built on these, sample data; the PATCH replaces the earlier `…/withdraw` and `…/make-default`). **Built 2026-10-08** (§8Z.23) with the rules below, each write audited (`PRICING_PLAN_CREATED` / `PRICING_PLAN_UPDATED`, also for the plan that loses the default). A first plan must be the default (`409 DEFAULT_PLAN_REQUIRED`). `404 PRICING_PLAN_NOT_FOUND`. Not built: the two table CHECKs are already in migration 0023; no DELETE route exists on purpose.
  - The list carries `vendor_count` per plan.
  - **The model and terms of a plan never change:** a `model`, `commission_rate`, `monthly_fee_npr` or `duration_cycles` in a PATCH is `400 VALIDATION_FAILED`.
  - **Exactly one default, an offered Commission plan.** Making a plan the default clears the previous one in the same transaction. `409 DEFAULT_PLAN_REQUIRED` for switching the only default off or withdrawing it; `422 DEFAULT_PLAN_NOT_COMMISSION`; `409 PRICING_PLAN_NAME_TAKEN` (case-insensitive).
  - **Confirmed 2026-10-07:** a `COMMISSION` rate and a `SUBSCRIPTION` fee are strictly above 0 (add both to the table’s CHECKs: `model <> 'COMMISSION' OR commission_rate > 0`, `model <> 'SUBSCRIPTION' OR monthly_fee_npr > 0`); only `FREE` is 0. A Free plan lasts 1–36 cycles (still the app’s bound; to confirm).
- [x] **Worker `BILLING_CYCLE_RENEWAL`** (midnight, one transaction per vendor under the row lock): apply due PENDING changes, revert an expired Free plan to the default Commission plan (settlement model untouched), start the next BS month, audit rows. Safe to run twice or concurrently. **Built 2026-10-08** (starts first cycles, applies due changes, opens the next BS month). Not built: the Free-plan reversion.
- [ ] **Free-plan notice:** a delayed job at `plan end − 7 days` → outbox `vendor.free_plan_expiring` → SMS + push, once per plan period.
- [ ] **Checkout:** `payment_options` = the settlement-model routing ∩ `accepted_payment_methods` (active values only; never a PENDING row).
- [ ] Test: SPEC verification 11.

### 6.6 Live Orders board support — P1

- [ ] **`VendorOrderView.customer_first_name: string | null`** (first name only; `last_name` and the phone stay hidden). The app shows "Customer" until then.
- [ ] **`GET /api/vendors/orders` keeps fleet orders after dispatch**, with `delivery_state: OFFERED | ASSIGNED | PICKED_UP | null`, until the delivery is `PICKED_UP`; and returns the orders handed over or delivered today (or `?include=handed_over`). The app then drops its in-memory record of them.
- [ ] **Tell the shop when the rider picks up.** `POST /api/deliveries/:id/pickup` writes an outbox event today for nobody: add `delivery.picked_up` and fan it out to the shop's room as `delivery:state_update { order_id, delivery_state }`. The board moves the order from Ready to Handed Over on it.
- [ ] **Tell riders when an order is ready.** The vendor's dispatch ("Ready for Pickup") should push "Order ready at <shop>" to the assigned rider, or to riders who can take the open gig (no rider push exists today).
- [ ] **No new order state (decided 2026-10-07).** The board's "Ready" is `OUT_FOR_DELIVERY` not yet collected. The app disables "Ready for Pickup" with a countdown for the customer's 60 seconds; keep `422 CANCELLATION_WINDOW_OPEN` on dispatch as the rule (verify it, nothing to build).

### 6.7 Screens that only need wiring (the API exists)

- [ ] **Catalogue (app work):** the list is `GET /api/vendor/products`, the In Stock switch is the availability route of 6.8, the form is `POST` / `PUT /api/vendor/products`, categories are `GET /api/categories`, photos are `POST …/:id/images`. The app holds a sample catalogue in memory until this is done.
- [ ] **Ledger by settlement model:** `GET /api/vendors/wallet/balance` gains `settlement_model` and, once `vendor_ledgers` exists (section 5 step 1), `credit_limit_npr`, `ad_fees_owed_npr`, `prepaid_floor_npr`. The app previews models A and C from sample figures until then.

### 6.8 Product availability flag — P0 (decided 2026-10-07)

`products.is_active` already exists and means **hidden** (soft delete, admin Hide). The In Stock / Out of Stock switch is a second flag, `is_available`. Details: STATE_HANDOFF.md §8Z.14.

- [ ] **Migration:** `products.is_available boolean NOT NULL DEFAULT true`. Drizzle schema, `productSchema` and `contract.ts` together.
- [ ] **`PATCH /api/vendor/products/:id/availability { is_available }`** (VENDOR, own product) → `200 { product }`, also on repeat; `404 PRODUCT_NOT_FOUND` for another shop's. It never changes `stock_quantity`; `PATCH …/stock` never changes the flag.
- [ ] **`vendorProductViewSchema` gains `is_available`** (vendor and admin lists).
- [ ] **Customer reads:** `in_stock = is_available AND stock_quantity > 0` on `GET /api/products` and `GET /api/vendors/:id/products`, and `stock_quantity` reported as 0 while unavailable (no customer app change).
- [ ] **Checkout:** an unavailable line is a shortfall with `available: 0` (`409 INSUFFICIENT_STOCK`), in the stock guard and in the Redis lock's availability.
- [ ] Test: SPEC verification 16.

### 6.9 Marketing screens — the routes they call (all in section 5; nothing new)

The Vendor App's Marketing tab is built on sample data to these contracts. Build them with section 5 steps 2, 3 and 5.

- [ ] **My Offers:** `GET / POST /api/vendor/offers` (body `{ kind: FLAT | PERCENTAGE, value, min_cart_npr, max_discount_npr?, ends_at? }`; `400` when a flat value exceeds its minimum cart), `POST /api/vendor/offers/:id/end`. Each offer in the list carries the server-rendered `label`.
- [ ] **Campaigns:** `GET /api/vendor/campaigns` (invites and joined, each with `kind`, `value`, `max_discount_npr`, `min_cart_npr`, `vendor_share_percent`, `terms_version`, dates, `opted_in_at | null`), `POST …/:id/opt-in { terms_version }` (`409 CAMPAIGN_TERMS_CHANGED`), `POST …/:id/opt-out`. No admin opt-in route.
- [ ] **Ad Marketplace:** `GET /api/vendor/ads/products` (with the shop's `settlement_model`, `available_for_ads_npr`, and per product `collection` and `recharge_required_npr`), `POST /api/vendor/ads/purchases { ad_product_id, starts_at, budget_npr?, idempotency_key, agreed: true }`, `GET /api/vendor/ads/purchases`, `POST …/:id/cancel`.
- [ ] **The guard the app mirrors:** `422 AD_EXCEEDS_PENDING_PAYOUT` (Model B, `balance + pending_escrow < ad_price`) and `422 LEDGER_RECHARGE_REQUIRED` (Models A and C). The app shows "Insufficient funds for this ad purchase." for both.
- [ ] Ad products the app sells: slot `CAROUSEL` ("Carousel Placement", flat rate) and slot `FEED_LISTING` ("Sponsored Search", per order with a budget).

### 6.10 Analytics and the vendor account — P2

- [ ] **`GET /api/vendor/analytics/summary`** (VENDOR, own shop, `no-store`): `{ today_sales_npr, today_order_count, top_item: { product_name, units_sold, sales_npr } | null, ad_roi: { spend_npr, revenue_npr } | null, daily_sales: [{ day: SUN…SAT, sales_npr }] }` (7 entries, oldest first; days in Asia/Kathmandu; sales = delivered subtotal less the shop's own discounts). Shape and definitions: STATE_HANDOFF.md §8Z.14.
- [ ] **Language and WhatsApp consent:** the vendor settings call `PATCH /api/me { language_preference | whatsapp_opt_in }` (section 2, any role). Nothing vendor-specific.
- [ ] **`GET /api/vendor/deletion-eligibility`** → `{ eligible, blockers: [NEGATIVE_BALANCE | ACTIVE_ORDERS | PENDING_PAYOUT | ACTIVE_AD], wallet_balance_npr, active_order_count }`.
- [ ] **`POST /api/vendor/deletion-request`** (no body) → `200 { account_status: DELETED_REQUESTED, deletion_requested_at, accepting_orders: false }`, also on repeat; `409 SHOP_NOT_DELETABLE` (`details.blockers`), re-checked under the vendor row lock. One transaction: `users.account_status`, `vendors.accepting_orders = false`, audit row. `vendors.status` is not changed; invoices, ledger entries and audit rows are kept.
- [ ] **`DELETE /api/vendor/deletion-request`** → 204 (withdraw before the purge).
- [ ] Test: SPEC verification 17.

### 6.11 The PAN payout gate and settlement approvals — P0 for the gate (decided 2026-10-07)

A vendor trades as soon as its PAN is saved, but **no money is transferred to its bank account until a Super Admin has verified the PAN document** (`vendors.pan_verified_at`, section 6.2). Details: STATE_HANDOFF.md §8Z.15.

- [ ] **Retire vendor-requested payouts (decided 2026-10-07): payouts are admin-initiated or scheduled, never requested.**
  - Remove `POST /api/vendor/finance/payout` and `POST /api/admin/finance/payouts/:id/approve | reject`. Keep `GET /api/admin/finance/payouts` as read-only history.
  - `payout_requests` stays as the record of payouts: the settlement payout below writes its rows as APPROVED. No balance table.
  - Cutover: reject every PENDING request first, so each held amount is posted back to its wallet (`VENDOR_PAYOUT_REVERSAL`).
  - [x] Until the routes are removed, approve answers **`422 PAN_NOT_VERIFIED`** (`details.vendor_id`) for an unverified vendor; the request stays PENDING and Reject is not gated. **Built 2026-10-08** (the code was 409 in this file before; 422 was chosen on 2026-10-08).
  - Apps, in the same release: delete the admin “Payouts (legacy)” tab and `PayoutScreen`, and the “Request payout” form of the Vendor Portal’s Earnings tab (its balances and history stay). `GET /api/vendor/finance/ledger` keeps answering.
- [ ] **Not gated:** going LIVE, orders, and settlement postings into the ledger.
- [ ] `GET /api/vendor/finance/ledger` gains `pan_verified: boolean` (strict schema: API first), so the vendor sees why a payout is waiting.
- [x] **`GET /api/admin/finance/settlements`** (SUPER_ADMIN): Model B (`PLATFORM_ESCROW`) vendors with `available_for_payout_npr > 0`, each `{ vendor_id, business_name, phone, settlement_model, available_for_payout_npr, pending_escrow_npr, tax_id, pan_verified_at }`. Available = `max(0, wallet balance − ad_fees_owed_npr)`. **Built 2026-10-08** (§8Z.23). Every vendor is Model B until `vendors.settlement_model` exists, and `ad_fees_owed_npr` is 0 until `vendor_ledgers` does: available = `max(0, wallet balance)`.
- [x] **`POST /api/admin/finance/settlements/:vendor_id/payout { amount_npr, bank_reference, idempotency_key }`** → 201 / 200 replay. One transaction under the vendor row lock: the Phase 22 `VENDOR_PAYOUT` journal and a `payout_requests` row written as APPROVED. `422 PAN_NOT_VERIFIED`, `422 INSUFFICIENT_BALANCE`, `422 SETTLEMENT_MODEL_NOT_ESCROW`, `409 IDEMPOTENCY_KEY_REUSED`. **Built 2026-10-08** (§8Z.23), with audit entry `PAYOUT_PROCESSED`; `201 { payout, vendor, replayed }`. No minimum (a manual payout). Not built: `422 SETTLEMENT_MODEL_NOT_ESCROW` (no other model exists yet) and `409 BANK_ACCOUNT_REQUIRED` (no bank account routes).
- [ ] Any later transfer to a vendor bank account (Model C in Phase 3) takes the same gate.
- [ ] **Scheduled run:** a worker task (`SETTLEMENT_PAYOUT_RUN`) that pays every verified Model B vendor its available balance through the same service as the admin’s button, one transaction per vendor, skipping unverified vendors. **Schedule (decided 2026-10-07):**
  - Cron `0 2 * * 2`, `Asia/Kathmandu` (every Tuesday 02:00 NPT), a BullMQ scheduler like the midnight tasks, 3 attempts.
  - **Cut-off: Sunday 23:59 NPT**, read as the end of Sunday: `cutoff = Monday 00:00 Asia/Kathmandu` of the run’s week, exclusive.
  - Amount per vendor = `min(available balance from postings before the cutoff, available balance now)`: money credited after the cut-off waits a week, and a debit after the cut-off (a cash-order commission, an ad fee) still reduces what is paid, so a payout never overdraws the wallet. Computed under the vendor row lock.
  - **Minimum 1000 NPR, for the automated run only (decided 2026-10-08)**: a smaller amount is skipped by the run and carries over. A Super Admin’s manual payout has no minimum (closing out a suspended account, for example): the admin app’s form and `POST …/settlements/:vendor_id/payout` accept any positive amount up to what is available.
  - Idempotent per vendor and run: idempotency key `settlement-run:<cutoff date>:<vendor id>`, so a retried or doubled run pays once. One audit row per payout (`PAYOUT_PROCESSED`, actor `{ kind: 'SYSTEM', job: 'SETTLEMENT_PAYOUT_RUN' }`).
  - `GET /api/admin/finance/settlements` gains `next_run_at` and `cutoff_at`; the Settlements tab should show both and apply the minimum (app change).
  - [x] **Settlements tab wired (2026-10-08, §8Z.25):** the list, the primary bank account in each row, Process Payout disabled without a verified PAN or a primary bank account, one UUID idempotency key per opening of the payout window, and the 422 refusals shown in the form.
  - [x] **Vendor bank accounts (2026-10-08):** table `vendor_bank_accounts` (migration 0022: `bank_name`, `branch_name`, `account_name`, `account_number`, `routing_or_swift_code`, `is_primary`; one primary per vendor; RESTRICT).
  - [x] **Bank account routes (2026-10-08, §8Z.24):** vendor `GET / POST /api/vendor/bank-accounts`, `PUT …/:id` (each audited, the account number masked in the audit state). A shop with accounts always has exactly one primary: the first is primary, `is_primary: true` on another moves the mark, and it cannot be un-marked directly (`409 PRIMARY_BANK_ACCOUNT_REQUIRED`). At most 5 accounts; no delete. The admin’s settlement list shows the primary account in full, and **a payout is refused without one: `422 BANK_ACCOUNT_MISSING`** (this file said `409 BANK_ACCOUNT_REQUIRED` before; the code was set on 2026-10-08). No separate `make-primary` route: the PUT does it. The Vendor App has no screen for it.
  - [ ] **Still to decide: the transfer rail.** A scheduled job cannot type a bank reference: it needs a bank API, or a batch file an admin uploads to the bank and then confirms. Until then the run can only prepare the batch.
- [ ] Settlement **model change** approvals have their own tab now (`#/approvals`): section 5 step 4.
- [x] Test (2026-10-08, except the last clause): a verified shop is paid; an unverified one is refused on both routes with nothing posted; verifying then paying succeeds; a changed PAN closes the gate again; two concurrent payouts never exceed the balance; no route accepts a payout request from a vendor. SPEC verification 18. Still open from this line: "no route accepts a payout request from a vendor" (the vendor request route is retired with the app changes).

---

## Next phase (after the admin wiring of 2026-10-08)

Every admin tab except Vendor requests now runs on its real routes. What remains, in a suggested order:

1. **A browser pass of the wired admin app** against a migrated dev database (`pnpm db:migrate`, 0021–0025), and the first live run of the new routes.
2. ~~Vendor requests~~ **done 2026-10-08** (§8Z.26).
3. **Ad purchases, the flow** (section 5 step 5; the table exists since migration 0026): the vendor marketplace routes, collection per settlement model, the Model B guard, the sponsored feed, real validation of a sponsored promotion; then switch on `SPONSORSHIP_AVAILABLE` in the admin Promotions form.
4. **The vendor side of campaigns:** the routes are built (§8Z.26). Left: wiring the Vendor App's Campaigns section to them, and a notice to shops whose opt-in a terms change voided.
5. **Scheduled jobs:** `SETTLEMENT_PAYOUT_RUN` (blocked on the transfer rail), the Free-plan reversion and its 7-day notice in `BILLING_CYCLE_RENEWAL`, `vendor.suspended_for_compliance` SMS / push, the "one gate for LIVE", then `vendors_live_tax_identity_check`.
6. **Retire vendor payout requests** (6.11) with the legacy Payouts tab and the Vendor Portal's request form.
7. **Public promotions:** `GET /api/home/promotions`, the image upload, and the customer app's switch from mocks.
8. The discount engine (section 5 step 2) and fiscal invoicing (6.4).

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

Section 6 (vendor operations and IRD compliance), in this order; it can run alongside items 5–8:

1. 6.1 shared building blocks (BS calendar, amount in words, the Palika list).
2. 6.2 PAN compliance and PAN verification, with the gate of 6.11 on the existing payout approval, then 6.3's availability switch and `GET /api/vendor/profile` (the Vendor App's settings screen and Online switch stop being local).
3. 6.3 delivery settings and the serviceability / fee changes.
4. 6.4 invoicing (tables, triggers, issuing in the delivery transaction, read and print routes).
5. 6.8 the availability flag, then 6.6 board support and 6.7 wiring.
6. 6.5 billing cycles and pricing plans (after `audit_logs`).
7. 6.9 follows section 5 (offers with step 2, campaigns with step 3, ads with step 5); 6.10 after `PATCH /api/me` exists.
8. Credit / Debit Notes with dispute resolution; CBMS last.
9. The settlement list and admin-initiated payout of 6.11, then the retirement of vendor payout requests in the same release as the app changes; the Tuesday 02:00 run once vendor bank details and a transfer rail exist.
