import {
  deliveryScopes,
  disputeStatuses,
  fulfillmentModes,
  orderStates,
  paymentMethods,
  paymentStatuses,
  pricingModels,
  reviewDirections,
  userRoles,
  vendorStatuses,
  walletLedgerEntryTypes,
} from '@hamro-pasal/shared-types';
import { pgEnum } from 'drizzle-orm/pg-core';

// Postgres enum labels come from the shared-types tuples: one source of truth for DB and API.
export const userRoleEnum = pgEnum('user_role', userRoles);
export const vendorStatusEnum = pgEnum('vendor_status', vendorStatuses);
export const pricingModelEnum = pgEnum('pricing_model', pricingModels);
export const deliveryScopeEnum = pgEnum('delivery_scope', deliveryScopes);
export const fulfillmentModeEnum = pgEnum('fulfillment_mode', fulfillmentModes);
export const orderStateEnum = pgEnum('order_state', orderStates);
export const paymentMethodEnum = pgEnum('payment_method', paymentMethods);
export const paymentStatusEnum = pgEnum('payment_status', paymentStatuses);
export const walletLedgerEntryTypeEnum = pgEnum('wallet_ledger_entry_type', walletLedgerEntryTypes);
export const disputeStatusEnum = pgEnum('dispute_status', disputeStatuses);
export const reviewDirectionEnum = pgEnum('review_direction', reviewDirections);
