-- Step 7.3 (2026-10-15, SPEC core 6): order conversations open from placement until 7 days after
-- delivery, their escalation to Hamro Pasal, the 7-day hold of a prepaid order's earnings, its
-- day-8 release and the Super Admin's resolution. Refunds are recorded in REFUND_CLEARING and paid
-- by hand (decided 2026-10-15).
--
-- Hand-edited: the enum values added here cannot be used in this transaction, so the new CHECKs
-- compare ledger_account_type as text; dispute_status is created anew (not ADD VALUE), so its new
-- values can be used below. Existing OPEN disputes were raised to an admin-visible chat: they
-- become ESCALATED. Orders delivered before this migration keep their wallet credit (nothing is
-- moved); only new prepaid deliveries are held.
ALTER TYPE "public"."ledger_account_type" ADD VALUE 'VENDOR_DISPUTE_HOLD';--> statement-breakpoint
ALTER TYPE "public"."ledger_account_type" ADD VALUE 'REFUND_CLEARING';--> statement-breakpoint
ALTER TYPE "public"."ledger_line_type" ADD VALUE 'DISPUTE_HOLD';--> statement-breakpoint
ALTER TYPE "public"."ledger_line_type" ADD VALUE 'DISPUTE_RELEASE';--> statement-breakpoint
ALTER TYPE "public"."ledger_line_type" ADD VALUE 'DISPUTE_REFUND';--> statement-breakpoint
ALTER TYPE "public"."ledger_transaction_kind" ADD VALUE 'DISPUTE_HOLD_RELEASE';--> statement-breakpoint
ALTER TYPE "public"."ledger_transaction_kind" ADD VALUE 'DISPUTE_REFUND';--> statement-breakpoint
ALTER TABLE "disputes" DROP CONSTRAINT "disputes_reason_check";--> statement-breakpoint
ALTER TABLE "disputes" DROP CONSTRAINT "disputes_resolution_check";--> statement-breakpoint
ALTER TABLE "ledger_accounts" DROP CONSTRAINT "ledger_accounts_owner_check";--> statement-breakpoint
ALTER TABLE "disputes" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "disputes" ALTER COLUMN "status" SET DEFAULT 'OPEN'::text;--> statement-breakpoint
DROP TYPE "public"."dispute_status";--> statement-breakpoint
CREATE TYPE "public"."dispute_status" AS ENUM('OPEN', 'ESCALATED', 'CLOSED', 'RELEASED_TO_VENDOR', 'REFUNDED_TO_CUSTOMER', 'PARTIALLY_REFUNDED');--> statement-breakpoint
ALTER TABLE "disputes" ALTER COLUMN "status" SET DEFAULT 'OPEN'::"public"."dispute_status";--> statement-breakpoint
ALTER TABLE "disputes" ALTER COLUMN "status" SET DATA TYPE "public"."dispute_status" USING "status"::"public"."dispute_status";--> statement-breakpoint
ALTER TABLE "disputes" ALTER COLUMN "opened_by_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "disputes" ALTER COLUMN "reason" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "escalated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "escalated_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "escalation_reason" text;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "refund_npr" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "resolution_note" text;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "hold_release_transaction_id" uuid;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD COLUMN "hold_vendor_id" uuid;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_escalated_by_user_id_users_id_fk" FOREIGN KEY ("escalated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_hold_release_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("hold_release_transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_hold_vendor_id_vendors_id_fk" FOREIGN KEY ("hold_vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "disputes_escalated_by_user_id_idx" ON "disputes" USING btree ("escalated_by_user_id") WHERE "disputes"."escalated_by_user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "disputes_hold_release_transaction_id_idx" ON "disputes" USING btree ("hold_release_transaction_id") WHERE "disputes"."hold_release_transaction_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "disputes_escalated_at_idx" ON "disputes" USING btree ("escalated_at","id") WHERE "disputes"."escalated_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_hold_vendor_id_key" UNIQUE("hold_vendor_id");--> statement-breakpoint
-- Existing conversations (hand-added). Before step 7.3 every dispute was visible to the admin.
UPDATE "disputes"
   SET "status" = CASE WHEN "status" = 'OPEN' THEN 'ESCALATED'::"public"."dispute_status" ELSE "status" END,
       "escalated_at" = "created_at",
       "escalated_by_user_id" = "opened_by_user_id",
       "escalation_reason" = left('Raised before order conversations: ' || coalesce("reason", 'no reason given'), 500);--> statement-breakpoint
UPDATE "disputes"
   SET "resolution_note" = 'Resolved before order conversations; no amount was recorded.',
       "refund_npr" = 0
 WHERE "status" IN ('RELEASED_TO_VENDOR', 'REFUNDED_TO_CUSTOMER');--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_escalation_check" CHECK (("disputes"."escalated_at" IS NULL) = ("disputes"."escalated_by_user_id" IS NULL)
        AND ("disputes"."escalated_at" IS NULL) = ("disputes"."escalation_reason" IS NULL)
        AND ("disputes"."status" <> 'ESCALATED' OR "disputes"."escalated_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_escalation_reason_check" CHECK ("disputes"."escalation_reason" IS NULL OR length(btrim("disputes"."escalation_reason")) BETWEEN 10 AND 500);--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_refund_check" CHECK ("disputes"."refund_npr" IS NULL OR "disputes"."refund_npr" >= 0);--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_reason_check" CHECK ("disputes"."reason" IS NULL OR btrim("disputes"."reason") <> '');--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_resolution_check" CHECK (("disputes"."status" IN ('OPEN', 'ESCALATED')) = ("disputes"."resolved_at" IS NULL)
        AND ("disputes"."status" IN ('RELEASED_TO_VENDOR', 'REFUNDED_TO_CUSTOMER', 'PARTIALLY_REFUNDED'))
          = ("disputes"."resolved_by_user_id" IS NOT NULL)
        AND ("disputes"."resolved_by_user_id" IS NULL) = ("disputes"."resolution_note" IS NULL)
        AND ("disputes"."resolved_by_user_id" IS NULL) = ("disputes"."refund_npr" IS NULL)
        AND ("disputes"."resolved_by_user_id" IS NULL OR "disputes"."escalated_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_dispute_hold_non_negative_check" CHECK ("ledger_accounts"."account_type"::text <> 'VENDOR_DISPUTE_HOLD' OR "ledger_accounts"."balance_npr" >= 0);--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_owner_check" CHECK ((("ledger_accounts"."account_type" = 'VENDOR_WALLET') = ("ledger_accounts"."vendor_id" IS NOT NULL))
        AND (("ledger_accounts"."account_type" = 'DRIVER_WALLET') = ("ledger_accounts"."driver_user_id" IS NOT NULL))
        AND (("ledger_accounts"."account_type" = 'GATEWAY_CLEARING') = ("ledger_accounts"."gateway" IS NOT NULL))
        AND (("ledger_accounts"."account_type"::text = 'VENDOR_DISPUTE_HOLD') = ("ledger_accounts"."hold_vendor_id" IS NOT NULL)));--> statement-breakpoint
-- The owner of a dispute hold is as immutable as every other owner column (hand-added).
CREATE OR REPLACE FUNCTION guard_ledger_account_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.balance_npr <> 0 THEN
      RAISE EXCEPTION 'Ledger accounts must open at 0 NPR; post a journal transaction instead'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Ledger accounts cannot be deleted'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF (NEW.account_type, NEW.vendor_id, NEW.driver_user_id, NEW.gateway, NEW.hold_vendor_id)
     IS DISTINCT FROM (OLD.account_type, OLD.vendor_id, OLD.driver_user_id, OLD.gateway, OLD.hold_vendor_id) THEN
    RAISE EXCEPTION 'Ledger account type and owner are immutable'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.balance_npr IS DISTINCT FROM OLD.balance_npr
     AND current_setting('hamro.ledger_posting', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'ledger_accounts.balance_npr changes only through ledger postings'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
