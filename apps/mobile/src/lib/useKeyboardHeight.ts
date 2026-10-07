import { useEffect, useState } from 'react';
import { Keyboard } from 'react-native';

/**
 * The height of the software keyboard while it is showing, else 0. Android does not resize a
 * `Modal` for the keyboard (and `KeyboardAvoidingView` does not help there), so a scrollable form
 * adds this as bottom padding: every field can then be scrolled above the keys.
 */
export function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const shown = Keyboard.addListener('keyboardDidShow', (event) => {
      setHeight(event.endCoordinates.height);
    });
    const hidden = Keyboard.addListener('keyboardDidHide', () => {
      setHeight(0);
    });
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);

  return height;
}
