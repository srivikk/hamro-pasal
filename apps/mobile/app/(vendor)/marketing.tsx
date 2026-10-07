import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { SegmentedControl } from '../../src/components/SegmentedControl';
import {
  AdMarketplace,
  CampaignInvites,
  MyOffers,
} from '../../src/features/vendor/MarketingSections';
import { VendorSectionPlaceholder } from '../../src/features/vendor/VendorSectionPlaceholder';
import { VENDOR_MARKETING_MOCKS_ENABLED } from '../../src/store/useVendorMarketingStore';

const SECTIONS = ['OFFERS', 'CAMPAIGNS', 'ADS'] as const;
type MarketingSection = (typeof SECTIONS)[number];

/**
 * Vendor flow steps 10–11 (SPEC core sections 7 and 8), in three clearly separated sections:
 * My Offers (discounts the vendor funds itself), Campaigns (platform campaigns, joined only by the
 * vendor's own explicit opt-in) and the Ad Marketplace (sponsored placements the vendor buys).
 *
 * TODO: none of the backend exists yet (STATE_HANDOFF.md §8Z.5; BACKEND_CHECKLIST.md section 5).
 * The three sections run on sample data held on the device (development builds); a production
 * build shows the placeholder. No discount is applied to any order and no ad is charged.
 */
export default function VendorMarketingScreen() {
  const { t } = useTranslation();
  const [section, setSection] = useState<MarketingSection>('OFFERS');

  if (!VENDOR_MARKETING_MOCKS_ENABLED) {
    return (
      <VendorSectionPlaceholder
        testID="vendor-marketing"
        icon="megaphone-outline"
        title={t('vendorTabs.marketing.title')}
        body={t('vendorTabs.marketing.body')}
        items={[
          t('vendorTabs.marketing.offers'),
          t('vendorTabs.marketing.campaigns'),
          t('vendorTabs.marketing.ads'),
        ]}
      />
    );
  }

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
        {section === 'OFFERS' ? <MyOffers /> : null}
        {section === 'CAMPAIGNS' ? <CampaignInvites /> : null}
        {section === 'ADS' ? <AdMarketplace /> : null}
      </ScrollView>
    </View>
  );
}
