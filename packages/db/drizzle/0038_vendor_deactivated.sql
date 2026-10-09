-- Phase 36: a vendor that closed its shop (POST /api/vendor/account/deactivate). Soft delete:
-- the row stays for the ledger, invoices and audit trail. Nothing in this file uses the value.
ALTER TYPE "public"."vendor_status" ADD VALUE 'DEACTIVATED';