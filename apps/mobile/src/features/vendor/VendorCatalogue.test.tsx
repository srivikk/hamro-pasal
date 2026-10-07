import { fireEvent, screen, within } from '@testing-library/react-native';
import { router, useLocalSearchParams } from 'expo-router';

import VendorCatalogueScreen from '../../../app/(vendor)/catalogue';
import VendorProductScreen from '../../../app/(vendor)/product';
import { filterOptions } from '../../components/SearchableSelect';
import { useAuthStore } from '../../store/useAuthStore';
import { useToastStore } from '../../store/useToastStore';
import { useVendorCatalogueStore } from '../../store/useVendorCatalogueStore';
import { renderWithProviders } from '../../test/render';
import {
  EMPTY_PRODUCT_FORM,
  sanitizeStockInput,
  validateProductForm,
  type ProductForm,
} from './product-form';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), navigate: jest.fn() },
  useLocalSearchParams: jest.fn(() => ({})),
}));

const catalogue = () => useVendorCatalogueStore.getState();
const product = (id: string) => catalogue().products.find((each) => each.id === id);
const toast = () => useToastStore.getState().toast;
const press = (testID: string): void => {
  fireEvent.press(screen.getByTestId(testID));
};
const type = (testID: string, text: string): void => {
  fireEvent.changeText(screen.getByTestId(testID), text);
};
const openProduct = (id?: string): void => {
  jest.mocked(useLocalSearchParams).mockReturnValue(id === undefined ? {} : { id });
};

const form = (overrides: Partial<ProductForm> = {}): ProductForm => ({
  name: 'Local Honey 500g',
  price: '900',
  categoryId: 'honey-spreads',
  stock: '8',
  ...overrides,
});

beforeEach(() => {
  catalogue().reset();
  useAuthStore.getState().setLocale('en');
  useToastStore.setState({ toast: null });
  jest.mocked(router.push).mockClear();
  jest.mocked(router.navigate).mockClear();
  openProduct();
});

describe('product form rules', () => {
  it('builds a product from a complete form, trimming the name', () => {
    expect(validateProductForm(form({ name: '  Local   Honey 500g ', price: '899.50' }))).toEqual({
      ok: true,
      details: {
        name: 'Local Honey 500g',
        priceNpr: 899.5,
        categoryId: 'honey-spreads',
        stockQuantity: 8,
      },
    });
  });

  it('reports every missing or bad field of an empty form', () => {
    expect(validateProductForm({ ...EMPTY_PRODUCT_FORM, stock: '' })).toEqual({
      ok: false,
      errors: { name: 'name', price: 'price', categoryId: 'category', stock: 'stock' },
    });
  });

  it.each(['0', '-5', '1000000.01', '12.345', 'free'])('refuses %p as a price', (price) => {
    expect(validateProductForm(form({ price }))).toEqual({ ok: false, errors: { price: 'price' } });
  });

  it('takes 0 as a stock quantity (a product can be listed sold out)', () => {
    expect(validateProductForm(form({ stock: '0' }))).toMatchObject({
      ok: true,
      details: { stockQuantity: 0 },
    });
  });

  it('refuses a category that is not on the list', () => {
    expect(validateProductForm(form({ categoryId: 'electronics' }))).toEqual({
      ok: false,
      errors: { categoryId: 'category' },
    });
  });

  it('refuses a name another product of the shop already has, in any letter case', () => {
    expect(validateProductForm(form(), ['local honey 500G'])).toEqual({
      ok: false,
      errors: { name: 'nameTaken' },
    });
  });

  it('keeps digits only in the stock field, converting Nepali digits', () => {
    expect(sanitizeStockInput('1२ pcs')).toBe('12');
  });
});

describe('the searchable list', () => {
  const options = [
    { value: 'a', label: 'Kathmandu Metropolitan City' },
    { value: 'b', label: 'Lalitpur Metropolitan City' },
    { value: 'c', label: 'Kirtipur Municipality' },
  ];

  it('keeps the options containing every word typed, in any case', () => {
    expect(filterOptions(options, '')).toBe(options);
    expect(filterOptions(options, 'METRO lalit').map((option) => option.value)).toEqual(['b']);
    expect(filterOptions(options, 'pur').map((option) => option.value)).toEqual(['b', 'c']);
    expect(filterOptions(options, 'pokhara')).toEqual([]);
  });
});

describe('catalogue store', () => {
  it('starts with the sample catalogue, by name', () => {
    expect(catalogue().products.map((each) => each.name)).toEqual([
      'Basmati Rice 5kg',
      'DDC Ghee 500ml',
      'Ilam Tea 500g',
      'Masoor Dal 1kg',
      'Wai Wai Noodles (pack of 30)',
    ]);
  });

  it('Out of Stock is a flag: the stock count is never overwritten', () => {
    catalogue().setAvailable('seed-1', false);
    expect(product('seed-1')).toMatchObject({ isAvailable: false, stockQuantity: 12 });

    catalogue().setAvailable('seed-1', true);
    expect(product('seed-1')).toMatchObject({ isAvailable: true, stockQuantity: 12 });
  });

  it('changes that one product only', () => {
    const before = product('seed-3');
    catalogue().setAvailable('seed-1', false);
    expect(product('seed-3')).toBe(before);
  });

  it('adds a product, available, in name order; an edit keeps the availability flag', () => {
    const id = catalogue().addProduct({
      name: 'Curd 1L',
      priceNpr: 180,
      categoryId: 'dairy',
      stockQuantity: 6,
    });
    expect(catalogue().products.map((each) => each.name)[1]).toBe('Curd 1L');
    expect(product(id)?.isAvailable).toBe(true);

    catalogue().setAvailable(id, false);
    catalogue().updateProduct(id, {
      name: 'Curd 1L',
      priceNpr: 190,
      categoryId: 'dairy',
      stockQuantity: 0,
    });
    expect(product(id)).toMatchObject({ priceNpr: 190, stockQuantity: 0, isAvailable: false });
  });
});

describe('Catalogue tab', () => {
  it('lists the products with name, category, price and stock', () => {
    renderWithProviders(<VendorCatalogueScreen />);

    const row = within(screen.getByTestId('product-seed-1'));
    expect(row.getByText('Basmati Rice 5kg')).toBeOnTheScreen();
    expect(row.getByText('Rice, Flour & Pulses')).toBeOnTheScreen();
    expect(row.getByText('Rs. 1150')).toBeOnTheScreen();
    expect(screen.getByTestId('product-stock-seed-1')).toHaveTextContent('In stock: 12');
    expect(screen.getByTestId('product-stock-switch-seed-1').props.value).toBe(true);
    expect(screen.getByTestId('catalogue-sample-note')).toBeOnTheScreen();
  });

  it('shows a product switched out of stock with its switch off, whatever its count', () => {
    renderWithProviders(<VendorCatalogueScreen />);

    expect(product('seed-2')?.stockQuantity).toBe(8);
    expect(screen.getByTestId('product-stock-seed-2')).toHaveTextContent('Out of stock');
    expect(screen.getByTestId('product-stock-switch-seed-2').props.value).toBe(false);
  });

  it('says "No stock left" for a product that is switched on but has none to sell', () => {
    renderWithProviders(<VendorCatalogueScreen />);

    expect(screen.getByTestId('product-stock-seed-5')).toHaveTextContent('No stock left');
    expect(screen.getByTestId('product-stock-switch-seed-5').props.value).toBe(true);
  });

  it('switches a product out of stock and back, at once, on its row', () => {
    renderWithProviders(<VendorCatalogueScreen />);

    fireEvent(screen.getByTestId('product-stock-switch-seed-1'), 'valueChange', false);
    expect(screen.getByTestId('product-stock-seed-1')).toHaveTextContent('Out of stock');
    expect(screen.getByTestId('product-stock-switch-seed-1').props.value).toBe(false);
    expect(product('seed-1')?.stockQuantity).toBe(12); // the count is kept
    // Only that row changed.
    expect(screen.getByTestId('product-stock-seed-3')).toHaveTextContent('In stock: 30');

    fireEvent(screen.getByTestId('product-stock-switch-seed-1'), 'valueChange', true);
    expect(screen.getByTestId('product-stock-seed-1')).toHaveTextContent('In stock: 12');
  });

  it('opens a new product from the Add button and an existing one from its row', () => {
    renderWithProviders(<VendorCatalogueScreen />);

    press('catalogue-add');
    expect(router.push).toHaveBeenLastCalledWith('/product');

    press('product-edit-seed-3');
    expect(router.push).toHaveBeenLastCalledWith({
      pathname: '/product',
      params: { id: 'seed-3' },
    });
  });

  it('shows Nepali digits under ne', () => {
    renderWithProviders(<VendorCatalogueScreen />, { locale: 'ne' });
    expect(screen.getByTestId('product-stock-seed-1')).toHaveTextContent('स्टकमा: १२');
  });

  it('says so when the shop has no product', () => {
    useVendorCatalogueStore.setState({ products: [] });
    renderWithProviders(<VendorCatalogueScreen />);
    expect(screen.getByTestId('catalogue-empty')).toBeOnTheScreen();
  });
});

describe('product form screen', () => {
  it('adds a product: name, price, a category picked from the list, and stock', () => {
    renderWithProviders(<VendorProductScreen />);
    expect(screen.getByTestId('product-form-title')).toHaveTextContent('New product');

    type('product-name', 'Local Honey 500g');
    type('product-price', '900');
    press('product-category');
    type('product-category-search', 'honey');
    expect(screen.queryByTestId('product-category-option-dairy')).not.toBeOnTheScreen();
    press('product-category-option-honey-spreads');
    expect(screen.getByTestId('product-category')).toHaveTextContent('Honey & Spreads');
    type('product-stock', '8');
    press('product-save');

    expect(catalogue().products).toHaveLength(6);
    expect(catalogue().products.find((each) => each.name === 'Local Honey 500g')).toMatchObject({
      priceNpr: 900,
      categoryId: 'honey-spreads',
      stockQuantity: 8,
    });
    expect(toast()).toMatchObject({ message: 'Product added.', tone: 'success' });
    expect(router.navigate).toHaveBeenCalledWith('/catalogue');
  });

  it('saves nothing and marks the fields while the form is incomplete', () => {
    renderWithProviders(<VendorProductScreen />);

    press('product-save');

    expect(screen.getByTestId('product-name-error')).toHaveTextContent('Enter a product name.');
    expect(screen.getByTestId('product-price-error')).toHaveTextContent('Enter a price above 0.');
    expect(screen.getByTestId('product-category-error')).toHaveTextContent('Choose a category.');
    expect(catalogue().products).toHaveLength(5);
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('refuses a second product with the same name', () => {
    renderWithProviders(<VendorProductScreen />);
    type('product-name', 'ilam tea 500g');
    type('product-price', '400');
    press('product-category');
    press('product-category-option-tea-coffee');

    press('product-save');

    expect(screen.getByTestId('product-name-error')).toHaveTextContent(
      'You already have a product with this name.',
    );
    expect(catalogue().products).toHaveLength(5);
  });

  it('edits an existing product, filled in from the catalogue, keeping its own name', () => {
    openProduct('seed-3');
    renderWithProviders(<VendorProductScreen />);
    expect(screen.getByTestId('product-form-title')).toHaveTextContent('Edit product');
    expect(screen.getByTestId('product-name')).toHaveDisplayValue('Ilam Tea 500g');
    expect(screen.getByTestId('product-price')).toHaveDisplayValue('450');
    expect(screen.getByTestId('product-category')).toHaveTextContent('Tea & Coffee');
    expect(screen.getByTestId('product-stock')).toHaveDisplayValue('30');

    type('product-price', '475');
    type('product-stock', '२५');
    press('product-save');

    expect(product('seed-3')).toMatchObject({ priceNpr: 475, stockQuantity: 25 });
    expect(catalogue().products).toHaveLength(5);
    expect(toast()?.message).toBe('Product updated.');
  });

  it('starts a fresh form when the route is reused for another product', () => {
    openProduct('seed-3');
    const view = renderWithProviders(<VendorProductScreen />);
    expect(screen.getByTestId('product-name')).toHaveDisplayValue('Ilam Tea 500g');

    openProduct();
    view.rerender(<VendorProductScreen />);

    expect(screen.getByTestId('product-name')).toHaveDisplayValue('');
    expect(screen.getByTestId('product-form-title')).toHaveTextContent('New product');
  });

  it('has a placeholder for photos that says upload is coming', () => {
    renderWithProviders(<VendorProductScreen />);

    press('product-image-upload');

    expect(toast()?.message).toBe('Photo upload is coming soon.');
    expect(catalogue().products).toHaveLength(5);
  });
});
