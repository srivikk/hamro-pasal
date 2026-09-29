-- Phase 6: orders.placed_at is stamped when an order becomes PLACED (COD accepted at checkout, or
-- eSewa/Khalti payment confirmed). The 60 s cancellation window runs from it, not from created_at.
ALTER TABLE "orders" ADD COLUMN "placed_at" timestamp with time zone;--> statement-breakpoint
-- Backfill orders placed before this column existed. Their exact placement time was not
-- recorded; created_at is the closest known bound (exact for COD, which is placed at checkout).
UPDATE "orders" SET "placed_at" = "created_at" WHERE "state" NOT IN ('PENDING_PAYMENT', 'FAILED');--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_placed_at_check" CHECK (CASE "orders"."state" WHEN 'PENDING_PAYMENT' THEN "orders"."placed_at" IS NULL WHEN 'FAILED' THEN true ELSE "orders"."placed_at" IS NOT NULL END);
