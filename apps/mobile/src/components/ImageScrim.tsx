import { StyleSheet, View } from 'react-native';

import { LinearGradient } from '../lib/optional-linear-gradient';

const SCRIM_COLORS = ['rgba(0,0,0,0)', 'rgba(0,0,0,0.78)'] as const;

/**
 * The dark fade over the lower part of a cover image, so white text on it stays readable. A dev
 * client without the native gradient view gets a flat translucent band instead.
 */
export function ImageScrim() {
  return (
    <View className="absolute bottom-0 left-0 right-0 h-2/3" pointerEvents="none">
      {LinearGradient === null ? (
        <View style={StyleSheet.absoluteFill} className="bg-black/40" testID="image-scrim-flat" />
      ) : (
        <LinearGradient colors={SCRIM_COLORS} style={StyleSheet.absoluteFill} />
      )}
    </View>
  );
}
