-- Phase 6: checkout stores the customer's Nepal delivery address (Province/District/Palika/Ward/
-- Tole + dropped pin) as a per-order copy, and a canceled PAID order is flagged for refund.
CREATE TABLE "order_addresses" (
	"order_id" uuid PRIMARY KEY NOT NULL,
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
	CONSTRAINT "order_addresses_province_check" CHECK ("order_addresses"."province_id" BETWEEN 1 AND 7),
	CONSTRAINT "order_addresses_ward_check" CHECK ("order_addresses"."ward_number" >= 1),
	CONSTRAINT "order_addresses_lat_check" CHECK ("order_addresses"."exact_lat" BETWEEN -90 AND 90),
	CONSTRAINT "order_addresses_lng_check" CHECK ("order_addresses"."exact_lng" BETWEEN -180 AND 180)
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "refund_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "order_addresses" ADD CONSTRAINT "order_addresses_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_addresses_location_gist" ON "order_addresses" USING gist ("location");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_refund_required_paid_check" CHECK (NOT "orders"."refund_required" OR "orders"."payment_status" = 'PAID');