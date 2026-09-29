-- The single-entry vendor wallet ledger is replaced by the double-entry ledger (0005/0006).
-- Refuse to run if it holds history: those rows would need a data migration into
-- ledger_transactions / ledger_entries, not a silent drop.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "wallet_ledgers") THEN
    RAISE EXCEPTION 'wallet_ledgers contains rows; migrate them to the double-entry ledger before dropping';
  END IF;
END;
$$;
--> statement-breakpoint
DROP TABLE "wallet_ledgers" CASCADE;--> statement-breakpoint
DROP TYPE "public"."wallet_ledger_entry_type";--> statement-breakpoint
-- Trigger functions that only served wallet_ledgers (the triggers went with the table).
DROP FUNCTION apply_wallet_ledger_entry();--> statement-breakpoint
DROP FUNCTION reject_wallet_ledger_mutation();
