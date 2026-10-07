import Ionicons from '@expo/vector-icons/Ionicons';
import type { MenuProduct } from '@hamro-pasal/shared-types';
import { Pressable, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/Button';
import { ProductImage } from '../../components/ProductImage';
import { formatLocalizedNumber } from '../../i18n/format-number';
import { colors } from '../../theme/colors';

/**
 * One product of a shop's menu.
 * - The thumbnail opens the photo full screen; a product without a photo (or whose photo does
 *   not load) shows the default placeholder instead (not pressable).
 * - A sold-out product has "OUT OF STOCK" over its thumbnail and no Add button at all.
 * - The name and price open the item detail sheet.
 * - "Add" puts one in the cart and turns into a "- n +" control, so the quantity can be changed
 *   or the item removed right here.
 */
export function MenuProductRow({
  product,
  imageUrl,
  inCart,
  serviceable,
  frozen,
  onOpen,
  onViewPhoto,
  onAdd,
  onRemoveOne,
}: {
  product: MenuProduct;
  imageUrl: string | null;
  /** How many of this product the cart holds (0: show "Add"). */
  inCart: number;
  /** False for a shop that does not deliver here: browse only. */
  serviceable: boolean;
  /** A checkout is waiting for payment: the cart cannot change. */
  frozen: boolean;
  onOpen: () => void;
  onViewPhoto: () => void;
  /** One more. The caller reports stock and cart limits ("Maximum stock reached"). */
  onAdd: () => void;
  /** One fewer; at one, the item leaves the cart. */
  onRemoveOne: () => void;
}) {
  const { t, i18n } = useTranslation();
  const disabled = !serviceable || frozen;

  return (
    <View
      testID={`menu-product-${product.id}`}
      className={`mx-4 mb-3 flex-row items-center rounded-2xl bg-white p-4 shadow-sm ${
        serviceable ? '' : 'opacity-60'
      }`}
    >
      <ProductImage
        uri={imageUrl}
        soldOut={product.stock_quantity === 0}
        compact
        className="mr-3 h-16 w-16 rounded-xl"
        onPress={onViewPhoto}
        pressLabel={t('menu.viewPhoto', { name: product.name })}
        pressTestID={`menu-product-photo-${product.id}`}
        placeholderTestID={`menu-product-placeholder-${product.id}`}
      />

      {/* Tapping the product (not its photo or its buttons) opens the item detail sheet. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('menu.viewDetails', { name: product.name })}
        testID={`menu-product-open-${product.id}`}
        className="flex-1 pr-3 active:opacity-70"
        onPress={onOpen}
      >
        <Text className="text-base font-semibold text-gray-900">{product.name}</Text>
        <Text className="mt-1 text-sm text-gray-700">
          {t('common.price', { amount: product.price_npr })}
        </Text>
      </Pressable>

      {product.stock_quantity === 0 ? null : inCart === 0 ? (
        <Button
          label={t('menu.add')}
          size="sm"
          accessibilityLabel={`${t('menu.add')} ${product.name}`}
          disabled={disabled}
          onPress={onAdd}
        />
      ) : (
        <View
          testID={`menu-stepper-${product.id}`}
          className={`flex-row items-center rounded-xl border border-brand bg-brand-light ${
            disabled ? 'opacity-40' : ''
          }`}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('cart.decrease', { name: product.name })}
            accessibilityState={{ disabled }}
            disabled={disabled}
            hitSlop={6}
            className="h-9 w-9 items-center justify-center active:opacity-60"
            onPress={onRemoveOne}
          >
            <Ionicons name="remove" size={18} color={colors.brand} />
          </Pressable>
          <Text
            className="min-w-6 text-center text-sm font-extrabold text-brand"
            testID={`menu-quantity-${product.id}`}
          >
            {formatLocalizedNumber(inCart, i18n.language === 'ne' ? 'ne' : 'en')}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('cart.increase', { name: product.name })}
            accessibilityState={{ disabled }}
            disabled={disabled}
            hitSlop={6}
            className="h-9 w-9 items-center justify-center active:opacity-60"
            onPress={onAdd}
          >
            <Ionicons name="add" size={18} color={colors.brand} />
          </Pressable>
        </View>
      )}
    </View>
  );
}
