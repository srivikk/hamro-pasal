-- 2026-10-21: automated IRD PAN verification. The ird_pan_checks state machine (the admin's
-- "Action Required: Manual Review" queue), and vendors.pan_verified_by_job for a PAN the job
-- verified (no admin did): the verification CHECK now takes exactly one of the user or the job.
CREATE TYPE "public"."ird_pan_check_status" AS ENUM('QUEUED', 'RUNNING', 'VERIFIED', 'MANUAL_REVIEW', 'SUPERSEDED', 'RESOLVED');--> statement-breakpoint
CREATE TYPE "public"."ird_review_reason" AS ENUM('NAME_MISMATCH', 'PAN_NOT_FOUND', 'IRD_ACCOUNT_INACTIVE', 'LAYOUT_CHANGED', 'SCRAPER_FAILED', 'AUTOMATION_DISABLED', 'DOCUMENT_MISSING');--> statement-breakpoint
CREATE TABLE "ird_pan_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"tax_id" text NOT NULL,
	"status" "ird_pan_check_status" DEFAULT 'QUEUED' NOT NULL,
	"review_reason" "ird_review_reason",
	"attempts" integer DEFAULT 0 NOT NULL,
	"ird_business_name" text,
	"ird_registration_date" text,
	"name_similarity" numeric(4, 3),
	"last_error" text,
	"resolved_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "ird_pan_checks_tax_id_check" CHECK ("ird_pan_checks"."tax_id" ~ '^[0-9]{9}$'),
	CONSTRAINT "ird_pan_checks_attempts_check" CHECK ("ird_pan_checks"."attempts" BETWEEN 0 AND 3),
	CONSTRAINT "ird_pan_checks_similarity_check" CHECK ("ird_pan_checks"."name_similarity" IS NULL OR "ird_pan_checks"."name_similarity" BETWEEN 0 AND 1),
	CONSTRAINT "ird_pan_checks_state_check" CHECK (("ird_pan_checks"."status" IN ('MANUAL_REVIEW', 'RESOLVED')) = ("ird_pan_checks"."review_reason" IS NOT NULL)
        AND ("ird_pan_checks"."status" IN ('VERIFIED', 'MANUAL_REVIEW', 'RESOLVED', 'SUPERSEDED')) = ("ird_pan_checks"."completed_at" IS NOT NULL)
        AND ("ird_pan_checks"."status" = 'RESOLVED') = ("ird_pan_checks"."resolved_by_user_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "vendors" DROP CONSTRAINT "vendors_pan_verification_check";--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "pan_verified_by_job" text;--> statement-breakpoint
ALTER TABLE "ird_pan_checks" ADD CONSTRAINT "ird_pan_checks_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ird_pan_checks" ADD CONSTRAINT "ird_pan_checks_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ird_pan_checks_open_uidx" ON "ird_pan_checks" USING btree ("vendor_id") WHERE "ird_pan_checks"."status" IN ('QUEUED', 'RUNNING', 'MANUAL_REVIEW');--> statement-breakpoint
CREATE INDEX "ird_pan_checks_vendor_idx" ON "ird_pan_checks" USING btree ("vendor_id","created_at");--> statement-breakpoint
CREATE INDEX "ird_pan_checks_review_idx" ON "ird_pan_checks" USING btree ("created_at") WHERE "ird_pan_checks"."status" = 'MANUAL_REVIEW';--> statement-breakpoint
CREATE INDEX "ird_pan_checks_resolved_by_user_id_idx" ON "ird_pan_checks" USING btree ("resolved_by_user_id") WHERE "ird_pan_checks"."resolved_by_user_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_pan_verification_check" CHECK (("vendors"."pan_verified_at" IS NULL) = (num_nonnulls("vendors"."pan_verified_by_user_id", "vendors"."pan_verified_by_job") = 0) AND num_nonnulls("vendors"."pan_verified_by_user_id", "vendors"."pan_verified_by_job") <= 1 AND ("vendors"."pan_verified_at" IS NULL OR "vendors"."tax_id" IS NOT NULL));--> statement-breakpoint
CREATE TRIGGER ird_pan_checks_set_updated_at BEFORE UPDATE ON "ird_pan_checks" FOR EACH ROW EXECUTE FUNCTION set_updated_at();