-- 2026-10-21 (Task 5): verified-purchase product reviews (one per customer and product; the
-- delivered order that verified it is kept). Published at once, unlike the double-blind reviews.
CREATE TABLE "product_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"rating" smallint NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_reviews_product_id_customer_id_key" UNIQUE("product_id","customer_id"),
	CONSTRAINT "product_reviews_rating_check" CHECK ("product_reviews"."rating" BETWEEN 1 AND 5),
	CONSTRAINT "product_reviews_comment_check" CHECK (comment IS NULL OR (btrim(comment) <> '' AND char_length(comment) <= 500))
);
--> statement-breakpoint
ALTER TABLE "product_reviews" ADD CONSTRAINT "product_reviews_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_reviews" ADD CONSTRAINT "product_reviews_customer_id_users_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_reviews" ADD CONSTRAINT "product_reviews_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_reviews_product_id_created_at_idx" ON "product_reviews" USING btree ("product_id","created_at","id");--> statement-breakpoint
CREATE TRIGGER product_reviews_set_updated_at BEFORE UPDATE ON product_reviews
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();