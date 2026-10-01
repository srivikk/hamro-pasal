-- Phase 15: the Super Admin's DLQ monitor and vendor overrides.
-- dead_letter_events: every message a worker consumer dead-lettered (key/value byte for byte), with
-- the retry state the admin drives (PENDING -> RETRY_REQUESTED -> REPLAYED by the worker's replayer).
-- vendors.status_before_admin_suspension: the status an admin Restore returns to; an admin
-- suspension is never lifted by paying dues (the debt column stays null while it is set).
CREATE TYPE "public"."dead_letter_status" AS ENUM('PENDING', 'RETRY_REQUESTED', 'REPLAYED');--> statement-breakpoint
CREATE TABLE "dead_letter_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "dead_letter_status" DEFAULT 'PENDING' NOT NULL,
	"consumer" text NOT NULL,
	"source_topic" text NOT NULL,
	"source_partition" integer NOT NULL,
	"source_offset" text NOT NULL,
	"dead_letter_topic" text NOT NULL,
	"message_key" "bytea",
	"message_value" "bytea",
	"headers" jsonb NOT NULL,
	"event_id" text,
	"event_type" text,
	"attempts" integer NOT NULL,
	"error_name" text NOT NULL,
	"error_message" text NOT NULL,
	"failed_at" timestamp with time zone NOT NULL,
	"retry_requested_at" timestamp with time zone,
	"retry_requested_by" uuid,
	"replayed_at" timestamp with time zone,
	"replay_attempts" integer DEFAULT 0 NOT NULL,
	"last_replay_error" text,
	"replay_of_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dead_letter_events_offset_check" CHECK ("dead_letter_events"."source_offset" ~ '^[0-9]+$'),
	CONSTRAINT "dead_letter_events_partition_check" CHECK ("dead_letter_events"."source_partition" >= 0),
	CONSTRAINT "dead_letter_events_attempts_check" CHECK ("dead_letter_events"."attempts" >= 1),
	CONSTRAINT "dead_letter_events_replay_attempts_check" CHECK ("dead_letter_events"."replay_attempts" >= 0),
	CONSTRAINT "dead_letter_events_status_check" CHECK (("dead_letter_events"."status" = 'PENDING' AND "dead_letter_events"."retry_requested_at" IS NULL AND "dead_letter_events"."replayed_at" IS NULL)
        OR ("dead_letter_events"."status" = 'RETRY_REQUESTED' AND "dead_letter_events"."retry_requested_at" IS NOT NULL AND "dead_letter_events"."replayed_at" IS NULL)
        OR ("dead_letter_events"."status" = 'REPLAYED' AND "dead_letter_events"."retry_requested_at" IS NOT NULL AND "dead_letter_events"."replayed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "status_before_admin_suspension" "vendor_status";--> statement-breakpoint
ALTER TABLE "dead_letter_events" ADD CONSTRAINT "dead_letter_events_retry_requested_by_users_id_fk" FOREIGN KEY ("retry_requested_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dead_letter_events_source_uidx" ON "dead_letter_events" USING btree ("consumer","source_topic","source_partition","source_offset");--> statement-breakpoint
CREATE INDEX "dead_letter_events_failed_at_idx" ON "dead_letter_events" USING btree ("failed_at","id");--> statement-breakpoint
CREATE INDEX "dead_letter_events_status_idx" ON "dead_letter_events" USING btree ("status","failed_at","id");--> statement-breakpoint
CREATE INDEX "dead_letter_events_retry_requested_idx" ON "dead_letter_events" USING btree ("retry_requested_at","id") WHERE "dead_letter_events"."status" = 'RETRY_REQUESTED';--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_admin_suspension_check" CHECK ("vendors"."status_before_admin_suspension" IS NULL OR ("vendors"."status" = 'SUSPENDED' AND "vendors"."status_before_admin_suspension" <> 'SUSPENDED' AND "vendors"."status_before_debt_suspension" IS NULL));