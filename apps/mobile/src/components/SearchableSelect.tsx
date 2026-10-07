import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { colors } from '../theme/colors';

export interface SelectOption {
  value: string;
  label: string;
}

/** The options whose label contains every word typed, in any letter case. */
export function filterOptions(
  options: readonly SelectOption[],
  query: string,
): readonly SelectOption[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return options;
  return options.filter((option) => {
    const label = option.label.toLowerCase();
    return words.every((word) => label.includes(word));
  });
}

interface SearchableSelectProps {
  testID: string;
  options: readonly SelectOption[];
  /** What the closed control reads when nothing is chosen ("Choose a category"). */
  placeholder: string;
  /** The current choice's label, for a single-choice control. */
  selectedLabel?: string | null;
  searchPlaceholder: string;
  /** Shown when no option matches what was typed. */
  emptyText: string;
  onSelect: (value: string) => void;
  /** The field failed validation: red border. */
  invalid?: boolean;
}

/**
 * A dropdown with a search field: the closed control shows the choice, pressing it opens the
 * list under it, typing narrows the list, and choosing an option closes it. The value can only be
 * one of `options`, so nothing free-typed (and mistyped) is ever stored.
 *
 * The list is rendered in place, not virtualised: it is meant for short lists (tens of options).
 */
export function SearchableSelect({
  testID,
  options,
  placeholder,
  selectedLabel = null,
  searchPlaceholder,
  emptyText,
  onSelect,
  invalid = false,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const matches = filterOptions(options, query);

  return (
    <View className="gap-2">
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={selectedLabel ?? placeholder}
        onPress={() => {
          setOpen((current) => !current);
          setQuery('');
        }}
        className={`min-h-12 flex-row items-center justify-between rounded-xl border bg-white px-4 ${invalid ? 'border-red-500' : 'border-gray-300'}`}
      >
        <Text
          className={`flex-1 text-base ${selectedLabel === null ? 'text-gray-500' : 'text-gray-900'}`}
        >
          {selectedLabel ?? placeholder}
        </Text>
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={20} color={colors.inactive} />
      </Pressable>

      {open ? (
        <View className="rounded-xl border border-gray-300 bg-white">
          <View className="flex-row items-center gap-2 border-b border-gray-200 px-3">
            <Ionicons name="search" size={18} color={colors.inactive} />
            <TextInput
              testID={`${testID}-search`}
              accessibilityLabel={searchPlaceholder}
              autoFocus
              value={query}
              onChangeText={setQuery}
              placeholder={searchPlaceholder}
              className="min-h-11 flex-1 text-base text-gray-900"
            />
          </View>
          {matches.length === 0 ? (
            <Text className="px-4 py-3 text-sm text-gray-500" testID={`${testID}-empty`}>
              {emptyText}
            </Text>
          ) : (
            matches.map((option) => (
              <Pressable
                key={option.value}
                testID={`${testID}-option-${option.value}`}
                accessibilityRole="button"
                onPress={() => {
                  onSelect(option.value);
                  setOpen(false);
                  setQuery('');
                }}
                className="border-b border-gray-100 px-4 py-3 active:bg-gray-100"
              >
                <Text className="text-base text-gray-900">{option.label}</Text>
              </Pressable>
            ))
          )}
        </View>
      ) : null}
    </View>
  );
}
