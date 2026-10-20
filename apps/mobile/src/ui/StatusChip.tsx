import { Text, View } from 'react-native';

/*
 * The order-status colour code shared by the Seller board, the customer's order screens and the
 * admin tables: marigold = new / waiting, Himalayan blue = in preparation, Nepali green = on its way
 * or done, red = refused or failed.
 */
export type StatusTone = 'new' | 'preparing' | 'dispatched' | 'done' | 'danger' | 'neutral';

export const STATUS_TONES: Readonly<
  Record<StatusTone, { chip: string; text: string; card: string }>
> = {
  new: {
    chip: 'bg-marigold-light',
    text: 'text-marigold-dark',
    card: 'border-marigold bg-marigold-light',
  },
  preparing: {
    chip: 'bg-himalaya-light',
    text: 'text-himalaya-dark',
    card: 'border-himalaya bg-himalaya-light',
  },
  dispatched: {
    chip: 'bg-nepal-light',
    text: 'text-nepal-dark',
    card: 'border-nepal bg-nepal-light',
  },
  done: { chip: 'bg-nepal-light', text: 'text-nepal-dark', card: 'border-line bg-surface' },
  danger: { chip: 'bg-brand-light', text: 'text-brand-dark', card: 'border-brand bg-brand-light' },
  neutral: { chip: 'bg-surface-muted', text: 'text-ink-muted', card: 'border-line bg-surface' },
};

export function StatusChip({
  label,
  tone,
  testID,
}: {
  label: string;
  tone: StatusTone;
  testID?: string;
}) {
  const style = STATUS_TONES[tone];
  return (
    <View className={`self-start rounded-full px-3 py-1 ${style.chip}`} testID={testID}>
      <Text className={`font-body-semibold text-xs uppercase tracking-wide ${style.text}`}>
        {label}
      </Text>
    </View>
  );
}
