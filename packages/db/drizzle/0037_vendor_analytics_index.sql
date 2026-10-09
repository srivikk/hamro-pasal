-- Phase 35: the index behind GET /api/vendor/analytics/summary (a shop's deliveries by time).
-- No outbox table is created here: outbox_events exists since migration 0005 and the Phase 35
-- notification events (vendor.suspended_for_compliance, marketing.*) are written to it.
CREATE INDEX "orders_vendor_id_delivered_at_idx" ON "orders" USING btree ("vendor_id","delivered_at") WHERE "orders"."delivered_at" IS NOT NULL;