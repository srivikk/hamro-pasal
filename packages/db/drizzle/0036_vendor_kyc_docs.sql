-- Phase 34: the vendor’s uploaded PAN document (KYC).
-- pan_document_url is the object key of the document in the PRIVATE document store (a private
-- S3 / R2 bucket, or a directory outside the served uploads on a development machine). It is
-- not a public URL: the object is read only through the API. Null until the vendor uploads one.
ALTER TABLE "vendors" ADD COLUMN "pan_document_url" text;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_pan_document_url_check" CHECK ("vendors"."pan_document_url" IS NULL OR btrim("vendors"."pan_document_url") <> '');