import { createI18n } from '../../i18n/i18n';
import { hiddenCategoryItem } from './checkout-refusals';

describe('422 CATEGORY_UNAVAILABLE at checkout (decided 2026-10-20)', () => {
  it('names the first item whose category was hidden', () => {
    expect(
      hiddenCategoryItem({ product_ids: ['a', 'b'], product_names: ['Green Tea Bags', 'Matcha'] }),
    ).toBe('Green Tea Bags');
  });

  it('falls back when the answer carries no names', () => {
    expect(hiddenCategoryItem(undefined)).toBeNull();
    expect(hiddenCategoryItem({ product_names: [] })).toBeNull();
  });

  it('reads as a sentence in both languages', () => {
    const en = createI18n('en');
    expect(en.t('checkout.errors.CATEGORY_UNAVAILABLE_NAMED', { name: 'Green Tea Bags' })).toBe(
      'Green Tea Bags belongs to a category that is no longer available. Remove it and try again.',
    );
    const ne = createI18n('ne');
    expect(
      ne.t('checkout.errors.CATEGORY_UNAVAILABLE_NAMED', { name: 'Green Tea Bags' }),
    ).toContain('Green Tea Bags');
  });
});
