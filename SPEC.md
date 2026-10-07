This is the definitive System Architecture and Implementation Blueprint for "Hamro Pasal." This document serves as the absolute source of truth for the development agent. There are no assumptions to be made; every mechanical flow, database mutation, and edge case is strictly defined.

<tech_stack>
**Application Engine:** React Native managed via Expo (Expo Router for file-based routing). The architecture must support iOS and Android natively without ejecting to bare workflow. Prebuild and Expo Config Plugins will be used for native dependencies.
**Language:** Strict TypeScript (`"strict": true` in `tsconfig.json`, no implicit `any`).
**State Management:** Zustand for global client state (lightweight, un-opinionated).
**Data Fetching & Offline Caching:** TanStack Query (React Query) integrated with `react-native-mmkv` (by Tencent) as the synchronous persistent storage engine. This is mandatory to handle Nepal's highly volatile 4G/3G networks.
**UI Framework:** NativeWind (Tailwind for React Native) paired with React Native Reanimated for 60fps concurrent UI threads.
**Backend Protocol:** Node.js (Express or NestJS) utilizing standard REST for CRUD operations, and WebSockets (Socket.io) strictly reserved for real-time discrete driver tracking updates and in-app dispute chat.
**Database:** PostgreSQL with the **PostGIS** extension for geospatial calculations.
**In-Memory Cache:** Redis (mandatory for inventory locking and rate-limiting).
**Message Queue:** BullMQ on Redis for delayed timers, Kafka for domain event streaming.
</tech_stack>

<infrastructure_and_devops>
<!-- ========================================================================== -->
<!-- SUPPLEMENTARY ARCHITECTURE: INFRASTRUCTURE, DEVOPS, AND SERVICE EXTENSIONS -->
<!-- Source of Truth for DevOps, Background Processing, and Production Hardening -->
<!-- ========================================================================== -->

1. Backend Runtime & Micro-Services Architecture
- Framework & Language: Express 5 enforcing modular architecture, Dependency Injection, and strict class-validator DTOs for all payload ingress.
- Asynchronous Job Processing: BullMQ backed by Redis for background distributed worker queues:
  * 90-second vendor order acceptance timeouts (triggers automated IVR/SMS escalation).
  * 8-minute Ghost Customer countdown verification.
  * Midnight cron execution for scheduled vendor subscription-to-commission downgrades.
  * Push notification and third-party SMS fan-outs.
- Event Streaming: Apache Kafka for domain event streaming.
  * Node.js Kafka Client: Use `@confluentinc/kafka-javascript` instead of the deprecated `kafkajs` library.
  * Event Publishing: Transactional Outbox pattern required to guarantee atomicity between Postgres database commits and Kafka publishes.
- Real-Time Protocol Configuration:
  * Socket.io structured with discrete namespaces: `/orders` and `/chat`.
  * Horizontal clustering facilitated via `@socket.io/redis-adapter`.
  * Client reconnection strategy: Exponential backoff (1s, 2s, 4s, 8s, max 30s) with 25s ping-interval heartbeats for flaky mobile network switching.

2. Database Access & Spatial Extensions
- Relational Engine: PostgreSQL 16+ with PostGIS spatial extension.
- ORM / Query Layer: Drizzle ORM configured for strict type-safe relational schemas and native raw execution capability for:
  * Geospatial calculations using spatial indices (GiST on geometry points).
  * Concurrency locking using `SELECT ... FOR UPDATE` on order mutations and wallet transactions.

3. Cloud Infrastructure & Hosting Topology
- Container Orchestration: Dockerized container images deployed across AWS ECS (Fargate) or Google Cloud Run behind an Application Load Balancer (ALB) with SSL/TLS termination and HTTP/2 support.
- Managed Database (PostgreSQL + PostGIS): AWS RDS for PostgreSQL (Multi-AZ deployment with automated failover and daily Point-in-Time Recovery).
- Managed Cache: AWS ElastiCache for Redis (Multi-AZ with auto-failover) or Upstash Enterprise Serverless Redis.
- Object & Asset Storage: Cloudflare R2 (S3-compatible, zero-egress fee model) routed through Cloudflare CDN for fast public asset delivery (vendor catalog media, KYC document vaults, dispute evidence).

4. CI/CD & Mobile Release Pipeline
- Pipeline Orchestration: GitHub Actions automation pipeline:
  * Automated linting, strict TypeScript checks (`tsc --noEmit`), and Jest integration test passes.
  * Docker container compilation and push to Amazon ECR.
- Mobile Delivery (Expo EAS):
  * EAS Build: Automated compilation pipeline for Android App Bundles (.aab) and iOS Archive builds (.ipa).
  * EAS Update: Configured for immediate Over-The-Air (OTA) JavaScript patching to deploy hotfixes without waiting for App Store / Google Play review queues.

5. Observability, Telemetry & Logging
- Crash & Exception Tracking: Sentry unified across Expo mobile clients (capturing native Android/iOS crashes and React render exceptions) and NestJS backend processes (capturing unhandled exceptions and webhook aborts).
- Application Performance Monitoring (APM): Datadog or New Relic tracing database query latency (specifically PostGIS spatial indexing bottlenecks), Redis locking times, and external payment gateway webhooks.
- Structured Audit Logging: Winston logger outputting structured JSON streams to AWS CloudWatch / Datadog. Mandatory structured audit records for:
  * Every Escrow state transition.
  * Negative wallet commission deductions.
  * Vendor auto-suspension events.

6. Extended Local Integrations
- Voice / IVR Escalation: Twilio Voice API (or local Nepal SIP trunk) triggered via BullMQ workers to fire automated voice calls when vendors miss the 90-second alert threshold.
- Storage Optimization: `react-native-compressor` applied before transit to Cloudflare R2 (WebP format, max 1200px dimension, 75% quality cap at <300KB).
</infrastructure_and_devops>

<core_business_logic>
**1. Tenant Isolation (National Boundary Enforcement)**

* **Mechanic:** The entire platform operates in a strict multi-tenant architecture partitioned by `country_code`. Initial rollout is strictly `'NP'` (Nepal).
* **Enforcement:** Mobile numbers must pass a regex for `+977`. When fetching GPS, a reverse-geocoding API (or PostGIS polygon lookup) is called. If the `country_code` is not `'NP'`, the frontend completely arrests the app compilation, clearing the local cache, and rendering a blocking modal: "Service Unvailable in your territory."
* **Amendment (2026-10-06):** the block applies when a GPS position is obtained and is outside `'NP'`. If the user denies the location permission (or no position can be obtained), the app does not lock: it proceeds without coordinates and the user selects a location manually (Customer Flow step 0). Manually selected coordinates must still be inside Nepal.

**2. Dual-Fulfillment & Scopes**

* **Scopes:** Vendors do not just have a radius. They select a `delivery_scope` enum: `RADIUS_BOUND` (e.g., 5km), `CITY_WIDE` (matches municipality string), or `NATION_WIDE`.
* **Geospatial Logic:** If a user is at distance $D$, a vendor is serviceable if: Scope is Nation-Wide, OR (Scope is City-Wide AND customer_city = vendor_city), OR (Scope is Radius-Bound AND $D \le \text{Radius} \times 1.1$). The $1.1$ multiplier is the 10% strict GPS drift grace buffer.
* **Fulfillment Paths:** `SELF_DELIVERY` vs `PLATFORM_FLEET`.
* **Emergency Rider Override:** If a vendor on `SELF_DELIVERY` cannot fulfill an accepted order, they tap "Emergency Rider." The backend creates a ledger deduction row mapping the platform's delivery fee against the vendor's net payout, and publishes the gig to the `PLATFORM_FLEET`.
* **Delivery Modularity (amended 2026-10-07; specified, not yet implemented):**
  * **Mode:** a vendor switches its `fulfillment_mode` between `SELF_DELIVERY` and `PLATFORM_FLEET` (the platform's delivery; the Vendor App labels it "Platform delivery") from the Vendor App. A mode can be chosen only while the Super Admin has it enabled (Super Admin Flow step 4); if a vendor's mode is switched off by the Admin, the shop is not orderable until it chooses an enabled one. The switch applies to new orders at once: every order keeps the mode it was placed under (`fulfillment_locked`).
  * **Delivery charge:** under `SELF_DELIVERY` the vendor sets its own charge: a base fee (default 0), an optional per-kilometre fee (default 0) and an optional subtotal above which delivery is free. Under `PLATFORM_FLEET` the charge is the platform's, set by the Super Admin, and the vendor cannot edit it. The server computes the charge at checkout and stores it on the order; a later change never alters a placed order.
  * **Spatial scope, three tiers (one at a time, the `delivery_scope` enum above):**
    * **Radius** (`RADIUS_BOUND`): `radius_km` is the vendor's maximum radius, with the 10% buffer.
    * **City / Regional** (`CITY_WIDE`): the vendor lists the municipalities it serves in `serviceable_palikas` (Palika names from the Address System, never free text or ZIP codes; its own Palika is always included). A customer is serviceable when their Palika is in the list.
    * **National** (`NATION_WIDE`): the shop is serviceable to every address in Nepal (Dharan to Nepalgunj) and no radius applies. Contracts that need a flag expose it as the derived boolean `is_national`.

**3. Inventory Management (The 10-Minute Lock)**

* **Trigger:** Customer taps "Proceed to Checkout" (loading payment screen).
* **Execution:** Backend executes a Redis transaction locking the requested SKU quantities with a strict `TTL` of 600 seconds (10 minutes).
* **Resolution:**
* If Webhook/COD confirms within 600s: PostgreSQL permanent decrement executes, Redis lock is deleted.
* If TTL expires: Redis automatically evicts the lock. Frontend checkout session invalidates, returning user to cart with "Session Expired" error.



**4. Vendor Pricing & Lock-Ins**

* **Platform Fee Model:** Flat % commission per transaction automatically deducted at settlement.
* **Subscription Model:** 0% commission. Vendor pays flat monthly fee upfront.
* **Lock-in Logic:** Upon subscription payment, backend stamps `lock_in_expiry = NOW() + 90 days`. If a downgrade to Platform Fee is requested, the backend validates `NOW() > lock_in_expiry`. If valid, it defers execution by setting `scheduled_downgrade = true` and only changes the model at the end of the current paid billing cycle via a midnight cron job.
* **Dual-Layer Billing (amended 2026-10-07; specified, not yet implemented):** a vendor's charges have two layers that are never merged. **Layer 1, base enrollment:** the commission per order or the monthly subscription above. **Layer 2, premium add-ons:** sponsored placements the vendor bought itself in the Ad Marketplace (Ad Monetization, section 8). Every statement, ledger line and settlement shows the two layers as separate items.
* **Onboarding Models (amended 2026-10-07; specified, not yet implemented):** the Super Admin publishes the pricing plans a vendor may choose from. A plan is `FREE` (0% commission and no fee, for the number of Billing Cycles the plan states), `SUBSCRIPTION` or `COMMISSION`, with its rate or monthly fee. A vendor can only select a plan that is currently offered. One Commission plan is marked as the default.
* **End of a Free plan (decided 2026-10-07):** when a `FREE` plan expires, the vendor reverts automatically to the default Commission plan at that Billing Cycle renewal, unless it queued another plan itself. Its settlement model does not change (`PLATFORM_ESCROW` by default). A queued notification (SMS and push) is sent 7 days before the expiry.
* **Billing Cycle Lock (amended 2026-10-07; specified, not yet implemented):** every LIVE vendor has a Billing Cycle, which is the **BS (Bikram Sambat) calendar month**: the 1st to the last day (29th to 32nd) of the Nepali month, in `Asia/Kathmandu`, renewed by the midnight cron job (decided 2026-10-07; required for IRD tax reconciliation). A vendor that goes LIVE mid-month has a prorated first cycle that ends on the last day of that BS month, and a monthly fee for it is charged strictly in proportion to the days left (confirmed 2026-10-07): fee × days left ÷ days in that BS month, half-up to the paisa. A vendor may ask to change its pricing plan or the payment methods it accepts at any time, but the backend only **queues** the change with `effective_from` = the end of the current cycle. Nothing changes mid-cycle: the vendor's active plan, commission rate and accepted payment methods are constant for a whole cycle, so every order and settlement of a cycle is accounted under one set of terms.
  * A queued change can be replaced or withdrawn until the cycle renews. At renewal the job applies it, in one transaction with the start of the new cycle, and writes an audit row.
  * This generalises the deferred downgrade above: a downgrade from Subscription still requires `NOW() > lock_in_expiry` when it is requested, and is then one more queued change (the `scheduled_downgrade` flag is replaced by the queue).
  * The payment methods a vendor accepts can only narrow what its settlement model allows (Checkout and Cart Math Protocol, Payment routing), never widen it, and at least one method must remain.
  * Orders already placed are unaffected: each order holds its own commission, payment method and settlement model.

**5. Financial Governance & Negative Wallets**

* **Escrow:** All upfront payments land in a central platform ledger. Escrow splits into `vendor_wallet`, `driver_wallet`, and `platform_revenue` only *after* the `DELIVERED` state.
* **The COD Problem:** On a COD Self-Delivery order, the vendor collects 100% cash, including the platform's commission.
* **Enforcement:** The backend automatically debits the `vendor_wallet` for the commission amount, pushing it into the negative. If `vendor_wallet < -2000 NPR` (Superadmin configurable limit), a database trigger automatically mutates the vendor's status to `SUSPENDED`. The vendor's app locks until they clear the negative balance via an upfront eSewa payment.
* **Ledger Model:** True double-entry accounting with balanced postings. Single-entry wallet tables are prohibited; `vendor.wallet_balance_npr` is a materialized projection.
* **Vendor Ledger and Settlement Models (amended 2026-10-07; specified, not yet implemented):** every vendor has one `vendor_ledgers` row: its `settlement_model`, its limits, and the vendor's balances as **projections of the double-entry journal** (balance, commission owed, ad fees owed, ad budget held). Nothing writes those balances directly; only postings move them. A vendor operates under exactly one model at a time. **Decided 2026-10-07: Models A and B are the Phase 1 / Phase 2 targets. Model C is deferred to Phase 3 and cannot be selected until then.**
  * **Model A, `COD_CREDIT` (credit limit):** the shop takes cash only. The customer pays the vendor or the rider; each order debits the ledger for the platform commission and any per-order fee, so the balance runs negative. Strictly below the limit (-2000 NPR, Superadmin configurable) the shop is suspended automatically and stays so until the vendor recharges the ledger through eSewa or Khalti.
  * **Model B, `PLATFORM_ESCROW` (default):** the customer pays the platform digitally. The platform holds the money, deducts commission, subscription fees and ad costs at settlement, and credits the remainder to the ledger for periodic payout. Refunds are paid out of the escrowed funds. Cash orders of a Model B shop follow the credit rule of Model A.
  * **Model C, `DIRECT_PREPAID` (prepaid) — Phase 3, deferred:** the customer's digital payment goes straight to the vendor's own eSewa / Khalti merchant account. The platform holds none of it, so the vendor must keep a **prepaid** ledger balance with a strict **Fixed Reserve** (minimum 5000 NPR, Superadmin configurable). Every platform fee is debited the moment the order is placed. The balance may never be drawn below the reserve by trading: a shop whose balance falls below it is suspended until it recharges back to the reserve or more. A refund is paid to the customer by the platform and debited from the prepaid balance, which is what the reserve exists to cover. It is deferred because it depends on eSewa's and Khalti's merchant terms allowing the platform to operate a vendor's credentials, and on that refund exposure; it is not to be built or offered before both are settled.
  * "Suspended" is the existing `status = 'SUSPENDED'` in every model (the shop is not active: hidden from the feed, not orderable); no separate `is_active` flag exists on vendors.
  * A change of settlement model is requested by the vendor, approved by a Super Admin, audited, and takes effect only when the shop has no open order and its ledger is at 0 or above.

**6. Double-Blind Review System & Disputes**

* **Review Logic:** Customer and Vendor ratings are quarantined in the DB (`is_published = false`). They are published only when both exist OR 48 hours elapse.
* **Penalties:** If Customer average rating $< 3.0$, their COD capability is disabled globally. If Vendor Acceptance Rate $< 85\%$, their sorting weight in the geospatial feed algorithm is penalized.

**7. Discounts: Vendor Offers and Platform Campaigns (added 2026-10-07; specified, not yet implemented)**

* **Principle:** a vendor can never be charged for a discount it did not switch on itself. Every discount deducted from a vendor's payout traces to a record that vendor's own account created, with the time and the user.
* **Vendor Offers (`vendor_offers`):** created by the vendor for its own shop. A rule is `FLAT` (an amount off) or `PERCENTAGE` (a share off, with an optional cap), with a minimum cart subtotal and a validity period. The vendor funds it entirely. A rule is never edited: changing it ends the old row and creates a new one, so an order always points at the exact rule it was priced with.
* **Platform Campaigns (`platform_campaigns`):** created by a Super Admin, with the discount rule and the share of each discount the vendor bears (`vendor_share_percent`, 0 to 100; the platform funds the rest). **An admin cannot enrol a shop.** A campaign applies to a shop only through a `campaign_opt_ins` row created by that vendor's own account from the Vendor App, which stores the terms exactly as they were shown. Opting out stops future orders only.
* **Stacking:** at most one vendor offer and one platform campaign per order; when several qualify, the one giving the customer the larger discount is taken in each layer. The campaign discount is calculated on the subtotal after the vendor offer. Discounts never reduce the delivery fee and never make the goods cost less than 0.
* **Audit (`audit_logs`):** an append-only table. Creating, enabling or ending an offer, opting into or out of a campaign, buying or cancelling an ad, and requesting or approving a settlement model change each write one row in the same database transaction as the change: the exact timestamp, the acting `user_id` and role, the vendor, and the state before and after. Rows are never updated or deleted.

**8. Ad Monetization (added 2026-10-07; specified, not yet implemented)**

* **Sponsored placements** are slides of the Home carousel, tiles of Featured Offers, and sponsored listings in the vendor feed. They are premium add-ons on top of base enrollment (Vendor Pricing, Dual-Layer Billing). Every sponsored placement is labelled "Ad" to the customer.
* **No unilateral billing:** an admin cannot charge a vendor for an ad. A promotion may carry `is_sponsored = true` only when it is linked to an `ad_purchases` row, and that row exists only because the vendor chose a product in the **Ad Marketplace** of the Vendor App and agreed to its price and `billing_model`. The database refuses a sponsored promotion without a purchase.
* **Billing models:** `FLAT_RATE` (a fixed price for the booked period, charged once) or `PER_ORDER_PREMIUM` (a fixed fee for each delivered order placed while the ad runs, up to the budget the vendor set).
* **Collection by settlement model:**
  * **Models A and C:** the vendor must first recharge its ledger. A `FLAT_RATE` price, or the whole budget of a `PER_ORDER_PREMIUM` ad, is taken from the ledger balance at purchase and refused if the balance does not cover it (and, in Model A, never on credit). Per-order fees are drawn from the held budget; the ad pauses when the budget is used up, and what is left when the ad ends is returned.
  * **Model B:** no recharge is needed. The charge is taken from the vendor's available balance, and whatever that does not cover is deducted from the vendor's pending payouts as orders settle. Per-order fees are deducted in each order's settlement. **Guard rail (decided 2026-10-07):** a `FLAT_RATE` ad is refused when `balance + pending_escrow < ad_price`; the platform never sells an ad for more than it already holds for that vendor.
* **Itemisation:** ad charges are their own ledger line types (`AD_FLAT_FEE`, `AD_ORDER_PREMIUM`) posted to their own revenue account, never added into the commission.
* **Sponsored feed listings (decided 2026-10-07):** up to **two** sponsored shops are placed at the top of the main vendor feed, above the distance order, each marked with the "Ad" badge. Only shops that deliver to the customer are eligible, so a sponsored listing never overrides delivery rules and never appears in "Explore Further". Among more than two eligible sponsored shops, the nearest two are shown; the rest keep their normal place.

**9. Checkout and Cart Math Protocol (added 2026-10-07; specified, not yet implemented)**

* **The server prices the order.** `POST /api/cart/checkout` computes, from database prices and the rules above:
  $\text{total} = \text{subtotal} - \text{vendor\_offer\_discount} - \text{platform\_promo\_discount} + \text{delivery\_fee}$.
  The client sends product ids and quantities only; any amount it sends is ignored.
* **Minimum order value** is checked against the subtotal before discounts.
* **Commission base:** the commission is charged on what the vendor actually sells for: $\text{subtotal} - \text{vendor\_offer\_discount} - \text{vendor share of the campaign discount}$. The platform's share of a campaign discount is the platform's marketing cost and is not taken from the vendor.
* **Snapshot:** the order stores each discount amount, the vendor's and the platform's share, the ids of the offer, the campaign and the opt-in, and a copy of each rule as applied. Settlement reads only the snapshot.
* **Payment token:** for eSewa and Khalti the backend creates the payment request (the eSewa signed form, the Khalti `pidx`) **for the final discounted total, inside the checkout request, before it answers**. The amount the gateway later confirms must equal that total ($\pm 0.01$ NPR).
* **Payment routing:** the payment methods a customer may use are decided by the server from the vendor's settlement model and ledger, and from the customer's COD eligibility. Model A: cash only. Model B: eSewa, Khalti and cash. Model C (Phase 3): cash and eSewa / Khalti, each only while the prepaid balance after this order's platform fees stays at or above the Fixed Reserve. The cart shows only the methods the server returned, and checkout refuses any other.
* **Model C credentials (Phase 3):** the payment request is created and verified with the vendor's own merchant credentials, which the platform stores encrypted.

**10. Fiscal Invoicing (IRD compliance; added 2026-10-07; specified, not yet implemented)**

* **Who issues it:** the vendor is the seller. The platform generates the invoice on the vendor's behalf, in the same database transaction that moves the order to `DELIVERED`, so a delivered order always has exactly one invoice and an undelivered one has none. Every invoice carries the disclaimer "Generated via Hamro Pasal on behalf of the seller."
* **Tax identity:** a vendor records its 9-digit PAN and whether it is VAT registered (and its legal name, registered address and contact number for the invoice header). The invoice stores a copy of these as they were at issue.
* **PAN is mandatory (decided 2026-10-07):** no vendor is `LIVE` without a PAN. An existing LIVE vendor that has none is moved automatically to `SUSPENDED_COMPLIANCE`: hidden from customers and not orderable, like any shop that is not LIVE. It returns to its previous status in the same transaction that stores the PAN it uploads from the Vendor App. This status is separate from `SUSPENDED` (debt, or an admin): paying dues never lifts a compliance suspension and a PAN never lifts a debt suspension. Orders it had already accepted are completed; their invoices are issued when the PAN arrives.
* **Header:** vendor name, address, contact, PAN / VAT number, the disclaimer, and the buyer's name (and PAN, when the buyer gives one).
* **Metadata:** the Nepal fiscal year (आर्थिक वर्ष, e.g. `2082/083`; it starts on 1 Shrawan), the Bill Number (बिजक नम्बर), the transaction date and time in both AD and BS (Bikram Sambat), and the payment method.
* **Bill Number:** a strict sequence per vendor, per fiscal year and per document type, starting at 1, **with no gaps and no reuse**. It is taken from a counter row locked inside the issuing transaction (never a database sequence, which leaves gaps on rollback).
* **Itemised table:** per line: product name, HS Code (required for imported goods, else empty), quantity, unit price, taxable amount, VAT rate and VAT amount.
* **VAT:** catalogue prices are what the customer pays (VAT inclusive). For a VAT-registered vendor each taxable line is split into taxable amount and **13% VAT**, shown explicitly; exempt products are listed with 0. A vendor that is not VAT registered issues a PAN invoice with no VAT lines. The invoice never changes what the customer pays (Checkout and Cart Math Protocol).
* **Discounts (decided 2026-10-07):** every discount on the order lowers the taxable amount: the vendor offer and the whole campaign discount, the platform-funded share included.
* **Totals:** subtotal, discount, taxable amount, VAT, delivery charge, grand total, and the amount in words. **The Grand Total must equal, to the paisa, the total the customer actually paid (the order total).**
* **Immutability:** an issued invoice and its lines are never updated or deleted; the database refuses both. Any correction or post-delivery refund is a new **Credit Note** or **Debit Note** that references the original invoice, has its own gap-free sequence, and is itself immutable.
* **View and print tracking:** every view, download and print is logged with the user and the time. The first print is the original; every later one is marked "Copy of Original" with its copy number.
* **CBMS:** the invoice table holds the fields the IRD's Central Billing Monitoring System takes (seller PAN, buyer PAN and name, fiscal year, invoice number, date in BS, total, taxable, VAT, exempt and export amounts, real-time flag) and a sync status, so a later integration posts existing rows without a schema change. No CBMS call is made in this phase (confirmed 2026-10-07: the handshake with the IRD is a later phase).
* **Scope:** this section covers the vendor's invoice to the customer. The platform's own invoices to vendors (commission, subscription, ad fees) are not specified yet.
</core_business_logic>

<user_journeys>
**Customer Flow**

0. **App boot sequence (amended 2026-10-06):** Splash screen (logo placeholder, tagline "Hamro pasal sajilo cha hai") -> full-screen Login/Signup page with a "Skip login" button, over which the native location permission prompt appears (only if the app may still ask; a visitor who is already signed in or already skipped the login is prompted right after the splash instead) -> Home.
   * **Location allowed:** the coordinates are stored in the global client store; the 'NP' check of Tenant Isolation runs on them, and Home lists shops around them.
   * **Location denied or unavailable:** the app proceeds without coordinates. The "Select delivery location" selector opens at once ("Device location not enabled" banner with an Enable action, live place search, map pin, saved addresses); a location chosen there takes the visitor to Home as a Guest. Home shows "Select Location" while none is chosen.
   * **Skip login:** the visitor enters Home as a Guest and may browse shops and fill a local cart. Sign-in is required only at checkout.
1. Auth via OTP (+977 only). Required to check out, not to browse. After the first sign-in the customer completes a profile: `full_name` is required before an order can be placed, `email` is optional.
2. App requests GPS (step 0). PostGIS validates 'NP' polygon.
3. Feed compiles using geospatial radius + 10% buffer. Unserviceable vendors render in a desaturated "Explore Further" section with carts disabled. **(Amended 2026-10-07, not yet implemented):** up to two sponsored shops that deliver to the customer are listed first, each with an "Ad" badge (Ad Monetization). The feed is evaluated from, in order: a location the customer selected manually in the Home header, the device GPS position, the selected delivery address.
4. User adds to cart. System enforces single-vendor cart restriction.
5. Cart validates `total >= vendor.MOV` (Minimum Order Value). Applies Cart validates total >= vendor.MOV. Rejects with HTTP 422 if below.
6. Before checkout, the delivery address must be inside the vendor's delivery scope (Dual-Fulfillment & Scopes: radius with the 10% buffer, city-wide Palika match, or nation-wide). If it is not, checkout is blocked with "This shop does not deliver to your selected address" and a "Change Address" action. Checkout then triggers Redis 10-min inventory lock.
7. Payment selection evaluates COD eligibility based on customer rating. **(Amended 2026-10-07, not yet implemented):** the methods offered also depend on the vendor's settlement model and ledger; the cart shows the discounts the server calculated (vendor offer, platform promotion) as separate lines, and the customer pays the discounted total (Checkout and Cart Math Protocol).
8. Unskippable 60-second cancellation window starts post-order.
9. Order tracking utilizes a **Discrete State Node** UI (Order Placed -> Preparing -> Out for Delivery -> Arrived) rather than live map polling to save API costs.
10. Customer displays 4-digit cryptographic OTP to driver upon handoff.
11. Double-blind review prompted. 48hr window opens to initiate dispute chat.
12. **(Added 2026-10-07, not yet implemented.)** The customer can open the order's invoice once it is delivered (Fiscal Invoicing); each view is logged.

**Vendor Flow**

1. Auth via OTP (+977).
2. Onboarding: Upload PAN/VAT and citizenship docs. State = `SANDBOXED`.
3. Configure `delivery_scope`, base delivery fees, MOV, and map SKUs to Admin Taxonomy.
4. Admin verifies. State = `APPROVED`.
5. Vendor selects Pricing Model (Subscription vs Commission). State = `LIVE`.
6. Incoming order triggers high-priority audio alarm. 3-minute acceptance window begins. (If 90s elapse with no app interaction, backend triggers an automated IVR/SMS alert).
7. Vendor inspects order. Can select "Accept with Modifications" (Partial Fulfillment) to remove out-of-stock items, adjusting the snapshot and triggering an automated partial refund via gateway API.
8. Vendor packs order. If Platform Fleet, waits for driver. If Self-Delivery, dispatches own staff.
9. Collects COD cash (driving platform wallet negative) or verifies OTP.
10. **Marketing tab (added 2026-10-07, not yet implemented).** The Vendor App has a "Marketing" tab with two clearly separated sections:
    * **My Offers:** the vendor's own offers. Create (flat or percentage, minimum cart, validity), switch off, and see past ones. The screen states that the vendor funds these discounts.
    * **Campaign Invites:** the platform campaigns open to the shop, each with its discount, dates and the share the vendor would bear, and an explicit **Opt in** action with a confirmation that restates those terms. Nothing here is on by default. Joined campaigns show the date and the account that joined, with **Opt out**.
11. **Ad Marketplace (added 2026-10-07, not yet implemented).** Reached from Marketing: the sponsored placements on sale, with price and billing model. Buying one shows the full cost, how it will be collected under the shop's settlement model (recharge first, or deducted from payouts), and requires an explicit agreement.
12. **Ledger (amended 2026-10-07, not yet implemented).** The wallet screen shows the settlement model, the balance, and separate lines for commission, subscription, ad fees, discounts and refunds; Models A and C have a **Recharge** action (eSewa / Khalti).
13. **App navigation (added 2026-10-07).** The Vendor App has four persistent tabs: **Live Orders** (home), **Catalogue**, **Ledger** (wallet, finances and invoices) and **Marketing** (offers, campaigns, ads). Every header carries the shop's **Online / Offline** switch and the way into **Shop settings**. Live Orders is a board with four columns, shown one at a time: **New** (`PLACED`), **Preparing** (`PREPARING`), **Ready** (`OUT_FOR_DELIVERY` and still in the shop) and **Handed Over**. "Ready for Pickup" on a Preparing order dispatches it, for either fulfilment mode. The button is disabled, with a countdown, until the customer's 60-second cancellation window has closed (decided 2026-10-07: a guard in the app, no new order state; the server still refuses an early dispatch). The shop's own delivery then waits under Ready for the customer's code; a platform fleet order waits under Ready for its rider (the dispatch notifies the riders) and moves to Handed Over when the rider confirms the pickup (decided 2026-10-07). A delivered order is Handed Over. The columns are a view: no order state is added. The shop sees the customer's first name only (decided 2026-10-07).
14. **Delivery and scope settings (added 2026-10-07, not yet implemented).** The vendor switches between self delivery and platform delivery (only modes the Admin has enabled), sets its own delivery charge under self delivery, and chooses one scope tier: radius, a list of municipalities, or national (Delivery Modularity).
15. **Queued billing changes (added 2026-10-07, not yet implemented).** The vendor may choose another pricing plan or change the payment methods it accepts at any time. The app shows the change as "Scheduled", with the date it takes effect (the next Billing Cycle renewal), and lets the vendor withdraw it until then (Billing Cycle Lock).
16. **Invoices (added 2026-10-07, not yet implemented).** Under Ledger: the shop's invoices and credit / debit notes by fiscal year, with view and print. A reprint is marked as a copy (Fiscal Invoicing).
17. **Online / Offline (added 2026-10-07, not yet implemented on the server).** The vendor can stop taking new orders at any time. An Offline shop stays in the feed, marked closed and not orderable (`422 VENDOR_UNAVAILABLE` at checkout); orders already placed are unaffected. It is the vendor's own switch and never changes the shop's `status`.
18. **Tax identity (added 2026-10-07, not yet implemented on the server).** The vendor enters its PAN in Shop settings. A shop suspended for compliance sees why, and is restored when the PAN is saved.
19. **Catalogue (added 2026-10-07).** The Catalogue tab lists the shop's products, each with an "In Stock / Out of Stock" switch on its row, and a form to add or edit one (name, price, category from the Admin Taxonomy, stock quantity, photos). "Out of Stock" sets an availability flag on the product (default on) and never changes the stock count (decided 2026-10-07): the product stays listed, shown as out of stock and not orderable, until the vendor switches it back. This is separate from hiding a product, which removes it from the catalogue.
20. **Ledger by settlement model (added 2026-10-07).** The Ledger shows the shop's money as its settlement model defines it. Model A: the credit balance and how much of the credit limit (-2000 NPR) is used. Model B: pending escrow and the amount available for payout. Model C (Phase 3): the active reserve balance against the Fixed Reserve.
21. **Marketing screens (added 2026-10-07; the screens exist, the backend does not).** The Marketing tab has three sections. **My Offers:** the running vendor-funded offers and a form for a new one (discount type, amount, minimum order). **Campaigns:** the invites, each with its terms and an Opt In that asks the vendor to accept those terms. **Ads:** the placements on sale; a purchase the shop cannot pay for under its settlement model is refused before any agreement is asked ("Insufficient funds for this ad purchase.").
22. **Analytics (added 2026-10-07, not yet implemented on the server).** Today's sales, the best-selling item, the return on the shop's ads, and the last seven days of sales.
23. **Vendor account (added 2026-10-07, not yet implemented on the server).** In Shop settings: the app language, the WhatsApp updates consent, and "Delete Shop Account". A shop with a negative ledger balance or an order not yet handed over cannot be deleted; otherwise the vendor confirms, the account is marked for deletion (a soft delete: invoices and financial records are kept) and the shop stops taking orders. The vendor can withdraw the request until the data is purged.

**Delivery Partner (Platform Fleet) Flow**

1. Receives geospatial gig broadcast. Taps Accept.
2. Navigates to Vendor, verifies order ID, taps "Picked Up."
3. Navigates to Customer, taps "Reached Location."
4. **The Ghost Timer:** If customer is missing, rider taps "Unable to Contact". This triggers an unskippable 8-minute server-side countdown. Backend fires automated IVR/Push notifications to customer. If timer hits zero, rider taps "Delivery Failed."
5. If customer is present, rider collects COD (adding to their own negative float ledger) and enters Customer's 4-digit OTP. Escrow releases.

**Super Admin Flow**

1. Verifies KYC uploads against national registries.
2. Manages immutable Master Category Taxonomy.
3. Arbitrates Disputes: Reviews in-app text/photo chat transcript. Clicks "Refund Customer" (API call to eSewa/Khalti) or "Release to Vendor" (Unfreezes Escrow).
4. Toggles platform logistics (Enable/Disable Self-Delivery or 3rd Party Fleet).
5. **(Added 2026-10-07, not yet implemented.)** Creates platform campaigns and invites shops; cannot enrol a shop. Publishes the Ad Marketplace products and their prices; cannot create a sponsored promotion or an ad charge without the vendor's purchase.
6. **(Added 2026-10-07, not yet implemented.)** Approves settlement model changes and reads the audit log.
7. **(Added 2026-10-07, not yet implemented.)** Publishes the pricing plans vendors may choose (Free, Subscription, Commission) and the platform delivery charge. Reads every invoice; cannot edit or delete one, and issues a Credit / Debit Note like anyone else when a correction is needed.
</user_journeys>

<nepal_localizations_and_integrations>
**1. eSewa Payment Integration (ePay v2)**

* **Architecture:** Use React Native WebView as a fallback, but prefer App-to-App deep linking via Intents if the eSewa app is installed.
* **Signature Generation (CRITICAL):** The backend MUST generate the `signature` using HMAC-SHA256.
* Formula: `Message = "total_amount,transaction_uuid,product_code"`
* Hash the `Message` using the eSewa `Secret_Key`.
* Convert the resulting hash strictly to a `Base64` string.


* **Validation:** Upon redirect, backend must verify the signature, verify `status === 'COMPLETE'`, and check that `total_amount` matches the DB snapshot ($\pm 0.01$ NPR tolerance).
* **Amount (amended 2026-10-07, not yet implemented):** `total_amount` is the order's final discounted total (Checkout and Cart Math Protocol), and the signed form is produced inside the checkout request. For a Model C vendor the `product_code` and `Secret_Key` are that vendor's own. The same applies to the Khalti `amount` and key.

**2. Khalti Payment Integration (ePay v2 Web Checkout)**

* **Initiate:** Backend POST to `[https://a.khalti.com/api/v2/epayment/initiate/](https://a.khalti.com/api/v2/epayment/initiate/)` with header `Authorization: Key <secret_key>`. Payload includes `return_url`, `amount` (in Paisa, meaning NPR $\times$ 100), `purchase_order_id`.
* **Response:** Extract `pidx` and `payment_url`. Frontend opens `payment_url` in WebBrowser.
* **Lookup/Verify:** On callback to `return_url`, backend MUST call POST `/api/v2/epayment/lookup/` with the `pidx`. Only if status is `Completed` does the escrow trigger.

**3. Address System & Hierarchy**

* Western ZIP codes are invalid.
* **Schema Fields:** `province_id` (1-7), `district_string`, `municipality_palika_string`, `ward_number` (Int), `tole_locality` (String), `landmark` (String), `exact_lat`, `exact_lng`.
* **Maps:** Integrate Mapbox (or Google Maps) for a "Drop a Pin" interface to capture precise `exact_lat`/`exact_lng`, converting to PostGIS geometry type.

**4. SMS/OTP**

* Integrate Sparrow SMS, Aakash SMS, or Firebase Auth. All payloads must prepend `+977`.
* **WhatsApp fallback (amended 2026-10-06):** the OTP entry screen offers "Get OTP via WhatsApp". The client then calls `POST /api/auth/otp/send` with `{ "phone": "+977…", "channel": "WHATSAPP" }` (`channel` is optional and defaults to `"SMS"`), and the backend delivers the same 6-digit code through a WhatsApp Business provider instead of SMS. The code rules are unchanged (single use, 2-minute expiry, 60-second resend cooldown per number, shared by both channels).

**5. Fiscal Calendar & IRD Invoicing (added 2026-10-07; specified, not yet implemented)**

* **Bikram Sambat:** BS dates are converted from AD with a month-length lookup table (BS months have no formula), in `Asia/Kathmandu`. An invoice stores its BS date as text at issue and never re-derives it.
* **Fiscal year:** runs from 1 Shrawan to the last day of Ashadh and is written `YYYY/YYY` (e.g. `2082/083`). Bill Numbers restart at 1 in each fiscal year.
* **Tax IDs:** PAN is 9 digits. A VAT-registered seller's VAT number is its PAN. Standard VAT is 13%.
* **Amount in words:** uses the Nepali grouping (thousand, lakh, crore), e.g. "Rupees One Lakh Two Thousand Five Hundred and Paisa Fifty Only".
* **Bilingual labels:** the invoice shows the IRD's Nepali field names beside the English ones (आर्थिक वर्ष, बिजक नम्बर, मिति), and Devanagari numerals under the `ne` locale.
* **CBMS:** integration with the IRD's Central Billing Monitoring System is deferred; the schema is kept compatible (Fiscal Invoicing).
</nepal_localizations_and_integrations>

<data_models_and_schemas>
Implement using strict TypeScript interfaces mapping to PostgreSQL schemas.

```typescript
enum DeliveryScope { RADIUS_BOUND, CITY_WIDE, NATION_WIDE }
enum FulfillmentMode { SELF_DELIVERY, PLATFORM_FLEET, EMERGENCY_FLEET }
enum OrderState { PENDING_PAYMENT, PLACED, PREPARING, OUT_FOR_DELIVERY, DELIVERED, CANCELED, FAILED, DISPUTED }
// Added 2026-10-07 (specified, not yet implemented):
enum SettlementModel { COD_CREDIT, PLATFORM_ESCROW, DIRECT_PREPAID } // Models A, B, C (C: Phase 3, not selectable yet)
enum DiscountKind { FLAT, PERCENTAGE }
enum AdBillingModel { FLAT_RATE, PER_ORDER_PREMIUM }

interface Vendor {
  id: string;
  phone: string; // +977 format
  status: 'SANDBOXED' | 'APPROVED' | 'LIVE' | 'SUSPENDED' | 'SUSPENDED_COMPLIANCE'; // SUSPENDED_COMPLIANCE added 2026-10-07: LIVE without a PAN
  pricing_model: 'SUBSCRIPTION' | 'COMMISSION';
  lock_in_expiry: Date | null;
  commission_rate: number;
  delivery_scope: DeliveryScope;
  radius_km: number;
  municipality_palika_string: string;
  min_order_value: number;
  location: any; // PostGIS Point (Lat/Lng)
  wallet_balance_npr: number;
  fulfillment_mode: FulfillmentMode;
  settlement_model: SettlementModel; // added 2026-10-07; existing vendors are PLATFORM_ESCROW
  // Added 2026-10-07 (specified, not yet implemented): delivery, billing cycle, tax identity.
  // pricing_model also gains 'FREE'.
  serviceable_palikas: string[];           // CITY_WIDE tier; always includes municipality_palika_string
  delivery_fee_per_km_npr: number;         // SELF_DELIVERY only, default 0 (the base fee also defaults to 0)
  free_delivery_above_npr: number | null;  // SELF_DELIVERY only
  accepted_payment_methods: ('ESEWA' | 'KHALTI' | 'COD')[];
  billing_cycle_started_at: Date | null;   // null until LIVE
  billing_cycle_ends_at: Date | null;      // the 1st of the next BS month; queued changes take effect here
  accepting_orders: boolean;               // the vendor's Online / Offline switch, default true
  legal_name: string | null;
  tax_id: string | null;                   // 9-digit PAN; mandatory: LIVE without it becomes SUSPENDED_COMPLIANCE
  is_vat_registered: boolean;
}

// Added 2026-10-07 (specified, not yet implemented). A change waits for the cycle to renew.
interface QueuedSettingChange {
  id: string;
  vendor_id: string;
  setting: 'PRICING_PLAN' | 'PAYMENT_METHODS';
  requested_value: unknown;                // the plan id, or the list of methods
  status: 'PENDING' | 'APPLIED' | 'WITHDRAWN' | 'SUPERSEDED';
  requested_by_user_id: string;
  requested_at: Date;
  effective_from: Date;                    // = billing_cycle_ends_at when requested
  applied_at: Date | null;
}

// Added 2026-10-07 (specified, not yet implemented). Immutable once issued.
interface Invoice {
  id: string;
  document_type: 'INVOICE' | 'CREDIT_NOTE' | 'DEBIT_NOTE';
  vendor_id: string;
  order_id: string;
  reference_invoice_id: string | null;     // notes only: the invoice they correct
  fiscal_year: string;                     // "2082/083"
  bill_number: number;                     // gap-free per vendor, fiscal year and document type
  issued_at: Date;                         // AD
  issued_date_bs: string;                  // "2082-06-21"
  seller_name: string; seller_address: string; seller_phone: string;
  seller_tax_id: string; seller_is_vat_registered: boolean;
  buyer_name: string; buyer_tax_id: string | null;
  payment_method: 'ESEWA' | 'KHALTI' | 'COD';
  subtotal: number; discount: number;
  taxable_amount: number; vat_rate: number; vat_amount: number; exempt_amount: number;
  delivery_charge: number;
  grand_total: number;
  amount_in_words: string;
  print_count: number;
  cbms_status: 'NOT_REQUIRED' | 'PENDING' | 'SYNCED' | 'FAILED';
  lines: {
    product_name: string; hs_code: string | null; quantity: number; unit_price: number;
    taxable_amount: number; vat_rate: number; vat_amount: number;
  }[];
}

interface OrderSnapshot {
  id: string;
  customer_id: string;
  vendor_id: string;
  state: OrderState;
  subtotal: number;
  delivery_fee: number;
  platform_commission_amount: number;
  fulfillment_locked: FulfillmentMode;
  payment_method: 'ESEWA' | 'KHALTI' | 'COD';
  payment_status: 'PENDING' | 'PAID' | 'FAILED';
  delivery_otp: string; // 4-digit bcrypt hash in DB, raw on Customer UI
  created_at: Date;
  // Added 2026-10-07 (specified, not yet implemented). total = subtotal
  //   - vendor_offer_discount - platform_promo_discount + delivery_fee
  vendor_offer_id: string | null;
  vendor_offer_discount: number;
  campaign_opt_in_id: string | null;
  platform_promo_discount: number;       // what the customer sees
  platform_promo_vendor_share: number;   // the part the vendor bears (per its opt-in)
  ad_order_premium: number;              // per-order ad fee, itemised apart from commission
  settlement_model_locked: SettlementModel;
}

// Added 2026-10-07 (specified, not yet implemented). Balances are projections of the journal.
interface VendorLedger {
  vendor_id: string;
  settlement_model: SettlementModel;
  balance_npr: number;            // negative = owed to the platform (Model A); prepaid funds (Model C)
  commission_owed_npr: number;
  ad_fees_owed_npr: number;
  ad_budget_held_npr: number;
  credit_limit_npr: number;       // Model A floor, default -2000
}

```

</data_models_and_schemas>

<edge_cases_and_constraints>

1. **Network Drop During Lock:** If a user loses connection during the Redis lock and reconnects, the app fetches `/api/cart/lock-status`. If TTL > 0, resume checkout. If TTL = 0, purge cart context.
2. **Wallet Limit Hard Stop:** The database must have a `CHECK (wallet_balance_npr >= -2000)` constraint (or handled safely in a transaction). If a COD delivery attempts to push the wallet below this, the backend trigger fires `UPDATE vendor SET status = 'SUSPENDED'`.
3. **Idempotency on Webhooks:** Payment gateways send duplicate webhooks. The orders table MUST process updates within a database transaction utilizing `SELECT ... FOR UPDATE` to prevent double-crediting the escrow ledger.
4. **Concurrent Carts:** A customer cannot have items from `Vendor A` and `Vendor B`. The local Zustand store must clear previous vendor items upon accepting a prompt when adding an item from a new vendor.
5. **Discount ended during checkout (added 2026-10-07, not yet implemented):** an offer or opt-in that ends after an order was priced still applies to that order (the order holds its own snapshot). One that ended before checkout is not applied, even if the app still showed it.
6. **Sponsored without a purchase:** the database must refuse `is_sponsored = true` on a promotion that has no `ad_purchases` row, and an ad charge without one.
7. **Prepaid reserve (Model C, Phase 3):** fees are debited under the vendor row lock. If an order's fees would take the balance below the Fixed Reserve, that order is not offered; a debit (a refund, for example) that leaves the balance below the reserve suspends the shop in the same transaction.
8. **Ad budget exhausted:** a `PER_ORDER_PREMIUM` ad whose held budget cannot cover the next fee is paused before that order is charged; an order is never charged a premium the budget did not hold.
9. **Change requested on the renewal boundary (added 2026-10-07, not yet implemented):** a request and the renewal job take the same vendor row lock. A request committed before the renewal is applied by it; one that arrives after waits a full cycle. A change is never applied twice or half-applied.
10. **Invoice numbering under concurrency:** two orders of one shop delivered at the same moment get consecutive Bill Numbers; a delivery that rolls back consumes no number. The first invoice after 1 Shrawan is number 1 of the new fiscal year, decided by the issue time in `Asia/Kathmandu`.
11. **Invoice tampering:** the database refuses `UPDATE` (other than the print counter and CBMS sync fields) and `DELETE` on invoices and invoice lines, for every role including the Super Admin.
12. **Scope emptied or mode disabled:** a `CITY_WIDE` vendor always keeps its own Palika in `serviceable_palikas`; a vendor whose delivery mode the Admin switched off is not orderable (`422 VENDOR_UNAVAILABLE`) until it picks an enabled one.
13. **BS month boundary (added 2026-10-07, not yet implemented):** a cycle ends at 00:00 `Asia/Kathmandu` on the 1st of the next BS month, whatever that month's length (29 to 32 days). A shop that goes LIVE on the last day of a month has a one-day first cycle.
14. **PAN and other suspensions:** a vendor suspended for debt that also lacks a PAN stays `SUSPENDED`; when its dues are cleared it moves to `SUSPENDED_COMPLIANCE`, not `LIVE`. No path sets `LIVE` without a PAN.
15. **Offline with orders in hand:** switching Offline never cancels or hides an order already placed; the alarm and the 90-second escalation still apply to it.
</edge_cases_and_constraints>

<verification_and_testing>
The coding agent must write unit and integration tests (Jest/Supertest) asserting:

1. **Redis TTL Drop:** Assert that calling checkout locks inventory for exactly 600s, and inventory becomes available immediately after TTL expiry.
2. **HMAC Validation:** Pass mock variables into the HMAC-SHA256 function and assert the resulting Base64 string exactly matches a known valid eSewa signature.
3. **Negative Wallet Math:** Assert that processing a COD order of 1000 NPR with a 10% commission correctly debits the vendor's wallet by 100 NPR, and triggers suspension if the boundary is crossed.
4. **Double-Blind Unlocking:** Assert that fetching a review returns `null/hidden` if only one party has submitted and `time < 48h`, but returns data if both submitted or `time > 48h`.
5. **Cart Math (added 2026-10-07):** subtotal 1000 NPR, a vendor offer of FLAT 100, a campaign of 10% with a 50% vendor share, delivery fee 50, commission 10%. Assert: vendor offer 100, campaign discount 90 (vendor 45, platform 45), **total 860**, commission 85.50 on a base of 855, and that the eSewa form returned by checkout is signed for `860`.
6. **Opt-in Required:** assert a campaign discounts nothing for a shop without its own opt-in row, that no admin route can create that row, and that opting in writes an audit row with the vendor user's id and the timestamp in the same transaction.
7. **Sponsored Needs a Purchase:** assert the database rejects a sponsored promotion and an ad charge that have no `ad_purchases` row, and that an ad charge is posted as its own line type, not as commission.
8. **Settlement Models:** assert that a Model A shop is offered cash only and is suspended strictly below its credit limit; that buying an ad is refused without sufficient balance in Model A; that in Model B a flat-rate ad is accepted against pending payouts and **refused when `balance + pending_escrow < ad_price`**; and that `DIRECT_PREPAID` cannot be selected while Model C is deferred. (Phase 3, with Model C: a shop below its Fixed Reserve is offered no order and is suspended.)
9. **Sponsored Feed:** assert that at most two sponsored shops lead the feed, that each is flagged for the "Ad" badge, and that a sponsored shop which does not deliver to the customer is neither moved up nor flagged in the serviceable section.
10. **Delivery Modularity (added 2026-10-07):** assert a `CITY_WIDE` shop serves a customer whose Palika is in `serviceable_palikas` and not one whose Palika is absent; that a `NATION_WIDE` shop in Dharan is serviceable to an address in Nepalgunj; that a `SELF_DELIVERY` shop with no fee configured charges 0; and that a vendor cannot select a delivery mode the Admin has disabled.
11. **Billing Cycle Lock:** assert that a pricing-plan or payment-method change made mid-cycle leaves the active values, the commission of an order placed afterwards and the payment methods offered at checkout unchanged; that the renewal job applies it exactly once (also when run twice or concurrently) and writes the audit row; and that a withdrawn change is never applied. Assert that a shop going LIVE mid-month gets a first cycle ending at the start of the next BS month, for months of 29, 30, 31 and 32 days, with a monthly fee prorated by days; that a `FREE` plan at its last renewal reverts to the default Commission plan with the settlement model unchanged; and that its 7-day notice is queued exactly once.
12. **Fiscal Invoicing:** assert that delivering an order creates exactly one invoice in the same transaction; that 20 concurrent deliveries for one shop yield Bill Numbers 1–20 with no gap or duplicate, and that a rolled-back delivery consumes none; that the first invoice of a new fiscal year is number 1; that 1130 NPR of taxable goods from a VAT-registered vendor shows taxable 1000.00 and VAT 130.00, and a non-VAT vendor shows no VAT; that the grand total equals the order total to the paisa, also for an order with a vendor offer and a platform-funded campaign discount (verification 5: taxable + VAT + delivery = 860); that `UPDATE` and `DELETE` on an issued invoice are refused by the database; that a refund after delivery creates a Credit Note referencing the invoice; and that a second print is logged and returned as copy 1.
13. **PAN Compliance (added 2026-10-07):** assert that the sweep moves a LIVE vendor without a PAN to `SUSPENDED_COMPLIANCE` and leaves one with a PAN alone; that the suspended shop is absent from the feed and refused at checkout; that saving a valid PAN restores its previous status in the same transaction, and anything but nine digits is refused; that clearing a debt never lifts a compliance suspension; and that no code path can set `LIVE` without a PAN.
14. **Online / Offline:** assert that an Offline shop is listed as not orderable, that checkout refuses it, that an order placed before the switch can still be accepted, dispatched and delivered, and that the switch never changes `status`.
15. **Fleet pickup on the board (added 2026-10-07):** assert that a dispatched fleet order is still listed for its shop with its delivery state, that the rider's pickup is announced to the shop's room exactly once, and that the order view sent to a vendor carries the customer's first name and never the last name or the phone.
16. **Product availability (added 2026-10-07):** assert that switching a product out of stock leaves `stock_quantity` unchanged, that the product is still listed to customers with `in_stock: false`, that checkout refuses it with `409 INSUFFICIENT_STOCK`, that switching it back makes it orderable with its old count, and that a hidden product (`is_active = false`) is unaffected by the flag.
17. **Shop deletion:** assert that a shop with a negative balance or an order not handed over is refused with every reason named, that a clear shop is marked for deletion and stops taking orders in one transaction, that its invoices and ledger entries remain, and that the request can be withdrawn.
</verification_and_testing>

<implicit_requirements_and_audit>

1. **Push Notifications:** Use Expo Push Notifications (or FCM). Critical states (Order Arrivals, Dispatches) must use `data-only` payloads to wake up the app silently in the background on budget Android devices.
2. **Bilingual Architecture:** Implement `i18next`. Create `en.json` and `ne.json`. Create a global utility function `toNepaliNumerals(num: number): string` to convert all prices, timestamps, and quantities to Devanagari numerals (०, १, २, ३, ४, ५, ६, ७, ८, ९) when the locale is set to `ne`.
3. **Authentication:** Implement JWT with short-lived Access Tokens (15 minutes) and HTTP-only, secure Refresh Tokens (7 days). Store access tokens in memory, NOT in unencrypted `AsyncStorage`. Use `react-native-mmkv` with encryption keys if persistence is required.
4. **WebSockets:** Configure Socket.io with namespaces (`/orders`, `/chat`). Emit discrete events (`order:state_update`, `chat:new_message`). Must handle reconnection logic natively (exponential backoff) due to unstable mobile networks in Nepal.
5. **Image Compression:** Vendors uploading catalog photos must pass through a React Native image compression module before transit to AWS S3 / Cloudflare R2 to save bandwidth.
6. **Dispute Chat Privacy:** The socket payload for disputes must completely strip `phone_number` and `last_name` from the User objects before broadcasting to the Vendor client, ensuring total privacy.
</implicit_requirements_and_audit>