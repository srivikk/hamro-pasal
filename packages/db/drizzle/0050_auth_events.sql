-- 2026-10-21 (Task 5): the Authentication Logs. One row per login-code send and check, by
-- number; never the code itself (codes stay a keyed hash in Redis, plus an AES-GCM copy for its
-- 2-minute life only where OTP_ADMIN_REVEAL is on).
CREATE TABLE "auth_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"user_id" uuid,
	"kind" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_events_kind_check" CHECK (kind IN ('OTP_SENT', 'OTP_SEND_FAILED', 'OTP_COOLDOWN', 'OTP_VERIFIED', 'OTP_WRONG', 'OTP_LOCKED', 'OTP_EXPIRED')),
	CONSTRAINT "auth_events_phone_check" CHECK ("auth_events"."phone" ~ '^\+977[0-9]{10}$')
);
--> statement-breakpoint
ALTER TABLE "auth_events" ADD CONSTRAINT "auth_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_events_created_at_idx" ON "auth_events" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "auth_events_phone_created_at_idx" ON "auth_events" USING btree ("phone","created_at");