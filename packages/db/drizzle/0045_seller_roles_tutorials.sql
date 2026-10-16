-- Step 7.7 / 7.8 (2026-10-16, SPEC core 11): one account, several roles (decided 2026-10-15), the
-- citizenship document of vendor flow 2, and the in-app tutorial videos.
CREATE TYPE "public"."app_variant" AS ENUM('CUSTOMER', 'SELLER');--> statement-breakpoint
CREATE TABLE "app_tutorials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app" "app_variant" NOT NULL,
	"youtube_video_id" text NOT NULL,
	"title" text NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_tutorials_youtube_video_id_check" CHECK ("app_tutorials"."youtube_video_id" ~ '^[A-Za-z0-9_-]{11}$'),
	CONSTRAINT "app_tutorials_title_check" CHECK (char_length(btrim("app_tutorials"."title")) BETWEEN 1 AND 80),
	CONSTRAINT "app_tutorials_display_order_check" CHECK ("app_tutorials"."display_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"user_id" uuid NOT NULL,
	"role" "user_role" NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_roles_user_id_role_pk" PRIMARY KEY("user_id","role")
);
--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "citizenship_document_url" text;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_tutorials_app_order_idx" ON "app_tutorials" USING btree ("app","display_order");--> statement-breakpoint
-- Hand-added: every account holds its primary role (users.role) as one of its roles.
INSERT INTO "user_roles" ("user_id", "role", "granted_at")
SELECT "id", "role", "created_at" FROM "users"
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Hand-added: a new account, or a changed primary role, is mirrored into user_roles, so no writer
-- of users (sign-in, fixtures, scripts) can leave an account without its role.
CREATE FUNCTION mirror_primary_user_role() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO user_roles (user_id, role) VALUES (NEW.id, NEW.role) ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER users_primary_role_mirror AFTER INSERT OR UPDATE OF role ON users
  FOR EACH ROW EXECUTE FUNCTION mirror_primary_user_role();
