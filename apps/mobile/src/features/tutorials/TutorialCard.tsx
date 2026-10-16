import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useDismissedTutorialsStore } from '../../store/useDismissedTutorialsStore';
import { thumbnailUrl } from './tutorial-embed';
import { TutorialPlayerModal } from './TutorialPlayerModal';
import { useTutorials } from './useTutorials';

/**
 * Step 7.8 (SPEC core 11, app additions 5): a small floating card with the first tutorial this
 * phone has not dismissed. Tapping it plays the video inside the app; "Don't show again" hides
 * that video's card for good (kept in MMKV), and the next video, if any, takes its place.
 */
export function TutorialCard() {
  const { t } = useTranslation();
  const tutorials = useTutorials();
  const dismissed = useDismissedTutorialsStore((state) => state.dismissed);
  const dismiss = useDismissedTutorialsStore((state) => state.dismiss);
  const [playing, setPlaying] = useState(false);

  const next = tutorials.data?.find((video) => dismissed[video.youtube_video_id] !== true);
  if (next === undefined) return null;

  return (
    <View
      testID="tutorial-card"
      className="absolute bottom-24 left-4 right-4 flex-row items-center gap-3 rounded-2xl bg-white p-3 shadow-lg"
    >
      <Pressable
        testID="tutorial-card-play"
        accessibilityRole="button"
        accessibilityLabel={t('tutorials.play', { title: next.title })}
        className="flex-1 flex-row items-center gap-3 active:opacity-70"
        onPress={() => {
          setPlaying(true);
        }}
      >
        <View>
          <Image
            testID="tutorial-card-thumbnail"
            source={{ uri: thumbnailUrl(next.youtube_video_id) }}
            className="h-14 w-24 rounded-lg bg-gray-200"
          />
          <View className="absolute inset-0 items-center justify-center">
            <Ionicons name="play-circle" size={28} color="#FFFFFF" />
          </View>
        </View>
        <View className="flex-1">
          <Text className="text-xs font-semibold uppercase text-brand">{t('tutorials.label')}</Text>
          <Text className="text-sm font-semibold text-gray-900" numberOfLines={2}>
            {next.title}
          </Text>
        </View>
      </Pressable>
      <Pressable
        testID="tutorial-card-dismiss"
        accessibilityRole="button"
        accessibilityLabel={t('tutorials.dontShowAgain')}
        hitSlop={8}
        onPress={() => {
          dismiss(next.youtube_video_id);
        }}
      >
        <Text className="text-xs font-semibold text-gray-500">{t('tutorials.dontShowAgain')}</Text>
      </Pressable>
      <TutorialPlayerModal
        videoId={playing ? next.youtube_video_id : null}
        title={next.title}
        onClose={() => {
          setPlaying(false);
        }}
      />
    </View>
  );
}
