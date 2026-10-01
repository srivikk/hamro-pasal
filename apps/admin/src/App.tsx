import { useEffect, useState } from 'react';

import { useSession, useSessionStore } from './app-context';
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

export function App() {
  const session = useSession();
  const sessionStore = useSessionStore();
  const [tab, setTab] = useHashTab();

  if (session === null) return <LoginScreen />;

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
          <span className="muted">{session.phone}</span>
          <button
            type="button"
            className="button ghost"
            onClick={() => {
              sessionStore.getState().clear();
            }}
          >
            Sign out
          </button>
        </div>
      </header>
      <main className="content">{tab === 'dlq' ? <DeadLetterScreen /> : <VendorScreen />}</main>
    </div>
  );
}
