import Ionicons from '@expo/vector-icons/Ionicons';
import type { MenuProduct } from '@hamro-pasal/shared-types';
import { useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/Button';
import { ProductImage } from '../../components/ProductImage';
import { RatingPill } from '../../components/RatingPill';
import { formatLocalizedNumber } from '../../i18n/format-number';
import { toNpr, toPaisa } from '../../lib/money';
import { useAuthStore } from '../../store/useAuthStore';
import {
  MAX_CART_LINES,
  MAX_LINE_QUANTITY,
  useCartStore,
  type CartVendor,
} from '../../store/useCartStore';
import { useToastStore } from '../../store/useToastStore';
import { colors } from '../../theme/colors';
import { clampQuantity } from '../discovery/discovery-rules';
import type { MenuProductDetail } from './menu-sections';

interface DetailProps {
  product: MenuProduct;
  /** Description, unit and photo, once the shop's catalogue has been read. */
  detail: MenuProductDetail | undefined;
  /** Product-level rating, when the platform has one. */
  rating: number | null;
  cartVendor: CartVendor;
  /** Why nothing can be added right now (already translated), or null when ordering is open. */
  blockedReason: string | null;
  onClose: () => void;
}

/** One side of the "- n +" control. `dimmed` looks disabled but still reports the press. */
function StepButton({
  icon,
  label,
  disabled,
  dimmed = false,
  testID,
  onPress,
}: {
  icon: 'add' | 'remove';
  label: string;
  disabled: boolean;
  dimmed?: boolean;
  testID: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={6}
      testID={testID}
      className={`h-10 w-10 items-center justify-center active:opacity-60 ${
        disabled || dimmed ? 'opacity-40' : ''
      }`}
      onPress={onPress}
    >
      <Ionicons name={icon} size={20} color={colors.brand} />
    </Pressable>
  );
}

/**
 * Mounted only while a product is open.
 *
 * The quantity is the cart's own while the product is in the cart: the control then changes the
 * cart line directly (as the menu row's does) and the button only closes the sheet. A product
 * that is not in the cart yet starts at 1 and is added with ADD.
 */
function Detail({ product, detail, rating, cartVendor, blockedReason, onClose }: DetailProps) {
  const { t } = useTranslation();
  const locale = useAuthStore((state) => state.locale);
  const addItem = useCartStore((state) => state.addItem);
  const setQuantity = useCartStore((state) => state.setQuantity);
  const inCart = useCartStore(
    (state) => state.lines.find((line) => line.productId === product.id)?.quantity ?? 0,
  );
  const showToast = useToastStore((state) => state.show);
  const [selected, setSelected] = useState(1);
  const [notice, setNotice] = useState<string | null>(null);

  const stock = product.stock_quantity;
  const soldOut = stock === 0;
  const editingCart = inCart > 0;
  // Never more than the stock, nor than one cart line may hold.
  const ceiling = Math.min(stock, MAX_LINE_QUANTITY);
  const quantity = editingCart ? inCart : clampQuantity(selected, ceiling);
  const blocked = blockedReason !== null;
  const atCeiling = quantity >= ceiling;

  const cartProduct = {
    id: product.id,
    name: product.name,
    unitPriceNpr: product.price_npr,
    availableStock: stock,
  };

  /** What a refused change is called; `null` when it went through. */
  const refusal = (result: ReturnType<typeof addItem>): string | null => {
    if (result === 'added' || result === 'vendor_conflict') return null;
    if (result === 'stock_limit') return t('menu.maxStock');
    if (result === 'quantity_limit') return t('menu.quantityLimit', { max: MAX_LINE_QUANTITY });
    return t('menu.cartFull', { max: MAX_CART_LINES });
  };

  const onIncrease = (): void => {
    if (atCeiling) {
      // The button stays pressable at the limit so the customer is told why nothing happens.
      showToast(
        quantity >= stock
          ? t('menu.maxStock')
          : t('menu.quantityLimit', { max: MAX_LINE_QUANTITY }),
        'info',
      );
      return;
    }
    if (!editingCart) {
      setSelected(quantity + 1);
      return;
    }
    const refused = refusal(addItem(cartVendor, cartProduct, 1));
    if (refused !== null) showToast(refused, 'info');
  };

  const onDecrease = (): void => {
    if (!editingCart) {
      setSelected(quantity - 1);
      return;
    }
    // At one, the item leaves the cart and the sheet offers ADD again, from 1.
    if (inCart === 1) setSelected(1);
    setQuantity(product.id, inCart - 1);
  };

  const onAdd = (): void => {
    const result = addItem(cartVendor, cartProduct, quantity);
    // 'vendor_conflict': the store raises the root ReplaceCartModal, which needs this sheet gone.
    if (result === 'added' || result === 'vendor_conflict') onClose();
    else setNotice(refusal(result));
  };

  const hint = blockedReason ?? notice;
  const lineTotalNpr = toNpr(toPaisa(product.price_npr) * quantity);

  return (
    <View className="max-h-[88%] overflow-hidden rounded-t-3xl bg-white" testID="product-sheet">
      <ScrollView bounces={false}>
        <ProductImage
          uri={detail?.imageUrl}
          soldOut={soldOut}
          className="h-56"
          imageTestID="product-sheet-image"
          placeholderTestID="product-sheet-placeholder"
        />

        <View className="px-5 pt-4">
          <View className="flex-row items-start justify-between gap-3">
            <Text className="flex-1 text-xl font-extrabold text-gray-900">{product.name}</Text>
            {rating === null ? null : <RatingPill rating={rating} testID="product-sheet-rating" />}
          </View>
          <Text className="mt-1 text-lg font-bold text-gray-900" testID="product-sheet-price">
            {detail === undefined
              ? t('common.price', { amount: product.price_npr })
              : t('discovery.priceUnit', { amount: product.price_npr, unit: detail.unit })}
          </Text>

          <View className="mt-2 flex-row items-center gap-3">
            {soldOut ? (
              <View className="rounded-md bg-gray-200 px-2 py-1">
                <Text className="text-xs font-bold text-gray-700">{t('discovery.outOfStock')}</Text>
              </View>
            ) : (
              <Text className="text-xs text-gray-500">
                {t('discovery.inStock', { count: stock })}
              </Text>
            )}
            {inCart > 0 ? (
              <Text className="text-xs font-semibold text-brand">
                {t('menu.inCart', { count: inCart })}
              </Text>
            ) : null}
          </View>

          {detail?.description == null ? null : (
            <Text
              className="mt-3 text-sm leading-5 text-gray-500"
              testID="product-sheet-description"
            >
              {detail.description}
            </Text>
          )}
        </View>
      </ScrollView>

      <View className="px-5 pb-8 pt-4">
        {hint === null ? null : (
          <Text className="mb-3 text-xs text-amber-800" testID="product-sheet-hint">
            {hint}
          </Text>
        )}
        {/* Nothing to add of a sold-out product: no quantity control and no ADD button. One that
            is somehow still in the cart keeps its control, so it can be taken out here. */}
        {soldOut && !editingCart ? null : (
          <View className="flex-row items-center gap-4">
            <View className="flex-row items-center rounded-xl border border-brand bg-brand-light">
              <StepButton
                icon="remove"
                testID="product-sheet-decrease"
                label={t('discovery.decrease', { name: product.name })}
                disabled={blocked || (!editingCart && quantity <= 1)}
                onPress={onDecrease}
              />
              <Text
                className="min-w-8 text-center text-base font-extrabold text-brand"
                testID="product-sheet-quantity"
              >
                {formatLocalizedNumber(quantity, locale)}
              </Text>
              <StepButton
                icon="add"
                testID="product-sheet-increase"
                label={t('discovery.increase', { name: product.name })}
                disabled={blocked}
                dimmed={atCeiling}
                onPress={onIncrease}
              />
            </View>
            <View className="flex-1">
              {editingCart ? (
                <Button
                  label={t('menu.doneWithTotal', { amount: lineTotalNpr })}
                  testID="product-sheet-done"
                  onPress={onClose}
                />
              ) : (
                <Button
                  label={t('menu.addWithTotal', { amount: lineTotalNpr })}
                  accessibilityLabel={t('menu.addToCart', { name: product.name })}
                  testID="product-sheet-add"
                  disabled={blocked}
                  onPress={onAdd}
                />
              )}
            </View>
          </View>
        )}
      </View>
    </View>
  );
}

/**
 * The item detail sheet of the shop page: photo, name, price, rating (when there is one),
 * description, and a quantity control bound to the cart. Open while `product` is not null.
 */
export function ProductDetailSheet({
  product,
  ...rest
}: Omit<DetailProps, 'product'> & { product: MenuProduct | null }) {
  const { t } = useTranslation();
  return (
    <Modal
      visible={product !== null}
      transparent
      animationType="slide"
      onRequestClose={rest.onClose}
    >
      <Pressable
        accessibilityLabel={t('menu.closeDetail')}
        testID="product-sheet-backdrop"
        className="flex-1 bg-black/50"
        onPress={rest.onClose}
      />
      {product === null ? null : <Detail key={product.id} product={product} {...rest} />}
    </Modal>
  );
}
