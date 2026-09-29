-- Checkout (Phase 4) creates the order together with its inventory lock, and copies the
-- vendor's standing fulfillment choice (SPEC §2) onto the order as fulfillment_locked.
ALTER TABLE "orders" ADD COLUMN "reservation_id" uuid;--> statement-breakpoint
-- Existing vendors are backfilled with SELF_DELIVERY, the only mode that needs no platform
-- rider. The default is then dropped, so every new vendor must state its mode explicitly.
ALTER TABLE "vendors" ADD COLUMN "fulfillment_mode" "fulfillment_mode" NOT NULL DEFAULT 'SELF_DELIVERY';--> statement-breakpoint
ALTER TABLE "vendors" ALTER COLUMN "fulfillment_mode" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_reservation_id_key" UNIQUE("reservation_id");--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_fulfillment_mode_check" CHECK ("vendors"."fulfillment_mode" IN ('SELF_DELIVERY', 'PLATFORM_FLEET'));
