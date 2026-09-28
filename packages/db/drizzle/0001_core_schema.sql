CREATE TYPE "public"."delivery_scope" AS ENUM('RADIUS_BOUND', 'CITY_WIDE', 'NATION_WIDE');--> statement-breakpoint
CREATE TYPE "public"."dispute_status" AS ENUM('OPEN', 'REFUNDED_TO_CUSTOMER', 'RELEASED_TO_VENDOR');--> statement-breakpoint
CREATE TYPE "public"."fulfillment_mode" AS ENUM('SELF_DELIVERY', 'PLATFORM_FLEET', 'EMERGENCY_FLEET');--> statement-breakpoint
CREATE TYPE "public"."order_state" AS ENUM('PENDING_PAYMENT', 'PLACED', 'PREPARING', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELED', 'FAILED', 'DISPUTED');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('ESEWA', 'KHALTI', 'COD');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('PENDING', 'PAID', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."pricing_model" AS ENUM('SUBSCRIPTION', 'COMMISSION');--> statement-breakpoint
CREATE TYPE "public"."review_direction" AS ENUM('CUSTOMER_TO_VENDOR', 'VENDOR_TO_CUSTOMER');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('CUSTOMER', 'VENDOR', 'DRIVER', 'SUPER_ADMIN');--> statement-breakpoint
CREATE TYPE "public"."vendor_status" AS ENUM('SANDBOXED', 'APPROVED', 'LIVE', 'SUSPENDED');--> statement-breakpoint
CREATE TYPE "public"."wallet_ledger_entry_type" AS ENUM('ESCROW_RELEASE', 'COD_COMMISSION', 'EMERGENCY_RIDER_FEE', 'TOP_UP', 'ADJUSTMENT');--> statement-breakpoint
CREATE TABLE "disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"opened_by_user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"status" "dispute_status" DEFAULT 'OPEN' NOT NULL,
	"resolved_by_user_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "disputes_order_id_unique" UNIQUE("order_id"),
	CONSTRAINT "disputes_reason_check" CHECK (btrim("disputes"."reason") <> ''),
	CONSTRAINT "disputes_resolution_check" CHECK (("disputes"."status" = 'OPEN') = ("disputes"."resolved_at" IS NULL AND "disputes"."resolved_by_user_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"direction" "review_direction" NOT NULL,
	"rating" smallint NOT NULL,
	"comment" text,
	"is_published" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviews_order_id_direction_key" UNIQUE("order_id","direction"),
	CONSTRAINT "reviews_rating_check" CHECK ("reviews"."rating" BETWEEN 1 AND 5),
	CONSTRAINT "reviews_comment_check" CHECK ("reviews"."comment" IS NULL OR btrim("reviews"."comment") <> ''),
	CONSTRAINT "reviews_published_at_check" CHECK ("reviews"."is_published" = ("reviews"."published_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"product_name" text NOT NULL,
	"unit_price_npr" numeric(12, 2) NOT NULL,
	"quantity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_items_order_id_product_id_key" UNIQUE("order_id","product_id"),
	CONSTRAINT "order_items_product_name_check" CHECK (btrim("order_items"."product_name") <> ''),
	CONSTRAINT "order_items_unit_price_check" CHECK ("order_items"."unit_price_npr" > 0),
	CONSTRAINT "order_items_quantity_check" CHECK ("order_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"state" "order_state" DEFAULT 'PENDING_PAYMENT' NOT NULL,
	"subtotal" numeric(12, 2) NOT NULL,
	"delivery_fee" numeric(12, 2) NOT NULL,
	"platform_commission_amount" numeric(12, 2) NOT NULL,
	"fulfillment_locked" "fulfillment_mode" NOT NULL,
	"payment_method" "payment_method" NOT NULL,
	"payment_status" "payment_status" DEFAULT 'PENDING' NOT NULL,
	"payment_gateway_ref" text,
	"delivery_otp" text NOT NULL,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_idempotency_key_key" UNIQUE("idempotency_key"),
	CONSTRAINT "orders_payment_gateway_ref_key" UNIQUE("payment_method","payment_gateway_ref"),
	CONSTRAINT "orders_id_vendor_id_key" UNIQUE("id","vendor_id"),
	CONSTRAINT "orders_idempotency_key_check" CHECK (btrim("orders"."idempotency_key") <> ''),
	CONSTRAINT "orders_subtotal_check" CHECK ("orders"."subtotal" >= 0),
	CONSTRAINT "orders_delivery_fee_check" CHECK ("orders"."delivery_fee" >= 0),
	CONSTRAINT "orders_platform_commission_check" CHECK ("orders"."platform_commission_amount" >= 0),
	CONSTRAINT "orders_cod_has_no_gateway_ref_check" CHECK ("orders"."payment_method" <> 'COD' OR "orders"."payment_gateway_ref" IS NULL),
	CONSTRAINT "orders_delivery_otp_bcrypt_check" CHECK ("orders"."delivery_otp" ~ '^\$2[aby]\$')
);
--> statement-breakpoint
CREATE TABLE "customer_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"province_id" smallint NOT NULL,
	"district_string" text NOT NULL,
	"municipality_palika_string" text NOT NULL,
	"ward_number" integer NOT NULL,
	"tole_locality" text NOT NULL,
	"landmark" text NOT NULL,
	"exact_lat" double precision NOT NULL,
	"exact_lng" double precision NOT NULL,
	"location" geometry(Point,4326) GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint("exact_lng", "exact_lat"), 4326)) STORED NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_addresses_province_check" CHECK ("customer_addresses"."province_id" BETWEEN 1 AND 7),
	CONSTRAINT "customer_addresses_ward_check" CHECK ("customer_addresses"."ward_number" >= 1),
	CONSTRAINT "customer_addresses_lat_check" CHECK ("customer_addresses"."exact_lat" BETWEEN -90 AND 90),
	CONSTRAINT "customer_addresses_lng_check" CHECK ("customer_addresses"."exact_lng" BETWEEN -180 AND 180)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"role" "user_role" NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_phone_unique" UNIQUE("phone"),
	CONSTRAINT "users_phone_np_check" CHECK ("users"."phone" ~ '^\+9779[0-9]{9}$'),
	CONSTRAINT "users_first_name_check" CHECK (btrim("users"."first_name") <> ''),
	CONSTRAINT "users_last_name_check" CHECK ("users"."last_name" IS NULL OR btrim("users"."last_name") <> '')
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"name" text NOT NULL,
	"price_npr" numeric(12, 2) NOT NULL,
	"stock_quantity" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_vendor_id_name_key" UNIQUE("vendor_id","name"),
	CONSTRAINT "products_name_check" CHECK (btrim("products"."name") <> ''),
	CONSTRAINT "products_price_check" CHECK ("products"."price_npr" > 0),
	CONSTRAINT "products_stock_quantity_check" CHECK ("products"."stock_quantity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "vendors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"business_name" text NOT NULL,
	"phone" text NOT NULL,
	"status" "vendor_status" DEFAULT 'SANDBOXED' NOT NULL,
	"pricing_model" "pricing_model",
	"lock_in_expiry" timestamp with time zone,
	"scheduled_downgrade" boolean DEFAULT false NOT NULL,
	"commission_rate" numeric(5, 4) NOT NULL,
	"delivery_scope" "delivery_scope" NOT NULL,
	"radius_km" numeric(6, 2) NOT NULL,
	"city_string" text NOT NULL,
	"min_order_value" numeric(12, 2) NOT NULL,
	"base_delivery_fee_npr" numeric(12, 2) NOT NULL,
	"location" geometry(Point,4326) NOT NULL,
	"wallet_balance_npr" numeric(12, 2) DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendors_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "vendors_phone_np_check" CHECK ("vendors"."phone" ~ '^\+9779[0-9]{9}$'),
	CONSTRAINT "vendors_business_name_check" CHECK (btrim("vendors"."business_name") <> ''),
	CONSTRAINT "vendors_city_string_check" CHECK (btrim("vendors"."city_string") <> ''),
	CONSTRAINT "vendors_commission_rate_check" CHECK ("vendors"."commission_rate" BETWEEN 0 AND 1),
	CONSTRAINT "vendors_subscription_zero_commission_check" CHECK ("vendors"."pricing_model" IS DISTINCT FROM 'SUBSCRIPTION' OR "vendors"."commission_rate" = 0),
	CONSTRAINT "vendors_live_requires_pricing_model_check" CHECK ("vendors"."status" <> 'LIVE' OR "vendors"."pricing_model" IS NOT NULL),
	CONSTRAINT "vendors_radius_km_check" CHECK ("vendors"."radius_km" > 0),
	CONSTRAINT "vendors_min_order_value_check" CHECK ("vendors"."min_order_value" >= 0),
	CONSTRAINT "vendors_base_delivery_fee_check" CHECK ("vendors"."base_delivery_fee_npr" >= 0),
	CONSTRAINT "vendors_wallet_balance_floor_check" CHECK ("vendors"."wallet_balance_npr" >= -2000 OR "vendors"."status" = 'SUSPENDED')
);
--> statement-breakpoint
CREATE TABLE "platform_settings" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"vendor_wallet_suspension_limit_npr" numeric(12, 2) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_settings_singleton_check" CHECK ("platform_settings"."id"),
	CONSTRAINT "platform_settings_wallet_limit_check" CHECK ("platform_settings"."vendor_wallet_suspension_limit_npr" BETWEEN -2000 AND 0)
);
--> statement-breakpoint
CREATE TABLE "wallet_ledgers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"order_id" uuid,
	"entry_type" "wallet_ledger_entry_type" NOT NULL,
	"amount_npr" numeric(12, 2) NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_ledgers_order_id_entry_type_key" UNIQUE("order_id","entry_type"),
	CONSTRAINT "wallet_ledgers_amount_sign_check" CHECK (("wallet_ledgers"."entry_type" IN ('COD_COMMISSION', 'EMERGENCY_RIDER_FEE') AND "wallet_ledgers"."amount_npr" < 0)
        OR ("wallet_ledgers"."entry_type" IN ('ESCROW_RELEASE', 'TOP_UP') AND "wallet_ledgers"."amount_npr" > 0)
        OR ("wallet_ledgers"."entry_type" = 'ADJUSTMENT' AND "wallet_ledgers"."amount_npr" <> 0)),
	CONSTRAINT "wallet_ledgers_order_required_check" CHECK ("wallet_ledgers"."entry_type" IN ('TOP_UP', 'ADJUSTMENT') OR "wallet_ledgers"."order_id" IS NOT NULL),
	CONSTRAINT "wallet_ledgers_description_check" CHECK ("wallet_ledgers"."description" IS NULL OR btrim("wallet_ledgers"."description") <> '')
);
--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_opened_by_user_id_users_id_fk" FOREIGN KEY ("opened_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_users_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ledgers" ADD CONSTRAINT "wallet_ledgers_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ledgers" ADD CONSTRAINT "wallet_ledgers_order_vendor_fk" FOREIGN KEY ("order_id","vendor_id") REFERENCES "public"."orders"("id","vendor_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "disputes_status_idx" ON "disputes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "reviews_unpublished_created_at_idx" ON "reviews" USING btree ("created_at") WHERE "reviews"."is_published" = false;--> statement-breakpoint
CREATE INDEX "order_items_product_id_idx" ON "order_items" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "orders_customer_id_idx" ON "orders" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "orders_vendor_id_state_idx" ON "orders" USING btree ("vendor_id","state");--> statement-breakpoint
CREATE INDEX "customer_addresses_user_id_idx" ON "customer_addresses" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "customer_addresses_location_gist" ON "customer_addresses" USING gist ("location");--> statement-breakpoint
CREATE INDEX "products_vendor_id_idx" ON "products" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "vendors_location_gist" ON "vendors" USING gist ("location");--> statement-breakpoint
CREATE INDEX "vendors_location_geography_gist" ON "vendors" USING gist (("location"::geography));--> statement-breakpoint
CREATE INDEX "vendors_status_idx" ON "vendors" USING btree ("status");--> statement-breakpoint
CREATE INDEX "wallet_ledgers_vendor_id_created_at_idx" ON "wallet_ledgers" USING btree ("vendor_id","created_at");