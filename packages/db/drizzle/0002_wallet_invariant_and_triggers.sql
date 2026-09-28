-- =============================================================================
-- 0002: Integrity triggers and reference data
--   1. updated_at maintenance
--   2. platform_settings singleton row (reference data)
--   3. Negative wallet invariant (SPEC §5 and edge case #2)
--   4. Append-only wallet ledger
-- =============================================================================

-- 1. updated_at ---------------------------------------------------------------
CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER customer_addresses_set_updated_at BEFORE UPDATE ON customer_addresses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER vendors_set_updated_at BEFORE UPDATE ON vendors
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER products_set_updated_at BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER orders_set_updated_at BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER disputes_set_updated_at BEFORE UPDATE ON disputes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER platform_settings_set_updated_at BEFORE UPDATE ON platform_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

-- 2. Platform settings --------------------------------------------------------
-- SPEC §5: suspension limit is -2000 NPR and Superadmin-configurable within [-2000, 0].
INSERT INTO platform_settings (id, vendor_wallet_suspension_limit_npr) VALUES (true, -2000);
--> statement-breakpoint
-- The wallet trigger requires this row, so it can be updated but never deleted.
CREATE FUNCTION reject_platform_settings_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'platform_settings is a required singleton row and cannot be deleted'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER platform_settings_no_delete BEFORE DELETE ON platform_settings
  FOR EACH ROW EXECUTE FUNCTION reject_platform_settings_delete();
--> statement-breakpoint

-- 3. Negative wallet invariant ------------------------------------------------
-- Fires on every INSERT/UPDATE of a vendor row, including the balance update performed by
-- apply_wallet_ledger_entry(), so the ledger path and direct vendor edits are both covered.
--
-- When the balance drops strictly below the configured limit, the row being written is
-- switched to SUSPENDED. This is equivalent to `UPDATE vendors SET status = 'SUSPENDED' WHERE
-- id = NEW.vendor_id`, but runs as a BEFORE trigger so it lands in the same row version.
-- That lets vendors_wallet_balance_floor_check (balance >= -2000 OR SUSPENDED) accept the
-- breaching debit instead of rolling it back, so the commission owed is never lost.
-- A separate UPDATE from an AFTER trigger would be too late, because the CHECK has already
-- failed the original write.
CREATE FUNCTION enforce_vendor_wallet_limit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_limit numeric(12, 2);
  v_depth numeric(12, 2);
BEGIN
  IF NEW.wallet_balance_npr >= 0 THEN
    RETURN NEW;
  END IF;

  -- Depth: how far the wallet is below zero.
  v_depth := -NEW.wallet_balance_npr;

  SELECT vendor_wallet_suspension_limit_npr INTO STRICT v_limit
  FROM platform_settings
  WHERE id;

  IF NEW.wallet_balance_npr >= v_limit THEN
    RETURN NEW;
  END IF;

  -- Below the limit: a suspended vendor cannot be reactivated until the debt is cleared.
  IF TG_OP = 'UPDATE' AND OLD.status = 'SUSPENDED' AND NEW.status <> 'SUSPENDED' THEN
    RAISE EXCEPTION 'Vendor % cannot leave SUSPENDED while wallet balance (% NPR) is below the limit (% NPR)',
        NEW.id, NEW.wallet_balance_npr, v_limit
      USING ERRCODE = 'check_violation',
            HINT = 'Clear the negative balance with a TOP_UP ledger entry first.';
  END IF;

  IF NEW.status <> 'SUSPENDED' THEN
    NEW.status := 'SUSPENDED';
    -- Delivered to LISTENers only if the transaction commits. Consumed by the backend for the
    -- structured audit log that SPEC requires for vendor auto-suspension events.
    PERFORM pg_notify(
      'vendor_wallet_suspended',
      json_build_object(
        'vendor_id', NEW.id,
        'wallet_balance_npr', NEW.wallet_balance_npr,
        'depth_npr', v_depth,
        'limit_npr', v_limit
      )::text
    );
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER vendors_enforce_wallet_limit BEFORE INSERT OR UPDATE ON vendors
  FOR EACH ROW EXECUTE FUNCTION enforce_vendor_wallet_limit();
--> statement-breakpoint

-- Applies each ledger entry to the vendor's wallet.
-- AFTER INSERT on purpose: BEFORE INSERT triggers also fire for rows that
-- `INSERT ... ON CONFLICT DO NOTHING` then skips. A duplicate webhook would then move the
-- balance twice while recording one ledger row. AFTER triggers fire only for rows actually
-- inserted. The UPDATE takes the vendor row lock, so concurrent entries serialise.
CREATE FUNCTION apply_wallet_ledger_entry() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE vendors
  SET wallet_balance_npr = wallet_balance_npr + NEW.amount_npr
  WHERE id = NEW.vendor_id;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER wallet_ledgers_apply_entry AFTER INSERT ON wallet_ledgers
  FOR EACH ROW EXECUTE FUNCTION apply_wallet_ledger_entry();
--> statement-breakpoint

-- 4. Append-only ledger -------------------------------------------------------
CREATE FUNCTION reject_wallet_ledger_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'wallet_ledgers is append-only (% rejected); post a compensating ADJUSTMENT entry instead', TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER wallet_ledgers_append_only BEFORE UPDATE OR DELETE ON wallet_ledgers
  FOR EACH ROW EXECUTE FUNCTION reject_wallet_ledger_mutation();
