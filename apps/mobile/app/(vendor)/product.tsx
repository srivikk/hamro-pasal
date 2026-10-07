import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '../../src/components/Button';
import { KeyboardScreen } from '../../src/components/KeyboardScreen';
import { SearchableSelect } from '../../src/components/SearchableSelect';
import {
  categoryName,
  EMPTY_PRODUCT_FORM,
  formFromProduct,
  MAX_PRODUCT_NAME_LENGTH,
  MOCK_PRODUCT_CATEGORIES,
  sanitizePriceInput,
  sanitizeStockInput,
  validateProductForm,
  type ProductField,
  type ProductForm,
  type ProductFormErrors,
} from '../../src/features/vendor/product-form';
import { useToastStore } from '../../src/store/useToastStore';
import { useVendorCatalogueStore } from '../../src/store/useVendorCatalogueStore';

const CATEGORY_OPTIONS = MOCK_PRODUCT_CATEGORIES.map((category) => ({
  value: category.id,
  label: category.name,
}));

/**
 * Add a product, or edit the one named by `?id=` (opened from the Catalogue tab): name, price,
 * category, stock quantity, and where the photos will go.
 *
 * TODO: `POST /api/vendor/products` / `PUT /api/vendor/products/:id` (+ `PATCH …/stock`), the
 * categories from `GET /api/categories`, and photos through `POST …/:id/images` with
 * `expo-image-picker` (STATE_HANDOFF.md §8L). Until then the product is saved on the device.
 */
export default function VendorProductScreen() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const products = useVendorCatalogueStore((state) => state.products);
  const addProduct = useVendorCatalogueStore((state) => state.addProduct);
  const updateProduct = useVendorCatalogueStore((state) => state.updateProduct);
  const toast = useToastStore((store) => store.show);

  const editing = products.find((product) => product.id === id) ?? null;
  const [form, setForm] = useState<ProductForm>(() =>
    editing === null ? EMPTY_PRODUCT_FORM : formFromProduct(editing),
  );
  // The route stays mounted under the tabs: a different product (or "new") starts a fresh form.
  const [formFor, setFormFor] = useState(id);
  const [errors, setErrors] = useState<ProductFormErrors>({});
  if (formFor !== id) {
    setFormFor(id);
    setForm(editing === null ? EMPTY_PRODUCT_FORM : formFromProduct(editing));
    setErrors({});
  }

  const update = (patch: Partial<ProductForm>): void => {
    setForm((current) => ({ ...current, ...patch }));
  };
  const errorOf = (field: ProductField): string | null => {
    const error = errors[field];
    return error === undefined ? null : t(`vendorCatalogue.errors.${error}`);
  };

  const submit = (): void => {
    const otherNames = products
      .filter((product) => product.id !== editing?.id)
      .map((product) => product.name);
    const result = validateProductForm(form, otherNames);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    if (editing === null) addProduct(result.details);
    else updateProduct(editing.id, result.details);
    toast(t(editing === null ? 'vendorCatalogue.added' : 'vendorCatalogue.updated'), 'success');
    setForm(EMPTY_PRODUCT_FORM);
    setErrors({});
    router.navigate('/catalogue');
  };

  const field = (
    name: Exclude<ProductField, 'categoryId'>,
    label: string,
    value: string,
    onChangeText: (text: string) => void,
    keyboardType: 'default' | 'decimal-pad' | 'number-pad',
    maxLength?: number,
  ) => {
    const error = errorOf(name);
    return (
      <View className="gap-1">
        <Text className="text-sm font-semibold text-gray-700">{label}</Text>
        <TextInput
          testID={`product-${name}`}
          accessibilityLabel={label}
          value={value}
          onChangeText={onChangeText}
          keyboardType={keyboardType}
          maxLength={maxLength}
          className={`min-h-12 rounded-xl border bg-white px-4 text-base text-gray-900 ${error === null ? 'border-gray-300' : 'border-red-500'}`}
        />
        {error === null ? null : (
          <Text className="text-sm text-red-700" testID={`product-${name}-error`}>
            {error}
          </Text>
        )}
      </View>
    );
  };

  const categoryError = errorOf('categoryId');

  return (
    <KeyboardScreen testID="vendor-product-form">
      <Text className="text-xl font-bold text-gray-900" testID="product-form-title">
        {t(editing === null ? 'vendorCatalogue.addTitle' : 'vendorCatalogue.editTitle')}
      </Text>

      {field(
        'name',
        t('vendorCatalogue.name'),
        form.name,
        (name) => {
          update({ name });
        },
        'default',
        MAX_PRODUCT_NAME_LENGTH,
      )}
      {field(
        'price',
        t('vendorCatalogue.price'),
        form.price,
        (price) => {
          update({ price: sanitizePriceInput(price) });
        },
        'decimal-pad',
      )}

      <View className="gap-1">
        <Text className="text-sm font-semibold text-gray-700">{t('vendorCatalogue.category')}</Text>
        <SearchableSelect
          testID="product-category"
          options={CATEGORY_OPTIONS}
          placeholder={t('vendorCatalogue.categoryPlaceholder')}
          selectedLabel={form.categoryId === null ? null : categoryName(form.categoryId)}
          searchPlaceholder={t('vendorCatalogue.categorySearch')}
          emptyText={t('vendorCatalogue.categoryNone')}
          invalid={categoryError !== null}
          onSelect={(categoryId) => {
            update({ categoryId });
          }}
        />
        {categoryError === null ? null : (
          <Text className="text-sm text-red-700" testID="product-category-error">
            {categoryError}
          </Text>
        )}
      </View>

      {field(
        'stock',
        t('vendorCatalogue.stock'),
        form.stock,
        (stock) => {
          update({ stock: sanitizeStockInput(stock) });
        },
        'number-pad',
      )}

      <Button
        testID="product-image-upload"
        label={t('vendorCatalogue.addPhoto')}
        variant="secondary"
        onPress={() => {
          toast(t('vendorCatalogue.photoSoon'), 'success');
        }}
      />

      <Button testID="product-save" label={t('vendorCatalogue.save')} onPress={submit} />
    </KeyboardScreen>
  );
}
