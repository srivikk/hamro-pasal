-- Phase 12.5: application-layer debt suspension (SPEC §5). A vendor suspended for wallet debt
-- remembers its previous status, which clearing the debt restores. The enforce_vendor_wallet_limit
-- trigger stays as the database-level safety net (SPEC §5 "a database trigger").
ALTER TABLE "vendors" ADD COLUMN "status_before_debt_suspension" "vendor_status";--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_debt_suspension_check" CHECK ("vendors"."status_before_debt_suspension" IS NULL OR ("vendors"."status" = 'SUSPENDED' AND "vendors"."status_before_debt_suspension" <> 'SUSPENDED'));