import {
  deadLetterStatuses,
  deliveryStates,
  deliveryScopes,
  disputeStatuses,
  fulfillmentModes,
  ledgerAccountTypes,
  ledgerTransactionKinds,
  orderStates,
  paymentMethods,
  paymentStatuses,
  pricingModels,
  reviewDirections,
  userRoles,
  vendorStatuses,
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
export const ledgerAccountTypeEnum = pgEnum('ledger_account_type', ledgerAccountTypes);
export const ledgerTransactionKindEnum = pgEnum('ledger_transaction_kind', ledgerTransactionKinds);
export const disputeStatusEnum = pgEnum('dispute_status', disputeStatuses);
export const reviewDirectionEnum = pgEnum('review_direction', reviewDirections);
export const deadLetterStatusEnum = pgEnum('dead_letter_status', deadLetterStatuses);
export const deliveryStateEnum = pgEnum('delivery_state', deliveryStates);
