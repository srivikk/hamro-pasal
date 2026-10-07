import { requireOptionalNativeModule } from 'expo';
import type { LinearGradient as LinearGradientComponent } from 'expo-linear-gradient';

/**
 * expo-linear-gradient draws with a native view. A development client built before the package
 * was added does not contain it, and rendering it there is a red screen; so the native view is
 * used only when the build has it, and callers draw a flat fallback until the client is rebuilt.
 */
const nativeGradientAvailable = requireOptionalNativeModule('ExpoLinearGradient') !== null;

function loadLinearGradient(): typeof LinearGradientComponent {
  // Required only when the build has the view, never unconditionally, for the reason above.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('expo-linear-gradient') as { LinearGradient: typeof LinearGradientComponent })
    .LinearGradient;
}

/** The native gradient view, resolved once; null on a build that does not contain it. */
export const LinearGradient = nativeGradientAvailable ? loadLinearGradient() : null;
