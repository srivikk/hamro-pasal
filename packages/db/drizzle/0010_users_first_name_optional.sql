-- Phase 7: OTP sign-up creates a customer from the phone number alone, so first_name becomes
-- optional (like last_name). A present name must still be non-blank.
ALTER TABLE "users" DROP CONSTRAINT "users_first_name_check";--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "first_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_first_name_check" CHECK ("users"."first_name" IS NULL OR btrim("users"."first_name") <> '');