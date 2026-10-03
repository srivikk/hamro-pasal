-- Phase 21: rider dispatch. deliveries is the platform rider's job for one fleet order: created
-- OFFERED when the shop dispatches it, then ASSIGNED (a rider accepted), PICKED_UP and DELIVERED
-- (the customer's code matched). It has no code column: the doorstep code stays orders.delivery_otp.
CREATE TYPE "public"."delivery_state" AS ENUM('OFFERED', 'ASSIGNED', 'PICKED_UP', 'DELIVERED', 'FAILED');--> statement-breakpoint
CREATE TABLE "deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"rider_id" uuid,
	"state" "delivery_state" DEFAULT 'OFFERED' NOT NULL,
	"accepted_at" timestamp with time zone,
	"picked_up_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deliveries_rider_check" CHECK (("deliveries"."state" = 'OFFERED') = ("deliveries"."rider_id" IS NULL)),
	CONSTRAINT "deliveries_accepted_at_check" CHECK (("deliveries"."state" = 'OFFERED') = ("deliveries"."accepted_at" IS NULL)),
	CONSTRAINT "deliveries_picked_up_at_check" CHECK ("deliveries"."state" NOT IN ('OFFERED', 'ASSIGNED') OR "deliveries"."picked_up_at" IS NULL),
	CONSTRAINT "deliveries_completed_at_check" CHECK (("deliveries"."state" IN ('DELIVERED', 'FAILED')) = ("deliveries"."completed_at" IS NOT NULL)),
	CONSTRAINT "deliveries_delivered_picked_up_check" CHECK ("deliveries"."state" <> 'DELIVERED' OR "deliveries"."picked_up_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_rider_id_users_id_fk" FOREIGN KEY ("rider_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_order_id_uidx" ON "deliveries" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "deliveries_rider_id_state_idx" ON "deliveries" USING btree ("rider_id","state");--> statement-breakpoint
CREATE INDEX "deliveries_state_idx" ON "deliveries" USING btree ("state");--> statement-breakpoint
CREATE TRIGGER deliveries_set_updated_at BEFORE UPDATE ON deliveries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
-- Backfill (hand-added): fleet orders already on the road become open gigs, so a rider can still
-- accept and deliver them through /api/deliveries. Orders delivered earlier get no row.
INSERT INTO "deliveries" ("order_id")
SELECT "id" FROM "orders"
WHERE "state" = 'OUT_FOR_DELIVERY' AND "fulfillment_locked" IN ('PLATFORM_FLEET', 'EMERGENCY_FLEET');
