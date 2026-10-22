import { MAX_PRODUCT_IMAGES } from '@hamro-pasal/shared-types';
import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Image, Pressable, Text, TextInput, View } from 'react-native';
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
  PhotoUploadError,
  useOwnProductsQuery,
  useSaveProduct,
} from '../../src/features/vendor/useVendorProducts';
import { ApiError } from '../../src/api/http';
import {
  photoProblem,
  PRODUCT_ERROR_CODES,
  type LocalPhoto,
  type PhotoProblem,
} from '../../src/api/vendor-products';
import { useToastStore } from '../../src/store/useToastStore';

/**
 * Add a product (POST /api/vendor/products), or edit the one named by `?id=` (opened from the
 * Catalogue tab: PUT /api/vendor/products/:id, and PATCH …/stock when the count changed): name,
 * price, category from the live taxonomy, stock quantity.
 *
 * Photos (2026-10-21, Task 5): picked from the gallery (JPEG, PNG or WebP, 5 MB each, 8 per
 * product), shown at once and uploaded on Save as one multipart request to
 * `POST /api/vendor/products/:id/images`, after the product itself is saved (so a new product
 * gets its id first). If only the upload fails, the product stays saved and the photos stay
 * picked, to retry with Save.
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

  // A new product whose photos failed to upload is edited from then on (its id is known).
  const [createdId, setCreatedId] = useState<string | null>(null);
  const editing = products.find((product) => product.id === (id ?? createdId)) ?? null;
  const [form, setForm] = useState<ProductForm>(() =>
    editing === null ? EMPTY_PRODUCT_FORM : formFromProduct(editing),
  );
  // The route stays mounted under the tabs: a different product (or "new") starts a fresh form.
  const [formFor, setFormFor] = useState(id);
  const [errors, setErrors] = useState<ProductFormErrors>({});
  const [photos, setPhotos] = useState<LocalPhoto[]>([]);
  const [photoError, setPhotoError] = useState<PhotoProblem | 'limit' | 'failed' | null>(null);
  if (formFor !== id) {
    setFormFor(id);
    setCreatedId(null);
    setForm(editing === null ? EMPTY_PRODUCT_FORM : formFromProduct(editing));
    setErrors({});
    setPhotos([]);
    setPhotoError(null);
  }
  const savedPhotos = editing?.image_urls ?? [];

  const pickPhotos = async (): Promise<void> => {
    setPhotoError(null);
    const room = MAX_PRODUCT_IMAGES - savedPhotos.length - photos.length;
    if (room <= 0) {
      setPhotoError('limit');
      return;
    }
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      // Below 1, iOS hands back a JPEG instead of a HEIC the server would refuse.
      quality: 0.8,
      allowsMultipleSelection: true,
      selectionLimit: room,
    });
    if (picked.canceled) return;
    const chosen = picked.assets.map((asset) => ({
      uri: asset.uri,
      mimeType: asset.mimeType ?? null,
      fileSize: asset.fileSize ?? null,
    }));
    const refused = chosen.map(photoProblem).find((problem) => problem !== null);
    if (refused !== undefined) setPhotoError(refused);
    const accepted = chosen.filter((photo) => photoProblem(photo) === null).slice(0, room);
    setPhotos((current) => [...current, ...accepted]);
  };

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
      { current: editing, draft: result.details, photos },
      {
        onSuccess: () => {
          setPhotos([]);
          setCreatedId(null);
          toast(
            t(editing === null ? 'vendorCatalogue.added' : 'vendorCatalogue.updated'),
            'success',
          );
          setForm(EMPTY_PRODUCT_FORM);
          setErrors({});
          router.navigate('/catalogue');
        },
        onError: (error) => {
          if (error instanceof PhotoUploadError) {
            // The product is saved; its photos are not. A new one is now an edit: Save retries
            // the photos only.
            setPhotoError('failed');
            toast(t('vendorCatalogue.photoUploadFailed'), 'error');
            if (editing === null) setCreatedId(error.product.id);
            return;
          }
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

      <View className="gap-2">
        <Text className="text-sm font-semibold text-gray-700">
          {t('vendorCatalogue.photos', { count: savedPhotos.length + photos.length })}
        </Text>
        {savedPhotos.length + photos.length === 0 ? null : (
          <View className="flex-row flex-wrap gap-2" testID="product-photos">
            {savedPhotos.map((url) => (
              <Image
                key={url}
                source={{ uri: url }}
                accessibilityIgnoresInvertColors
                className="h-20 w-20 rounded-xl bg-gray-200"
              />
            ))}
            {photos.map((photo) => (
              <Pressable
                key={photo.uri}
                testID={`product-pending-photo-${String(photos.indexOf(photo))}`}
                accessibilityRole="button"
                accessibilityLabel={t('vendorCatalogue.removePhoto')}
                onPress={() => {
                  setPhotos((current) => current.filter((each) => each.uri !== photo.uri));
                }}
              >
                <Image
                  source={{ uri: photo.uri }}
                  accessibilityIgnoresInvertColors
                  className="h-20 w-20 rounded-xl border-2 border-brand bg-gray-200"
                />
              </Pressable>
            ))}
          </View>
        )}
        {photoError === null ? null : (
          <Text className="text-sm text-red-700" testID="product-photo-error">
            {t(`vendorCatalogue.photoErrors.${photoError}`, { count: MAX_PRODUCT_IMAGES })}
          </Text>
        )}
        <Button
          testID="product-image-upload"
          label={t('vendorCatalogue.addPhoto')}
          variant="secondary"
          disabled={savedPhotos.length + photos.length >= MAX_PRODUCT_IMAGES}
          onPress={() => void pickPhotos()}
        />
      </View>

      <Button
        testID="product-save"
        label={t('vendorCatalogue.save')}
        disabled={save.isPending}
        onPress={submit}
      />
    </KeyboardScreen>
  );
}
