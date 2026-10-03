import type { PublicProduct } from '@hamro-pasal/shared-types';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/Button';
import { formatLocalizedNumber } from '../../i18n/format-number';
import { useAuthStore } from '../../store/useAuthStore';
import {
  MAX_CART_LINES,
  MAX_LINE_QUANTITY,
  useCartStore,
  type CartVendor,
} from '../../store/useCartStore';
import { clampQuantity, maxAddable } from './discovery-rules';

export interface ProductCardProps {
  product: PublicProduct;
  /** The product's shop as a cart vendor, or null when it cannot be ordered from here. */
  cartVendor: CartVendor | null;
  /** Shown while `cartVendor` is null: why this product cannot be ordered (already translated). */
  blockedReason: string | null;
  /** A checkout is in flight or waiting for payment: the cart is frozen. */
  frozen: boolean;
}

/**
 * One product of the public list with its quantity picker. The picker can never exceed the stock
 * the server reported minus what the cart already holds; a sold-out product shows an explicit
 * "Out of Stock" badge and cannot be added.
 */
export function ProductCard({ product, cartVendor, blockedReason, frozen }: ProductCardProps) {
  const { t } = useTranslation();
  const locale = useAuthStore((state) => state.locale);
  const addItem = useCartStore((state) => state.addItem);
  const inCart = useCartStore(
    (state) => state.lines.find((line) => line.productId === product.id)?.quantity ?? 0,
  );
  const [selected, setSelected] = useState(1);
  const [notice, setNotice] = useState<string | null>(null);

  const soldOut = product.stock_quantity === 0;
  const max = maxAddable(product.stock_quantity, inCart);
  // Derived, so a refetch that lowers the stock pulls the picker down with it.
  const quantity = clampQuantity(selected, max);
  const canAdd = cartVendor !== null && !frozen && max > 0;

  const onAdd = (): void => {
    if (cartVendor === null) return;
    const result = addItem(
      cartVendor,
      {
        id: product.id,
        name: product.name,
        unitPriceNpr: product.price_npr,
        availableStock: product.stock_quantity,
      },
      quantity,
    );
    // 'vendor_conflict' needs no handling here: the store raises the root ReplaceCartModal.
    if (result === 'added') setSelected(1);
    if (result === 'stock_limit') {
      setNotice(t('discovery.stockLimit', { count: product.stock_quantity }));
    } else if (result === 'quantity_limit') {
      setNotice(t('menu.quantityLimit', { max: MAX_LINE_QUANTITY }));
    } else if (result === 'cart_full') {
      setNotice(t('menu.cartFull', { max: MAX_CART_LINES }));
    } else {
      setNotice(null);
    }
  };

  const hint =
    cartVendor === null ? blockedReason : !soldOut && max === 0 ? t('discovery.maxInCart') : notice;

  return (
    <View
      testID={`product-card-${product.id}`}
      className={`mx-4 mb-3 rounded-2xl border border-neutral-200 bg-white p-4 ${
        soldOut ? 'opacity-70' : ''
      }`}
    >
      <Text className="text-base font-semibold text-neutral-900">{product.name}</Text>
      <Text className="mt-0.5 text-xs text-neutral-500">{product.vendor.business_name}</Text>
      {product.description === null ? null : (
        <Text className="mt-1 text-sm text-neutral-600">{product.description}</Text>
      )}
      <Text className="mt-2 text-sm font-semibold text-neutral-900">
        {t('discovery.priceUnit', { amount: product.price_npr, unit: product.unit })}
      </Text>

      <View className="mt-1 flex-row items-center gap-3">
        {soldOut ? (
          <View
            className="rounded-md bg-neutral-200 px-2 py-1"
            testID={`out-of-stock-${product.id}`}
          >
            <Text className="text-xs font-bold text-neutral-700">{t('discovery.outOfStock')}</Text>
          </View>
        ) : (
          <Text className="text-xs text-neutral-600" testID={`stock-${product.id}`}>
            {t('discovery.inStock', { count: product.stock_quantity })}
          </Text>
        )}
        {inCart > 0 ? (
          <Text className="text-xs font-semibold text-brand">
            {t('menu.inCart', { count: inCart })}
          </Text>
        ) : null}
      </View>

      <View className="mt-3 flex-row items-center justify-between">
        <View className="flex-row items-center gap-2">
          <Button
            label="−"
            size="sm"
            variant="secondary"
            disabled={!canAdd || quantity <= 1}
            accessibilityLabel={t('discovery.decrease', { name: product.name })}
            onPress={() => {
              setSelected(quantity - 1);
            }}
          />
          <Text
            className="min-w-6 text-center text-base font-semibold text-neutral-900"
            testID={`quantity-${product.id}`}
          >
            {formatLocalizedNumber(quantity, locale)}
          </Text>
          <Button
            label="+"
            size="sm"
            variant="secondary"
            disabled={!canAdd || quantity >= max}
            accessibilityLabel={t('discovery.increase', { name: product.name })}
            onPress={() => {
              setSelected(quantity + 1);
            }}
          />
        </View>
        <Button
          label={t('menu.add')}
          size="sm"
          disabled={!canAdd}
          accessibilityLabel={`${t('menu.add')} ${product.name}`}
          onPress={onAdd}
        />
      </View>

      {hint === null ? null : (
        <Text className="mt-2 text-xs text-amber-800" testID={`product-hint-${product.id}`}>
          {hint}
        </Text>
      )}
    </View>
  );
}
