-- Phase 9.5: the dispute chat transcript. /chat persists every message here before broadcasting
-- it; the first message of an order also opens its disputes row.
CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dispute_id" uuid NOT NULL,
	"sender_user_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"body" text NOT NULL,
	"attachments" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_messages_dispute_sender_client_key" UNIQUE("dispute_id","sender_user_id","client_id"),
	CONSTRAINT "chat_messages_client_id_check" CHECK (length("chat_messages"."client_id") BETWEEN 1 AND 100),
	CONSTRAINT "chat_messages_body_check" CHECK (length("chat_messages"."body") <= 2000),
	CONSTRAINT "chat_messages_attachments_check" CHECK (jsonb_typeof("chat_messages"."attachments") = 'array' AND jsonb_array_length("chat_messages"."attachments") <= 4),
	CONSTRAINT "chat_messages_not_empty_check" CHECK (btrim("chat_messages"."body") <> '' OR jsonb_array_length("chat_messages"."attachments") > 0)
);
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_dispute_id_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."disputes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_sender_user_id_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_messages_dispute_id_created_at_idx" ON "chat_messages" USING btree ("dispute_id","created_at");