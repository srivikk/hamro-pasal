-- Phase 22: financial reconciliation and payouts. payout_requests is a vendor withdrawal (the amount
-- is held by a VENDOR_PAYOUT journal when requested); orders.reconciled_at is stamped by the nightly
-- reconciliation. No balance table: vendor money stays in the double-entry ledger (SPEC 5).
-- The new enum values are not used in this file: a value added to an existing enum cannot be used
-- before its transaction commits, so the PAYOUT_CLEARING account is opened by the first payout.
CREATE TYPE "public"."payout_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED');--> statement-breakpoint
ALTER TYPE "public"."ledger_account_type" ADD VALUE 'PAYOUT_CLEARING';--> statement-breakpoint
ALTER TYPE "public"."ledger_transaction_kind" ADD VALUE 'VENDOR_PAYOUT';--> statement-breakpoint
ALTER TYPE "public"."ledger_transaction_kind" ADD VALUE 'VENDOR_PAYOUT_REVERSAL';--> statement-breakpoint
CREATE TABLE "payout_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"amount_npr" numeric(12, 2) NOT NULL,
	"status" "payout_status" DEFAULT 'PENDING' NOT NULL,
	"idempotency_key" text NOT NULL,
	"hold_transaction_id" uuid NOT NULL,
	"reversal_transaction_id" uuid,
	"bank_reference" text,
	"rejection_reason" text,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payout_requests_vendor_id_idempotency_key_key" UNIQUE("vendor_id","idempotency_key"),
	CONSTRAINT "payout_requests_hold_transaction_id_key" UNIQUE("hold_transaction_id"),
	CONSTRAINT "payout_requests_amount_check" CHECK ("payout_requests"."amount_npr" > 0),
	CONSTRAINT "payout_requests_idempotency_key_check" CHECK (btrim("payout_requests"."idempotency_key") <> ''),
	CONSTRAINT "payout_requests_status_check" CHECK (("payout_requests"."status" = 'PENDING' AND "payout_requests"."decided_at" IS NULL AND "payout_requests"."decided_by_user_id" IS NULL
            AND "payout_requests"."bank_reference" IS NULL AND "payout_requests"."reversal_transaction_id" IS NULL
            AND "payout_requests"."rejection_reason" IS NULL)
        OR ("payout_requests"."status" = 'APPROVED' AND "payout_requests"."decided_at" IS NOT NULL
            AND "payout_requests"."decided_by_user_id" IS NOT NULL AND "payout_requests"."bank_reference" IS NOT NULL
            AND btrim("payout_requests"."bank_reference") <> ''
            AND "payout_requests"."reversal_transaction_id" IS NULL AND "payout_requests"."rejection_reason" IS NULL)
        OR ("payout_requests"."status" = 'REJECTED' AND "payout_requests"."decided_at" IS NOT NULL
            AND "payout_requests"."decided_by_user_id" IS NOT NULL AND "payout_requests"."bank_reference" IS NULL
            AND "payout_requests"."reversal_transaction_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "reconciled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payout_requests" ADD CONSTRAINT "payout_requests_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_requests" ADD CONSTRAINT "payout_requests_hold_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("hold_transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_requests" ADD CONSTRAINT "payout_requests_reversal_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("reversal_transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_requests" ADD CONSTRAINT "payout_requests_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payout_requests_vendor_id_created_at_idx" ON "payout_requests" USING btree ("vendor_id","created_at");--> statement-breakpoint
CREATE INDEX "payout_requests_created_at_idx" ON "payout_requests" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "payout_requests_status_created_at_idx" ON "payout_requests" USING btree ("status","created_at","id");--> statement-breakpoint
CREATE INDEX "orders_unreconciled_idx" ON "orders" USING btree ("delivered_at","id") WHERE "orders"."state" = 'DELIVERED' AND "orders"."reconciled_at" IS NULL;--> statement-breakpoint
CREATE INDEX "orders_vendor_id_reconciled_at_idx" ON "orders" USING btree ("vendor_id","reconciled_at");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_reconciled_at_check" CHECK ("orders"."reconciled_at" IS NULL OR "orders"."state" IN ('DELIVERED', 'DISPUTED'));--> statement-breakpoint
CREATE TRIGGER payout_requests_set_updated_at BEFORE UPDATE ON payout_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
