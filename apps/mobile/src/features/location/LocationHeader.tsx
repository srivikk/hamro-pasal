import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useState, type ComponentProps, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MapPinPicker } from '../../components/MapPinPicker';
import { formatLocalizedNumber } from '../../i18n/format-number';
import { selectSelectedAddress, useAddressStore } from '../../store/useAddressStore';
import { selectHasSession, useAuthStore } from '../../store/useAuthStore';
import { useBrowseLocationStore } from '../../store/useBrowseLocationStore';
import { colors } from '../../theme/colors';
import { ADDRESS_LABEL_STYLE, fullAddressText } from '../address/AddressBookModal';
import { formatAddressLine } from '../address/address-form';
import { currentPinPosition } from '../territory/device-territory';
import type { Coordinates } from '../territory/territory';
import { describePlace } from './describe-place';
import { useHeaderTone } from './header-phase';
import { MAX_PLACE_SEARCH_LENGTH, usePlaceSuggestions } from './place-search';

export interface LocationPickerDeps {
  /** The device position (or the __DEV__ simulator's); null when it cannot be read. */
  locate?: () => Promise<Coordinates | null>;
  /** Opens the OS settings page of the app (to switch the location permission on). */
  openSettings?: () => void;
}

/** A tappable row of the selector: icon tile, title, optional subtitle, chevron. */
function Row({
  icon,
  tint = colors.brand,
  tile = 'bg-brand-light',
  title,
  subtitle,
  testID,
  disabled = false,
  onPress,
}: {
  icon: ComponentProps<typeof Ionicons>['name'];
  tint?: string;
  tile?: string;
  title: string;
  subtitle?: string;
  testID: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled }}
      disabled={disabled}
      testID={testID}
      className={`flex-row items-center gap-3 px-4 py-3 active:bg-gray-100 ${
        disabled ? 'opacity-40' : ''
      }`}
      onPress={onPress}
    >
      <View className={`h-10 w-10 items-center justify-center rounded-xl ${tile}`}>
        <Ionicons name={icon} size={20} color={tint} />
      </View>
      <View className="flex-1">
        <Text className="text-base font-bold text-gray-900" numberOfLines={1}>
          {title}
        </Text>
        {subtitle === undefined || subtitle === '' ? null : (
          <Text className="mt-0.5 text-sm leading-5 text-gray-500" numberOfLines={2}>
            {subtitle}
          </Text>
        )}
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.inactive} />
    </Pressable>
  );
}

function Card({ children }: { children: ReactNode }) {
  return <View className="overflow-hidden rounded-2xl bg-white shadow-sm">{children}</View>;
}

function Divider() {
  return <View className="ml-16 h-px bg-gray-100" />;
}

interface LocationPickerProps {
  deps: LocationPickerDeps;
  /** Dismissed without choosing, or after a choice (then `onChosen` ran first). */
  onClose: () => void;
  /** A location was written to useBrowseLocationStore. */
  onChosen?: () => void;
}

/**
 * "Select delivery location": the screen a visitor gets when the device location is off and
 * nothing was chosen, and the one the Home header opens. With an empty search field it offers
 * the current location, the map and the saved addresses; from two typed characters on it lists
 * live suggestions instead. Every choice goes into useBrowseLocationStore, so the feed and menus
 * follow it at once.
 */
function LocationPicker({ deps, onClose, onChosen }: LocationPickerProps) {
  const { t } = useTranslation();
  const locale = useAuthStore((state) => state.locale);
  // Saved addresses are personal data: a signed-out visitor is not shown them.
  const signedIn = useAuthStore(selectHasSession);
  const addresses = useAddressStore((state) => state.addresses);
  const setOverride = useBrowseLocationStore((state) => state.setOverride);
  const clearOverride = useBrowseLocationStore((state) => state.clearOverride);
  const override = useBrowseLocationStore((state) => state.override);
  // No device position: the permission was refused (or GPS is off).
  const deviceOff = useBrowseLocationStore((state) => state.device === null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [gpsFailed, setGpsFailed] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const search = usePlaceSuggestions(query);

  const choose = (position: Coordinates, label: string, palika: string | null = null): void => {
    const accepted = setOverride({
      lat: position.latitude,
      lng: position.longitude,
      label,
      municipalityPalika: palika,
    });
    if (!accepted) return;
    onChosen?.();
    onClose();
  };

  /** A captured point is shown by its name; never by its coordinates. */
  const chooseNamed = async (position: Coordinates, fallback: string): Promise<void> => {
    setBusy(true);
    const name = await describePlace(position);
    setBusy(false);
    choose(position, name ?? fallback);
  };

  const locateDevice = async (): Promise<void> => {
    setBusy(true);
    setGpsFailed(false);
    const position = await (deps.locate ?? currentPinPosition)().catch(() => null);
    setBusy(false);
    if (position === null) setGpsFailed(true);
    else await chooseNamed(position, t('browseLocation.currentLocation'));
  };

  return (
    <SafeAreaView className="flex-1 bg-gray-50">
      <View className="flex-row items-center gap-2 bg-white px-2 py-3 shadow-sm">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('address.cancel')}
          testID="location-picker-close"
          hitSlop={8}
          className="h-10 w-10 items-center justify-center rounded-full active:bg-gray-100"
          onPress={onClose}
        >
          <Ionicons name="chevron-down" size={24} color="#111827" />
        </Pressable>
        <Text className="text-xl font-bold text-gray-900" accessibilityRole="header">
          {t('browseLocation.title')}
        </Text>
      </View>
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 16 }}
        keyboardShouldPersistTaps="handled"
      >
        {deviceOff ? (
          <View
            className="flex-row items-center gap-3 rounded-2xl bg-red-50 p-4"
            testID="location-off-banner"
          >
            <Ionicons name="location" size={22} color="#DC2626" />
            <View className="flex-1">
              <Text className="text-base font-bold text-gray-900">
                {t('browseLocation.deviceOffTitle')}
              </Text>
              <Text className="mt-0.5 text-sm text-gray-500">
                {t('browseLocation.deviceOffBody')}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('browseLocation.enable')}
              testID="location-enable"
              className="rounded-xl bg-brand px-4 py-2 active:bg-brand-dark"
              onPress={() => {
                (deps.openSettings ?? (() => void Linking.openSettings()))();
              }}
            >
              <Text className="text-sm font-bold text-white">{t('browseLocation.enable')}</Text>
            </Pressable>
          </View>
        ) : null}

        <View className="flex-row items-center rounded-xl bg-white px-3 shadow-sm">
          <Ionicons name="search" size={18} color={colors.inactive} />
          <TextInput
            testID="place-search"
            value={query}
            onChangeText={setQuery}
            placeholder={t('browseLocation.searchPlaceholder')}
            accessibilityLabel={t('browseLocation.searchPlaceholder')}
            maxLength={MAX_PLACE_SEARCH_LENGTH}
            autoCorrect={false}
            returnKeyType="search"
            className="flex-1 px-2 py-3 text-base text-gray-900"
          />
          {search.loading ? (
            <ActivityIndicator size="small" color={colors.brand} testID="place-search-loading" />
          ) : query === '' ? null : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('browseLocation.clearSearch')}
              testID="place-search-clear"
              hitSlop={8}
              onPress={() => {
                setQuery('');
              }}
            >
              <Ionicons name="close-circle" size={20} color={colors.inactive} />
            </Pressable>
          )}
        </View>

        {search.active ? (
          // Two or more characters: the suggestions replace the default view.
          search.failed ? (
            <Text className="text-sm text-red-700" testID="place-search-problem">
              {t('browseLocation.searchFailed')}
            </Text>
          ) : search.loading ? (
            <Text className="px-1 text-sm text-gray-500">{t('browseLocation.searching')}</Text>
          ) : search.suggestions.length === 0 ? (
            <Text className="text-sm text-gray-500" testID="place-search-problem">
              {t('browseLocation.notFound')}
            </Text>
          ) : (
            <Card>
              {search.suggestions.map((suggestion, index) => (
                <View key={suggestion.id}>
                  {index === 0 ? null : <Divider />}
                  <Row
                    icon="location"
                    tint="#B45309"
                    tile="bg-amber-100"
                    title={suggestion.title}
                    subtitle={suggestion.subtitle}
                    testID={`place-suggestion-${suggestion.id}`}
                    onPress={() => {
                      choose(
                        { latitude: suggestion.lat, longitude: suggestion.lng },
                        suggestion.label,
                      );
                    }}
                  />
                </View>
              ))}
            </Card>
          )
        ) : (
          <>
            {gpsFailed ? (
              <Text className="text-sm text-red-700" testID="place-search-problem">
                {t('browseLocation.gpsFailed')}
              </Text>
            ) : null}
            <Card>
              <Row
                icon="locate"
                title={t('browseLocation.useCurrent')}
                subtitle={t('browseLocation.useCurrentHint')}
                testID="browse-current-location"
                disabled={busy}
                onPress={() => void locateDevice()}
              />
              <Divider />
              <Row
                icon="map"
                title={t('browseLocation.pickOnMap')}
                testID="browse-pick-on-map"
                onPress={() => {
                  setMapOpen(true);
                }}
              />
              {override === null ? null : (
                <>
                  <Divider />
                  <Row
                    icon="refresh"
                    tint={colors.inactive}
                    tile="bg-gray-100"
                    title={t('browseLocation.reset')}
                    testID="browse-reset"
                    onPress={() => {
                      clearOverride();
                      onClose();
                    }}
                  />
                </>
              )}
            </Card>

            {signedIn && addresses.length > 0 ? (
              <View className="gap-2">
                <Text className="text-xs font-bold uppercase tracking-wide text-gray-500">
                  {t('browseLocation.savedAddresses')}
                </Text>
                <Card>
                  {addresses.map((entry, index) => {
                    const style = ADDRESS_LABEL_STYLE[entry.label];
                    const ward = formatLocalizedNumber(entry.address.ward_number, locale);
                    return (
                      <View key={entry.id}>
                        {index === 0 ? null : <Divider />}
                        <Row
                          icon={style.icon}
                          tint={style.color}
                          tile={style.tile}
                          title={t(`address.label.${entry.label}`)}
                          subtitle={fullAddressText(entry, ward)}
                          testID={`browse-address-${entry.id}`}
                          onPress={() => {
                            choose(
                              {
                                latitude: entry.address.exact_lat,
                                longitude: entry.address.exact_lng,
                              },
                              formatAddressLine(entry.address, ward),
                              entry.address.municipality_palika_string,
                            );
                          }}
                        />
                      </View>
                    );
                  })}
                </Card>
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
      <MapPinPicker
        visible={mapOpen}
        initial={override === null ? null : { latitude: override.lat, longitude: override.lng }}
        onConfirm={(position) => {
          setMapOpen(false);
          void chooseNamed(position, t('browseLocation.pinnedLocation'));
        }}
        onClose={() => {
          setMapOpen(false);
        }}
      />
    </SafeAreaView>
  );
}

/** The selector as a full-screen modal: used by the Home header and by the welcome screen. */
export function LocationSelectorModal({
  visible,
  deps = {},
  onClose,
  onChosen,
}: {
  visible: boolean;
  deps?: LocationPickerDeps;
  onClose: () => void;
  onChosen?: () => void;
}) {
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      {/* Mounted per opening, so each visit starts with an empty search. */}
      {visible ? (
        <LocationPicker
          deps={deps}
          onClose={onClose}
          {...(onChosen === undefined ? {} : { onChosen })}
        />
      ) : null}
    </Modal>
  );
}

/**
 * The Home header row: "Hamro Pasal in" over the place the shops are listed around, with a
 * chevron (tap to change it by hand: search a place, pick it on the map, use the device position,
 * or a saved address), and the round profile button at the right. When no location is known (permission refused and nothing selected) it reads
 * "Select Location". The choice only moves the feed and menus; an order is still delivered to
 * the delivery address.
 *
 * `open` / `onOpenChange` let the screen open the selector too.
 */
export function LocationHeader({
  deps = {},
  open: controlledOpen,
  onOpenChange,
}: {
  deps?: LocationPickerDeps;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const locale = useAuthStore((state) => state.locale);
  const signedIn = useAuthStore(selectHasSession);
  const override = useBrowseLocationStore((state) => state.override);
  const device = useBrowseLocationStore((state) => state.device);
  const delivery = useAddressStore(selectSelectedAddress);
  // Dark text on the day gradients, white on the night sky (see HeaderGradient).
  const night = useHeaderTone() === 'light';
  const [ownOpen, setOwnOpen] = useState(false);
  const open = controlledOpen ?? ownOpen;
  const setOpen = (next: boolean): void => {
    setOwnOpen(next);
    onOpenChange?.(next);
  };

  // The same order as useCustomerLocation: chosen place, device position, delivery address.
  const label =
    override !== null
      ? override.label
      : device !== null
        ? (device.label ?? t('browseLocation.currentLocation'))
        : delivery === null
          ? null
          : signedIn
            ? formatAddressLine(
                delivery.address,
                formatLocalizedNumber(delivery.address.ward_number, locale),
              )
            : delivery.address.municipality_palika_string;

  return (
    <>
      {/* No background of its own: on Home it sits on the header gradient. */}
      <View className="flex-row items-center">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('browseLocation.change')}
          testID="location-header"
          className="flex-1 px-4 pb-2 pt-3 active:opacity-70"
          onPress={() => {
            setOpen(true);
          }}
        >
          <Text
            className={`text-xl font-extrabold ${night ? 'text-white' : 'text-gray-900'}`}
            testID="location-header-title"
          >
            {t('browseLocation.appIn')}
          </Text>
          <View className="mt-0.5 flex-row items-center gap-1">
            <Text
              className={`shrink text-sm font-semibold ${
                // "Select Location" keeps an accent; on the night sky the brand red is too dark.
                label === null
                  ? night
                    ? 'text-amber-300'
                    : 'text-brand'
                  : night
                    ? 'text-white'
                    : 'text-gray-800'
              }`}
              numberOfLines={1}
              testID="location-header-label"
            >
              {label ?? t('browseLocation.select')}
            </Text>
            <Ionicons name="chevron-down" size={16} color={night ? '#FFFFFF' : '#1F2937'} />
          </View>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('tabs.profile')}
          testID="header-profile"
          hitSlop={8}
          className="mr-4 h-10 w-10 items-center justify-center rounded-full bg-white shadow-sm active:bg-gray-100"
          onPress={() => {
            router.push('/profile');
          }}
        >
          <Ionicons name="person" size={20} color="#1F2937" />
        </Pressable>
      </View>
      <LocationSelectorModal
        visible={open}
        deps={deps}
        onClose={() => {
          setOpen(false);
        }}
      />
    </>
  );
}
