-- Step 7.3 (2026-10-15, SPEC core 11): weekly opening hours, the Open / Closed switch over them,
-- Auto-Pause after missed orders, and the two Superadmin settings behind them.
CREATE TYPE "public"."availability_override" AS ENUM('NONE', 'OPEN', 'CLOSED');--> statement-breakpoint
CREATE TABLE "vendor_opening_hours" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"weekday" smallint NOT NULL,
	"opens_at" time NOT NULL,
	"closes_at" time NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_opening_hours_weekday_check" CHECK ("vendor_opening_hours"."weekday" BETWEEN 0 AND 6),
	CONSTRAINT "vendor_opening_hours_range_check" CHECK ("vendor_opening_hours"."opens_at" <> "vendor_opening_hours"."closes_at")
);
--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "availability_override" "availability_override" DEFAULT 'NONE' NOT NULL;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "availability_override_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "auto_paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "consecutive_missed_orders" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "last_order_minutes_before_close" integer DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "auto_pause_threshold" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "vendor_opening_hours" ADD CONSTRAINT "vendor_opening_hours_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vendor_opening_hours_vendor_idx" ON "vendor_opening_hours" USING btree ("vendor_id","weekday");--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_availability_override_check" CHECK ("vendors"."availability_override" <> 'NONE' OR "vendors"."availability_override_until" IS NULL);--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_consecutive_missed_orders_check" CHECK ("vendors"."consecutive_missed_orders" >= 0);--> statement-breakpoint
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_last_order_check" CHECK ("platform_settings"."last_order_minutes_before_close" BETWEEN 0 AND 120);--> statement-breakpoint
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_auto_pause_threshold_check" CHECK ("platform_settings"."auto_pause_threshold" BETWEEN 1 AND 20);