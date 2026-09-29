import type { PricingModel } from '@hamro-pasal/shared-types';

import { toNpr, toPaisa } from '../ledger/money';

/** Checkout was refused for a business reason (HTTP 422 unless stated otherwise). */
export class CheckoutRejectedError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly httpStatus = 422,
  ) {
    super(message);
    this.name = 'CheckoutRejectedError';
  }
}

export interface PricingVendor {
  readonly pricing_model: PricingModel | null;
  readonly commission_rate: number;
  readonly min_order_value: number;
  readonly base_delivery_fee_npr: number;
}

export interface PricingProduct {
  readonly id: string;
  readonly name: string;
  readonly price_npr: number;
}

export interface PricedLine {
  readonly productId: string;
  readonly productName: string;
  readonly unitPricePaisa: number;
  readonly quantity: number;
}

export interface PricedCart {
  readonly lines: readonly PricedLine[];
  readonly subtotalPaisa: number;
  readonly deliveryFeePaisa: number;
  readonly commissionPaisa: number;
  readonly totalPaisa: number;
}

/**
 * Prices a cart from database prices only; client-sent prices are never trusted.
 *   subtotal   = sum(unit price x qty)
 *   delivery   = vendor base delivery fee
 *   commission = subtotal x vendor rate (0 on SUBSCRIPTION, SPEC §4), rounded to the paisa
 * A subtotal below the vendor's MOV is rejected (SPEC journey step 5). SPEC names a "Small Cart
 * Surcharge" for that case but does not define its amount, so none is invented here.
 */
export function priceCart(
  vendor: PricingVendor,
  products: ReadonlyMap<string, PricingProduct>,
  items: readonly { readonly productId: string; readonly quantity: number }[],
): PricedCart {
  const lines = items.map((item): PricedLine => {
    const product = products.get(item.productId);
    if (product === undefined) {
      throw new Error(`Product ${item.productId} was not loaded for pricing`);
    }
    return {
      productId: product.id,
      productName: product.name,
      unitPricePaisa: toPaisa(product.price_npr),
      quantity: item.quantity,
    };
  });

  const subtotalPaisa = lines.reduce((sum, line) => sum + line.unitPricePaisa * line.quantity, 0);
  const minimumPaisa = toPaisa(vendor.min_order_value);
  if (subtotalPaisa < minimumPaisa) {
    throw new CheckoutRejectedError(
      'BELOW_MINIMUM_ORDER_VALUE',
      `Order subtotal is below this vendor's minimum of ${String(vendor.min_order_value)} NPR`,
      { minimum_npr: vendor.min_order_value, subtotal_npr: toNpr(subtotalPaisa) },
    );
  }

  // Rate as integer basis points keeps the product exact; the result rounds half-up to the paisa.
  const rateBasisPoints =
    vendor.pricing_model === 'SUBSCRIPTION' ? 0 : Math.round(vendor.commission_rate * 10_000);
  const commissionPaisa = Math.round((subtotalPaisa * rateBasisPoints) / 10_000);
  const deliveryFeePaisa = toPaisa(vendor.base_delivery_fee_npr);

  return {
    lines,
    subtotalPaisa,
    deliveryFeePaisa,
    commissionPaisa,
    totalPaisa: subtotalPaisa + deliveryFeePaisa,
  };
}
