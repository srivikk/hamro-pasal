-- Phase 23: index audit. Every foreign key below had no index led by its column, so deleting (or
-- changing the key of) the referenced users / ledger_transactions row made PostgreSQL scan the
-- whole referencing table while it held the parent row lock. Columns that are usually NULL get a
-- partial index: the foreign key check filters on `column = $1`, which implies IS NOT NULL.
-- No table, column or constraint changes. Plain CREATE INDEX (Drizzle runs migrations inside one
-- transaction, so CONCURRENTLY is not possible): writes to each table wait while its index builds.
CREATE INDEX "dead_letter_events_retry_requested_by_idx" ON "dead_letter_events" USING btree ("retry_requested_by") WHERE "dead_letter_events"."retry_requested_by" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "chat_messages_sender_user_id_idx" ON "chat_messages" USING btree ("sender_user_id");--> statement-breakpoint
CREATE INDEX "disputes_opened_by_user_id_idx" ON "disputes" USING btree ("opened_by_user_id");--> statement-breakpoint
CREATE INDEX "disputes_resolved_by_user_id_idx" ON "disputes" USING btree ("resolved_by_user_id") WHERE "disputes"."resolved_by_user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "orders_driver_user_id_idx" ON "orders" USING btree ("driver_user_id") WHERE "orders"."driver_user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "payout_requests_reversal_transaction_id_idx" ON "payout_requests" USING btree ("reversal_transaction_id") WHERE "payout_requests"."reversal_transaction_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "payout_requests_decided_by_user_id_idx" ON "payout_requests" USING btree ("decided_by_user_id") WHERE "payout_requests"."decided_by_user_id" IS NOT NULL;
