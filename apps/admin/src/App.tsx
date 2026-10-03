import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { useAdminApi, useSession, useSessionStore } from './app-context';
import { LoginScreen } from './features/auth/LoginScreen';
import { portalOf } from './features/auth/login-rules';
import { CategoryScreen } from './features/categories/CategoryScreen';
import { DeadLetterScreen } from './features/dlq/DeadLetterScreen';
import { PayoutScreen } from './features/finance/PayoutScreen';
import { ProductScreen } from './features/products/ProductScreen';
import { VendorEarningsScreen } from './features/vendor-portal/VendorEarningsScreen';
import { VendorProductScreen } from './features/vendor-portal/VendorProductScreen';
import { VendorScreen } from './features/vendors/VendorScreen';
import {
  TABS,
  tabFromHash,
  VENDOR_TABS,
  vendorTabFromHash,
  type Tab,
  type VendorTab,
} from './tabs';

function Screen({ tab }: { readonly tab: Tab }) {
  switch (tab) {
    case 'dlq':
      return <DeadLetterScreen />;
    case 'vendors':
      return <VendorScreen />;
    case 'categories':
      return <CategoryScreen />;
    case 'products':
      return <ProductScreen />;
    case 'payouts':
      return <PayoutScreen />;
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
      <header className="topbar">
        <div className="brand">
          Hamro Pasal <span className="brand-sub">{vendor ? 'Vendor Portal' : 'Super Admin'}</span>
        </div>
        <nav className="tabs" aria-label="Sections">
          {vendor
            ? VENDOR_TABS.map(({ id, label }) => (
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
              ))
            : TABS.map(({ id, label }) => (
                <button
                  key={id}
                  type="button"
                  className="tab"
                  aria-current={tab === id ? 'page' : undefined}
                  onClick={() => {
                    setTab(id);
                  }}
                >
                  {label}
                </button>
              ))}
        </nav>
        <div className="account">
          {signOut.isError && (
            <span className="error small" role="alert">
              Couldn't sign out. Try again.
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
        </div>
      </header>
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
