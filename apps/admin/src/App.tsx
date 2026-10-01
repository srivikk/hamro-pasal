import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { useAdminApi, useSession, useSessionStore } from './app-context';
import { LoginScreen } from './features/auth/LoginScreen';
import { DeadLetterScreen } from './features/dlq/DeadLetterScreen';
import { VendorScreen } from './features/vendors/VendorScreen';

type Tab = 'dlq' | 'vendors';

function tabFromHash(hash: string): Tab {
  return hash === '#/vendors' ? 'vendors' : 'dlq';
}

/** The current tab, kept in the URL hash so a tab can be bookmarked and Back works. */
function useHashTab(): [Tab, (tab: Tab) => void] {
  const [tab, setTab] = useState<Tab>(() => tabFromHash(window.location.hash));
  useEffect(() => {
    const onChange = () => {
      setTab(tabFromHash(window.location.hash));
    };
    window.addEventListener('hashchange', onChange);
    return () => {
      window.removeEventListener('hashchange', onChange);
    };
  }, []);
  return [
    tab,
    (next) => {
      window.location.hash = next === 'vendors' ? '#/vendors' : '#/dlq';
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
  const [tab, setTab] = useHashTab();

  // The access token is forgotten only once the server has cleared the refresh cookie: otherwise
  // the next page load would sign the admin straight back in.
  const signOut = useMutation({
    mutationFn: () => api.logout(),
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
          Hamro Pasal <span className="brand-sub">Super Admin</span>
        </div>
        <nav className="tabs" aria-label="Sections">
          <button
            type="button"
            className="tab"
            aria-current={tab === 'dlq' ? 'page' : undefined}
            onClick={() => {
              setTab('dlq');
            }}
          >
            Dead letters
          </button>
          <button
            type="button"
            className="tab"
            aria-current={tab === 'vendors' ? 'page' : undefined}
            onClick={() => {
              setTab('vendors');
            }}
          >
            Vendors
          </button>
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
      <main className="content">{tab === 'dlq' ? <DeadLetterScreen /> : <VendorScreen />}</main>
    </div>
  );
}
