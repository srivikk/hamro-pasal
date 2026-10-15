-- Step 7.1 (2026-10-15, SPEC core 11): the account settings behind /api/me (email, language,
-- terms, WhatsApp consent, account status), the vendor code, and the notification centre.
CREATE TYPE "public"."account_status" AS ENUM('ACTIVE', 'DELETED_REQUESTED', 'SUSPENDED');--> statement-breakpoint
CREATE TYPE "public"."language_preference" AS ENUM('en', 'ne');--> statement-breakpoint
CREATE TYPE "public"."notification_audience" AS ENUM('VENDOR', 'CUSTOMER', 'ALL_CUSTOMERS');--> statement-breakpoint
CREATE TYPE "public"."notification_source" AS ENUM('ADMIN', 'SYSTEM');--> statement-breakpoint
CREATE TABLE "notification_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"audience" "notification_audience" NOT NULL,
	"source" "notification_source" NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_user_id" uuid,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_messages_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "notification_messages_title_check" CHECK (char_length(btrim("notification_messages"."title")) BETWEEN 1 AND 60),
	CONSTRAINT "notification_messages_body_check" CHECK (char_length(btrim("notification_messages"."body")) BETWEEN 1 AND 240),
	CONSTRAINT "notification_messages_data_check" CHECK (jsonb_typeof("notification_messages"."data") = 'object'),
	CONSTRAINT "notification_messages_source_check" CHECK (("notification_messages"."source" = 'ADMIN') = ("notification_messages"."created_by_user_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "notification_reads" (
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_reads_message_id_user_id_pk" PRIMARY KEY("message_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "notification_recipients" (
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"read_at" timestamp with time zone,
	CONSTRAINT "notification_recipients_message_id_user_id_pk" PRIMARY KEY("message_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "language_preference" "language_preference" DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "terms_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "whatsapp_opt_in" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "account_status" "account_status" DEFAULT 'ACTIVE' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deletion_requested_at" timestamp with time zone;--> statement-breakpoint
-- Hand-written: the vendor code. A sequence and a function that never truncates past 99999
-- (lpad alone would), then a backfill in sign-up order, then the default and NOT NULL.
CREATE SEQUENCE "vendor_code_seq" AS bigint START WITH 1;--> statement-breakpoint
CREATE FUNCTION next_vendor_code() RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT 'HPV-' || CASE WHEN n < 100000 THEN lpad(n::text, 5, '0') ELSE n::text END
  FROM (SELECT nextval('vendor_code_seq') AS n) AS next
$$;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "vendor_code" text;--> statement-breakpoint
UPDATE "vendors" AS v SET "vendor_code" = numbered.code
  FROM (SELECT id, 'HPV-' || lpad(row_number() OVER (ORDER BY created_at, id)::text, 5, '0') AS code FROM "vendors") AS numbered
  WHERE v.id = numbered.id;--> statement-breakpoint
SELECT setval('vendor_code_seq', greatest((SELECT count(*) FROM "vendors"), 1), (SELECT count(*) FROM "vendors") > 0);--> statement-breakpoint
ALTER TABLE "vendors" ALTER COLUMN "vendor_code" SET DEFAULT next_vendor_code();--> statement-breakpoint
ALTER TABLE "vendors" ALTER COLUMN "vendor_code" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_messages" ADD CONSTRAINT "notification_messages_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_reads" ADD CONSTRAINT "notification_reads_message_id_notification_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."notification_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_reads" ADD CONSTRAINT "notification_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_recipients" ADD CONSTRAINT "notification_recipients_message_id_notification_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."notification_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_recipients" ADD CONSTRAINT "notification_recipients_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_messages_audience_created_idx" ON "notification_messages" USING btree ("audience","created_at","id");--> statement-breakpoint
CREATE INDEX "notification_messages_created_by_user_id_idx" ON "notification_messages" USING btree ("created_by_user_id") WHERE "notification_messages"."created_by_user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "notification_reads_user_idx" ON "notification_reads" USING btree ("user_id","message_id");--> statement-breakpoint
CREATE INDEX "notification_recipients_user_idx" ON "notification_recipients" USING btree ("user_id","message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uidx" ON "users" USING btree ("email") WHERE "users"."email" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_vendor_code_unique" UNIQUE("vendor_code");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_email_check" CHECK ("users"."email" IS NULL OR ("users"."email" = lower(btrim("users"."email")) AND "users"."email" LIKE '_%@_%'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_deletion_requested_check" CHECK (("users"."account_status" = 'DELETED_REQUESTED') = ("users"."deletion_requested_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_vendor_code_check" CHECK ("vendors"."vendor_code" ~ '^HPV-[0-9]{5,}$');