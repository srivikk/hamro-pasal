-- Phase 10: the 90 s vendor acceptance SLA writes at most one vendor.escalation.required event per
-- order (the IVR/SMS alert must never call a vendor twice), and the worker looks it up by order.
CREATE UNIQUE INDEX "outbox_events_vendor_escalation_uidx" ON "outbox_events" USING btree ("aggregate_id") WHERE "outbox_events"."event_type" = 'vendor.escalation.required';
