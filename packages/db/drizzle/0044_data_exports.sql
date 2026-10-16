-- Step 7.6 (2026-10-16, SPEC core 11): queued data exports, built by the worker and emailed
-- through Amazon SES (attached under 7 MB, else linked for 7 days behind sign-in).
CREATE TYPE "public"."export_delivery" AS ENUM('ATTACHMENT', 'LINK');--> statement-breakpoint
CREATE TYPE "public"."export_job_status" AS ENUM('QUEUED', 'RUNNING', 'DONE', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."export_kind" AS ENUM('STATEMENT', 'ORDERS', 'INVOICES', 'VENDORS', 'CUSTOMERS', 'PAYOUTS', 'AUDIT_LOG');--> statement-breakpoint
CREATE TABLE "export_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"role" "user_role" NOT NULL,
	"kind" "export_kind" NOT NULL,
	"params" jsonb NOT NULL,
	"email" text NOT NULL,
	"status" "export_job_status" DEFAULT 'QUEUED' NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"file_key" text,
	"delivery" "export_delivery",
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	CONSTRAINT "export_jobs_row_count_check" CHECK ("export_jobs"."row_count" >= 0),
	CONSTRAINT "export_jobs_params_check" CHECK (jsonb_typeof("export_jobs"."params") = 'object'),
	CONSTRAINT "export_jobs_file_key_check" CHECK ("export_jobs"."file_key" IS NULL OR "export_jobs"."file_key" ~ '^exports/[0-9a-f-]{36}\.zip$'),
	CONSTRAINT "export_jobs_outcome_check" CHECK (("export_jobs"."status" IN ('DONE', 'FAILED')) = ("export_jobs"."finished_at" IS NOT NULL)
        AND ("export_jobs"."status" = 'DONE') = ("export_jobs"."delivery" IS NOT NULL)
        AND ("export_jobs"."delivery" IS DISTINCT FROM 'LINK' OR "export_jobs"."expires_at" IS NOT NULL)
        AND ("export_jobs"."file_key" IS NULL OR "export_jobs"."delivery" = 'LINK')
        AND ("export_jobs"."status" <> 'FAILED' OR "export_jobs"."error" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "export_jobs_requested_by_idx" ON "export_jobs" USING btree ("requested_by_user_id","created_at");--> statement-breakpoint
CREATE INDEX "export_jobs_expires_idx" ON "export_jobs" USING btree ("expires_at") WHERE "export_jobs"."file_key" IS NOT NULL;