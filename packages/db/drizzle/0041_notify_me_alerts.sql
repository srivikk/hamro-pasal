-- Step 7.4 (2026-10-15, SPEC core 11): Notify Me. A customer waits for an out-of-stock product
-- or a closed shop; the row is deleted when the notice is written (SPEC edge case 22).
CREATE TABLE "shop_open_alerts" (
	"user_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shop_open_alerts_user_id_vendor_id_pk" PRIMARY KEY("user_id","vendor_id")
);
--> statement-breakpoint
CREATE TABLE "stock_alerts" (
	"user_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_alerts_user_id_product_id_pk" PRIMARY KEY("user_id","product_id")
);
--> statement-breakpoint
ALTER TABLE "shop_open_alerts" ADD CONSTRAINT "shop_open_alerts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_open_alerts" ADD CONSTRAINT "shop_open_alerts_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_alerts" ADD CONSTRAINT "stock_alerts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_alerts" ADD CONSTRAINT "stock_alerts_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shop_open_alerts_vendor_idx" ON "shop_open_alerts" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "stock_alerts_product_idx" ON "stock_alerts" USING btree ("product_id");