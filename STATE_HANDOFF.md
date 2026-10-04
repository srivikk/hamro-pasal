# Hamro Pasal: State Handoff (Phases 0–23 complete, feature development closed; Phase 24 local test harness)

This file tells a fresh agent session exactly what exists in this repository, so it can resume
work without re-deriving it. It describes the tree at the end of **Phase 23 (End-to-End System Audit & Failure Mode Hardening)**, the last planned development phase, on top of Phase 22 (Financial Reconciliation & Payouts), 21 (Rider Dispatch &
Geolocation Telemetry), 20 (Push Notifications & Event Alerting), 19 (Vendor Catalog Management & Asset Uploads), 18 (Mobile
Customer Discovery & Live Inventory Integration), 17 (Catalog, Taxonomy & Inventory Management), 16 (Authentication Hardening & HTTP-Only Cookies), 15 (Super Admin Web Dashboard & DLQ Monitoring), 14 (Worker Resiliency & IVR Escalation), 13 (Notification Worker & SMS Dispatch), 12.5 (Application-Layer Suspension & Top-Ups), 12 (Vendor Wallet &
Debt Reconciliation), 11.5 (Vendor Dispatch UI & Self-Delivery Handoff), 11 (Driver Handoff & OTP Verification), 10 (Vendor Order Management & Audio Alarms), 9.6 (Chat Transcript Read-Back), 9.5 (Chat Persistence & Vendor Review Linkage), 9 (Double-Blind Reviews & Dispute Chat), 8 (Real-Time Order Tracking, Socket.io `/orders`), 7.5 (Token Refresh Flow & Auth Polish), 7 (OTP
Authentication), 6.5 (Mobile Live-Link) and 6 (Backend Gap-Closing). When this file and the code disagree, **the code wins**. When anything disagrees with
`SPEC.md`, **SPEC.md wins** (see `CLAUDE.md`).

> **Status in one paragraph.** The customer path is now linked end to end in code: the mobile app
> reads the PostGIS vendor feed, vendor menus and order detail from the Express API, sends the
> saved Nepal delivery address with checkout, and cancels through the server. **The feed, menu and
> cancel mocks are deleted.** Every call is validated against the shared-types Zod contracts, and
> both sides are covered by tests (API integration tests on real Postgres/Redis; mobile tests over
> msw). **Customers sign in with a +977 OTP** (6 digits, Redis, 2 min) and get a 15-min access
> token plus a 7-day refresh token; the app renews the access token transparently (§8A, §9.3).
> **Order tracking is real time (Phase 8):** every order state change writes an
> `order.state_changed` outbox event; a worker Kafka consumer broadcasts it through Redis to the
> API's Socket.io `/orders` room `order:{id}` as `order:state_update`, and the tracking screen
> patches its TanStack Query cache from it. The 30 s polling is gone (§8B, §9.6). Both mobile
> sockets (`/orders`, `/chat`) share one token lifecycle with the HTTP refresh path (§9.3).
> **Phase 9:** `POST /api/reviews` stores double-blind reviews (quarantined until both sides rate or
> 48 h pass), the API serves the `/chat` dispute namespace (Redis adapter, server-side PII filter) and
> accepts dispute photos at `POST /api/uploads/dispute-evidence` (local disk stand-in for R2, 5 MB);
> the app's review and upload mocks are deleted (§8C, §9.9, §9.10).
> **Phase 9.5:** every `/chat` message is stored in `chat_messages` before it is broadcast, and an
> order's first message opens its `disputes` row (an OPEN dispute stays reachable past 48 h); vendors
> rate customers at `POST /api/vendors/orders/:id/reviews` with the same quarantine transaction (§8C).
> **Phase 9.6:** `GET /api/orders/:id/chat` returns the transcript (customer, vendor or admin; same
> privacy filter as the broadcast), and the dispute screen hydrates from it while the socket
> connects, refetching after every re-join (§8C, §9.10).
> **Phase 10:** vendors accept (PLACED → PREPARING) or reject (→ CANCELED, stock back, escrow refund
> flag for prepaid) at `POST /api/vendors/orders/:id/accept|reject` and list open orders at
> `GET /api/vendors/orders`. Every order that becomes PLACED gets a BullMQ timer at `placed_at + 90 s`
> (scheduled by a worker Kafka consumer of the PLACED outbox event); if the order is still PLACED
> then, the worker writes `vendor.escalation.required` (topic `notifications.broadcast`) for the
> IVR/SMS fallback. Vendors join a `vendor:{id}` room on `/orders`; the app routes a VENDOR to a
> dashboard (`app/(vendor)/dashboard.tsx`) whose `expo-audio` alarm loops at full volume until each
> new order is accepted or rejected (§8D, §9.13). A vendor may accept at once; the customer can still
> cancel a PREPARING order inside the 60 s window (user decision, §12).
> **Phase 11:** vendors dispatch a PREPARING order at `POST /api/vendors/orders/:id/dispatch`
> (→ OUT_FOR_DELIVERY, refused with `422 CANCELLATION_WINDOW_OPEN` until `placed_at + 60 s`), and a
> platform rider delivers at `POST /api/driver/orders/:id/deliver { delivery_otp }`: the bcrypt hash
> must match; a match sets DELIVERED + `delivered_at`, erases the hash (column now nullable,
> migration 0013), records the rider and **settles escrow in the same transaction**. Wrong codes
> are `401 INVALID_OTP` (Redis counter per order); the 5th locks the order for 15 min
> (`429 DELIVERY_OTP_LOCKED`). Riders list fleet orders out for delivery at `GET /api/driver/orders`
> and use `app/(driver)/driver/dashboard.tsx` (§8E, §9.14). The mobile HTTP layer now refreshes
> the token only on a 401 `UNAUTHENTICATED` (a replayed wrong code would count twice).
> **Phase 11.5:** the vendor dashboard has a **Dispatch** button on PREPARING orders (a 422
> `CANCELLATION_WINDOW_OPEN` becomes a toast with the seconds left), and the shop's own staff hand
> over **SELF_DELIVERY** orders at `POST /api/vendors/orders/:id/deliver` with exactly the rider's
> rules (one shared `DeliveryHandoff`: bcrypt check, 5-try Redis lockout, DELIVERED + hash erased +
> settlement in one commit); a fleet order there is `409 WRONG_FULFILLMENT_MODE`. The vendor list
> now includes the shop's own OUT_FOR_DELIVERY orders, shown with the 4-digit code field (§8E,
> §9.13).
> **Phase 12:** vendors read their wallet at `GET /api/vendors/wallet/balance` (balance, suspension
> limit, `is_suspended`, prepaid earnings still in escrow) and `GET /api/vendors/wallet/ledger`
> (wallet postings newest first, cursor-paginated, with the balance after each), shown on
> `app/(vendor)/wallet.tsx` with a red "shop is offline" banner when suspended. A new midnight task,
> `VENDOR_DEBT_RECONCILIATION`, suspends every non-suspended vendor whose wallet is strictly below
> the current `platform_settings` limit and writes `vendor.suspended_for_debt` (§8F, §9.15).
> **Phase 12.5:** suspension is now also applied **in the application layer**: every journal that
> moves a vendor wallet goes through `WalletService` (inside `LedgerService.post`), which suspends
> a vendor crossing the limit (`vendor.suspended_for_debt`) and restores a debt-suspended vendor to
> its previous status once the balance is back to 0 or more (`vendor.restored`), both via the
> outbox to Kafka. **The `enforce_vendor_wallet_limit` trigger was kept** as the database safety
> net (user decision; SPEC §5 requires a database trigger), so no migration drops it. New:
> `POST /api/vendors/wallet/top-up` (mock credit, only with `WALLET_TOP_UP_MODE=MOCK`, refused in
> production) and the app's "Pay outstanding balance" button (§8F, §9.15).
> **Phase 13:** the worker consumes `notifications.broadcast` and texts the vendor for
> `vendor.suspended_for_debt` (shop offline, dues to pay), `vendor.restored` (back online) and
> `vendor.escalation.required` (order waited over 90 s), once per `event_id` (Redis claim), retried
> by Kafka redelivery when the provider fails. The SMS adapters moved from the API into a shared
> package, **`@hamro-pasal/sms`**, so the API (login codes) and the worker use the same Sparrow /
> Aakash / Mock code and the same `SMS_PROVIDER` switch; `MOCK` logs `[sms:mock] to +977…: <text>`
> and makes no network call (§8G).
> **Phase 14:** the notification consumer is wrapped in a **dead-letter queue**: a message that
> fails its first attempt and 3 retries (1 s / 2 s / 4 s backoff) is copied byte for byte to the new
> Kafka topic **`notifications.dlq`** (with `dlq_*` headers), its offset is committed and the
> partition moves on; an unparseable envelope goes there at once. A **stale-order guard** reads the
> order's current state before an escalation is sent and silently drops it unless the order is
> still PLACED. The escalation now also places an **IVR call** concurrently with the SMS, through a
> new shared package **`@hamro-pasal/ivr`**: only a MOCK adapter exists (`IVR_PROVIDER=MOCK` logs
> `[ivr:mock] Calling +977…: "You have a pending order…"`; the default `DISABLED` places no call)
> (§8H).
> **Phase 15:** every dead letter is now also a row in the new **`dead_letter_events`** table
> (written by the worker **before** the Kafka copy, key/value byte for byte, idempotent per source
> offset). A Super Admin lists them at `GET /api/admin/dlq` and presses Retry
> (`POST /api/admin/dlq/:id/retry` → 202 `RETRY_REQUESTED`); the worker's new **DeadLetterReplayer**
> (outbox-style, `FOR UPDATE SKIP LOCKED`) republishes the stored bytes to the source topic and marks
> the row `REPLAYED`; a replay that fails again becomes a new row linked by `replay_of_id`. Admins
> also list every vendor with wallet and standing (`GET /api/admin/vendors`) and **Suspend / Restore**
> them by hand through `WalletService` (new column `vendors.status_before_admin_suspension`; paying
> dues never lifts an admin suspension; Restore is refused below the wallet limit; each override
> writes `vendor.status_overridden` + an audit log line). A new **Vite + React web app,
> `apps/admin`**, signs in with the +977 OTP (SUPER_ADMIN only) and shows both screens (§8I).
> **Phase 16:** a Super Admin's refresh token is no longer readable by scripts: `POST /api/auth/otp/verify`
> puts it in an **`HttpOnly; Secure; SameSite=Strict` cookie** (`hamro_pasal_refresh`, path `/api/auth`,
> 7 days) and leaves it out of the JSON body; every other role (the mobile app) still gets it in the
> body. New: **`POST /api/auth/refresh`** (reads only the cookie, answers a new 15-min access token plus
> the account; a refused cookie is cleared; an account that is no longer SUPER_ADMIN is refused) and
> **`POST /api/auth/logout`** (clears the cookie, 204). The admin app keeps only the access token in
> memory, renews it from the cookie on a 401, and **restores the session with a silent refresh on page
> load**, so a browser reload no longer signs out (§8J).
> **Phase 17:** the catalogue has a **Master Category Taxonomy** and products carry real catalogue
> data. New table **`categories`** (a tree through `parent_id`, at most 3 levels, unique slug);
> `products` gained `category_id`, `description`, `unit`, `image_urls`, `metadata`, the listing
> indexes and a **GIN full-text index** on name + description (migration 0016). A Super Admin writes
> the taxonomy at `POST / PUT / DELETE /api/admin/categories` (cycles, depth and slug checked under one
> advisory lock; only an unused category can be deleted, a used one is hidden). Vendors add SKUs at
> `POST /api/vendor/products`, set stock at `PATCH /api/vendor/products/:id/stock` and list their own
> at `GET /api/vendor/products`. **Public, no token:** `GET /api/categories` (the active tree) and
> `GET /api/products` (active products of LIVE vendors; `category_id` includes descendants,
> `vendor_id`, full-text `search`, keyset pagination). Checkout now refuses a cart line above
> `products.stock_quantity` **before** pricing (`409 INSUFFICIENT_STOCK` with every short line), on top
> of the Redis lock and the guarded decrement that already existed. The admin app has two new tabs,
> **Categories** (tree + create/edit modal) and **Products** (overview by vendor, Hide / Show). Cloud
> infrastructure was skipped on purpose (user decision): everything runs on local Docker (§8K).
> **Phase 18:** the mobile Home screen now uses the catalogue. A search field and one pill per
> **root category** (`GET /api/categories`, cached 5 min) sit above the vendor feed; typing (debounced
> **300 ms**) or choosing a pill swaps the feed for the public product list
> (`GET /api/products?category_id=&search=`, paged), showing name, description, price per unit and
> stock. **`GET /api/products` now also returns `stock_quantity`** (it carried only `in_stock`; a
> Phase 17 choice reversed because the quantity picker needs the number). The picker cannot pass
> stock − what the cart holds; a product with `stock_quantity === 0` shows an "Out of Stock" badge
> with Add disabled; only shops in the feed's serviceable section can be ordered from. Cart lines
> remember the last known stock (`availableStock`, store v3). A checkout refused with
> `409 INSUFFICIENT_STOCK` writes each short line's `available` into the store; the cart highlights
> those lines, asks for a lower quantity ("Set to N" / "Remove") and keeps Proceed disabled until
> they fit (§9.16).
> **Phase 19:** vendors manage their own catalogue. New on `/api/vendor/products`: **`PUT /:id`**
> (replaces name, description, price, unit, category, visibility; never the stock; the photo list
> only when one is sent), **`DELETE /:id`** (soft delete: `is_active = false`, 204) and
> **`POST /:id/images`** (multipart, 1–8 `images` parts, JPEG / PNG / WebP by their own bytes, 5 MB
> each, at most 8 photos per product). Photos are written to **`apps/api/uploads/product-images/<product>/<uuid>.<ext>`**
> (the new default `UPLOADS_DIR`, git-ignored; dispute evidence moved there too), served statically
> at `/uploads`, and their URLs appended to `products.image_urls`. Every statement carries the
> caller's vendor id, so **another shop's product is `404 PRODUCT_NOT_FOUND` and untouched**.
> **`GET /api/vendors/:id/products` (the mobile vendor menu) now returns `stock_quantity`**, and the
> menu passes it to the cart, which closes the Phase 18 gap (a line added from a menu had no stock
> ceiling). The web app (`apps/admin`) now also admits **vendors**: they land on a **Vendor Portal**
> ("My products": stock per row, Hide / Show, an Edit modal with details, category and photo upload).
> No cloud storage was added (user decision: local infrastructure only) (§8L).
> **Phase 20:** order updates reach phones as **Expo push notifications**. New table
> **`device_tokens`** (migration 0017: one row per app installation, unique Expo push token → user)
> and **`POST /api/notifications/device-token`** (any signed-in role; upsert, a phone follows the
> account that signed in on it last). The app asks for the notification permission once a session
> exists (launch or right after sign-in), fetches its token with `expo-notifications` and registers
> it; a foreground handler shows banners while the app is open. The worker has a third consumer
> on `order.lifecycle`, **`order-push-notifications`**: for every `order.state_changed` it reads
> the customer's / vendor's tokens from Postgres and POSTs to
> `https://exp.host/--/api/v2/push/send` with plain `fetch` (new order → vendor; accepted,
> dispatched, delivered, failed → customer; cancelled → both). **New orders and dispatches are
> data-only pushes** (SPEC implicit requirement 1); the app's background task posts their visible
> notification. Push is **best effort** (claimed once per event, a failure is logged and never
> blocks the partition); a token Expo reports `DeviceNotRegistered` is deleted. With
> `SMS_PROVIDER=MOCK` the worker also logs `[sms:mock] to +977…: Hamro Pasal: New order. …` beside
> each push attempt (no SMS is ever sent for an order push) (§8M, §9.17).
> **Phase 21:** platform riders now work through **deliveries**. New table **`deliveries`**
> (migration 0018: one per fleet order, `OFFERED → ASSIGNED → PICKED_UP → DELIVERED`, `FAILED`
> reserved) is created when a shop dispatches a PLATFORM_FLEET / EMERGENCY_FLEET order. A rider
> lists open gigs and their own at `GET /api/deliveries`, takes one at
> `POST /api/deliveries/:id/accept` (row-locked: one of several riders wins, the others get
> `409 DELIVERY_ALREADY_ASSIGNED`), marks it `POST …/pickup`, and hands it over at
> `POST …/complete { delivery_otp }`. **The doorstep code is still the order's
> `orders.delivery_otp`** (user decision: no `handoff_otp` column), checked by the unchanged
> `DeliveryHandoff` (bcrypt, 5-try Redis lockout, DELIVERED + hash erased + settlement in one
> commit). **The Phase 11 routes `/api/driver/orders` are removed** (user decision): a fleet order
> can only be delivered by the rider who accepted it, after pickup. **Rider GPS:** DRIVER accounts
> now connect to Socket.io `/orders` (user decision: no new namespace) and emit
> `rider:location { latitude, longitude }`; the API stores it with **`GEOADD riders:active`** (+ a
> hash of report times) and every 5 s pushes **`order:rider_location`** to the customers subscribed
> to an order whose delivery a rider has accepted. The mobile rider dashboard has Accept / Picked up
> / code field per delivery and a **"Simulate GPS" switch** (mock positions, testing only); the
> Profile tab has a `__DEV__` **Rider Mode** entry that signs out and opens sign-in for a rider
> number. The customer app does **not** show the pushed position yet (§8N, §9.14).
> **Phase 22:** vendors can withdraw their earnings, and delivered orders are reconciled nightly.
> **No balance table was added** (user decision; SPEC §5 prohibits single-entry wallet tables):
> "available" is the VENDOR_WALLET ledger balance and "pending" the prepaid earnings still in
> escrow. New table **`payout_requests`** and column **`orders.reconciled_at`** (migration 0019),
> a new ledger account type **`PAYOUT_CLEARING`** and journal kinds `VENDOR_PAYOUT` /
> `VENDOR_PAYOUT_REVERSAL`. A vendor reads `GET /api/vendor/finance/ledger` and requests a payout
> at `POST /api/vendor/finance/payout`: **the amount is held at once** (user decision), moved
> VENDOR_WALLET → PAYOUT_CLEARING under the vendor row lock, so concurrent requests can never
> exceed the balance (`422 INSUFFICIENT_BALANCE`). A Super Admin lists requests at
> `GET /api/admin/finance/payouts`, **approves** one with the bank transfer's reference
> (`POST …/:id/approve`; no further deduction) or **rejects** it (`POST …/:id/reject`, added: the
> amount is posted back). The worker's third midnight task, **`ORDER_RECONCILIATION`**, does **not**
> credit vendors a second time (settlement still happens in the delivery's commit; user decision):
> for every DELIVERED order without `reconciled_at` it verifies the settlement journal against the
> order's stored commission, posts the journal if it is missing, and stamps `reconciled_at`; a
> mismatch is audited and left unreconciled. It can be run by hand with
> `pnpm --filter @hamro-pasal/worker reconcile:orders`. The ledger code (LedgerService,
> SettlementService, WalletService, the settlement plan, money) moved from the API into a shared
> package, **`@hamro-pasal/ledger`**, so the worker posts with the same code. The web app has a
> **Payouts** tab (Super Admin) and an **Earnings** tab in the Vendor Portal (§8O).
> **Phase 23 (the last planned phase; feature development is closed):** an audit, no new feature.
> `apps/api/test/e2e-lifecycle.int.test.ts` walks **one order through the whole platform over the
> public HTTP API** (browse → checkout → eSewa payment → vendor accept → dispatch → rider accept →
> pickup → doorstep code → settlement) and then runs the **midnight reconciliation by its manual
> command**; `apps/api/test/inventory-stress.int.test.ts` fires **100 concurrent checkouts at 5
> units: exactly 5 orders, 95 × `409 INSUFFICIENT_STOCK`, stock 0**. The schema audit found **7
> foreign keys without an index**; migration **`0020_audit_indexes`** adds them (the two the prompt
> named, the order's customer and `deliveries.rider_id`, were already indexed). The JWT audit found
> the access and refresh keys correctly separated and added one startup check (a JWT secret may not
> equal a payment gateway key). **"Closed" means the planned phases 0–23 are done, not that every
> line of SPEC.md is built**: the list at the end of this paragraph still stands (§8P, §13).
> **Phase 24 (local end-to-end harness; not a product feature):** one switch, **`MOCK_SERVICES=true`**
> (refused at boot with `NODE_ENV=production`), keeps every third-party call on the machine: SMS and
> IVR are answered as their MOCK adapters whatever `SMS_PROVIDER` / `IVR_PROVIDER` say, the worker
> logs **`[MOCK PUSH] -> Vendor <vendor id>: <payload>`** / **`-> User <customer id>: …`** instead of
> calling Expo, and the API serves **`POST /api/test/mock-payment { order_id }`**, which pays a prepaid
> order through the real confirmation code (PAID, escrow credited, PLACED). The route is registered
> only when `process.env.NODE_ENV !== 'production'` **and** the switch is on; otherwise the path is
> the ordinary `404 NOT_FOUND`. The seed gives the Thamel shop **five** products, and
> `pnpm dev:all` boots API, worker, admin and Expo together. The Docker setup, `db:seed` and the
> mock SMS already existed and were kept; **no password was added** (SPEC: sign-in is +977 OTP only)
> (§8Q).
> **No live device run has happened yet** (§13); the admin app and the DLQ retry loop were run live
> against local infrastructure (§8I), as were the cookie session (§8J), the catalog screens (§8K) and the Vendor Portal with a real upload (§8L) in headless Edge. **No push has been delivered to a real device** (the Expo API is mocked in every test; FCM / APNs credentials are not set up). Still not built: a real IVR provider (Twilio Voice
> or a Nepal SIP trunk; only the mock exists), gig broadcast by distance / "Reached Location" / "Delivery Failed", the ghost-customer timer,
> a customer screen for the rider's position,
> dispute resolution (no admin screen for it yet), KYC verification, R2, refund payouts,
> and refresh-token rotation/revocation.
>
> **Next priority: the first live end-to-end device run** (§11 item 1), now including a vendor device
> and a rider device, covering the whole lifecycle through dispatch, the delivery code and
> settlement.

---

## 0. Ground rules (read first)

- `CLAUDE.md`: follow SPEC.md strictly. Implement only the requested scope. Strict TypeScript with
  zero `any`. Write tests for every service, transaction and state mutation. Never replace Nepal
  address models (Province/District/Palika/Ward/Tole) or eSewa/Khalti flows with Western defaults.
- `AGENTS.md` is generated by Turborepo. Before changing Turbo config, read `node_modules/turbo/docs/`.
- `SPEC.md` was edited by the user during the project: vendors use `municipality_palika_string`, and
  Kafka uses `@confluentinc/kafka-javascript`. Both are implemented.
- **Contracts live in `@hamro-pasal/shared-types`.** Every endpoint's request and response Zod
  schemas are there (`api/requests.ts`, `api/responses.ts`); the API integration tests parse every
  response with them, and the mobile client validates with the same definitions.
- **Rebuild after touching `packages/*`.** Workspace packages are consumed through their built
  `dist/`: run `pnpm build` (or `turbo run build --filter=<pkg>`) before the API, worker or Metro
  can see a change. Stale `dist/` shows up as confusing type errors (e.g. a new column "missing").
- The project verifies important behaviour with **mutation checks**: break the rule on purpose,
  confirm a test fails, restore. Phase 6 did this for the 1.1× radius buffer, the 60 s window, the
  `placed_at` anchor and the address-aware idempotency fingerprint; Phase 6.5 for the address-based
  feed location, the `CANCELLATION_WINDOW_EXPIRED` mapping and the refund toast; Phase 7 for the
  OTP TTL, single use, session storage, post-sign-in refetch and return navigation; Phase 7.5 for
  the refresh single flight, the relaunch refresh and the no-revival guard. **A test must not
  build its expectation from the constant it is guarding** (the 422 screen test uses the literal
  server code for this reason).

## 1. Snapshot

| Item            | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commits         | `a85082d` init · `e5dc38d` P1 infra · `b4adafe` P2 DB · `204239a` P3 concurrency/ledger/Kafka · `140e82b` + `6c06575` P4 gateways/HTTP/contracts · `d396d8b` 5.1 · `22fe6b6` 5.2 · `142e6f4` 5.3 · `9f23735` 5.4 · `72d56ac` 5.5 · `50b2e4b` 5.6 · `f6f6630` 5.7 · `d8d62c6` handoff · `77a980c` P6 · `a9fc049` P6.5 · `5f1e0f5` P7 + 7.5 · `1be7a71` P8 · `136f184` P9 · `eb2ec80` P9.5 · `1f50027` P9.6 · `2ae9633` P10 · `e2cb61d` P11 · `5f3fc9a` P11.5 · `81d45ba` P12 · `76b1d7f` P12.5 · `6aa0f73` P13 · `aa13ee6` P14 · `95b0272` P15 · `c937775` P16 · `5253be9` P17 · `b8e2edd` P18 · `bbac3a9` P19 · `27898bf` P19 + P20 · `9d2f5f6` P21 · `745ed08` P22 · Phase 23 (uncommitted) |
| Node            | 24 (`.nvmrc`), engines `>=24`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Package manager | pnpm 12.6.0 via corepack. Run `corepack enable pnpm` once (Turbo needs `pnpm` on PATH)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Monorepo        | pnpm workspaces + Turborepo 2.11, `nodeLinker: hoisted` (required by Metro)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| TypeScript      | **6.0.3** (pinned `~6.0`: typescript-eslint supports `<6.1`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Tests           | Jest **29** everywhere (Expo SDK 57 requires it); backend uses ts-jest + supertest                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Unit tests      | **1446 passing** (`pnpm test`): shared-types 214, api 92, worker 142, sms 21, ivr 7, kafka 7, db 7, ledger 11, admin 106, mobile 839 (end of Phase 24; every suite rerun)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Integ. tests    | **655 passing** (`pnpm test:integration`, needs `pnpm infra:up`): db 64, api 524, worker 66, kafka 1 (end of Phase 24; every suite rerun). Phase 24 fixed two order-dependent tests (§8Q). **Stop any running worker first**: a dev worker on the same Kafka broker makes `vendor-notifications.int` fail. Earlier flakes, none reproduced since: one unexplained `driver-orders-api` failure in the first full Phase 12.5 run (that suite was replaced in Phase 21); once in Phase 9 the kafka publisher test timed out beside the worker suite. The `vendors-api` CITY_WIDE flake (Phases 9.6–11.5) is **fixed**                                                                           |
| Lint/format     | ESLint 10 flat config (`strictTypeChecked` + react-hooks 7 for mobile), Prettier; Husky pre-commit runs lint-staged. All clean at the end of Phase 23                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Dev database    | Migrations 0000–0020 applied (`pnpm db:migrate`); `drizzle-kit generate` reports "No schema changes"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

### Root commands (`package.json`)

```
pnpm build | dev | lint | lint:fix | typecheck | test | test:integration | format | format:check | clean
pnpm dev:all       # Phase 24: turbo run dev --concurrency=20 (API, worker, admin, Expo + the package watchers)
pnpm infra:up      # docker compose up --wait, then provisions Kafka topics (kafka-init)
pnpm infra:down    # stop containers, keep volumes
pnpm infra:reset   # drop all volumes and start fresh
pnpm db:generate | db:migrate | db:seed    # via Turbo -> packages/db
pnpm --filter @hamro-pasal/api token:dev [-- --phone 98XXXXXXXX]   # 15-min access JWT for a seeded user
pnpm --filter @hamro-pasal/worker reconcile:orders                 # Phase 22: run the nightly order reconciliation now
```

Turbo tasks `typecheck`, `lint`, `test`, `test:integration`, `dev` and `db:migrate` depend on
`^build`.

## 2. Repository map

```
.env.example · .env (git-ignored)   every server env var
docker-compose.yml                  postgis/postgis:16-3.5-alpine, redis:7.4-alpine, apache/kafka:4.3.1 (KRaft),
                                    kafka-init (profile "init"), prom/prometheus:v3.15.0
infra/postgres/init/01-extensions.sql · infra/kafka/create-topics.sh · infra/prometheus/prometheus.yml
eslint.config.mjs · tsconfig.base.json (strictness flags) · tsconfig.node.json (NodeNext/CJS) · turbo.json · pnpm-workspace.yaml
```

### Backend workspaces

```
packages/shared-types/src          @hamro-pasal/shared-types (zod only, safe for React Native)
  api/requests.ts                  checkoutRequestSchema (delivery_address REQUIRED), vendorFeedQuerySchema,
                                   vendorMenuQuerySchema, idParamSchema, lockStatusQuerySchema,
                                   paymentInitiateRequestSchema, esewaWebhookRequestSchema, khaltiLookupRequestSchema,
                                   otpSendRequestSchema, otpVerifyRequestSchema, tokenRefreshRequestSchema,
                                   MAX_CART_LINES=50, MAX_LINE_QUANTITY=99
  api/responses.ts                 errorBodySchema, orderViewSchema, lockViewSchema, paymentViewSchema,
                                   checkoutResponseSchema, lockStatusResponseSchema, esewa/khalti initiate schemas,
                                   paymentStatusResponseSchema, feedVendorSchema, feedEntrySchema, feedResponseSchema,
                                   menuProductSchema, vendorMenuSchema, orderAddressViewSchema, orderItemViewSchema,
                                   orderSnapshotSchema, orderDetailResponseSchema, cancelOrderResponseSchema,
                                   otpSendResponseSchema, authUserSchema, authTokensResponseSchema,
                                   tokenRefreshResponseSchema; Phase 16: cookieAuthTokensResponseSchema (no refresh_token),
                                   otpVerifyResponseSchema (either sign-in shape), sessionRefreshResponseSchema
  api/admin.ts                     Phase 15: adminDeadLetterListQuerySchema, deadLetterViewSchema, adminDeadLetterList/Retry
                                   response schemas, adminVendorViewSchema (suspension NONE|DEBT|ADMIN|UNSPECIFIED),
                                   adminVendorList/Override response schemas, ADMIN_VENDOR_LIST_LIMIT=500
  api/notifications.ts             Phase 20: expoPushTokenSchema (EXPO_PUSH_TOKEN_PATTERN), devicePlatformSchema
                                   (ANDROID | IOS), deviceTokenRegisterRequest / Response schemas,
                                   orderPushDataSchema (the `data` of every order push), ORDER_PUSH_CHANNEL_ID='orders'
  api/catalog.ts                   (publicProductSchema carries stock_quantity since Phase 18)
                                   Phase 17: adminCategoryWriteRequestSchema, category / adminCategory view + list schemas,
                                   buildCategoryTree, flattenCategoryTree, slugifyCategoryName, vendorProductCreate / Stock /
                                   ListQuery schemas, vendorProductViewSchema, productListQuerySchema, publicProductSchema,
                                   adminProductListQuery / View / ActiveRequest schemas, PRODUCT_LIST_MAX_LIMIT=50
  domain/{enums,entities,constants}.ts   strict row schemas (users, vendors, products, orders, order_addresses, ...)
                                   constants incl. DELIVERY_RADIUS_GPS_DRIFT_MULTIPLIER=1.1, ORDER_CANCELLATION_WINDOW_SECONDS=60,
                                   OTP_CODE_LENGTH=6, OTP_TTL_SECONDS=120, OTP_RESEND_COOLDOWN_SECONDS=60,
                                   OTP_MAX_VERIFY_ATTEMPTS=5, ACCESS_TOKEN_TTL_SECONDS=900, REFRESH_TOKEN_TTL_SECONDS=604800
  env/server-env.ts                serverEnvSchema, parseServerEnv (empty optional vars are treated as unset), kafka env;
                                   SMS_PROVIDER ∈ SPARROW | AAKASH | FIREBASE | MOCK (MOCK refused in production)
  events/domain-events.ts          Kafka topics + typed event envelopes
  jobs/queues.ts                   BullMQ queue names, delays, payload schemas
  localization/{address,nepal-geography,numerals,phone}.ts   (numerals: toNepaliNumerals, toAsciiDigits)
  nepal/geo.ts                     NEPAL_BOUNDING_BOX (single source for every coarse Nepal check), isWithinNepalBoundingBox
  realtime/orders-socket.ts        /orders wire contract: ORDERS_NAMESPACE, ORDER_SOCKET_EVENTS, orderRoom, SOCKET_PING_INTERVAL_MS,
                                   SOCKET_IO_REDIS_KEY, SOCKET_UNAUTHENTICATED, orderSubscribeRequest/Ack schemas,
                                   orderStateUpdateSchema, orderStateUpdateFromEvent (Phase 8)
packages/db/src                    @hamro-pasal/db: Drizzle schema, client, migrator, outbox writer
  schema/{columns,enums,categories,users,vendors,orders,ledger,outbox,wallet,disputes,dead-letters,
          device-tokens,deliveries,contract}.ts
  geo/ewkb.ts · outbox.ts · testing.ts (@hamro-pasal/db/testing) · scripts/{migrate,seed,database-url}.ts
packages/db/drizzle/               0000–0020 SQL migrations (+ meta/ snapshots, 0003 hand-patched)
packages/kafka/src                 config.ts, producer.ts (DomainEventPublisher), index.ts
packages/sms/src                   @hamro-pasal/sms (Phase 13, server-only; moved from apps/api/src/sms):
  sms-gateway.ts                   Sparrow / Aakash / Mock adapters (strict +977 via prepareOutboundSms), SmsDeliveryError
  from-env.ts                      smsGatewayFromEnv(env, { mockLog?, fetch? }) picks one by SMS_PROVIDER; mockSmsLogLine
packages/ivr/src                   @hamro-pasal/ivr (Phase 14, server-only; used by the worker):
  ivr-gateway.ts                   IvrGateway, MockIvrGateway (strict +977 via prepareOutboundCall), IvrCallError
  from-env.ts                      ivrGatewayFromEnv(env, { mockLog? }): MOCK → MockIvrGateway, DISABLED → null; mockIvrLogLine
packages/ledger/src                @hamro-pasal/ledger (Phase 22, server-only; moved from apps/api, used by API and worker):
  money.ts                         toPaisa, toNpr
  settlement-plan.ts               AccountRef (+ PAYOUT_CLEARING), planPaymentCapture, planSettlement
  ledger-service.ts                LedgerService.post (opens the one PAYOUT_CLEARING account on first use, advisory lock)
  settlement-service.ts            SettlementService, orderSettlementKey ("order-settlement:<order>")
  wallet-service.ts                WalletService (debt suspension / restore, admin overrides) and its errors
apps/api/src                       Express 5 API
  app.ts (createApp) · container.ts (buildContainer / buildContainerFromEnv) · server.ts (HTTP + Socket.io)
  realtime/orders-namespace.ts     attachRealtime: Socket.io /orders (JWT handshake, ownership-checked rooms, Redis adapter)
  auth/access-token.ts             HS256 access tokens (JWT_ACCESS_SECRET, aud hamro-pasal-app, 900 s)
  auth/refresh-token.ts            HS256 refresh tokens (JWT_REFRESH_SECRET, aud hamro-pasal-refresh, typ refresh, jti, 7 d)
  auth/otp-store.ts                OtpStore (Redis keys, keyed digest, atomic Lua check-and-consume), generateOtpCode
  auth/refresh-cookie.ts           Phase 16: REFRESH_COOKIE (hamro_pasal_refresh, /api/auth, 7 d), setRefreshCookie,
                                   clearRefreshCookie (HttpOnly, Secure, SameSite=Strict), readRefreshCookie
  auth/otp-auth-service.ts         OtpAuthService: sendOtp, verifyOtp (fetch-or-create CUSTOMER), refreshAccessToken,
                                   refreshCookieSession (Phase 16, SUPER_ADMIN only)
  catalog/catalog-service.ts       CatalogService (PostGIS feed + menus), VendorNotFoundError, FEED_SECTION_LIMIT
  checkout/{checkout-service,pricing,delivery-otp}.ts
  orders/order-service.ts          OrderService (order detail, cancellation, isCustomerOrder), CancellationWindowExpiredError,
                                   OrderNotCancelableError
  orders/order-events.ts           enqueueOrderStateChanged: the one way every state change reaches the outbox
  orders/vendor-order-service.ts   VendorOrderService (Phase 10: listOpen, accept, reject, vendorIdForUser),
                                   OrderDecisionConflictError, VendorAccountNotFoundError
  config/env.ts · http/{auth,errors,validate}.ts · infra/{pg-errors,redis-mutex,redis-pool}.ts
  inventory/{inventory-lock-service,stock-reader,errors}.ts
  ledger/{ledger-service,money,settlement-plan,settlement-service}.ts
  payments/{gateway-http,payable-order,payment-confirmation}.ts · payments/esewa/* · payments/khalti/*
  routes/{auth,vendors,cart,orders,payments,views}.ts
                                   (SMS: imports @hamro-pasal/sms; buildContainerFromEnv calls smsGatewayFromEnv)
  admin/dead-letter-service.ts     Phase 15: DeadLetterService (list, requestRetry)
  admin/admin-vendor-service.ts    Phase 15: AdminVendorService (list, suspend, restore via WalletService, audit line)
  routes/admin.ts                  Phase 15: /api/admin router (deadLetterView, adminVendorView)
  catalog/category-service.ts      Phase 17: CategoryService (listActive, listAll, create, update, remove; advisory lock)
  catalog/taxonomy-rules.ts        Phase 17: placementProblem (parent exists, no cycle, depth ≤ 3), depthOf, heightOf
  catalog/product-service.ts       Phase 17: ProductService (create, setStock, listForVendor, listPublic, listForAdmin,
                                   setActive), prefixSearchQuery
  routes/catalog.ts                Phase 17: categoriesRouter, productsRouter (public), vendorProductsRouter,
                                   mountAdminCatalog (added to the /api/admin router), the catalog views;
                                   Phase 19: PUT /:id, DELETE /:id, POST /:id/images (multer) on vendorProductsRouter
  uploads/evidence-storage.ts      LocalEvidenceStorage, sniffEvidenceType (JPEG / PNG / WebP by magic bytes)
  uploads/product-image-storage.ts Phase 19: ProductImageStorage (save, remove), LocalProductImageStorage
                                   (<UPLOADS_DIR>/product-images/<product>/<uuid>.<ext>)
  container.ts                     Phase 19: DEFAULT_UPLOADS_DIR = <api root>/uploads; one directory and base URL
                                   for both local storages
  notifications/device-token-service.ts  Phase 20: DeviceTokenService.register (upsert on the token),
                                   DeviceTokenOwnerNotFoundError (→ 401)
  routes/notifications.ts          Phase 20: notificationsRouter (POST /device-token), mounted at /api/notifications
                                   behind requireAuth with no role filter
  deliveries/delivery-service.ts   Phase 21: DeliveryService (list, accept, pickUp, complete, ridersOnTheRoad),
                                   offerDelivery (called by the vendor's dispatch), FLEET_FULFILLMENT_MODES
  deliveries/rider-location-store.ts  Phase 21: RiderLocationStore (GEOADD riders:active + riders:active:seen;
                                   record, latest, remove), riderLocationKeys
  routes/deliveries.ts             Phase 21: deliveriesRouter, mounted at /api/deliveries behind requireAuth(DRIVER)
                                   (orders/driver-order-service.ts and routes/driver-orders.ts are deleted)
  realtime/rider-telemetry.ts      Phase 21: serveRiderTelemetry on /orders (rider:location in, the periodic
                                   order:rider_location push out)
  ledger/*.ts · wallet/wallet-service.ts   Phase 22: one-line re-exports of @hamro-pasal/ledger (the code moved there)
  finance/vendor-finance-service.ts  Phase 22: VendorFinanceService (ledgerView, requestPayout), payoutHoldKey,
                                   PayoutExceedsBalanceError, PayoutKeyReusedError
  finance/admin-payout-service.ts  Phase 22: AdminPayoutService (list, approve, reject), PayoutNotFoundError,
                                   PayoutAlreadyDecidedError, InvalidPayoutCursorError
  routes/vendor-finance.ts         Phase 22: vendorFinanceRouter, mounted at /api/vendor/finance behind requireAuth(VENDOR);
                                   payoutView. The admin routes are in routes/admin.ts (adminPayoutView)
  wallet/vendor-wallet-service.ts  + pendingEscrowOf (shared by the wallet balance and the finance ledger)
apps/api/scripts/mint-dev-token.ts
apps/api/test/e2e-lifecycle.int.test.ts      Phase 23: one order through every role over HTTP, then the manual reconciliation
apps/api/test/inventory-stress.int.test.ts   Phase 23: 100 concurrent POST /api/cart/checkout on 5 units
packages/db/test/foreign-key-indexes.int.test.ts   Phase 23: the index audit as a test (no FK without a leading index)
apps/api/test/                     *.int.test.ts (auth-api, auth-cookie-api, cart-api, checkout-claim, inventory-concurrency, ledger-settlement,
                                   mint-dev-token, orders-api, orders-realtime, payments-api, vendors-api) + global-setup.ts + support/
apps/worker/src                    main.ts, lifecycle.ts, outbox/ (OutboxRelay), queues/, config/, infra/,
                                   consumers/ (buildConsumers + routeByTopic; order-state-fanout.ts: Kafka order.lifecycle →
                                   Redis → /orders rooms; vendor-sla-scheduler.ts: PLACED → 90 s BullMQ timer;
                                   vendor-notifications.ts: Kafka notifications.broadcast → vendor SMS + IVR, Phases 13/14;
                                   dead-letter.ts: withDeadLetter retries + dead_letter_events row + notifications.dlq,
                                   Phases 14/15),
                                   dead-letters/ (Phase 15: dead-letter-store.ts DatabaseDeadLetterStore,
                                   dead-letter-replayer.ts DeadLetterReplayer + replayRecord),
                                   notifications/vendor-sms.ts (SMS templates, Phase 13), vendor-ivr.ts (IVR script,
                                   Phase 14), order-state-reader.ts (stale-order guard's DB read, Phase 14),
                                   sla/vendor-escalation.ts (VendorEscalationService, Phase 10),
                                   Phase 20: consumers/order-push-notifications.ts (Kafka order.lifecycle → Expo push,
                                   smsFallbackLogFromEnv), push/expo-push.ts (ExpoPushGateway: fetch to exp.host,
                                   batches of 100, tickets), notifications/order-push.ts (orderPushes: who is told
                                   what, expoMessages: data-only vs visible), notifications/push-recipients.ts
                                   (DatabasePushRecipients: tokens + phone of a customer / vendor, remove)
                                   Phase 22: finance/order-reconciliation.ts (OrderReconciliationService,
                                   vendorWalletPaisa), scripts/reconcile-orders.ts (manual run),
                                   queues/processors.ts (+ runOrderReconciliation, auditReconciliationDiscrepancy)
apps/worker/test/                  outbox-relay, queues, order-state-fanout, vendor-sla, vendor-debt-reconciliation,
                                   vendor-notifications, dead-letter-replayer, order-push, order-reconciliation (*.int.test.ts)
```

### Admin web workspace (`apps/admin`, `@hamro-pasal/admin`, Phase 15)

```
package.json              Vite 8 + @vitejs/plugin-react 6, React 19.2.3, TanStack Query 5, Zustand 5, zod, shared-types
vite.config.ts            dev server :5173, proxies /api to ADMIN_API_PROXY_TARGET (default http://127.0.0.1:4000);
                          optimizeDeps.include shared-types (a CommonJS workspace package)
jest.config.cjs           Jest 29 + ts-jest (transpile only, node env); type checking is `tsc --noEmit`
index.html · src/main.tsx QueryClient, in-memory session store, same-origin API client, cache cleared on sign-out
                          (or when a refresh answers for another admin)
src/App.tsx               useSessionRestore (silent refresh on load, "Restoring your session…"), shell: tabs
                          "Dead letters" (#/dlq) / "Vendors" (#/vendors), phone + Sign out (POST /api/auth/logout)
src/app-context.tsx       AdminProvider, useAdminApi, useSession, retryTransientFailures
src/api/client.ts         createApiClient: Zod-validated bodies, ApiError, credentials same-origin, single-flight cookie
                          refresh (POST /api/auth/refresh) on 401 UNAUTHENTICATED, restoreSession
src/api/admin-api.ts      createAdminApi: sendOtp, verifyOtp, restoreSession, logout, listDeadLetters, retryDeadLetter,
                          listVendors, overrideVendor
src/auth/session-store.ts createSessionStore (zustand/vanilla, memory only: phone, user, access token; no refresh token)
src/features/auth/        LoginScreen.tsx (+977 number → 6-digit code, SUPER_ADMIN only), login-rules.ts
src/features/dlq/         DeadLetterScreen.tsx (filters, cards, Retry, Load older, 3 s poll while a retry is queued),
                          dead-letter-rules.ts
src/features/vendors/     VendorScreen.tsx (search, table, two-step Suspend / Restore), vendor-rules.ts
src/tabs.ts               Phase 17: TABS (dlq, vendors, categories, products), tabFromHash
src/features/categories/  Phase 17: CategoryScreen.tsx (tree list, native <dialog> modal to create / edit, two-step
                          Delete), category-rules.ts (form validation with the API schema, parentOptions, slug autofill)
src/features/products/    Phase 17: ProductScreen.tsx (vendor filter, table, Hide / Show, Load more), product-rules.ts
src/features/vendor-portal/  Phase 19 (VENDOR accounts): VendorProductScreen.tsx (own catalogue: stock per row,
                          two-step Hide / Show, Edit modal with details, category and photo upload),
                          vendor-product-rules.ts (form → PUT body with the API schema, parseStock, uploadProblem,
                          categoryOptions / categoryLabel, error messages)
src/features/auth/login-rules.ts  + portalOf (SUPER_ADMIN → dashboard, VENDOR → Vendor Portal, others refused)
src/tabs.ts               Phase 22: + 'payouts' (dashboard); VENDOR_TABS (my-products, earnings), vendorTabFromHash
src/features/finance/     Phase 22 (SUPER_ADMIN): PayoutScreen.tsx (status chips, cards, Approve with a bank
                          reference, Reject with an optional reason, Load older), payout-rules.ts (input
                          checks with the API schemas, error messages, replacePayout; also used by the vendor tab)
src/features/vendor-portal/VendorEarningsScreen.tsx  Phase 22 (VENDOR): balances, "Request payout", payout
                          requests, reconciled orders
src/lib/format.ts         formatNpr (lakh grouping), formatDateTime (Asia/Kathmandu)
src/styles.css            light/dark tokens, no CSS framework
```

### Mobile workspace (`apps/mobile`, `@hamro-pasal/mobile`)

```
app.json                  scheme hamropasal; plugins: expo-router, expo-secure-store,
                          expo-location (when-in-use text), expo-image-picker (photos only)
babel.config.js · metro.config.js · tailwind.config.js · global.css · nativewind-env.d.ts   NativeWind 4 wiring
jest.config.js · jest.setup.ts · jest.setup-after-env.ts                                     test infrastructure (§9.12)
.env                      EXPO_PUBLIC_API_URL only (must be the host's LAN IP, e.g. http://192.168.1.20:4000)

app/_layout.tsx           root: QueryClientProvider > I18nextProvider > SessionExpiryHandler, Stack, ReplaceCartModal,
                          CheckoutSessionWatcher, ReviewPrompt, ToastHost, TerritoryGate (last = topmost)
app/login.tsx             OTP step 1: +977 number → POST /api/auth/otp/send, then replaces itself with /verify-otp
app/verify-otp.tsx        OTP step 2: 6-digit code → POST /api/auth/otp/verify, resend countdown, change number
app/(tabs)/_layout.tsx    Tabs: Shops / Cart (badge = item count) / Profile
app/(tabs)/index.tsx      feed (GET /api/vendors); sign-in prompt when signed out
app/(tabs)/cart.tsx       cart, address, checkout, payment; "Sign in to Checkout" when signed out
app/(tabs)/profile.tsx    account (sign in / sign out) + language + __DEV__ token sign-in + __DEV__ territory simulator
app/vendor/[id].tsx       vendor menu (GET /api/vendors/:id/products)
app/order/[id]/index.tsx  order tracking (GET /api/orders/:id once + Socket.io /orders live updates), 60 s cancel, OTP, dispute button
app/order/[id]/dispute.tsx  dispute chat (Socket.io /chat scaffold)
app/(vendor)/_layout.tsx    Phase 10: vendor-only group (non-vendors are redirected to /)
app/(vendor)/dashboard.tsx  Phase 10: incoming orders, Accept / Reject, looping expo-audio alarm
assets/sounds/vendor-alarm.wav   1.2 s two-tone alarm loop (generated, 22.05 kHz mono PCM, 53 KB)

src/api/        http.ts (apiRequest with token renewal, refreshAccessToken, onSessionExpired, ApiError)
                auth.ts (sendOtp, verifyOtp, useSendOtp, useVerifyOtp, useSignOut, AUTH_ERROR_CODES) · mutations.ts (useCheckout, NO_DELIVERY_ADDRESS) · queries.ts (useLockStatus)
                catalog.ts (fetchFeed, fetchVendorMenu, VENDOR_NOT_FOUND) · orders.ts (fetchOrder, cancelOrder,
                CANCELLATION_WINDOW_EXPIRED) · payments.ts (eSewa/Khalti calls)
                query-client.ts (createQueryClient, retryTransientFailures)
src/services/   socket.ts (createAuthenticatedSocket: shared token lifecycle; createOrdersSocket, createChatSocket)
src/store/      useAuthStore · useCartStore · useCheckoutStore · useOrderStore · useDeliveryOtpStore
                useAddressStore · useReviewStore · useToastStore
src/storage/    app-mmkv.ts (plain) · secure-mmkv.ts (AES-256) · encryption-key.ts · mmkv-state-storage.ts
src/features/   address/ auth/ cart/ checkout/ dispute/ feed/ location/ menu/ order/ payment/ review/ territory/ vendor/
                (location/customer-location.ts: useCustomerLocation, THAMEL_FALLBACK_LOCATION;
                auth/login-form.ts: toNepalPhone, sanitizeOtpInput, leaveSignIn; auth/useSessionExpiryHandler.ts)
src/components/ Button, VendorCard, ReplaceCartModal, PaymentWebViewModal, AddressFormModal, ReviewModal, Toast
src/i18n/       i18n.ts (createI18n, bindLocale, `localizedNumber` formatter) · format-number.ts · locales/{en,ne}.json
src/config/     api.ts (API_URL, throws at startup if EXPO_PUBLIC_API_URL is missing) · parse-api-url.ts
src/lib/        money.ts (paisa) · countdown.ts · useBeforeDeadline.ts · useDebouncedValue.ts (Phase 18)
Phase 18:       src/api/catalog.ts (+ fetchCategories, fetchProducts, CATEGORY_NOT_FOUND; both public)
                src/features/discovery/ (discovery-rules.ts, useCategoriesQuery.ts, useProductSearch.ts,
                CategoryPills.tsx, ProductCard.tsx, ProductResults.tsx)
                src/features/feed/ShopsFeed.tsx (the vendor feed, moved out of app/(tabs)/index.tsx)
                src/features/cart/stock-shortfalls.ts (stockLevelsFromDetails)
Phase 19:       app/vendor/[id].tsx passes the menu's stock_quantity to the cart (availableStock)
Phase 20:       index.ts (the app entry, package.json "main": registers the push task, then loads expo-router/entry)
                src/api/notifications.ts (registerDeviceToken)
                src/features/notifications/ (push-registration.ts: permission → token → API;
                usePushRegistration.ts; notification-handler.ts: foreground banners + Android channel;
                order-push-task.ts + register-order-push-task.ts: data-only pushes → local notification;
                PushNotifications.tsx, mounted in app/_layout.tsx)
                app.json plugin expo-notifications (defaultChannel orders, enableBackgroundRemoteNotifications)
Phase 21:       src/api/deliveries.ts (fetchDeliveries, advanceDelivery, completeDelivery; driver-orders.ts deleted)
                src/features/driver/ (useDeliveries.ts, DeliveryCard.tsx, rider-gps-simulator.ts,
                RiderGpsSimulator.tsx, RiderModeEntry.tsx; useDriverOrders.ts and DriverOrderCard.tsx deleted)
src/test/       msw.ts · api-fixtures.ts (+ menuProduct) · render.tsx · in-memory-mmkv.ts · mock-webview.tsx · fake-socket.ts
                · fake-notifications.ts (Phase 20: expo-notifications + expo-task-manager stand-in)
```

## 3. Local environment

- Ports (127.0.0.1 only): Postgres `5432`, Redis `6379`, Kafka `9092` (host) / `kafka:29092`
  (containers), Prometheus `9090`, API `4000`.
- Use `KAFKA_BROKERS=127.0.0.1:9092`, not `localhost`: on Windows/macOS `localhost` resolves to `::1`
  first and librdkafka stalls about 2 s per connection.
- Topics: `order.lifecycle` (4), `payment.reconciliation` (4), `ledger.mutations` (4),
  `notifications.broadcast` (2), `notifications.dlq` (2, Phase 14). Auto-create is disabled. A broker
  created before Phase 14 lacks the DLQ topic: run `pnpm infra:up` (or `docker compose run --rm
kafka-init`) once, or dead-lettering fails and the message is redelivered instead.
- Root `.env` passes `parseServerEnv`. Never print or commit `.env` values. The API has still not
  been started live against a device. **The dev `.env` has `SMS_PROVIDER=SPARROW`**: signing in sends
  a real, billed SMS. For local work set `SMS_PROVIDER=MOCK`; the API then prints
  `[sms:mock] to +977…: Hamro Pasal: your login code is 123456…` to its console.
- **Full local run without any third party (Phase 24):** set `MOCK_SERVICES=true` in the root `.env`
  (it overrides `SMS_PROVIDER=SPARROW`, so no SMS is billed), then follow the run order in §8Q.
- **Running the app against the API:** `pnpm infra:up`, `pnpm db:migrate`, `pnpm db:seed`,
  `pnpm --filter @hamro-pasal/api dev`, then sign in from the Profile tab (or the Feed/Cart prompts)
  with a seeded number, e.g. 9800000001 (Aarav), and the code from the API log. An unknown number
  becomes a new CUSTOMER. The `__DEV__` token paste (`token:dev`) still works for quick checks, but
  it holds no refresh token, so it lapses after 15 min.
- **Admin dashboard (Phase 15):** with the API running, `pnpm --filter @hamro-pasal/admin dev` serves
  http://localhost:5173 and proxies `/api` to `ADMIN_API_PROXY_TARGET` (default
  `http://127.0.0.1:4000`; set it if the API runs on another port). Sign in with the seeded Super
  Admin **9800000099** and the code from the API log (`SMS_PROVIDER=MOCK`). Any other role is refused
  on the sign-in screen (and gets 403 from every `/api/admin` route). Retries need the **worker**
  running (`pnpm --filter @hamro-pasal/worker dev`): the API only queues them. Reloading the page
  keeps the admin signed in (Phase 16: the HttpOnly refresh cookie; Chrome, Edge and Firefox accept
  its `Secure` flag on `http://localhost`, so open the dev server as `localhost`, not by LAN IP).
  `vite build` writes `apps/admin/dist` (static files; the
  `/api` path must reach the API on the same origin in production).
- **Uploads directory (Phase 19):** files the API stores (product photos, dispute evidence) go to
  `UPLOADS_DIR`, default **`apps/api/uploads`** (resolved from the API's own location, so it is the
  same for `tsx` and for `dist/`; git-ignored; created on the first upload). It was
  `os.tmpdir()/uploads` before Phase 19; files left there are no longer served. The API serves the
  directory at `/uploads` and writes `UPLOADS_PUBLIC_BASE_URL` (default
  `http://localhost:<API_PORT>/uploads`) into the stored URLs: **absolute URLs are saved in
  Postgres**, so set the LAN address before uploading anything a phone must load, and expect URLs
  saved earlier to keep the old host.
- **Push notifications (Phase 20):** the worker sends through Expo's public push API and needs no
  key (`EXPO_ACCESS_TOKEN` only if the Expo project enforces "enhanced push security"). Locally,
  with no device registered, the worker makes **no request to exp.host**; set `SMS_PROVIDER=MOCK`
  to see, for every order state change, `[sms:mock] to +977…: Hamro Pasal: <title>. <body>` in the
  worker log (and `{"notification":"push.sent",…}` / `"push.failed"` once a device is
  registered). **A real push needs a development build on a physical device** (emulators without
  Play services and iOS simulators get no token), the EAS project in `app.json`
  (`extra.eas.projectId`), and **FCM V1 credentials (Android) / an APNs key (iOS) uploaded to that
  EAS project**, plus `google-services.json` for the Android build. None of that is in the
  repository. `expo-notifications` and `expo-task-manager` are native: rebuild the dev client
  (`npx expo prebuild` + `expo run:android`) after pulling Phase 20.
- **Vendor Portal (Phase 19):** the same web app (`pnpm --filter @hamro-pasal/admin dev`,
  http://localhost:5173). Sign in with a **vendor** number, e.g. **9800000011** (Thamel Kirana
  Pasal) and the code from the API log (`SMS_PROVIDER=MOCK`): the app opens "My products" instead
  of the admin tabs. A vendor's tokens are held in memory only, so **reloading the page signs a
  vendor out** (the HttpOnly cookie session is for Super Admins, §8J). Photos load straight from
  the API's `/uploads` (not through the Vite proxy).
- **Admin dev server and `shared-types` (Phase 17):** Vite pre-bundles `@hamro-pasal/shared-types` and
  does not notice when the package is rebuilt, so a stale bundle lacks new schemas and a screen
  shows "… could not be loaded" although the API answers 200 (seen in the Phase 17 live run). The
  `dev` script is therefore **`vite --force`** (rebuilds the dependency cache on every start, ~0.4 s).
  After `pnpm build` of a package, restart the admin dev server.
- **Mobile → API:** `apps/mobile/.env` holds only `EXPO_PUBLIC_API_URL`. A device or emulator cannot
  reach the host's `127.0.0.1`. Expo inlines only `EXPO_PUBLIC_*` values into the bundle.
- The mobile app needs a **development build** (`npx expo prebuild` + `expo run:android`, or EAS),
  not Expo Go: MMKV v4 (Nitro), Reanimated 4, SecureStore, WebView, Location and Image Picker are native.
- Integration tests use isolated resources: DBs `hamro_pasal_test` (db), `hamro_pasal_api_test`,
  `hamro_pasal_worker_test`, dropped and recreated per run; Redis logical DB 15 (api) and 14 (worker).
  Suites share one database per package, so assertions must filter by the ids they created
  (`vendors-api` also places its vendors around Pokhara, ~140 km from every other suite's Kathmandu
  vendors).
- Dev seed (`pnpm db:seed`, idempotent, creates no orders). **All ids are random database UUIDs**:

  | Phone          | Role        | Notes                                                                                                                                                                                                                                 |
  | -------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | +9779800000001 | CUSTOMER    | Aarav, address Thamel (Kathmandu MC, ward 26)                                                                                                                                                                                         |
  | +9779800000002 | CUSTOMER    | Sita, address Pulchowk (Lalitpur MC, ward 16)                                                                                                                                                                                         |
  | +9779800000011 | VENDOR      | Thamel Kirana Pasal: LIVE, COMMISSION 10%, RADIUS_BOUND 5 km, SELF_DELIVERY, MOV 500, fee 50. Products: Wai Wai Noodles (pack of 30) 600, Basmati Rice 5kg 1150, Ilam Tea 500g 450, Masoor Dal 1kg 220, DDC Ghee 500ml 750 (Phase 24) |
  | +9779800000012 | VENDOR      | Patan Organic Store: LIVE, SUBSCRIPTION 0%, CITY_WIDE (Lalitpur MC), PLATFORM_FLEET. Products: Organic Rayo ko Saag (bunch) 60, Local Honey 500g 900                                                                                  |
  | +9779800000013 | VENDOR      | Bhaktapur Juju Dhau Bhandar: APPROVED (not LIVE), NATION_WIDE. Product: Juju Dhau (clay pot) 250                                                                                                                                      |
  | +9779800000021 | DRIVER      | Bikash                                                                                                                                                                                                                                |
  | +9779800000099 | SUPER_ADMIN |                                                                                                                                                                                                                                       |

- **Seeded taxonomy (Phase 17):** `pnpm db:seed` also ensures (idempotently, by slug, on an already
  seeded database too) the root **Groceries** with six subcategories (`rice-flour-pulses`,
  `noodles-snacks`, `tea-coffee`, `dairy`, `fresh-vegetables`, `honey-spreads`) and maps each seeded
  product that has no category yet. Every seeded product has `unit = 'piece'` (the column default).

## 4. Data layer (`packages/db`)

### Migrations (apply with `pnpm db:migrate`; drift check `cd packages/db && npx drizzle-kit generate` → "No schema changes")

| File                                         | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0000_extensions.sql`                        | `CREATE EXTENSION IF NOT EXISTS postgis` (custom)                                                                                                                                                                                                                                                                                                                                                                                                      |
| `0001_core_schema.sql`                       | enums, users, customer_addresses, vendors, products, orders, order_items, (old) wallet_ledgers, platform_settings, disputes, reviews                                                                                                                                                                                                                                                                                                                   |
| `0002_wallet_invariant_and_triggers.sql`     | `set_updated_at` triggers, platform_settings seed (-2000), `enforce_vendor_wallet_limit` (auto-suspend + `pg_notify('vendor_wallet_suspended', …)`)                                                                                                                                                                                                                                                                                                    |
| `0003_rename_vendor_city_to_palika.sql`      | `vendors.city_string` → `municipality_palika_string` (custom RENAME; `meta/0003_snapshot.json` hand-patched)                                                                                                                                                                                                                                                                                                                                           |
| `0004_drop_single_entry_wallet_ledger.sql`   | drops wallet_ledgers (aborts if it holds rows)                                                                                                                                                                                                                                                                                                                                                                                                         |
| `0005_double_entry_ledger_and_outbox.sql`    | ledger_accounts, ledger_transactions, ledger_entries, outbox_events, orders.driver_user_id                                                                                                                                                                                                                                                                                                                                                             |
| `0006_ledger_integrity_triggers.sql`         | balanced-journal deferred constraint triggers, posting application, projection guards, append-only, seeded system accounts                                                                                                                                                                                                                                                                                                                             |
| `0007_checkout_order_links.sql`              | orders.reservation_id (unique), vendors.fulfillment_mode (backfilled SELF_DELIVERY, default dropped)                                                                                                                                                                                                                                                                                                                                                   |
| `0008_order_addresses_and_refunds.sql`       | **Phase 6.** `order_addresses` table; `orders.refund_required` + `orders_refund_required_paid_check`                                                                                                                                                                                                                                                                                                                                                   |
| `0009_orders_placed_at.sql`                  | **Phase 6.** `orders.placed_at`, hand-added backfill (`placed_at = created_at` for already-placed rows), `orders_placed_at_check`                                                                                                                                                                                                                                                                                                                      |
| `0010_users_first_name_optional.sql`         | **Phase 7.** `users.first_name` nullable (OTP sign-up knows only the phone); `users_first_name_check` still rejects a blank name                                                                                                                                                                                                                                                                                                                       |
| `0011_chat_messages.sql`                     | **Phase 9.5.** `chat_messages` table (dispute transcript): FKs to `disputes` and `users`, dedupe key, length/attachment/non-empty CHECKs, index                                                                                                                                                                                                                                                                                                        |
| `0012_vendor_escalation_index.sql`           | **Phase 10.** Partial unique index `outbox_events_vendor_escalation_uidx` on `aggregate_id` WHERE `event_type = 'vendor.escalation.required'`                                                                                                                                                                                                                                                                                                          |
| `0013_delivery_otp_nullable.sql`             | **Phase 11.** `orders.delivery_otp` nullable (erased at delivery); `orders_delivery_otp_present_check`: null only in DELIVERED / DISPUTED                                                                                                                                                                                                                                                                                                              |
| `0014_vendor_debt_suspension.sql`            | **Phase 12.5.** `vendors.status_before_debt_suspension` (vendor_status, nullable) + `vendors_debt_suspension_check`: set only while SUSPENDED, never SUSPENDED itself. **The wallet trigger is not dropped**                                                                                                                                                                                                                                           |
| `0015_dead_letters_and_admin_suspension.sql` | **Phase 15.** `dead_letter_status` enum, `dead_letter_events` table (unique source index, status/retry CHECK, list + replay-queue indexes, FK `retry_requested_by` → users); `vendors.status_before_admin_suspension` + `vendors_admin_suspension_check` (only while SUSPENDED, never with the debt column)                                                                                                                                            |
| `0016_catalog_taxonomy.sql`                  | **Phase 17.** `categories` table (unique slug, slug / name / order CHECKs, self-parent CHECK, RESTRICT parent FK, `(parent_id, display_order)` index, hand-added `set_updated_at` trigger); `products` + `category_id` (RESTRICT FK), `description`, `unit` (default `piece`), `image_urls text[]`, `metadata jsonb` with CHECKs; `products_vendor_id_idx` replaced by `(vendor_id, is_active)`; `(category_id, is_active)`; GIN `products_search_idx` |

| `0017_device_tokens.sql` | **Phase 20.** `device_tokens` table (FK `user_id` → users CASCADE, unique `token`, `user_id` index, token-format + length CHECK, platform CHECK, hand-added `set_updated_at` trigger) |
| `0018_deliveries.sql` | **Phase 21.** `delivery_state` enum, `deliveries` table (FK `order_id` → orders CASCADE, unique per order; FK `rider_id` → users RESTRICT; five CHECKs tying rider and timestamps to the state; `(rider_id, state)` and `(state)` indexes; hand-added `set_updated_at` trigger) and a **hand-added backfill**: every fleet order already OUT_FOR_DELIVERY gets an OFFERED row |
| `0019_reconciliation_and_payouts.sql` | **Phase 22.** `payout_status` enum; `ledger_account_type` + `PAYOUT_CLEARING`; `ledger_transaction_kind` + `VENDOR_PAYOUT`, `VENDOR_PAYOUT_REVERSAL` (**added, not used in the file**: PostgreSQL cannot use a new value of an existing enum before commit, and Drizzle runs every pending migration in one transaction); `payout_requests` table (FKs to vendors, users and twice to ledger_transactions, all RESTRICT; unique `(vendor_id, idempotency_key)` and `hold_transaction_id`; amount, key and status CHECKs; three indexes; hand-added `set_updated_at` trigger); `orders.reconciled_at` + `orders_reconciled_at_check` + the partial index `orders_unreconciled_idx` and `orders_vendor_id_reconciled_at_idx` |
| `0020_audit_indexes.sql` | **Phase 23.** Seven `CREATE INDEX` statements, one per foreign key that had no index led by its column: `orders_driver_user_id_idx`, `disputes_opened_by_user_id_idx`, `disputes_resolved_by_user_id_idx`, `chat_messages_sender_user_id_idx`, `payout_requests_reversal_transaction_id_idx`, `payout_requests_decided_by_user_id_idx`, `dead_letter_events_retry_requested_by_idx`. The five on usually-NULL columns are **partial** (`WHERE … IS NOT NULL`). No table, column or constraint change; generated by drizzle-kit, renamed, header comment added |

**Staging rule:** drizzle-kit prompts interactively on renames, which fails in this non-TTY
environment. Stage schema edits so a single `generate` only adds or only drops. Hand-write renames
as `--custom` migrations with a patched snapshot. Generated files get random names: rename the
`.sql` file **and** its `tag` in `meta/_journal.json`, and add a header comment. Data backfills are
hand-inserted between the generated statements (0009 does this).

### Tables and key invariants

- `users(phone UNIQUE CHECK ~ '^\+9779[0-9]{9}$', role, first_name?, last_name?)`. `first_name` is null for
  customers created by OTP sign-up until they add a name (Phase 7); a present name is non-blank.
- `customer_addresses`: Nepal hierarchy + `exact_lat/exact_lng` (double) + generated `location`
  `ST_SetSRID(ST_MakePoint(exact_lng, exact_lat), 4326)` with GiST. Province 1–7, ward ≥ 1.
  **No route writes it yet** (saved-address CRUD is not built; the app keeps the address locally).
- `vendors`: SPEC Vendor fields + `user_id`, `business_name`, `base_delivery_fee_npr`,
  `scheduled_downgrade`, `fulfillment_mode` ∈ {SELF_DELIVERY, PLATFORM_FLEET}. `pricing_model` is
  nullable until LIVE; SUBSCRIPTION ⇒ commission 0 (CHECKs). `location geometry(Point,4326)` with two
  GiST indexes (geometry, and `(location::geography)` for metre-accurate `ST_DWithin`). Wallet floor
  `CHECK (wallet_balance_npr >= -2000 OR status = 'SUSPENDED')` + trigger `enforce_vendor_wallet_limit`
  (suspends strictly below `platform_settings.vendor_wallet_suspension_limit_npr`, configurable in
  [-2000, 0]); **kept in Phase 12.5** as the safety net under the application-layer `WalletService`,
  §8F). `wallet_balance_npr` is a **projection**: only ledger postings may change it.
  `status_before_debt_suspension` (Phase 12.5): the status a debt suspension restores; null unless
  the vendor is SUSPENDED for debt (an admin suspension leaves it null and is never auto-lifted).
- **`categories`** (Phase 17, migration 0016): `id`, `name` (non-blank), `slug` (`UNIQUE`,
  `^[a-z0-9]+(-[a-z0-9]+)*$`), `parent_id` → categories (**RESTRICT**, null = root), `icon_url?`,
  `display_order` ≥ 0 (default 0), `is_active` (default true), `created_at`, `updated_at` (trigger).
  CHECK `parent_id IS DISTINCT FROM id`; index `(parent_id, display_order)`. Cycles and the 3-level
  limit are **not** database constraints: `CategoryService` enforces them under an advisory lock
  (§8K). Zod: `categorySchema`, in the compile-time contract and `contract.int.test.ts`.
- `products(vendor_id, name UNIQUE per vendor, price_npr > 0, stock_quantity >= 0, is_active)` plus,
  since Phase 17: `category_id` → categories (**RESTRICT**, nullable: null only for rows older than
  the migration; the API requires it for new products), `description?` (non-blank), `unit` (default
  `'piece'`), `image_urls text[]` (≤ 8, default `{}`), `metadata jsonb` (an object, default `{}`).
  SPEC's `price` is the existing `price_npr`. Indexes: `(vendor_id, is_active)` (replaces
  `products_vendor_id_idx`), `(category_id, is_active)`, and **`products_search_idx`**: GIN on
  `to_tsvector('simple', name || ' ' || coalesce(description, ''))`. A query must filter on exactly
  that expression (`productSearchDocument` in `packages/db/src/schema/vendors.ts`) to use it.
  **`stock_quantity` is the one stock number**: vendors set it, checkout reads and decrements it.
- `orders`: SPEC OrderSnapshot + `idempotency_key UNIQUE`, `reservation_id UNIQUE`, `driver_user_id`,
  `payment_gateway_ref` (UNIQUE per method, NULL for COD), bcrypt-only `delivery_otp`, and:
  - **`placed_at`** (Phase 6): stamped with `now()` in `CheckoutService.claim()`, the only code path
    that sets PLACED (COD at checkout, eSewa webhook, Khalti lookup all go through it).
    `orders_placed_at_check`: `PENDING_PAYMENT ⇒ NULL`, `FAILED ⇒ either` (paid-after-expiry never
    placed; a failed delivery was), every other state ⇒ NOT NULL. **Tests that force an order past
    PLACED by hand must also set `placed_at`** (`markDelivered` does, via `coalesce`).
  - **`refund_required`** (Phase 6), default false; `orders_refund_required_paid_check` allows true
    only when `payment_status = 'PAID'`.
  - `delivered_at` (set by nothing yet; tests set it). A fleet order can't be DELIVERED without a
    driver (CHECK).
- **`order_addresses`** (Phase 6): `order_id` PK/FK (cascade) + the Nepal hierarchy + pin + generated
  `location` Point(4326) with GiST, same CHECKs as `customer_addresses`, no `updated_at` (immutable
  per-order copy). Written by checkout inside the order transaction.
- `order_items(order_id, product_id UNIQUE together, product_name + unit_price_npr snapshot)`.
- Ledger: `ledger_accounts` (SYSTEM_ESCROW, PLATFORM_REVENUE, GATEWAY_CLEARING ESEWA/KHALTI,
  VENDOR_WALLET auto-created per vendor, DRIVER_WALLET lazily), `ledger_transactions(kind,
idempotency_key UNIQUE, order_id?)`, `ledger_entries(amount_npr <> 0)`. Journals balance to 0 at
  COMMIT (deferred triggers), need ≥ 2 postings, can only be posted in the creating transaction, and
  are append-only. Escrow balance ≥ 0.
- `reviews(order_id, direction CUSTOMER_TO_VENDOR|VENDOR_TO_CUSTOMER, rating 1–5, comment?,
is_published DEFAULT false, published_at, one per direction per order)`. Written by
  `POST /api/reviews` (customer, Phase 9) and `POST /api/vendors/orders/:id/reviews` (vendor, Phase
  9.5), both through `ReviewService.submit` (§8C).
- `disputes(order_id UNIQUE, opened_by_user_id, reason non-blank, status OPEN|REFUNDED_TO_CUSTOMER|RELEASED_TO_VENDOR,
resolved_by_user_id?, resolved_at?)`, `disputes_resolution_check`: OPEN ⇔ no resolver and no
  resolved_at. **Created by the order's first `/chat` message** (Phase 9.5; `reason` = that message,
  or "Photo evidence submitted" for a photo-only one). Nothing resolves a dispute yet.
- **`chat_messages`** (Phase 9.5, migration 0011): `id`, `dispute_id` → disputes (restrict),
  `sender_user_id` → users (restrict), `client_id` (1–100 chars), `body` (≤ 2000), `attachments jsonb`
  (array of `{url, content_type}`, ≤ 4), `created_at` (= the broadcast `sent_at`). `UNIQUE (dispute_id,
sender_user_id, client_id)` dedupes retried sends; `chat_messages_not_empty_check` requires text or
  an image; index `(dispute_id, created_at)` for transcript reads. Holds no names or phones (only the
  sender's id). Append-only by convention (no code updates or deletes rows; no trigger enforces it).
  Zod: `chatMessageRowSchema` (`shared-types/domain/entities.ts`), asserted in `contract.ts` and
  parsed in `test/contract.int.test.ts`.
- **`dead_letter_events`** (Phase 15, migration 0015): one row per dead-lettered message:
  `consumer`, `source_topic`, `source_partition`, `source_offset` (text, digits only),
  `dead_letter_topic`, `message_key` / `message_value` (**bytea**, byte for byte; custom `bytea` column in
  `schema/columns.ts`), `headers jsonb` (the message's own string headers, no `dlq_*`), `event_id` /
  `event_type` (from the headers; null for a poison pill), `attempts` ≥ 1, `error_name`, `error_message`
  (≤ 2000), `failed_at`, `status` PENDING | RETRY_REQUESTED | REPLAYED, `retry_requested_at` /
  `retry_requested_by` (→ users), `replayed_at`, `replay_attempts`, `last_replay_error`, `replay_of_id`
  (the row a failed retry came from). `UNIQUE (consumer, source_topic, source_partition, source_offset)`
  makes the worker's insert idempotent; `dead_letter_events_status_check` ties the timestamps to the
  status. Not in the Zod entity contract (like `outbox_events`): the API view is
  `deadLetterViewSchema` (§8I).
- **`device_tokens`** (Phase 20, migration 0017): `id`, `user_id` → users (**CASCADE**), `token`
  (**UNIQUE**; CHECK `~ '^Expo(nent)?PushToken\[.+\]$'` and ≤ 255 chars, the shared
  `EXPO_PUSH_TOKEN_PATTERN`), `platform` (text, CHECK `ANDROID | IOS`), `created_at`, `updated_at`
  (trigger; also set by every re-registration). Index `(user_id)`. One row per app installation:
  the token is the key, so a phone has one owner at a time and an account may have many phones.
  A vendor is reached through `vendors.user_id`. Not in the Zod entity contract (like
  `outbox_events`); the API contract is `api/notifications.ts`.
- **`deliveries`** (Phase 21, migration 0018): `id`, `order_id` → orders (**CASCADE**, **UNIQUE**: one
  delivery per order), `rider_id` → users (RESTRICT, null only while OFFERED), `state`
  `delivery_state` (OFFERED | ASSIGNED | PICKED_UP | DELIVERED | FAILED, default OFFERED),
  `accepted_at`, `picked_up_at`, `completed_at`, `created_at`, `updated_at` (trigger). CHECKs:
  `deliveries_rider_check` and `deliveries_accepted_at_check` (OFFERED ⇔ no rider ⇔ no
  `accepted_at`), `deliveries_picked_up_at_check` (none before PICKED_UP),
  `deliveries_completed_at_check` (set ⇔ DELIVERED or FAILED),
  `deliveries_delivered_picked_up_check` (a DELIVERED row was picked up). Indexes
  `(rider_id, state)`, `(state)`. **No code column**: the doorstep code is `orders.delivery_otp`.
  Only fleet orders have a row (SELF_DELIVERY orders never do); fleet orders delivered before
  Phase 21 have none. `orders.driver_user_id` is now set at **accept** (it was set at delivery).
  Not in the Zod entity contract (like `device_tokens`); the API contract is `deliveryViewSchema`.
- **`payout_requests`** (Phase 22, migration 0019): `id`, `vendor_id` → vendors (RESTRICT),
  `amount_npr` (> 0), `status` `payout_status` (PENDING | APPROVED | REJECTED, default PENDING),
  `idempotency_key` (**UNIQUE per vendor**), `hold_transaction_id` → ledger_transactions (NOT NULL,
  UNIQUE: the VENDOR_PAYOUT journal that took the amount out of the wallet),
  `reversal_transaction_id` → ledger_transactions (the VENDOR_PAYOUT_REVERSAL of a rejection),
  `bank_reference`, `rejection_reason`, `decided_by_user_id` → users, `decided_at`, `created_at`,
  `updated_at` (trigger). `payout_requests_status_check`: PENDING ⇔ nothing decided; APPROVED ⇒
  `decided_at`, `decided_by_user_id` and a non-blank `bank_reference`, no reversal; REJECTED ⇒
  `decided_at`, `decided_by_user_id` and a reversal journal, no bank reference. Indexes
  `(vendor_id, created_at)`, `(created_at, id)`, `(status, created_at, id)`. **It stores no balance.**
  Not in the Zod entity contract (like `deliveries`); the API contracts are in `api/finance.ts`.
- **`orders.reconciled_at`** (Phase 22): stamped by the worker's nightly reconciliation; null until
  then. CHECK `orders_reconciled_at_check`: only a DELIVERED or DISPUTED order can carry it. In the
  Zod entity (`orderSchema`) and the compile-time contract. SPEC's `OrderState` has no RECONCILED,
  so it is a column, not a state.
- **`PAYOUT_CLEARING`** (Phase 22): a seventh ledger account type with **one** account and no owner
  column. It is not seeded by a migration (see 0019): `LedgerService` inserts it the first time a
  journal names it, under `pg_advisory_xact_lock(2200022)`. No unique index enforces the singleton.
  Its balance = every payout requested and not rejected (pending + approved).
- **`vendors.status_before_admin_suspension`** (Phase 15): the status an admin Restore returns to; set
  only while SUSPENDED by an admin, never together with `status_before_debt_suspension` (CHECK). In the
  Zod entity (`vendorSchema`) and the compile-time contract.
- Money is `numeric(12,2)` read as JS `number`. Services compute in integer paisa
  (`apps/api/src/ledger/money.ts`). The mobile app does the same (`src/lib/money.ts`).

### Schema ↔ Zod contract

`packages/db/src/schema/contract.ts` asserts at **compile time** that every table's `$inferSelect`
equals the strict Zod type in `shared-types/src/domain/entities.ts` (now including
`orderAddresses ↔ OrderAddress`); `test/contract.int.test.ts` parses real rows at runtime. A column
change must update both sides or `tsc` fails. `test/postgis.int.test.ts` lists every geometry
column; a new one must be added there.

### Custom PostGIS geometry

`packages/db/src/schema/columns.ts#geoPoint` writes EWKT `SRID=4326;POINT(lng lat)` and reads hex
EWKB (`geo/ewkb.ts`), because Drizzle 0.45's built-in `geometry()` ignores `srid`.
**`GeoPoint = { x: longitude, y: latitude }`.**

## 5. Transactional outbox and events

- Write side: `enqueueDomainEvent(tx, { type, aggregateId, payload })` (`packages/db/src/outbox.ts`)
  validates against `domainEventSchema` and inserts into `outbox_events` **inside the caller's
  transaction**.
- Relay: `apps/worker/src/outbox/outbox-relay.ts#OutboxRelay`, batches of 100
  `FOR UPDATE SKIP LOCKED`, polls every 250 ms, publishes with `DomainEventPublisher` (key =
  aggregate_id, headers event_id/type/version), sets `published_at` only after the Kafka ack, and
  dead-letters after 20 attempts. At-least-once: consumers must dedupe on `event_id`.
- Producer: `@confluentinc/kafka-javascript`, `{ 'enable.idempotence': true, acks: -1 }`.
- Events and topics:

  | `event_type`                 | Topic                     | Aggregate      | Emitted by                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
  | ---------------------------- | ------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `order.locked`               | `order.lifecycle`         | reservation_id | checkout                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
  | `order.placed`               | `order.lifecycle`         | order_id       | lock claim (PLACED)                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
  | `order.canceled_refund_due`  | `payment.reconciliation`  | order_id       | **Phase 6.** Cancellation of a PAID order ("ORDER_CANCELED_REFUND_DUE"). Payload: order/vendor/customer ids, ESEWA\|KHALTI, gateway ref, `refund_amount_npr` (subtotal + delivery fee), `canceled_at`                                                                                                                                                                                                                                                                                 |
  | `order.state_changed`        | `order.lifecycle`         | order_id       | **Phase 8.** Every change of `orders.state`, in the same transaction (`enqueueOrderStateChanged`). Payload: order/customer/vendor ids, `from_state` (null on creation), `to_state`, `payment_status`, `refund_required`, `placed_at`, `delivered_at`, `changed_at` (= the row's `updated_at`)                                                                                                                                                                                         |
  | `ledger.mutated`             | `ledger.mutations`        | transaction_id | every journal                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
  | `vendor.escalation.required` | `notifications.broadcast` | order_id       | **Phase 10.** The worker's 90 s timer found the order still PLACED. Payload: order/vendor ids, `vendor_phone` (+977, for the IVR call/SMS), `placed_at`, `sla_seconds` (90), `escalated_at`. At most one per order (partial unique index, migration 0012). **Phase 13: SMS to the vendor; Phase 14: plus an IVR call (mock), both only while the order is still PLACED.**                                                                                                             |
  | `vendor.suspended_for_debt`  | `notifications.broadcast` | vendor_id      | **Phases 12 / 12.5.** A vendor crossed the suspension limit: written by the API's `WalletService` in the transaction of the posting that crossed it (Phase 12.5), or by the nightly `VENDOR_DEBT_RECONCILIATION` after the limit was tightened (Phase 12). Payload: `vendor_id`, `vendor_phone` (+977), `previous_status` (never SUSPENDED), `wallet_balance_npr` (< 0), `suspension_limit_npr`, `suspended_at`. Once per transition into SUSPENDED. **Phase 13: SMS to the vendor.** |
  | `vendor.restored`            | `notifications.broadcast` | vendor_id      | **Phase 12.5.** A debt-suspended vendor's balance is back to 0 or more (top-up or payout); `WalletService` restored `status_before_debt_suspension`. Payload: `vendor_id`, `vendor_phone`, `restored_status` (never SUSPENDED), `wallet_balance_npr` (≥ 0), `transaction_id` (the clearing journal), `restored_at`. **Phase 13: SMS to the vendor.**                                                                                                                                  |
  | `vendor.status_overridden`   | `notifications.broadcast` | vendor_id      | **Phase 15.** A Super Admin suspended or restored the vendor by hand (`WalletService.suspendByAdmin` / `restoreByAdmin`, same transaction). Payload: `vendor_id`, `action` SUSPEND\|RESTORE, `from_status`, `to_status`, `wallet_balance_npr`, `admin_user_id`, `overridden_at`. The audit record of SPEC infrastructure §5; no consumer texts it (the notification consumer ignores it).                                                                                             |

- Consumers (`apps/worker/src/consumers/index.ts#buildConsumers`, one handler per topic, group
  `KAFKA_CONSUMER_GROUP_ID`):

  | Consumer                                                    | Topic                     | Acts on                                                                                   | Does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
  | ----------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | `order-state-fanout.ts#orderStateFanoutConsumer`            | `order.lifecycle`         | `order.state_changed`                                                                     | Broadcasts `order:state_update` (`orderStateUpdateFromEvent`) to the rooms of `orderStateUpdateRooms`: `order:{order_id}`, plus `vendor:{vendor_id}` once the order was placed (`placed_at` not null; Phase 10), namespace `/orders`, via `@socket.io/redis-emitter` (key `SOCKET_IO_REDIS_KEY`). Other event types are ignored.                                                                                                                                                                                                                                               |
  | `vendor-sla-scheduler.ts#vendorSlaSchedulerConsumer`        | `order.lifecycle`         | `order.state_changed` to PLACED                                                           | **Phase 10.** Schedules the `vendor-acceptance-timeout` job (id = order id, idempotent) with delay `vendorAcceptanceDelayMs(placed_at, now)` = what is left of 90 s from `placed_at` (0 if already past). Throws (redelivery) if Redis refuses.                                                                                                                                                                                                                                                                                                                                |
  | `vendor-notifications.ts#vendorNotificationConsumer`        | `notifications.broadcast` | `vendor.suspended_for_debt`, `vendor.restored`, `vendor.escalation.required`              | **Phase 13.** Renders the template (`notifications/vendor-sms.ts`) and sends it to `vendor_phone` through the `SMS_PROVIDER` adapter; an escalation also places an IVR call (`IVR_PROVIDER`) concurrently, after the stale-order guard found the order still PLACED (Phase 14). Dedupe per channel (`notifications:sms:seen:` / `notifications:ivr:seen:{event_id}`); a failure releases that channel's claim and throws. **Wrapped in `withDeadLetter`** (Phase 14): 3 in-process retries, then a `dead_letter_events` row (Phase 15) and `notifications.dlq`. §8G, §8H, §8I. |
  | `order-push-notifications.ts#orderPushNotificationConsumer` | `order.lifecycle`         | `order.state_changed` to PLACED, PREPARING, OUT_FOR_DELIVERY, DELIVERED, CANCELED, FAILED | **Phase 20.** Reads the recipient's device tokens (`device_tokens`; a vendor through `vendors.user_id`) and POSTs the pushes to `https://exp.host/--/api/v2/push/send`. Registered **last** on the topic and **never throws**: claimed once per event (`notifications:push:seen:{event_id}`, kept on failure), failures logged as `push.failed`. `DeviceNotRegistered` tokens are deleted. With `SMS_PROVIDER=MOCK` logs the SMS each push stands in for. §8M.                                                                                                                 |
  - **Dedupe:** `SET fanout:orders:seen:{event_id} 1 EX 86400 NX` before broadcasting; a redelivery is
    skipped. If the broadcast fails the claim is deleted and the handler throws, so Kafka redelivers.
  - **Publish errors are not swallowed:** the emitter calls `redis.publish` without awaiting it;
    `RedisOrderRoomBroadcaster` hands it a wrapper that collects those promises and awaits them.
  - An invalid envelope is logged and skipped on `order.lifecycle` (a poison message would otherwise
    block the partition). On `notifications.broadcast` it is dead-lettered to `notifications.dlq`
    instead (Phase 14, §8H); the `order.lifecycle` consumers have no DLQ yet.
  - **Several consumers may share a topic (Phase 10):** `routeByTopic` builds one Kafka handler per
    topic that runs its consumers in registration order (fan-out, then the SLA scheduler). If any
    throws, the message fails and is redelivered to all of them, so each must be idempotent.
  - Nothing acts on `order.canceled_refund_due` yet (no refund is issued). A canceled COD order now
    emits `order.state_changed`, but no vendor app or notification consumes it (§13).

## 6. Concurrency, ledger, timers

- Redis 600 s lock (`apps/api/src/inventory/inventory-lock-service.ts`): keys
  `inv:{vendorId}:res:{reservationId}` (JSON, `PX 600000`) and `inv:{vendorId}:holds:{productId}`.
  WATCH → read → MULTI/EXEC with retries on a dedicated pooled connection. Available = Postgres stock
  − live holds.
- Claim (`checkout/checkout-service.ts#claim`): order `FOR UPDATE`, stock decrement guarded by
  `stock_quantity >= qty`, state → PLACED **and `placed_at = now()`**, `order.placed`, lock released
  after commit.
- Cancellation (`orders/order-service.ts#cancel`, §8): order `FOR UPDATE`, stock incremented back from
  `order_items` (in product-id order), state → CANCELED, refund flag + event in the same commit,
  then a best-effort release of any lingering reservation.
- Settlement (`ledger/settlement-plan.ts` pure, `settlement-service.ts`): capture moves money
  GATEWAY_CLEARING → SYSTEM_ESCROW. Settlement happens only in DELIVERED; the vendor gets S − C, C goes
  to revenue, and the delivery fee goes to the deliverer. COD self-delivery debits C from the vendor
  wallet (may suspend); COD fleet debits the driver. Keys `payment-capture:<order>`,
  `order-settlement:<order>`. **Nothing triggers settlement yet** (no DELIVERED transition route).
- BullMQ (`apps/worker/src/queues/`): `vendor-acceptance-timeout` (90 s), `ghost-customer-timer`
  (8 min), `midnight-maintenance` (cron `0 0 * * *`, Asia/Kathmandu). **Phase 10: the 90 s timer is
  live** (scheduled by the worker's `vendor-sla-scheduler` consumer, handled by
  `createTimerHandlers` → `VendorEscalationService`, §8D). The ghost-customer and midnight handlers
  are still **placeholders that log**. The API enqueues nothing itself. **Phase 22:** a third
  midnight scheduler, `order-reconciliation` (task `ORDER_RECONCILIATION`), is live (§8O);
  `SUBSCRIPTION_DOWNGRADE` is still the placeholder.

## 7. eSewa ePay v2 and Khalti rules (backend)

Code: `apps/api/src/payments/esewa/{signature,esewa-service}.ts`, `payments/khalti/*`. Unchanged in
Phase 6.

1. The signed message is `name=value` pairs in `signed_field_names` order, comma-joined:
   `total_amount=110,transaction_uuid=241028,product_code=EPAYTEST`.
2. Signature = standard Base64 of HMAC-SHA256 (44 chars). Pinned vectors (UAT secret
   `8gBm/:&EnhH.1/q`): request above → `i94zsd3oXF6ZsSr/kGqT4sSzYQzjj1W/waxjWyRwaME=`; documented
   success callback → `62GcfZTmVkzhtUeh+QJ1AqiJrjoWWGof3U+eTPTZ7fA=`.
3. **Float rule:** the callback `data` is base64 JSON whose `total_amount` is a number literal such as
   `1000.0`; `decodeEsewaCallback` keeps every number as its **source string** (JSON.parse reviver
   with `context.source`). Never round-trip callback numbers through `Number` before verifying.
4. Verification recomputes over the callback's own `signed_field_names` (must include status,
   total_amount, transaction_uuid, product_code, signed_field_names), compares in constant time,
   checks product_code, and only then compares the amount to `subtotal + delivery_fee` (±1 paisa)
   under `SELECT … FOR UPDATE`. Only `COMPLETE` credits.
5. Initiate returns `{ payment_url, method: 'POST', fields }`, where `fields` includes
   `success_url` and `failure_url` (from `ESEWA_SUCCESS_URL` / `ESEWA_FAILURE_URL`). A fresh
   `transaction_uuid` per initiate is stored as `payment_gateway_ref`.
6. Khalti: `POST {KHALTI_BASE_URL}/epayment/initiate/` (`Authorization: Key <secret>`, amount in paisa),
   `pidx` stored as `payment_gateway_ref`; `lookup` credits only on `Completed` within ±1 paisa.
   SPEC's `https://a.khalti.com/api/v2` is production; sandbox is `https://dev.khalti.com/api/v2`.
7. Shared tail (`payments/payment-confirmation.ts`): lock order by `(payment_method,
payment_gateway_ref)` `FOR UPDATE`, capture escrow once, then claim the lock → PLACED. If the lock
   expired or stock vanished: order **FAILED**, stays PAID, response `409 PAID_AFTER_SESSION_EXPIRED`
   `{ order_id, refund_required: true }`. **This path does not set `orders.refund_required`**, and no
   refund flow exists.
8. **The API has no handlers at `ESEWA_SUCCESS_URL` / `ESEWA_FAILURE_URL` / `KHALTI_RETURN_URL`.** The
   mobile WebView intercepts those navigations (§9.5), so it works without them, but a browser
   fallback or the SPEC's eSewa app-to-app intent would need real landing pages.

## 8. Express API: exact state

Composition root `apps/api/src/container.ts` (`buildContainer`, `buildContainerFromEnv`); app
`apps/api/src/app.ts#createApp(services?)` (without services only `/health` is mounted). JSON body
limit 100 kB, `x-powered-by` off. `ApiServices = { accessTokenSecret, auth, catalog, checkout,
orders, esewa, khalti }`. Routers: `/api/auth` (`routes/auth.ts`, **public**), and behind
`requireAuth(CUSTOMER)`: `/api/vendors` (`routes/vendors.ts`), `/api/cart` (`routes/cart.ts`),
`/api/orders` (`routes/orders.ts`), `/api/payments` (`routes/payments.ts`, per-route customer
auth). `Infrastructure` now requires an `sms: SmsGateway` (tests inject `MockSmsGateway`).

### Implemented routes (the complete list)

| Method & path                                                      | Auth                                                              | Request                                                                                                                                                                                                                           | Success                                      | Response schema                                                                                                                                                                                                                                                                                                   | Used by mobile                                                              |
| ------------------------------------------------------------------ | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `POST /api/auth/otp/send`                                          | **none**                                                          | `otpSendRequestSchema {phone: strict +9779XXXXXXXXX}`                                                                                                                                                                             | 200                                          | `otpSendResponseSchema {phone, expires_in_seconds: 120, resend_after_seconds: 60}`                                                                                                                                                                                                                                | `useSendOtp` (login screen, resend)                                         |
| `POST /api/auth/otp/verify`                                        | **none**                                                          | `otpVerifyRequestSchema {phone, code: 6 digits}`                                                                                                                                                                                  | 200 (`no-store`)                             | `authTokensResponseSchema {token_type, access_token, access_token_expires_in, refresh_token, refresh_token_expires_in, user{id, role, first_name\|null}, is_new_user}`; **SUPER_ADMIN (Phase 16):** `cookieAuthTokensResponseSchema` (the same without `refresh_token`) + `Set-Cookie: hamro_pasal_refresh` (§8J) | `useVerifyOtp` (code screen); admin `verifyOtp`                             |
| `POST /api/auth/token/refresh`                                     | **none** (the refresh JWT)                                        | `tokenRefreshRequestSchema {refresh_token}`                                                                                                                                                                                       | 200 (`no-store`)                             | `tokenRefreshResponseSchema {token_type, access_token, access_token_expires_in}`                                                                                                                                                                                                                                  | `apiRequest` renewal (`refreshAccessToken`)                                 |
| `POST /api/auth/refresh`                                           | **none** (the HttpOnly refresh cookie; SUPER_ADMIN accounts only) | no body (a token in the body or a header is ignored)                                                                                                                                                                              | 200 (`no-store`)                             | `sessionRefreshResponseSchema {token_type, access_token, access_token_expires_in, user{id, role, first_name\|null, phone}}`; `401 REFRESH_TOKEN_INVALID` (missing, expired, forged, wrong audience/type, deleted or demoted account) and the cookie is cleared                                                    | no (admin `restoreSession` and 401 renewal)                                 |
| `POST /api/auth/logout`                                            | **none**                                                          | –                                                                                                                                                                                                                                 | **204** (`no-store`, also without a cookie)  | no body; `Set-Cookie` clears `hamro_pasal_refresh`                                                                                                                                                                                                                                                                | no (admin Sign out)                                                         |
| `GET /health`                                                      | none                                                              | –                                                                                                                                                                                                                                 | 200 `{status:'ok'}`                          | –                                                                                                                                                                                                                                                                                                                 | no                                                                          |
| `GET /api/vendors?lat=&lng=[&municipality_palika_string=]`         | Bearer CUSTOMER                                                   | `vendorFeedQuerySchema` (coordinates inside `NEPAL_BOUNDING_BOX`)                                                                                                                                                                 | 200                                          | `feedResponseSchema {serviceable[], explore_further[]}` of `{vendor: FeedVendor, distance_km, serviceable}`                                                                                                                                                                                                       | `useFeedQuery` (Shops tab)                                                  |
| `GET /api/vendors/:id/products?lat=&lng=[&municipality_…]`         | Bearer CUSTOMER                                                   | `idParamSchema` + `vendorMenuQuerySchema`                                                                                                                                                                                         | 200                                          | `vendorMenuSchema {vendor, serviceable, products[{id, name, price_npr, in_stock, stock_quantity (Phase 19)}]}`                                                                                                                                                                                                    | `useVendorMenuQuery` (vendor screen)                                        |
| `POST /api/cart/checkout`                                          | Bearer CUSTOMER                                                   | `checkoutRequestSchema {idempotency_key(8–100), vendor_id, payment_method, items[1–50]{product_id, quantity 1–99}, delivery_address (required)}`                                                                                  | 201 new / 200 replay                         | `checkoutResponseSchema {order: OrderView, reservation{id\|null, expires_at\|null}, delivery_otp\|null, replayed}`                                                                                                                                                                                                | `useCheckout` (sends the saved address)                                     |
| `GET /api/cart/lock-status?order_id=`                              | Bearer CUSTOMER (owner)                                           | `lockStatusQuerySchema`                                                                                                                                                                                                           | 200                                          | `lockStatusResponseSchema {order, lock{status ACTIVE\|EXPIRED\|RELEASED, ttl_ms, expires_at}}`                                                                                                                                                                                                                    | `useLockStatus` (5 s poll, checkout only)                                   |
| `GET /api/orders/:id`                                              | Bearer CUSTOMER (owner)                                           | `idParamSchema`                                                                                                                                                                                                                   | 200                                          | `orderDetailResponseSchema {order: OrderSnapshot}`                                                                                                                                                                                                                                                                | `useOrderQuery` → `fetchOrder` (no polling)                                 |
| `POST /api/orders/:id/cancel`                                      | Bearer CUSTOMER (owner)                                           | `idParamSchema`                                                                                                                                                                                                                   | 200 (also on repeat)                         | `cancelOrderResponseSchema {order_id, state:'CANCELED', refund_required}`                                                                                                                                                                                                                                         | `useCancelOrder` → `cancelOrder`                                            |
| `POST /api/payments/esewa/initiate`                                | Bearer CUSTOMER (owner)                                           | `paymentInitiateRequestSchema {order_id}`                                                                                                                                                                                         | 200                                          | `esewaInitiateResponseSchema {payment_url, method:'POST', fields}`                                                                                                                                                                                                                                                | `initiateEsewa`                                                             |
| `POST /api/payments/esewa/webhook`                                 | **none** (HMAC-authenticated)                                     | `esewaWebhookRequestSchema {data: base64}`                                                                                                                                                                                        | 200                                          | `paymentStatusResponseSchema {status, payment: PaymentView\|null}`                                                                                                                                                                                                                                                | `confirmEsewa` (the app forwards the redirect)                              |
| `POST /api/payments/khalti/initiate`                               | Bearer CUSTOMER (owner)                                           | `{order_id}`                                                                                                                                                                                                                      | 200                                          | `khaltiInitiateResponseSchema {pidx, payment_url, expires_at}`                                                                                                                                                                                                                                                    | `initiateKhalti`                                                            |
| `POST /api/payments/khalti/lookup`                                 | Bearer CUSTOMER (pidx owner)                                      | `khaltiLookupRequestSchema {pidx}`                                                                                                                                                                                                | 200                                          | `paymentStatusResponseSchema`                                                                                                                                                                                                                                                                                     | `lookupKhalti`                                                              |
| `POST /api/reviews`                                                | Bearer CUSTOMER (order owner)                                     | `reviewSubmitRequestSchema {order_id, rating 1–5 int, feedback? ≤500 (trimmed, blank → null)}`                                                                                                                                    | 201                                          | `reviewSubmitResponseSchema {review: {id, order_id, direction, rating, feedback, status QUARANTINED\|PUBLISHED, published_at, created_at}}`                                                                                                                                                                       | `submitReview` (`ReviewModal`)                                              |
| `POST /api/vendors/orders/:id/reviews`                             | Bearer VENDOR (order's vendor)                                    | `idParamSchema` + `vendorReviewSubmitRequestSchema {rating 1–5 int, feedback? ≤500}`                                                                                                                                              | 201                                          | `reviewSubmitResponseSchema` (direction `VENDOR_TO_CUSTOMER`)                                                                                                                                                                                                                                                     | no                                                                          |
| `GET /api/vendors/orders`                                          | Bearer VENDOR                                                     | –                                                                                                                                                                                                                                 | 200 (`no-store`)                             | `vendorOrderListResponseSchema {orders: VendorOrderView[]}` PLACED first, then PREPARING, oldest placement first, max 100; `404 VENDOR_NOT_FOUND` for a shopless vendor                                                                                                                                           | `fetchVendorOrders` (vendor dashboard)                                      |
| `POST /api/vendors/orders/:id/accept`                              | Bearer VENDOR (order's vendor)                                    | `idParamSchema`                                                                                                                                                                                                                   | 200 (also on repeat)                         | `vendorOrderDecisionResponseSchema {order_id, state:'PREPARING', refund_required}`                                                                                                                                                                                                                                | `decideVendorOrder` (Accept)                                                |
| `POST /api/vendors/orders/:id/reject`                              | Bearer VENDOR (order's vendor)                                    | `idParamSchema`                                                                                                                                                                                                                   | 200 (also on repeat)                         | `vendorOrderDecisionResponseSchema {order_id, state:'CANCELED', refund_required}`                                                                                                                                                                                                                                 | `decideVendorOrder` (Reject)                                                |
| `POST /api/vendors/orders/:id/dispatch`                            | Bearer VENDOR (order's vendor)                                    | `idParamSchema`                                                                                                                                                                                                                   | 200 (also on repeat)                         | `vendorOrderDispatchResponseSchema {order_id, state:'OUT_FOR_DELIVERY'}`; `422 CANCELLATION_WINDOW_OPEN` (details.retry_after_seconds) inside the 60 s window                                                                                                                                                     | `dispatchVendorOrder` (Dispatch)                                            |
| `POST /api/vendors/orders/:id/deliver`                             | Bearer VENDOR (order's vendor, SELF_DELIVERY orders only)         | `idParamSchema` + `deliveryOtpRequestSchema {delivery_otp: 4 ASCII digits}`                                                                                                                                                       | 200 (also on repeat)                         | `deliveryConfirmedResponseSchema {order_id, state:'DELIVERED', delivered_at}`; 401 `INVALID_OTP`, 429 `DELIVERY_OTP_LOCKED`, 409 `WRONG_FULFILLMENT_MODE`                                                                                                                                                         | `deliverVendorOrder` (vendor handoff)                                       |
| `GET /api/deliveries` (Phase 21)                                   | Bearer DRIVER                                                     | –                                                                                                                                                                                                                                 | 200 (`no-store`)                             | `deliveryListResponseSchema {deliveries[{id, state OFFERED\|ASSIGNED\|PICKED_UP, assigned_to_me, accepted_at\|null, picked_up_at\|null, order{OrderView + vendor_business_name, delivery_address, items}}]}`: open gigs and the rider's own, oldest dispatch first, max 100                                       | `fetchDeliveries` (rider dashboard)                                         |
| `POST /api/deliveries/:id/accept` (Phase 21)                       | Bearer DRIVER                                                     | `idParamSchema` (the **delivery** id)                                                                                                                                                                                             | 200 (also on repeat by the same rider)       | `deliveryResponseSchema {delivery}` (ASSIGNED); `409 DELIVERY_ALREADY_ASSIGNED` (another rider), `409 DELIVERY_STATE_CONFLICT` (details.state), `404 DELIVERY_NOT_FOUND`                                                                                                                                          | `advanceDelivery(id, 'accept')`                                             |
| `POST /api/deliveries/:id/pickup` (Phase 21)                       | Bearer DRIVER (the delivery's rider)                              | `idParamSchema`                                                                                                                                                                                                                   | 200 (also on repeat)                         | `deliveryResponseSchema` (PICKED_UP); `404 DELIVERY_NOT_FOUND` (open gig, another rider's, unknown), `409 DELIVERY_STATE_CONFLICT`                                                                                                                                                                                | `advanceDelivery(id, 'pickup')`                                             |
| `POST /api/deliveries/:id/complete` (Phase 21)                     | Bearer DRIVER (the delivery's rider, state PICKED_UP)             | `idParamSchema` + `deliveryOtpRequestSchema {delivery_otp: 4 ASCII digits}`                                                                                                                                                       | 200 (also on repeat)                         | `deliveryConfirmedResponseSchema {order_id, state:'DELIVERED', delivered_at}`; 401 `INVALID_OTP`, 429 `DELIVERY_OTP_LOCKED`, 409 `DELIVERY_STATE_CONFLICT` (not picked up yet; no attempt counted), 404 `DELIVERY_NOT_FOUND`                                                                                      | `completeDelivery` (rider handoff)                                          |
| `POST /api/uploads/dispute-evidence`                               | Bearer CUSTOMER (order owner)                                     | multipart: field `order_id` (`disputeEvidenceUploadFieldsSchema`) + part `file` (JPEG/PNG/WebP by magic bytes, ≤ 5 MB)                                                                                                            | 201                                          | `disputeEvidenceUploadResponseSchema {url, content_type}` (= a chat attachment)                                                                                                                                                                                                                                   | `uploadDisputeEvidence` (dispute screen)                                    |
| `GET /api/vendors/wallet/balance`                                  | Bearer VENDOR (own shop; SUSPENDED vendors too)                   | –                                                                                                                                                                                                                                 | 200 (`no-store`)                             | `vendorWalletBalanceResponseSchema {vendor_id, status, is_suspended, suspended_for_debt, wallet_balance_npr, suspension_limit_npr, pending_escrow_npr, pending_escrow_order_count}`; `404 VENDOR_NOT_FOUND` for a shopless vendor                                                                                 | `fetchVendorWalletBalance` (wallet screen)                                  |
| `GET /api/vendors/wallet/ledger?limit=&cursor=`                    | Bearer VENDOR (own shop)                                          | `vendorWalletLedgerQuerySchema {limit? 1–50 (default 20), cursor? = an entry id}`                                                                                                                                                 | 200 (`no-store`)                             | `vendorWalletLedgerResponseSchema {entries[{id, transaction_id, kind, entry_type, amount_npr, balance_after_npr, description, created_at, order\|null}], next_cursor}`; `400 INVALID_CURSOR` (not an entry of this wallet)                                                                                        | `fetchVendorWalletLedger` (wallet screen)                                   |
| `POST /api/vendors/wallet/top-up`                                  | Bearer VENDOR (own shop; SUSPENDED vendors too)                   | `walletTopUpRequestSchema {idempotency_key (8–100), amount_npr > 0, ≤ 100 000, whole paisa}`                                                                                                                                      | 201 new / 200 replay (`no-store`)            | `walletTopUpResponseSchema {transaction_id, amount_npr, wallet_balance_npr, status, is_suspended, restored, replayed}`; `409 IDEMPOTENCY_KEY_REUSED` (same key, other amount), `503 TOP_UP_UNAVAILABLE` unless `WALLET_TOP_UP_MODE=MOCK`                                                                          | `topUpVendorWallet` ("Pay outstanding balance")                             |
| `GET /api/orders/:id/chat`                                         | Bearer CUSTOMER, VENDOR or SUPER_ADMIN (order party or admin)     | `idParamSchema`                                                                                                                                                                                                                   | 200 (`no-store`)                             | `chatHistoryResponseSchema {messages: ChatMessage[]}` oldest first; senders `{id, first_name, role}` only; empty without a dispute                                                                                                                                                                                | `fetchChatHistory` (dispute screen)                                         |
| `GET /uploads/dispute-evidence/:order/:file`                       | none (unguessable uuid names)                                     | –                                                                                                                                                                                                                                 | 200                                          | the stored image (`express.static`, `nosniff`); only mounted for `LocalEvidenceStorage`                                                                                                                                                                                                                           | chat image bubbles                                                          |
| `GET /api/admin/dlq?status=&limit=&cursor=`                        | Bearer SUPER_ADMIN                                                | `adminDeadLetterListQuerySchema {status?, limit? 1–100 (default 50), cursor? = a row id}`                                                                                                                                         | 200 (`no-store`)                             | `adminDeadLetterListResponseSchema {dead_letters: DeadLetterView[], next_cursor}` newest failure first; `400 INVALID_CURSOR`                                                                                                                                                                                      | `listDeadLetters` (admin DLQ screen)                                        |
| `POST /api/admin/dlq/:id/retry`                                    | Bearer SUPER_ADMIN                                                | `idParamSchema`                                                                                                                                                                                                                   | **202** (also on repeat)                     | `adminDeadLetterRetryResponseSchema {dead_letter}` (RETRY_REQUESTED; the worker replays it); `404 DEAD_LETTER_NOT_FOUND`, `409 DEAD_LETTER_ALREADY_REPLAYED`                                                                                                                                                      | `retryDeadLetter` (Retry button)                                            |
| `GET /api/admin/vendors`                                           | Bearer SUPER_ADMIN                                                | –                                                                                                                                                                                                                                 | 200 (`no-store`)                             | `adminVendorListResponseSchema {vendors: AdminVendorView[] (by name, ≤ 500), suspension_limit_npr}`                                                                                                                                                                                                               | `listVendors` (admin Vendors screen)                                        |
| `POST /api/admin/vendors/:id/suspend`                              | Bearer SUPER_ADMIN                                                | `idParamSchema`                                                                                                                                                                                                                   | 200                                          | `adminVendorOverrideResponseSchema {vendor, previous_status}`; `409 VENDOR_STATUS_CONFLICT` (already SUSPENDED), `404 VENDOR_NOT_FOUND`                                                                                                                                                                           | `overrideVendor(id, 'SUSPEND')`                                             |
| `POST /api/admin/vendors/:id/restore`                              | Bearer SUPER_ADMIN                                                | `idParamSchema`                                                                                                                                                                                                                   | 200                                          | `adminVendorOverrideResponseSchema`; `409 VENDOR_STATUS_CONFLICT` (not SUSPENDED), `409 WALLET_BELOW_SUSPENSION_LIMIT` (details balance + limit), `409 RESTORE_STATUS_UNKNOWN`                                                                                                                                    | `overrideVendor(id, 'RESTORE')`                                             |
| `GET /api/categories`                                              | **none** (public)                                                 | –                                                                                                                                                                                                                                 | 200                                          | `categoryListResponseSchema {categories[{id, name, slug, parent_id, icon_url, display_order}]}`: active categories whose ancestors are all active, flat, in tree order                                                                                                                                            | `fetchCategories` (Home category pills)                                     |
| `GET /api/products?category_id=&vendor_id=&search=&limit=&cursor=` | **none** (public)                                                 | `productListQuerySchema` (limit 1–50, default 20; search 1–100 chars)                                                                                                                                                             | 200                                          | `productListResponseSchema {products[{id, vendor{id, business_name}, category_id, name, description, price_npr, unit, in_stock, stock_quantity (Phase 18), image_urls, metadata}], next_cursor}` by name; `404 CATEGORY_NOT_FOUND` (unknown or inactive), `400 INVALID_CURSOR`                                    | `fetchProducts` (Home product list)                                         |
| `GET /api/vendor/products?limit=&cursor=`                          | Bearer VENDOR (own shop, any status)                              | `vendorProductListQuerySchema`                                                                                                                                                                                                    | 200 (`no-store`)                             | `vendorProductListResponseSchema {products: VendorProductView[], next_cursor}` inactive included, by name; `400 INVALID_CURSOR`, `404 VENDOR_NOT_FOUND`                                                                                                                                                           | no                                                                          |
| `POST /api/vendor/products`                                        | Bearer VENDOR (own shop, any status)                              | `vendorProductCreateRequestSchema {category_id, name, description?, price_npr, unit? ('piece'), stock_quantity? (0), image_urls? ≤ 8, is_active? (true), metadata?}`                                                              | 201 (`no-store`)                             | `vendorProductResponseSchema {product}`; `422 CATEGORY_UNAVAILABLE`, `409 PRODUCT_NAME_TAKEN`                                                                                                                                                                                                                     | no                                                                          |
| `PATCH /api/vendor/products/:id/stock`                             | Bearer VENDOR (own product)                                       | `idParamSchema` + `vendorProductStockRequestSchema {stock_quantity: int ≥ 0}` (the new quantity, not a delta)                                                                                                                     | 200 (`no-store`)                             | `vendorProductResponseSchema`; `404 PRODUCT_NOT_FOUND` (also another shop's)                                                                                                                                                                                                                                      | no                                                                          |
| `PUT /api/vendor/products/:id` (Phase 19)                          | Bearer VENDOR (own product)                                       | `idParamSchema` + `vendorProductUpdateRequestSchema {category_id, name, description?, price_npr, unit? ('piece'), is_active? (true), metadata? ({}), image_urls? ≤ 8 (kept when omitted)}`; `stock_quantity` or `vendor_id` → 400 | 200 (`no-store`)                             | `vendorProductResponseSchema`; `404 PRODUCT_NOT_FOUND` (also another shop's), `422 CATEGORY_UNAVAILABLE` (moving into an unknown / hidden category), `409 PRODUCT_NAME_TAKEN`                                                                                                                                     | `updateOwnProduct` (Vendor Portal: Edit, Show)                              |
| `DELETE /api/vendor/products/:id` (Phase 19)                       | Bearer VENDOR (own product)                                       | `idParamSchema`                                                                                                                                                                                                                   | **204** (also on repeat)                     | no body; soft delete (`is_active = false`); `404 PRODUCT_NOT_FOUND` (also another shop's)                                                                                                                                                                                                                         | `hideOwnProduct` (Vendor Portal: Hide)                                      |
| `POST /api/vendor/products/:id/images` (Phase 19)                  | Bearer VENDOR (own product)                                       | `idParamSchema` + multipart/form-data: 1–8 parts named `images` (JPEG / PNG / WebP by magic bytes, ≤ 5 MB each); no other field                                                                                                   | 201 (`no-store`)                             | `vendorProductResponseSchema` (the new URLs appended to `image_urls`); `404 PRODUCT_NOT_FOUND`, `422 PRODUCT_IMAGE_LIMIT` (details.max_images 8, current_images), `413 FILE_TOO_LARGE`, `415 UNSUPPORTED_MEDIA_TYPE`, `400 VALIDATION_FAILED` (no file) / `MALFORMED_REQUEST` (another field or part name)        | `uploadOwnProductImages` (Vendor Portal: Upload)                            |
| `GET /uploads/product-images/:product/:file` (Phase 19)            | none (unguessable uuid names)                                     | –                                                                                                                                                                                                                                 | 200                                          | the stored photo (`express.static`, `nosniff`); same mount as the dispute evidence                                                                                                                                                                                                                                | product thumbnails (Vendor Portal); `image_urls` of the public product list |
| `POST /api/notifications/device-token` (Phase 20)                  | Bearer, **any role**                                              | `deviceTokenRegisterRequestSchema {token: Expo push token (≤ 255), platform: ANDROID \| IOS}`; a `user_id` in the body → 400                                                                                                      | 200 (`no-store`; new, repeat or taken over)  | `deviceTokenRegisterResponseSchema {device_token{token, platform, updated_at}}`; `400 VALIDATION_FAILED`, `401 UNAUTHENTICATED` (also when the token's account was deleted)                                                                                                                                       | `registerDeviceToken` (`usePushRegistration`)                               |
| `GET /api/admin/categories`                                        | Bearer SUPER_ADMIN                                                | –                                                                                                                                                                                                                                 | 200 (`no-store`)                             | `adminCategoryListResponseSchema {categories[CategoryView + is_active, product_count, created_at, updated_at]}` the whole taxonomy in tree order                                                                                                                                                                  | `listCategories` (admin Categories screen)                                  |
| `POST /api/admin/categories`                                       | Bearer SUPER_ADMIN                                                | `adminCategoryWriteRequestSchema {name, slug, parent_id? (null), icon_url? (null), display_order? (0), is_active? (true)}`                                                                                                        | 201                                          | `adminCategoryResponseSchema {category}`; `409 CATEGORY_SLUG_TAKEN`, `422 CATEGORY_PARENT_NOT_FOUND`, `422 CATEGORY_TOO_DEEP`                                                                                                                                                                                     | `createCategory`                                                            |
| `PUT /api/admin/categories/:id`                                    | Bearer SUPER_ADMIN                                                | `idParamSchema` + `adminCategoryWriteRequestSchema` (replaces every field)                                                                                                                                                        | 200                                          | `adminCategoryResponseSchema`; the POST errors plus `409 CATEGORY_CYCLE`, `404 CATEGORY_NOT_FOUND`                                                                                                                                                                                                                | `updateCategory`                                                            |
| `DELETE /api/admin/categories/:id`                                 | Bearer SUPER_ADMIN                                                | `idParamSchema`                                                                                                                                                                                                                   | **204**                                      | no body; `409 CATEGORY_IN_USE` (details child_count, product_count), `404 CATEGORY_NOT_FOUND`                                                                                                                                                                                                                     | `deleteCategory`                                                            |
| `GET /api/admin/products?vendor_id=&limit=&cursor=`                | Bearer SUPER_ADMIN                                                | `adminProductListQuerySchema` (limit 1–100, default 50)                                                                                                                                                                           | 200 (`no-store`)                             | `adminProductListResponseSchema {products[VendorProductView + vendor{id, business_name, status}, category_name], next_cursor}` by vendor name, then product name; `400 INVALID_CURSOR`                                                                                                                            | `listProducts` (admin Products screen)                                      |
| `PATCH /api/admin/products/:id/active`                             | Bearer SUPER_ADMIN                                                | `idParamSchema` + `adminProductActiveRequestSchema {is_active}`                                                                                                                                                                   | 200 (also on repeat)                         | `adminProductResponseSchema {product}`; `404 PRODUCT_NOT_FOUND`                                                                                                                                                                                                                                                   | `setProductActive` (Hide / Show)                                            |
| `GET /api/vendor/finance/ledger` (Phase 22)                        | Bearer VENDOR (own shop, any status)                              | –                                                                                                                                                                                                                                 | 200 (`no-store`)                             | `vendorFinanceLedgerResponseSchema {vendor_id, available_balance_npr, pending_balance_npr, pending_payout_npr, unreconciled_order_count, reconciled_orders[≤ 20], payouts[≤ 20]}`; `404 VENDOR_NOT_FOUND` for a shopless vendor                                                                                   | `getOwnFinanceLedger` (Vendor Portal: Earnings)                             |
| `POST /api/vendor/finance/payout` (Phase 22)                       | Bearer VENDOR (own shop, any status)                              | `payoutRequestSchema {idempotency_key (8–100), amount_npr > 0, ≤ 1 000 000, whole paisa}`                                                                                                                                         | 201 new / 200 replay (`no-store`)            | `payoutRequestResponseSchema {payout: PayoutView, available_balance_npr, replayed}`; `422 INSUFFICIENT_BALANCE` (details requested_npr, available_balance_npr), `409 IDEMPOTENCY_KEY_REUSED` (same key, other amount)                                                                                             | `requestOwnPayout` (Earnings: Request payout)                               |
| `GET /api/admin/finance/payouts?status=&limit=&cursor=` (Phase 22) | Bearer SUPER_ADMIN                                                | `adminPayoutListQuerySchema {status?, limit? 1–100 (default 50), cursor? = a request id}`                                                                                                                                         | 200 (`no-store`)                             | `adminPayoutListResponseSchema {payouts: AdminPayoutView[], next_cursor}` newest request first; `400 INVALID_CURSOR`                                                                                                                                                                                              | `listPayouts` (admin Payouts screen)                                        |
| `POST /api/admin/finance/payouts/:id/approve` (Phase 22)           | Bearer SUPER_ADMIN                                                | `idParamSchema` + `adminPayoutApproveRequestSchema {bank_reference: 1–100 chars, trimmed}`                                                                                                                                        | 200 (also on repeat with the same reference) | `adminPayoutDecisionResponseSchema {payout}` (APPROVED); `409 PAYOUT_ALREADY_DECIDED` (details.status; also another reference), `404 PAYOUT_NOT_FOUND`                                                                                                                                                            | `approvePayout`                                                             |
| `POST /api/admin/finance/payouts/:id/reject` (Phase 22)            | Bearer SUPER_ADMIN                                                | `idParamSchema` + optional `adminPayoutRejectRequestSchema {reason? ≤ 500, blank → null}`                                                                                                                                         | 200 (also on repeat)                         | `adminPayoutDecisionResponseSchema {payout}` (REJECTED, amount back in the wallet); `409 PAYOUT_ALREADY_DECIDED`, `404 PAYOUT_NOT_FOUND`                                                                                                                                                                          | `rejectPayout`                                                              |

- `OrderView = {id, vendor_id, state, payment_method, payment_status, fulfillment, subtotal_npr,
delivery_fee_npr, total_npr, created_at}` (no OTP hash, gateway ref or commission).
- `OrderSnapshot = OrderView + {customer_id, refund_required, placed_at|null, delivered_at|null,
delivery_address: OrderAddressView|null, items[{product_id, product_name, unit_price_npr,
quantity}]}`. `delivery_address` is null only for orders created before checkout required it.
- `FeedVendor = {id, business_name, delivery_scope, radius_km, municipality_palika_string,
min_order_value, base_delivery_fee_npr, fulfillment_mode, location{x: lng, y: lat}}` (no phone,
  wallet or commission; the schema is strict).
- `PaymentView = {order_id, order_state, payment_status, duplicate}`.
- `VendorOrderView = OrderView + {placed_at (non-null), delivery_address|null, items[]}` (Phase 10): no
  `customer_id`, name or phone (strict schema).

**Feed / menu behaviour (SPEC §2, `catalog/catalog-service.ts`).** One SQL query over LIVE vendors
computes `ST_Distance(vendor::geography, customer::geography)` (WGS 84 spheroid) and `serviceable`:
NATION_WIDE → true; CITY_WIDE → `vendor.municipality_palika_string = :palika` exactly (false when the
optional `municipality_palika_string` query param is absent; the API has no palika polygons);
RADIUS_BOUND → `ST_DWithin(…, radius_km * 1000 * 1.1)`. Sorted by distance then id, partitioned in
TypeScript, each section capped at `FEED_SECTION_LIMIT = 100`. `distance_km` is rounded to the metre.
Menus: vendor must be LIVE (else `404 VENDOR_NOT_FOUND`), active products sorted by name,
`in_stock = stock_quantity > 0` and, since Phase 19, `stock_quantity` itself (both ignore other
customers' Redis holds; checkout re-checks). Verified
at 5.4 km (serviceable) vs 5.501 km (not) on a 5 km radius, and 5.499 vs 5.502 km on four bearings;
vendors are placed with `ST_Project` (`pointAtDistance` in `test/support/fixtures.ts`).

**Checkout behaviour:** the stock guard runs first (Phase 17: a line above `products.stock_quantity`
is `409 INSUFFICIENT_STOCK` before anything else, §8K); server-side pricing from DB (client prices never trusted); delivery fee =
vendor base fee; commission half-up to the paisa (0 on SUBSCRIPTION). Vendor must be LIVE (else
`422 VENDOR_UNAVAILABLE`); below MOV → `422 BELOW_MINIMUM_ORDER_VALUE`; COD refused below average
published VENDOR_TO_CUSTOMER rating 3.0. `delivery_address` is validated by `nepalAddressInputSchema`
(district normalised to its canonical name, province/district match, pin inside
`NEPAL_BOUNDING_BOX`) and inserted into `order_addresses` in the order transaction. Creates a CSPRNG
4-digit OTP (bcrypt stored), locks inventory, inserts order + items + address + `order.locked` in one
transaction. Same idempotency key → Redis-mutex-serialised replay of the same order, **rotating the
OTP** (the replay does not compare the request body, so a changed address on the same key is ignored;
the app therefore puts the address in its key fingerprint, §9.4). COD is claimed immediately
(PLACED); prepaid stays PENDING_PAYMENT until the gateway confirms within 600 s. **Checkout does not
check that the address is inside the vendor's service area** (§11).

**Cancellation behaviour (customer journey 8, `orders/order-service.ts#cancel`).** In one
transaction under `SELECT … FOR UPDATE`:

1. not found or not the caller's → `404 ORDER_NOT_FOUND` (ids cannot be probed);
2. already CANCELED → 200 with the same body (idempotent; also after the window);
3. state not PLACED **or PREPARING** → `409 ORDER_STATE_CONFLICT` (`details.state`). PREPARING is
   cancelable since Phase 10: a vendor may accept at once, but that does not shorten the customer's
   unskippable window. A PENDING_PAYMENT order is **not** cancelable: a payment arriving after such a
   cancel would be captured with no refund flag;
4. `clock_timestamp() - placed_at <= 60 s` (database clock, measured after the row lock is held),
   else `422 CANCELLATION_WINDOW_EXPIRED`. Anchored on **`placed_at`**, so time spent paying on a
   gateway does not count;
5. stock added back per `order_items`, state → CANCELED;
6. `payment_status = 'PAID'` → `refund_required = true` and `order.canceled_refund_due` enqueued.
   Steps 5–6 are `order-service.ts#cancelPlacedOrder(tx, order)`, shared with the vendor's reject.
   After commit, any leftover reservation is released. Verified at 59 s / 61 s, with a prepaid order
   checked out 300 s earlier but placed 50 s earlier (succeeds), and with 5 concurrent cancels
   (stock restored once, one event).

**Error envelope** `{ error: { code, message, details? } }` (`errorBodySchema`, emitted by
`http/errors.ts`). Clients branch on `code`:

| HTTP            | codes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400             | `VALIDATION_FAILED` (details.issues), `MALFORMED_REQUEST`, `INVALID_CART`, `INVALID_PAYMENT_CALLBACK`, `INVALID_CURSOR` (wallet ledger, admin DLQ, product lists)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 401 / 403       | `UNAUTHENTICATED` / `FORBIDDEN`; auth: `OTP_INVALID` (details.attempts_remaining), `REFRESH_TOKEN_INVALID`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 404             | `NOT_FOUND`, `ORDER_NOT_FOUND`, `PAYMENT_NOT_FOUND`, `VENDOR_NOT_FOUND`, `DEAD_LETTER_NOT_FOUND`, `CATEGORY_NOT_FOUND`, `PRODUCT_NOT_FOUND`, `DELIVERY_NOT_FOUND`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 409             | `INSUFFICIENT_STOCK` (details.shortfalls), `IDEMPOTENCY_KEY_REUSED`, `WRONG_PAYMENT_METHOD`, `ORDER_NOT_PAYABLE`, `ORDER_STATE_CONFLICT` (also: reviewing an order that is not DELIVERED, details.state), `CHECKOUT_IN_PROGRESS`, `PAYMENT_AMOUNT_MISMATCH`, `PAID_AFTER_SESSION_EXPIRED` (details.order_id, refund_required), `REVIEW_ALREADY_SUBMITTED` (details.review_id), admin: `DEAD_LETTER_ALREADY_REPLAYED`, `VENDOR_STATUS_CONFLICT` (details.status), `WALLET_BELOW_SUSPENSION_LIMIT` (details.wallet_balance_npr, suspension_limit_npr), `RESTORE_STATUS_UNKNOWN`, catalog: `CATEGORY_SLUG_TAKEN` (details.slug), `CATEGORY_CYCLE`, `CATEGORY_IN_USE` (details.child_count, product_count), `PRODUCT_NAME_TAKEN`, deliveries: `DELIVERY_ALREADY_ASSIGNED`, `DELIVERY_STATE_CONFLICT` (details.state) |
| 410             | `RESERVATION_EXPIRED` (SPEC "Session Expired"), `OTP_EXPIRED` (no valid code: never sent, expired, used or burned)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 413 / 415       | `FILE_TOO_LARGE` (details.max_bytes) / `UNSUPPORTED_MEDIA_TYPE` (evidence uploads, product photos)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 422             | `VENDOR_UNAVAILABLE`, `PRODUCT_UNAVAILABLE` (details.product_ids), `BELOW_MINIMUM_ORDER_VALUE`, `COD_NOT_AVAILABLE`, `CANCELLATION_WINDOW_EXPIRED`, `REVIEW_WINDOW_CLOSED`, `DISPUTE_WINDOW_CLOSED`, `CATEGORY_PARENT_NOT_FOUND`, `CATEGORY_TOO_DEEP` (details.max_depth), `CATEGORY_UNAVAILABLE` (details.category_id), `PRODUCT_IMAGE_LIMIT` (details.max_images, current_images)                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 429             | `OTP_RESEND_COOLDOWN` (details.retry_after_seconds), `OTP_ATTEMPTS_EXCEEDED`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 502 / 503 / 500 | `PAYMENT_GATEWAY_ERROR`, `SMS_DELIVERY_FAILED` / `CHECKOUT_BUSY`, `TOP_UP_UNAVAILABLE` / `INTERNAL_SERVER_ERROR`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

**Phase 22 codes** (not in the table above): `404 PAYOUT_NOT_FOUND`; `409 PAYOUT_ALREADY_DECIDED`
(details.status); `422 INSUFFICIENT_BALANCE` (details.requested_npr, available_balance_npr);
`400 INVALID_CURSOR` and `409 IDEMPOTENCY_KEY_REUSED` are reused for payouts.

**Access tokens** (`auth/access-token.ts`, `http/auth.ts`): HS256 only, issuer `hamro-pasal-api`,
audience `hamro-pasal-app`, TTL 900 s, claims `{ sub: user uuid, role }`, `Authorization: Bearer
<jwt>`. Issued by OTP login and by the refresh endpoint (§8A). Development tokens still come from
`apps/api/scripts/mint-dev-token.ts` (`pnpm --filter @hamro-pasal/api token:dev`), which refuses to
run with `NODE_ENV=production`.

### Order state transitions that exist today

Only these code paths change `orders.state`, and each writes `order.state_changed` in the same
transaction (Phase 8), which `/orders` streams to the app (§8B). **Any new transition (the lifecycle
routes) must call `enqueueOrderStateChanged(tx, fromState, updatedRow)`** in its transaction.

| From → to                     | Where                                                                   | Trigger                                    | Outbox event today                                                              |
| ----------------------------- | ----------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------- |
| (new) → PENDING_PAYMENT       | `CheckoutService.checkout`                                              | `POST /api/cart/checkout`                  | `order.state_changed` (from null) + `order.locked` (aggregate = reservation_id) |
| PENDING_PAYMENT → PLACED      | `CheckoutService.claim` (sets `placed_at`)                              | COD checkout, eSewa webhook, Khalti lookup | `order.state_changed` + `order.placed`                                          |
| PENDING_PAYMENT → FAILED      | `PaymentConfirmationService.placeIfPending`                             | paid after the 600 s lock expired          | `order.state_changed` (update + event in one transaction)                       |
| PLACED / PREPARING → CANCELED | `OrderService.cancel`                                                   | `POST /api/orders/:id/cancel` (≤ 60 s)     | `order.state_changed` always; plus `order.canceled_refund_due` if PAID          |
| PLACED → PREPARING            | `VendorOrderService.accept` (Phase 10)                                  | `POST /api/vendors/orders/:id/accept`      | `order.state_changed`                                                           |
| PLACED → CANCELED             | `VendorOrderService.reject` (Phase 10)                                  | `POST /api/vendors/orders/:id/reject`      | `order.state_changed` always; plus `order.canceled_refund_due` if PAID          |
| PREPARING → OUT_FOR_DELIVERY  | `VendorOrderService.dispatch` (Phase 11)                                | `POST /api/vendors/orders/:id/dispatch`    | `order.state_changed`                                                           |
| OUT_FOR_DELIVERY → DELIVERED  | `DeliveryService.complete` (Phase 21; fleet orders, delivery PICKED_UP) | `POST /api/deliveries/:id/complete`        | `order.state_changed` (+ `ledger.mutated` of the settlement journal)            |
| OUT_FOR_DELIVERY → DELIVERED  | `VendorOrderService.deliver` (Phase 11.5)                               | `POST /api/vendors/orders/:id/deliver`     | `order.state_changed` (+ `ledger.mutated` of the settlement journal)            |

### Not implemented (backend)

No routes for: saved-address CRUD, profile (name) editing, refresh-token revocation (the Phase 16 logout only clears the browser cookie), the rest of the rider flow
(gig broadcast by distance, "Reached Location", "Delivery Failed"; accept, pickup and complete exist since Phase 21, §8N), "Accept with Modifications",
reading published reviews, dispute resolution (nothing moves a dispute out of OPEN or the order to `DISPUTED`), refunds, admin
(beyond the Phase 15 DLQ monitor and vendor overrides and the Phase 17 taxonomy and products overview: KYC approval, logistics toggles, platform settings),
a driver app, `/metrics`, rate limiting beyond the per-phone OTP cooldown. Push notifications exist
for order state changes only (Phase 20, §8M; no chat, wallet or rider pushes, no unregister route). The
escalation's SMS is sent (Phase 13) and an IVR call is placed through the **mock** adapter only
(Phase 14; no Twilio / SIP trunk adapter); DLQ replay exists since Phase 15 (§8I); the ghost-customer and
subscription-downgrade timers are placeholders.

## 8Q. Local end-to-end harness (Phase 24)

Tooling for a full manual run on one machine. No table, migration, event, screen or production
behaviour changed. Code: `packages/shared-types/src/env/server-env.ts`,
`apps/worker/src/push/mock-push.ts`, `apps/worker/src/consumers/order-push-notifications.ts`,
`apps/api/src/payments/mock-payment-service.ts`, `apps/api/src/routes/mock-services.ts`,
`apps/api/src/{app,container,server}.ts`, `packages/db/src/scripts/seed.ts`, root `package.json`.

**What the prompt asked vs what was built.**

| Prompt said                                                   | Built                                                                                                                                                                         |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| create `docker-compose.yml` (e.g. `postgis/postgis:15-3.3`)   | **Kept the existing file** (Phase 1): `postgis/postgis:16-3.5-alpine` (SPEC: PostgreSQL 16+), `redis:7.4-alpine`, `apache/kafka:4.3.1` in KRaft mode, plus topic provisioning |
| `infra:up` = `docker-compose up -d`                           | **Kept** `docker compose up --detach --wait && docker compose run --rm kafka-init`: it also waits for health and creates the topics (auto-create is off)                      |
| seed with "a predictable password (e.g. password123)"         | **No passwords.** SPEC allows only +977 OTP sign-in and `users` has no password column. The predictable part is the phone number; the code is printed by the mock SMS         |
| "1 Customer (with a funded mock wallet if applicable)"        | Not applicable: SPEC has no customer wallet (customers pay by COD, eSewa or Khalti)                                                                                           |
| 1 vendor with 5 products                                      | The seeded Thamel shop went from 3 to **5** products; the other seeded accounts were kept                                                                                     |
| `"dev:all": "turbo run dev"`                                  | `turbo run dev --concurrency=20`: there are 10 persistent `dev` tasks and Turbo refuses to start them at its default concurrency of 10 (the plain `pnpm dev` fails this way)  |
| `if (process.env.NODE_ENV !== 'production')` on mock branches | Done, in three layers (below)                                                                                                                                                 |

**The switch.** `MOCK_SERVICES` (`z.stringbool()`, default `false`) in `serverEnvSchema`.
`mockServicesEnabled(env)` = `MOCK_SERVICES && NODE_ENV !== 'production'` is the one predicate.

| With `MOCK_SERVICES=true` | Effect                                                                                                                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SMS (API and worker)      | `parseServerEnv` returns `SMS_PROVIDER: 'MOCK'` whatever `.env` says (the dev `.env` has SPARROW): `[sms:mock] to +977…: Hamro Pasal: your login code is 123456. …` in the API log |
| IVR (worker)              | `IVR_PROVIDER: 'MOCK'`: `[ivr:mock] Calling +977…` for a 90 s escalation                                                                                                           |
| Push (worker)             | `pushGatewayFromEnv` → `MockPushGateway` (ok tickets, **no request to exp.host**) and one log line per push                                                                        |
| Payments (API)            | `POST /api/test/mock-payment` is mounted; the API logs a warning at boot and `[MOCK PAYMENT] <gateway> order <id>: PAID, PLACED` per call                                          |

- Not covered by the switch: `WALLET_TOP_UP_MODE` (set it to `MOCK` separately to try "Pay
  outstanding balance") and Khalti's `initiate` (a real HTTP call to Khalti; see below).
- The provider credentials in `.env` are still validated for the provider named there.

**Production guard (three layers).**

1. `parseServerEnv` refuses `MOCK_SERVICES=true` with `NODE_ENV=production`: API and worker do not boot.
2. `buildContainer` creates `MockPaymentService` only when `config.mockServices === true &&
process.env.NODE_ENV !== 'production'`; the worker picks the mock gateway and log through
   `mockServicesEnabled`.
3. `createApp` mounts `/api/test` only when `process.env.NODE_ENV !== 'production' &&
services.mockPayments !== undefined`. Unmounted, the path reaches the catch-all: `404 NOT_FOUND`.

**Mock push.** The line is written by the consumer, per recipient, so it appears **whether or not a
device is registered** (a phone without FCM / APNs credentials registers no token):

```
[MOCK PUSH] -> Vendor 71ee8ed6-…: {"priority":"high","_contentAvailable":true,"data":{"type":"order.state_changed","order_id":"a8d536c3-…","state":"PLACED","audience":"VENDOR","data_only":true,"title":"New order","body":"Order #2B3719 is waiting. Open the app to accept or reject it."}}
[MOCK PUSH] -> User 0c1d…: {"title":"Order accepted","body":"The shop is preparing order #2B3719.","sound":"default","priority":"high","channelId":"orders","data":{…}}
```

`Vendor <id>` is `vendors.id`, `User <id>` the customer's `users.id`; the payload is the Expo
message without its `to`. The `[sms:mock]` fallback line of Phase 20 is still logged beside it.

**Mock payment.** `POST /api/test/mock-payment`, no token, body `{ "order_id": "<uuid>" }`.

```
curl -X POST http://localhost:4000/api/test/mock-payment -H "Content-Type: application/json" -d "{\"order_id\":\"<ORDER_ID>\"}"
PowerShell: Invoke-RestMethod -Method Post -Uri http://localhost:4000/api/test/mock-payment -ContentType application/json -Body '{"order_id":"<ORDER_ID>"}'
```

- **eSewa order:** builds the success callback eSewa would send (`status: COMPLETE`, the order's
  total, its `transaction_uuid`), signs it with `ESEWA_SECRET_KEY` and passes it to the real
  `EsewaService.handleCallback`: HMAC check, amount check under the row lock, escrow capture, lock
  claim, PLACED, the outbox events. **Khalti order:** skips only Khalti's server-side lookup and calls
  the same `PaymentConfirmationService.confirm`.
- An order whose payment was never started in the app has no gateway reference; one is assigned
  (a uuid, or `mock-pidx-<uuid>`). A reference stored by the app's `initiate` is reused.
- 200 `paymentStatusResponseSchema` (`status` COMPLETE / Completed, `payment.duplicate` true on a
  repeat: one escrow credit however often it is called). `409 WRONG_PAYMENT_METHOD` for a COD order,
  `404 ORDER_NOT_FOUND`, `400 VALIDATION_FAILED`, and `409 PAID_AFTER_SESSION_EXPIRED` (order FAILED +
  PAID) once the 600 s lock is gone, exactly like a late real callback.
- **Where the order id comes from:** the checkout response; on a device, the newest row of
  `select id, state, payment_method from orders order by created_at desc limit 1`
  (`docker compose exec postgres psql -U hamro_pasal -d hamro_pasal -c "…"`).
- **On the device:** check out with **eSewa** (its `initiate` makes no server-side network call; the
  WebView opens eSewa's UAT page), run the command, and within 5 s the app's lock-status poll sees
  PLACED and opens the tracking screen. With Khalti the app's `initiate` calls Khalti and fails
  without sandbox keys; the order stays payable and the command still works.

**Seed accounts** (`pnpm db:seed`; sign in with the number, the code is in the API log):

| Role        | Phone      | Notes                                                                                                                                                                 |
| ----------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Super Admin | 9800000099 | web dashboard, http://localhost:5173                                                                                                                                  |
| Vendor      | 9800000011 | Thamel Kirana Pasal: LIVE, 10 % commission, SELF_DELIVERY, MOV 500, fee 50. **Five products**: Wai Wai 600, Basmati Rice 1150, Ilam Tea 450, Masoor Dal 220, Ghee 750 |
| Vendor      | 9800000012 | Patan Organic Store: PLATFORM_FLEET (use this shop to exercise the rider), CITY_WIDE Lalitpur, MOV 800                                                                |
| Customer    | 9800000001 | Aarav (Thamel). 9800000002 is Sita (Pulchowk, Lalitpur)                                                                                                               |
| Rider       | 9800000021 | Bikash                                                                                                                                                                |

`seedThamelCatalogue` adds the two new products idempotently (`ON CONFLICT (vendor_id, name) DO
NOTHING`) on an already seeded database too; `seedTaxonomy` maps them to their categories.

**Run order.** `.env`: `MOCK_SERVICES=true`; `apps/mobile/.env`: `EXPO_PUBLIC_API_URL=http://<LAN IP>:4000`.

```
corepack enable pnpm
pnpm install
pnpm infra:up        # Postgres + PostGIS, Redis, Kafka (+ topics), Prometheus
pnpm db:migrate
pnpm db:seed
pnpm dev:all         # API :4000, worker, admin :5173, Expo
```

Under Turbo the Expo terminal is not interactive (no `a` / `r` keys); run
`pnpm --filter @hamro-pasal/mobile dev` in its own terminal for those, and the development build
is still required (§3).

**Tests.**

- shared-types `server-env.test.ts` (+2): off by default, refused in production, SMS / IVR answered
  as MOCK only while on.
- Worker `push/mock-push.test.ts` (8): ok tickets and no `fetch`; the line for vendor and customer;
  the gateway and the log chosen only with the switch outside production; through the real
  consumer: vendor line with the data-only payload, customer line, both sides of a cancellation,
  logged without a registered device.
- API integration `mock-payment-api.int.test.ts` (11, real Express + PostgreSQL + Redis): eSewa
  never initiated / already initiated, Khalti without a lookup, repeat and 5 simultaneous calls →
  one escrow credit, expired lock, COD refused and untouched, 404 / 400, **and the guard: 404
  without the switch, 404 with `NODE_ENV=production` although the switch is asked for, 404 from a
  production process handed a container that still carries the service**. Mutation-checked:
  dropping the `process.env.NODE_ENV` check in `createApp` fails the last one.
- **Two order-dependent tests fixed** (both exposed by the new suite's extra fixtures and run
  order, neither a product defect): `e2e-lifecycle` placed its shop at the fixtures' default
  location, where the shared test database now holds more than the feed's 100-per-section cap
  (it is now at the customer's pin); `admin-vendors-api` read two outbox rows without an
  `ORDER BY` (now by `occurred_at`).
- **Live run (local Docker, API + worker started with `MOCK_SERVICES=true`, driven by a script over
  HTTP; not a device):** OTP for 9800000001 read from the API log, the menu showed five products,
  eSewa checkout → `PENDING_PAYMENT`, mock payment → `PLACED` + `PAID`, the worker printed the
  `[MOCK PUSH] -> Vendor …` line for that order; the order was then cancelled inside the 60 s
  window. That cancelled, refund-flagged order (3 × Masoor Dal) is left in the dev database.
- `pnpm dev:all` itself was not started (it needs an interactive terminal for Expo); Turbo's
  persistent-task limit behind the `--concurrency` flag was reproduced.

## 8P. End-to-end audit and failure-mode hardening (Phase 23)

The last planned phase. It adds tests, seven indexes and one startup check; **no route, table,
column, event or screen changed**. Code: `apps/api/test/e2e-lifecycle.int.test.ts`,
`apps/api/test/inventory-stress.int.test.ts`, `packages/db/test/foreign-key-indexes.int.test.ts`,
`packages/db/drizzle/0020_audit_indexes.sql` (+ the four schema files),
`packages/shared-types/src/env/server-env.ts`.

**What "feature development is 100 % complete" means here.** Every phase that was planned and
requested (0–23) is built, tested and documented. It does **not** mean SPEC.md is fully implemented.
Still unbuilt from SPEC: the 8-minute ghost-customer timer and "Delivery Failed", "Reached Location",
gig broadcast by distance, "Accept with Modifications" (partial fulfilment + partial refund), the
3-minute vendor acceptance window, the Emergency Rider override, refunds actually paid through
eSewa / Khalti, dispute resolution, KYC approval, the subscription lock-in and midnight downgrade,
a real IVR provider, Cloudflare R2 and image compression, the eSewa app-to-app intent, the Mapbox
pin-drop, Sentry / APM / Winston, the CI/CD and EAS pipelines, and refresh-token rotation. And
**nothing has run on a physical device** (§13).

### 8P.1 End-to-end lifecycle (`e2e-lifecycle.int.test.ts`, 8 steps, real Express + PostgreSQL + Redis)

One prepaid order from a PLATFORM_FLEET shop at 10 % commission, 2 × 500 NPR + 50 NPR fee = 1050 NPR.
Every step is an HTTP request with the role's own token, parsed with the shared-types response schema;
the steps share state and run in order.

| #   | Actor    | Calls                                                                                                        | Asserted                                                                                                                                                                                                 |
| --- | -------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | customer | `GET /api/categories`, `GET /api/products?category_id=`, `GET /api/vendors`, `GET /api/vendors/:id/products` | the category, the product with `stock_quantity` 10, the shop in the serviceable section, the menu                                                                                                        |
| 2   | customer | `POST /api/cart/checkout` (ESEWA), `GET /api/cart/lock-status`                                               | 201 PENDING_PAYMENT, total 1050, a 4-digit code, lock ACTIVE with 590–600 s left, PostgreSQL stock still 10                                                                                              |
| 3   | customer | `POST /api/payments/esewa/initiate`, `POST /api/payments/esewa/webhook` (signed with the UAT key)            | PLACED + PAID, **stock 8**, SYSTEM_ESCROW +1050, vendor wallet still 0                                                                                                                                   |
| 4   | vendor   | `GET /api/vendors/orders`, `POST …/accept`                                                                   | the order listed, PREPARING                                                                                                                                                                              |
| 5   | vendor   | `POST …/dispatch`                                                                                            | 422 inside the 60 s window; after it OUT_FOR_DELIVERY and one OFFERED delivery with no rider                                                                                                             |
| 6   | rider    | `POST /api/deliveries/:id/accept`, `GET /api/deliveries`, `POST …/pickup`                                    | ASSIGNED and `assigned_to_me`, PICKED_UP, `orders.driver_user_id` = the rider                                                                                                                            |
| 7   | rider    | `POST …/complete { delivery_otp }`, then the customer's `GET /api/orders/:id`                                | DELIVERED, hash erased, **one** settlement journal: vendor +900, rider +50, PLATFORM_REVENUE +100, escrow back to its starting balance; the five `order.state_changed` events in order                   |
| 8   | operator | the manual reconciliation, twice; the vendor's `GET /api/vendor/finance/ledger` before and after             | `reconciled_at` stamped, still one journal, wallet still 900 (**nobody paid twice**), the order under `reconciled_orders` with cut 900, `unreconciled_order_count` 1 → 0; the second run changes nothing |

- **Mapping to the prompt's wording.** "Wallet authorized" is read as the customer's payment being
  captured into escrow (step 3): no customer wallet exists in SPEC. "Settle the ledger" at midnight is
  Phase 22's verify-and-stamp: the money moved in step 7's commit, and step 8 proves the cron does not
  move it again.
- **The reconciliation is run as the documented manual command**, in its own process:
  `node <tsx cli> src/scripts/reconcile-orders.ts` with `cwd` = `apps/worker`, i.e. exactly what
  `pnpm --filter @hamro-pasal/worker reconcile:orders` runs, minus the `.env` file: the test passes
  every server variable itself and points `DATABASE_URL` at the API test database. The API package
  does not import worker code.
- **The one shortcut:** the test does not wait 60 s. It first proves the dispatch is refused (422),
  then moves `placed_at` 61 s back with the existing `backdatePlacement` fixture.
- Not covered by this file (each has its own suite): COD, Khalti, SELF_DELIVERY, cancellation,
  wrong codes, sockets, Kafka fan-out, push, SMS. The outbox rows are asserted; no relay runs.
- The reconciliation command scans the **whole** test database, so in a full run it also processes
  DELIVERED fixture orders that earlier suites left behind (it reconciles some and logs
  discrepancies for the rest). The file asserts only on its own order, and measures the shared
  escrow and revenue accounts before that step.

### 8P.2 Concurrency stress (`inventory-stress.int.test.ts`, 2 tests)

100 customers, one product, 100 simultaneous `POST /api/cart/checkout` (COD, so each success is
claimed in the same request) against one listening server: the stock guard, the Redis 600 s lock
(WATCH / MULTI / EXEC) and the guarded decrement together.

| Test             | Stock | Requests        | Result (every run so far)                                                                                                                             |
| ---------------- | ----- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| exact sell-out   | 5     | 100 × 1 unit    | **5 × 201 (all PLACED), 95 × 409, every refusal `INSUFFICIENT_STOCK`, `products.stock_quantity` = 0**, 5 order lines of 1 unit, no hold left in Redis |
| mixed quantities | 25    | 100 × 1–4 units | only 201 / 409; units sold + stock left = 25; stock ≥ 0; the subtotals answered = the units sold; no hold left in Redis                               |

- No `503 CHECKOUT_BUSY` and no 500 appeared: the lock's retry budget was enough for 100 contenders
  on one SKU with the test app's 10 Redis and 30 PostgreSQL connections.
- **Mutation-checked:** availability computed without the live holds → 19 orders instead of 5 (both
  tests fail). Removing the Phase 17 stock guard alone does **not** fail it, as expected: the Redis
  lock is the layer that decides between concurrent customers (§8K).
- **Finding (not a defect of correctness, left as designed): a short under-allocation window.**
  The claim commits the PostgreSQL decrement and only then deletes its Redis hold. In between, another
  checkout counts that unit twice (stock already lowered, hold still there) and can be refused although
  a unit is free. It can never oversell. In the sell-out test the refused customer is one of 95 who
  would be refused anyway, so the count stayed at exactly 5 in every run; **in theory the last unit
  could stay unsold if the final request of a burst lands in that window**, which would show as 4
  orders and stock 1. Not observed. Releasing the hold first would trade this for an oversell attempt
  caught only by the guarded decrement (after the order row exists), so the order was kept.

### 8P.3 Index audit and migration 0020

Method: a catalog query over `pg_constraint` (every foreign key) against `pg_index` (a valid index
whose leading columns are the key's columns), run on the migrated dev database. It is now a test,
`foreign-key-indexes.int.test.ts`, so **a future foreign key without an index fails CI**.

| Foreign key (all `ON DELETE RESTRICT`)    | Parent              | Index added                                   | Partial       |
| ----------------------------------------- | ------------------- | --------------------------------------------- | ------------- |
| `orders.driver_user_id`                   | users               | `orders_driver_user_id_idx`                   | yes           |
| `disputes.opened_by_user_id`              | users               | `disputes_opened_by_user_id_idx`              | no (NOT NULL) |
| `disputes.resolved_by_user_id`            | users               | `disputes_resolved_by_user_id_idx`            | yes           |
| `chat_messages.sender_user_id`            | users               | `chat_messages_sender_user_id_idx`            | no (NOT NULL) |
| `payout_requests.reversal_transaction_id` | ledger_transactions | `payout_requests_reversal_transaction_id_idx` | yes           |
| `payout_requests.decided_by_user_id`      | users               | `payout_requests_decided_by_user_id_idx`      | yes           |
| `dead_letter_events.retry_requested_by`   | users               | `dead_letter_events_retry_requested_by_idx`   | yes           |

- **Why it matters:** deleting a parent row (or changing its key) makes PostgreSQL look for
  referencing rows in each child table; without an index that is a sequential scan per child table,
  done while the parent row is locked. Six of the seven guard deletes from `users`.
- **The prompt's two examples were already covered:** `orders` has no `user_id`; its customer column
  `customer_id` has `orders_customer_id_idx` (Phase 2), and `deliveries.rider_id` leads
  `deliveries_rider_id_state_idx` (Phase 21). Every other foreign key (23 of the 30) was already led by an
  index or a unique constraint.
- Partial indexes hold only the rows that name a parent. The foreign key check filters on
  `column = $1`, which implies `IS NOT NULL`, so the planner can use them (tested with `EXPLAIN`
  on `orders.driver_user_id`).
- `orders_driver_user_id_idx` also serves a future "this rider's orders" query; nothing reads it
  that way yet.
- `dead_letter_events.replay_of_id` is a plain uuid, not a foreign key, and was left without an index.
- **Deploy note:** the indexes are built with plain `CREATE INDEX` (Drizzle runs all pending
  migrations in one transaction, so `CONCURRENTLY` is impossible there). Writes to each table wait
  while its index builds: instant on today's data, a short write stall on a large `orders` table.
- Tests (db, +3): no foreign key without a leading index; the seven indexes exist with the right
  partial / full shape; the `EXPLAIN`.

### 8P.4 JWT secret isolation audit

| Checked                    | Result                                                                                                                                                                                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two keys                   | `JWT_ACCESS_SECRET` signs only access tokens, `JWT_REFRESH_SECRET` only refresh tokens (`auth/access-token.ts`, `auth/refresh-token.ts`); `parseServerEnv` refuses equal values and anything under 32 characters                                                      |
| Cross-use                  | each verifier pins HS256, the issuer and **its own audience** (`hamro-pasal-app` / `hamro-pasal-refresh`); the refresh token also needs `typ: refresh`. A token of one kind fails the other verifier on the key **and** the audience (tested both ways since Phase 7) |
| Where the refresh key goes | only `OtpAuthService` (sign at verify, verify at refresh). Request authentication (`requireAuth`) and both Socket.io namespaces receive the access key only                                                                                                           |
| Derived keys               | the OTP digest pepper is `HMAC-SHA256(JWT_ACCESS_SECRET, "hamro-pasal:otp-digest:v1")`: domain-separated, the JWT key itself is never used as the pepper                                                                                                              |
| Logging                    | no `console.*` call prints a secret or a token; `token:dev` prints a token on purpose and refuses to run in production                                                                                                                                                |
| Repository                 | `.env` is git-ignored; `.env.example` has empty secret values                                                                                                                                                                                                         |

- **Added:** `parseServerEnv` now also refuses a JWT secret equal to `ESEWA_SECRET_KEY` or
  `KHALTI_SECRET_KEY` ("Must differ from …"), so one leaked key can never be both a signing key and a
  gateway key (shared-types, +1 unit test).
- **Left as found (reported, not changed):**
  - the **worker** parses the same `serverEnvSchema`, so it must be given both JWT secrets although
    no worker code reads them. Strict isolation would give the worker its own schema without them;
  - rotating `JWT_ACCESS_SECRET` also changes the OTP pepper (outstanding login codes die; harmless,
    they last 2 minutes);
  - keys are static: no `kid`, no rotation with overlap, and refresh tokens still cannot be revoked
    (§13, backlog item 2).

## 8O. Financial reconciliation and payouts (Phase 22)

SPEC §5 (Financial Governance: escrow, double-entry ledger), infrastructure §1 (midnight cron) and
§5 (audit records). Code: `packages/ledger`, `packages/db/src/schema/payouts.ts` (migration 0019),
`packages/shared-types/src/api/finance.ts`,
`apps/api/src/finance/{vendor-finance-service,admin-payout-service}.ts`,
`apps/api/src/routes/{vendor-finance,admin}.ts`, `apps/worker/src/finance/order-reconciliation.ts`,
`apps/worker/src/queues/processors.ts`, `apps/admin/src/features/{finance,vendor-portal}`.

```
delivery handoff (unchanged) ─ same tx ─▶ DELIVERED + journal "order-settlement:<order>" (vendor wallet moves here)

midnight (00:00 Asia/Kathmandu) ─ BullMQ midnight-maintenance {task: ORDER_RECONCILIATION}
  for each order: state = DELIVERED AND reconciled_at IS NULL      (keyset on id, batches of 200)
    BEGIN ─ SELECT order FOR UPDATE ─ still DELIVERED and unreconciled? (else skip)
          ─ expected = vendor posting of planSettlement(order)       (subtotal − stored commission [+ fee])
          ─ journal missing? ─▶ SettlementService.settleOrderInTransaction   (same idempotency key)
          ─ actual = the journal's posting to the vendor wallet
          ─ actual = expected ─▶ UPDATE orders SET reconciled_at = now() ─ COMMIT
          ─ otherwise ─▶ ROLLBACK, audit line "order.reconciliation_discrepancy", next order

vendor POST /api/vendor/finance/payout {idempotency_key, amount_npr}
  BEGIN ─ SELECT vendor FOR NO KEY UPDATE ─ replay of the key? ─ amount ≤ wallet_balance_npr?
        ─ journal VENDOR_PAYOUT: VENDOR_WALLET −X, PAYOUT_CLEARING +X ─ INSERT payout_requests (PENDING) ─ COMMIT
admin  POST /api/admin/finance/payouts/:id/approve {bank_reference}   PENDING → APPROVED (no journal)
admin  POST /api/admin/finance/payouts/:id/reject  {reason?}          PENDING → REJECTED
        ─ journal VENDOR_PAYOUT_REVERSAL: PAYOUT_CLEARING −X, VENDOR_WALLET +X (same tx)
```

**User decisions (asked before building).**

| Prompt said                                                                          | Built                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a `ledgers` / `vendor_balances` table with `available_balance` and `pending_balance` | **No balance table** (SPEC §5: "Single-entry wallet tables are prohibited"). `available_balance_npr` = `vendors.wallet_balance_npr` (the VENDOR_WALLET projection); `pending_balance_npr` = the Phase 12 pending escrow |
| the cron calculates the vendor's cut and adds it to `available_balance`              | **Verify and mark.** Settlement stays in the delivery's commit (Phase 11); the cron checks that journal, posts it only if it is missing, and stamps `reconciled_at`. Crediting again would have paid vendors twice      |
| approval "deducts from ledger"                                                       | **Hold at request.** The amount leaves the wallet when it is requested; approval records the bank reference; a **reject route was added** to post it back                                                               |
| "total minus a flat 10% platform commission" (an example)                            | the order's stored `platform_commission_amount` (the vendor's rate at checkout; 0 for SUBSCRIPTION). Not asked: SPEC §4                                                                                                 |
| "mark the orders as RECONCILED"                                                      | column `orders.reconciled_at`; SPEC's `OrderState` enum is unchanged. Not asked                                                                                                                                         |

**The reconciliation worker** (`OrderReconciliationService`, task `ORDER_RECONCILIATION`).

- **Scheduling.** `midnightTasks` gained `ORDER_RECONCILIATION`, so `registerMidnightJobs` upserts a
  third scheduler, `order-reconciliation` (`0 0 * * *`, Asia/Kathmandu, 3 attempts), on the existing
  `midnight-maintenance` queue. The handler is `runOrderReconciliation`.
- **Manual run:** `pnpm --filter @hamro-pasal/worker reconcile:orders` runs the same function once
  against `DATABASE_URL` without BullMQ or a running worker (safe beside the scheduled job). Or add a
  job `{ task: 'ORDER_RECONCILIATION' }` to the queue (what the integration test does).
- **One transaction per order**, so one bad order never rolls back the others. Inside it the order
  row is locked `FOR UPDATE` and re-checked (still DELIVERED, `reconciled_at` still null): a second
  run, a retried job or two workers queue on the lock and then skip.
- **The vendor's cut** is the VENDOR_WALLET posting of `planSettlement(order)`: prepaid → subtotal −
  commission (+ the delivery fee on SELF_DELIVERY); COD fleet → subtotal − commission; **COD
  self-delivery → −commission** (the shop already holds the cash; SPEC §5 "The COD Problem"); a 0 %
  COD self-delivery order → 0 (no journal exists and none is needed).
- **A missing journal is posted** through `SettlementService.settleOrderInTransaction` (the delivery's
  own code path, now in `@hamro-pasal/ledger`), with the order's idempotency key
  `orderSettlementKey(order.id)`, so a settlement exists at most once whoever posts it. In
  production the delivery always posts it first; this covers orders set DELIVERED outside the
  handoff. It goes through `WalletService`, so a COD commission debit can still suspend the vendor.
- **Double counting is prevented three ways:** the order row lock + re-check, the ledger's unique
  idempotency key, and the fact that an existing journal is only compared, never added to.
- **Discrepancies** are returned, not thrown: `SETTLEMENT_MISMATCH` (the journal's vendor posting
  differs from the order snapshot; expected and actual amounts reported) and `SETTLEMENT_FAILED` (no
  journal and none could be posted: a prepaid order never captured, a fleet order without a rider,
  a database refusal). The order's transaction is rolled back, `reconciled_at` stays null, one JSON
  line is logged (`{"audit":"order.reconciliation_discrepancy","order_id","vendor_id","reason",
"expected_vendor_wallet_npr","actual_vendor_wallet_npr","message"}`), and **the job still
  succeeds** (a failed job would be retried at once by BullMQ; the next night tries the order again).
  A failure of the scan itself fails the job.
- Summary log: `[worker] order reconciliation: N order(s) reconciled (M settlement(s) posted), K
discrepancy(ies)`. No outbox event is written for a reconciliation (a posted settlement writes the
  usual `ledger.mutated`).

**Balances** (`VendorFinanceService.ledgerView`, one REPEATABLE READ read-only snapshot).

| Field                      | Source                                                                                                                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `available_balance_npr`    | `vendors.wallet_balance_npr`. May be negative (COD commission debt); only a positive balance can be withdrawn                                                                    |
| `pending_balance_npr`      | `pendingEscrowOf`: the vendor's share of prepaid, PAID orders in PLACED / PREPARING / OUT_FOR_DELIVERY / DISPUTED                                                                |
| `pending_payout_npr`       | sum of the vendor's PENDING `payout_requests` (already out of the available balance)                                                                                             |
| `unreconciled_order_count` | DELIVERED orders with `reconciled_at` null                                                                                                                                       |
| `reconciled_orders`        | the 20 most recently reconciled: amounts, `vendor_cut_npr` (what the order earned the shop) and `wallet_amount_npr` (what the journal posted; −commission for COD self-delivery) |
| `payouts`                  | the vendor's 20 newest requests (`PayoutView`: no admin id)                                                                                                                      |

- **Earnings are withdrawable from delivery, not from reconciliation**: the wallet is credited in
  the delivery's commit, and the payout check reads the wallet. Reconciliation is the audit of that
  credit (decision; §12).

**Payout state machine.**

```
            request (amount ≤ wallet, held by journal VENDOR_PAYOUT)
                 │
                 ▼
             PENDING ── approve {bank_reference} ──▶ APPROVED   final; money stays in PAYOUT_CLEARING
                 │
                 └───── reject {reason?} ─────────▶ REJECTED   final; VENDOR_PAYOUT_REVERSAL returns it
```

| Step    | Who               | Under                          | Effect                                                                                                                         | Repeat / refusals                                                                                                                                                       |
| ------- | ----------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| request | VENDOR (own shop) | vendor row `FOR NO KEY UPDATE` | journal `vendor-payout:<vendor>:<key>` (VENDOR_WALLET −X, PAYOUT_CLEARING +X) + the PENDING row, one commit                    | same key + same amount → 200 `replayed`, no second hold; same key, other amount → `409 IDEMPOTENCY_KEY_REUSED`; X > wallet → `422 INSUFFICIENT_BALANCE`, nothing stored |
| approve | SUPER_ADMIN       | request row `FOR UPDATE`       | APPROVED, `bank_reference`, `decided_by_user_id`, `decided_at`. **No journal**: the amount left the wallet at the request      | APPROVED with the same reference → 200 same row; another reference, or REJECTED → `409 PAYOUT_ALREADY_DECIDED`                                                          |
| reject  | SUPER_ADMIN       | request row `FOR UPDATE`       | journal `vendor-payout-reversal:<request id>` (PAYOUT_CLEARING −X, VENDOR_WALLET +X) + REJECTED, reason, who, when, one commit | REJECTED → 200 same row (the reason is not changed, no second credit); APPROVED → 409                                                                                   |

- **Why concurrent requests cannot overdraw:** every request of one vendor first takes that vendor's
  row lock (the lock every wallet journal takes, `WalletService.lockStandings`), then reads the
  balance, then posts. A second request waits and reads the balance the first one committed.
  Tested: 10 simultaneous requests of 300 on a 1000 balance → exactly three 201s and seven 422s,
  balance 100; 6 simultaneous requests for the whole balance → one 201.
- **Approve vs reject race:** both lock the request row and re-read its status, so exactly one wins
  (tested 8 rounds) and the money is never both paid out and returned.
- A payout never suspends a vendor (the balance stays ≥ 0), and a rejection's credit goes through
  `WalletService` like any other. Any vendor status may read the ledger and request a payout
  (a SUSPENDED shop's positive balance is still its money).
- Both journals appear in the vendor's wallet ledger (`GET /api/vendors/wallet/ledger`) as
  `entry_type` **`PAYOUT_HOLD`** and **`PAYOUT_REVERSAL`** (two new `walletEntryTypes`; the mobile
  wallet screen got their EN / NE labels).
- **Audit:** each decision logs one JSON line after its commit (`console.warn`,
  `{"audit":"payout.approved" | "payout.rejected","payout_id","vendor_id","amount_npr",
"bank_reference","admin_user_id","decided_at"}`); a repeated decision logs nothing. The journals
  write `ledger.mutated` as always. **No new domain event** and no SMS / push to the vendor.
- **The bank transfer itself is not made by the system.** Approve only records the reference an
  admin types after paying the vendor outside the platform.

**`@hamro-pasal/ledger`.** The worker has to post a missing settlement with exactly the API's code,
so `money.ts`, `settlement-plan.ts` (+ its 11 unit tests), `ledger-service.ts`,
`settlement-service.ts` and `wallet-service.ts` moved (`git mv`) to `packages/ledger/src`. The old
API paths are **one-line re-exports**, so no importer changed. `AccountRef` gained
`{ type: 'PAYOUT_CLEARING' }`. API and worker depend on the package; **rebuild it after editing**
(`pnpm build`), like every workspace package.

**Web app.**

- **Payouts tab** (Super Admin, `#/payouts`): status chips (opens on **Pending**), a card per request
  (amount, shop, phone, the wallet now, requested / decided times, bank reference or reason).
  **Approve** asks for the bank transfer reference (required, checked with the API's schema);
  **Reject** asks for an optional reason. A decided card is patched into the cached pages, then the
  list is refetched; a 409 says the request was already decided. "Load older" pages with the cursor.
- **Earnings tab** (Vendor Portal, `#/earnings`; the portal now has two tabs, `VENDOR_TABS`): the
  four figures, an amount field + **Request payout** (disabled without a positive balance; the
  amount is checked against the shown balance, the server decides again), the payout requests and
  the reconciled orders. **One idempotency key per attempt**, kept across a network failure so a
  retry cannot hold the amount twice, and dropped after a success or a server refusal.

**Tests.**

- shared-types `api/finance.test.ts` (9): the request (paisa, limits, no vendor id or status), the
  admin bodies and query, view strictness, the new enum values.
- ledger: `settlement-plan.test.ts` (11, moved from the API).
- Worker unit `queues.test.ts` (+3): the handler audits discrepancies without failing the job, a
  failed scan fails it, other tasks do not reconcile.
- Worker integration `order-reconciliation.int.test.ts` (13, **real PostgreSQL + BullMQ, the real
  SettlementService**): **1000 NPR at 10 % → the vendor's wallet +900 and revenue +100**; the stored
  commission is used (75.50 → 924.50); + fee for SELF_DELIVERY and not for a fleet order; COD
  self-delivery −100 and the order marked PAID; a 0 % order reconciled with nothing posted; **an
  order the delivery already settled is not credited again**; a second run changes nothing and keeps
  the first timestamp; **6 simultaneous runs over 3 orders → one winner per order, one journal each,
  2700 in the wallet**; PLACED orders untouched; the CHECK; a mismatch reported with 800 expected vs
  900 posted and left unreconciled; an uncaptured prepaid order reported while the next order is
  still reconciled; the job through BullMQ.
- API integration `vendor-finance-api.int.test.ts` (15): empty ledger; available / pending /
  reconciled rows with cut and wallet amount for prepaid, COD and fleet; other shops hidden; roles;
  the hold (wallet, PAYOUT_CLEARING, PENDING row, the wallet ledger's PAYOUT_HOLD entry); exactly the
  balance vs one paisa more; empty and indebted wallets; the second request sees what the first
  left; **the two races**; replay of a key (sequential, 5 at once, 5 first uses at once); key reuse
  and per-vendor keys; nine invalid bodies; roles.
- API integration `admin-payouts-api.int.test.ts` (13): list order, vendor block, status filter,
  paging, bad queries, roles; approve (no further money moves, audit line, the vendor's view),
  repeat vs another reference, 5 simultaneous approvals → one audit line, validation / 404 / roles;
  reject (wallet back, reversal journal, reason, PAYOUT_REVERSAL entry), no body + repeat, the
  returned money can be requested again, validation; finality both ways; **approve vs reject, 8
  rounds**; the table's CHECKs.
- Admin `features/finance.test.ts` (13): tabs, input checks, the amount rule, cache patch, messages,
  the five endpoints' wiring.
- `queues.int.test.ts` expects three schedulers. **Every earlier suite passes unchanged** apart
  from the three files that build `createTimerHandlers` (they pass the new dependency).
- **Mutation-checked** (each fails at least one test): no balance check on a payout (5), the balance
  read without the vendor row lock (3), no replay lookup of the idempotency key (3), the request row
  not locked for a decision (1), approve ignoring an earlier decision (3), a repeated reject posting
  again (1); reconciliation without the re-check under the lock (2), without the order row lock (1),
  without the mismatch comparison (1), not posting a missing settlement (8).
- **Not run live:** the API, the worker and the two web tabs were not started for this phase (tests
  only). The React screens have no component tests, like the other admin screens.

## 8N. Rider dispatch and geolocation telemetry (Phase 21)

SPEC delivery partner flow steps 1, 2 and 5, customer journey 10, implicit requirement 4 and the
tech stack's "WebSockets … for real-time discrete driver tracking updates". Code:
`packages/db/src/schema/deliveries.ts` (migration 0018),
`apps/api/src/deliveries/{delivery-service,rider-location-store}.ts`,
`apps/api/src/routes/deliveries.ts`, `apps/api/src/realtime/rider-telemetry.ts`,
`packages/shared-types/src/realtime/orders-socket.ts`, `packages/shared-types/src/api/responses.ts`,
`apps/mobile/src/features/driver/*` (§9.14).

```
vendor POST /api/vendors/orders/:id/dispatch (fleet order) ─ same tx ─▶ INSERT deliveries (OFFERED, no rider)
rider  GET  /api/deliveries                      open gigs + own ASSIGNED / PICKED_UP
rider  POST /api/deliveries/:id/accept           OFFERED → ASSIGNED, rider_id, orders.driver_user_id
rider  POST /api/deliveries/:id/pickup           ASSIGNED → PICKED_UP
rider  POST /api/deliveries/:id/complete {otp}   PICKED_UP → DeliveryHandoff (orders.delivery_otp) → DELIVERED + settlement

rider socket /orders ─ rider:location {latitude, longitude} ─▶ MULTI
                                                                  GEOADD riders:active <lng> <lat> <rider id>
                                                                  HSET   riders:active:seen <rider id> <epoch ms>
                                                                EXEC ─▶ ack {ok, recorded_at}
API instance, every 5 s:
  order ids of the rooms its own sockets are in (order:{id})
  ─▶ SELECT order_id, rider_id FROM deliveries ⋈ orders        (ASSIGNED | PICKED_UP, order OUT_FOR_DELIVERY)
  ─▶ GEOPOS riders:active <riders…>  +  HMGET riders:active:seen <riders…>   (drop anything older than 120 s)
  ─▶ emit order:rider_location {order_id, latitude, longitude, recorded_at}  to room order:{id}, local sockets only
```

**User decisions (asked before building).**

| Prompt said                                             | Built                                                                                                                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `deliveries` stores a 4-digit `handoff_otp`             | **No code column.** The one doorstep code is SPEC's `orders.delivery_otp` (bcrypt, shown to the customer); completing a delivery verifies it via `DeliveryHandoff` |
| a WebSocket namespace for riders, another for customers | **Both on `/orders`** (SPEC names exactly `/orders` and `/chat`): DRIVER admitted, events `rider:location` and `order:rider_location`                              |
| `POST /api/deliveries/:id/accept` and `…/complete`      | Those, plus **`GET /api/deliveries`** (the rider must find the id) and **`POST …/pickup`** (so PICKED_UP is reachable)                                             |
| (silent on the Phase 11 routes)                         | **`/api/driver/orders` removed**; the only way to deliver a fleet order is its delivery                                                                            |
| states ASSIGNED, PICKED_UP, DELIVERED, FAILED           | plus **OFFERED** (dispatched, no rider yet; not asked of the user: the row has to exist before `/accept` can name it)                                              |

**Delivery lifecycle (`DeliveryService`).** Every step runs in one transaction that locks the
**order row first, then the delivery row** (`FOR UPDATE`), the order the dispatch and the handoff
also use.

| Step       | From → to             | Who                  | Effect                                                                                                       | Repeat / refusals                                                                                                                                                        |
| ---------- | --------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| (dispatch) | – → OFFERED           | the vendor           | `offerDelivery`: `INSERT … ON CONFLICT DO NOTHING` in the dispatching transaction; nothing for SELF_DELIVERY | a repeated dispatch keeps one row                                                                                                                                        |
| accept     | OFFERED → ASSIGNED    | any DRIVER           | `rider_id`, `accepted_at = now()`, `orders.driver_user_id = rider`                                           | own delivery again → 200 same body; another rider's → `409 DELIVERY_ALREADY_ASSIGNED`; unknown → `404 DELIVERY_NOT_FOUND`. 5 riders at once → one 200, four 409 (tested) |
| pickup     | ASSIGNED → PICKED_UP  | the delivery's rider | `picked_up_at = now()`                                                                                       | PICKED_UP → 200 same body; open gig or another rider's → 404 (ids cannot be probed); other state → `409 DELIVERY_STATE_CONFLICT` `details.state`                         |
| complete   | PICKED_UP → DELIVERED | the delivery's rider | `DeliveryHandoff.handOver` (below), then `state = DELIVERED`, `completed_at = now()`, all in one commit      | DELIVERED → 200 same body; ASSIGNED → 409 **before any code is looked at** (no attempt counted); not the rider → 404 (also for the right code)                           |

- No step changes `orders.state` except complete, so accept and pickup write no outbox event and
  nothing is pushed or broadcast for them.
- `GET /api/deliveries`: `deliveries ⋈ orders ⋈ vendors` where the order is OUT_FOR_DELIVERY and the
  delivery is OFFERED or (the caller's and ASSIGNED / PICKED_UP), by `created_at`, capped at 100.
  `DeliveryView` is strict: no customer id, name or phone, no rider id, no hash.
- FAILED is in the enum and the CHECKs but **no code sets it** (the ghost-customer timer is not built).

**OTP verification flow** (customer journey 10; "require a valid handoff OTP to reach DELIVERED").

1. Checkout creates the 4-digit code (CSPRNG), stores its **bcrypt hash** in `orders.delivery_otp`
   and returns the raw code once to the customer's app (encrypted MMKV, shown on the tracking
   screen). Unchanged since Phase 4.
2. `POST /api/deliveries/:id/complete { delivery_otp }`: `requireAuth(DRIVER)`, then the strict body
   (4 ASCII digits, else `400 VALIDATION_FAILED`, nothing counted).
3. Under the order + delivery row locks: the caller must be `deliveries.rider_id` (else 404) and the
   delivery PICKED_UP (else 409).
4. `DeliveryHandoff.handOver(tx, order, otp, riderId)`, the same object the vendor's SELF_DELIVERY
   handoff uses (§8E): order must be OUT_FOR_DELIVERY; a locked order is `429 DELIVERY_OTP_LOCKED`
   even for the right code; `bcrypt.compare`; a wrong code is counted in Redis
   (`delivery-otp:failures:{order}`, 15 min) → `401 INVALID_OTP` `details.attempts_remaining` 4 → 1,
   the 5th → 429.
5. A match: `orders.state = DELIVERED`, `delivered_at = now()`, **`delivery_otp = NULL`** (no replay),
   escrow settled (`settleOrderInTransaction`), `order.state_changed` written, and the delivery row
   closed, in one commit. After it the Redis counter is deleted.

- **Every path to DELIVERED checks the code:** `DeliveryService.complete` (fleet) and
  `VendorOrderService.deliver` (SELF_DELIVERY) are the only code that sets the state, and both go
  through `handOver`. There is **no database trigger** tying `orders.state = DELIVERED` to a
  `deliveries` row (test fixtures still set DELIVERED by hand).
- The row locks serialise guesses (10 concurrent wrong codes → four 401s, six 429s; 5 concurrent
  right codes → one delivery, one settlement journal; tested).

**Redis geospatial architecture (`RiderLocationStore`).**

| Key                  | Type           | Written by                                           | Read by                             |
| -------------------- | -------------- | ---------------------------------------------------- | ----------------------------------- |
| `riders:active`      | geo set (zset) | `GEOADD riders:active <lng> <lat> <rider user id>`   | `GEOPOS riders:active <rider>…`     |
| `riders:active:seen` | hash           | `HSET riders:active:seen <rider user id> <epoch ms>` | `HMGET riders:active:seen <rider>…` |

- **Why Redis, not PostgreSQL:** a position is overwritten every few seconds and is worthless when
  old; nothing durable depends on it (flushing Redis loses no order, as §8A's boundary says).
- **One member per rider**: `GEOADD` on an existing member moves it, so the set holds each rider's
  last report only. Redis takes **longitude first**; the store converts from / to
  `{ latitude, longitude }` (mutation-checked: swapping them fails 17 tests).
- **Staleness without TTLs:** members of a sorted set cannot expire, so the report time is written
  to the hash in the **same `MULTI`** and `latest()` drops anything older than
  `RIDER_LOCATION_MAX_AGE_SECONDS` (120 s). A position is never returned without its age.
- **Precision:** Redis stores a 52-bit geohash; a round trip is exact to under a metre (tests
  compare to 5 decimals).
- **Nothing is ever removed** in production (`remove()` exists and is tested but unused): the set
  grows to one member per rider that ever reported, and old ones are simply ignored. Nothing uses
  `GEOSEARCH` yet either; the set is ready for broadcasting gigs by distance (§11).
- The server clock stamps `recorded_at` (when the report arrived), not the device.

**WebSocket payload contracts** (namespace `/orders`, `packages/shared-types/src/realtime/orders-socket.ts`;
handshake, transports and heartbeat as in §8B).

| Event                  | Direction                  | Payload                                                                                                      | Ack / notes                                                                                                                                                                                               |
| ---------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rider:location`       | rider → server             | `riderLocationRequestSchema` (strict) `{ latitude: number, longitude: number }`, inside `NEPAL_BOUNDING_BOX` | optional ack `riderLocationAckSchema`: `{ ok: true, recorded_at }` or `{ ok: false, error: { code, message } }` with code `VALIDATION_FAILED` \| `FORBIDDEN` \| `RATE_LIMITED` \| `INTERNAL_SERVER_ERROR` |
| `order:rider_location` | server → order's customers | `orderRiderLocationSchema` (strict) `{ order_id, latitude, longitude, recorded_at }`                         | no ack. Carries **no rider id, name or phone**                                                                                                                                                            |

```jsonc
// rider → server
socket.emit('rider:location', { "latitude": 27.7154, "longitude": 85.3123 }, ack)
// ack
{ "ok": true, "recorded_at": "2026-10-03T10:45:00.000Z" }
{ "ok": false, "error": { "code": "RATE_LIMITED", "message": "Position sent too soon" } }
// server → sockets in room order:{order_id}
{ "order_id": "4a1c…", "latitude": 27.7154, "longitude": 85.3123, "recorded_at": "2026-10-03T10:45:00.000Z" }
```

- **The rider is the handshake's token subject.** The strict payload has no rider field (a
  `rider_id` key is `VALIDATION_FAILED`), so nobody can report for someone else. A CUSTOMER or
  VENDOR socket emitting the event gets `FORBIDDEN` and nothing is stored.
- **Rate limit:** one report per connection per `RIDER_LOCATION_MIN_INTERVAL_MS` (1 s, kept in the
  socket's closure, not in Redis); a sooner one is `RATE_LIMITED` and not stored.
- **Any signed-in rider may report**, with or without a delivery (the set is meant for gig
  broadcast later). What a customer can see is decided at push time.
- **Push** (`serveRiderTelemetry`, one `setInterval` per API instance,
  `RIDER_LOCATION_PUSH_INTERVAL_MS` = 5 s, rounds never overlap):
  - the customer subscribes exactly as before (`orders:subscribe`, ownership-checked); there is
    no new subscription event. The push goes to whoever is in `order:{id}`;
  - only an order with a delivery **ASSIGNED or PICKED_UP** and state OUT_FOR_DELIVERY has a rider
    to show: nothing while the gig is open, nothing after delivery (both tested);
  - **one push per report:** a position whose `recorded_at` was already pushed to that room is not
    sent again; a customer who subscribes later gets the rider's last fresh position on the next
    round (tested);
  - emitted with `namespace.local`, so each instance serves its own sockets and nothing is
    duplicated through the Redis adapter. Cost per round per instance: one SQL query and two Redis
    commands, none when no order room exists.
- `RealtimeOptions.riders` (`{ locations, deliveries, pushIntervalMs?, minReportIntervalMs? }`)
  switches it on; `server.ts` passes `container.riderLocations` and `container.deliveries`.

**Tests.**

- shared-types (+6): `orders-socket.test.ts` (event names, the request inside Nepal only and with
  no extra key, the ack codes, the push without identity, the three intervals' order),
  `responses.test.ts` (delivery list and view strictness).
- API integration `deliveries-api.int.test.ts` (35, real Express + PostgreSQL + Redis; replaces
  `driver-orders-api`): dispatch opens one OFFERED row (repeat, SELF_DELIVERY, before dispatch);
  accept (assignment + `driver_user_id`, repeat, second rider 409, **5 riders at once**, 404 / 400,
  roles); pickup (once, hidden from others); complete (delivered + hash erased + delivery closed +
  event, COD and prepaid settlement, retry, 5 concurrent, counter cleared); **the constraints:
  right code before pickup → 409 with no attempt counted, right code from a rider who never
  accepted → 404, from another rider → 404 before and after, the old routes are 404, the table's
  CHECK and unique constraints**; wrong codes (401, neighbours, countdown + lockout, 10 concurrent,
  per order, expiry, roles, validation); the list (open / mine / picked up / others' hidden,
  dropped when completed, no identity, roles).
- API integration `rider-telemetry.int.test.ts` (25, **real Redis GEOADD** + Socket.io with the
  Redis adapter): the key is a zset and GEOPOS returns the position (longitude first) with its
  time in the hash; **GEODIST Thamel–Patan ≈ 4.9 km and GEOSEARCH BYRADIUS 1 km finds only the
  Thamel rider**; one position per rider; several riders and unknown ones; the 120 s bound at
  exactly the boundary; remove; 10 racing reports; then over sockets: stored under the token's
  rider with the acked time, without an ack, six invalid payloads, CUSTOMER / VENDOR refused, the
  rate limit; the push to the order's customer without identity, one push per report, nothing
  for an open gig then starting at accept, never another rider's position, orders kept apart,
  stops at delivery, a late subscriber.
- `orders-realtime.int.test.ts`: SUPER_ADMIN still refused; a rider is admitted and gets no room.
  `vendor-delivery-api.int.test.ts`: its two rider cases now go through `/api/deliveries`.
  **Every other order state machine suite passes unchanged** (orders, vendor orders, vendor
  delivery, payments, cart, ledger settlement, worker).
- Mobile: §9.14.
- **Mutation-checked** (each fails at least one test): complete without the PICKED_UP check (1),
  `lockOwn` ignoring the rider (3), accept ignoring an existing rider (2), dispatch offering no
  delivery (30), latitude / longitude swapped in GEOADD (17), no staleness bound (1), unchanged
  positions re-sent (2), no role check on `rider:location` (2), no rate limit (1). One mutant
  **survives by design**: dropping the delivery-state filter in `ridersOnTheRoad` (an open gig has
  no rider and a finished delivery's order is no longer OUT_FOR_DELIVERY, so two other conditions
  cover it).
- **Not run on a device or with a real GPS;** the API was not started live for this phase.

## 8M. Push notifications: device tokens and order alerts (Phase 20)

SPEC implicit requirement 1 ("Use Expo Push Notifications. Critical states (Order Arrivals,
Dispatches) must use `data-only` payloads…") and infrastructure §1 (push fan-out). Code:
`packages/shared-types/src/api/notifications.ts`, `packages/db/src/schema/device-tokens.ts`
(migration 0017), `apps/api/src/notifications/device-token-service.ts`,
`apps/api/src/routes/notifications.ts`, `apps/worker/src/consumers/order-push-notifications.ts`,
`apps/worker/src/push/expo-push.ts`, `apps/worker/src/notifications/{order-push,push-recipients}.ts`,
`apps/mobile/src/features/notifications/*` (§9.17).

```
app (session exists) ─ permission ─ getExpoPushTokenAsync({projectId}) ─▶ "ExponentPushToken[…]"
   └─ POST /api/notifications/device-token {token, platform} ─▶ INSERT … ON CONFLICT (token) DO UPDATE
                                                                 device_tokens(user_id, token, platform)

order state change ──(same tx)──▶ outbox order.state_changed ──relay──▶ Kafka order.lifecycle
  ──worker: 1. order-state-fanout (Socket.io)  2. vendor-sla-scheduler  3. order-push-notifications
       orderPushes(event) → who is told what           (none → return, nothing claimed)
       SET notifications:push:seen:{event_id} NX       (redelivery → return)
       per push: recipient = users / vendors ⋈ device_tokens (phone + tokens)
                 SMS_PROVIDER=MOCK → log "[sms:mock] to +977…: Hamro Pasal: <title>. <body>"
       one POST https://exp.host/--/api/v2/push/send  [ {to, …}, … ]   (≤ 100 per request)
       tickets: DeviceNotRegistered → DELETE FROM device_tokens WHERE token IN (…)
       any failure → log {"notification":"push.failed",…}; never thrown
```

**Device tokens (API).** `POST /api/notifications/device-token`, mounted behind `requireAuth`
**without a role list** (customers, vendors, riders and admins all register).

- The account is the access token's subject; the strict body takes only `token` and `platform`
  (a `user_id` is `400 VALIDATION_FAILED`). `token` must match `EXPO_PUSH_TOKEN_PATTERN`
  (`ExponentPushToken[…]` or `ExpoPushToken[…]`, ≤ 255 chars); the same pattern is the table's CHECK.
- One statement: `INSERT … ON CONFLICT (token) DO UPDATE SET user_id, platform, updated_at = now()`.
  A repeat keeps the row (tested: 5 simultaneous registrations → one row); **a phone on which
  another account signs in moves to that account** and the previous one stops getting its pushes.
  Always 200, `Cache-Control: no-store`.
- An access token whose account was deleted hits the foreign key → `401 UNAUTHENTICATED` (the
  app's refresh then ends the session). Rows are deleted with their user (CASCADE).
- **Nothing unregisters a token on sign-out** (§13): the row stays with the last account until
  another one registers on that phone or Expo reports the token dead.

**Notification event triggers** (`notifications/order-push.ts#orderPushes`; the prompt's
`order.created` / `order.status_changed` are the existing `order.state_changed`):

| `to_state`                | Recipient                                 | Kind          | Title / body (`#CODE` = last 6 hex digits of the order id, as both apps show)                                          |
| ------------------------- | ----------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| PLACED                    | vendor                                    | **data-only** | New order / Order #CODE is waiting. Open the app to accept or reject it.                                               |
| PREPARING                 | customer                                  | visible       | Order accepted / The shop is preparing order #CODE.                                                                    |
| OUT_FOR_DELIVERY          | customer                                  | **data-only** | Your order is on its way / Order #CODE has left the shop. Keep your 4-digit delivery code ready.                       |
| DELIVERED                 | customer                                  | visible       | Order delivered / Order #CODE was delivered. Rate the shop in the app.                                                 |
| CANCELED                  | customer, and the vendor if it was placed | visible       | Order cancelled / Order #CODE was cancelled. (+ "A refund of your payment has been initiated." when `refund_required`) |
| FAILED                    | customer                                  | visible       | Order not completed / Order #CODE could not be completed. Open the app for details.                                    |
| PENDING_PAYMENT, DISPUTED | nobody                                    | –             | –                                                                                                                      |

- **Recipients** (`DatabasePushRecipients`): the customer is `users.id = customer_id` (phone
  `users.phone`); the vendor is the shop's own user, `vendors.user_id` (phone `vendors.phone`, the
  number the vendor SMS go to). Every device of the account gets the push. An unknown user or
  vendor is skipped.
- A cancellation does not say who cancelled (the event does not carry it), so **the side that
  cancelled is told too**.
- Riders get no push (no gig assignment exists; nothing in the event names a rider).
- Texts are English (the server does not know the app language), like the vendor SMS.

**The two message shapes** (`expoMessages`), one per device token:

```jsonc
// visible (accepted, delivered, cancelled, failed): the OS draws it; in the foreground the handler shows a banner
{ "to": "ExponentPushToken[…]", "title": "Order accepted", "body": "The shop is preparing order #1F8A11.",
  "sound": "default", "priority": "high", "channelId": "orders", "data": { … } }
// data-only (new order, dispatch; SPEC): no title/body/sound, wakes the app, which posts the notification
{ "to": "ExponentPushToken[…]", "priority": "high", "_contentAvailable": true, "data": { … } }
// data = orderPushDataSchema, identical in both:
{ "type": "order.state_changed", "notification_id": "<event_id>", "order_id": "…", "state": "PREPARING",
  "audience": "CUSTOMER" | "VENDOR", "data_only": false | true, "title": "…", "body": "…" }
```

**Expo gateway** (`ExpoPushGateway`, plain `fetch`, no Expo server SDK): `POST
https://exp.host/--/api/v2/push/send`, JSON array body, `Accept` + `Content-Type:
application/json`, `Authorization: Bearer <EXPO_ACCESS_TOKEN>` only when that optional env var is
set, `AbortSignal.timeout(5000)`, batches of 100. The answer's `data[i]` is the ticket of message
`i`: `ok` or `error` (+ `details.error`). A non-2xx answer, a network error, a non-JSON body or a
ticket count that differs from the batch is a `PushDeliveryError`. **Push receipts are not
fetched** (a ticket only means Expo accepted the message, §13).

**Delivery guarantees (decision).** Best effort, **at most once**:

- The event is claimed in Redis (`notifications:push:seen:{event_id}`, 24 h) before anything is
  read or sent, and **the claim is kept on failure**: a Kafka redelivery (caused by another
  consumer of the topic) never sends a late or duplicate push.
- The handler **never throws**. `order.lifecycle` also carries the live tracking fan-out and the
  90 s vendor timer and has no DLQ; a retried push would hold their partition back (up to the 5 s
  timeout per attempt). The consumer is registered last, so both run first for every message.
- So a push is **lost** when Expo or Postgres is down at that moment. The vendor's safety net for
  a new order is the 90 s SMS + IVR escalation (§8D, §8G, §8H); the customer's is the tracking
  screen's socket and its catch-up refetch.
- Events that push nothing (other event types, PENDING_PAYMENT, DISPUTED) claim nothing.
- One JSON log line per event that reached Expo:
  `{"notification":"push.sent","sent","rejected","removed_tokens","event_type","event_id","aggregate_id","to_state"}`
  (no token, no phone, no text), or `"push.failed"` with the error.

**SMS / IVR fallback logging.** `smsFallbackLogFromEnv(env)`: with `SMS_PROVIDER=MOCK` the consumer
prints, beside each push attempt and **also when the recipient has no device registered**,
`[sms:mock] to +9779800000011: Hamro Pasal: New order. Order #1F8A11 is waiting. Open the app to
accept or reject it.` (the same `mockSmsLogLine` format as every other mock SMS). With SPARROW /
AAKASH it is `null`: **an order push never sends or bills an SMS**. No IVR line is logged here:
the only voice call is the 90 s escalation's (`IVR_PROVIDER=MOCK`, §8H), unchanged.

**Tests.**

- shared-types `api/notifications.test.ts` (14): token formats, request strictness (no user id),
  strict response, push data (extra keys tolerated, other type / unknown state / blank title refused).
- API integration `device-tokens-api.int.test.ts` (17, real Express + PostgreSQL): stored for the
  caller with the contract, every role, repeat keeps one row, **takeover by another account**,
  several devices, 5 concurrent registrations, five validation refusals storing nothing, 401
  without a token and for a deleted account, cascade with the user, the two CHECKs.
- Worker unit: `push/expo-push.test.ts` (10: **the literal URL**, method, headers, body, bearer
  token, ticket pairing, 150 messages → 100 + 50, no request for none, HTTP / network / malformed
  answers); `notifications/order-push.test.ts` (15: every row of the table above verbatim, both
  message shapes, data accepted by the app's schema for every state);
  `consumers/order-push-notifications.test.ts` (19, **the real gateway over a fake `fetch`**: the
  exact request when an order is placed, visible push on accept, both sides on cancel, redelivery
  once, no device / unknown recipient → no request, ignored events claim nothing, Expo 503 and an
  unreadable database swallowed, `DeviceNotRegistered` removed, the mock SMS line with and without
  a device, once per event, off for real providers, `smsFallbackLogFromEnv`, and the wiring:
  through `buildConsumers` the fan-out and the 90 s timer still run when the push fails).
- Worker integration `order-push.int.test.ts` (7, **real Postgres rows + OutboxRelay + Kafka +
  Redis, Expo mocked at `fetch`**): a placed order → one data-only request to
  `https://exp.host/--/api/v2/push/send` for both vendor devices and none for the customer; accept
  → visible push to the customer; cancel → both; the `[sms:mock]` lines with the phones from
  Postgres; a republished envelope sent once; a `DeviceNotRegistered` token deleted from
  `device_tokens`; Expo 503 → not retried and the next event on the partition still pushed.
- Mobile: §9.17.
- **Mutation-checked** (each fails at least one test): no dedupe claim (5), rethrowing a failure
  (3), critical pushes sent with a title (2), `data_only` always false (2), dead tokens kept (1),
  vendor / customer swapped (10), SMS log for every provider (3), another URL (2), no batching (1),
  no bearer header (1), vendor told of an unplaced order's end (4); API: a registration not moving
  the device (1).
- **Not run against the real Expo service or a device.**

## 8L. Vendor catalogue management and local uploads (Phase 19)

SPEC vendor flow step 3 (the vendor's SKUs), implicit requirement 5 (catalog photos) and §3
(inventory). Code: `apps/api/src/catalog/product-service.ts` (`update`, `hide`, `addImages`),
`apps/api/src/routes/catalog.ts#vendorProductsRouter`, `apps/api/src/uploads/product-image-storage.ts`,
`apps/api/src/app.ts` (static mount), `apps/api/src/container.ts` (`DEFAULT_UPLOADS_DIR`),
`packages/shared-types/src/api/{catalog,responses}.ts`, `apps/admin/src/features/vendor-portal/*`,
`apps/mobile/app/vendor/[id].tsx`.

```
Vendor Portal (apps/admin, VENDOR)                         API /api/vendor/products  (requireAuth VENDOR)
  Edit ──── PUT /:id {category_id, name, price_npr, …} ──▶ ProductService.update   ─┐ every statement:
  Hide ──── DELETE /:id ─────────────────────────────────▶ ProductService.hide     ─┤ WHERE id = :id
  Set ───── PATCH /:id/stock {stock_quantity} ───────────▶ ProductService.setStock ─┤   AND vendor_id =
  Upload ── POST /:id/images  multipart "images" × 1–8 ──▶ ProductService.addImages ─┘   (vendor of the token)
                                                             │ multer (memory) → sniff bytes → ProductImageStorage.save
                                                             ▼
        apps/api/uploads/product-images/<product id>/<uuid>.<jpg|png|webp>      (UPLOADS_DIR, git-ignored)
                                                             │ UPDATE products SET image_urls = array_cat(image_urls, …)
                                                             ▼                     WHERE … AND cardinality + n <= 8
        products.image_urls = [ …, "http://localhost:4000/uploads/product-images/<product id>/<uuid>.jpg" ]
                                                             │
  <img src> / GET /api/products ◀── express.static(UPLOADS_DIR) at /uploads (nosniff, no index, no dotfiles)
```

**Vendor scoping rules** (what "a vendor can only edit their own products" means in code).

1. The shop is **never named by the client**. `requireAuth(VENDOR)` yields the user id; `vendorIdOf`
   reads `vendors.id WHERE user_id = <token subject>` (a vendor account without a shop:
   `404 VENDOR_NOT_FOUND`). The request schemas are strict: a `vendor_id` in a PUT body is
   `400 VALIDATION_FAILED`, and no route can move a product to another shop.
2. Every read and write of a product carries **`products.id = :id AND products.vendor_id = :vendorId`**
   in its own WHERE (not a check followed by an unscoped write): PUT's read and its UPDATE, DELETE's
   UPDATE, the upload's read and its UPDATE, the stock PATCH (Phase 17).
3. Another shop's product therefore matches no row: **`404 PRODUCT_NOT_FOUND`**, the same answer as
   for an unknown id (ids cannot be probed), and the row is byte-for-byte unchanged (tested). For
   an upload, nothing is written to disk either: ownership is read before any file is saved.
4. Roles: CUSTOMER, DRIVER and SUPER_ADMIN get `403 FORBIDDEN` on all three routes; no token 401.
   The Super Admin's own controls stay under `/api/admin` (§8K).
5. The list (`GET /api/vendor/products`) and its cursor were already scoped (Phase 17).

**PUT `/api/vendor/products/:id`** (`vendorProductUpdateRequestSchema`, `ProductService.update`).

| Field                                          | Rule                                                                                                                                                                                                            |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `category_id`                                  | required. Checked to be an **active** category only when it differs from the product's current one (`422 CATEGORY_UNAVAILABLE`): a product may stay in a category the admin has hidden, it cannot move into one |
| `name`                                         | required, trimmed, ≤ 120; unique per shop (`409 PRODUCT_NAME_TAKEN`; keeping its own name is fine)                                                                                                              |
| `price_npr`                                    | required, > 0, whole paisa, ≤ 1 000 000. Checkout re-prices from the database, so the new price is what the next checkout charges (tested); placed orders keep their snapshot                                   |
| `description`, `unit`, `is_active`, `metadata` | optional; **PUT replaces**: omitted → null, `'piece'`, `true`, `{}`. `is_active: true` is how a hidden product is shown again                                                                                   |
| `image_urls`                                   | optional. **Omitted → the photos are kept.** Given → it becomes the list (remove / reorder, ≤ 8 http(s) URLs); files of dropped photos that this storage issued are deleted after the commit (best effort)      |
| `stock_quantity`                               | **not accepted** (400): the stock has its own PATCH, so an edit can never reset it                                                                                                                              |

**DELETE `/api/vendor/products/:id`** = `UPDATE … SET is_active = false` (soft delete; rows are
referenced by `order_items`). 204, also on repeat. The product leaves `GET /api/products`, the
vendor menu and checkout (`422 PRODUCT_UNAVAILABLE`), and stays in the vendor's own list as hidden
(all tested). Its stock, photos and name are kept.

**Local upload pipeline** (`POST /api/vendor/products/:id/images`).

1. `requireAuth(VENDOR)` runs **before** multer, so an unauthenticated body is never parsed.
2. `multer` (memory storage): field **`images`** (`PRODUCT_IMAGE_FILE_FIELD`), `fileSize`
   `MAX_PRODUCT_IMAGE_BYTES` = 5 MB, `files` 8, **`fields: 0`**. A larger file → `413 FILE_TOO_LARGE`
   (refused while streaming); a 9th file → `422 PRODUCT_IMAGE_LIMIT`; a form field or a file part
   with another name → `400 MALFORMED_REQUEST`; no file (or a JSON body) → `400 VALIDATION_FAILED`.
3. Each file's type is read from its **own bytes** (`sniffEvidenceType`: JPEG, PNG, WebP); the
   declared Content-Type and the file name are ignored. One bad file refuses the whole request
   (`415 UNSUPPORTED_MEDIA_TYPE`) before anything is stored (an SVG named `photo.jpg` is tested).
4. `ProductService.addImages`: ownership + current count (`404` / `422 PRODUCT_IMAGE_LIMIT` with
   `details {max_images: 8, current_images}`), then `ProductImageStorage.save` per file, in order.
5. `LocalProductImageStorage.save` writes `<UPLOADS_DIR>/product-images/<product id>/<uuid>.<ext>`
   (`mkdir -p`, `flag: 'wx'`; the name is a random uuid, the extension comes from the sniffed
   type, nothing from the client reaches the path) and returns
   `<UPLOADS_PUBLIC_BASE_URL>/product-images/<product id>/<uuid>.<ext>`.
6. One guarded statement appends the URLs:
   `UPDATE products SET image_urls = array_cat(image_urls, ARRAY[…]) WHERE id AND vendor_id AND
cardinality(image_urls) + n <= 8`. If it matches no row (another upload filled the product
   meanwhile, or it vanished), **the files just written are deleted** and the request is refused.
   Tested: 4 concurrent uploads of 3 photos → two 201s, two 422s, 6 URLs, exactly those 6 files.
   The database CHECK `cardinality(image_urls) <= 8` (Phase 17) backs it.
7. 201 with the product (`vendorProductResponseSchema`); `Cache-Control: no-store`.

**Serving.** `createApp` mounts `express.static(rootDir, { index: false, dotfiles: 'deny' })` with
`X-Content-Type-Options: nosniff` at the path of the public base URL (`/uploads`) for every local
storage; the evidence and photo storages share one directory and path, mounted once. No auth:
product photos are public anyway (they are in the unauthenticated `GET /api/products`).

**Where files go.** `buildContainerFromEnv`: `UPLOADS_DIR ?? DEFAULT_UPLOADS_DIR`, where
`DEFAULT_UPLOADS_DIR = resolve(__dirname, '..', 'uploads')` = **`apps/api/uploads`** for both
`src/` (tsx) and `dist/` (node). `.gitignore` has `apps/api/uploads/`. Integration tests use a
per-process temp directory (`TEST_UPLOADS_DIR`) and delete it. R2 later = another
`ProductImageStorage` (`save`, `remove`); `remove` only deletes a URL with this product's prefix
and a `<uuid>.<ext>` name, so no URL can make it delete outside its directory (tested).

**The resolved mobile catalog gap.** Phase 18 capped cart lines with `stock_quantity` from the
public product list, but `GET /api/vendors/:id/products` (the shop's menu) carried only `in_stock`,
so a line added from a menu had `availableStock: null`: the menu's Add and the cart's "+" could
raise it to 99 whatever the stock, until a checkout answered 409.

- `menuProductSchema` now has **`stock_quantity`** (int ≥ 0; `in_stock` kept), filled by
  `CatalogService.getMenu` → `menuView`. As on the public list it is the on-hand count (other
  customers' live holds are not subtracted; checkout stays the authority).
- `app/vendor/[id].tsx` passes `availableStock: product.stock_quantity` to `useCartStore.addItem`
  and shows "Out of stock" from the number. The store rules are Phase 18's, unchanged: Add past the
  stock answers `stock_limit` ("No more of this item is in stock."), and the cart's stepper cannot
  raise the line past it.
- Opening a menu also **refreshes** what a line knows: a restocked product can be added again
  after an earlier 409 lowered `availableStock` (tested).
- The schema is strict, so the app rejects a menu without the field: **deploy the API before the
  app** (as in Phase 18).

**Vendor Portal (`apps/admin`).**

- **Entry.** The existing +977 OTP sign-in. `portalOf(user)`: SUPER_ADMIN → the dashboard (tabs,
  unchanged), **VENDOR → the Vendor Portal**, anyone else refused on the sign-in screen. `App.tsx`
  renders `VendorProductScreen` and the brand "Vendor Portal" for a vendor; no admin tab is
  offered (and `/api/admin` answers 403 anyway).
- **Session.** The API was not changed: only a SUPER_ADMIN gets the refresh cookie (§8J). A vendor's
  sign-in body has `refresh_token`; the session store keeps it **in memory** (`refreshToken?`), and
  `createApiClient.runRefresh` posts it to `POST /api/auth/token/refresh` on a 401 `UNAUTHENTICATED`
  (same single flight, one replay, only 400/401 end the session). The cookie endpoint is never
  called for a vendor. **A reload signs the vendor out**; Sign out just forgets the tokens.
- **Screen ("My products").** Table: first photo (+N more), name / category path / description,
  price per unit, **stock field + Set** (whole number 0–1 000 000, disabled until changed), Visible /
  Hidden badge with **two-step Hide** or **Show**, **Edit**. "Load more" pages with the cursor.
  Saved products are patched into the cached pages (no refetch).
- **Show** sends a PUT with the product as it is and `is_active: true` (`showRequest`). A product
  with no category (older than the taxonomy) opens the editor instead: PUT requires one, which is
  also how such products get mapped.
- **Edit modal** (native `<dialog>`): name, category (active taxonomy from the public
  `GET /api/categories`, indented; the product's own hidden category stays selectable), description,
  price, unit, "Visible to customers", photos. The form is validated with the API's own
  `vendorProductUpdateRequestSchema`; `metadata` is carried over (PUT replaces, the form does not
  edit it); `image_urls` is sent **only when a photo was removed**.
- **Photos.** "Upload" stores the chosen files at once (not on Save) and adds their thumbnails;
  "Remove" takes a photo out of the form and is applied by Save. Checked on the device first
  (`uploadProblem`: a file chosen, room left of the 8, JPEG / PNG / WebP, ≤ 5 MB); the server
  checks again by content.
- **The multipart boundary.** `uploadOwnProductImages` appends every `File` to a `FormData` under
  `images` and hands it to the client; `createApiClient.send` passes a `FormData` body through
  untouched and **sets no `Content-Type`** for it (it sets `application/json` only for JSON bodies).
  The browser then writes `multipart/form-data; boundary=…` with the boundary it generated; a
  hand-written header would have none and multer would refuse the body.

**Tests.**

- shared-types (+4): `vendorProductUpdateRequestSchema` (defaults without `image_urls`, photo list,
  stock / vendor id / bad price refused), a menu product without or with a bad `stock_quantity`.
- API unit `uploads/product-image-storage.test.ts` (5): path and URL, unique names, mount path,
  remove (idempotent), and never deleting through a foreign, external or `../` URL.
- API integration `vendor-product-lifecycle.int.test.ts` (23, real Express + PostgreSQL + Redis +
  disk): PUT replace / defaults / **Vendor A vs Vendor B (404, row equal before and after, owner
  still can)** / vendor id in the body / validation incl. stock / category move vs stay / name
  clash / the new price at checkout / unknown id; DELETE soft delete (gone from the public list,
  the menu and checkout, still listed for the vendor), idempotent + shown again by PUT, **Vendor A
  cannot hide B's**; upload: file on disk = bytes sent, URL in Postgres, served back with
  `nosniff`, several files in order after existing ones, URL in the public list, **Vendor A cannot
  upload to B's and nothing is stored**, bytes not declared type (415, nothing stored), exactly
  5 MB vs one byte more (413), the 8-photo limit (422 with counts), the race, missing file / JSON
  body / wrong field / extra field / bad id, PUT removing a photo deletes its file (then 404);
  roles and the shopless vendor on all three routes. `vendors-api.int.test.ts`: the menu carries
  the exact stock.
- Admin `features/vendor-portal.test.ts` (25): `portalOf`, the form → PUT body, photo list only
  when changed, field errors, Show, `parseStock`, category options / labels, `uploadProblem`,
  cache replace, messages; endpoint wiring; **the upload is a `FormData` with two `images` parts
  and no `Content-Type` header, and a real `Request` built from it carries
  `multipart/form-data; boundary=…`**; the vendor's body-token refresh, refused refresh, cookie
  endpoint never called.
- Mobile (+4, `VendorMenuScreen.test.tsx`, `api/catalog.int.test.ts`): a menu line stops at the
  menu's stock with the banner, cannot be raised past it in the cart, a restocked product can be
  added again, sold out by `stock_quantity` even if `in_stock` says true, the menu contract
  carries `[20, 12, 0]`, a menu without the field is `UNEXPECTED_RESPONSE`.
- **Mutation-checked** (each fails at least one test): PUT / DELETE / upload not scoped to the
  vendor (1 each), no image cap in the UPDATE (1), refused upload keeping its files (1), PUT
  wiping photos when none are listed (1), dropped photos keeping their file (1), no category check
  on a move (1), declared type trusted (1), menu stock as 1 / 0 (1); admin: JSON or boundary-less
  multipart Content-Type on the upload (1 each), FormData stringified (2), wrong field name (2),
  vendor refresh through the cookie endpoint (2), photo list always sent (2), metadata dropped (2),
  no 8-photo check (1); mobile: stock not passed to the cart (4), sold out by the flag (1). One
  mutant **survives by design**: removing the count pre-check in `addImages` (the guarded UPDATE
  enforces the same limit; the pre-check only avoids writing files first).
- **Live run (local Docker, the built API with `SMS_PROVIDER=MOCK` behind the Vite dev proxy,
  headless Edge over CDP; not a device), 29 checks:** over HTTP the Patan vendor's PUT, DELETE and
  upload against a Thamel product each answered 404 and stored nothing; in the browser 9800000011
  signed in and landed on the Vendor Portal with its three products and no admin tabs; stock set
  from a row reached `GET /api/products`; a real PNG was uploaded from the modal: the request's
  header was `multipart/form-data; boundary=----WebKitFormBoundary…`, the file appeared under
  `apps/api/uploads/product-images/<id>/` with the uploaded bytes, the thumbnail decoded from
  `http://localhost:4010/uploads/…`, and the URL was in the public list; a price edit kept stock
  and photo; Hide removed the product from the public list and Show returned it; removing the photo
  and saving deleted the file (URL then 404); a reload showed the sign-in screen. The seeded
  product was put back as it was.

## 8K. Catalog, taxonomy and inventory (Phase 17)

SPEC Super Admin flow 2 ("Manages immutable Master Category Taxonomy"), vendor flow step 3 ("map
SKUs to Admin Taxonomy") and §3 (inventory). Code: `packages/db/src/schema/{categories,vendors}.ts`,
migration 0016, `packages/shared-types/src/api/catalog.ts`,
`apps/api/src/catalog/{category-service,taxonomy-rules,product-service}.ts`,
`apps/api/src/routes/catalog.ts`, `apps/api/src/checkout/checkout-service.ts#assertInStock`,
`apps/admin/src/features/{categories,products}`.

```
Super Admin (apps/admin) ─ POST / PUT / DELETE /api/admin/categories ─▶ CategoryService ─▶ categories
                                                  (one advisory lock: parent exists, no cycle, ≤ 3 levels)
Vendor ─ POST /api/vendor/products {category_id, …} ─▶ ProductService ─▶ products (FK category RESTRICT)
       ─ PATCH /api/vendor/products/:id/stock {stock_quantity} ─▶ products.stock_quantity  ◀─ the one stock number
Anyone ─ GET /api/categories · GET /api/products?category_id=&vendor_id=&search= ─▶ active products of LIVE vendors
Checkout ─ assertInStock (PostgreSQL) ─▶ Redis 600 s lock (stock − live holds) ─▶ claim: UPDATE … WHERE stock_quantity >= qty
```

**Taxonomy (`CategoryService`).**

- "Immutable" is read as **immutable for vendors**: only a Super Admin writes it; vendors and
  customers read it.
- Every write runs in a transaction that first takes `pg_advisory_xact_lock(1700017)`, then reads
  every `(id, parent_id)` and asks `taxonomy-rules.ts#placementProblem`:

  | Problem            | Answer                          | Rule                                                                                   |
  | ------------------ | ------------------------------- | -------------------------------------------------------------------------------------- |
  | `PARENT_NOT_FOUND` | `422 CATEGORY_PARENT_NOT_FOUND` | the parent must exist                                                                  |
  | `CYCLE`            | `409 CATEGORY_CYCLE`            | never under itself or one of its own descendants                                       |
  | `TOO_DEEP`         | `422 CATEGORY_TOO_DEEP`         | depth of the parent + height of the moved subtree ≤ `MAX_CATEGORY_DEPTH` (3; root = 1) |

  The lock is what makes the check sound: two simultaneous opposite moves (A under B, B under A)
  cannot both pass (tested 5 rounds; mutation-checked).

- `slug` is unique (`409 CATEGORY_SLUG_TAKEN`, also for 5 simultaneous creates: one 201). **PUT
  replaces every editable field** (an omitted optional one takes its default); moving a category
  moves its subtree.
- **DELETE removes only an unused category** (no subcategories, no products mapped), else
  `409 CATEGORY_IN_USE` with the counts; both foreign keys are RESTRICT, so the database refuses it
  too. A used category is retired with `is_active: false`.
- `is_active: false` hides a category **and everything under it** from `GET /api/categories`
  (`buildCategoryTree` drops a branch whose parent is not in the list). The admin list still shows
  all of it, with `product_count` = products mapped directly to each category.
- Lists are flat, in tree order (parent before children; siblings by `display_order`, then name).
  `buildCategoryTree` / `flattenCategoryTree` (shared-types) are used by the API and the admin app.

**Products (`ProductService`).**

- The shop is always the caller's (`vendors.user_id` = token subject; a body `vendor_id` is a 400;
  a vendor account without a shop is `404 VENDOR_NOT_FOUND`). **Any vendor status** may add
  products (a SANDBOXED vendor builds its catalogue before approval, SPEC vendor flow step 3).
- Create: the category must exist and be active (`422 CATEGORY_UNAVAILABLE`); the name is unique per
  shop (`409 PRODUCT_NAME_TAKEN`; 5 simultaneous creates → one row). `price_npr` in whole paisa,
  ≤ 1 000 000; `image_urls` are http(s) URLs (no upload route yet); `metadata` a JSON object of at
  most 4000 characters.
- **Stock = `PATCH …/stock {stock_quantity}`: the counted quantity replaces the stored one** (not a
  delta). Another shop's product is `404 PRODUCT_NOT_FOUND` and stays untouched.
- **Public list** (`GET /api/products`): `products.is_active` and `vendors.status = 'LIVE'`;
  `in_stock` (`stock_quantity > 0`, as on vendor menus) and, **since Phase 18, `stock_quantity`
  itself** (the mobile quantity picker needs it; Phase 17 withheld it). It is the vendor's on-hand
  count: other customers' live Redis holds are not subtracted. Vendor menus still carry only
  `in_stock`.
  - `category_id`: the category **and its active descendants** (recursive CTE); an unknown or
    inactive category is `404 CATEGORY_NOT_FOUND`.
  - `search`: `prefixSearchQuery` lower-cases, splits on anything that is not a letter, combining
    mark or digit, and builds `wai:* & noo:*` for `to_tsquery('simple', …)` against the indexed
    expression. Every word must match the start of a word in the name or description. Operators
    cannot be injected (only letters / marks / digits survive); a search of punctuation only
    answers an empty page. Devanagari names match (tested). `'simple'` = no stemming, no stop words.
  - Order `(name, id)`; keyset pagination, the cursor row compared in SQL (as the wallet ledger).
- **Admin list**: every product (inactive too), by vendor name then product name, optional
  `vendor_id`. `PATCH /api/admin/products/:id/active` flips `is_active`: a hidden product leaves the
  public list and the vendor menu, and checkout answers `422 PRODUCT_UNAVAILABLE` (tested).

**Inventory architecture (three layers, one number).**

| Layer                            | Where                                                           | Refuses when                                   | Answer                                            |
| -------------------------------- | --------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------- |
| 1. Stock guard (Phase 17)        | `CheckoutService.checkoutExclusive` → `assertInStock`           | a merged cart line > `products.stock_quantity` | `409 INSUFFICIENT_STOCK`, every short line listed |
| 2. Redis 600 s lock (SPEC §3)    | `InventoryLockService.reserve`                                  | a line > stock − other customers' live holds   | `409 INSUFFICIENT_STOCK` (what is left)           |
| 3. Guarded decrement (the claim) | `CheckoutService.claim`: `UPDATE … WHERE stock_quantity >= qty` | the stock dropped after the lock was taken     | `InsufficientStockError` (prepaid: order FAILED)  |

- Layer 1 is new: it runs **before** pricing, the MOV check, the COD check and the lock, so an
  out-of-stock cart creates no order, no lock and no outbox event, and reports all short lines at
  once (`details.shortfalls[{productId, requested, available}]`; split lines of one product are
  added up). **Order of refusals changed:** a cart that is both below MOV and out of stock now
  answers `INSUFFICIENT_STOCK`.
- Layers 2 and 3 are unchanged (Phases 3–4). Layer 2 still decides between concurrent customers
  (10 simultaneous checkouts of the last unit → one order, tested); layer 3 is the final word in
  PostgreSQL (`products_stock_quantity_check` backs it).
- **Vendor stock edits and live holds:** setting stock does not touch Redis holds. Raising it is
  available at once. Lowering it below a live hold makes that checkout's claim fail at layer 3
  (never an oversell, tested): a prepaid order paid meanwhile ends as FAILED + PAID (the existing
  `PAID_AFTER_SESSION_EXPIRED` path, which still does not flag the refund, §13).
- No event is emitted for a stock or product change (nothing consumes one yet).

**Admin web app.** Two tabs (`src/tabs.ts`, hash `#/categories`, `#/products`):

- **Categories**: the tree as an indented list (name, Active / Hidden badge, slug, order, product
  count); "Add subcategory" down to level 2, Edit, two-step Delete (disabled with the reason while
  the category has subcategories or products). A native `<dialog>` modal creates and edits: the slug
  follows the name until edited by hand, the Parent list never offers the category itself, its
  descendants, or a place that would pass 3 levels; the form is validated with the API's own Zod
  schema; server refusals (slug taken, cycle, …) are shown in the modal.
- **Products**: vendor filter (reuses the vendors query), table (product + category, vendor +
  status, price, stock with unit, a Visible / Hidden / "Vendor is …" badge), Hide / Show (patches the
  cached pages in place), "Load more". Read-only otherwise.
- `createApiClient` now sends PUT / PATCH / DELETE; a 204 is read as null.

**Tests.**

- shared-types `api/catalog.test.ts` (28): tree building / flattening / hidden branches / cycles,
  slugify, every request schema's defaults and refusals, the public view has no stock.
- API unit `catalog/catalog-rules.test.ts` (15): depth, height, every placement rule,
  `prefixSearchQuery` (Devanagari, injection), `assertInStock`.
- API integration, real Express + PostgreSQL + Redis:
  - `admin-categories-api.int.test.ts` (26): hierarchy and tree order, 4th level, unknown parent,
    slug conflicts (5 concurrent creates), PUT replace / move subtree / cycle / depth / opposite
    concurrent moves, hide a branch, DELETE unused / with children / with products / FK, roles; admin
    products list, paging, hide → gone from public list, menu and checkout, show again.
  - `vendor-products-api.int.test.ts` (19): create, defaults, body vendor ignored, non-LIVE vendors,
    name conflicts (5 concurrent), unknown / inactive category, validation; stock set, zero, other
    shop 404, sold out → restock → order, lowering stock under a live hold; list, paging 2/2/1,
    foreign cursor; roles and the shopless vendor.
  - `catalog-api.int.test.ts` (17): public tree without a token, hidden branches; LIVE + active only,
    no stock in the body; vendor filter; category subtree, deactivated branch, 404; combined filters;
    prefix / multi-word / description / Devanagari search, operator injection, **`EXPLAIN` shows
    `products_search_idx`**; paging without gaps, exact-page end, default 20, bad parameters.
  - `cart-api.int.test.ts` "stock guard" (+6): out of stock on COD / eSewa / Khalti with no order
    and no hold, exact quantity then one more, every short line + split lines, before MOV, another
    customer's hold, 10 concurrent checkouts of the last unit.
- db integration: `catalog.int.test.ts` (14: slug / name / order CHECKs, parent FK, self-parent,
  RESTRICT deletes, `updated_at` trigger, product CHECKs, the three indexes) and the contract test
  (categories, new product columns, a pre-Phase-17 product).
- admin `features/catalog-rules.test.ts` (26): tabs, tree rows, delete reasons, parent options, form
  (slug autofill, request building, field errors), product rules, endpoint wiring incl. 204.
- **Mutation-checked** (each fails at least one test): no stock guard (1), guard `<=` instead of `<`
  (5), no cycle check (2), no depth limit (2), no advisory lock (1), delete ignoring products (1),
  stock update not scoped to the vendor (1), non-LIVE vendors public (2), inactive products public
  (2), category filter without descendants (2), inactive branches in the subtree (1), search
  without prefix (1), inclusive cursor (2), vendor using an inactive category (1).
- **Live run (local Docker, headless Edge over CDP, not a device):** the built API with
  `SMS_PROVIDER=MOCK` behind the Vite dev proxy; signed in as 9800000099; Categories showed the
  seeded tree; a subcategory was created through the modal (slug auto-filled, parent preselected),
  a duplicate slug was refused in the modal, the category was hidden (gone from the public list) and
  deleted; Delete on Groceries was disabled with its reason; Products listed all six seeded
  products, filtered to one vendor, and Hide / Show of "Local Honey 500g" removed it from and
  returned it to the public `search=honey`. The first attempt failed on a stale Vite bundle (§3).

## 8J. Cookie-based refresh for the Super Admin dashboard (Phase 16)

SPEC implicit requirement 3 ("HTTP-only, secure Refresh Tokens (7 days)"; access tokens in memory).
Closes the Phase 15 gap "the admin session is lost on reload". Code: `apps/api/src/auth/refresh-cookie.ts`,
`auth/otp-auth-service.ts#refreshCookieSession`, `routes/auth.ts`, `packages/shared-types/src/api/responses.ts`,
`apps/admin/src/{api/client.ts,api/admin-api.ts,auth/session-store.ts,App.tsx}`.

```
browser (apps/admin)                                   API /api/auth
  POST /otp/verify {phone, code} ───────────────────▶ user.role = SUPER_ADMIN
     ◀── 200 {access_token, user, …}  (no refresh_token)
         Set-Cookie: hamro_pasal_refresh=<7-day refresh JWT>; Max-Age=604800; Path=/api/auth;
                     HttpOnly; Secure; SameSite=Strict
  access token → memory (zustand)        cookie → the browser's jar (no script can read it)

  page load / reload ─ POST /refresh (cookie attached by the browser, no body) ──▶ verify JWT, read user
     ◀── 200 {access_token, user{id, role, first_name, phone}}   → session restored, dashboard shown
     ◀── 401 REFRESH_TOKEN_INVALID + cookie cleared               → sign-in screen
  any call ─▶ 401 UNAUTHENTICATED ─▶ POST /refresh (single flight) ─▶ replay once with the new token
  Sign out ─ POST /logout ──▶ 204 + cookie cleared ─▶ access token forgotten
```

**The cookie** (`REFRESH_COOKIE`, one definition for set and clear):

| Attribute         | Value                 | Why                                                                                                 |
| ----------------- | --------------------- | --------------------------------------------------------------------------------------------------- |
| name              | `hamro_pasal_refresh` | value = the same refresh JWT as before (`JWT_REFRESH_SECRET`, aud `hamro-pasal-refresh`, 7 d)       |
| `HttpOnly`        | always                | JavaScript (and an XSS) cannot read it                                                              |
| `Secure`          | always                | HTTPS only. Chrome, Edge and Firefox also store it on `http://localhost` (local development)        |
| `SameSite=Strict` | always                | never attached to a request another site started: no CSRF on `/refresh` or `/logout`, no CORS setup |
| `Path=/api/auth`  | always                | sent to the auth endpoints only, not with every `/api/admin` call                                   |
| `Max-Age`         | 604800                | the refresh token's own lifetime (the JWT `exp` is what the server enforces)                        |
| `Domain`          | not set               | host-only: the exact host that set it                                                               |

**Who gets a cookie.** Decided by the account's role at `POST /api/auth/otp/verify`: a **SUPER_ADMIN**
gets the cookie and a body without `refresh_token` (`cookieAuthTokensResponseSchema`); every other role
gets the Phase 7 body with `refresh_token` and **no** cookie (the mobile app has no cookie jar it relies
on and keeps the token in AES-256 MMKV). The admin app parses `otpVerifyResponseSchema` (either shape),
because it must still read a non-admin's answer to refuse it. Consequence: **a Super Admin can no longer
sign in on the mobile app** (its strict schema requires `refresh_token`, so the answer is
`UNEXPECTED_RESPONSE`); it had no admin screens anyway.

**`POST /api/auth/refresh`** (`OtpAuthService.refreshCookieSession`):

- The token is read **only** from the cookie (`readRefreshCookie`: exact name, first occurrence, no
  decoding). A token in the JSON body or the `Authorization` header is ignored (401).
- Same verification as `/token/refresh` (signature, HS256, issuer, refresh audience, `typ`, expiry),
  then the account is read from Postgres: missing → refused; **role no longer SUPER_ADMIN → refused**
  (cookie sessions exist for Super Admins only, so a demotion ends the browser session at the next
  refresh, and another role's refresh token pasted into the cookie is useless).
- Every refusal is the same `401 REFRESH_TOKEN_INVALID`, and the response **clears the cookie**
  (except when there was none), so the browser stops presenting a dead token.
- 200: a new 15-min access token + `user {id, role, first_name, phone}` (the reloaded dashboard shows
  the phone and knows nothing else about its session), `Cache-Control: no-store`, **no `Set-Cookie`**:
  the refresh token is **not rotated** and keeps its original 7-day expiry (no sliding window).

**`POST /api/auth/logout`**: clears the cookie (same attributes, `Expires` 1970) and answers 204, with
or without a cookie, no authentication. **It revokes nothing on the server**: the JWT that was in the
cookie stays valid until its `exp` if it was copied before (it cannot be copied by a script; §13).

**`POST /api/auth/token/refresh`** (body token, mobile) is unchanged.

**Admin app.**

- `createSessionStore` holds `{ phone, user, accessToken }`; there is no refresh token in JavaScript.
- `createApiClient` sends every request with `credentials: 'same-origin'`. `runRefresh` calls
  `POST /api/auth/refresh` without a body and **sets the whole session** from the answer, so one
  function serves both the 401 renewal and the page-load restore. Kept from Phase 15: single flight,
  one replay, only 400/401 end the session (network/5xx keep it), and a refresh that finishes after a
  sign-out never revives the session (compared by user id). If the cookie now belongs to another
  admin (another tab signed in), the session follows the cookie and `main.tsx` clears the query cache.
- **Silent refresh on load:** `App.tsx#useSessionRestore` calls `api.restoreSession()` once per mount
  (StrictMode's double mount collapses into the single flight) and shows "Restoring your session…"
  until it answers; refused or unreachable → the sign-in screen.
- **Sign out** awaits `POST /api/auth/logout` and only then forgets the access token; if the call
  fails the admin stays signed in and sees "Couldn't sign out. Try again." (forgetting the token while
  the cookie survived would sign them back in on the next load).
- No Axios: the client is the existing `fetch` wrapper (the prompt named Axios interceptors as an
  example).

**Tests.**

- API unit (`src/auth/refresh-cookie.test.ts`, 5): the exact `Set-Cookie` lines for set and clear, no
  `Domain`, reading by exact name among other cookies, first of duplicates, empty/absent → null.
- API integration (`test/auth-cookie-api.int.test.ts`, 14, real Express + Redis + Postgres through the
  OTP flow): the Super Admin cookie's attribute set is exactly HttpOnly, Secure, SameSite=Strict,
  Path=/api/auth, Max-Age=604800 (+ Expires) and the strict body has no refresh token; NEW / CUSTOMER /
  VENDOR / DRIVER get the body token and no cookie; `/refresh` issues a 900 s SUPER_ADMIN token that
  opens `/api/admin/vendors`, returns the account, sets no cookie and repeats; cookie found among
  others; no cookie / token in body / token in header / other cookie name / empty value → 401;
  expired, wrong secret, wrong audience, missing `typ`, an access token, a tampered signature and
  garbage → 401 **and cleared**; deleted account; demoted admin; a vendor's refresh token as the cookie;
  logout 204 clears with the same attributes, also without a cookie.
- shared-types (`responses.test.ts`, +3) and admin app (42, +9): refresh sends no body and
  `credentials: 'same-origin'`, restore from the cookie alone, refused → signed out, network error and
  contract break rejected without a session, StrictMode double call → one request, following another
  admin's cookie, the three cookie endpoints' wiring, a non-admin sign-in body still parsed, a failed
  logout rejected.
- Mutation-checked: no HttpOnly, no Secure, SameSite=Lax (each 2 unit + 6 integration fail), no role
  check on the cookie refresh (2), refused cookie not cleared (3), refresh token also in the admin
  body (1), token accepted from the body (1); admin client: reviving a signed-out session (1), no
  single flight (2), credentials omitted (4), restore not creating a session (3).
- **Live run (local infra, headless Edge over CDP, not a device):** a second API (`SMS_PROVIDER=MOCK`)
  behind the Vite dev proxy on `http://localhost`; signed in as 9800000099 through the real form; the
  browser stored the cookie as HttpOnly + Secure + SameSite=Strict, path `/api/auth`, 7 days;
  `document.cookie` was empty; the cookie was not attached to `/api/admin` URLs; **after a reload the
  dashboard came back signed in** and loaded the vendor list with the restored token; Sign out removed
  the cookie and a further reload showed the sign-in screen.

## 8I. Super Admin dashboard: DLQ monitoring and vendor overrides (Phase 15)

SPEC Super Admin flow and infrastructure §5 (audit records of vendor suspensions); closes the Phase
14 gap "nothing reads `notifications.dlq`, no replay tool". Code: `apps/worker/src/dead-letters/*`,
`apps/worker/src/consumers/dead-letter.ts`, `apps/api/src/admin/*`, `apps/api/src/routes/admin.ts`,
`apps/api/src/wallet/wallet-service.ts` (admin overrides), `packages/shared-types/src/api/admin.ts`,
`apps/admin`.

```
worker withDeadLetter (4th failure or poison pill)
  ├─▶ INSERT dead_letter_events … ON CONFLICT (consumer, topic, partition, offset) DO NOTHING
  └─▶ Kafka notifications.dlq (unchanged, byte for byte + dlq_* headers)      ── either fails → no commit, redelivery

admin "Retry" ─▶ POST /api/admin/dlq/:id/retry ─▶ row FOR UPDATE: PENDING → RETRY_REQUESTED (202)
worker DeadLetterReplayer (every 1 s): SELECT … RETRY_REQUESTED FOR UPDATE SKIP LOCKED (≤ 20)
  ─▶ producer.send(source_topic, key, value, own headers + dlq_replay_of=<row id>) ─▶ REPLAYED (same tx)
  ─▶ consumer handles it again (event_id dedupe still applies)
       └─ fails again ─▶ a NEW dead_letter_events row with replay_of_id = <row id>
```

**Dead letter rows (worker).** `DeadLetterOptions.store` is now required; `withDeadLetter` calls
`store.save(deadLetterEntry(...))` and only then `publisher.publish(deadLetterRecord(...))`, so a
message never reaches the DLQ topic without its row. `DatabaseDeadLetterStore` inserts with
`ON CONFLICT DO NOTHING` on the source index (a redelivery after a crash between the insert and the
offset commit is stored once). `ownHeaders` keeps the message's headers as strings (last value of a
repeated header) without `dlq_*`; `dlq_replay_of` becomes `replay_of_id` when it is a uuid.

**Retry = outbox-style, not a Kafka client in the API** (decision): the API only records the request;
`DeadLetterReplayer` (started in `main.ts` next to the OutboxRelay, same idempotent producer) publishes
and marks REPLAYED in one transaction after the ack (at-least-once; consumers dedupe on `event_id`).
A failed publish increments `replay_attempts` and stores `last_replay_error`; after 10 the row waits
(shown on the card) until an admin presses "Retry again", which resets the count.

| Retry request on…                    | Answer                                                 |
| ------------------------------------ | ------------------------------------------------------ |
| PENDING                              | 202, RETRY_REQUESTED, `retry_requested_at/by` recorded |
| RETRY_REQUESTED, replay_attempts 0   | 202, the same row (idempotent; first requester kept)   |
| RETRY_REQUESTED, replay_attempts > 0 | 202, `replay_attempts` reset to 0 (re-armed)           |
| REPLAYED                             | `409 DEAD_LETTER_ALREADY_REPLAYED` (retry the new row) |
| unknown / malformed id               | `404 DEAD_LETTER_NOT_FOUND` / `400 VALIDATION_FAILED`  |

**List** (`GET /api/admin/dlq`): keyset on `(failed_at, id)` newest first, cursor compared in SQL;
optional `status`. `DeadLetterView` decodes the key and value as UTF-8 (`raw_value`) and adds
`payload` = the value parsed as JSON (`z.json()`) or null.

**Vendor overrides** (`WalletService`, the one place that changes a vendor's standing, called by
`AdminVendorService` inside its transaction; the container now builds one `WalletService` shared with
`LedgerService`):

| Action  | Allowed when                                                                                                                                        | Effect (vendor row `FOR NO KEY UPDATE`)                                                                                          |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Suspend | status ≠ SUSPENDED (else 409 VENDOR_STATUS_CONFLICT)                                                                                                | SUSPENDED, `status_before_admin_suspension` = previous status                                                                    |
| Restore | SUSPENDED with a remembered status (admin, else debt; else 409 RESTORE_STATUS_UNKNOWN) and balance ≥ limit (else 409 WALLET_BELOW_SUSPENSION_LIMIT) | the remembered status; both columns cleared. A debt suspension can be lifted early by an admin (balance between the limit and 0) |

- Both write `vendor.status_overridden` in the same transaction and, after the commit, one JSON audit
  line (`console.warn`, `{"audit":"vendor.status_overridden",…,"admin_user_id"}`).
- **Paying never lifts an admin suspension:** `applyThreshold` only restores debt suspensions (the
  debt column), and the admin column is never set together with it. A debt-suspended vendor cannot
  be suspended by an admin on top (409); restore it or leave it.
- After an admin restore, SPEC §5 applies as before: the next debit below the limit suspends for
  debt again (tested).
- `GET /api/admin/vendors`: one REPEATABLE READ snapshot, by business name, capped at 500 (no
  pagination), with `suspension` NONE / DEBT / ADMIN / UNSPECIFIED and `restore_status`.

**Admin web app** (`apps/admin`, §2): Vite 8 + React 19 SPA, English only (SPEC's bilingual rule is
the customer/vendor app's). Sign-in = the existing OTP endpoints; a non-SUPER_ADMIN account is refused
on the screen and its tokens dropped. The access token lives in memory only; **since Phase 16 the
refresh token is an HttpOnly cookie** and a reload restores the session (§8J; Phase 15 kept both tokens
in memory and a reload signed out). The client renews on a 401 `UNAUTHENTICATED` with one single-flight
refresh, like the mobile app. Every body is validated with the shared Zod schemas. Screens: **Dead letters** (status chips,
cards with failure reason, source, key, replay link, message JSON + headers, Retry / "Retry again",
"Load older", auto-refresh every 3 s while a retry is queued) and **Vendors** (search, status badge,
suspension reason, wallet balance in red when negative, two-step Suspend / Restore with the reason a
Restore is disabled). `vite build` → `dist/` (~780 kB JS: zod + shared-types' geography tables; no
code splitting yet).

**Tests.**

- Worker unit (`dead-letter.test.ts`, 13): row before Kafka, row insert failure → no publish +
  rethrow, `replay_of` linking and `dlq_*` stripping, non-uuid link ignored, 2000-char row error,
  header decoding; plus the Phase 14 cases.
- Worker integration: `vendor-notifications.int.test.ts` now asserts the rows (4 × 503 → one PENDING row
  equal to the Kafka copy; success on the 3rd retry → no row; poison pill → row with null event id);
  `dead-letter-replayer.int.test.ts` (6, **real Postgres + Kafka**): republished byte for byte with
  `dlq_replay_of` and marked REPLAYED, PENDING/REPLAYED untouched, broker refusal keeps
  RETRY_REQUESTED with the error and stops at `maxAttempts`, 4 concurrent replayers publish once, a
  failing replay becomes a linked row, 3 concurrent saves of one offset → one row.
- API integration: `admin-dlq-api.int.test.ts` (13: full view incl. decoded payload, poison pill,
  paging without gaps + status filter, bad query/cursor, 202 + who/when, idempotent repeat, 4
  simultaneous admins, a request waiting on another's row lock, re-arm, 409 replayed, 404/400,
  roles, CHECK), `admin-vendors-api.int.test.ts` (17: list with balances and all four suspension
  kinds, suspend + event + audit line, 409s, 5 concurrent suspends, an override waiting on another's
  row lock, top-up does not lift an admin suspension, restore LIVE/APPROVED/SANDBOXED, restore refused
  below the limit, early lift of a debt suspension then re-suspension by the next debit, 404/400,
  roles, CHECK).
- shared-types (`api/admin.test.ts`, 8) and admin app (33: API client renewal branches, endpoint
  wiring, session store, formatting in Nepal Time, sign-in / DLQ / vendor rules).
- Mutation-checked: no limit check on restore (1 fails), admin suspension written to the debt column
  (4), no vendor row lock (1), no DLQ row lock (1), retrying a REPLAYED row (1), replayer without its
  row lock (1), row stored after the Kafka copy (2).
- **Live run (local infra, not a device):** API + worker + Vite dev server; a poison pill produced to
  `notifications.broadcast` → row PENDING → Retry 202 → REPLAYED → failed again → new row with
  `replay_of_id` → retry of the replayed row 409; suspend / suspend again (409) / restore of a
  seeded vendor with audit lines; a VENDOR token on `/api/admin` → 403; headless Edge signed in as
  9800000099 and rendered both screens with that data. Two dead letters with key
  `live-check-…` were left in the dev database.

## 8H. Worker resiliency: dead-letter queue, stale-order guard, IVR call (Phase 14)

Infrastructure §1 (Kafka, SMS fan-out, the 90 s escalation) and §6 (IVR escalation). Code:
`apps/worker/src/consumers/{dead-letter,vendor-notifications,index}.ts`,
`apps/worker/src/notifications/{order-state-reader,vendor-ivr}.ts`, `packages/ivr`.

```
Kafka notifications.broadcast ──▶ withDeadLetter( vendorNotificationConsumer )
  attempt 1 ─ fail ─▶ 1 s ─▶ retry 1 ─ fail ─▶ 2 s ─▶ retry 2 ─ fail ─▶ 4 s ─▶ retry 3 ─ fail
     └─▶ producer.send(notifications.dlq, same key + value, original headers + dlq_*) ─▶ return
         (eachMessage resolves → offset committed → next message on the partition)
  PoisonMessageError (unparseable envelope) ─▶ straight to notifications.dlq (1 attempt)
  DLQ publish fails ─▶ error propagates ─▶ offset NOT committed ─▶ Kafka redelivers (never dropped)

vendor.escalation.required ─▶ SELECT state FROM orders WHERE id = order_id
  state ≠ PLACED (accepted, rejected, canceled, dispatched) or no row ─▶ return
      (no SMS, no call, no claim, no DLQ)
  PLACED ─▶ Promise.allSettled([ SMS (SMS_PROVIDER), IVR call (IVR_PROVIDER) ])
```

**Dead-letter queue** (`withDeadLetter(consumer, { name, deadLetterTopic, publisher, maxRetries?,
retryDelayMs?, sleep?, now?, onDeadLettered? })`):

- Retries are **in-process** (the handler is re-run inside the same `eachMessage`), not Kafka
  redeliveries: this gives real backoff and a deterministic count. `DEAD_LETTER_MAX_RETRIES = 3`,
  `defaultRetryDelayMs` = 1 s, 2 s, 4 s (the partition waits ~7 s per failing message; the other
  partition keeps flowing). A worker crash mid-retries restarts the count at the redelivery.
- The dead letter: topic `KAFKA_TOPICS.NOTIFICATIONS_DLQ = 'notifications.dlq'` (2 partitions,
  `infra/kafka/create-topics.sh`), **key and value byte for byte** (a replay can republish it
  unchanged, and a poison pill is preserved as it arrived), the original headers (`event_id`,
  `event_type`, `event_version`) plus `dlq_source_topic`, `dlq_source_partition`,
  `dlq_source_offset`, `dlq_consumer` (`vendor-notifications`), `dlq_attempts` (4, or 1 for a
  poison pill), `dlq_error_name`, `dlq_error_message` (≤ 1000 chars), `dlq_failed_at`.
- Published through the worker's existing idempotent producer (`KafkaDeadLetterPublisher`), then one
  JSON line is logged: `{"notification":"dead_lettered","consumer",…,"attempts","error"}`.
- `PoisonMessageError`: thrown by the consumer for an envelope that fails `domainEventSchema`
  (replacing Phase 13's log-and-skip on this topic); never retried.
- Only `notifications.broadcast` is wrapped. `order.lifecycle` keeps its Phase 8/10 behaviour
  (invalid envelopes skipped, other failures redelivered by Kafka without limit). Nothing consumes
  `notifications.dlq` yet (inspect it with `kafka-console-consumer.sh --property print.headers=true`).

**Stale-order guard.** For `vendor.escalation.required` only, `DatabaseOrderStateReader.currentState`
reads `orders.state` (plain read, no lock) **on every attempt**, before any claim. Anything but
`PLACED` (or a missing order) returns silently without notifying. This closes the Phase 13 gap where
a consumer backlog could text a vendor about an order already answered. A small window remains
between the read and the provider call (not locked on purpose: holding the order row lock across
an SMS/IVR HTTP call would block the vendor's accept).

**IVR call** (`@hamro-pasal/ivr`):

- `IvrGateway.call({ to, script })`; every adapter goes through `prepareOutboundCall` (strict
  `+9779XXXXXXXXX` via `normalizeNepalPhone`, script 1–500 chars). `ivrGatewayFromEnv(env)`:
  `IVR_PROVIDER=MOCK` → `MockIvrGateway`, which prints (console.info, no network)
  `[ivr:mock] Calling +9779800000011: "You have a pending order on Hamro Pasal. Order 4 F A 5 B 6 has waited over 90 seconds. Open the app now to accept or reject it."`;
  `DISABLED` (the default) → `null`, so escalations are SMS only.
- `IVR_PROVIDER` (`parseServerEnv`, enum `MOCK | DISABLED`, default `DISABLED`): **MOCK is refused
  with `NODE_ENV=production`**. No real provider exists: Twilio Voice / a SIP trunk is one more
  adapter and enum value. A local `.env` needs `IVR_PROVIDER=MOCK` to see the log line.
- Script (`notifications/vendor-ivr.ts#vendorEscalationCall`): the dashboard's order code spelled
  out one character at a time for text-to-speech; the SLA seconds come from the event.
- SMS and call run **concurrently** (`Promise.allSettled`), each with its own Redis claim
  (`notifications:ivr:seen:{event_id}`, 24 h). If one fails, only its claim is released and the
  handler throws (an `AggregateError` if both fail), so a retry repeats only the failed channel
  (tested: IVR down → the retry calls without texting again). A dead-lettered event has its failed
  channel unclaimed, so a future replay would deliver it.
- After a call the worker logs `{"notification":"ivr.placed",…,"provider"}` (no phone, no script).

**Tests.**

- `src/consumers/dead-letter.test.ts` (7): pass-through, success on the 3rd retry (4 attempts,
  delays 1/2/4 s, no DLQ), DLQ after the 3rd retry with the exact record, poison at once, failed
  publish propagates, header truncation, default backoff.
- `src/consumers/vendor-notifications.test.ts` (21): the Phase 13 cases, poison →
  `PoisonMessageError`, SMS + call for a PLACED order, call started while the SMS is in flight,
  guard for PREPARING / CANCELED / OUT_FOR_DELIVERY / unknown (no claim), re-check on retry,
  per-channel claims, both failing, DISABLED, the MOCK log line. Also
  `src/notifications/vendor-ivr.test.ts` (3), `packages/ivr/src/ivr.test.ts` (7),
  `server-env.test.ts` (+1).
- `test/vendor-notifications.int.test.ts` (10, **real Postgres rows + OutboxRelay + Kafka + Redis**,
  with a second consumer reading the real `notifications.dlq`): 4 × Sparrow 503 → exactly 4
  attempts, the event in the DLQ byte for byte with its headers, the next message on the same
  partition texted, no further attempt; 3 × 503 → texted on the 4th attempt, nothing
  dead-lettered; a poison pill → DLQ at once (attempts 1) and the next message processed; an order
  moved to PREPARING or CANCELED after the timer wrote the event → no SMS, no call, no DLQ; a
  PLACED order → SMS + mock call.
- Mutation-checked: removing the guard (2 integration + 5 unit tests fail), `<` instead of `<=` for
  the retry count (2 + 2), rethrowing instead of committing after the DLQ publish (2 + 3),
  retrying poison pills (1 + 1).

## 8G. Vendor notification SMS (Phase 13)

SPEC §5 (the suspended vendor must learn why the app locked), vendor flow step 6 and
infrastructure §1/§6 (SMS fan-out, the 90 s escalation). Code: `packages/sms`,
`apps/worker/src/consumers/vendor-notifications.ts`, `apps/worker/src/notifications/vendor-sms.ts`.

```
API WalletService / worker sweep / worker 90 s timer ──(same tx)──▶ outbox
  ──OutboxRelay──▶ Kafka notifications.broadcast (key = vendor or order id)
  ──worker vendorNotificationConsumer──▶ vendorNotificationSms(event) ──▶ SmsGateway (SMS_PROVIDER)
```

| Event                        | SMS (plain ASCII, one 160-char segment; tested)                                                                                                     |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vendor.suspended_for_debt`  | `Hamro Pasal: your shop is offline. Your wallet is at Rs. -2,500, below the Rs. -2,000 limit. Pay Rs. 2,500 in the app's Wallet to go back online.` |
| `vendor.restored`            | `Hamro Pasal: your dues are cleared and your shop is back online. Wallet balance: Rs. 0.`                                                           |
| `vendor.escalation.required` | `Hamro Pasal: order #4FA5B6 has waited over 90 seconds. Open the app now to accept or reject it.`                                                   |

- **Recipient:** the event's `vendor_phone` (already `nepalPhoneSchema`), normalised again by
  `prepareOutboundSms`. Amounts use lakh grouping (`formatNpr`); the amount to pay is the dues
  (−balance), because a debt suspension lifts at 0 (§8F.1), not at the limit. The order code is the
  dashboard's (`VendorOrderCard`: last 6 hex digits, upper case). The SLA seconds come from the event.
- **Once per event:** `SET notifications:sms:seen:{event_id} 1 EX 86400 NX` before sending; a
  redelivery is skipped. A send that throws (`SmsDeliveryError`: HTTP error, timeout, refused
  `response_code`) deletes the claim and rethrows, so Kafka redelivers and it is retried. An invalid
  envelope is logged and skipped. Other event types on the topic are ignored without a claim.
- After the provider accepts, one JSON line is logged:
  `{"notification":"sms.sent","event_type","event_id","aggregate_id","provider"}` (no phone, no text).
- **`@hamro-pasal/sms`** (new workspace package, Node only): the adapters formerly in
  `apps/api/src/sms/sms-gateway.ts` (unchanged) plus `smsGatewayFromEnv(env, { mockLog?, fetch? })`,
  formerly `apps/api/src/container.ts`. The API and the worker both call it with their parsed env.
  **`SMS_PROVIDER=MOCK` makes no HTTP call** and prints `[sms:mock] to +977…: <text>` (console.info
  by default); it is refused in production by `parseServerEnv`.
- The worker's `ConsumerDeps` gained `sms`; `main.ts` builds it from env. No new topic or migration.
- **Tests:** `packages/sms/src/from-env.test.ts` (6: MOCK logs without fetch, default console,
  Sparrow form fields and URL, Aakash, FIREBASE / missing credentials refused);
  `apps/worker/src/notifications/vendor-sms.test.ts` (13: each template verbatim, tightened limit
  with paisa, null for other events, one ASCII segment, `formatNpr`, `orderCode`);
  `apps/worker/src/consumers/vendor-notifications.test.ts` (10: topic, template sent, redelivery
  once, failure releases + retry sends, other events unclaimed, 3 invalid envelopes skipped, MOCK
  log, routing); `apps/worker/test/vendor-notifications.int.test.ts` (4, **real Postgres outbox +
  OutboxRelay + Kafka + Redis**: all three events arrive at the Sparrow adapter as the exact
  `token/from/to/text` form, a republished envelope texts once, a Sparrow HTTP 503 is redelivered
  and accepted on the second attempt, MOCK logs the body with no HTTP call). Mutation-checked: not
  releasing the claim on failure (1 unit + 1 integration fail), ignoring the claim result (1 + 1).

## 8F. Vendor wallet and nightly debt reconciliation (Phase 12)

SPEC §5 (Financial Governance, negative wallets) and edge case 2. Code:
`apps/api/src/wallet/vendor-wallet-service.ts`, `routes/vendor-wallet.ts` (mounted at
`/api/vendors/wallet` behind `requireAuth(VENDOR)`, before the customer catalogue); worker
`wallet/vendor-debt-reconciliation.ts`, `queues/processors.ts#createTimerHandlers`.

**Balance** (`VendorWalletService.balance`, one REPEATABLE READ read-only transaction):

- `wallet_balance_npr` = `vendors.wallet_balance_npr` (the ledger projection); `status` and
  `is_suspended` (= `status === 'SUSPENDED'`; SPEC's column is `status`, the prompt's
  `is_suspended` is derived); `suspension_limit_npr` from `platform_settings`.
- `pending_escrow_npr` = what settlement will credit the vendor for prepaid (ESEWA/KHALTI) orders
  that are PAID and in PLACED / PREPARING / OUT_FOR_DELIVERY / DISPUTED: subtotal − commission, plus
  the delivery fee on SELF_DELIVERY orders. Refunds only exist on CANCELED/FAILED orders, which
  these states exclude. `pending_escrow_order_count` counts them.

**Ledger** (`VendorWalletService.ledger`): the vendor's VENDOR_WALLET `ledger_entries` ⋈
`ledger_transactions` ⟕ `orders`, newest first by `(created_at, id)`. Keyset pagination on the
entry id: the cursor row is compared **in SQL** (`(created_at, id) < (SELECT … WHERE id = cursor)`),
so microsecond timestamps are never rounded through JS. A cursor that is not an entry of this
wallet → `400 INVALID_CURSOR`. `balance_after_npr` = sum of every posting up to the page's newest
entry, then walked down the page in paisa. `entry_type`: ORDER_SETTLEMENT < 0 →
`COD_COMMISSION_DEBIT` (the only settlement that debits a vendor), > 0 → `ORDER_PAYOUT`;
VENDOR_TOP_UP → `TOP_UP`; ADJUSTMENT (and a PAYMENT_CAPTURE, which never touches a vendor wallet)
→ `ADJUSTMENT`. `order` carries payment method, fulfilment, subtotal, fee and commission (the
vendor may see its own commission; customer views still never do).

**Nightly reconciliation** (`VENDOR_DEBT_RECONCILIATION`, a second scheduler on the existing
`midnight-maintenance` queue, `0 0 * * *` Asia/Kathmandu, id `vendor-debt-reconciliation`):

- Why: `enforce_vendor_wallet_limit` suspends only when a vendor row is written, so a vendor already
  at −1500 when the Super Admin tightens the limit from −2000 to −1000 would keep trading.
- One transaction: read the limit; `SELECT … FOR NO KEY UPDATE` (ordered by id) every vendor with
  `status <> 'SUSPENDED' AND wallet_balance_npr < limit` (strictly below, **the trigger's rule**);
  set them SUSPENDED (Phase 12.5: remembering `status_before_debt_suspension`, so a top-up restores
  them); one `vendor.suspended_for_debt` outbox event each. The WHERE is re-checked on
  the locked row, so a top-up committing first saves the vendor. Healthy rows are not written.
- The handler writes one structured JSON audit line per suspension (`console.warn`,
  `{"audit":"vendor.suspended_for_debt",…}`; SPEC infrastructure §5) and fails the job on error
  (BullMQ retries, 3 attempts). A rerun finds nothing.
- `SUBSCRIPTION_DOWNGRADE` is still a logging placeholder.

Tests: `apps/api/test/vendor-wallet-api.int.test.ts` (12: zero balance, −100 COD debit, suspended at
−2500 still answered, escrow share 950 + 900 with refunded/unpaid/COD/settled excluded, entry
labels and breakdown, 5 entries paged 2/2/1 with chained balances, empty, foreign/unknown cursor,
validation, 401/403/404); `apps/worker/test/vendor-debt-reconciliation.int.test.ts` (6: only
strictly-below vendors suspended incl. APPROVED, healthy rows byte-identical, event payload,
trigger-suspended vendor skipped, rerun + 4 concurrent sweeps → one event each, top-up before the
sweep, through BullMQ with the audit line, exactly-at-limit not a breach); `queues.int.test.ts` now
expects both schedulers. Mutation-checked: `<=` instead of `<` in the cursor (4 fail), CANCELED
counted as escrow (1), `lte` in the sweep (2), no status filter (5), no row lock (1).

### 8F.1 Application-layer suspension and top-ups (Phase 12.5)

**What the prompt asked vs what was built.** The prompt asked to drop the suspension trigger and
move the rule into a WalletService, and to restore vendors to `'ACTIVE'`. Asked and decided with the
user: the **trigger is kept** (SPEC §5 says "a database trigger automatically mutates the vendor's
status"; it also lets `vendors_wallet_balance_floor_check` accept a breaching debit), the service
runs **on top of it**; vendors are restored to their **previous status** (no ACTIVE status exists);
the mock top-up is **dev-only**. **No migration drops the trigger**; migration 0014 only adds
`status_before_debt_suspension`.

**`WalletService`** (`apps/api/src/wallet/wallet-service.ts`), called by `LedgerService.post` for every
journal with a VENDOR_WALLET posting (settlements, top-ups, adjustments; `LedgerService` now takes it
in its constructor):

1. `lockStandings(tx, vendorIds)` **before** the postings: `SELECT … FOR NO KEY UPDATE` of the vendor
   rows in id order (serialises journals per vendor; NO KEY so new orders' FK checks on the vendor are
   not blocked), remembering each status.
2. Postings are inserted (the trigger may flip the row to SUSPENDED here).
3. `applyThreshold(tx, before, transactionId)` **after** them, same transaction:
   - balance **strictly below** the current limit and the vendor was not SUSPENDED **before the
     journal** → `status = SUSPENDED`, `status_before_debt_suspension = <previous>`,
     `vendor.suspended_for_debt` to the outbox. Judged on the captured status, not the row's current
     one, because the trigger has already flipped the row;
   - vendor SUSPENDED **with** `status_before_debt_suspension` set and balance **≥ 0** → that status is
     restored, the column cleared, `vendor.restored` written. The threshold is 0, not the limit (SPEC:
     "until they clear the negative balance"): a partial payment to −1500 leaves the shop offline;
   - an admin suspension (column null) is never lifted; a further debit of a suspended vendor writes
     nothing; a replayed journal (duplicate idempotency key) never reaches the service.
4. The result's `standingChanges` lists what happened (the top-up uses it for `restored`).

Events are written to the **transactional outbox** in the posting's transaction and published to
Kafka (`notifications.broadcast`, key = vendor id) by the worker's OutboxRelay; nothing calls Kafka
directly from a request. The trigger's `pg_notify` still fires but has no listener. No audit log
line is written by the API (the outbox row is the durable record; the worker's sweep still logs).

**Top-up** (`POST /api/vendors/wallet/top-up`, `wallet/vendor-top-up-service.ts`):

- `WALLET_TOP_UP_MODE` (`parseServerEnv`): `DISABLED` (default) → `503 TOP_UP_UNAVAILABLE`; `MOCK` →
  credits **without any payment**; `MOCK` with `NODE_ENV=production` fails at startup. Tests default to
  MOCK (`buildTestApp({ walletTopUpMode })`).
- One transaction: the caller's vendor, then a balanced `VENDOR_TOP_UP` journal
  **GATEWAY_CLEARING(ESEWA) −X → VENDOR_WALLET +X** (the shape a real eSewa capture will have),
  idempotency key `vendor-top-up:<vendor id>:<client key>` (scoped per vendor). A replay with the same
  amount → 200 `replayed: true`, one credit; another amount → `409 IDEMPOTENCY_KEY_REUSED`.
- Clearing the debt restores the vendor through `WalletService` in the same commit (`restored: true`
  only on that request).
- `GET /api/vendors/wallet/balance` gained `suspended_for_debt` (SUSPENDED with the column set), so the
  app can offer payment after a partial top-up leaves the balance above the limit but negative.
- The worker's nightly sweep (Phase 12) now sets `status_before_debt_suspension` too.

Tests: `apps/api/test/wallet-service.int.test.ts` (12: suspension at the crossing posting with its
event, −100 stays LIVE, no second event, tightened limit, 5 concurrent crossings → one event, replayed
journal, restore to LIVE with `vendor.restored` + transaction id, still suspended at −1500, payout
restores APPROVED as APPROVED, admin suspension not lifted, 4 concurrent top-ups → one restore,
suspend again after a restore); the top-up block of `vendor-wallet-api.int.test.ts` (8: pay off + ledger
entry + clearing account, partial, healthy, 5 concurrent same-key → one credit + 409 on another
amount, per-vendor keys, validation, roles, 503 when DISABLED) and `suspended_for_debt` for admin vs
debt; `apps/worker/test/outbox-relay.int.test.ts` relays both events through **real Kafka** to
`notifications.broadcast` in order with the vendor id as key. Mutation-checked: judging the transition
on the row's current status (11 fail), restoring at the limit instead of 0 (3), no row lock (1).

## 8E. Dispatch and the doorstep OTP handoff (Phases 11 and 11.5)

> **Phase 21 changed the rider's half of this section.** `GET /api/driver/orders` and
> `POST /api/driver/orders/:id/deliver` and `DriverOrderService` no longer exist; the rider works
> through `/api/deliveries` (§8N) and must accept and pick up before the code is checked. Dispatch,
> the shared `DeliveryHandoff` (steps 2–4 below), the lockout and everything about the vendor's
> SELF_DELIVERY handoff are unchanged. Dispatch of a fleet order now also inserts its `deliveries`
> row. The paragraphs "Which orders a rider sees" and "Deliver" below describe Phase 11 and are
> kept for the handoff's rules only.

SPEC vendor flow step 8, customer journey 10, delivery partner flow step 5. Code:
`apps/api/src/orders/vendor-order-service.ts#dispatch`, `orders/driver-order-service.ts`,
`orders/delivery-otp-attempts.ts`, `routes/{vendor-orders,driver-orders}.ts`.

**Dispatch** (`POST /api/vendors/orders/:id/dispatch`, VENDOR, same ownership rule as accept/reject):
PREPARING → OUT_FOR_DELIVERY + `order.state_changed` under the order row lock. OUT_FOR_DELIVERY →
200 same body (no event); any other state → `409 ORDER_STATE_CONFLICT`. **Refused with
`422 CANCELLATION_WINDOW_OPEN` (`details.retry_after_seconds`) while
`clock_timestamp() - placed_at <= 60 s`** (user decision): once out for delivery the customer can no
longer cancel, so an early dispatch would cut the unskippable window short. Same boundary and clock
as the cancel, so exactly one of cancel / dispatch can succeed. Applies to every fulfilment mode (the
prompt's rule; SPEC's "If Platform Fleet, waits for driver" pickup step is not modelled).

**Which orders a rider sees** (user decision; nothing assigns gigs yet): state OUT_FOR_DELIVERY,
`fulfillment_locked` PLATFORM_FLEET or EMERGENCY_FLEET, and `driver_user_id` null (an open gig) or the
caller. SELF_DELIVERY orders belong to the vendor's staff and are `404` to riders; so is another
rider's order. `GET /api/driver/orders` lists them (oldest placement first, max 100, `no-store`) as
`driverOrderSchema` = OrderView + `vendor_business_name`, `delivery_address`, `items`,
`assigned_to_me` (no customer id, name or phone, no hash).

**Deliver** (`POST /api/driver/orders/:id/deliver { delivery_otp: 4 ASCII digits }`, DRIVER), one
transaction under `SELECT … FOR UPDATE` on the order:

1. not carriable by this rider → `404 ORDER_NOT_FOUND`; already DELIVERED by this rider → 200 same
   body (retry after a lost response); any other state → `409 ORDER_STATE_CONFLICT` (no attempt
   counted);
2. locked (≥ 5 failures in Redis) → `429 DELIVERY_OTP_LOCKED` `details.retry_after_seconds`, **even for
   the right code**;
3. `bcrypt.compare` against `orders.delivery_otp`. Wrong → Lua `INCR` of
   `delivery-otp:failures:{order}` (the 1st failure sets a 15 min TTL, the 5th restarts it): failures
   1–4 → `401 INVALID_OTP` `details.attempts_remaining` (4 → 1); the 5th → 429. Counted per order,
   whoever types it;
4. match → `state = DELIVERED`, `delivered_at = now()`, `delivery_otp = NULL` (no replay),
   `driver_user_id = caller`, then `SettlementService.settleOrderInTransaction` (**user decision**, SPEC
   "Escrow releases": a COD order becomes PAID, the rider's float is debited S and credited the fee),
   then `order.state_changed` with the settled row, all in one commit. After commit the Redis
   counter is deleted (best effort).

- The row lock serialises guesses for one order, so none slips past the limit (tested: 10 concurrent
  wrong codes → exactly four 401s and six 429s; 5 concurrent right codes → one delivery, one
  settlement journal).
- Constants in shared-types: `DELIVERY_OTP_LENGTH` 4, `DELIVERY_OTP_MAX_ATTEMPTS` 5,
  `DELIVERY_OTP_LOCKOUT_SECONDS` 900 (tests shorten the lockout via
  `Infrastructure.deliveryOtpOptions`).
- The checkout replay's OTP rotation now updates only while the order is still in a rotatable
  state, so a replay racing the delivery cannot write a new hash onto a delivered order.
- Tests: `test/driver-orders-api.int.test.ts` (23) and the dispatch block of
  `test/vendor-orders-api.int.test.ts` (8). Mutation-checked: skipping the lockout check, dropping the
  row lock and keeping the hash each fail tests; allowing dispatch inside the window fails 2.

**One handoff for rider and vendor (Phase 11.5).** Steps 2–4 above live in
`orders/delivery-handoff.ts#DeliveryHandoff.handOver(tx, lockedOrder, otp, driverUserId | null)` (+
`afterCommit`, which clears the counter). The container builds **one** instance (one
`DeliveryOtpAttempts`) and gives it to both `DriverOrderService` and `VendorOrderService`; the services
differ only in which order they may lock. The error classes moved there too.

**Vendor handoff** (`POST /api/vendors/orders/:id/deliver { delivery_otp }`, VENDOR; vendor flow step 9):
the order is locked through the vendor's ownership (`lockVendorOrder`, another shop's order or an
unknown id is 404), then:

1. `fulfillment_locked` is not SELF_DELIVERY → **`409 WRONG_FULFILLMENT_MODE`** (`details.fulfillment`),
   checked **before** any code, so a vendor can never burn a fleet order's attempts or lock its rider
   out (tested: 6 wrong codes from the vendor → no counter, and the rider then delivers);
2. already DELIVERED → 200 same body; otherwise `DeliveryHandoff.handOver(…, null)`: no rider is
   recorded (`driver_user_id` stays null, as the fleet CHECK allows for SELF_DELIVERY).

- Settlement is the existing SELF_DELIVERY plan: COD debits the commission from the vendor wallet
  (tested: 1000 NPR at 10% → −100; a 25 000 NPR order → −2500 and the vendor is **SUSPENDED** by the
  wallet trigger, the delivery still commits); prepaid pays the vendor S − C + delivery fee (950).
- The rider endpoint still refuses SELF_DELIVERY orders (404), so each order has exactly one party
  that can hand it over.
- `GET /api/vendors/orders` now also lists the shop's **SELF_DELIVERY orders OUT_FOR_DELIVERY**, after
  PLACED and PREPARING (`dashboardRank`); a fleet order leaves the list once dispatched.
- Request/response contracts are shared by both endpoints and were renamed from Phase 11's
  `driverDeliver*`: `deliveryOtpRequestSchema`, `deliveryConfirmedResponseSchema`
  (`routes/views.ts#deliveryConfirmedBody`).
- Tests: `test/vendor-delivery-api.int.test.ts` (21): transition, hash erased, no rider, COD and
  prepaid settlement, suspension, repeat, 5 concurrent right codes → one delivery, fleet and
  EMERGENCY_FLEET refused without counting, rider endpoint closed to SELF_DELIVERY, 401 countdown,
  5th → 429 then the right code refused, 10 concurrent wrong → 4 × 401 + 6 × 429, lockout expiry,
  PREPARING → 409 without counting, 404s, roles, validation, list contents and order.
  Mutation-checked: dropping the SELF_DELIVERY gate fails 3.

## 8D. Vendor order management and the 90-second SLA (Phase 10)

SPEC vendor flow steps 6–7 and infrastructure §1/§6. Code: `apps/api/src/orders/vendor-order-service.ts`,
`routes/vendor-orders.ts`; worker `consumers/vendor-sla-scheduler.ts`, `sla/vendor-escalation.ts`.

**Ownership.** Every vendor route addresses the order through its vendor: `orders ⋈ vendors ON
vendors.user_id = caller`, locked `FOR UPDATE OF orders`. Another vendor's order and unknown ids are
`404 ORDER_NOT_FOUND`; customers/drivers get 403 at `requireAuth(VENDOR)`.

| Decision | Allowed from | Effect (one transaction)                                                                                                                                                     | Repeat / conflict                                                                                    |
| -------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| accept   | PLACED       | state → PREPARING, `order.state_changed`. Stock untouched (decremented at placement)                                                                                         | PREPARING → 200 same body (no new event); anything else → `409 ORDER_STATE_CONFLICT` `details.state` |
| reject   | PLACED       | `cancelPlacedOrder`: stock back, state → CANCELED, `order.state_changed`; PAID → `refund_required` + `order.canceled_refund_due`; lingering Redis hold released after commit | CANCELED (by either side) → 200 same body; PREPARING etc. → 409                                      |

- No time limit on either decision (the 60 s window is the customer's only; SPEC's 3-minute vendor
  acceptance window is **not enforced**, §13). Tested: concurrent accepts → one event; concurrent
  rejects → stock and refund once; simultaneous accept + reject → exactly one wins.

**The 90 s SLA.**

```
order → PLACED ──(same tx)──▶ outbox order.state_changed ──relay──▶ Kafka order.lifecycle
  ──worker vendor-sla-scheduler──▶ BullMQ vendor-acceptance-timeout (jobId = order id,
     delay = placed_at + 90 s − now, ≥ 0)
  ──fires──▶ VendorEscalationService.escalateIfUnanswered (tx, order row FOR UPDATE):
       state ≠ PLACED            → NOT_PENDING (vendor answered / customer canceled)
       escalation row exists     → ALREADY_ESCALATED (retried job)
       else                      → outbox vendor.escalation.required (notifications.broadcast)
```

- Scheduling from the outbox event (not from the API after its commit) means a crash cannot lose the
  timer. The delay is anchored on `placed_at`, so relay/Kafka lag does not stretch the SLA (the
  worker's clock vs the DB clock is assumed NTP-close).
- Accept/reject take the same row lock as the escalation, so a decision at 89.9 s and the timer
  cannot both win. The timer is **not cancelled** on accept; it fires and finds the order no longer
  PLACED (the `cancelVendorAcceptanceTimeout` helper exists but is unused).
- "No app interaction" is read as "no decision": opening the dashboard without answering does not
  stop the escalation.
- Tests (`apps/worker/test/vendor-sla.int.test.ts`, real Postgres + BullMQ, 10): escalation payload,
  NOT_PENDING for PREPARING/CANCELED/unknown, 5 concurrent + retried runs → one row, DB refuses a
  second row, job scheduled at placed_at + 90 s (and once per redelivery), overdue job fires at once,
  accepted-before-due → nothing, unanswered → escalated. No test waits 90 s (backdated
  `placed_at`, `job.promote()`). Mutation-checked: escalating regardless of state, dropping the
  already-escalated check, and anchoring on receipt instead of `placed_at` each fail a test.

**Vendor room on `/orders`.** `ALLOWED_ROLES` is now CUSTOMER + VENDOR. `vendor:subscribe` (no payload,
ack `vendorSubscribeAckSchema`) joins `vendor:{vendorId}` for the caller's own shop: `FORBIDDEN` for
non-vendors, `VENDOR_NOT_FOUND` for a shopless vendor. Order rooms stay customer-only (a vendor's
`orders:subscribe` gets `ORDER_NOT_FOUND`). The worker fans every placed order's
`order:state_update` to both rooms (`orderStateUpdateRooms`); the redis-emitter publishes one message
for several rooms. Tested in `test/orders-realtime.int.test.ts` ("vendor room", 4).

## 8C. Reviews, dispute chat `/chat` and evidence uploads (Phases 9 and 9.5)

**Reviews (SPEC §6).** `apps/api/src/reviews/review-service.ts#ReviewService`; routes
`routes/reviews.ts` (customer, `POST /api/reviews`) and, since Phase 9.5, `routes/vendor-orders.ts`
(vendor, `POST /api/vendors/orders/:id/reviews`, mounted before the customer catalogue under
`/api/vendors` with `requireAuth(VENDOR)`). Both call the same `submit`, so the quarantine
transaction is identical: a vendor review of an order the customer already reviewed publishes both
(tested: the customer's review goes from hidden to `publicReview` in one request).

- `submit({ orderId, direction, authorUserId, rating, feedback })`, one transaction under
  `SELECT … FOR UPDATE OF orders`: author = the order's customer (CUSTOMER_TO_VENDOR) or the vendor's
  `user_id` (VENDOR_TO_CUSTOMER), else `OrderNotFoundError` (404); state must be `DELIVERED` (409
  `ORDER_STATE_CONFLICT`); `clock_timestamp() < delivered_at + 48 h` (422 `REVIEW_WINDOW_CLOSED`: a late
  review would see the other side's already-public one); one per side (409 `REVIEW_ALREADY_SUBMITTED`).
- **Quarantine = SPEC's `is_published = false`.** The API exposes it as `status: QUARANTINED | PUBLISHED`
  (the prompt asked for `status: QUARANTINED`; SPEC's column wins, the status is derived). If the other
  side has already reviewed, **both rows are published in the same transaction** with the same
  `published_at`; otherwise the new row stays quarantined.
- **48 h rule without a sweeper:** `reviews/review-visibility.ts#reviewIsPublic()` is the SQL predicate
  `is_published OR delivered_at <= now() - 48 h`. `ReviewService.publicReview(orderId, direction)`
  (SPEC verification test 4) and the checkout COD-eligibility average both use it, so a single-sided
  review counts once 48 h have passed even though `is_published` was never flipped. Nothing flips it
  later (no BullMQ job); add one if the flag itself must become true.
- The row lock is what makes "both reviewed → publish both" race-free (mutation-checked: without it,
  simultaneous customer + vendor submissions leave both quarantined).

**Dispute access.** `disputes/dispute-service.ts#DisputeService.access(participant, orderId)`: the
order's customer or the vendor's user while `state = DELIVERED` and (`clock_timestamp() < delivered_at + 48 h`
**or the order's dispute is OPEN**, Phase 9.5: an opened dispute outlives the window until resolved);
`SUPER_ADMIN` always; anyone else (drivers included) `ORDER_NOT_FOUND`. The same rule gates evidence
uploads. `participantProfile(userId)` loads the **full** users row (last name and phone included) for
the chat's sender field.

**Transcript (Phase 9.5).** `DisputeService.recordMessage({ orderId, senderUserId, clientId, body,
attachments })`, one transaction:

1. `INSERT INTO disputes … ON CONFLICT (order_id) DO NOTHING RETURNING` (opened_by = sender, reason =
   the trimmed body or "Photo evidence submitted"), else read the existing dispute. Two simultaneous
   first messages open exactly one dispute (tested 5×; mutation-checked: a plain insert fails it);
2. `INSERT INTO chat_messages … ON CONFLICT (dispute_id, sender_user_id, client_id) DO NOTHING
RETURNING`, else read the stored row: a retried send is stored once and gets the same id back.

Returns `{ message, dispute, disputeOpened, replayed }`. Any participant's first message opens the
dispute (customer, vendor or admin). The order state is **not** changed (it stays `DELIVERED`, which
reviews and access rely on).

**Socket.io `/chat`** (`realtime/chat-namespace.ts#serveChatNamespace`, attached by `attachRealtime`
when `options.chat` is given, so it shares the `/orders` server, heartbeat and **Redis adapter**).
Contract: `packages/shared-types/src/realtime/chat-socket.ts`.

| Aspect    | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Handshake | `realtime/socket-auth.ts#socketAuth` (shared with `/orders`): bad/missing/expired token → `UNAUTHENTICATED`; roles CUSTOMER, VENDOR, SUPER_ADMIN, else `FORBIDDEN`                                                                                                                                                                                                                                                                                                                  |
| Join      | `chat:join { order_id }` (ack optional) → `DisputeService.access` → room `dispute:{order_id}`; ack `{ ok: true, order_id }` or `{ ok: false, error: { code: VALIDATION_FAILED \| ORDER_NOT_FOUND \| DISPUTE_WINDOW_CLOSED \| INTERNAL_SERVER_ERROR } }`. Access is decided once per order per connection                                                                                                                                                                            |
| Send      | `chat:new_message { client_id, order_id, body ≤ 2000, attachments ≤ 4 }` + ack. Anything else the client sends (sender, id, sent_at) is ignored. Same access rule (no join needed to send). Attachments must satisfy `EvidenceStorage.isEvidenceUrl(order, url)` (issued by the upload endpoint for that order)                                                                                                                                                                     |
| Broadcast | **Persisted first** (`recordMessage`; if that fails nothing is broadcast and the ack is `INTERNAL_SERVER_ERROR`). `id` = the `chat_messages.id`, `sent_at` = its `created_at`, `sender` = the sender's users row, then **`broadcastChatMessage` → `sanitizeChatMessage`**: `stripChatPii` deletes `last_name` / `phone_number` / `phone` at every depth, then the allowlist schema keeps `sender {id, first_name, role}` only. Emitted to the room; the ack carries the same object |

- **Privacy tests:** `src/realtime/chat-namespace.test.ts` (in-process, raw payloads received by the
  other party, spoofed senders, admin without first name; mutation-checked: bypassing the filter fails 4
  tests) and `test/chat-realtime.int.test.ts` (two API instances on one Redis adapter, real DB rows with
  surnames and phones, customer on one instance, vendor on the other).
- **Persistence tests** (`test/chat-realtime.int.test.ts`, "persistence"): the row exists with the
  broadcast's id/time; first message opens the dispute, later ones (either party) join it; vendor-opened
  and photo-only disputes; retried `client_id` stored once; simultaneous first messages → one dispute;
  OPEN dispute reachable at 49 h and closed again once resolved; refused messages store nothing.
  Mutation-checked: broadcasting without `recordMessage` fails 7 of them.
  **Transcript read-back (Phase 9.6).** `GET /api/orders/:id/chat` (`routes/order-chat.ts`, mounted at
  `/api/orders` behind `requireAuth(CUSTOMER, VENDOR, SUPER_ADMIN)` **before** the customer-only orders
  router; only `/:id/chat` matches there, every other path falls through, so vendors still get 403 on
  `GET /api/orders/:id`) → `DisputeService.transcript(participant, orderId)`:

- **Who:** the order's customer or the vendor's user (the `isParty` check shared with `access`) or a
  Super Admin; anyone else (and unknown ids) `404 ORDER_NOT_FOUND`; drivers 403 at the router. Unlike
  `access`, there is **no window check**: the parties can reread their own conversation after the
  48 h window and after resolution.
- **What:** `chat_messages` ⋈ `disputes` (by order) ⋈ `users` (sender), `ORDER BY created_at, id`,
  every row through **`disputes/chat-message-view.ts#publicChatMessage`**, the one function that turns a
  stored row + full users row into the public `ChatMessage`. The `/chat` broadcast now uses the same
  function (`broadcastChatMessage(namespace, row, orderId, sender)`), so REST and socket output are
  byte-identical (tested: the history equals the live ack). `Cache-Control: no-store`. No pagination:
  the whole transcript is returned.
- **Tests** (`test/chat-history.int.test.ts`, 8): order and filtered senders (raw body has no surname
  or phone), vendor and admin access, empty without a dispute, readable after the window and
  resolution, 404s for other customers/vendors/unknown ids, 401/403/400, other order routes unchanged,
  identical to the broadcast. Mutation-checked: returning the raw users row fails the PII tests.

**Evidence uploads (mock R2).** `uploads/evidence-storage.ts#LocalEvidenceStorage` writes
`<UPLOADS_DIR>/dispute-evidence/<order>/<uuid>.<ext>` (default `UPLOADS_DIR` = `apps/api/uploads` since
Phase 19, §8L; it was `os.tmpdir()/uploads`) and returns `<UPLOADS_PUBLIC_BASE_URL>/dispute-evidence/…` (default
`http://localhost:<API_PORT>/uploads`); `createApp` serves the directory there. multer (memory, 5 MB
limit, 1 file) → owner + 48 h window (`DisputeService.assertAccess`) → `sniffEvidenceType` (magic bytes;
the declared type is ignored) → save. **A phone cannot load `localhost`: set `UPLOADS_PUBLIC_BASE_URL` to
the host's LAN address for device runs.** Swapping in R2 means another `EvidenceStorage` implementation.

## 8B. Socket.io `/orders` (Phase 8)

Code: `apps/api/src/realtime/orders-namespace.ts#attachRealtime`, wired in `server.ts` (the HTTP
server is created with `createServer(createApp(container))`; the adapter gets its own `pub` and a
`pub.duplicate()` `sub` Redis connection; shutdown closes Socket.io, which closes the HTTP server).
Contract: `packages/shared-types/src/realtime/orders-socket.ts`.

```
state change ──(same tx)──▶ outbox order.state_changed ──OutboxRelay──▶ Kafka order.lifecycle
  ──worker order-state-fanout (dedupe event_id)──▶ Redis PUBLISH hamro-pasal:socket.io#/orders#order:{id}#
  ──@socket.io/redis-adapter on every API instance──▶ sockets in room order:{id} ──▶ 'order:state_update'
```

| Aspect      | Behaviour                                                                                                                                                                                                                                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server      | `transports: ['websocket']` (no sticky sessions needed behind the ALB), `pingInterval: 25000` (= `SOCKET_PING_INTERVAL_MS` = mobile `HEARTBEAT_INTERVAL_MS`), `pingTimeout: 20000`, 16 kB max message                                                                                                                |
| Adapter     | `@socket.io/redis-adapter`, key `SOCKET_IO_REDIS_KEY = 'hamro-pasal:socket.io'` (the worker's emitter must use the same key). Pub/sub is not scoped by Redis DB: tests use a unique key per run                                                                                                                      |
| Handshake   | `auth.token` verified with `verifyAccessToken` (HS256, issuer, audience, expiry). Missing/invalid/expired or a refresh token → `connect_error` message `UNAUTHENTICATED`, `data.code` the same. Non-CUSTOMER → `FORBIDDEN`                                                                                           |
| Subscribe   | `orders:subscribe { order_id }` **with ack**. `OrderService.isCustomerOrder` must hold, then join `order:{id}` → `{ ok: true, order_id }`. Otherwise `{ ok: false, error: { code } }`: `ORDER_NOT_FOUND` (not yours or unknown: no probing), `VALIDATION_FAILED`, `INTERNAL_SERVER_ERROR`. No ack function → ignored |
| Unsubscribe | `orders:unsubscribe { order_id }` leaves the room. Rooms die with the connection: clients re-subscribe after every reconnect                                                                                                                                                                                         |
| Update      | `order:state_update` = `orderStateUpdateSchema { order_id, state, payment_status, refund_required, placed_at, delivered_at, changed_at }` (the snapshot fields a state change can alter)                                                                                                                             |

- **Phase 21:** DRIVER accounts are admitted too (roles CUSTOMER, VENDOR, DRIVER; SUPER_ADMIN is
  still `FORBIDDEN`). A rider joins no room (`orders:subscribe` → `ORDER_NOT_FOUND`,
  `vendor:subscribe` → `FORBIDDEN`); they only emit `rider:location`, and the namespace gained the
  server event `order:rider_location` (§8N).
- The token is checked **only at the handshake**: a connection outlives its 15-min access token until
  it reconnects (§13).
- Tests: `apps/api/test/orders-realtime.int.test.ts` (outbox event for every transition, handshake
  refusals, ownership, room isolation, unsubscribe, a real cancel delivered, re-subscribe after
  reconnect) and `apps/worker/test/order-state-fanout.int.test.ts` (outbox → relay → Kafka → consumer
  → Redis → a Socket.io server with the adapter; other room gets nothing; redelivery once; failed
  broadcast retried).

## 8A. Authentication (Phases 7 and 7.5)

SPEC journey step 1 ("Auth via OTP (+977 only)") and implicit requirement 3 (15-min access tokens,
7-day refresh tokens). Code: `apps/api/src/auth/*`, `routes/auth.ts`; client `apps/mobile/src/api/{auth,http}.ts`.

### OTP flow (`OtpAuthService`)

1. **Send** (`POST /api/auth/otp/send`):
   - The phone must already be strict `+9779XXXXXXXXX` (`nepalPhoneSchema`); the app normalises input
     (Nepali digits, pasted +977) before sending.
   - Resend cooldown: `SET otp:cooldown:{phone} 1 PX 60000 NX`. If it is held, `429
OTP_RESEND_COOLDOWN` with the seconds left, and no SMS.
   - A fresh code (`crypto.randomInt`, 6 digits, leading zeros kept) **replaces** any earlier one
     (MULTI: DEL, HSET, PEXPIRE 120000), so an older SMS stops working. It is stored **before** the SMS
     is sent, so it already works when the SMS arrives.
   - SMS text (plain ASCII, one GSM-7 segment): "Hamro Pasal: your login code is NNNNNN. It expires in
     2 minutes. Do not share it with anyone." If the adapter throws, both keys are deleted (the customer
     can retry at once) and the API answers `502 SMS_DELIVERY_FAILED`.
2. **Verify** (`POST /api/auth/otp/verify`):
   - One Lua script (`CHECK_AND_CONSUME`, below) counts the attempt, compares the digest and consumes
     the code **atomically**. Outcomes: valid, `401 OTP_INVALID` (attempts_remaining 4 → 1), `429
OTP_ATTEMPTS_EXCEEDED`, `410 OTP_EXPIRED`.
   - Account: `INSERT … ON CONFLICT (phone) DO NOTHING`, then SELECT. An unknown number becomes a new
     **CUSTOMER** with `first_name` null (`is_new_user: true`). An existing account **keeps its role**
     (a vendor signing in gets a VENDOR token; customer routes then answer 403).
   - Returns both tokens (below) with `Cache-Control: no-store`.

### Atomic Redis OTP logic (`apps/api/src/auth/otp-store.ts`)

Every OTP state change is a **single Redis command, a MULTI/EXEC block or a Lua script**, so there is
no read-then-write gap for concurrent requests to slip through.

| Step                | Redis operation(s)                                                                                 | Atomicity                 | Guarantees                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------- |
| Cooldown claim      | `SET otp:cooldown:{phone} 1 PX 60000 NX`; if refused, `PTTL` for the seconds left                  | single command (`NX`)     | of N simultaneous sends for one phone, exactly one gets a code and an SMS; the rest get 429 |
| Save code           | `MULTI` → `DEL otp:code:{phone}` → `HSET … digest <hmac> attempts 0` → `PEXPIRE … 120000` → `EXEC` | transaction               | the old code is gone the instant the new one exists; the hash never exists without its TTL  |
| Undo on SMS failure | `DEL otp:code:{phone} otp:cooldown:{phone}`                                                        | single command            | a failed SMS leaves no usable code and no cooldown (retry at once)                          |
| Verify              | `EVAL CHECK_AND_CONSUME 1 otp:code:{phone} <hmac(phone:code)> 5`                                   | Lua (runs alone in Redis) | single use; attempts counted even under concurrency; the 5th wrong guess deletes the code   |

```lua
-- KEYS[1] = otp:code:{phone}   ARGV[1] = HMAC-SHA256(pepper, "phone:code")   ARGV[2] = 5
local digest = redis.call('HGET', KEYS[1], 'digest')
if not digest then return {-1} end                                   -- missing: 410 OTP_EXPIRED
local attempts = redis.call('HINCRBY', KEYS[1], 'attempts', 1)       -- every attempt counts
if digest == ARGV[1] then
  redis.call('DEL', KEYS[1])                                         -- consume: single use
  return {1}                                                         -- valid
end
if attempts >= tonumber(ARGV[2]) then
  redis.call('DEL', KEYS[1])                                         -- burn after the 5th miss
  return {-2}                                                        -- 429 OTP_ATTEMPTS_EXCEEDED
end
return {0, attempts}                                                 -- 401 OTP_INVALID, 5 - attempts left
```

- **Why Lua:** a HGET + compare + DEL done from Node would let two concurrent requests with the
  right code both read the digest before either deletes it, minting two sessions. Redis runs a script
  to completion before any other command, so the second request finds the key gone (`{-1}` → 410).
  Tested: 5 simultaneous correct submissions → exactly one 200 and four 410s, one account row.
- **Attempts are counted before comparing**, so a correct code on the 6th try is impossible: the 5th
  wrong attempt already deleted the key. Tested: 4 wrong → attempts left `[4, 3, 2, 1]`, 5th wrong →
  429, correct code afterwards → 410.
- **Expiry is Redis's own `PEXPIRE`**; the API never compares timestamps. Tested with a 300 ms TTL
  override: the code works before and returns 410 after.
- **Digest, not code:** the hash field holds `HMAC-SHA256(pepper, "+9779…:NNNNNN")` (hex). A code for
  one phone never verifies for another (the phone is inside the MAC). The Lua comparison is a plain
  string compare of two server-computed digests, not of user input against a secret.
- **Crash safety:** if the API dies between saving the code and sending the SMS, the code simply
  expires; nothing outlives its TTL, and no Postgres state is written until a code is consumed.

### Tokens

| Token   | Secret               | Audience              | TTL      | Claims                                | Where the app keeps it                                                                        |
| ------- | -------------------- | --------------------- | -------- | ------------------------------------- | --------------------------------------------------------------------------------------------- |
| Access  | `JWT_ACCESS_SECRET`  | `hamro-pasal-app`     | 900 s    | `sub`, `role`                         | memory only (`useAuthStore.accessToken`, never persisted); admin web: memory only             |
| Refresh | `JWT_REFRESH_SECRET` | `hamro-pasal-refresh` | 604800 s | `sub`, `typ: 'refresh'`, `jti` (uuid) | AES-256 MMKV (`hamro-pasal.secure`, key in the OS keychain); admin web: HttpOnly cookie (§8J) |

Different secrets **and** audiences: a refresh token is never accepted as an access token and vice
versa (tested both ways). `parseServerEnv` already refuses identical secrets.

### Token lifecycle and rotation (exact current state)

```
OTP verify ──▶ access A1 (15 min, memory)  +  refresh R (7 d, encrypted MMKV)
   │
   ├─ request with A1 ──▶ 200
   ├─ A1 expires ──▶ 401 ──▶ POST /token/refresh {R} ──▶ access A2 ──▶ replay ──▶ 200
   ├─ app relaunch (A gone, R kept) ──▶ POST /token/refresh {R} before the first request
   ├─ … lazily, at the next 401 after each expiry: A3, A4, … (R unchanged)
   └─ R expires / account deleted / R forged ──▶ 401 REFRESH_TOKEN_INVALID ──▶ client signs out
```

- **Access tokens rotate**: every refresh issues a brand-new 15-minute access token (fresh `iat`/`exp`,
  role re-read from Postgres). Old access tokens are not revoked; they simply expire within 15 min.
- **Refresh tokens do NOT rotate.** `/token/refresh` returns no new refresh token, the `jti` is
  never checked or stored, and the same `R` works for its full 7 days. Sign-out deletes the device
  copy only. **There is no server-side revocation or denylist**; the Phase 16 `POST /api/auth/logout`
  only clears the Super Admin's browser cookie (§8J). The cookie refresh (`/api/auth/refresh`) does
  not rotate either.
- **Implications:** a leaked refresh token is usable for up to 7 days; a customer is signed out after
  7 days no matter how active they are (no sliding window).
- **To add rotation later** (§11): on each refresh, issue `R'` with a new `jti`, record the old
  `jti` as used (Redis `SET … EX <remaining ttl>` or a Postgres table), and treat reuse of a used
  `jti` as theft (revoke the whole token family). The client already persists whatever
  `refresh_token` it is given, so it needs only `setSession` on refresh instead of `setAccessToken`.

**Refresh** (`POST /api/auth/token/refresh`, Phase 7.5): verifies signature, algorithm (HS256),
issuer, the refresh audience, `typ` and expiry, then **reads the role from the database** (a role
change applies at the next refresh; a deleted account gets `401 REFRESH_TOKEN_INVALID`). Returns only
a new access token. **The refresh token is not rotated and there is no server-side revocation**:
sign-out only forgets it on the device, and a copied refresh token stays valid for its 7 days (§13).
Every failure (forged, expired, wrong audience, access token sent, deleted account, garbage) is the
same `401 REFRESH_TOKEN_INVALID`.

### Redis boundaries

Redis holds only short-lived coordination state; **PostgreSQL is the source of truth** for anything
durable. Flushing Redis loses no orders, money or accounts (it only cancels live checkouts and
outstanding codes).

| Key                                  | Type           | TTL                                  | Owner                  | Purpose                                                                                    |
| ------------------------------------ | -------------- | ------------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------ |
| `inv:{vendorId}:res:{reservationId}` | string         | 600 s (`PX`)                         | `InventoryLockService` | the 10-minute cart lock (SPEC §3)                                                          |
| `inv:{vendorId}:holds:{productId}`   | hash           | follows the reservations             | `InventoryLockService` | live holds subtracted from Postgres stock                                                  |
| `mutex:checkout:{idempotency_key}`   | string         | 30 s lease                           | `RedisKeyedMutex`      | serialises same-key checkout retries                                                       |
| `otp:code:{phone}`                   | hash           | 120 s (`OTP_TTL_SECONDS`)            | `OtpStore`             | `{ digest, attempts }`; digest = HMAC-SHA256(pepper, "phone:code"), never the code         |
| `otp:cooldown:{phone}`               | string         | 60 s (`OTP_RESEND_COOLDOWN_SECONDS`) | `OtpStore`             | per-phone resend throttle                                                                  |
| `delivery-otp:failures:{order}`      | string         | 15 min                               | `DeliveryOtpAttempts`  | wrong doorstep codes per order (Phase 11)                                                  |
| `riders:active`                      | geo set (zset) | none (overwritten per report)        | `RiderLocationStore`   | Phase 21: `GEOADD` member = rider user id, the rider's last position                       |
| `riders:active:seen`                 | hash           | none                                 | `RiderLocationStore`   | Phase 21: rider user id → epoch ms of that report (a position older than 120 s is ignored) |

- **No session state lives in Redis.** Tokens are stateless JWTs; nothing about a signed-in user is
  stored server-side (hence no revocation yet).
- The OTP digest key (pepper) is derived as `HMAC-SHA256(JWT_ACCESS_SECRET, "hamro-pasal:otp-digest:v1")`
  (`container.ts#otpPepper`): no extra secret to provision, and the JWT key itself is never reused.
  Rotating `JWT_ACCESS_SECRET` invalidates outstanding codes (harmless: they last 2 min).
- BullMQ (worker) uses the same Redis. Integration tests use logical DB 15 (api) and 14 (worker).

### SMS providers (`@hamro-pasal/sms#smsGatewayFromEnv`, shared with the worker since Phase 13)

`SPARROW` and `AAKASH` send real SMS (strict +977 via `prepareOutboundSms`). `MOCK` records and
prints the message (`[sms:mock] …`); `parseServerEnv` refuses it when `NODE_ENV=production`.
`FIREBASE` makes the API and the worker **fail at startup**: Firebase Auth sends its own codes and
cannot deliver server-written text.

## 9. Mobile app: state as of Phase 7.5

Expo SDK 57 (`expo ~57.0.25`, `react-native 0.86.3`, `react 19.2.3`), Expo Router (typed routes),
strict TS, NativeWind 4.2.7 + **Tailwind 3.4** (NativeWind 4 requires v3), Reanimated 4.5.1,
TanStack Query 5, Zustand 5, i18next 26, react-native-mmkv 4.3.2 (+ nitro-modules),
react-native-webview 13.16.1, socket.io-client 4.8.4, expo-location, expo-image-picker,
expo-secure-store, expo-crypto, zod 4. `pnpm peers check` is clean.

**Phase 6** changed only logic: checkout sends the delivery address (§9.4), the idempotency
fingerprint includes it, and the territory gate reads the shared `NEPAL_BOUNDING_BOX` (§9.7).
**Phase 6.5** linked the app to the live API and deleted the mocks:

- **Deleted:** `features/feed/{mock-feed-api,feed-contract,serviceability}.ts`,
  `features/menu/{mock-menu-api,menu-contract}.ts`, `features/order/mock-cancel-api.ts`, and their
  tests. The app now uses the shared-types schemas (`feedResponseSchema`, `vendorMenuSchema`,
  `orderDetailResponseSchema`, `cancelOrderResponseSchema`) and types (`FeedEntry`, `VendorMenu`,
  `MenuProduct`, `OrderSnapshotView`). Client-side serviceability (haversine) is gone: the server
  decides (§8).
- **Customer location** (`features/location/customer-location.ts`): `useCustomerLocation()` returns
  the saved address's `exact_lat`/`exact_lng` and Palika from `useAddressStore` (encrypted MMKV), or
  `THAMEL_FALLBACK_LOCATION` (27.7154, 85.3123, Kathmandu Metropolitan City) when none is saved. The
  Palika is sent as `municipality_palika_string` so CITY_WIDE vendors can match. Changing the saved
  address changes the query key, so the feed and menus refetch. **Live GPS is not used for the feed
  yet.**
- **Feed** (`useFeedQuery`, `app/(tabs)/index.tsx`) and **menus** (`useVendorMenuQuery`,
  `app/vendor/[id].tsx`) call `src/api/catalog.ts`. `404 VENDOR_NOT_FOUND` shows "This shop isn't
  available." without a retry button; other failures show the load error with "Try again".
- **Retry policy:** these reads (and the order read) use `retryTransientFailures`
  (`src/api/query-client.ts`): network errors, 408, 429 and 5xx retry up to 3 times with the
  default backoff; every other 4xx surfaces at once. Other queries keep the global default.
- **Only UI files touched:** the three screens' data wiring (which hook, which error code), and the
  cancel button's mutation arguments. No layout, style or copy changed except the new refund toast.

**Phases 7 and 7.5** added sign-in and session renewal:

- **Screens:** `app/login.tsx` (fixed `+977` prefix, 10-digit field, Nepali digits accepted,
  validated by `toNepalPhone` → `normalizeNepalPhone` + `NEPAL_PHONE_REGEX`) and
  `app/verify-otp.tsx` (6-digit code with `textContentType="oneTimeCode"` / `autoComplete="sms-otp"`,
  per-code error messages, a resend countdown from `resend_after_seconds` via `useNow` +
  `formatCountdown`, "Change number"). All copy is in `en.json` / `ne.json` under `auth.*`.
- **Navigation contract:** a screen that needs a session does `router.push('/login')`. Login
  **replaces** itself with `/verify-otp` after the SMS is sent, so after verifying `leaveSignIn` does
  `router.back()` to exactly the screen that asked (Feed, Cart, Profile), or `router.replace('/')`
  when sign-in was the first screen.
- **Entry points:** Profile's account section (sign in / sign out); the Feed's "Sign in to see the
  shops near you." (shown for `NOT_SIGNED_IN` or a 401); the Cart's **"Sign in to Checkout"**, which
  replaces "Proceed to Checkout" while signed out (Phase 7.5).
- **Signed in** means `selectHasSession`: an access token in memory **or** a refresh token in
  encrypted storage (after a relaunch only the refresh token exists; the first request renews it).
- **On verify:** `useVerifyOtp` calls `setSession` (access token in memory, refresh token persisted)
  and invalidates every query, so screens that failed for lack of a session refetch.
  `useSignOut` clears the session and the whole query cache.

### 9.0 Screen inventory (exact current UI)

| Route                 | File                                | Session needed                  | Server calls                                                                                                                                              | What the user sees                                                                                                                                                                                                                                                                                                                                                  |
| --------------------- | ----------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/` (Shops tab)       | `app/(tabs)/index.tsx`              | only for the shops and to order | `GET /api/vendors` (saved-address pin or Thamel), `GET /api/categories`, `GET /api/products` (both public, Phase 18)                                      | search field + root-category pills (§9.16); with neither in use: "Delivers to you" + desaturated "Explore Further" (carts disabled); loading; "Sign in to see the shops near you." when signed out; retry on other errors. With a search or a pill: the product list (name, shop, description, price per unit, stock or "Out of Stock" badge, quantity picker, Add) |
| `/vendor/[id]`        | `app/vendor/[id].tsx`               | yes                             | `GET /api/vendors/:id/products`                                                                                                                           | products with price and stock; add to cart (single-vendor, replace prompt; never past the menu's `stock_quantity`, Phase 19); browse-only banner if not serviceable; "This shop isn't available."                                                                                                                                                                   |
| `/cart` (Cart tab)    | `app/(tabs)/cart.tsx`               | only to check out               | `POST /api/cart/checkout`, lock-status poll, eSewa/Khalti initiate + confirm                                                                              | lines, +/-, summary (platform fee Rs. 0), MOV check, delivery address card, payment picker, **"Proceed to Checkout" or "Sign in to Checkout"**, reservation countdown, payment WebView                                                                                                                                                                              |
| `/profile` (tab)      | `app/(tabs)/profile.tsx`            | no                              | –                                                                                                                                                         | account (Sign in / Sign out), language EN/NE, `__DEV__` token paste, `__DEV__` Rider Mode entry (Phase 21) and territory simulator                                                                                                                                                                                                                                  |
| `/login`              | `app/login.tsx`                     | no                              | `POST /api/auth/otp/send`                                                                                                                                 | +977 prefix, number field, validation and cooldown messages                                                                                                                                                                                                                                                                                                         |
| `/verify-otp`         | `app/verify-otp.tsx`                | no                              | `POST /api/auth/otp/verify`, `…/otp/send` (resend)                                                                                                        | 6-digit field, per-error messages, resend countdown, "Change number"; on success toast + back to the caller                                                                                                                                                                                                                                                         |
| `/order/[id]`         | `app/order/[id]/index.tsx`          | yes                             | `GET /api/orders/:id`, Socket.io `/orders`, `POST /api/orders/:id/cancel`                                                                                 | order code and total, 60 s cancel countdown + button, delivery OTP badge, discrete tracker, dispute button (48 h after delivery)                                                                                                                                                                                                                                    |
| `/order/[id]/dispute` | `app/order/[id]/dispute.tsx`        | yes                             | `GET /api/orders/:id/chat`, Socket.io `/chat` (join + send with acks), `POST /api/uploads/dispute-evidence`                                               | earlier messages (transcript) + live chat (first names only), photo attach (≤ 5 MB), closed/unavailable notice when the server refuses the join                                                                                                                                                                                                                     |
| `/driver/dashboard`   | `app/(driver)/driver/dashboard.tsx` | yes (DRIVER)                    | `GET /api/deliveries`, `POST /api/deliveries/:id/accept` / `pickup` / `complete`, Socket.io `/orders` (`rider:location`, only while the GPS switch is on) | "Simulate GPS" switch (testing), then open gigs and own deliveries (shop, ward/tole/palika, items, cash to collect or "paid online"): **Accept delivery** on an open gig, **Picked up from the shop** once accepted, then the 4-digit code field + Confirm delivery; pull to refresh, sign out (Phases 11, 21)                                                      |
| `/wallet` (vendor)    | `app/(vendor)/wallet.tsx`           | yes (VENDOR)                    | `GET /api/vendors/wallet/balance`, `GET /api/vendors/wallet/ledger` (infinite)                                                                            | red "Your shop is offline" banner when suspended (dues and limit, or a support message when not about dues), balance (red when negative), money in escrow, transactions (label, order #, ± amount, commission, time, balance after), loads older pages at the end, pull to refresh (Phase 12)                                                                       |
| `/dashboard` (vendor) | `app/(vendor)/dashboard.tsx`        | yes (VENDOR)                    | `GET /api/vendors/orders`, Socket.io `/orders` (`vendor:subscribe`), `POST /api/vendors/orders/:id/accept` / `reject` / `dispatch` / `deliver`            | new orders (items, total, payment, ward/tole/palika) with Accept / Reject, Preparing list with Dispatch, Out for delivery list (own deliveries) with the 4-digit code field, red alarm banner + looping expo-audio alarm while any order waits, sign out (Phases 10, 11.5)                                                                                          |
| (root overlays)       | `app/_layout.tsx`                   | –                               | lock-status (via `CheckoutSessionWatcher`), `POST /api/reviews`, `POST /api/notifications/device-token` (Phase 20, once signed in)                        | territory gate (topmost), replace-cart modal, review prompt, toasts, session-expiry handler                                                                                                                                                                                                                                                                         |

### 9.1 Storage

| Instance             | File                         | Encryption                                                                                                                                                              | Holds                                                         |
| -------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `hamro-pasal.secure` | `src/storage/secure-mmkv.ts` | AES-256; 32-char key generated once (`encryption-key.ts`, expo-crypto) and kept in the OS keychain entry `hamro-pasal.mmkv-key` (`AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`) | auth (refresh token, locale), delivery OTPs, delivery address |
| `hamro-pasal.app`    | `src/storage/app-mmkv.ts`    | none (non-sensitive)                                                                                                                                                    | cart, checkout session, tracked orders, reviews               |

All persisted stores use `createJSONStorage` over `mmkvStateStorage` (synchronous hydration), a
version number, and `migrate` + `merge` functions that **re-validate with Zod and drop anything that
fails**. Each store has a `create*Store(storage)` factory for tests plus an app-wide instance.

### 9.2 Zustand stores (`src/store/`)

| Store                                                                 | Key / version                              | Persisted                                                                                                                                  | Memory only                            | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useAuthStore`                                                        | `hamro-pasal.auth` **v2** (secure)         | `refreshToken`, `role` (Phase 10), `locale` ('en' \| 'ne')                                                                                 | **`accessToken`** (SPEC: memory only)  | `setSession` on OTP verify; `setAccessToken` on refresh (and by the `__DEV__` token paste); `clearSession` on sign-out or a refused refresh. `selectHasSession` = either token present.                                                                                                                                                                                                                                                                                           |
| `useCartStore`                                                        | `hamro-pasal.cart` **v3** (app)            | `vendor {id, name, deliveryFeeNpr, minOrderValueNpr}`, `lines[{productId, name, unitPriceNpr, quantity, availableStock (number or null)}]` | `pendingAddition`                      | **Single-vendor** (SPEC edge case 4) with a replace prompt (`ReplaceCartModal`). Limits from shared-types (99 per line, 50 lines). Prices are display-only; the server re-prices. **Phase 18:** `addItem` answers `stock_limit` past the known stock, `setQuantity` never raises a line past it (but always allows lowering), `syncStock` records the server's counts, `isOverStock` / `selectHasOverStockLine` flag lines above them (§9.16). A v2 cart is kept (stock unknown). |
| `useCheckoutStore`                                                    | `hamro-pasal.checkout` v1 (app)            | `session {orderId, reservationId, expiresAt, orderState, paymentMethod, totalNpr}`, `attempt {idempotencyKey, fingerprint}`                | `deliveryOtp`, `sessionExpired`        | One idempotency key per **checkout fingerprint = vendor + method + sorted items + delivery address** (Phase 6 added the address), reused across retries and relaunches. `startSession`, `applyLockStatus`, `applyPaymentView`, `setOrderState`, `expireSession`, `endSession`. A stored v1 fingerprint without the address no longer matches, so the first checkout after upgrade gets a fresh key.                                                                               |
| `useOrderStore`                                                       | `hamro-pasal.orders` v2 (app)              | `orders[id] {orderId, placedAt, deliveredAt, state, paymentMethod, totalNpr}`, capped at 20                                                | –                                      | `placedAt` = when the device saw PLACED (60 s countdown anchor); `deliveredAt` = when it first saw DELIVERED (48 h dispute anchor). **Deliberately device clocks** (§9.6, §12): the server's `placed_at`/`delivered_at` arrive with `GET /api/orders/:id` but are not used for the UI timers.                                                                                                                                                                                     |
| `useDeliveryOtpStore`                                                 | `hamro-pasal.delivery-otps` v1 (secure)    | `otps[orderId]` (4 digits)                                                                                                                 | –                                      | Written on every checkout success (newest replay wins); cleared on DELIVERED/CANCELED/FAILED.                                                                                                                                                                                                                                                                                                                                                                                     |
| `useAddressStore`                                                     | `hamro-pasal.delivery-address` v1 (secure) | `address: NepalAddress \| null`                                                                                                            | –                                      | `setAddress` parses with `nepalAddressInputSchema` (throws on invalid). **Sent with every checkout** (Phase 6); not synced to `customer_addresses` (no endpoint).                                                                                                                                                                                                                                                                                                                 |
| `useReviewStore`                                                      | `hamro-pasal.reviews` v1 (app)             | `submitted[orderId] {reviewId, rating, comment, submittedAt}`                                                                              | `snoozed` ("Not now")                  | Written only after a (mock) submission succeeds.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `useToastStore`                                                       | –                                          | –                                                                                                                                          | `toast`                                | Rendered by `ToastHost` (Reanimated, 4 s).                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `useTerritorySimulator` (`features/territory/territory-simulator.ts`) | –                                          | –                                                                                                                                          | `simulation: off \| inside \| outside` | `__DEV__` only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

### 9.3 API client and token renewal (`src/api/http.ts`)

`apiRequest({ method, path, query?, body?, schema })` reads the access token from `useAuthStore` **at
call time**, JSON-encodes the body, builds the query string by hand (RN's `URLSearchParams` is
incomplete), parses non-2xx bodies with `errorBodySchema` into `ApiError(status, code, message,
details)`, and validates 2xx bodies with the given shared-types schema. Client-side codes:
`NOT_SIGNED_IN` (no request sent), `NETWORK_ERROR`, `UNEXPECTED_RESPONSE`, plus `INVALID_CART` and
`NO_DELIVERY_ADDRESS` from the checkout builder. **Every API call goes through `apiRequest`**, so
every request carries the Bearer token and every 2xx body is Zod-validated; a contract break becomes
`UNEXPECTED_RESPONSE`. Query defaults (`query-client.ts`): staleTime 30 s, 3 retries with capped
exponential backoff (`retryTransientFailures` narrows that for the catalogue and order reads, §9),
**mutations never retried automatically**.

**Token renewal (Phase 7.5).** Authenticated requests (the default; only the three `/api/auth/*`
calls pass `authenticated: false`, so a wrong-OTP 401 never triggers a refresh):

1. No access token in memory but a refresh token stored → **refresh first** (the relaunch case).
   Neither → `401 NOT_SIGNED_IN`, no request sent.
2. Send. On a **401**: if another request already renewed the token meanwhile, replay with that one;
   otherwise `refreshAccessToken()` and replay **once** with the new token. A second 401 surfaces
   (no loop).
3. `refreshAccessToken` is **single flight** (one module-level promise): a burst of 401s makes one
   `POST /api/auth/token/refresh` and every caller waits for it ("pauses the queue").
4. Refresh outcomes: success → `setAccessToken` (memory only). **400/401** → the session is over:
   `clearSession()` (the persisted refresh token is removed too) and every `onSessionExpired`
   listener runs; the original 401 surfaces. **Network error or 5xx** → the error surfaces and the
   session is **kept** (a flaky connection never signs anyone out).
5. If the user signed out (or another account signed in) while a refresh was running, its result is
   discarded: a stale refresh never revives a session.
6. `useSessionExpiryHandler` (mounted once in `app/_layout.tsx`) listens and runs
   `queryClient.clear()` plus the toast "Your session has ended. Please sign in again."

The whole interceptor, as implemented in `src/api/http.ts` (simplified: `send` arguments and imports abbreviated):

```ts
let refreshInFlight: Promise<string | null> | null = null;

export function refreshAccessToken(): Promise<string | null> {
  refreshInFlight ??= runRefresh().finally(() => { refreshInFlight = null; });   // single flight
  return refreshInFlight;
}

async function runRefresh(): Promise<string | null> {
  const refreshToken = useAuthStore.getState().refreshToken;
  if (refreshToken === null) return null;
  const stillCurrent = () => useAuthStore.getState().refreshToken === refreshToken;
  try {
    const { access_token } = await send({ POST /api/auth/token/refresh, body: { refresh_token } }, null);
    if (!stillCurrent()) return null;                 // signed out meanwhile: never revive
    useAuthStore.getState().setAccessToken(access_token);   // memory only
    return access_token;
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 400)) {
      if (stillCurrent()) { clearSession(); notify onSessionExpired listeners; }
      return null;                                    // session over
    }
    throw error;                                      // network / 5xx: keep the session
  }
}

export async function apiRequest<T>(request): Promise<T> {
  if (request.authenticated === false) return send(request, null);          // /api/auth/* only
  let token = accessToken ?? (await refreshAccessToken());                  // relaunch case
  if (token === null) throw new ApiError(401, 'NOT_SIGNED_IN', …);
  try {
    return await send(request, token);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error;
    const current = useAuthStore.getState().accessToken;
    token = current !== null && current !== token ? current : await refreshAccessToken();
    if (token === null) throw error;
    return send(request, token);                                            // replay once, no loop
  }
}
```

Burst example: three screens fetch at once with an expired token → three 401s → the first caller
starts `runRefresh`, the other two receive the same promise → **one** refresh call → all three replay
with the new token. Tested in `src/api/token-refresh.int.test.ts` (10 cases; the single flight, the
relaunch refresh and the no-revival guard were each broken on purpose and caught).

**Sockets use the same renewal (Phase 8).** `createAuthenticatedSocket(url, factory)`
(`src/services/socket.ts`) backs both `createOrdersSocket` and `createChatSocket`; each returns
`{ socket, close }` (always `close()`, never just `disconnect()`, so no pending retry revives it):

1. The `auth` callback runs at every (re)connect and sends `socketAccessToken()`: the in-memory
   token, or `refreshAccessToken()` when there is none (the relaunch case). It is the **same
   single-flight refresh** as `apiRequest`: a screen's GET and its socket starting together make one
   refresh call (tested).
2. A `connect_error` with `UNAUTHENTICATED` is not retried by Socket.io (server refusal), so the client
   renews: it uses a newer in-memory token if an HTTP request already renewed it, else
   `refreshAccessToken()`, then `socket.connect()` again.
3. **No loop:** if the token it just renewed is refused too, it stops.
4. Refresh refused (400/401) → the HTTP layer signs out; the socket stays down. Network/5xx → the
   session is kept and the reconnect is retried on the 1, 2, 4 … 30 s schedule (`reconnectDelayMs`).
5. Transport errors are left to Socket.io's own reconnection (same backoff).

Tested in `src/features/order/OrderRealtime.test.tsx` (`/orders`, through the tracking screen) and
`src/services/chat-socket.test.ts` (`/chat`); the relaunch refresh, reconnect after renewal, no-loop
guard, backoff retry and the `/chat` wiring were each broken on purpose and caught.

### 9.4 Checkout and lock status

- `buildCheckoutRequest` (`src/api/mutations.ts`) builds `checkoutRequestSchema` from the cart (ids
  and quantities only) **and `useAddressStore`'s saved address as `delivery_address`**. No saved
  address → `ApiError(400, 'NO_DELIVERY_ADDRESS')`, nothing sent (the cart screen already disables
  Proceed without one). An invalid cart → `INVALID_CART`. On success it stores the OTP, then
  `startSession`. `RESERVATION_EXPIRED` → `expireSession`; `IDEMPOTENCY_KEY_REUSED` → new key next time.
- The cart (`app/(tabs)/cart.tsx`) requires: subtotal ≥ MOV, a saved delivery address, and a payment
  method. Summary rows: subtotal, delivery fee, platform fee (**Rs. 0**: SPEC §4 deducts commission
  from the vendor), total. The cart is frozen while a reservation is pending.
- `useLockStatus` (`src/api/queries.ts`) polls `GET /api/cart/lock-status` every **5 s**, only while
  `selectShouldPollLock`, continuing through network errors (SPEC edge case 1). Mounted once by
  `src/features/checkout/CheckoutSessionWatcher.tsx`, which also watches for any transition to
  PLACED, records `placedAt` and `router.push('/order/[id]')` (**only the id travels in the route**).

### 9.5 Payment WebView interception (`src/features/payment/`, `src/components/PaymentWebViewModal.tsx`)

- A successful prepaid checkout calls `usePaymentFlow().start(orderId, method)` automatically. The
  reservation panel also has a "Pay with …" retry button.
- **eSewa:** `POST /api/payments/esewa/initiate` → `buildEsewaFormHtml(payment_url, fields)` builds an
  auto-submitting POST form (every value HTML-escaped; `payment_url` must be http(s)) → WebView.
- **Khalti:** `POST /api/payments/khalti/initiate` → WebView `source={{ uri: payment_url }}`.
- `interpretNavigation(target, url)` (`payment-redirect.ts`) matches eSewa success/failure on
  **origin + path equality** with the signed URLs, extracts `data` with `rawQueryParam` (never
  `URLSearchParams`, which would turn `+` into a space), and treats any non-Khalti page carrying this
  payment's `pidx` as the Khalti return.
- **The server only learns of a payment because the app forwards it:** eSewa success →
  `POST /esewa/webhook {data}`; Khalti `Completed`/`Pending`/no status → `POST /khalti/lookup {pidx}`.
  `payment` present → `applyPaymentView`; `409 PAID_AFTER_SESSION_EXPIRED` → order FAILED + refund
  toast; `RESERVATION_EXPIRED` → Session Expired. `useLockStatus` keeps polling as a safety net.
- **Not implemented:** SPEC's eSewa App-to-App intent; the WebView is the only path.

### 9.6 Order tracking and the 60-second cancellation (`app/order/[id]/index.tsx`, `src/features/order/`)

- **Order read:** `useOrderQuery` → `fetchOrder` (`src/api/orders.ts`) → `GET /api/orders/:id`
  (`orderDetailResponseSchema`), **no polling** (Phase 8 removed `ORDER_REFRESH_INTERVAL_MS`).
  `syncOrderSnapshot` copies the server state into `useOrderStore` (`applyOrderView`); terminal states
  erase the OTP. REST and socket updates both go through it.
- **Live updates (Phase 8):** `useOrderRealtime(orderId, enabled)`
  (`src/features/order/useOrderRealtime.ts`), mounted by the screen while the order is not terminal:
  - opens `createOrdersSocket()` (§9.3 token lifecycle) and on **every** `connect` emits
    `orders:subscribe { order_id }` with a 10 s ack; a timed-out or `INTERNAL_SERVER_ERROR` ack is
    retried on the backoff schedule while connected, `ORDER_NOT_FOUND`/`VALIDATION_FAILED` never;
  - after each successful join it **invalidates the order query once** (catch-up for anything sent
    while offline or before the join);
  - each `order:state_update` is validated (`orderStateUpdateSchema`), must match the order id and must
    not be older (`changed_at`) than the last applied one; `applyOrderStateUpdate` then patches the
    cached `OrderSnapshotView` with `queryClient.setQueryData` (no HTTP round trip) and runs
    `syncOrderSnapshot`. Without a cached snapshot it invalidates instead;
  - a terminal state disables the hook, which `close()`s the socket.
- **Cancellation window (UX only):** `CANCELLATION_WINDOW_MS = 60_000` from the persisted **device**
  `placedAt`, clamped to [0, 60 s], with a live countdown and a "Cancel Order" button. When it closes,
  a still-PLACED order is **displayed** as PREPARING (`displayedOrderState`). This timer is purely for
  UX: **Postgres is the gatekeeper** (`placed_at + 60 s` on the database clock, §8). Anchoring the
  countdown on the server's `placed_at` was rejected because it would compare a server timestamp with
  a possibly skewed device clock.
- **Cancellation is live:** `useCancelOrder` (`order-hooks.ts`) → `cancelOrder(orderId)` →
  `POST /api/orders/:id/cancel` (`cancelOrderResponseSchema`).
  - success → order CANCELED in `useOrderStore` and the checkout store, OTP erased, toast
    `order.cancel.done` ("Your order was cancelled.") or, when the server answers
    `refund_required: true` (a PAID prepaid order), `order.cancel.doneRefund` ("Order cancelled.
    Escrow refund initiated." / "अर्डर रद्द भयो। रकम फिर्ता प्रक्रिया सुरु भयो।");
  - `422 CANCELLATION_WINDOW_EXPIRED` → error toast `order.cancel.windowClosed`;
  - any other error (e.g. `409 ORDER_STATE_CONFLICT` because the vendor moved on) → error toast
    `order.cancel.failed`;
  - on every error the order query is invalidated, so the screen shows the server's real state.
- Tracker: Order Placed → Preparing → Out for Delivery → Arrived → Delivered. **There is no ARRIVED
  `OrderState`**, so Arrived completes together with DELIVERED. No map polling.
- OTP badge: 4 digits from `useDeliveryOtpStore`, Devanagari under `ne`, hidden and erased when terminal.
- "Report an Issue / Dispute" shows while DELIVERED and less than 48 h after the **device-observed**
  `deliveredAt`.

### 9.7 Territory gate (SPEC §1) (`src/features/territory/`)

`TerritoryGate` (root, topmost) runs `useTerritoryGuard` on launch and on every foreground.

- **Box:** `NEPAL_TERRITORY_BOX` is now an alias of shared-types' **`NEPAL_BOUNDING_BOX`**
  (`26.347–30.447 N, 80.058–88.201 E`, Nepal's extreme points). The same constant bounds address pins
  (`nepalAddressInputSchema`) and the API's feed coordinates, so the Phase 5 mismatch (a pin near the
  border passing one check and failing another) is gone.
- **Decision:** `checkTerritory` asks for permission, gets a position (last known ≤ 10 min, else
  current with a 15 s timeout), then: outside the box → blocked, with no geocoding; inside the box →
  the device reverse geocoder must return `NP`; geocoder unavailable → the box decides.
- **Blocked:** an unskippable full-screen modal with SPEC's text verbatim, "Service Unvailable in your
  territory", and `purgeLocalData` wipes the query cache, all stores and both MMKV instances.
- Refused permission and no position fix each get their own locked, retryable screen.
- `__DEV__` simulator toggle (Real GPS / Nepal / Outside).

### 9.8 Address (SPEC Nepal §3)

- **Form:** `src/components/AddressFormModal.tsx`: province picker (1–7, localized), cascading
  districts, palika, ward (ASCII or Devanagari digits, 1–33), tole, landmark, and a **stub pin** ("use
  my current location"; a map pin-drop is still to do).
- **Validation:** `validateAddressForm` runs `nepalAddressInputSchema`, including the district/province
  match and the Nepal bounding box for the pin.
- **Cart:** `DeliveryAddressCard` shows the saved address, and Proceed is disabled without one. The
  address **is sent with checkout** and stored server-side per order.

### 9.9 Reviews (SPEC §6) (`src/components/ReviewModal.tsx`, `src/features/review/`)

- `ReviewPrompt` opens the modal for the most recent DELIVERED order inside its 48 h window that hasn't
  been reviewed or snoozed. 1–5 stars, optional feedback (≤ 500 chars), quarantine badge (EN/NE).
- **Live since Phase 9:** `src/api/reviews.ts#submitReview` → `POST /api/reviews` (input validated with
  `reviewSubmitRequestSchema` first; invalid → `INVALID_REVIEW`, nothing sent). Outcomes in `ReviewModal`:
  201 → recorded with the server's id/feedback, toast `review.thanks` (QUARANTINED) or
  `review.thanksPublished` (PUBLISHED: the vendor had rated); 409 `REVIEW_ALREADY_SUBMITTED` → recorded
  with `details.review_id` (a lost response), toast `review.alreadySubmitted`; 422 `REVIEW_WINDOW_CLOSED`
  / 409 `ORDER_STATE_CONFLICT` → snoozed, toast `review.unavailable`; anything else → modal stays, toast
  `review.failed`, retryable. `features/review/review-api.ts` (the mock) is deleted.

### 9.10 Dispute chat + privacy-filtered Socket.io scaffold

- **Socket client** (`src/services/socket.ts`): `createChatSocket()` returns `{ socket, close }` from
  `createAuthenticatedSocket(API_URL + "/chat")`: `transports: ['websocket']`, `autoConnect: false`,
  infinite reconnection, **backoff 1 s → 2 s → 4 s → 8 s → 16 s → 30 s cap** (`randomizationFactor: 0`),
  and since Phase 8 the **same token lifecycle as `/orders`** (§9.3: refresh on relaunch, renew and
  reconnect after `UNAUTHENTICATED`, no loop). `useDisputeChat` calls `close()` on unmount.
  **`HEARTBEAT_INTERVAL_MS` (= shared `SOCKET_PING_INTERVAL_MS`, 25 s) must be the server's
  `pingInterval`.** The `/chat` server (Phase 9, §8C) refuses bad tokens with `UNAUTHENTICATED`, so the
  client's renewal applies.
- **Events (Phase 9):** `chat:join { order_id }` **with ack** on every (re)connect; a timeout or
  `INTERNAL_SERVER_ERROR` is retried on the 1, 2, 4 … 30 s schedule, `DISPUTE_WINDOW_CLOSED` /
  `ORDER_NOT_FOUND` are final and replace the chat with "window has ended" / "This dispute isn't
  available.". `chat:new_message` sends **only `{ client_id, order_id, body, attachments }`** (no user
  object leaves the device); the message is "Sending…" until the ack `{ ok: true, message }`, whose
  message (server id, time, filtered sender) replaces the local copy. A refusal, a malformed ack or a
  10 s timeout → "Not sent. Tap to retry.".
- **Transcript hydration (Phase 9.6):** `useDisputeChat` runs a TanStack query
  (`chatHistoryQueryKey(orderId)` → `src/api/chat.ts#fetchChatHistory` → `GET /api/orders/:id/chat`,
  `retryTransientFailures`, `staleTime: 0`) **in parallel with** the socket connecting. The screen shows
  "Loading the conversation…" until it answers, and a "Couldn't load earlier messages. Try again" banner
  if it fails (the live chat keeps working). The hook keeps only live messages (socket + own sends) in
  state and derives the thread with `mergeThread(history, live, selfId)`: transcript first, live entries
  it does not already contain (same server id, or our own message by `client_id`) appended, sorted by
  `sent_at` (stable). After every successful **re-join** (not the first) the query is invalidated, so
  messages sent while the device was offline appear. Own messages keep their `client_id` as the list
  key, others use the server id.
- **Contract and privacy filter:** the schemas live in shared-types (`realtime/chat-socket.ts`);
  `src/features/dispute/chat-contract.ts` re-exports them. Every incoming payload, **every ack and every
  transcript message**
  goes through `sanitizeChatMessage` again (PII keys stripped at every depth, `ChatUser = { id,
first_name|null, role }` allowlist), so a server regression would still not render a surname or phone.
  Attachment URLs may be `http` or `https` (local-dev evidence is `http`).
- **Evidence upload is live:** `src/api/uploads.ts#uploadDisputeEvidence` → multipart
  `POST /api/uploads/dispute-evidence` (RN FormData `{ uri, name, type }` part; `apiRequest` sends
  FormData without a JSON content type). Refused on the device before sending: not an image, or
  `fileSize > 5 MB`. Server `FILE_TOO_LARGE` / `UNSUPPORTED_MEDIA_TYPE` / `DISPUTE_WINDOW_CLOSED` map to
  `EvidenceRejectedError` reasons with their own messages. `mock-evidence-upload.ts` is deleted. **Still
  no compression** (react-native-compressor is not installed): full-size photos over 5 MB are refused.

### 9.11 i18n

`en.json` / `ne.json` have identical key sets (enforced by a test). Numbers use the custom
`{{value, localizedNumber}}` format, backed by `toNepaliNumerals` from shared-types under `ne`.

### 9.12 Mobile test infrastructure

- 768 Jest tests at the end of Phase 18 (jest-expo + React Native Testing Library 13 + react-test-renderer 19.2.3).
- **msw 2** intercepts `fetch` for every API-backed test (`src/test/msw.ts`,
  `setupApiTestEnvironment()`: listens with `onUnhandledRequest: 'error'`, sets the test access
  token and saves `THAMEL_ADDRESS` before each test). Screen tests (feed, menu, order tracking) go
  through the real `apiRequest`, so they also exercise the Zod contracts and the Bearer header.
  **Phase 18:** the server has one standing handler, `GET /api/categories` → an empty taxonomy
  (the Home screen always asks for the pills); `server.use` overrides it, `resetHandlers` keeps it.
  `renderHookWithProviders` now takes `initialProps` and a `queryClient`.
  `src/api/{auth,catalog,orders,checkout,lock-status,token-refresh}.int.test.ts` assert the exact wire
  format; `token-refresh.int.test.ts` covers every renewal branch in §9.3 (single flight, relaunch,
  refused refresh, network/5xx, no loop, no revival, auth endpoints excluded).
- `src/features/auth/LoginFlow.test.tsx` drives both sign-in screens over msw, including the Feed
  and the code screen in one tree to prove the Feed recovers after sign-in. Tests that assert router
  calls must `jest.clearAllMocks()` in `beforeEach` (router mocks otherwise leak between tests).
- **Fixtures** (`src/test/api-fixtures.ts`) are seed-shaped, fixed-uuid test data built through the
  shared-types response schemas (`feedResponse`, `vendorMenu`, `orderSnapshot`,
  `orderDetailResponse`, `cancelResponse`, …), so a fixture can never drift from the contract.
  They are test-only; nothing in `app/` or `src/` outside `src/test/` imports them.
- The order tracking screen test uses fake timers **with** msw; the cancel handler uses msw's
  `delay(300)` so the in-flight "Cancelling…" state is observable with `advanceTimersByTimeAsync`.
- `jest.setup.ts` globally mocks MMKV (in-memory), Reanimated and worklets, WebView, Ionicons,
  SecureStore and expo-crypto, and defaults `EXPO_PUBLIC_API_URL=http://api.hamropasal.test`.
- `jest.setup-after-env.ts` sets `asyncUtilTimeout` to 5 s; `testTimeout` is 15 s.
- Test clients set `gcTime: Infinity` for queries **and** mutations, so single files exit cleanly.
- FlatList screens that update asynchronously use fake timers (`VirtualizedList` renders on a 50 ms
  timer that otherwise triggers `act()` warnings).

### 9.14 Driver dashboard and the delivery code (Phase 11)

**Phase 21 rewrote the data side of this screen ("Rider Mode").** The route, role routing, the
shared code field (`DeliveryOtpForm`) and the 401 rule below are unchanged; the bullets "Data" and
"Not built" below describe Phase 11 and are superseded by this block.

- **Data.** `src/api/deliveries.ts`: `fetchDeliveries` (`GET /api/deliveries`),
  `advanceDelivery(id, 'accept' | 'pickup')` (no body), `completeDelivery(id, code)` (the code is
  validated first; a malformed one is `INVALID_DELIVERY_CODE` and nothing is sent). Hooks in
  `features/driver/useDeliveries.ts`: `useDeliveriesQuery` (`['driver','deliveries']`,
  `staleTime: 0`, pull to refresh; still no polling and no socket for the list),
  `useDeliveryStep` and `useCompleteDelivery` (both `retry: false`, both refetch the list after
  every answer).
- **Card (`DeliveryCard`).** One action per state: OFFERED → **Accept delivery**; ASSIGNED →
  **Picked up from the shop**; PICKED_UP → the code field. The code field does not exist before
  pickup (the server would answer 409 anyway).
  - accept / pickup success patches the cached delivery with the server's and toasts;
    `409 DELIVERY_ALREADY_ASSIGNED` removes the gig **at once** ("Another rider took this
    delivery."); `DELIVERY_NOT_FOUND` / `DELIVERY_STATE_CONFLICT` remove it ("can't be delivered
    from here any more"); a network failure keeps it with a retry toast;
  - complete: the Phase 11 outcomes (success removes it; wrong code → tries left + field cleared;
    lockout → minutes; stale → removed). `isStaleDeliveryError` now also covers the two
    `DELIVERY_*` codes.
- **GPS simulation (testing only).** `features/driver/rider-gps-simulator.ts`:
  - `mockRiderPosition(step)`: a straight line Thamel (27.7154, 85.3123) → Patan Durbar Square
    (27.6727, 85.3249) in 20 steps and back, forever; every point passes the server's contract;
  - `useRiderGpsSimulator(enabled)`: while on, opens `createOrdersSocket()` (the shared token
    lifecycle, §9.3), emits `rider:location` **at once on every connect** and then every 5 s
    (`RIDER_GPS_SIMULATION_INTERVAL_MS` = the server's push period), with a 10 s ack. Status
    `connecting` → `streaming` on the first `{ ok: true }`, `refused` on an error ack; a lost ack
    is ignored; a disconnect stops the timer and the reconnect restarts it (one timer, tested);
    switching off or leaving the screen closes the socket;
  - `RiderGpsSimulator` (top of the dashboard): the switch, the status line and "Last sent: lat,
    lng (reports: N)". **Off by default; no socket is opened until it is switched on.**
  - **It never reads the device's GPS.** A real rider build would feed `expo-location`'s watcher
    into the same event.
- **Rider Mode entry.** `RiderModeEntry` on the Profile tab, `__DEV__` only: "Switch to Rider
  Mode" signs the current account out and opens `/login`; signing in with a rider's number (seed
  **9800000021**, code from the API log with `SMS_PROVIDER=MOCK`) lands on `/driver/dashboard`
  through the existing role redirect, and Sign out there leaves Rider Mode. It is not a role
  switch: a rider is a real account role and the API authorises every call by it.
- **Socket types.** `OrdersServerToClientEvents` gained `order:rider_location` and
  `OrdersClientToServerEvents` `rider:location` (`src/services/socket.ts`). **The customer's
  tracking screen does not listen for `order:rider_location`** (not requested; SPEC customer
  journey 9 asks for discrete state nodes, not a live map).
- Strings: `driverDashboard.*` (rewritten) and `riderMode.*`, EN and NE.
- **Tests** (+28, 839 in total): `DriverDashboard.test.tsx` (27, msw + FakeSocket: the one action
  per state, accept in flight / taken by another rider with the refetch still pending / network
  failure / pickup / stale, the code field and every completion outcome on the new route, the GPS
  switch off by default and streaming the first mock point over `/orders`),
  `rider-gps-simulator.test.tsx` (10, fake timers: the route, disabled, handshake token and first
  point, one point per interval, refusal, lost ack, disconnect / reconnect, switch off, the Rider
  Mode entry), `api/deliveries.int.test.ts` (16: wire format of the four calls, strict contract,
  no refresh or replay on `401 INVALID_OTP`).
- **Mutation-checked:** the code field shown before pickup (1), the timer kept across a
  disconnect (1), no position at connect (7), the socket left open when switched off (2), a taken
  gig kept in the list (1), an error ack counted as streaming (1).
- **Not run on a device.**

- **Route.** `app/(driver)/_layout.tsx` (DRIVER only, else `/`) + `app/(driver)/driver/dashboard.tsx`
  = **`/driver/dashboard`**. The prompt's `app/(driver)/dashboard.tsx` would resolve to `/dashboard`,
  which the vendor dashboard already owns (groups add no path segment). `app/(tabs)/_layout.tsx`
  redirects a signed-in DRIVER there (after sign-in and after a relaunch).
- **Data.** `src/api/driver-orders.ts`: `fetchDriverOrders`, and `deliverDriverOrder`, which validates
  with `driverDeliverRequestSchema` first (a malformed code is `INVALID_DELIVERY_CODE` and nothing is
  sent). `useDriverOrdersQuery` (`['driver','orders']`, `staleTime: 0`, pull to refresh; **no socket,
  no polling**). `useDeliverOrder` (TanStack mutation, `retry: false`): success removes the order from
  the cache + toast; `INVALID_OTP` → "Wrong code. Attempts left: N." and the field is cleared;
  `DELIVERY_OTP_LOCKED` → the minutes to wait; `409`/`404` → the order is removed; other failures keep
  it. The list is refetched after every answer.
- **Input.** `features/driver/delivery-otp-input.ts`: `sanitizeDeliveryOtpInput` (Nepali digits
  converted, non-digits dropped, max 4), `isCompleteDeliveryOtp`; `number-pad`, `maxLength 4`. The
  button stays disabled until 4 digits are typed and while the code is being checked.
- **401 handling (`src/api/http.ts`).** `apiRequest` refreshes and replays **only on a 401 with code
  `UNAUTHENTICATED`** (what `requireAuth` answers for a missing or expired token). Any other 401 (here
  `INVALID_OTP`) surfaces at once: a replay would be a second wrong guess. Tested and mutation-checked.
- **Tests:** `delivery-otp-input.test.ts`, `DriverDashboard.test.tsx`, `DriverRouting.test.tsx`,
  `api/driver-orders.int.test.ts`. Mutation-checked: removing the UNAUTHENTICATED guard and not
  clearing the field each fail tests.
- **Shared with the vendor (Phase 11.5):** the field and button are `features/delivery/DeliveryOtpForm.tsx`,
  the cash line `CashToCollect.tsx`, the input helpers `delivery-otp-input.ts`, the error toasts
  `delivery-errors.ts` (`deliveryErrorMessage`, `isStaleDeliveryError`: ORDER_STATE_CONFLICT,
  ORDER_NOT_FOUND, WRONG_FULFILLMENT_MODE → drop the order) and the request check
  `src/api/delivery.ts` (`deliveryOtpBody`, `DELIVERY_ERROR_CODES`). Their strings moved to the
  `delivery.*` i18n namespace. Test ids: `delivery-otp-<id>`, `deliver-<id>`, `delivery-cash-<id>`.
- **Not built:** gig accept / "Picked Up" / "Reached Location", the ghost-customer "Unable to
  Contact" flow, live updates for riders.

### 9.15 Vendor wallet (Phases 12 and 12.5)

- **Route.** `app/(vendor)/wallet.tsx` = `/wallet`, inside the vendor-only group (the group is a
  Stack, not tabs, so the dashboard got a **Wallet** button, `vendor-wallet-link`).
- **Data.** `src/api/vendor-wallet.ts` (`fetchVendorWalletBalance`, `fetchVendorWalletLedger(cursor)`),
  `features/vendor/useVendorWallet.ts`: `useVendorWalletBalanceQuery` (`['vendor','wallet','balance']`)
  and `useVendorWalletLedgerQuery` (TanStack **infinite** query, `initialPageParam: null`,
  `getNextPageParam: next_cursor`), both `staleTime: 0` + `retryTransientFailures`. The FlatList
  calls `fetchNextPage` on `onEndReached` (not after a failed page: that shows a retry button).
- **Banner.** `wallet-format.ts#suspensionReason`: shown **only when the server says
  `is_suspended`**; DEBT (Phase 12.5: the server's `suspended_for_debt`) quotes the dues and the
  limit, OTHER (an admin suspension) asks to contact support. No client-side comparison decides it.
- **Pay outstanding balance (Phase 12.5).** On a DEBT banner, `wallet-pay-dues` pays exactly the
  dues (`outstandingDues` = −balance) through `useVendorTopUp` → `topUpVendorWallet` →
  `POST /api/vendors/wallet/top-up`. One idempotency key per outstanding amount, kept until a
  payment succeeds (a retry after a lost response cannot pay twice). Success patches the cached
  balance at once (the banner clears before any refetch), toasts "Dues paid. Your shop is back
  online." (or "stays offline" when the server still says suspended), then invalidates the balance
  and ledger queries. `503 TOP_UP_UNAVAILABLE` → "Paying dues in the app isn't available yet.";
  other errors → retry toast. The button reads "Paying…" and is disabled while in flight.
- **Formatting.** `formatBalance` / `formatPosting` put the sign before the currency ("− Rs. 100");
  `formatPostedAt` renders local `YYYY-MM-DD HH:mm` with Devanagari digits under `ne`. Strings
  under `vendorWallet.*` (EN/NE) and `vendorDashboard.wallet`.
- **Tests:** `VendorWallet.test.tsx` (11, msw: banner for debt / tightened limit / other reason /
  Nepali digits, none when healthy or negative within the limit, escrow line, balance retry,
  entries, empty, next page with the cursor and none after the last), `api/vendor-wallet.int.test.ts`
  (3), the dashboard link in `VendorFulfilment.test.tsx`. Mutation-checked: gating the banner on a
  negative balance instead of `is_suspended` fails 2. Phase 12.5: `VendorWallet.test.tsx` now 16
  (pay exactly the dues, banner cleared before the slow refetch answers, ledger refetched with the
  top-up, "Paying…" + no double press, partial result keeps the banner, 503, retry reuses the key)
  and `api/vendor-wallet.int.test.ts` 5. Mutation-checked: a new key per press, no cache patch and
  no ledger refetch each fail 1.

### 9.13 Vendor dashboard and the incoming-order alarm (Phase 10)

- **Role routing.** `useAuthStore.role` is read from the access token's `role` claim
  (`src/lib/access-token-role.ts`, base64url decode, **no signature check**: the role only picks
  screens, the API authorises every call) on `setSession` and on every `setAccessToken` (a refresh
  carries the role as the server now sees it; an unreadable token keeps the known role). It is
  persisted (store v2; a v1 slice migrates with `role: null` until the next token), never without a
  refresh token, and cleared on sign-out. `app/(tabs)/_layout.tsx` redirects a signed-in VENDOR to
  `/dashboard`; `app/(vendor)/_layout.tsx` redirects everyone else to `/`. So a vendor lands on the
  dashboard after OTP sign-in (the code screen's `router.back()` returns into the tabs, which
  redirect) and after a relaunch.
- **Data.** `useVendorOrdersQuery` (`['vendor','orders']`, `staleTime: 0`,
  `retryTransientFailures`) → `GET /api/vendors/orders`. `useVendorOrdersRealtime` opens
  `createOrdersSocket()` (same token lifecycle, §9.3), emits `vendor:subscribe` on every connect
  (10 s ack; timeout/INTERNAL retried on the backoff schedule, FORBIDDEN/VENDOR_NOT_FOUND never),
  refetches after each join and on every valid `order:state_update` (a new order's items are not in
  the update, so it refetches rather than patches).
- **Decisions.** `useVendorOrderDecisions`: pressing Accept/Reject adds the order to an
  `acknowledged` set at once (`onMutate`) and sends the POST. Success patches the cache (PREPARING
  stays listed, CANCELED is removed) and toasts; a network/5xx failure **withdraws** the
  acknowledgement (the alarm rings again) with "Couldn't send your answer"; `409`/`404` (the customer
  canceled, or another device answered) keeps it silent with "no longer waiting". The list is
  refetched after every decision.
- **Alarm** (`src/features/vendor/vendor-alarm.ts`): **`expo-audio` ~57.0.5**, not `expo-av`
  (`expo-av`'s last release, 16.0.8, targets SDK 54; SDK 57 bundles `expo-audio`). `createVendorAlarm`
  sets the audio mode (`playsInSilentMode: true`, `interruptionMode: 'doNotMix'`), lazily creates one
  player for `assets/sounds/vendor-alarm.wav` with `loop = true`, `volume = 1`; `start()` → `play()`
  (idempotent), `stop()` → `pause()` + `seekTo(0)`, `release()` → `remove()`. `useVendorAlarm(ringing)`
  owns one per mount. **ringing = some order is PLACED and not acknowledged** (`isAlarmRinging`), so it
  loops until every waiting order is answered, restarts if an answer fails, and stops by itself when
  the customer cancels. Leaving the screen frees the player. **Foreground only**: no background
  playback plugin, no push (§13).
- **Tests:** `vendor-alarm.test.ts` (11, fake player: loop/volume/play/pause/seekTo/remove),
  `VendorDashboard.test.tsx` (14, msw + FakeSocket: room join, alarm on socket arrival, Accept/Reject
  silence it before the server answers, two orders, failure resumes, 409 stays silent, customer
  cancel, unmount), `VendorRouting.test.tsx` (9), `api/vendor-orders.int.test.ts` (5), auth store role
  (6) and token decoding (6). `jest.setup.ts` mocks `expo-audio` globally with
  `src/test/fake-audio.ts` (default volume 0.5, so a test proves the app sets 1). Mutation-checked:
  no loop, no pause on stop, no acknowledgement on press, no resume on failure each fail tests.
- **Customer side:** `canCancel` / the order screen's `windowOpen` accept PLACED **or PREPARING**
  inside the 60 s window (`isCancelableState`), matching the server.
- **Dispatch and self-delivery handoff (Phase 11.5).** `VendorOrderCard` shows **Dispatch** on a
  PREPARING order (`dispatch-<id>`) and, on a SELF_DELIVERY order OUT_FOR_DELIVERY, the handoff hint,
  the cash to collect and `DeliveryOtpForm`; the dashboard lists those under "Out for delivery".
  - `useVendorDispatch` (`dispatchVendorOrder`, `retry: false`): success patches the cached state
    (a fleet order is dropped by `isOnVendorDashboard`, a SELF_DELIVERY one moves to Out for delivery)
    and toasts; **`422 CANCELLATION_WINDOW_OPEN` → "The customer can still cancel for N s. Dispatch
    after that."** (N from `details.retry_after_seconds`, Devanagari under `ne`), the button stays;
    409/404 → "This order has moved on."; anything else → "Couldn't dispatch the order."
  - `useVendorDelivery` (`deliverVendorOrder`, `retry: false`): the rider's outcomes (success removes
    the order; wrong code → tries left + field cleared; lockout → minutes; stale → removed).
  - The alarm is unaffected: only PLACED orders ring.
  - Tests: `VendorFulfilment.test.tsx` (14, msw + FakeSocket through the real dashboard) and the
    dispatch/deliver cases of `api/vendor-orders.int.test.ts`. Mutation-checked: dropping the 422
    branch and showing the code field on fleet orders each fail tests.

### 9.16 Product discovery and live inventory (Phase 18)

SPEC vendor flow step 3 (SKUs mapped to the admin taxonomy), §3 (inventory) and customer flow
steps 3–4. Code: `app/(tabs)/index.tsx`, `src/features/discovery/*`, `src/features/feed/ShopsFeed.tsx`,
`src/lib/useDebouncedValue.ts`, `src/api/catalog.ts`, `src/store/useCartStore.ts`,
`src/features/cart/stock-shortfalls.ts`, `src/api/mutations.ts`, `app/(tabs)/cart.tsx`.

```
Home ─ search field ──(toSearchTerm)──▶ useDebouncedValue(300 ms) ─┐
     ─ category pill (root) ───────────────────────────────────────┴▶ useInfiniteQuery
                                             ['products', categoryId, search] ─▶ GET /api/products
     neither in use ─▶ ShopsFeed (GET /api/vendors, unchanged)

ProductCard: max = min(stock_quantity, 99) − in cart ─▶ stepper 1…max ─▶ addItem(…, availableStock)
Cart ─ POST /api/cart/checkout ─▶ 409 INSUFFICIENT_STOCK {shortfalls[{productId, requested, available}]}
     ─▶ useCartStore.syncStock ─▶ lines with quantity > availableStock highlighted, Proceed disabled
     ─▶ customer lowers ("−", "Set to N", "Remove") ─▶ new fingerprint ─▶ new idempotency key ─▶ checkout
```

**API change.** `publicProductSchema` (shared-types) gained `stock_quantity` (int ≥ 0), and
`publicProductView` (`apps/api/src/routes/catalog.ts`) fills it. `in_stock` is kept. The mobile app
rejects a product list without it (`UNEXPECTED_RESPONSE`), so **the API and the app must be
deployed together** for this phase.

**Home screen (`app/(tabs)/index.tsx`).** One screen, two bodies under a shared header:

| Header state                     | Body                                                        |
| -------------------------------- | ----------------------------------------------------------- |
| field blank and the "Shops" pill | `ShopsFeed`: the Phase 6.5 vendor feed, behaviour unchanged |
| text in the field, or a category | `ProductResults`: the public product list for that filter   |

- **Categories:** `useCategoriesQuery` (`['categories']`, `staleTime` 5 min, `retryTransientFailures`,
  **public**: `authenticated: false`, so it works signed out). Pills = `rootCategories` (`parent_id`
  null, server order) after a "Shops" pill that clears the filter. A root pill also lists its
  subcategories' products (the API matches descendants); subcategories are not pills. **Invalidation:**
  the product list's pull to refresh, and a `404 CATEGORY_NOT_FOUND` from `GET /api/products` (the
  category was hidden meanwhile). A chosen category that is no longer in the list stops filtering at
  once (the selection is derived from the current roots), so the screen falls back to the shops. If
  the taxonomy cannot be loaded, the pills are simply absent; search still works.
- **Search pattern:** `useProductSearch(input, categoryId)`.
  - `toSearchTerm`: trimmed, inner whitespace collapsed, cut to `MAX_PRODUCT_SEARCH_LENGTH` (100);
    blank → null (the API refuses an empty search). The `TextInput` has the same `maxLength`.
  - `useDebouncedValue(term, SEARCH_DEBOUNCE_MS = 300)`: the query key holds the **debounced** term,
    so a burst of keystrokes makes one request with the last text. Only the term is debounced; a
    pill tap asks at once. Whitespace-only edits do not change the term and ask nothing.
  - `active` (field or pill in use) switches the body **at the first keystroke**; while
    `isDebouncing` the list shows a spinner instead of the previous results.
  - `useInfiniteQuery`, key `['products', categoryId, search]` (`PRODUCTS_QUERY_KEY = ['products']` is
    the prefix to invalidate), `staleTime: 0` (stock moves; a filter chosen again shows its cached
    page at once and refetches behind it), `getNextPageParam: next_cursor`, `enabled` only with a
    filter. Next page on `onEndReached`; a failed page gets a retry button instead of rescrolling.
  - The server matches every word as a prefix (§8K); nothing is filtered on the device.
- **Who can be ordered from:** the public list names only the shop (`vendor {id, business_name}`).
  `serviceableVendors(feed)` maps the feed's **serviceable** section to cart vendors (fee, MOV); a
  product of any other shop is browse-only with "Doesn't deliver to you" (SPEC customer flow step
  3). Without a loaded feed nothing can be added; signed out, the card says "Sign in to order."
  Browsing itself needs no session.
- **Product card:** name, shop, description, `Rs. {price} / {unit}`, "{n} in stock" or the
  **"Out of Stock" badge** (`stock_quantity === 0`), "{n} in cart", stepper, Add.

**Stock safeguards (three places, one number).**

| Where                      | Rule                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ProductCard` stepper      | `maxAddable(stock, inCart)` = max(0, min(stock, 99) − inCart); the shown quantity is `clampQuantity(selected, max)`, **derived on every render**, so a refetch that lowers the stock pulls the picker down. "+" is disabled at the ceiling; Add and both steppers are disabled at max 0 (sold out, or the cart already holds it all: "All the available stock is already in your cart.") |
| `useCartStore.addItem`     | `'stock_limit'` (nothing changes) when the line would pass the product's stock. The stock is the one passed with the product, else the line's known value (**since Phase 19 the vendor menu passes its `stock_quantity` too**, §8L). Checked after the 99-per-line limit                                                                                                                 |
| `useCartStore.setQuantity` | an increase is capped at `maxLineQuantity(availableStock)`; **a decrease is always taken**, so an over-stock line can be stepped down one at a time and never back up                                                                                                                                                                                                                    |

**409 INSUFFICIENT_STOCK in the cart.**

1. `useCheckout`'s `onError` → `stockLevelsFromDetails(error.details)` (Zod; `available` floored and
   never negative; missing or malformed details → no levels) → `syncStock(levels)`: sets
   `availableStock` on the named lines, **quantities untouched**. `['products']` queries are
   invalidated (their counts are stale). The idempotency key is kept: the cart must change before
   checkout is possible again, and a changed cart has a new fingerprint and key (tested).
2. The cart screen marks every `isOverStock` line (quantity > `availableStock`) with a red border
   and "Only N left in stock. Lower the quantity." + **"Set to N"**, or "Out of stock. Remove this
   item to continue." + **"Remove"** when N is 0. "+" is disabled at the stock.
3. **Proceed to Checkout is disabled while any line is over stock**; below the server's message (or,
   when there is none, e.g. after a relaunch) the cart says "Lower the highlighted items to
   continue." Changing any quantity clears the last checkout error (`checkout.reset()`).
4. The highlight is derived from persisted state, so it survives a relaunch. `available` from the
   Redis-lock layer is stock minus other customers' live holds, so it can be lower than the real
   stock for up to 600 s; adding the product again from the list refreshes it.
5. Both server layers are handled the same way (the stock guard and the Redis lock answer the same
   code and details, §8K).

**Tests** (mobile +93, 768 in total).

- `lib/useDebouncedValue.test.ts` (6, fake timers): initial value at once, 299 ms vs 300 ms, a burst
  yields only the last value, change and back, unmount clears the timer, custom delay.
- `features/discovery/discovery-rules.test.ts` (15): search term, roots, `maxAddable`, `clampQuantity`.
- `api/discovery.int.test.ts` (12, msw): no Bearer header on either endpoint, works signed out,
  strict contracts (admin fields refused, a product without `stock_quantity` refused), the hook
  cached across two readers, **8 keystrokes → one request with the last text**, whitespace-only
  edit → no request, category not debounced, paging with the cursor, 404 → pills refetched, no retry.
- `features/discovery/ProductDiscovery.test.tsx` (21, the real Home screen over msw): root pills
  only, shops by default, category filter + real data, switching and returning to the shops, cached
  re-selection, a vanished category, taxonomy failure, search debounce on screen, search + category,
  clearing, retry, next page and end of list, Devanagari; **out-of-stock badge with everything
  disabled, one unit left, stepper stopped at the stock, add with the feed's vendor snapshot, cart
  contents counted, in stock → less stock → sold out through refetches,** unserviceable shop,
  signed-out browsing, frozen during checkout.
- `store/useCartStore.test.ts` (+22): the stock block (19), persistence of `availableStock`, a v2 cart
  kept, negative stock discarded.
- `features/cart/stock-shortfalls.test.ts` (8), `features/cart/CartScreen.test.tsx` (+7: highlight +
  store sync + disabled Proceed, "Set to N" then a successful checkout with a new key, stepping
  down, sold-out removal, several lines, no lines named, Nepali), `api/checkout.int.test.ts` (+1:
  store synced, product lists invalidated, key kept), `VendorMenuScreen.test.tsx` (+1).
- shared-types `catalog.test.ts` and API `catalog-api.int.test.ts`: the public product now carries
  `stock_quantity` (one test each rewritten; counts unchanged).
- **Mutation-checked** (each fails at least one test): no debounce (3), the request keyed on the
  undebounced text (2), `addItem` ignoring stock (6), `setQuantity` ignoring stock (2) or forcing an
  over-stock line down (2), `isOverStock` with `>=` (4), `maxAddable` ignoring the cart (4), Add
  enabled when sold out (3), no badge (3), stepper not clamped (4), no `syncStock` on 409 (5),
  checkout allowed over stock (2), unserviceable shops orderable (1).
- **Not run on a device or against the live API** (msw only; the API integration test covers the
  new field).

### 9.17 Push notifications (Phase 20)

SPEC implicit requirement 1. Code: `index.ts`, `app/_layout.tsx`, `src/api/notifications.ts`,
`src/features/notifications/*`, `app.json`. Dependencies: **`expo-notifications` ~57.0.21** and
**`expo-task-manager` ~57.0.21** (both native: a new development build is needed).

- **Registration** (`push-registration.ts#registerForPushNotifications`, never throws):
  1. `devicePlatform()` (android → `ANDROID`, ios → `IOS`, anything else → `unavailable`) and
     `easProjectId()` (`Constants.expoConfig.extra.eas.projectId`, else `Constants.easConfig`);
  2. `getPermissionsAsync`; if not granted and `canAskAgain`, `requestPermissionsAsync` (the OS
     prompt; Android 13+ and iOS). Refused → `permission_denied`, nothing else happens;
  3. `getExpoPushTokenAsync({ projectId })`; a device that cannot get one (emulator without Play
     services, simulator, missing FCM setup) → `unavailable`;
  4. `registerDeviceToken({ token, platform })` → `POST /api/notifications/device-token` through
     `apiRequest` (Bearer token, Zod-validated; a non-Expo token is refused on the device).
     Server or network failure → `failed`.
- **When** (`usePushRegistration`, mounted once by `PushNotifications` in the root layout): only
  while `selectHasSession`, so the prompt appears **at launch with a stored session or right after
  sign-in**, never on a signed-out first launch. It runs again when the refresh token changes (a
  new sign-in, possibly another account) but not when only the access token is renewed. A `failed`
  attempt is repeated when the app next returns to the foreground (`AppState` → `active`); the
  other results are not retried until the next launch or sign-in.
- **Foreground banners** (`notification-handler.ts`): `configureForegroundNotifications()` runs at
  module scope of `app/_layout.tsx` and installs `setNotificationHandler`: a notification with a
  title or body → `shouldShowBanner`, `shouldShowList`, `shouldPlaySound` (no badge); one with
  neither (a raw data-only push) → nothing. Without a handler Expo shows nothing while the app is
  open.
- **Android channel**: `ensureOrderNotificationChannel(t('notifications.orderChannel'))` creates
  `orders` (`ORDER_PUSH_CHANNEL_ID`, importance HIGH, default sound), named "Order updates" /
  "अर्डर अपडेट" in the app language; the worker's visible pushes name the same `channelId`, and
  `app.json` sets it as the plugin's `defaultChannel`.
- **Data-only pushes** (`order-push-task.ts`): `registerOrderPushTask()` defines the TaskManager
  task `hamro-pasal.order-push` and registers it with `Notifications.registerTaskAsync`. It runs
  for every remote notification (foreground, background, terminated). `orderPushFromTaskPayload`
  finds the worker's `data` wherever the platform put it (`data.dataString` or `data.body` as a
  JSON string on Android, `data.body` as an object on iOS, or `data` itself), validates it with
  `orderPushDataSchema`, ignores notification taps, and **only when `data_only` is true** posts a
  local notification (`scheduleNotificationAsync`: the event's title and body, default sound, the
  `orders` channel on Android, `identifier = notification_id` so a push delivered twice replaces
  itself). That local notification then passes the foreground handler like any other.
- **App entry**: `package.json` `"main": "index.ts"`, which imports
  `register-order-push-task` **before** `expo-router/entry`. A terminated app is started headless
  for a data-only push and no component mounts, so the task cannot be defined in a layout.
- `app.json`: plugin `["expo-notifications", { "defaultChannel": "orders",
"enableBackgroundRemoteNotifications": true }]` (the iOS `remote-notification` background mode
  that `_contentAvailable` needs).
- **Not built:** opening the order when a notification is tapped, unregistering on sign-out, a
  settings switch, localised push text, notification icon / colour.
- **Tests** (+39, `src/features/notifications/`): `push-registration.test.tsx` (16, msw + the
  `fake-notifications` stand-in, `expo-constants` fed the real `app.json`): permission → token
  with the project id → the exact POST (Bearer, `{token, platform: 'ANDROID'}`), no second prompt
  when granted, `IOS`, refused prompt, cannot ask again, no token, web, 503 → `failed`, a non-Expo
  token never sent; the hook: registers at launch with a session, **nothing while signed out then
  registers after sign-in**, again after sign-out + sign-in, not on an access-token renewal,
  retry on foreground after a failure, listener removed on unmount. `notifications.test.ts` (23):
  banner behaviour, handler installed, channel on Android only, the four payload shapes, six
  payloads ignored, the local notification verbatim, iOS trigger, identifier, a visible push left
  to the system, `Failed` when posting throws, task defined once and registered, nothing on web.
- **Mutation-checked** (each fails at least one test): no banner (2), registering while signed out
  (1), posting every push locally (1), no retry on foreground (1), retrying always (1), always
  prompting (1), the posted copy still `data_only` (1), a banner for an empty notification (1), no
  project id (1).
- **Not run on a device.** The payload shapes the task reads come from the Expo documentation and
  types, not from an observed delivery.

## 10. Mock inventory (what the app still fakes)

Phase 6.5 removed every catalogue, order and cancellation mock. What remains:

| Mock            | File                                             | Real replacement (status)                                                                     |
| --------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Dev token paste | `src/features/auth/DevSignIn.tsx` (`__DEV__`)    | Superseded by OTP login (§8A); kept for quick checks. Holds no refresh token.                 |
| Feed location   | `THAMEL_FALLBACK_LOCATION` when no address saved | Live GPS (`expo-location` is already used by the territory gate) or a Mapbox pin-drop (§9.8). |

Phase 9 deleted the review and evidence-upload mocks; the dispute chat talks to the real `/chat`
server. The **server side** still fakes R2: evidence is stored on the API host's disk (§8C).

**Ids are real now.** The feed and menus return database uuids, so a checkout started from the app
references real vendors and products (a Phase 6 API test checks out a product id taken from the
menu endpoint). The Phase 5 "mock ids → 422 VENDOR_UNAVAILABLE" blocker is gone.

## 11. Backlog (suggested order)

1. **NEXT PRIORITY: first live end-to-end run** on a development build against the local API (§3),
   with the worker running (`pnpm --filter @hamro-pasal/worker dev`) so `/orders` updates flow: feed →
   menu → checkout (COD, then eSewa and Khalti sandboxes) → tracking (live) → cancel. Confirm eSewa's real success
   redirect matches `rawQueryParam` (§13).
2. **Session hardening, rest** (Phase 16 moved the Super Admin's refresh token into an HttpOnly cookie
   and added `/api/auth/refresh` + `/api/auth/logout`, §8J): refresh-token rotation (a new refresh
   token, or cookie, per refresh, old `jti` burned) with a Redis/Postgres denylist, making logout
   revoke the `jti` (today it only clears the cookie; the mobile app has no logout call), and per-IP
   rate limiting on `/api/auth/*` (only the per-phone cooldown exists).
3. **Order lifecycle, rest** (Phase 10 built accept/reject and the 90 s timer; Phase 11 dispatch
   and the fleet rider's OTP delivery with settlement; Phase 11.5 the vendor's Dispatch button and
   the SELF_DELIVERY handoff): gig broadcast/assignment, "Picked Up",
   "Reached Location", the
   8 min ghost-customer timer, and driver access to `/orders`. Each transition calls
   `enqueueOrderStateChanged` in its transaction; the vendor room already receives every update.
   Vendor follow-ups: ~~the IVR/SMS consumer of `vendor.escalation.required`~~ (SMS in Phase 13,
   mock IVR call in Phase 14; still to do: a **real IVR adapter** in `@hamro-pasal/ivr`, Twilio
   Voice or a Nepal SIP trunk, ~~a DLQ replay tool~~ (Phase 15), and a DLQ for `order.lifecycle`), SPEC's **3-minute acceptance window**
   (auto-reject? not specified), "Accept with Modifications" (partial fulfilment + partial refund),
   Vendor Acceptance Rate (< 85 % penalises feed ranking), refusing decisions from a SUSPENDED
   vendor, background alarm (push with a data-only payload, expo-audio background plugin).
4. **Cancellation follow-ups:** the vendor dashboard now hears customer cancellations (vendor room);
   no push reaches a vendor whose app is closed. The 60 s window vs early accept is decided (§12).
5. **Refunds:** a worker consumer for `order.canceled_refund_due` (eSewa/Khalti refund APIs + a ledger
   journal out of SYSTEM_ESCROW), and the same for `PAID_AFTER_SESSION_EXPIRED` (which should also set
   `refund_required`). The app already tells the customer "Escrow refund initiated".
6. **Checkout serviceability:** reject a delivery address outside the vendor's scope (reuse the
   CatalogService SQL).
7. **Feed location from GPS** instead of the saved address / Thamel fallback.
8. **Saved addresses** (`customer_addresses` CRUD) if the app should sync addresses across devices,
   and a profile screen to add the customer's name (`first_name` is null after OTP sign-up).
9. **Disputes follow-up (Phases 9/9.5 built reviews both ways, `/chat` with a persisted transcript,
   dispute opening, transcript read-back and uploads, §8C):** a Super Admin client for the transcript
   (the API already serves it to admins), transcript pagination if disputes get long, admin resolution
   routes (`REFUNDED_TO_CUSTOMER` triggers the refund flow, `RELEASED_TO_VENDOR` unfreezes escrow),
   decide whether an opened dispute moves the order to `DISPUTED` (reviews and access currently
   require `DELIVERED`), a read route for published reviews, and optionally a BullMQ job that flips
   `is_published` after 48 h (reads already treat such reviews as public).
10. **Evidence storage:** replace `LocalEvidenceStorage` with Cloudflare R2 (presigned PUT or
    server-side put) behind the same `EvidenceStorage` interface, and add react-native-compressor on
    the device (SPEC infrastructure §6: WebP, 1200 px, < 300 KB) so large photos are not refused.
11. **Admin dashboard follow-ups (Phase 15 built the DLQ monitor and vendor overrides, §8I):**
    ~~HTTP-only refresh cookie for the web (survive reloads)~~ (Phase 16, §8J), same-origin **HTTPS**
    hosting of `apps/admin/dist` behind the ALB (the cookie is `Secure` and `SameSite=Strict`, so the
    dashboard and `/api` must share one HTTPS origin), an alert when dead letters arrive, a DLQ for `order.lifecycle` stored the same
    way, KYC approval (SANDBOXED → APPROVED), ~~taxonomy~~ (Phase 17, §8K), logistics toggles, the suspension-limit setting,
    dispute transcripts and resolution, vendor list pagination (capped at 500), and component tests
    for the React screens (only their logic modules are unit-tested).
12. Landing pages for `ESEWA_SUCCESS_URL` / `ESEWA_FAILURE_URL` / `KHALTI_RETURN_URL`, eSewa app-to-app
    support, `/metrics` (the Prometheus target is down), rate limiting, worker consumers and timer
    handlers, feed pagination (sections are capped at 100).

13. **Push follow-ups (Phase 20 built the device-token endpoint, the worker's order pushes and the
    app's registration, foreground handler and data-only task, §8M, §9.17):** FCM V1 / APNs
    credentials on the EAS project and the first real delivery (part of item 1); **unregister on
    sign-out** (`DELETE /api/notifications/device-token`); open the order when a notification is
    tapped; poll Expo push receipts and drop tokens that fail there; a looping alarm for a vendor
    whose app is closed (a custom channel sound, or a full-screen intent); pushes for dispute chat
    messages, wallet suspension / restore and, once gigs exist, riders; localised text (store the
    app language with the device token); a retry path for failed pushes that does not sit on the
    `order.lifecycle` partition (their own topic or a BullMQ queue).

14. **Catalog follow-ups (Phase 17 built the taxonomy, vendor create / stock / list, the public
    reads, the checkout stock guard and the two admin screens, §8K; Phase 18 the customer's
    category pills, product search and stock safeguards, §9.16; Phase 19 the vendor's edit / hide /
    photo upload routes, the web Vendor Portal and `stock_quantity` on vendor menus, §8L):** a
    **"New product" form in the Vendor Portal** (the API route exists; the portal only edits) and a
    vendor catalogue screen in the mobile app; a cookie session for vendors on the web (a reload
    signs them out); **R2** behind `ProductImageStorage` and `react-native-compressor` /
    server-side resizing (SPEC infrastructure §6: WebP, 1200 px, < 300 KB; today the original file
    is stored); telling an admin Hide apart from a vendor's own (a vendor can show again a product
    the Super Admin hid); subcategory navigation (only root pills exist); a serviceability flag (or
    location parameters) on `GET /api/products` instead of joining with the feed on the device;
    product images on the mobile cards; search ranking / typo tolerance / Roman ↔ Devanagari matching; an audit record and a
    vendor notification when an admin hides a product; rate limiting of the public reads and of
    uploads; component tests for the React screens.

15. **Rider follow-ups (Phase 21 built deliveries with accept / pickup / complete, GEOADD
    telemetry and the periodic customer push, §8N, §9.14):** real GPS on the rider's device
    (`expo-location` watcher, background location permission) instead of the mock switch;
    **showing the rider's position to the customer** (the tracking screen ignores
    `order:rider_location`; SPEC asks for discrete nodes, so decide what to show); gig broadcast by
    distance (`GEOSEARCH riders:active` from the shop, a push to nearby riders) instead of every
    rider seeing every open gig; "Reached Location", the 8 min ghost-customer timer and
    `FAILED`; un-accepting / reassigning a delivery (no route; a rider who accepts and disappears
    blocks the order); a live update of the rider's list (it is pull to refresh); sweeping riders
    that stopped reporting out of `riders:active`; a per-rider (not per-connection) rate limit;
    moving pickup before OUT_FOR_DELIVERY if "Out for Delivery" should mean "the rider has it".

16. **Finance follow-ups (Phase 22 built reconciliation, payout requests with approve / reject and
    the two web tabs, §8O):** a real bank / eSewa payout integration (today an admin pays outside the
    platform and types the reference); the vendor's **bank account details** (no table or form; the
    admin must already know where to pay); a vendor notification when a payout is decided (SMS /
    push; no event exists); the payout flow in the **mobile** vendor app (the wallet screen only
    lists the postings); a minimum payout and a per-day limit; withdrawing only **reconciled**
    earnings if the audit should gate money; an admin screen for reconciliation discrepancies (they
    are log lines) and a way to resolve one (an ADJUSTMENT journal); a second journal at approval
    (PAYOUT_CLEARING → a bank account) so the clearing balance means "pending" only; a unique index
    for the PAYOUT_CLEARING singleton in a later migration; pagination of the vendor's reconciled
    orders and payouts (capped at 20); rider (driver wallet) payouts and float collection;
    component tests for the two React screens and a live run.

## 12. Decisions made (with the user's approval where one was asked)

- Express 5 (not NestJS); BullMQ **and** Kafka; conditional wallet CHECK + trigger with limit in
  `platform_settings`; double-entry ledger; delivery fee to the deliverer; transactional outbox;
  checkout creates the order together with the lock; JWT verification now, login later; enums
  stored as strings; ioredis 5.x (ioredis-mock needs it).
- Mobile: access token memory-only, refresh token and locale in AES-256 MMKV (key in the keychain);
  cart in plain MMKV; single-vendor enforcement in the store with a replace prompt; customer platform
  fee shown as Rs. 0; payment-method picker in the cart; payment callbacks forwarded to the
  webhook/lookup endpoints; the delivery OTP persisted in encrypted storage and never passed through
  route params; mocks for every missing endpoint behind a single file each; geofence = box + reverse
  geocoder with a box fallback.
- **Phase 6:**
  - One `NEPAL_BOUNDING_BOX` (Nepal's extreme points, the territory gate's former values) for the
    gate, address pins and API coordinates.
  - Feed response keys are `serviceable` / `explore_further` (the mobile contract), not
    `unserviceable`. CITY_WIDE matching needs the optional `municipality_palika_string` query param.
    Menus require `lat`/`lng` because the menu contract carries `serviceable`.
  - The delivery address is a per-order copy in `order_addresses`, not a reference to
    `customer_addresses`. It is **required** at checkout (the app sends it).
  - Only PLACED orders are cancelable; the window runs from **`placed_at`** on the database clock;
    expiry is `422 CANCELLATION_WINDOW_EXPIRED`; repeat cancels return 200; other customers get 404.
  - The refund-due event is named `order.canceled_refund_due` (dotted like the others) on
    `payment.reconciliation`.
  - Existing placed orders were backfilled with `placed_at = created_at` (0009).
- **Phase 6.5:**
  - **Clock ownership:** the mobile 60 s countdown (and the 48 h dispute button) run on the
    device's own observation times (`placedAt` / `deliveredAt` in `useOrderStore`); they are UX
    only. The Postgres `placed_at + 60 s` check is the authority, and the app handles its
    `422 CANCELLATION_WINDOW_EXPIRED`. Do not anchor client timers on server timestamps (device clock
    drift).
  - The feed and menus are asked from the saved address's pin and Palika, falling back to Thamel;
    live GPS for the feed is deferred.
  - Mocks are deleted, not kept behind flags; tests use msw with schema-built fixtures instead.
  - Reads that cannot succeed on retry (4xx other than 408/429) are not retried.
  - A prepaid cancel is announced as "Order cancelled. Escrow refund initiated." based on the
    server's `refund_required`, not on the client's idea of the payment method.
- **Phase 7:**
  - OTP: 6 digits, 120 s TTL, 60 s resend cooldown, 5 attempts, single use, stored as a keyed digest
    (all constants in shared-types).
  - `users.first_name` became nullable rather than inventing a placeholder name.
  - Existing accounts keep their role on sign-in; new numbers become CUSTOMERs.
  - `SMS_PROVIDER=MOCK` for development (refused in production); `FIREBASE` fails at startup.
  - The refresh token is returned in the JSON body (a native app has no HTTP-only cookie jar) and
    stored in AES-256 MMKV; the access token stays in memory.
  - Login replaces itself with the code screen so "back" after verifying lands on the caller.
- **Phase 7.5:**
  - Refresh returns a new access token only (no rotation yet); the role comes from the database.
  - The client refreshes on a 401 **and** up front when only a refresh token exists (relaunch).
  - Only 400/401 from the refresh endpoint end the session; network errors and 5xx keep it.
  - A stored refresh token counts as signed in (`selectHasSession`), so the Cart and Profile do not
    flash "signed out" after a relaunch.

- **Phase 8:**
  - The socket event is SPEC's `order:state_update` (the Phase 8 prompt said `order_updated`; SPEC
    wins per CLAUDE.md). Its payload is the slim `orderStateUpdateSchema`, patched into the cached
    snapshot, not a full `OrderSnapshot`.
  - One generic event, `order.state_changed` on `order.lifecycle`, for every transition (creation
    included), alongside the existing specific events.
  - Fan-out runs in the worker (Kafka consumer + `@socket.io/redis-emitter`), not in the API; the API
    only serves sockets. Both share `SOCKET_IO_REDIS_KEY`.
  - WebSocket-only transport on server and client (no sticky sessions needed).
  - Only CUSTOMERs may connect to `/orders` for now, mirroring the REST routes. (Phase 10 admits
    VENDORs too, for their shop room only; §8D.)
  - Room membership is checked once, at subscribe; the token only at the handshake.
  - The client refetches once after every successful subscribe instead of polling.
  - `/chat` got the same client token lifecycle now (`createAuthenticatedSocket`), before its server
    exists.

- **Phase 9:**
  - Review quarantine is SPEC's `is_published = false`; the prompt's `status: QUARANTINED` is the
    API's derived view of it (SPEC wins). The request field is the prompt's `feedback` (stored in
    `reviews.comment`).
  - The 48 h anchor is `orders.delivered_at` (database clock). Reviews after the window are refused
    (422), so the double blind cannot be bypassed by reviewing after the other side went public.
  - 48 h publication is evaluated at read time (`reviewIsPublic`), including for the COD rating
    average; no sweeper job.
  - `/chat` lives on the same Socket.io server as `/orders` (one Redis adapter, one heartbeat). Chat
    access: order customer / vendor user inside the window, Super Admin always, drivers never.
  - The server builds the sender from its own users row and strips PII at a single exit point
    (`broadcastChatMessage`); clients send no user object. Attachments must be URLs the upload
    endpoint issued for that order.
  - Uploads are multipart through the API (multer, memory, 5 MB), type checked by magic bytes, stored
    under `os.tmpdir()/uploads` (the prompt's `/tmp/uploads`, portable to Windows) and served by the
    API. Attachment URLs may be `http` for this local stand-in.

- **Phase 9.5:**
  - The transcript table is `chat_messages` keyed to `disputes` (not to orders): every message belongs
    to a dispute, and the order's first message creates it. The prompt's event name `chat:message` is
    the existing `chat:new_message` (SPEC implicit requirement 4 names that event).
  - Messages are persisted **before** broadcasting; a failed write means no broadcast.
  - Retries dedupe on `(dispute, sender, client_id)`; the retry is re-broadcast with the stored id and
    clients drop the duplicate.
  - Any participant (customer, vendor, admin) can open the dispute. The order state stays
    `DELIVERED`.
  - An OPEN dispute keeps the chat (and uploads) available after 48 h; resolution closes it again.
  - The vendor review route is `/api/vendors/orders/:id/reviews`, mounted ahead of the customer
    `/api/vendors` catalogue; it reuses `ReviewService.submit` unchanged.

- **Phase 9.6:**
  - Transcript read-back is REST (`GET /api/orders/:id/chat`), not part of the `chat:join` ack, so it
    is cacheable in TanStack Query and works while the socket is still connecting.
  - Reading needs party membership only (no 48 h check): it is the parties' own conversation.
  - One function (`publicChatMessage`) produces every client-visible message, for both the socket and
    REST, so the privacy filter cannot diverge between them.
  - The app fetches on mount in parallel with the socket and refetches after each re-join (not on
    the first join, which would duplicate the mount request).

- **Phase 13:**
  - The SMS adapters moved into a shared package (`@hamro-pasal/sms`) rather than the worker
    importing from the API app or copying the code; the API's behaviour is unchanged.
  - Notification SMS go through the existing `SMS_PROVIDER` switch (Sparrow in `.env`, MOCK
    for local work); there is no separate notification provider setting.
  - Dedupe claims the event before sending (as the order fan-out does): on a crash mid-send an
    SMS may be lost, never sent twice by a redelivery.
  - The suspension SMS asks for the full dues (to 0), matching the restore rule, not the gap to
    the limit.
  - Texts are English ASCII (single GSM-7 segment, cheapest); the IVR voice call is out of scope.

- **Phase 17:**
  - **Cloud infrastructure is skipped for now (user decision):** everything stays on local Docker.
  - `products` already existed, so the prompt's "create products" became an ALTER (migration 0016).
    The prompt's `price` is the existing `price_npr`; `category_id` is nullable in the database
    (older rows) and required by the API.
  - The prompt's path `/api/vendor/products` (singular) was used as written, beside the existing
    `/api/vendors/...` routes. Query parameters are snake_case like every other contract
    (`category_id`, `vendor_id`), not the prompt's `categoryId` / `vendorId`.
  - SPEC's "immutable" taxonomy = immutable for vendors. The prompt's DELETE removes only an unused
    category; a used one is hidden (`is_active: false`). PUT replaces the whole category.
  - Depth is capped at 3 levels (`MAX_CATEGORY_DEPTH`); cycles and depth are checked in the service
    under one advisory lock, not by a trigger.
  - `GET /api/categories` and `GET /api/products` need **no token** (the prompt's "Public"); the
    older feed and menus stay CUSTOMER-only.
  - Full-text search is an **expression GIN index** with the `'simple'` configuration (no stored
    `tsvector` column, no stemming: names are Nepali and English), matched by word prefix, all words
    required, sorted by name (not by rank) so keyset pagination stays stable.
  - Stock is set to an absolute quantity. Checkout got an explicit PostgreSQL stock check in front
    of the existing Redis lock and guarded decrement, which were kept.
  - Added although the prompt did not list them, because the admin screens need them:
    `GET /api/admin/categories`, `GET /api/admin/products`, `PATCH /api/admin/products/:id/active`.
  - A product in a hidden category stays visible in the unfiltered public list, on menus and at
    checkout (hiding a category removes navigation to it, it does not delist products).
  - The admin `dev` script became `vite --force` (stale pre-bundled `shared-types`, §3).

- **Phase 23:**
  - **"Feature development complete" is stated for the planned phases, not for all of SPEC.md**; the
    unbuilt SPEC items are listed in §8P and §13 rather than hidden behind the declaration.
  - The lifecycle test uses a **prepaid (eSewa) fleet order**, the path that exercises escrow, the
    Redis lock, the rider and all three wallets. "Wallet authorized" = payment captured into escrow.
  - The midnight job is triggered **as the manual command in a child process**, not by importing
    worker code into the API tests and not through BullMQ (Phase 22 already tests the queue path).
  - The stress test goes through **HTTP with COD** (the prompt's "stock exactly 0" needs the claim in
    the same request); the Redis-only race test from Phase 3 was kept beside it.
  - The claim's commit-then-release order was **kept** although it allows a brief under-allocation
    (never an oversell); see §8P.2.
  - Usually-NULL foreign keys got **partial** indexes; the audit query is kept as a test.
  - The prompt's `orders.user_id` does not exist; the customer column is `customer_id` and was
    already indexed. No index was added that the audit did not call for.
  - The JWT audit added one check (JWT secret ≠ gateway key) and did not split the worker's env schema
    (a wider change than an audit; reported in §8P.4).

- **Phase 22:**
  - **Double-entry is kept; no `vendor_balances` table** (asked; user chose). SPEC §5 prohibits
    single-entry wallet tables and `vendors.wallet_balance_npr` already is the projection.
  - **The nightly job verifies and marks; it does not credit** (asked; user chose). Settlement
    stays in the delivery's transaction (the Phase 11 decision), so earnings are available from
    delivery. The job posts a settlement only when none exists.
  - **A payout is held when requested** (asked; user chose), and **`POST …/reject` was added** so a
    held amount can be returned. Approval moves no money.
  - Not asked, decided from SPEC: the commission is the order's stored
    `platform_commission_amount`, not a flat 10 %; "RECONCILED" is `orders.reconciled_at`, not an
    `OrderState`.
  - The prompt's paths were used as written (`/api/vendor/finance/…`, `/api/admin/finance/…`).
    Fields are snake_case with the `_npr` suffix like every other contract.
  - The payout request takes an `idempotency_key` (a money endpoint, like the top-up), scoped per
    vendor; too much is `422 INSUFFICIENT_BALANCE`.
  - One new account type, `PAYOUT_CLEARING`, holds requested payouts. It is opened at run time
    because a new enum value cannot be used inside the migration that adds it.
  - Reconciliation is one transaction **per order**, and a discrepancy does not fail the job.
  - The ledger code moved to a shared package instead of being copied into the worker; the API
    keeps re-export files at the old paths to avoid touching ~30 imports.
  - Approving again with the same bank reference is idempotent; with another one it is a 409
    (a recorded transfer is not silently overwritten).
  - Any vendor status may request a payout of a positive balance.

- **Phase 21:**
  - **The doorstep code stays on the order** (asked; user chose): `deliveries` has no
    `handoff_otp`. SPEC's `OrderSnapshot.delivery_otp` (bcrypt) is the single code; a second,
    plain-text code per delivery would have contradicted it.
  - **No new Socket.io namespace** (asked; user chose): riders and the rider-location push live on
    `/orders`, SPEC's namespace for order tracking. Customers need no new subscription.
  - **The Phase 11 rider routes are removed** (asked; user chose), not kept beside the new ones:
    otherwise a rider could deliver without accepting and the delivery row would mean nothing.
  - **`POST …/pickup` was added** (asked; user chose) so PICKED_UP is reachable, and complete
    requires it.
  - Added without asking because the flow needs them: the **OFFERED** state and
    **`GET /api/deliveries`**.
  - The delivery is created by the vendor's **dispatch**, in its transaction. The order is
    therefore OUT_FOR_DELIVERY before a rider accepts or picks up (the Phase 11 model, where
    dispatch is the vendor's handoff); the order state machine itself did not change.
  - `orders.driver_user_id` is set at accept (the fleet-delivered CHECK and settlement read it at
    delivery, as before).
  - Another rider's accept is `409 DELIVERY_ALREADY_ASSIGNED` (the gig was visible to them); every
    later step on someone else's delivery is `404`.
  - Positions go to Redis only (`GEOADD`), with the report time in a companion hash because zset
    members cannot expire; 120 s staleness, 1 s per-connection rate limit, 5 s push period.
  - The push is a **server timer over local rooms**, not an event relayed per report: the prompt
    asked for a periodic push, and it bounds the cost per customer whatever the rider's report rate.
  - Rider coordinates must be inside `NEPAL_BOUNDING_BOX` (SPEC §1), like every other coordinate.
  - "Rider Mode" is a `__DEV__` entry that signs out and opens sign-in, plus a mock-GPS switch on
    the rider dashboard; it does not let a customer account act as a rider.
- **Phase 20:**
  - **A `device_tokens` table**, not a column on users / vendors (the prompt allowed either): an
    account has several devices, and a vendor is reached through its user.
  - **The token is the unique key**: registering it again moves the device to the caller. One
    endpoint for every role; the account comes from the access token.
  - The prompt's `order.created` / `order.status_changed` are the existing **`order.state_changed`**
    events on `order.lifecycle`; no new event or topic was added.
  - **SPEC over simplicity: new orders and dispatches are data-only pushes** (SPEC implicit
    requirement 1, "Order Arrivals, Dispatches"; "arrival" is read as an order arriving at the
    shop, since no ARRIVED state exists). The other transitions are ordinary visible pushes. Not
    asked of the user. The app posts the visible notification for a data-only push from a
    background task, and `data_only` in the payload tells it which pushes those are.
  - **Push is best effort** (no retry, no DLQ, never throws): it shares `order.lifecycle` with
    the live tracking and the 90 s timer, which must not wait for Expo. Not asked of the user.
  - **Plain `fetch`** to `https://exp.host/--/api/v2/push/send` (the prompt), no `expo-server-sdk`;
    `EXPO_ACCESS_TOKEN` is optional.
  - "Fallback logging for SMS/IVR" = a **log line only**, and only for `SMS_PROVIDER=MOCK`: order
    pushes never send a real SMS (cost) and add no IVR call. It is logged whether or not the
    recipient has a device.
  - Dead tokens (`DeviceNotRegistered`) are deleted by the worker; receipts are not polled.
  - The permission is requested **once a session exists** (the prompt's "post-login"), because the
    endpoint needs one and a prompt before sign-in has no context.
  - The app entry became `index.ts` so the background task is defined before any UI loads.
  - Unregistering on sign-out and tap-to-open were not requested and were not built (§13).
- **Phase 19:**
  - **Local storage only (the prompt):** no S3 / R2. `UPLOADS_DIR` now defaults to `uploads/` at the
    API root (the prompt's location) instead of the OS temp directory, for dispute evidence too:
    one directory, one static mount.
  - The upload field is **`images`**, 1 to 8 files per request (the limit of `image_urls`); types
    are read from the bytes; 5 MB each, like evidence. Photos are stored **as uploaded** (no
    resizing or WebP conversion).
  - **Absolute URLs** are saved in `image_urls` (as the evidence URLs are), built from
    `UPLOADS_PUBLIC_BASE_URL`.
  - **PUT replaces the details** (like the category PUT) but **not the stock** (its own PATCH; a
    `stock_quantity` in the body is a 400, so an edit can never zero the stock by omission) and
    **not the photos unless `image_urls` is sent**. A sent list is how photos are removed or
    reordered; files of dropped photos are deleted (best effort).
  - **DELETE is a soft delete** (`is_active = false`, the prompt's "soft-deleting/hiding"): rows are
    referenced by `order_items`. It is idempotent (204). The name stays taken in that shop.
    PUT with `is_active: true` shows the product again.
  - A product may **stay** in a category the Super Admin has hidden; it cannot **move** into one.
  - Another shop's product is `404 PRODUCT_NOT_FOUND` (not 403): ids cannot be probed, as on the
    Phase 17 stock route.
  - Too many photos is `422 PRODUCT_IMAGE_LIMIT`, checked before writing and again inside the
    `UPDATE` (concurrent uploads).
  - The menu keeps `in_stock` and adds `stock_quantity` (as Phase 18 did for the public list).
  - **Vendor Portal = the existing Vite app**, chosen by the account's role at sign-in (the
    prompt). **Auth was not changed:** a vendor's refresh token still arrives in the body (the mobile
    contract), so the web keeps it in memory and a reload signs the vendor out. Not asked of the
    user; extending the cookie session to vendors would change `/api/auth` and is in the backlog.
  - The portal edits, stocks, hides and photographs existing products; **creating** a product from
    the portal was not requested and was not built (scope).
  - The upload request is a `FormData` passed to `fetch` with **no `Content-Type` header**, so the
    browser writes `multipart/form-data; boundary=…` itself.

- **Phase 18:**
  - **`GET /api/products` exposes `stock_quantity`** (not asked of the user; the prompt required
    showing it and clamping to it, and the public view had only `in_stock`). `in_stock` stays.
    Vendor menus were left as they are.
  - Discovery lives on the Home tab as a second body under a shared header, not a new tab: shops by
    default, products once a search or category is in use.
  - Pills are the **root** categories (the prompt's wording); a root includes its descendants.
  - Only the typed text is debounced (300 ms); the screen switches to "loading" at the first
    keystroke rather than showing results for older text.
  - The public endpoints are called without a token, so browsing works signed out; ordering still
    needs the feed (a session) because serviceability, fee and MOV come from it.
  - A 409 **does not lower quantities automatically**: the store records the stock, the cart
    highlights and offers "Set to N" (the prompt: "prompting the user to lower the quantity").
  - `availableStock` is nullable and defaults to null, so v2 carts and menu additions keep working.
  - Decreasing an over-stock line is always allowed; only increases are clamped.

- **Phase 16:**
  - **The role decides the transport** at `/otp/verify`: SUPER_ADMIN → cookie and no `refresh_token`
    in the body; everyone else → body, no cookie. Returning the token in the body as well would have
    kept the mobile contract for admins but left the token readable by scripts, defeating HttpOnly.
    Accepted cost: a Super Admin cannot sign in on the mobile app.
  - The prompt's `POST /api/auth/refresh` is a **new** route beside `/api/auth/token/refresh` (mobile,
    body token), not a rename. It reads the cookie only and is limited to SUPER_ADMIN accounts.
  - Its answer carries the account (with phone) so a reload needs no other call or stored profile.
  - `Secure` is unconditional (no development switch): browsers accept it on `http://localhost`.
    `Path=/api/auth`, host-only, no `__Host-` prefix (that prefix requires `Path=/`).
  - No cookie library: Express sets and clears it; one small reader parses the `Cookie` header.
  - No CSRF token: `SameSite=Strict` plus JSON answers a foreign page cannot read.
  - Logout clears the cookie and revokes nothing; rotation and a denylist stay in the backlog (not
    requested).
  - The admin client stays on `fetch` (no Axios) and signs out only after the server cleared the
    cookie.

- **Phase 15:**
  - **Retry goes through Postgres, not a Kafka client in the API:** `POST …/retry` answers 202 and the
    worker's `DeadLetterReplayer` publishes (SPEC infrastructure §1's outbox rule: a database change
    and a Kafka publish must not disagree). The prompt said "republishes the event"; it does, a moment
    later.
  - The worker writes the row **before** the Kafka DLQ copy (both kept); the row is idempotent per
    source offset. Key and value are `bytea` so a poison pill is replayed exactly.
  - A replay that fails again is a **new row** linked by `replay_of_id`; a REPLAYED row cannot be
    retried again (409).
  - "Existing vendor endpoints" had no admin list, so `GET /api/admin/vendors` was added.
  - **Admin suspension is its own kind:** new column `status_before_admin_suspension`, never lifted by
    paying dues; Restore returns to the remembered status and is refused while the wallet is below the
    limit (SPEC §5; the trigger would refuse it too). An admin may lift a debt suspension early once
    the balance is within the limit. A vendor SUSPENDED with no remembered status cannot be restored
    from the dashboard (409 RESTORE_STATUS_UNKNOWN) rather than guessing a status.
  - Overrides emit `vendor.status_overridden` (outbox) + an audit log line, not SMS.
  - Admin app: **Vite + React** (not Next.js: no server rendering needed), Jest 29 like the rest of
    the repo, plain CSS, English only, session in memory only (Phase 16: refresh token in an
    HttpOnly cookie).

- **Phase 14:**
  - "3 retries" = 1 attempt + 3 retries (4 calls), retried **in-process** with 1/2/4 s backoff, not
    counted across Kafka redeliveries (Redis counters per offset would survive a crash but add
    state; bounded blocking of one partition was preferred).
  - The dead letter keeps the original key, value and headers and adds `dlq_*` headers, instead of
    wrapping the event in a new JSON envelope, so it can be replayed unchanged.
  - Unparseable envelopes on `notifications.broadcast` now go to the DLQ (one attempt) instead of
    being logged and skipped: they are poison pills too, and the copy is kept.
  - If the DLQ publish fails, the offset is not committed (the message is redelivered) rather than
    being dropped.
  - Only the notification consumer is wrapped (the prompt's scope); `order.lifecycle` is unchanged.
  - The stale-order guard reads without a row lock and drops a missing order too; it runs on every
    retry, before any claim.
  - `IVR_PROVIDER` is `MOCK | DISABLED` with default `DISABLED` (so existing and production
    configs still parse); MOCK is refused in production like the SMS and top-up mocks. No real
    provider was added (not requested).
  - SMS and IVR each have their own Redis claim, so a retry after one channel failed does not
    repeat the other.

- **Phase 12.5:**
  - **The wallet trigger stays** (asked; user chose, SPEC §5): the application-layer `WalletService`
    runs on top of it instead of replacing it. The prompt's "migration to drop it" was not written.
  - **Restore to the previous status** (asked; user chose): SPEC has no `ACTIVE`; the status before a
    debt suspension is stored in `vendors.status_before_debt_suspension`, and only debt suspensions
    are lifted by paying.
  - **Mock top-up is dev-only** (asked; user chose): `WALLET_TOP_UP_MODE=MOCK`, refused in production,
    default `DISABLED` (503).
  - Restoration needs the balance back at **0 or more** (SPEC "until they clear the negative
    balance"), not merely above the limit as the prompt said; any credit (top-up or payout) counts.
  - "Emit to Kafka" = the transactional outbox (infrastructure §1), relayed by the worker.
  - The top-up takes an `idempotency_key` (money endpoint), scoped per vendor.
  - Vendor rows are locked `FOR NO KEY UPDATE` (API and worker sweep).

- **Phase 12:**
  - `is_suspended` is derived from SPEC's `vendors.status = 'SUSPENDED'` (no new column).
  - The reconciliation threshold is the **configured `platform_settings` limit** (SPEC: −2000,
    Super Admin configurable), with the trigger's **strictly below** rule, not the prompt's example
    "<= −1000"; the tests tighten the limit to −1000 to exercise it.
  - "Active vendors" = every vendor not already SUSPENDED (SANDBOXED/APPROVED included).
  - The sweep is a second task on the existing midnight cron queue, not a new queue.
  - `vendor.suspended_for_debt` goes to `notifications.broadcast` (no new Kafka topic to provision).
  - Pending escrow is the vendor's future share, not the gross amount held.
  - Ledger pagination is keyset on the entry id (`next_cursor`), not offset.
  - The vendor screen is a Stack route `/wallet` reached from the dashboard (the vendor group has no
    tabs).

- **Phase 11.5:**
  - The vendor's handoff reuses the rider's transaction body verbatim (`DeliveryHandoff`), not a copy,
    so the two cannot drift. One Redis counter per order, whoever types.
  - A fleet order on the vendor endpoint is `409 WRONG_FULFILLMENT_MODE` (named like
    `WRONG_PAYMENT_METHOD`), not 404: the vendor owns the order, it is just not theirs to hand over.
    It is checked before the code, so it never counts as an attempt.
  - SELF_DELIVERY orders out for delivery stay on the vendor's list (the code is typed there); fleet
    orders leave it at dispatch.
  - Phase 11's `driverDeliverRequestSchema` / `driverDeliverResponseSchema` were renamed to the
    neutral `deliveryOtpRequestSchema` / `deliveryConfirmedResponseSchema` (same shapes).

- **Phase 11:**
  - **Delivery settles escrow in the same transaction** (asked; user chose, per SPEC "Escrow
    releases"). `settleOrder` was split into `settleOrderInTransaction(tx, order)`.
  - **Riders see fleet orders that are unclaimed or theirs** (asked; user chose); delivering records
    the rider as `driver_user_id`. SELF_DELIVERY orders are not the rider's.
  - **Dispatch waits for the customer's 60 s window** (asked; user chose): `422
CANCELLATION_WINDOW_OPEN` with the seconds left.
  - Error codes: the prompt's `401 INVALID_OTP` (not the login's `OTP_INVALID`), and
    `429 DELIVERY_OTP_LOCKED`. Lockout: 5 wrong codes for one order within 15 min lock it for 15 min;
    the counter lives in Redis (SPEC: Redis for rate limiting) and is checked under the order row lock.
  - The hash is erased (`NULL`), not overwritten; a CHECK allows null only after delivery.
  - The rider's screen is `/driver/dashboard` (route collision with the vendor's `/dashboard`).
  - The mobile token refresh is limited to a 401 `UNAUTHENTICATED`.

- **Phase 10:**
  - **Early accept vs the 60 s window (asked; user chose):** a vendor may accept immediately
    (PLACED → PREPARING); the customer can still cancel a PREPARING order until `placed_at + 60 s`
    (server and app). Rejected alternatives: blocking Accept for 60 s, or letting Accept close the
    window.
  - **`expo-audio` instead of the requested `expo-av`:** `expo-av` is not available for Expo SDK 57
    (last release targets SDK 54). The prompt's `playSoundAsync`/`stopAsync` map to expo-audio's
    `play()` and `pause()` + `seekTo(0)`; tests assert those.
  - The 90 s timer is scheduled by a **worker Kafka consumer of the PLACED outbox event**, not by the
    API after commit (crash-safe), and anchored on `placed_at`.
  - The escalation is an outbox event `vendor.escalation.required` on `notifications.broadcast`
    (the prompt's name), at most once per order (checked under the order row lock, backed by a partial
    unique index). It carries the vendor's phone for the IVR/SMS consumer (the SMS half is Phase 13).
  - Reject shares the customer cancellation's transaction body (`cancelPlacedOrder`): stock back,
    refund flag + `order.canceled_refund_due` for PAID orders. Rejecting an already canceled order
    answers 200.
  - Vendors get a shop room `vendor:{id}` on `/orders` (not per-order rooms); the fan-out sends
    placed orders' updates there. The dashboard refetches on each update.
  - The app learns the role from the access token claim (unverified, UI routing only) and persists it.
  - The alarm rings while any PLACED order is unanswered; pressing either button silences it before
    the server answers; a failed answer makes it ring again.

## 13. Known gaps and risks

- **Phase 23:**
  - **Feature development is closed, the product is not launch-ready.** Nothing has run on a physical
    device, no real eSewa / Khalti sandbox session has happened, and the SPEC items listed in §8P are
    unbuilt (refunds are flagged but never paid; disputes cannot be resolved; no KYC approval).
  - The lifecycle and stress tests run against local Docker with one API process. They say nothing
    about several API instances, a managed Redis with failover, or real network latency.
  - **Under-allocation window at the claim** (§8P.2): a customer can get a `409 INSUFFICIENT_STOCK`
    for a unit that is free a few milliseconds later, and in theory the last unit of a burst can stay
    unsold. The sell-out test asserts exactly 5 orders; if it ever reports 4 with stock 1, this is why.
  - The lifecycle test's reconciliation step runs over the whole shared test database and takes
    longer as earlier suites leave more DELIVERED fixture orders behind.
  - The worker process is still handed both JWT secrets it never uses (§8P.4).
  - Migration 0020 builds its indexes without `CONCURRENTLY` (§8P.3).

- **Phase 22:**
  - **Not run live.** The endpoints, the midnight job and the two web tabs are covered by tests
    (real PostgreSQL / Redis / BullMQ on the server side, rule and wiring tests on the web side)
    but the API, worker and browser were not started for this phase.
  - **No money leaves the platform.** Approve records a reference an admin types; nothing checks it
    against a bank, and the system does not store the vendor's bank account.
  - **An approved payout cannot be undone** (no route; a wrong approval needs a manual ADJUSTMENT
    journal, for which there is no route either). A rejected one cannot be re-opened; the vendor
    requests again.
  - **Earnings can be withdrawn before they are reconciled**, and before the 48 h dispute window
    closes: a payout can empty the wallet of an order that is later disputed or refunded (no refund
    or dispute resolution flow exists yet, §13).
  - `PAYOUT_CLEARING` holds pending and approved payouts together; the pending total is the sum of
    PENDING rows. Its singleton is guarded by an advisory lock, not by a database constraint.
  - A discrepancy is only a log line: nothing alerts, lists or resolves it, and it is retried every
    night forever. Orders with a discrepancy are re-read each run (bounded by their number).
  - The reconciliation scans all unreconciled DELIVERED orders in one job; a very large backlog
    (the first run on an old database) runs long inside one BullMQ job.
  - `mismatch` compares only the vendor's posting; a wrong rider or revenue posting with a correct
    vendor posting is not detected.
  - Fixture-style orders (DELIVERED without a settlement) get their settlement at midnight, which
    for a COD self-delivery order debits the commission and can suspend the vendor then.
  - The vendor is not told when a payout is approved or rejected. The mobile app cannot request a
    payout. The lists on the Earnings tab stop at 20 rows. No minimum amount, no daily limit, no
    rate limit on requests.
  - The web vendor session is memory-only (Phase 19): a reload during a payout request loses the
    idempotency key; the request, if it reached the server, is visible after signing in again.
  - The Nepali wallet labels for the two payout entries have not been reviewed by a native speaker.
- **Phase 21:**
  - **Never run on a device, and no real GPS anywhere.** The only position source is the mock
    switch; the API and the app were tested separately (real Redis / PostgreSQL / Socket.io on the
    API side, msw + a fake socket on the app side).
  - **The customer app does not display the rider's position.** The server pushes
    `order:rider_location`; nothing on the tracking screen listens.
  - **A rider who accepts and never delivers blocks the order.** There is no un-accept, no
    reassignment, no timeout and no admin override; `FAILED` is never set.
  - **Every rider sees every open gig in the country** (no distance filter; the list is capped at
    100, oldest first, so a backlog of 100 unaccepted gigs hides newer ones).
  - A fleet order delivered before Phase 21 has no `deliveries` row; one that was on the road at
    migration time became an open gig.
  - **A rider's position is visible from accept, not from pickup,** and to the customer of every
    order that rider currently carries. Any DRIVER account can write a position (inside Nepal) at
    1 report per second per connection; several connections multiply that. Positions are not
    checked for plausibility (speed, jumps).
  - `riders:active` is never pruned; `riders:active:seen` and the geo set can disagree only
    between two MULTIs of the same rider racing (last write wins on each key).
  - The push timer runs in every API instance and queries PostgreSQL every 5 s while any order
    room has a socket in it; `lastPushed` is per instance, so a customer who reconnects to another
    instance may receive the same position once more.
  - Accept and pickup produce no event: the vendor and the customer are not told a rider is
    coming, and no push notification is sent to riders about new gigs.
  - A socket's role and identity are fixed at the handshake (as for `/orders` in general): a rider
    demoted or signed out keeps reporting until the connection drops.
  - The Nepali rider strings have not been reviewed by a native speaker.
- **Phase 20:**
  - **Never delivered to a device.** The Expo push API is mocked at `fetch` in every test and the
    app side runs against a stand-in for `expo-notifications`. FCM V1 / APNs credentials and
    `google-services.json` are not set up, so a real build cannot receive a push yet (§3).
  - **The data-only path is unverified on hardware.** How Android and iOS hand a data-only Expo
    push to the background task (`data.dataString` / `data.body`) is taken from Expo's docs and
    types. If a device shows nothing for a new order or a dispatch, look at
    `orderPushFromTaskPayload` first. Budget Android phones that kill background apps may also
    drop data-only messages (Doze, vendor battery savers); iOS throttles `content-available`
    pushes and does not deliver them to a force-quit app. **If this proves unreliable, the
    fallback is one line: send those two pushes with a title and body** (set `critical: false`
    in `orderPushes`), which contradicts SPEC implicit requirement 1 and is the user's call.
  - **Push is best effort and at most once** (§8M): an Expo or Postgres outage loses the pushes of
    the events processed meanwhile; nothing retries or dead-letters them. A slow Expo delays the
    `order.lifecycle` partition by up to 5 s per event (the fan-out for that event has already run).
  - **Push receipts are not checked.** A ticket `ok` means Expo accepted the message, not that FCM
    / APNs delivered it; tokens that only fail at the receipt stage are not cleaned up.
  - **Sign-out does not unregister the device.** The last account to register on a phone keeps
    receiving its order pushes after signing out, until another account signs in there (the token
    moves) or the app is uninstalled. On a shared phone this can show one person's order status to
    another. An authenticated `DELETE /api/notifications/device-token` called by `useSignOut` (and
    by the session-expiry path, which has no valid token left) is the fix.
  - Both sides are told of a cancellation, including the one who cancelled. Riders get no pushes.
  - Push text is English only; the Android channel name follows the app language at launch.
  - Tapping a notification only opens the app (no deep link to the order).
  - A vendor whose app is closed now gets the "New order" push, but **the looping alarm still
    rings only in the foreground**; the push plays the default sound once.
  - Any signed-in account can register any number of tokens (no per-user cap, no rate limit), and
    a token is only checked for its format, not for belonging to this Expo project.
  - With `SMS_PROVIDER=MOCK` the worker log now carries customer phone numbers (the mock SMS
    line); development only, MOCK is refused in production.
- **Phase 19:**
  - **A vendor can undo a Super Admin's Hide.** `products.is_active` is one flag: the admin's
    `PATCH /api/admin/products/:id/active` and the vendor's PUT / DELETE both write it, so a vendor
    can show again a product the admin hid (before Phase 19 vendors could not edit, so an admin
    Hide was final). A separate admin flag needs a migration.
  - Uploads live on the API host's disk (`apps/api/uploads`): not shared between instances, lost
    with the container, served without auth (unguessable names), **development only until R2**.
  - `image_urls` hold **absolute URLs with the host of the time of upload**
    (`http://localhost:4000/uploads/…` by default): a phone cannot load them unless
    `UPLOADS_PUBLIC_BASE_URL` was the LAN address when they were uploaded, and changing the base
    URL does not rewrite stored URLs.
  - Photos are stored as uploaded, up to 5 MB (no compression, resizing or WebP; SPEC
    infrastructure §6), and the mobile cards still show no images.
  - An upload request is buffered in memory (up to 8 × 5 MB) before ownership is checked; there is
    no rate limit on uploads.
  - A PUT that sends `image_urls` while another request uploads can drop the photo just uploaded
    (last write wins); its file then stays on disk. A crash between writing files and the
    `UPDATE` also leaves orphan files. Nothing sweeps orphans.
  - PUT accepts any http(s) URL in `image_urls` (as create does), not only uploaded ones.
  - A hidden product keeps its name reserved in the shop (409 on reuse) and cannot be hard-deleted.
  - Price or name edits emit no event; open carts on devices keep the old display price until the
    server re-prices at checkout.
  - **Web vendor session:** memory only, lost on reload; no `POST /api/auth/logout` call (nothing
    to clear) and no server-side revocation, as for the mobile app.
  - The portal has **no "New product" form** and no shop status / wallet view; its React screen has
    no component test (rule modules are unit-tested; the screen was run live once, §8L).
  - The mobile menu change was not run on a device (msw tests only). **A new app build against an
    API without `stock_quantity` on menus shows "Couldn't load this shop's products"**: deploy the
    API first.
- **Phase 18:** never run on a device or against the live API (msw tests only). The exact stock of
  every LIVE vendor's product is now public and unauthenticated (competitors can read it; no rate
  limit). The stock shown ignores other customers' live holds, so the picker can allow a quantity
  the Redis lock then refuses (handled by the 409 flow). After a 409 from the lock layer the stored
  `availableStock` may be lower than the real stock until the product is added again from the list
  (nothing refreshes a cart line by itself; ~~a line added from a **vendor menu** has no stock at
  all until a 409~~ **fixed in Phase 19**: the menu carries `stock_quantity`, §8L). A product whose shop is beyond the feed's 100-per-section cap looks
  undeliverable. Products of non-serviceable shops are listed, not hidden or sorted last. Only root
  categories are browsable; no images on the cards; units are vendor free text and are not
  translated. An old app build against the new API still works; **a new build against an API
  without `stock_quantity` shows "Couldn't load products"**. The Nepali discovery and stock strings
  have not been reviewed by a native speaker.
- **Phase 17:** ~~the mobile app does not call the new endpoints (no category browsing, search~~
  (Phase 18, §9.16; still no vendor catalogue screen in the mobile app); ~~a vendor can create products and set stock but cannot edit or delete a
  product, or map a pre-Phase-17 product to a category; `image_urls` are plain URLs (no upload)~~ (Phase 19, §8L);
  hiding a category does not delist its products (they remain in the unfiltered list, on menus and
  at checkout); search is prefix-AND only (no ranking, no typo tolerance, Roman and Devanagari
  spellings do not match each other); the public reads have no rate limit; an admin Hide writes no
  audit line or event and the vendor is not told; a product renamed while a client is paging by
  name can be skipped or repeated; lowering stock below a live prepaid checkout fails that order
  after payment (FAILED + PAID, refund still not flagged); the two React screens have no component
  tests (their rule modules are unit-tested, the screens were run live once).
- **Phase 12.5:** the top-up is a **mock** (no eSewa top-up initiate/callback yet; `MOCK` credits
  money that was never paid and must stay out of production); ~~`vendor.suspended_for_debt` and
  `vendor.restored` have no consumer (no SMS)~~ (Phase 13 texts the vendor); the API writes no audit log line for suspensions
  (the outbox row is the record); a journal posted outside `LedgerService` would be suspended by
  the trigger only, with no event and no restore status; ~~there is no admin route to lift or
  impose a suspension~~ (Phase 15: admin Suspend / Restore).
- **Phase 12:** a SUSPENDED vendor can still accept, dispatch and deliver orders already placed (it
  only drops out of the feed, which lists LIVE vendors); `balance_after_npr` sums the wallet's whole
  history up to each page (fine now, a stored running balance later); an entry committed late with
  an earlier `created_at` can land behind a cursor the client already passed.

- **Phases 11/11.5:** ~~no gig assignment (any fleet rider may deliver an unclaimed order and becomes
  its driver)~~ (Phase 21: a rider must accept first, §8N); riders get no live updates (pull to refresh). A locked order can be unlocked only by
  waiting 15 min (no admin override). Dispatch has no confirmation step. The Nepali driver and
  dispatch/handoff strings have not been reviewed by a native speaker.

- **No live end-to-end run** of the app against the API, and no live eSewa/Khalti sandbox session.
  The link is verified from both ends (API integration tests on real Postgres/Redis, mobile tests
  over msw with the same Zod contracts), but never together on a device. The first sandbox run should confirm
  that eSewa's real success redirect carries `data` in the form `rawQueryParam` expects.
- **Refunds are flagged, never paid:** `refund_required` + `order.canceled_refund_due` have no
  consumer, yet the app tells the customer "Escrow refund initiated"; `PAID_AFTER_SESSION_EXPIRED`
  orders are not even flagged.
- **The escalation's voice call is a mock (Phase 14):** the vendor gets an SMS after 90 s, and
  `IVR_PROVIDER=MOCK` only logs the call; production (`DISABLED`) places no call until a real
  Twilio Voice / SIP trunk adapter is written.
- **Phase 16:** the cookie session cannot be revoked (logout clears the browser's copy; no rotation,
  no `jti` denylist, 7 days fixed with no sliding window); signing out in one tab leaves other tabs
  working until their 15-min access token expires; a Super Admin can no longer sign in on the mobile
  app; the cookie is `Secure`, so the dashboard works only over HTTPS or on `http://localhost` (not
  by LAN IP over HTTP, and Safari refuses `Secure` cookies on `http://localhost`); if the API is
  unreachable at page load the sign-in screen is shown although the cookie is still valid (reload to
  retry); the React restore / sign-out wiring in `App.tsx` has no component test (verified by the
  live run only).
- **Phase 15:** ~~the admin session is lost on reload (memory only, no HTTP-only cookie yet)~~ (Phase
  16); the admin app has no production hosting (the `/api` path must be same-origin) and no component tests; the
  vendor list stops at 500; no alert fires when a dead letter arrives (it has to be looked at); a
  retry replays to a consumer whose Redis dedupe claims expire after 24 h, so a retry after a day may
  repeat a channel that had succeeded (e.g. the SMS when only the IVR call failed); the Kafka
  `notifications.dlq` copy is still written but nothing consumes it (the table is the source for the
  monitor).
- **Phase 14:** ~~nothing reads `notifications.dlq` (no alert, no replay tool)~~ (Phase 15: rows in
  `dead_letter_events`, admin monitor and replay; still no alert). A failing message
  holds its partition for ~7 s of backoff, so a long provider outage drains the backlog into the
  DLQ at about one message per 7 s per partition. The retry count restarts if the worker crashes
  mid-retries. The stale-order guard reads without a lock, so an accept landing between the read
  and the provider call can still be followed by the SMS/call. `order.lifecycle` consumers still
  have no DLQ (a permanent failure there blocks the partition).
- **The alarm only rings in the foreground.** A vendor whose app is backgrounded or killed hears
  nothing (no push, no background playback plugin); only the 90 s escalation SMS reaches them.
- **Phase 13:** notification SMS are at-most-once on a crash (the Redis claim is taken before
  sending, so a worker dying mid-send loses that SMS) and at-least-once on a provider timeout (the
  provider may have sent it before the timeout; the retry sends again). ~~A permanent provider
  failure blocks the partition~~ (Phase 14: dead-lettered after 3 retries). ~~Escalation SMS are
  not checked for staleness~~ (Phase 14: stale-order guard). SMS text is English only (the vendor's app language is
  not known on the server). A new consumer group position starts at the latest offset, so events
  written before the worker first subscribes to `notifications.broadcast` are not texted.
- **SPEC's 3-minute vendor acceptance window is not enforced:** an unanswered order stays PLACED
  indefinitely after the 90 s escalation. A SUSPENDED vendor can still accept/reject.
- **Reject has no confirmation step:** one tap cancels the customer's order.
- The dashboard lists at most 100 open orders and refetches the whole list on every update.
- The 90 s delay is computed with the worker's clock against the DB's `placed_at` (assumes NTP).
- **Checkout accepts an address outside the vendor's delivery area.**
- The device-side 60 s countdown starts when the device sees PLACED, the server's at `placed_at`;
  a device that learns of the placement late shows more time than the server allows. **Accepted by
  design** (§12): the server answers 422 and the app shows the "window has ended" toast.
- **No admin client for transcripts:** `GET /api/orders/:id/chat` serves Super Admins, but no admin
  app exists. The transcript is returned whole (no pagination).
- **Disputes are opened but never resolved:** no route sets `REFUNDED_TO_CUSTOMER` /
  `RELEASED_TO_VENDOR`, so an opened dispute keeps its chat open indefinitely.
- **Evidence lives on the API host's disk** (`os.tmpdir()/uploads`): lost on redeploy, not shared
  between instances, and served without auth (unguessable names only). Development only until R2.
- **Chat access is decided once per order per connection:** a socket that joined before the 48 h
  mark can keep posting until it reconnects.
- **Socket tokens are checked only at the handshake:** a `/orders` connection stays open after its
  15-min access token expires, until the next reconnect (then the client renews). Disconnecting at
  `exp` would close this.
- **No live run of the fan-out:** API and worker were each tested against real Redis/Kafka, and the
  API was started once to check the handshake, but a device has never received `order:state_update`.
  The worker must be running or no update is broadcast (the app still catches up on reconnect).
- **Refresh tokens cannot be revoked.** Sign-out only deletes the device copy (or, for the admin
  web, the cookie); a stolen refresh token keeps minting access tokens for up to 7 days. Rotation +
  denylist is backlog item 2.
- **Rate limiting is per phone only**: one IP can request codes for many numbers (SMS cost) and try
  codes across many numbers. Per-IP limits are backlog item 2.
- **`.env` uses Sparrow**: local sign-ins **and the worker's vendor notifications** send real SMS
  unless `SMS_PROVIDER=MOCK`.
- **Wallet top-ups are off by default** (`WALLET_TOP_UP_MODE=DISABLED`, 503); set `MOCK` locally to
  try the "Pay outstanding balance" button.
- A driver (or admin) signing in on the app gets a token for their real role and sees 403s on the
  customer screens (vendors are routed to their dashboard since Phase 10).
- The `__DEV__` token paste has no refresh token, so it lapses after 15 min (then the Feed shows its
  sign-in prompt).
- The Nepali sign-in strings have not been reviewed by a native speaker.
- An order placed on another device (or before this app version) has no device `placedAt`, so its
  cancel button never shows even inside the server's window.
- `in_stock` and `stock_quantity` on menus ignore Redis holds; the feed loads every LIVE vendor before capping at 100 per
  section (fine at current scale, needs SQL-side limiting or pagination later).
- The `order.locked` outbox write can't be atomic with Redis (the lock is released if the insert fails).
- Hot rows: every settlement locks the single SYSTEM_ESCROW and PLATFORM_REVENUE accounts.
- Tightening the wallet limit does not retroactively suspend vendors until their next posting.
- Sparrow/Aakash payloads use +977 per SPEC; the providers may expect the 10-digit national format.
- The small-cart surcharge amount is undefined in SPEC; carts below MOV are rejected.
- **Sentry, OTA updates and the Mapbox pin-drop** are not started.
