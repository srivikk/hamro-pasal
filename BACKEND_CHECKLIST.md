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

## 6. Vendor operations and IRD compliance (specified 2026-10-07, nothing built)

Rules: SPEC.md Dual-Fulfillment "Delivery Modularity", Vendor Pricing "Billing Cycle Lock", core section 10 "Fiscal Invoicing", Nepal section 5. Schemas, triggers and decisions: STATE_HANDOFF.md §8Z.11 (start with "Final decisions"). What the Vendor App already shows from sample data: §8Z.12 and §8Z.13. Every new or changed response shape lands in `packages/shared-types` first (strict schemas).

**Decided 2026-10-07:** every discount lowers the taxable amount and the Grand Total equals `total_npr`; the Billing Cycle is the BS calendar month, first cycle and first fee prorated by days; an expired Free plan reverts to the default Commission plan with a 7-day notice; a LIVE vendor without a PAN becomes `SUSPENDED_COMPLIANCE`; vendors see the customer's first name only; a fleet order stays "Ready" until its rider confirms the pickup; CBMS is a later phase.

### 6.1 Shared building blocks (do these first)

- [ ] **P0 `localization/bikram-sambat.ts` in shared-types.** A BS month-length table (lookup, no formula), AD ↔ BS in `Asia/Kathmandu`, `fiscalYearOf(date)` → `"2082/083"` (the year starts on 1 Shrawan), `nextBsMonthStart(date)`, `daysInBsMonth`. Pin known date pairs in tests (7 October 2025 = 21 Ashwin 2082).
- [ ] **P0 `amountInWords(npr)` in shared-types** (thousand / lakh / crore, "and Paisa … Only"). A working version with tests is in `apps/mobile/src/features/vendor/invoice-math.ts`; move it, do not rewrite it.
- [ ] **P0 The canonical Palika list in shared-types** (753 municipalities with province and district), exported for the API's validation and the app's picker. The app uses a 10-name stand-in today (`mock-palikas.ts`).
- [ ] **P1 `audit_logs`** (BACKEND_CHECKLIST section 5 step 1). The billing queue and the compliance sweep write to it.

### 6.2 PAN compliance and tax identity — P0

- [ ] **Migration A (own file, before first use):** `ALTER TYPE vendor_status ADD VALUE 'SUSPENDED_COMPLIANCE'`.
- [ ] **Migration B:** `vendors.legal_name`, `registered_address`, `tax_id` (`^[0-9]{9}$`), `is_vat_registered`, `status_before_compliance_suspension`; `vendors_compliance_suspension_check`. Drizzle schema, `vendorSchema` and `contract.ts` together.
- [ ] **`PUT /api/vendor/tax-identity`** (VENDOR, own shop, any status).
  - Body `{ tax_id, is_vat_registered, legal_name?, registered_address? }` → `200 { vendor_id, tax_id, is_vat_registered, status }`.
  - `400 VALIDATION_FAILED` for anything but nine digits.
  - Same transaction, vendor row lock: a `SUSPENDED_COMPLIANCE` shop returns to `status_before_compliance_suspension`; write `vendor.restored`; issue the invoices its delivered orders were waiting for (6.4).
- [ ] **Compliance sweep.** One-off run, then nightly `VENDOR_COMPLIANCE_SWEEP` on `midnight-maintenance`: every `LIVE` vendor with `tax_id IS NULL` → `SUSPENDED_COMPLIANCE`, outbox `vendor.suspended_for_compliance` (SMS + push), audit row. Only after it has run: add `vendors_live_tax_identity_check`.
- [ ] **One gate for LIVE.** Go-live, `WalletService`'s debt restore and the admin Restore each send a vendor without a PAN to `SUSPENDED_COMPLIANCE` instead of `LIVE`.
- [ ] **Worker:** SMS + push templates for `vendor.suspended_for_compliance`.
- [ ] **Admin vendor list:** show the new status and suspension kind `COMPLIANCE`; Restore is refused while the PAN is missing.
- [ ] Test: SPEC verification 13.

### 6.3 Shop settings: availability, delivery mode, scope, charges — P0 / P1

- [ ] **P0 `vendors.accepting_orders boolean NOT NULL DEFAULT true`** and **`PUT /api/vendor/availability { accepting_orders }`** → `200 { vendor_id, accepting_orders, status }` (also on repeat).
  - Never changes `status`. Feed entry gains `accepting_orders` (app shows the shop closed, carts disabled). Checkout: `422 VENDOR_UNAVAILABLE`.
  - Orders already placed are untouched. Test: SPEC verification 14.
- [ ] **P0 `GET /api/vendor/profile`** (VENDOR): `{ vendor_id, business_name, status, suspension: NONE | DEBT | ADMIN | COMPLIANCE, accepting_orders, tax_id, is_vat_registered, settlement_model, fulfillment_mode, delivery_scope, radius_km, serviceable_palikas, base_delivery_fee_npr, delivery_fee_per_km_npr, free_delivery_above_npr, billing_cycle_ends_at }`. One call replaces the app's local copies of the Online switch and Shop settings.
- [ ] **P1 Migration:** `vendors.serviceable_palikas text[]` (backfilled with the shop's own Palika, GIN index, size and own-Palika CHECKs), `delivery_fee_per_km_npr`, `free_delivery_above_npr`, `base_delivery_fee_npr` default 0; `platform_settings.self_delivery_enabled`, `platform_fleet_enabled`, `platform_delivery_fee_npr`.
- [ ] **P1 `GET / PUT /api/vendor/delivery-settings`.**
  - Body `{ fulfillment_mode, delivery_scope, radius_km, serviceable_palikas, base_delivery_fee_npr, delivery_fee_per_km_npr, free_delivery_above_npr }`.
  - `422 DELIVERY_MODE_DISABLED`; `422 PALIKA_UNKNOWN` (`details.palikas`) for a name not in the canonical list; `400 VALIDATION_FAILED` for a fee under `PLATFORM_FLEET` or a radius out of range.
- [ ] **P1 Serviceability SQL** (`CatalogService`, shared with the checkout check of section 2): `CITY_WIDE` = `:palika = ANY (serviceable_palikas)`. `feedVendorSchema` gains `serviceable_palikas`, `is_national`.
- [ ] **P1 Delivery charge in `CheckoutService`:** self delivery = base + `ceil(km)` × per-km (Radius scope only), 0 at or above the free-delivery threshold; fleet = `platform_delivery_fee_npr`.
- [ ] **P1 `PUT /api/admin/settings/logistics`** (the two mode switches and the platform fee).
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

- [ ] **Migration A (own file):** `ALTER TYPE pricing_model ADD VALUE 'FREE'`.
- [ ] **Migration B:** `pricing_plans` (+ `is_default`, one default, a Commission plan); `vendors.pricing_plan_id`, `accepted_payment_methods`, `billing_cycle_started_at`, `billing_cycle_ends_at`; `vendor_setting`, `setting_change_status`, `vendor_setting_changes` (one PENDING row per vendor and setting); drop `vendors.scheduled_downgrade`.
- [ ] **Going LIVE starts the first cycle:** `ends_at` = 00:00 Asia/Kathmandu on the 1st of the next BS month. A subscription's first fee = `monthly_fee × days left ÷ days in that BS month`, half-up to the paisa (confirmed 2026-10-07).
- [ ] **`GET /api/vendor/billing`**: active plan, accepted methods, cycle dates, pending changes, plans on offer.
- [ ] **`POST /api/vendor/billing/changes { setting: PRICING_PLAN | PAYMENT_METHODS, value }`** → **202** with `effective_from`. Supersedes an earlier pending change of that setting; audit row.
  - `422 PRICING_PLAN_NOT_OFFERED`; `409 LOCK_IN_ACTIVE` (`details.lock_in_expiry`); `422 PAYMENT_METHOD_NOT_ALLOWED` (`details.allowed`); `400 VALIDATION_FAILED` for an empty list.
- [ ] **`DELETE /api/vendor/billing/changes/:id`** → 204 (withdraw; also on repeat); `409 SETTING_CHANGE_CLOSED`.
- [ ] **`GET / POST /api/admin/pricing-plans`, `POST …/:id/withdraw`, `POST …/:id/make-default`.**
- [ ] **Worker `BILLING_CYCLE_RENEWAL`** (midnight, one transaction per vendor under the row lock): apply due PENDING changes, revert an expired Free plan to the default Commission plan (settlement model untouched), start the next BS month, audit rows. Safe to run twice or concurrently.
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

Section 6 (vendor operations and IRD compliance), in this order; it can run alongside items 5–8:

1. 6.1 shared building blocks (BS calendar, amount in words, the Palika list).
2. 6.2 PAN compliance, then 6.3's availability switch and `GET /api/vendor/profile` (the Vendor App's settings screen and Online switch stop being local).
3. 6.3 delivery settings and the serviceability / fee changes.
4. 6.4 invoicing (tables, triggers, issuing in the delivery transaction, read and print routes).
5. 6.8 the availability flag, then 6.6 board support and 6.7 wiring.
6. 6.5 billing cycles and pricing plans (after `audit_logs`).
7. 6.9 follows section 5 (offers with step 2, campaigns with step 3, ads with step 5); 6.10 after `PATCH /api/me` exists.
8. Credit / Debit Notes with dispute resolution; CBMS last.
