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

**2. Dual-Fulfillment & Scopes**

* **Scopes:** Vendors do not just have a radius. They select a `delivery_scope` enum: `RADIUS_BOUND` (e.g., 5km), `CITY_WIDE` (matches municipality string), or `NATION_WIDE`.
* **Geospatial Logic:** If a user is at distance $D$, a vendor is serviceable if: Scope is Nation-Wide, OR (Scope is City-Wide AND customer_city = vendor_city), OR (Scope is Radius-Bound AND $D \le \text{Radius} \times 1.1$). The $1.1$ multiplier is the 10% strict GPS drift grace buffer.
* **Fulfillment Paths:** `SELF_DELIVERY` vs `PLATFORM_FLEET`.
* **Emergency Rider Override:** If a vendor on `SELF_DELIVERY` cannot fulfill an accepted order, they tap "Emergency Rider." The backend creates a ledger deduction row mapping the platform's delivery fee against the vendor's net payout, and publishes the gig to the `PLATFORM_FLEET`.

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

**5. Financial Governance & Negative Wallets**

* **Escrow:** All upfront payments land in a central platform ledger. Escrow splits into `vendor_wallet`, `driver_wallet`, and `platform_revenue` only *after* the `DELIVERED` state.
* **The COD Problem:** On a COD Self-Delivery order, the vendor collects 100% cash, including the platform's commission.
* **Enforcement:** The backend automatically debits the `vendor_wallet` for the commission amount, pushing it into the negative. If `vendor_wallet < -2000 NPR` (Superadmin configurable limit), a database trigger automatically mutates the vendor's status to `SUSPENDED`. The vendor's app locks until they clear the negative balance via an upfront eSewa payment.
* **Ledger Model:** True double-entry accounting with balanced postings. Single-entry wallet tables are prohibited; `vendor.wallet_balance_npr` is a materialized projection.

**6. Double-Blind Review System & Disputes**

* **Review Logic:** Customer and Vendor ratings are quarantined in the DB (`is_published = false`). They are published only when both exist OR 48 hours elapse.
* **Penalties:** If Customer average rating $< 3.0$, their COD capability is disabled globally. If Vendor Acceptance Rate $< 85\%$, their sorting weight in the geospatial feed algorithm is penalized.
</core_business_logic>

<user_journeys>
**Customer Flow**

1. Auth via OTP (+977 only).
2. App requests GPS. PostGIS validates 'NP' polygon.
3. Feed compiles using geospatial radius + 10% buffer. Unserviceable vendors render in a desaturated "Explore Further" section with carts disabled.
4. User adds to cart. System enforces single-vendor cart restriction.
5. Cart validates `total >= vendor.MOV` (Minimum Order Value). Applies Small Cart Surcharge if below.
6. Checkout triggers Redis 10-min inventory lock.
7. Payment selection evaluates COD eligibility based on customer rating.
8. Unskippable 60-second cancellation window starts post-order.
9. Order tracking utilizes a **Discrete State Node** UI (Order Placed -> Preparing -> Out for Delivery -> Arrived) rather than live map polling to save API costs.
10. Customer displays 4-digit cryptographic OTP to driver upon handoff.
11. Double-blind review prompted. 48hr window opens to initiate dispute chat.

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
</user_journeys>

<nepal_localizations_and_integrations>
**1. eSewa Payment Integration (ePay v2)**

* **Architecture:** Use React Native WebView as a fallback, but prefer App-to-App deep linking via Intents if the eSewa app is installed.
* **Signature Generation (CRITICAL):** The backend MUST generate the `signature` using HMAC-SHA256.
* Formula: `Message = "total_amount,transaction_uuid,product_code"`
* Hash the `Message` using the eSewa `Secret_Key`.
* Convert the resulting hash strictly to a `Base64` string.


* **Validation:** Upon redirect, backend must verify the signature, verify `status === 'COMPLETE'`, and check that `total_amount` matches the DB snapshot ($\pm 0.01$ NPR tolerance).

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
</nepal_localizations_and_integrations>

<data_models_and_schemas>
Implement using strict TypeScript interfaces mapping to PostgreSQL schemas.

```typescript
enum DeliveryScope { RADIUS_BOUND, CITY_WIDE, NATION_WIDE }
enum FulfillmentMode { SELF_DELIVERY, PLATFORM_FLEET, EMERGENCY_FLEET }
enum OrderState { PENDING_PAYMENT, PLACED, PREPARING, OUT_FOR_DELIVERY, DELIVERED, CANCELED, FAILED, DISPUTED }

interface Vendor {
  id: string;
  phone: string; // +977 format
  status: 'SANDBOXED' | 'APPROVED' | 'LIVE' | 'SUSPENDED';
  pricing_model: 'SUBSCRIPTION' | 'COMMISSION';
  lock_in_expiry: Date | null;
  commission_rate: number;
  delivery_scope: DeliveryScope;
  radius_km: number;
  municipality_palika_string: string;
  min_order_value: number;
  location: any; // PostGIS Point (Lat/Lng)
  wallet_balance_npr: number;
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
}

```

</data_models_and_schemas>

<edge_cases_and_constraints>

1. **Network Drop During Lock:** If a user loses connection during the Redis lock and reconnects, the app fetches `/api/cart/lock-status`. If TTL > 0, resume checkout. If TTL = 0, purge cart context.
2. **Wallet Limit Hard Stop:** The database must have a `CHECK (wallet_balance_npr >= -2000)` constraint (or handled safely in a transaction). If a COD delivery attempts to push the wallet below this, the backend trigger fires `UPDATE vendor SET status = 'SUSPENDED'`.
3. **Idempotency on Webhooks:** Payment gateways send duplicate webhooks. The orders table MUST process updates within a database transaction utilizing `SELECT ... FOR UPDATE` to prevent double-crediting the escrow ledger.
4. **Concurrent Carts:** A customer cannot have items from `Vendor A` and `Vendor B`. The local Zustand store must clear previous vendor items upon accepting a prompt when adding an item from a new vendor.
</edge_cases_and_constraints>

<verification_and_testing>
The coding agent must write unit and integration tests (Jest/Supertest) asserting:

1. **Redis TTL Drop:** Assert that calling checkout locks inventory for exactly 600s, and inventory becomes available immediately after TTL expiry.
2. **HMAC Validation:** Pass mock variables into the HMAC-SHA256 function and assert the resulting Base64 string exactly matches a known valid eSewa signature.
3. **Negative Wallet Math:** Assert that processing a COD order of 1000 NPR with a 10% commission correctly debits the vendor's wallet by 100 NPR, and triggers suspension if the boundary is crossed.
4. **Double-Blind Unlocking:** Assert that fetching a review returns `null/hidden` if only one party has submitted and `time < 48h`, but returns data if both submitted or `time > 48h`.
</verification_and_testing>

<implicit_requirements_and_audit>

1. **Push Notifications:** Use Expo Push Notifications (or FCM). Critical states (Order Arrivals, Dispatches) must use `data-only` payloads to wake up the app silently in the background on budget Android devices.
2. **Bilingual Architecture:** Implement `i18next`. Create `en.json` and `ne.json`. Create a global utility function `toNepaliNumerals(num: number): string` to convert all prices, timestamps, and quantities to Devanagari numerals (०, १, २, ३, ४, ५, ६, ७, ८, ९) when the locale is set to `ne`.
3. **Authentication:** Implement JWT with short-lived Access Tokens (15 minutes) and HTTP-only, secure Refresh Tokens (7 days). Store access tokens in memory, NOT in unencrypted `AsyncStorage`. Use `react-native-mmkv` with encryption keys if persistence is required.
4. **WebSockets:** Configure Socket.io with namespaces (`/orders`, `/chat`). Emit discrete events (`order:state_update`, `chat:new_message`). Must handle reconnection logic natively (exponential backoff) due to unstable mobile networks in Nepal.
5. **Image Compression:** Vendors uploading catalog photos must pass through a React Native image compression module before transit to AWS S3 / Cloudflare R2 to save bandwidth.
6. **Dispute Chat Privacy:** The socket payload for disputes must completely strip `phone_number` and `last_name` from the User objects before broadcasting to the Vendor client, ensuring total privacy.
</implicit_requirements_and_audit>