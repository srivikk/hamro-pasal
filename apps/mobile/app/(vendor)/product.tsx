import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '../../src/components/Button';
import { KeyboardScreen } from '../../src/components/KeyboardScreen';
import { SearchableSelect } from '../../src/components/SearchableSelect';
import { useCategoriesQuery } from '../../src/features/discovery/useCategoriesQuery';
import {
  categoryNameOf,
  EMPTY_PRODUCT_FORM,
  formFromProduct,
  MAX_PRODUCT_NAME_LENGTH,
  productCategoryOptions,
  sanitizePriceInput,
  sanitizeStockInput,
  validateProductForm,
  type ProductField,
  type ProductForm,
  type ProductFormErrors,
} from '../../src/features/vendor/product-form';
import {
  loadedProducts,
  useOwnProductsQuery,
  useSaveProduct,
} from '../../src/features/vendor/useVendorProducts';
import { ApiError } from '../../src/api/http';
import { PRODUCT_ERROR_CODES } from '../../src/api/vendor-products';
import { useToastStore } from '../../src/store/useToastStore';

/**
 * Add a product (POST /api/vendor/products), or edit the one named by `?id=` (opened from the
 * Catalogue tab: PUT /api/vendor/products/:id, and PATCH …/stock when the count changed): name,
 * price, category from the live taxonomy, stock quantity.
 *
 * TODO: photos through `POST …/:id/images` with `expo-image-picker` (STATE_HANDOFF.md §8L).
 */
export default function VendorProductScreen() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const productsQuery = useOwnProductsQuery();
  const products = useMemo(() => loadedProducts(productsQuery.data), [productsQuery.data]);
  const save = useSaveProduct();
  const toast = useToastStore((store) => store.show);
  // The live taxonomy: hidden categories and everything below them are never offered.
  const categoryOptions = productCategoryOptions(useCategoriesQuery().data?.categories ?? []);

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
    const result = validateProductForm(form, otherNames, categoryOptions);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    if (save.isPending) return;
    save.mutate(
      { current: editing, draft: result.details },
      {
        onSuccess: () => {
          toast(
            t(editing === null ? 'vendorCatalogue.added' : 'vendorCatalogue.updated'),
            'success',
          );
          setForm(EMPTY_PRODUCT_FORM);
          setErrors({});
          router.navigate('/catalogue');
        },
        onError: (error) => {
          if (error instanceof ApiError && error.code === PRODUCT_ERROR_CODES.nameTaken) {
            setErrors({ name: 'nameTaken' });
          } else if (
            error instanceof ApiError &&
            error.code === PRODUCT_ERROR_CODES.categoryUnavailable
          ) {
            setErrors({ categoryId: 'category' });
          } else {
            toast(t('vendorCatalogue.saveError'), 'error');
          }
        },
      },
    );
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
          options={categoryOptions}
          placeholder={t('vendorCatalogue.categoryPlaceholder')}
          selectedLabel={
            form.categoryId === null ? null : categoryNameOf(categoryOptions, form.categoryId)
          }
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

      <Button
        testID="product-save"
        label={t('vendorCatalogue.save')}
        disabled={save.isPending}
        onPress={submit}
      />
    </KeyboardScreen>
  );
}
