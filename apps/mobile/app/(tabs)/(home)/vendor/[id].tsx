import Ionicons from '@expo/vector-icons/Ionicons';
import type { FeedResponse, MenuProduct, VendorMenu } from '@hamro-pasal/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, SectionList, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { VENDOR_NOT_FOUND } from '../../../../src/api/catalog';
import { ApiError } from '../../../../src/api/http';
import { Button } from '../../../../src/components/Button';
import { ImageViewerModal } from '../../../../src/components/ImageViewerModal';
import { ShopSkeleton } from '../../../../src/components/Skeleton';
import { useCategoriesQuery } from '../../../../src/features/discovery/useCategoriesQuery';
import { feedQueryKey } from '../../../../src/features/feed/useFeedQuery';
import { useCustomerLocation } from '../../../../src/features/location/customer-location';
import {
  groupMenu,
  OTHER_SECTION_KEY,
  searchMenu,
  useMenuCatalog,
  type MenuSection,
} from '../../../../src/features/menu/menu-sections';
import { MenuProductRow } from '../../../../src/features/menu/MenuProductRow';
import { ProductDetailSheet } from '../../../../src/features/menu/ProductDetailSheet';
import { ShopHeader } from '../../../../src/features/menu/ShopHeader';
import { useVendorMenuQuery } from '../../../../src/features/menu/useVendorMenuQuery';
import { vendorExtras } from '../../../../src/features/promo/mock-promotions';
import { formatLocalizedNumber } from '../../../../src/i18n/format-number';
import { useAuthStore } from '../../../../src/store/useAuthStore';
import { useFavouritesStore } from '../../../../src/store/useFavouritesStore';
import { useToastStore } from '../../../../src/store/useToastStore';
import {
  MAX_CART_LINES,
  MAX_LINE_QUANTITY,
  useCartStore,
  type CartVendor,
} from '../../../../src/store/useCartStore';
import { selectIsCheckoutPending, useCheckoutStore } from '../../../../src/store/useCheckoutStore';

function toCartVendor({ vendor }: VendorMenu): CartVendor {
  return {
    id: vendor.id,
    name: vendor.business_name,
    deliveryFeeNpr: vendor.base_delivery_fee_npr,
    minOrderValueNpr: vendor.min_order_value,
  };
}

export default function VendorMenuScreen() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const location = useCustomerLocation();
  const menu = useVendorMenuQuery(id, location);
  const queryClient = useQueryClient();
  const cartVendorId = useCartStore((state) => state.vendor?.id ?? null);
  const lines = useCartStore((state) => state.lines);
  const addItem = useCartStore((state) => state.addItem);
  const setQuantity = useCartStore((state) => state.setQuantity);
  const checkoutPending = useCheckoutStore(selectIsCheckoutPending);
  const [notice, setNotice] = useState<string | null>(null);
  const locale = useAuthStore((state) => state.locale);
  const categories = useCategoriesQuery();
  const catalog = useMenuCatalog(id);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [search, setSearch] = useState('');
  const isFavourite = useFavouritesStore((state) => state.favourites[id] !== undefined);
  const toggleFavourite = useFavouritesStore((state) => state.toggleFavourite);
  const showToast = useToastStore((state) => state.show);
  // The product whose detail sheet is open. An id, so the sheet follows a refetched menu.
  const [openedId, setOpenedId] = useState<string | null>(null);
  // The product whose photos are open full screen.
  const [photosOfId, setPhotosOfId] = useState<string | null>(null);
  const list = useRef<SectionList<MenuProduct, MenuSection>>(null);

  // While loading or failed the stack header gives the way back; the loaded page draws its own
  // back button on the shop's banner.
  const header = (
    <Stack.Screen
      options={{
        headerShown: !menu.isSuccess,
        title: menu.data?.vendor.business_name ?? '',
        headerBackTitle: t('common.back'),
      }}
    />
  );

  if (menu.isPending) {
    return (
      <View className="flex-1 bg-gray-50">
        {header}
        <ShopSkeleton testID="menu-loading" />
      </View>
    );
  }

  if (menu.isError) {
    const notFound = menu.error instanceof ApiError && menu.error.code === VENDOR_NOT_FOUND;
    return (
      <View className="flex-1 items-center justify-center gap-4 bg-gray-50 px-6">
        {header}
        <Text className="text-center text-base text-gray-700">
          {notFound ? t('menu.notFound') : t('menu.loadError')}
        </Text>
        {notFound ? null : <Button label={t('common.retry')} onPress={() => void menu.refetch()} />}
      </View>
    );
  }

  const { vendor, serviceable, products } = menu.data;
  const searching = search.trim() !== '';
  // Products grouped by their subcategory (one plain section until the categories are known).
  const sections = groupMenu(
    searchMenu(products, search),
    catalog.data?.categoryOf,
    categories.data?.categories ?? [],
    { all: t('menu.allItems'), other: t('menu.otherItems') },
  );
  // The menu does not carry the distance; the feed the customer came from does. It is only read
  // from the cache (no request): a page opened without the feed shows no distance.
  const cachedFeed = queryClient.getQueryData<FeedResponse>(feedQueryKey(location));
  const distanceKm =
    [...(cachedFeed?.serviceable ?? []), ...(cachedFeed?.explore_further ?? [])].find(
      (entry) => entry.vendor.id === vendor.id,
    )?.distance_km ?? null;
  const opened = products.find((product) => product.id === openedId) ?? null;
  const photosOf = products.find((product) => product.id === photosOfId) ?? null;
  const photos =
    photosOf === null ? null : (catalog.data?.detailOf[photosOf.id]?.imageUrls ?? null);
  const quantityInCart = (productId: string): number =>
    cartVendorId === vendor.id
      ? (lines.find((line) => line.productId === productId)?.quantity ?? 0)
      : 0;

  const onAdd = (product: MenuProduct): void => {
    const result = addItem(toCartVendor(menu.data), {
      id: product.id,
      name: product.name,
      unitPriceNpr: product.price_npr,
      // Phase 19: the menu carries the exact stock, so a line added here is capped like one added
      // from the product list (and the cart's stepper knows its ceiling).
      availableStock: product.stock_quantity,
    });
    // 'vendor_conflict' needs no handling here: the store raises the root ReplaceCartModal.
    if (result === 'quantity_limit') setNotice(t('menu.quantityLimit', { max: MAX_LINE_QUANTITY }));
    else if (result === 'cart_full') setNotice(t('menu.cartFull', { max: MAX_CART_LINES }));
    else {
      setNotice(null);
      // Pressing "+" at the last unit in stock: said in a toast, the page itself does not move.
      if (result === 'stock_limit') showToast(t('menu.maxStock'), 'info');
    }
  };

  // Why nothing can be ordered right now; also what the detail sheet says instead of adding.
  const blocked = !serviceable
    ? t('menu.notServiceable')
    : checkoutPending
      ? t('menu.checkoutPending')
      : null;
  const banner = blocked ?? notice;
  // The empty search field suggests this shop's own subcategories, one at a time.
  const categoryHints = sections
    .filter((section) => section.key !== OTHER_SECTION_KEY)
    .map((section) => t('menu.searchFor', { name: section.title.toLocaleLowerCase() }));
  const searchHints = categoryHints.length === 0 ? [t('menu.searchPlaceholder')] : categoryHints;

  return (
    <View className="flex-1 bg-gray-50">
      {header}
      <SectionList
        ref={list}
        testID="menu-sections"
        sections={sections}
        keyExtractor={(product) => product.id}
        stickySectionHeadersEnabled={false}
        keyboardShouldPersistTaps="handled"
        // Room below the last product for the floating ITEMS button.
        contentContainerStyle={{ paddingBottom: 96 }}
        ListHeaderComponent={
          <>
            <ShopHeader
              name={vendor.business_name}
              palika={vendor.municipality_palika_string}
              extras={vendorExtras(vendor)}
              distanceKm={distanceKm}
              serviceable={serviceable}
              favourite={isFavourite}
              onToggleFavourite={() => {
                const extras = vendorExtras(vendor);
                const saved = toggleFavourite({
                  vendorId: vendor.id,
                  name: vendor.business_name,
                  location: [extras.locality, vendor.municipality_palika_string]
                    .filter((part) => part !== null && part !== '')
                    .join(', '),
                });
                showToast(t(saved ? 'favourites.added' : 'favourites.removed'), 'info');
              }}
              search={search}
              searchHints={searchHints}
              onSearchChange={setSearch}
              onBack={() => {
                router.back();
              }}
            />
            {banner === null ? null : (
              <View className="mx-4 mt-4 rounded-xl bg-amber-50 p-3" testID="menu-banner">
                <Text className="text-sm text-amber-900">{banner}</Text>
              </View>
            )}
          </>
        }
        ListEmptyComponent={
          <Text className="px-4 pt-6 text-center text-base text-gray-500" testID="menu-empty">
            {searching ? t('menu.searchEmpty', { search: search.trim() }) : t('menu.empty')}
          </Text>
        }
        // A jump to a section that is not laid out yet: go near it, then land on it.
        onScrollToIndexFailed={({ averageItemLength, index }) => {
          list.current?.getScrollResponder()?.scrollTo({ y: averageItemLength * index });
        }}
        renderSectionHeader={({ section }) => (
          <View
            className="flex-row items-baseline gap-2 px-4 pb-2 pt-4"
            testID={`menu-section-${section.key}`}
          >
            <Text className="text-lg font-extrabold text-gray-900">{section.title}</Text>
            <Text className="text-sm font-medium text-gray-500">
              {formatLocalizedNumber(section.data.length, locale)}
            </Text>
          </View>
        )}
        renderItem={({ item: product }) => {
          const inCart = quantityInCart(product.id);
          return (
            <MenuProductRow
              product={product}
              imageUrl={catalog.data?.detailOf[product.id]?.imageUrl ?? null}
              inCart={inCart}
              serviceable={serviceable}
              frozen={checkoutPending}
              onOpen={() => {
                setOpenedId(product.id);
              }}
              onViewPhoto={() => {
                setPhotosOfId(product.id);
              }}
              onAdd={() => {
                onAdd(product);
              }}
              onRemoveOne={() => {
                setNotice(null);
                // At one, this takes the item out of the cart and "Add" comes back.
                setQuantity(product.id, inCart - 1);
              }}
            />
          );
        }}
      />

      {/* The floating menu of this shop's subcategories. Bottom-right, above the list's last
          row; the tab bar is outside this screen, so nothing of it is covered. */}
      {sections.length > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('menu.items')}
          testID="menu-fab"
          className="absolute bottom-6 right-4 flex-row items-center gap-2 rounded-full bg-gray-900 px-5 py-3 shadow-sm active:bg-gray-700"
          onPress={() => {
            setSheetOpen(true);
          }}
        >
          <Ionicons name="restaurant-outline" size={16} color="#FFFFFF" />
          <Text className="text-sm font-extrabold tracking-widest text-white">
            {t('menu.items')}
          </Text>
        </Pressable>
      ) : null}

      <ImageViewerModal
        images={photos === null || photos.length === 0 ? null : photos}
        title={photosOf?.name ?? ''}
        onClose={() => {
          setPhotosOfId(null);
        }}
      />

      <ProductDetailSheet
        product={opened}
        detail={opened === null ? undefined : catalog.data?.detailOf[opened.id]}
        // SPEC has no product-level ratings (reviews are per order, between customer and shop).
        rating={null}
        cartVendor={toCartVendor(menu.data)}
        blockedReason={blocked}
        onClose={() => {
          setOpenedId(null);
        }}
      />

      <Modal
        visible={sheetOpen}
        transparent
        animationType="slide"
        onRequestClose={() => {
          setSheetOpen(false);
        }}
      >
        <Pressable
          accessibilityLabel={t('address.cancel')}
          testID="menu-sheet-backdrop"
          className="flex-1 bg-black/50"
          onPress={() => {
            setSheetOpen(false);
          }}
        />
        <View className="max-h-[70%] rounded-t-3xl bg-white pb-6 pt-3" testID="menu-sheet">
          <View className="mb-2 h-1 w-10 self-center rounded-full bg-gray-300" />
          <Text className="px-5 pb-2 text-lg font-extrabold text-gray-900">
            {t('menu.sheetTitle')}
          </Text>
          <ScrollView>
            {sections.map((section, sectionIndex) => (
              <Pressable
                key={section.key}
                accessibilityRole="button"
                accessibilityLabel={section.title}
                testID={`menu-jump-${section.key}`}
                className="flex-row items-center justify-between px-5 py-3 active:bg-gray-100"
                onPress={() => {
                  setSheetOpen(false);
                  list.current?.scrollToLocation({
                    sectionIndex,
                    itemIndex: 0,
                    viewPosition: 0,
                    animated: true,
                  });
                }}
              >
                <Text className="text-base font-semibold text-gray-900">{section.title}</Text>
                <Text className="text-base font-medium text-gray-500">
                  ({formatLocalizedNumber(section.data.length, locale)})
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}
