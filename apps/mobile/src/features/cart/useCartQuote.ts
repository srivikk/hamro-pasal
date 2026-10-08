import type { NepalAddress } from '@hamro-pasal/shared-types';
import { useQuery } from '@tanstack/react-query';

import { fetchCartQuote } from '../../api/cart-quote';
import { ApiError } from '../../api/http';
import { retryTransientFailures } from '../../api/query-client';
import { useAddressStore } from '../../store/useAddressStore';
import { selectHasSession, useAuthStore } from '../../store/useAuthStore';
import { isOverStock, useCartStore, type CartLine } from '../../store/useCartStore';
import { computeCartSummary } from './cart-summary';
import { stockLevelsFromDetails } from './stock-shortfalls';

/** Prefix of every quote query: invalidate it when the server says a quote no longer holds. */
export const CART_QUOTE_QUERY_KEY = ['cart-quote'] as const;

/** One key per cart contents and delivery address: a changed cart never shows an older quote. */
export function cartQuoteQueryKey(
  vendorId: string,
  lines: readonly Pick<CartLine, 'productId' | 'quantity'>[],
  address: NepalAddress,
) {
  const items = lines
    .map((line) => `${line.productId}:${String(line.quantity)}`)
    .sort()
    .join(',');
  return [...CART_QUOTE_QUERY_KEY, vendorId, items, JSON.stringify(address)] as const;
}

/**
 * The server's price for the cart as it is now (POST /api/cart/quote). Both checkout steps read
 * it: the Cart's bill and the Payment Options screen's amount and methods.
 *
 * It is asked only when checkout could go ahead: signed in, a delivery address, at or above the
 * shop's minimum, no line above known stock, and no reservation already waiting (`frozen`).
 * Never served stale: an offer can end at any moment, and checkout compares the total.
 */
export function useCartQuote({ frozen }: { frozen: boolean }) {
  const signedIn = useAuthStore(selectHasSession);
  const vendor = useCartStore((state) => state.vendor);
  const lines = useCartStore((state) => state.lines);
  const address = useAddressStore((state) => state.address);

  const ready =
    signedIn &&
    !frozen &&
    vendor !== null &&
    address !== null &&
    lines.length > 0 &&
    !lines.some(isOverStock) &&
    computeCartSummary(vendor, lines).shortOfMinimumNpr === 0;

  return useQuery({
    queryKey:
      vendor === null || address === null
        ? CART_QUOTE_QUERY_KEY
        : cartQuoteQueryKey(vendor.id, lines, address),
    queryFn: async () => {
      if (vendor === null || address === null) throw new Error('No cart to quote');
      try {
        return await fetchCartQuote({ vendorId: vendor.id, lines, deliveryAddress: address });
      } catch (error) {
        // The server names every short line: record it, as a refused checkout does, so the cart
        // highlights those lines and asks for a lower quantity.
        if (error instanceof ApiError && error.code === 'INSUFFICIENT_STOCK') {
          useCartStore.getState().syncStock(stockLevelsFromDetails(error.details));
        }
        throw error;
      }
    },
    enabled: ready,
    staleTime: 0,
    gcTime: 0,
    retry: retryTransientFailures,
  });
}
