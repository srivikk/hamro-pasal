-- 2026-10-21 (decided by the user; SPEC core 4, 5, 9 and 12 amended): the customer's stored-value
-- wallet (payment method WALLET, a CUSTOMER_WALLET ledger account per customer), gateway recharges
-- of a customer wallet or a shop ledger (wallet_recharges),
-- settlement Model C activated (a shop's own encrypted eSewa / Khalti merchant accounts and the
-- Fixed Reserve in platform_settings), and the Billing Cycle's dues notice on vendors.
--
-- Hand-edited: the enum values added here cannot be used in this transaction, so every new CHECK
-- compares as text; the ledger account guard learns the new owner column; the two new tables get
-- the set_updated_at trigger. WALLET is never stored in vendors.accepted_payment_methods (a shop
-- takes the wallet wherever it takes eSewa / Khalti), so nothing is backfilled.
ALTER TYPE "public"."ledger_account_type" ADD VALUE 'CUSTOMER_WALLET';--> statement-breakpoint
ALTER TYPE "public"."ledger_transaction_kind" ADD VALUE 'CUSTOMER_WALLET_RECHARGE';--> statement-breakpoint
ALTER TYPE "public"."ledger_transaction_kind" ADD VALUE 'WALLET_PAYMENT';--> statement-breakpoint
ALTER TYPE "public"."ledger_transaction_kind" ADD VALUE 'ORDER_FEE_DEBIT';--> statement-breakpoint
ALTER TYPE "public"."ledger_transaction_kind" ADD VALUE 'ORDER_REFUND';--> statement-breakpoint
ALTER TYPE "public"."payment_method" ADD VALUE 'WALLET';--> statement-breakpoint
CREATE TABLE "vendor_gateway_accounts" (
	"vendor_id" uuid NOT NULL,
	"gateway" "payment_method" NOT NULL,
	"merchant_code" text NOT NULL,
	"secret_ciphertext" "bytea" NOT NULL,
	"secret_hint" text NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_gateway_accounts_pkey" PRIMARY KEY("vendor_id","gateway"),
	CONSTRAINT "vendor_gateway_accounts_gateway_check" CHECK ("vendor_gateway_accounts"."gateway"::text IN ('ESEWA', 'KHALTI')),
	CONSTRAINT "vendor_gateway_accounts_merchant_code_check" CHECK ("vendor_gateway_accounts"."merchant_code" ~ '^[A-Za-z0-9_-]{2,100}$'),
	CONSTRAINT "vendor_gateway_accounts_hint_check" CHECK (length("vendor_gateway_accounts"."secret_hint") = 4),
	CONSTRAINT "vendor_gateway_accounts_verification_check" CHECK (("vendor_gateway_accounts"."verified_at" IS NULL) = ("vendor_gateway_accounts"."verified_by_user_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "wallet_recharges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"vendor_id" uuid,
	"gateway" "payment_method" NOT NULL,
	"amount_npr" numeric(12, 2) NOT NULL,
	"idempotency_key" text NOT NULL,
	"gateway_ref" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"transaction_id" uuid,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_recharges_user_key_key" UNIQUE("user_id","idempotency_key"),
	CONSTRAINT "wallet_recharges_amount_check" CHECK ("wallet_recharges"."amount_npr" > 0),
	CONSTRAINT "wallet_recharges_gateway_check" CHECK ("wallet_recharges"."gateway"::text IN ('ESEWA', 'KHALTI')),
	CONSTRAINT "wallet_recharges_status_check" CHECK ("wallet_recharges"."status" IN ('PENDING', 'COMPLETED', 'FAILED')
        AND ("wallet_recharges"."status" = 'COMPLETED') = ("wallet_recharges"."transaction_id" IS NOT NULL)
        AND ("wallet_recharges"."status" = 'PENDING') = ("wallet_recharges"."completed_at" IS NULL)),
	CONSTRAINT "wallet_recharges_key_check" CHECK (btrim("wallet_recharges"."idempotency_key") <> '')
);
--> statement-breakpoint
ALTER TABLE "ledger_accounts" DROP CONSTRAINT "ledger_accounts_owner_check";--> statement-breakpoint
ALTER TABLE "ledger_accounts" DROP CONSTRAINT "ledger_accounts_gateway_check";--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD COLUMN "customer_user_id" uuid;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "dues_notice_opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "dues_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "dues_amount_npr" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "prepaid_reserve_npr" numeric(12, 2) DEFAULT 5000 NOT NULL;--> statement-breakpoint
ALTER TABLE "vendor_gateway_accounts" ADD CONSTRAINT "vendor_gateway_accounts_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_gateway_accounts" ADD CONSTRAINT "vendor_gateway_accounts_verified_by_user_id_users_id_fk" FOREIGN KEY ("verified_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_recharges" ADD CONSTRAINT "wallet_recharges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_recharges" ADD CONSTRAINT "wallet_recharges_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_recharges" ADD CONSTRAINT "wallet_recharges_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vendor_gateway_accounts_verified_by_user_id_idx" ON "vendor_gateway_accounts" USING btree ("verified_by_user_id") WHERE "vendor_gateway_accounts"."verified_by_user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_gateway_accounts_merchant_uidx" ON "vendor_gateway_accounts" USING btree ("gateway","merchant_code");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_recharges_gateway_ref_uidx" ON "wallet_recharges" USING btree ("gateway","gateway_ref");--> statement-breakpoint
CREATE INDEX "wallet_recharges_user_id_idx" ON "wallet_recharges" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "wallet_recharges_vendor_id_idx" ON "wallet_recharges" USING btree ("vendor_id") WHERE "wallet_recharges"."vendor_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "wallet_recharges_transaction_id_idx" ON "wallet_recharges" USING btree ("transaction_id") WHERE "wallet_recharges"."transaction_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_customer_user_id_users_id_fk" FOREIGN KEY ("customer_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vendors_dues_due_at_idx" ON "vendors" USING btree ("dues_due_at") WHERE "vendors"."dues_due_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_customer_user_id_key" UNIQUE("customer_user_id");--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_customer_wallet_non_negative_check" CHECK ("ledger_accounts"."account_type"::text <> 'CUSTOMER_WALLET' OR "ledger_accounts"."balance_npr" >= 0);--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_owner_check" CHECK ((("ledger_accounts"."account_type" = 'VENDOR_WALLET') = ("ledger_accounts"."vendor_id" IS NOT NULL))
        AND (("ledger_accounts"."account_type" = 'DRIVER_WALLET') = ("ledger_accounts"."driver_user_id" IS NOT NULL))
        AND (("ledger_accounts"."account_type" = 'GATEWAY_CLEARING') = ("ledger_accounts"."gateway" IS NOT NULL))
        AND (("ledger_accounts"."account_type"::text = 'VENDOR_DISPUTE_HOLD') = ("ledger_accounts"."hold_vendor_id" IS NOT NULL))
        AND (("ledger_accounts"."account_type"::text = 'CUSTOMER_WALLET') = ("ledger_accounts"."customer_user_id" IS NOT NULL)));--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_gateway_check" CHECK ("ledger_accounts"."gateway" IS NULL OR "ledger_accounts"."gateway"::text IN ('ESEWA', 'KHALTI'));--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_dues_notice_check" CHECK (("vendors"."dues_notice_opened_at" IS NULL) = ("vendors"."dues_due_at" IS NULL)
        AND ("vendors"."dues_due_at" IS NULL) = ("vendors"."dues_amount_npr" IS NULL)
        AND ("vendors"."dues_amount_npr" IS NULL OR "vendors"."dues_amount_npr" > 0)
        AND ("vendors"."dues_due_at" IS NULL OR "vendors"."dues_due_at" > "vendors"."dues_notice_opened_at"));--> statement-breakpoint
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_prepaid_reserve_check" CHECK ("platform_settings"."prepaid_reserve_npr" >= 5000);--> statement-breakpoint
CREATE TRIGGER vendor_gateway_accounts_set_updated_at BEFORE UPDATE ON vendor_gateway_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER wallet_recharges_set_updated_at BEFORE UPDATE ON wallet_recharges
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
-- The owner of a customer wallet is as immutable as every other owner column (hand-added).
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

  IF (NEW.account_type, NEW.vendor_id, NEW.driver_user_id, NEW.gateway, NEW.hold_vendor_id, NEW.customer_user_id)
     IS DISTINCT FROM (OLD.account_type, OLD.vendor_id, OLD.driver_user_id, OLD.gateway, OLD.hold_vendor_id, OLD.customer_user_id) THEN
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