import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { SegmentedControl } from '../../src/components/SegmentedControl';
import { MyOffers } from '../../src/features/vendor/MarketingSections';
import { VendorAdsSection } from '../../src/features/vendor/VendorAdsSection';
import { VendorCampaignsSection } from '../../src/features/vendor/VendorCampaignsSection';
import { VendorSectionPlaceholder } from '../../src/features/vendor/VendorSectionPlaceholder';
import { VENDOR_MARKETING_MOCKS_ENABLED } from '../../src/store/useVendorMarketingStore';

const SECTIONS = ['OFFERS', 'CAMPAIGNS', 'ADS'] as const;
type MarketingSection = (typeof SECTIONS)[number];

/**
 * Vendor flow steps 10–11 (SPEC core sections 7 and 8), in three clearly separated sections:
 * My Offers (discounts the vendor funds itself), Campaigns (platform campaigns, joined only by the
 * vendor's own explicit opt-in) and the Ad Marketplace (sponsored placements the vendor buys).
 *
 * Campaigns and Ads read and write the API (/api/vendor/campaigns, /api/vendor/ads). My Offers
 * still runs on sample data held on the device in development builds (vendor offers have no
 * backend yet); a production build shows its placeholder there. No offer discounts any order.
 */
export default function VendorMarketingScreen() {
  const { t } = useTranslation();
  const [section, setSection] = useState<MarketingSection>('OFFERS');

  return (
    <View className="flex-1 bg-gray-50" testID="vendor-marketing">
      <View className="px-4 pt-4">
        <SegmentedControl
          testID="marketing-section"
          segments={SECTIONS.map((value) => ({
            value,
            label: t(`vendorMarketing.section.${value}`),
          }))}
          selected={section}
          onSelect={setSection}
        />
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        {section === 'OFFERS' ? (
          VENDOR_MARKETING_MOCKS_ENABLED ? (
            <MyOffers />
          ) : (
            <VendorSectionPlaceholder
              testID="vendor-offers-placeholder"
              icon="pricetags-outline"
              title={t('vendorMarketing.section.OFFERS')}
              body={t('vendorTabs.marketing.body')}
              items={[t('vendorTabs.marketing.offers')]}
            />
          )
        ) : null}
        {section === 'CAMPAIGNS' ? <VendorCampaignsSection /> : null}
        {section === 'ADS' ? <VendorAdsSection /> : null}
      </ScrollView>
    </View>
  );
}
