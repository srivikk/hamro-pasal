import { useEffect, type ReactNode } from 'react';
import { View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

/**
 * A loading placeholder: grey blocks in the shape of what is coming, pulsing together. One
 * animation drives the whole group (the blocks themselves are plain views), on the UI thread.
 */
export function SkeletonGroup({
  children,
  testID,
  fill = false,
}: {
  children: ReactNode;
  testID: string;
  /** Take the remaining height of the screen (a full-screen loading state). */
  fill?: boolean;
}) {
  const opacity = useSharedValue(1);
  useEffect(() => {
    opacity.value = withRepeat(withTiming(0.45, { duration: 750 }), -1, true);
  }, [opacity]);
  const pulse = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.View
      testID={testID}
      accessibilityRole="progressbar"
      accessibilityState={{ busy: true }}
      style={[fill ? { flex: 1 } : null, pulse]}
    >
      {children}
    </Animated.View>
  );
}

/** One grey block. Size and corner radius come from `className` ("h-4 w-32 rounded"). */
export function SkeletonBlock({ className }: { className: string }) {
  return <View className={`bg-gray-200 ${className}`} />;
}

function VendorCardSkeleton() {
  return (
    <View className="mx-4 mb-4 rounded-2xl bg-white shadow-sm">
      <SkeletonBlock className="h-40 rounded-t-2xl" />
      <View className="gap-2 p-4">
        <SkeletonBlock className="h-5 w-2/3 rounded" />
        <SkeletonBlock className="h-4 w-1/2 rounded" />
        <SkeletonBlock className="h-3 w-3/4 rounded" />
      </View>
    </View>
  );
}

/** The Home feed while GET /api/vendors is on its way: a heading and three shop cards. */
export function FeedSkeleton({ testID }: { testID: string }) {
  return (
    <SkeletonGroup testID={testID}>
      <View className="px-4 pb-3 pt-4">
        <SkeletonBlock className="h-5 w-40 rounded" />
      </View>
      <VendorCardSkeleton />
      <VendorCardSkeleton />
      <VendorCardSkeleton />
    </SkeletonGroup>
  );
}

function RowSkeleton() {
  return (
    <View className="mx-4 mb-3 flex-row items-center rounded-2xl bg-white p-4 shadow-sm">
      <SkeletonBlock className="mr-3 h-16 w-16 rounded-xl" />
      <View className="flex-1 gap-2">
        <SkeletonBlock className="h-4 w-3/4 rounded" />
        <SkeletonBlock className="h-4 w-1/3 rounded" />
      </View>
      <SkeletonBlock className="h-9 w-16 rounded-xl" />
    </View>
  );
}

/** A list of product rows (search results, a category's shops being worked out). */
export function RowsSkeleton({ testID, rows = 5 }: { testID: string; rows?: number }) {
  return (
    <SkeletonGroup testID={testID}>
      <View className="pt-4">
        {Array.from({ length: rows }, (_, index) => (
          <RowSkeleton key={index} />
        ))}
      </View>
    </SkeletonGroup>
  );
}

/** A shop's page while its menu loads: the banner, the info card, the search bar and some rows. */
export function ShopSkeleton({ testID }: { testID: string }) {
  return (
    <SkeletonGroup testID={testID} fill>
      <SkeletonBlock className="h-48" />
      <View className="-mt-12 mx-4 gap-3 rounded-2xl bg-white p-4 shadow-sm">
        <SkeletonBlock className="h-6 w-2/3 rounded" />
        <SkeletonBlock className="h-4 w-1/2 rounded" />
        <SkeletonBlock className="h-4 w-1/3 rounded" />
      </View>
      <View className="mx-4 mt-4">
        <SkeletonBlock className="h-12 rounded-xl" />
      </View>
      <View className="px-4 pb-2 pt-5">
        <SkeletonBlock className="h-5 w-32 rounded" />
      </View>
      <RowSkeleton />
      <RowSkeleton />
      <RowSkeleton />
    </SkeletonGroup>
  );
}

/** An order's page while GET /api/orders/:id is on its way: the heading, the timeline, the bill. */
export function OrderSkeleton({ testID }: { testID: string }) {
  return (
    <SkeletonGroup testID={testID} fill>
      <View className="gap-4 p-4">
        <View className="gap-2">
          <SkeletonBlock className="h-6 w-1/2 rounded" />
          <SkeletonBlock className="h-4 w-1/3 rounded" />
        </View>
        <SkeletonBlock className="h-48 rounded-2xl" />
        <SkeletonBlock className="h-32 rounded-2xl" />
        <SkeletonBlock className="h-40 rounded-2xl" />
      </View>
    </SkeletonGroup>
  );
}
