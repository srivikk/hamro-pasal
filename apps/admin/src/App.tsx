import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import brandLogo from './assets/brand-logo.png';

import { useAdminApi, useSession, useSessionStore } from './app-context';
import { AdProductScreen } from './features/ads/AdProductScreen';
import { ApprovalScreen } from './features/approvals/ApprovalScreen';
import { AuditLogScreen } from './features/audit/AuditLogScreen';
import { AuthLogScreen } from './features/auth-logs/AuthLogScreen';
import { DisputeScreen } from './features/disputes/DisputeScreen';
import { LoginScreen } from './features/auth/LoginScreen';
import { portalOf } from './features/auth/login-rules';
import { CampaignScreen } from './features/campaigns/CampaignScreen';
import { CategoryScreen } from './features/categories/CategoryScreen';
import { DashboardScreen } from './features/dashboard/DashboardScreen';
import { ComplianceScreen } from './features/compliance/ComplianceScreen';
import { DeadLetterScreen } from './features/dlq/DeadLetterScreen';
import { PayoutScreen } from './features/finance/PayoutScreen';
import { LogisticsScreen } from './features/logistics/LogisticsScreen';
import { NotificationScreen } from './features/notifications/NotificationScreen';
import { ExportScreen } from './features/exports/ExportScreen';
import { OnboardingScreen } from './features/onboarding/OnboardingScreen';
import { TutorialScreen } from './features/onboarding/TutorialScreen';
import { PricingPlanScreen } from './features/pricing/PricingPlanScreen';
import { ProductScreen } from './features/products/ProductScreen';
import { PromotionScreen } from './features/promotions/PromotionScreen';
import { SettlementScreen } from './features/settlements/SettlementScreen';
import { VendorEarningsScreen } from './features/vendor-portal/VendorEarningsScreen';
import { VendorProductScreen } from './features/vendor-portal/VendorProductScreen';
import { VendorScreen } from './features/vendors/VendorScreen';
import {
  TAB_GROUPS,
  tabFromHash,
  VENDOR_TABS,
  vendorTabFromHash,
  type Tab,
  type VendorTab,
} from './tabs';

function Screen({ tab }: { readonly tab: Tab }) {
  switch (tab) {
    case 'dashboard':
      return <DashboardScreen />;
    case 'dlq':
      return <DeadLetterScreen />;
    case 'vendors':
      return <VendorScreen />;
    case 'compliance':
      return <ComplianceScreen />;
    case 'categories':
      return <CategoryScreen />;
    case 'products':
      return <ProductScreen />;
    case 'campaigns':
      return <CampaignScreen />;
    case 'payouts':
      return <PayoutScreen />;
    case 'pricing-plans':
      return <PricingPlanScreen />;
    case 'settlements':
      return <SettlementScreen />;
    case 'ad-products':
      return <AdProductScreen />;
    case 'logistics':
      return <LogisticsScreen />;
    case 'approvals':
      return <ApprovalScreen />;
    case 'promotions':
      return <PromotionScreen />;
    case 'notifications':
      return <NotificationScreen />;
    case 'exports':
      return <ExportScreen />;
    case 'onboarding':
      return <OnboardingScreen />;
    case 'tutorials':
      return <TutorialScreen />;
    case 'audit-log':
      return <AuditLogScreen />;
    case 'disputes':
      return <DisputeScreen />;
    case 'auth-logs':
      return <AuthLogScreen />;
  }
}

/** The current tab, kept in the URL hash so a tab can be bookmarked and Back works. */
function useHashTab<T extends string>(fromHash: (hash: string) => T): [T, (tab: T) => void] {
  const [tab, setTab] = useState<T>(() => fromHash(window.location.hash));
  useEffect(() => {
    const onChange = () => {
      setTab(fromHash(window.location.hash));
    };
    window.addEventListener('hashchange', onChange);
    return () => {
      window.removeEventListener('hashchange', onChange);
    };
  }, [fromHash]);
  return [
    tab,
    (next) => {
      window.location.hash = `#/${next}`;
    },
  ];
}

/**
 * The silent refresh on page load: asks the API for an access token with the HttpOnly refresh
 * cookie the browser may still hold. False until it has answered (signed in, refused, or the API
 * could not be reached; the last two both lead to the sign-in screen).
 */
function useSessionRestore(): boolean {
  const api = useAdminApi();
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    let active = true;
    api
      .restoreSession()
      .catch(() => false)
      .finally(() => {
        if (active) setSettled(true);
      });
    return () => {
      active = false;
    };
  }, [api]);
  return settled;
}

export function App() {
  const api = useAdminApi();
  const session = useSession();
  const sessionStore = useSessionStore();
  const restored = useSessionRestore();
  const [tab, setTab] = useHashTab<Tab>(tabFromHash);
  const [vendorTab, setVendorTab] = useHashTab<VendorTab>(vendorTabFromHash);

  // Phase 19: a vendor gets the Vendor Portal instead of the dashboard's tabs.
  const vendor = session !== null && portalOf(session.user) === 'VENDOR';

  // The access token is forgotten only once the server has cleared the refresh cookie: otherwise
  // the next page load would sign the admin straight back in. A vendor has no cookie (their tokens
  // live in memory only), so there is nothing to clear on the server.
  const signOut = useMutation({
    mutationFn: () => (vendor ? Promise.resolve() : api.logout()),
    onSuccess: () => {
      sessionStore.getState().clear();
    },
  });

  if (session === null) {
    if (restored) return <LoginScreen />;
    return (
      <main className="login">
        <p className="muted" role="status">
          Restoring your session…
        </p>
      </main>
    );
  }

  return (
    <div className="shell">
      <aside className="sidebar" aria-label="Sections">
        <div className="brand">
          <img className="brand-logo" src={brandLogo} alt="" width={44} height={44} />
          <div>
            <div className="brand-name">Hamro Pasal</div>
            <div className="brand-sub">{vendor ? 'Vendor Portal' : 'Super Admin'}</div>
          </div>
        </div>
        <nav className="side-nav">
          {vendor ? (
            <div className="side-group">
              {VENDOR_TABS.map(({ id, label }) => (
                <button
                  key={id}
                  type="button"
                  className="tab"
                  aria-current={vendorTab === id ? 'page' : undefined}
                  onClick={() => {
                    setVendorTab(id);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : (
            TAB_GROUPS.map((group) => (
              <div className="side-group" key={group.name}>
                <div className="side-group-name">{group.name}</div>
                {group.tabs.map(({ id, label, icon }) => (
                  <button
                    key={id}
                    type="button"
                    className="tab"
                    aria-current={tab === id ? 'page' : undefined}
                    onClick={() => {
                      setTab(id);
                    }}
                  >
                    <span className="tab-icon" aria-hidden="true">
                      {icon}
                    </span>
                    {label}
                  </button>
                ))}
              </div>
            ))
          )}
        </nav>
        <div className="account">
          {signOut.isError && (
            <span className="error small" role="alert">
              Couldn&apos;t sign out. Try again.
            </span>
          )}
          <span className="muted">{session.phone}</span>
          <button
            type="button"
            className="button ghost"
            disabled={signOut.isPending}
            onClick={() => {
              signOut.mutate();
            }}
          >
            {signOut.isPending ? 'Signing out…' : 'Sign out'}
          </button>
          <span className="made-in-nepal">Made in Nepal</span>
        </div>
      </aside>
      <main className="content">
        {!vendor ? (
          <Screen tab={tab} />
        ) : vendorTab === 'earnings' ? (
          <VendorEarningsScreen />
        ) : (
          <VendorProductScreen />
        )}
      </main>
    </div>
  );
}
