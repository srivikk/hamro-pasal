import type { CategoryView } from '@hamro-pasal/shared-types';
import { Pressable, ScrollView, Text } from 'react-native';
import { useTranslation } from 'react-i18next';

function Pill({
  label,
  selected,
  onPress,
  testID,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      testID={testID}
      className={`mr-2 rounded-full border px-4 py-2 ${
        selected ? 'border-brand bg-brand' : 'border-neutral-300 bg-white'
      }`}
    >
      <Text className={`text-sm font-semibold ${selected ? 'text-white' : 'text-neutral-800'}`}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * One pill per root category, after a "Shops" pill that clears the filter. Choosing a root also
 * lists its subcategories' products (the API matches descendants).
 */
export function CategoryPills({
  categories,
  selectedId,
  onSelect,
}: {
  categories: readonly CategoryView[];
  selectedId: string | null;
  onSelect: (categoryId: string | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      className="flex-grow-0"
      contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 12 }}
      testID="category-pills"
    >
      <Pill
        label={t('discovery.shops')}
        selected={selectedId === null}
        testID="category-pill-shops"
        onPress={() => {
          onSelect(null);
        }}
      />
      {categories.map((category) => (
        <Pill
          key={category.id}
          label={category.name}
          selected={category.id === selectedId}
          testID={`category-pill-${category.id}`}
          onPress={() => {
            onSelect(category.id);
          }}
        />
      ))}
    </ScrollView>
  );
}
