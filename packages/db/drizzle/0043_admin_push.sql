-- Step 7.5 (2026-10-16, SPEC core 11): admin push. pg_trgm for the Super Admin vendor search by
-- name (the Vendor Code is matched by prefix), and the push outcome on each admin message.
-- Hand-added: the extension, before the index that needs its operator class. Idempotent, as
-- 0000 is for PostGIS (managed databases such as RDS allow pg_trgm).
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
ALTER TABLE "notification_messages" ADD COLUMN "recipient_count" integer;--> statement-breakpoint
ALTER TABLE "notification_messages" ADD COLUMN "push_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification_messages" ADD COLUMN "push_sent_count" integer;--> statement-breakpoint
ALTER TABLE "notification_messages" ADD COLUMN "push_failed_count" integer;--> statement-breakpoint
ALTER TABLE "notification_messages" ADD COLUMN "push_completed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "notification_messages_admin_created_idx" ON "notification_messages" USING btree ("created_at","id") WHERE "notification_messages"."source" = 'ADMIN';--> statement-breakpoint
CREATE INDEX "vendors_business_name_trgm_idx" ON "vendors" USING gin ("business_name" gin_trgm_ops);--> statement-breakpoint
ALTER TABLE "notification_messages" ADD CONSTRAINT "notification_messages_push_counts_check" CHECK (("notification_messages"."recipient_count" IS NULL OR "notification_messages"."recipient_count" >= 0)
        AND ("notification_messages"."push_completed_at" IS NULL) = ("notification_messages"."push_sent_count" IS NULL)
        AND ("notification_messages"."push_completed_at" IS NULL) = ("notification_messages"."push_failed_count" IS NULL)
        AND ("notification_messages"."push_completed_at" IS NULL OR "notification_messages"."push_started_at" IS NOT NULL)
        AND ("notification_messages"."push_sent_count" IS NULL OR "notification_messages"."push_sent_count" >= 0)
        AND ("notification_messages"."push_failed_count" IS NULL OR "notification_messages"."push_failed_count" >= 0));