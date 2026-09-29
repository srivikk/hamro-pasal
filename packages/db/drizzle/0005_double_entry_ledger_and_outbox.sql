CREATE TYPE "public"."ledger_account_type" AS ENUM('SYSTEM_ESCROW', 'PLATFORM_REVENUE', 'GATEWAY_CLEARING', 'VENDOR_WALLET', 'DRIVER_WALLET');--> statement-breakpoint
CREATE TYPE "public"."ledger_transaction_kind" AS ENUM('PAYMENT_CAPTURE', 'ORDER_SETTLEMENT', 'VENDOR_TOP_UP', 'ADJUSTMENT');--> statement-breakpoint
CREATE TABLE "ledger_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_type" "ledger_account_type" NOT NULL,
	"vendor_id" uuid,
	"driver_user_id" uuid,
	"gateway" "payment_method",
	"balance_npr" numeric(12, 2) DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_accounts_vendor_id_key" UNIQUE("vendor_id"),
	CONSTRAINT "ledger_accounts_driver_user_id_key" UNIQUE("driver_user_id"),
	CONSTRAINT "ledger_accounts_gateway_key" UNIQUE("gateway"),
	CONSTRAINT "ledger_accounts_owner_check" CHECK ((("ledger_accounts"."account_type" = 'VENDOR_WALLET') = ("ledger_accounts"."vendor_id" IS NOT NULL))
        AND (("ledger_accounts"."account_type" = 'DRIVER_WALLET') = ("ledger_accounts"."driver_user_id" IS NOT NULL))
        AND (("ledger_accounts"."account_type" = 'GATEWAY_CLEARING') = ("ledger_accounts"."gateway" IS NOT NULL))),
	CONSTRAINT "ledger_accounts_gateway_check" CHECK ("ledger_accounts"."gateway" IS DISTINCT FROM 'COD'),
	CONSTRAINT "ledger_accounts_escrow_non_negative_check" CHECK ("ledger_accounts"."account_type" <> 'SYSTEM_ESCROW' OR "ledger_accounts"."balance_npr" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"amount_npr" numeric(12, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_amount_non_zero_check" CHECK ("ledger_entries"."amount_npr" <> 0)
);
--> statement-breakpoint
CREATE TABLE "ledger_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "ledger_transaction_kind" NOT NULL,
	"idempotency_key" text NOT NULL,
	"order_id" uuid,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_transactions_idempotency_key_key" UNIQUE("idempotency_key"),
	CONSTRAINT "ledger_transactions_idempotency_key_check" CHECK (btrim("ledger_transactions"."idempotency_key") <> ''),
	CONSTRAINT "ledger_transactions_description_check" CHECK ("ledger_transactions"."description" IS NULL OR btrim("ledger_transactions"."description") <> '')
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"topic" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"published_at" timestamp with time zone,
	"publish_attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	CONSTRAINT "outbox_events_publish_attempts_check" CHECK ("outbox_events"."publish_attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "driver_user_id" uuid;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_driver_user_id_users_id_fk" FOREIGN KEY ("driver_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_ledger_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_system_singleton_idx" ON "ledger_accounts" USING btree ("account_type") WHERE "ledger_accounts"."account_type" IN ('SYSTEM_ESCROW', 'PLATFORM_REVENUE');--> statement-breakpoint
CREATE INDEX "ledger_entries_transaction_id_idx" ON "ledger_entries" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_account_id_created_at_idx" ON "ledger_entries" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "ledger_transactions_order_id_idx" ON "ledger_transactions" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "outbox_events_unpublished_idx" ON "outbox_events" USING btree ("occurred_at","id") WHERE "outbox_events"."published_at" IS NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_driver_user_id_users_id_fk" FOREIGN KEY ("driver_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_fleet_delivered_has_driver_check" CHECK ("orders"."fulfillment_locked" = 'SELF_DELIVERY' OR "orders"."state" <> 'DELIVERED' OR "orders"."driver_user_id" IS NOT NULL);