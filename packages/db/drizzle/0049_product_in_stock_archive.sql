-- 2026-10-21 (Task 5): three product flags with one owner each (src/product-visibility.ts).
-- is_active is now the Super Admin moderation flag only; in_stock is the vendor In Stock / Out of
-- Stock switch (true for every existing product); archived_at is the vendor removing a product.
-- Existing products with is_active = false are LEFT HIDDEN: before today the vendor switch and an
-- admin hide both wrote that column, and admin hides were not audited, so they cannot be told
-- apart. Failing closed keeps every moderated product hidden; a Super Admin shows a vendor-hidden
-- one again from the dashboard Products screen (see STATE_HANDOFF 8Z.45).
ALTER TABLE "products" ADD COLUMN "in_stock" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "archived_at" timestamp with time zone;