-- Phase 11: the driver's OTP handoff erases the delivery code's hash when the order is DELIVERED
-- (a used code can never be replayed). The hash may be null only in DELIVERED / DISPUTED.
ALTER TABLE "orders" ALTER COLUMN "delivery_otp" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_delivery_otp_present_check" CHECK ("orders"."delivery_otp" IS NOT NULL OR "orders"."state" IN ('DELIVERED', 'DISPUTED'));