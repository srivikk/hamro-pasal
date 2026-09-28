import type {
  CustomerAddress,
  Dispute,
  Order,
  OrderItem,
  PlatformSettings,
  Product,
  Review,
  User,
  Vendor,
  WalletLedger,
} from '@hamro-pasal/shared-types';

import type { disputes, reviews } from './disputes';
import type { orderItems, orders } from './orders';
import type { customerAddresses, users } from './users';
import type { products, vendors } from './vendors';
import type { platformSettings, walletLedgers } from './wallet';

/*
 * Compile-time contract: each table's selected row type must be *identical* to the Zod-inferred
 * type in packages/shared-types. Adding, removing, renaming, or changing the nullability of a
 * column on either side fails `tsc`. Runtime parsing of real rows is covered by the
 * integration test contract.int.test.ts.
 */
// Exact (invariant) type equality. The single-use generics are the mechanism, not an oversight.
/* eslint-disable @typescript-eslint/no-unnecessary-type-parameters */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/* eslint-enable @typescript-eslint/no-unnecessary-type-parameters */
type Assert<T extends true> = T;

export type SchemaContract = [
  Assert<Equals<typeof users.$inferSelect, User>>,
  Assert<Equals<typeof customerAddresses.$inferSelect, CustomerAddress>>,
  Assert<Equals<typeof vendors.$inferSelect, Vendor>>,
  Assert<Equals<typeof products.$inferSelect, Product>>,
  Assert<Equals<typeof orders.$inferSelect, Order>>,
  Assert<Equals<typeof orderItems.$inferSelect, OrderItem>>,
  Assert<Equals<typeof walletLedgers.$inferSelect, WalletLedger>>,
  Assert<Equals<typeof disputes.$inferSelect, Dispute>>,
  Assert<Equals<typeof reviews.$inferSelect, Review>>,
  Assert<Equals<typeof platformSettings.$inferSelect, PlatformSettings>>,
];
