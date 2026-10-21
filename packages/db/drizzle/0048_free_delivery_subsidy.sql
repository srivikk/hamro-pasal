-- 2026-10-21 (SPEC core 9, Task 4): the platform free-delivery threshold and its subsidy.
-- platform_settings.free_delivery_above_npr: goods worth this much or more, after discounts, ship
-- free for every shop (null: off). orders.platform_delivery_subsidy_npr: the fee the platform pays
-- instead of the customer; whoever delivers earns it at settlement (DELIVERY_SUBSIDY lines,
-- funded by PROMO_EXPENSE). DELIVERY_SUBSIDY is ADDED to ledger_line_type and NOT used in this
-- file: PostgreSQL cannot use an enum value in the transaction that adds it.
ALTER TYPE "public"."ledger_line_type" ADD VALUE 'DELIVERY_SUBSIDY';--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "platform_delivery_subsidy_npr" numeric(12, 2) DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "free_delivery_above_npr" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_delivery_subsidy_check" CHECK ("orders"."platform_delivery_subsidy_npr" >= 0
            AND ("orders"."platform_delivery_subsidy_npr" = 0 OR "orders"."delivery_fee" = 0));--> statement-breakpoint
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_free_delivery_check" CHECK ("platform_settings"."free_delivery_above_npr" IS NULL OR "platform_settings"."free_delivery_above_npr" > 0);