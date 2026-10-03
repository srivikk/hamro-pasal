-- Phase 20: push notifications. device_tokens holds the Expo push tokens the mobile app registers
-- (POST /api/notifications/device-token), one row per app installation. A token is unique: a
-- phone that signs in as another account moves its row to that account. Rows go with their user.
CREATE TABLE "device_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"platform" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_tokens_token_check" CHECK ("device_tokens"."token" ~ '^Expo(nent)?PushToken\[.+\]$' AND char_length("device_tokens"."token") <= 255),
	CONSTRAINT "device_tokens_platform_check" CHECK ("device_tokens"."platform" IN ('ANDROID', 'IOS'))
);
--> statement-breakpoint
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "device_tokens_token_uidx" ON "device_tokens" USING btree ("token");--> statement-breakpoint
CREATE INDEX "device_tokens_user_id_idx" ON "device_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE TRIGGER device_tokens_set_updated_at BEFORE UPDATE ON device_tokens
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
