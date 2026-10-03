-- Phase 17: catalog, taxonomy and inventory management.
-- categories: the Super Admin's Master Category Taxonomy (a tree through parent_id; deleting a
-- category that still has children or products is refused by the RESTRICT foreign keys).
-- products: mapped to a category (null only for rows older than this migration) and extended with
-- description, unit, image_urls and metadata. Indexes for the vendor and category listings, and a
-- GIN full-text index on name + description ('simple' configuration: no stemming).
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"parent_id" uuid,
	"icon_url" text,
	"display_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_slug_key" UNIQUE("slug"),
	CONSTRAINT "categories_name_check" CHECK (btrim("categories"."name") <> ''),
	CONSTRAINT "categories_slug_check" CHECK ("categories"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "categories_icon_url_check" CHECK ("categories"."icon_url" IS NULL OR btrim("categories"."icon_url") <> ''),
	CONSTRAINT "categories_display_order_check" CHECK ("categories"."display_order" >= 0),
	CONSTRAINT "categories_not_own_parent_check" CHECK ("categories"."parent_id" IS DISTINCT FROM "categories"."id")
);
--> statement-breakpoint
DROP INDEX "products_vendor_id_idx";--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "category_id" uuid;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "unit" text DEFAULT 'piece' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "image_urls" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "categories_parent_id_display_order_idx" ON "categories" USING btree ("parent_id","display_order");--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "products_vendor_id_is_active_idx" ON "products" USING btree ("vendor_id","is_active");--> statement-breakpoint
CREATE INDEX "products_category_id_is_active_idx" ON "products" USING btree ("category_id","is_active");--> statement-breakpoint
CREATE INDEX "products_search_idx" ON "products" USING gin (to_tsvector('simple', "name" || ' ' || coalesce("description", '')));--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_description_check" CHECK ("products"."description" IS NULL OR btrim("products"."description") <> '');--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_unit_check" CHECK (btrim("products"."unit") <> '');--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_image_urls_check" CHECK (cardinality("products"."image_urls") <= 8);--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_metadata_check" CHECK (jsonb_typeof("products"."metadata") = 'object');--> statement-breakpoint
CREATE TRIGGER categories_set_updated_at BEFORE UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();