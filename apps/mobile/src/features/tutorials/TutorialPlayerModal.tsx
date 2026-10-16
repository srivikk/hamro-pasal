import Ionicons from '@expo/vector-icons/Ionicons';
import { Modal, Pressable, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';

import { embedUrl, isEmbedNavigation } from './tutorial-embed';

/**
 * Step 7.8 (SPEC core 11): the tutorial plays inside the app, in YouTube's embedded player in a
 * WebView. Every navigation away from this video's embed page is refused (the YouTube logo,
 * "Watch on YouTube", a channel link), new windows are not opened, and the app never hands the
 * video to the YouTube app or the browser. Inline and full-screen playback are allowed.
 */
export function TutorialPlayerModal({
  videoId,
  title,
  onClose,
}: {
  /** null: closed. */
  videoId: string | null;
  title: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Modal
      visible={videoId !== null}
      animationType="slide"
      onRequestClose={onClose}
      supportedOrientations={['portrait', 'landscape']}
    >
      <SafeAreaView className="flex-1 bg-black">
        <View className="flex-row items-center justify-between px-4 py-3">
          <Text className="flex-1 text-base font-semibold text-white" numberOfLines={1}>
            {title}
          </Text>
          <Pressable
            testID="tutorial-player-close"
            accessibilityRole="button"
            accessibilityLabel={t('tutorials.close')}
            hitSlop={10}
            onPress={onClose}
          >
            <Ionicons name="close" size={26} color="#FFFFFF" />
          </Pressable>
        </View>
        {videoId === null ? null : (
          <View className="flex-1 justify-center">
            <View style={{ aspectRatio: 16 / 9, width: '100%' }}>
              <WebView
                testID="tutorial-player"
                source={{ uri: embedUrl(videoId) }}
                allowsInlineMediaPlayback
                allowsFullscreenVideo
                mediaPlaybackRequiresUserAction={false}
                javaScriptEnabled
                setSupportMultipleWindows={false}
                onShouldStartLoadWithRequest={(request) => isEmbedNavigation(request.url, videoId)}
                style={{ backgroundColor: '#000000' }}
              />
            </View>
          </View>
        )}
      </SafeAreaView>
    </Modal>
  );
}
