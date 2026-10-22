-- 2026-10-22 (Task 6): a Super Admin may unpublish a product review (platform policy). Hidden
-- reviews leave the public list and the product's average; when, who and why are set together.
ALTER TABLE "product_reviews" ADD COLUMN "hidden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_reviews" ADD COLUMN "hidden_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "product_reviews" ADD COLUMN "hidden_reason" text;--> statement-breakpoint
ALTER TABLE "product_reviews" ADD CONSTRAINT "product_reviews_hidden_by_user_id_users_id_fk" FOREIGN KEY ("hidden_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_reviews_hidden_by_user_id_idx" ON "product_reviews" USING btree ("hidden_by_user_id") WHERE "product_reviews"."hidden_by_user_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "product_reviews" ADD CONSTRAINT "product_reviews_hidden_check" CHECK (("product_reviews"."hidden_at" IS NULL) = ("product_reviews"."hidden_by_user_id" IS NULL) AND ("product_reviews"."hidden_at" IS NULL) = ("product_reviews"."hidden_reason" IS NULL) AND ("product_reviews"."hidden_reason" IS NULL OR btrim("product_reviews"."hidden_reason") <> ''));