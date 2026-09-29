-- CITY_WIDE serviceability (SPEC §2) compares the vendor's Palika with the customer address's
-- municipality_palika_string. Using the same column name and vocabulary on both sides makes
-- that an equality match. RENAME keeps existing data. The meta snapshot was updated to match.
ALTER TABLE "vendors" RENAME COLUMN "city_string" TO "municipality_palika_string";
--> statement-breakpoint
ALTER TABLE "vendors" RENAME CONSTRAINT "vendors_city_string_check" TO "vendors_municipality_palika_string_check";
