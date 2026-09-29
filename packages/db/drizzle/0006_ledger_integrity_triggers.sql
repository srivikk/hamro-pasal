-- =============================================================================
-- 0006: Double-entry ledger integrity
--   1. Reference accounts (escrow, revenue, gateway clearing) and vendor wallet accounts
--   2. Balanced-journal enforcement (deferred to COMMIT)
--   3. Posting application: account balances + vendors.wallet_balance_npr projection
--   4. Projection guards: balances move only through postings
--   5. Append-only journal and postings
--
-- Posting convention: amount_npr is the signed change to the account's balance, and every
-- journal transaction's postings sum to exactly 0 (value moves, it is never created or lost).
-- =============================================================================

-- 1. Accounts -------------------------------------------------------------------
CREATE TRIGGER ledger_accounts_set_updated_at BEFORE UPDATE ON ledger_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
INSERT INTO ledger_accounts (account_type) VALUES ('SYSTEM_ESCROW'), ('PLATFORM_REVENUE');
--> statement-breakpoint
INSERT INTO ledger_accounts (account_type, gateway) VALUES ('GATEWAY_CLEARING', 'ESEWA'), ('GATEWAY_CLEARING', 'KHALTI');
--> statement-breakpoint
-- A vendor balance not backed by postings cannot be carried over silently.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM vendors WHERE wallet_balance_npr <> 0) THEN
    RAISE EXCEPTION 'vendors with a non-zero wallet_balance_npr need an opening-balance journal before this migration';
  END IF;
END;
$$;
--> statement-breakpoint
INSERT INTO ledger_accounts (account_type, vendor_id) SELECT 'VENDOR_WALLET', id FROM vendors;
--> statement-breakpoint
-- Every vendor gets exactly one wallet account, created with the vendor.
CREATE FUNCTION create_vendor_wallet_account() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO ledger_accounts (account_type, vendor_id) VALUES ('VENDOR_WALLET', NEW.id);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER vendors_create_wallet_account AFTER INSERT ON vendors
  FOR EACH ROW EXECUTE FUNCTION create_vendor_wallet_account();
--> statement-breakpoint

-- 2. Balanced journals ------------------------------------------------------------
-- Deferred to COMMIT so a service can insert the header and all postings in any order.
-- Fires for the header too, so a header with no postings cannot commit.
CREATE FUNCTION assert_ledger_transaction_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_transaction_id uuid;
  v_sum numeric;
  v_count integer;
BEGIN
  IF TG_TABLE_NAME = 'ledger_entries' THEN
    v_transaction_id := NEW.transaction_id;
  ELSE
    v_transaction_id := NEW.id;
  END IF;

  SELECT coalesce(sum(amount_npr), 0), count(*) INTO v_sum, v_count
  FROM ledger_entries
  WHERE transaction_id = v_transaction_id;

  IF v_count < 2 OR v_sum <> 0 THEN
    RAISE EXCEPTION 'Ledger transaction % is unbalanced: % posting(s) summing to % NPR',
        v_transaction_id, v_count, v_sum
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_ledger_transaction_balanced();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_transactions_balanced AFTER INSERT ON ledger_transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_ledger_transaction_balanced();
--> statement-breakpoint

-- 3. Posting application ------------------------------------------------------------
-- Postings may only be added in the DB transaction that created their journal header, so a
-- committed journal can never gain extra (even balanced) postings later. The header's
-- created_at defaults to now(), the start time of the top-level transaction. Unlike xmin,
-- that value is identical inside savepoints, which Drizzle uses for nested transactions.
CREATE FUNCTION apply_ledger_entry() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_header_created_at timestamptz;
  v_account_type ledger_account_type;
  v_vendor_id uuid;
BEGIN
  SELECT created_at INTO v_header_created_at FROM ledger_transactions WHERE id = NEW.transaction_id;
  IF v_header_created_at IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'Postings can only be added in the transaction that created ledger transaction %',
        NEW.transaction_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  PERFORM set_config('hamro.ledger_posting', 'on', true);

  UPDATE ledger_accounts
  SET balance_npr = balance_npr + NEW.amount_npr
  WHERE id = NEW.account_id
  RETURNING account_type, vendor_id INTO v_account_type, v_vendor_id;

  -- The vendors row carries the SPEC §5 floor CHECK and suspension trigger, so the vendor
  -- wallet projection is updated in the same statement. A breaching debit therefore
  -- suspends the vendor (or fails) atomically with the posting.
  IF v_account_type = 'VENDOR_WALLET' THEN
    UPDATE vendors
    SET wallet_balance_npr = wallet_balance_npr + NEW.amount_npr
    WHERE id = v_vendor_id;
  END IF;

  PERFORM set_config('hamro.ledger_posting', 'off', true);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_apply AFTER INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION apply_ledger_entry();
--> statement-breakpoint

-- 4. Projection guards --------------------------------------------------------------
CREATE FUNCTION guard_ledger_account_mutation() RETURNS trigger
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

  IF (NEW.account_type, NEW.vendor_id, NEW.driver_user_id, NEW.gateway)
     IS DISTINCT FROM (OLD.account_type, OLD.vendor_id, OLD.driver_user_id, OLD.gateway) THEN
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
--> statement-breakpoint
CREATE TRIGGER ledger_accounts_guard BEFORE INSERT OR UPDATE OR DELETE ON ledger_accounts
  FOR EACH ROW EXECUTE FUNCTION guard_ledger_account_mutation();
--> statement-breakpoint
CREATE FUNCTION guard_vendor_wallet_projection() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.wallet_balance_npr <> 0 THEN
      RAISE EXCEPTION 'Vendors must open with a 0 NPR wallet; post a journal transaction instead'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF NEW.wallet_balance_npr IS DISTINCT FROM OLD.wallet_balance_npr
        AND current_setting('hamro.ledger_posting', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'vendors.wallet_balance_npr is a projection of the VENDOR_WALLET ledger account; post a journal transaction instead'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- Named to sort before vendors_enforce_wallet_limit: BEFORE triggers fire alphabetically.
CREATE TRIGGER vendors_a_guard_wallet_projection BEFORE INSERT OR UPDATE ON vendors
  FOR EACH ROW EXECUTE FUNCTION guard_vendor_wallet_projection();
--> statement-breakpoint

-- 5. Append-only journal ------------------------------------------------------------
CREATE FUNCTION reject_ledger_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% rejected); post a compensating ADJUSTMENT instead',
      TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ledger_transactions_append_only BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
--> statement-breakpoint
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
