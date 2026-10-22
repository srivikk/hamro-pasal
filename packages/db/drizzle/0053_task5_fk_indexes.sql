-- 2026-10-22: indexes for the three foreign keys of migrations 0050 and 0051 that had none
-- (found by test/foreign-key-indexes.int.test.ts). auth_events.user_id is usually null: partial.
CREATE INDEX "auth_events_user_id_idx" ON "auth_events" USING btree ("user_id") WHERE "auth_events"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "product_reviews_customer_id_idx" ON "product_reviews" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "product_reviews_order_id_idx" ON "product_reviews" USING btree ("order_id");