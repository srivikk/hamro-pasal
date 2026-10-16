import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';

import { useAdminApi } from '../../app-context';
import { formatDateTime } from '../../lib/format';
import {
  onboardingErrorMessage,
  sandboxedShops,
  validateShopDraft,
  type ShopDraft,
} from './onboarding-rules';

const VENDORS_KEY = ['admin', 'vendors'] as const;

const EMPTY: ShopDraft = {
  phone: '',
  businessName: '',
  palika: '',
  lat: '',
  lng: '',
  fulfillment: 'SELF_DELIVERY',
  approveNow: false,
};

/**
 * Onboarding (step 7.7, Super Admin flow 10): create a shop and its +977 account (the owner is
 * invited by SMS and signs in to the Seller app with that number), and approve shops that signed
 * themselves up once their KYC documents are in (SANDBOXED -> APPROVED).
 */
export function OnboardingScreen() {
  const api = useAdminApi();
  const queryClient = useQueryClient();
  const ids = {
    phone: useId(),
    name: useId(),
    palika: useId(),
    lat: useId(),
    lng: useId(),
    fulfillment: useId(),
  };
  const [draft, setDraft] = useState<ShopDraft>(EMPTY);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [rowErrors, setRowErrors] = useState<Readonly<Record<string, string>>>({});
  const vendors = useQuery({ queryKey: VENDORS_KEY, queryFn: () => api.listVendors() });

  const create = useMutation({
    mutationFn: (input: Parameters<typeof api.createVendor>[0]) => api.createVendor(input),
    onSuccess: (created) => {
      setDraft(EMPTY);
      setMessage({
        tone: 'success',
        text:
          `Created ${created.vendor_code} (${created.status}).` +
          (created.invite_sent
            ? ' The owner was sent the Seller app link by SMS.'
            : ' The invitation SMS could not be sent.'),
      });
    },
    onError: (error) => {
      setMessage({ tone: 'error', text: onboardingErrorMessage(error) });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: VENDORS_KEY }),
  });

  const approve = useMutation({
    mutationFn: (id: string) => api.approveVendor(id),
    onMutate: (id) => {
      setRowErrors(({ [id]: _cleared, ...rest }) => rest);
    },
    onError: (error, id) => {
      setRowErrors((current) => ({ ...current, [id]: onboardingErrorMessage(error) }));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: VENDORS_KEY }),
  });

  const set = <K extends keyof ShopDraft>(key: K, value: ShopDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const onCreate = () => {
    if (create.isPending) return;
    const result = validateShopDraft(draft);
    if (!result.ok) {
      setMessage({ tone: 'error', text: result.error });
      return;
    }
    setMessage(null);
    create.mutate(result.request);
  };

  const waiting = vendors.data === undefined ? [] : sandboxedShops(vendors.data.vendors);

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Onboarding</h2>
          <p className="muted">
            Create a shop for a seller (its account is the +977 number; an existing customer keeps
            one account with both roles), or approve shops that signed up in the Seller app.
          </p>
        </div>
      </div>

      <fieldset className="card" disabled={create.isPending}>
        <legend>New shop</legend>
        <label htmlFor={ids.phone}>Owner&apos;s mobile number</label>
        <input
          id={ids.phone}
          value={draft.phone}
          placeholder="98XXXXXXXX"
          onChange={(e) => {
            set('phone', e.target.value);
          }}
        />
        <label htmlFor={ids.name}>Shop name</label>
        <input
          id={ids.name}
          value={draft.businessName}
          onChange={(e) => {
            set('businessName', e.target.value);
          }}
        />
        <label htmlFor={ids.palika}>Municipality / Palika</label>
        <input
          id={ids.palika}
          value={draft.palika}
          onChange={(e) => {
            set('palika', e.target.value);
          }}
        />
        <label htmlFor={ids.lat}>Latitude</label>
        <input
          id={ids.lat}
          value={draft.lat}
          placeholder="27.7154"
          onChange={(e) => {
            set('lat', e.target.value);
          }}
        />
        <label htmlFor={ids.lng}>Longitude</label>
        <input
          id={ids.lng}
          value={draft.lng}
          placeholder="85.3123"
          onChange={(e) => {
            set('lng', e.target.value);
          }}
        />
        <label htmlFor={ids.fulfillment}>Who delivers</label>
        <select
          id={ids.fulfillment}
          value={draft.fulfillment}
          onChange={(e) => {
            set('fulfillment', e.target.value as ShopDraft['fulfillment']);
          }}
        >
          <option value="SELF_DELIVERY">The shop</option>
          <option value="PLATFORM_FLEET">Hamro Pasal riders</option>
        </select>
        <label>
          <input
            type="checkbox"
            checked={draft.approveNow}
            onChange={(e) => {
              set('approveNow', e.target.checked);
            }}
          />{' '}
          Approve now (I vetted this shop in person)
        </label>
        {message === null ? null : (
          <p className={message.tone} role={message.tone === 'error' ? 'alert' : undefined}>
            {message.text}
          </p>
        )}
        <button type="button" className="button primary" onClick={onCreate}>
          {create.isPending ? 'Creating…' : 'Create shop'}
        </button>
      </fieldset>

      <h3>Waiting for approval</h3>
      {vendors.isPending ? <p className="muted">Loading…</p> : null}
      {vendors.isError ? (
        <p className="error" role="alert">
          The shops could not be loaded.
        </p>
      ) : null}
      {vendors.data !== undefined && waiting.length === 0 ? (
        <p className="muted">No shop is waiting.</p>
      ) : null}
      {waiting.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Shop</th>
              <th>Phone</th>
              <th>Palika</th>
              <th>Signed up</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {waiting.map((vendor) => (
              <tr key={vendor.id}>
                <td>{vendor.business_name}</td>
                <td>{vendor.phone}</td>
                <td>{vendor.municipality_palika_string}</td>
                <td>{formatDateTime(vendor.created_at)}</td>
                <td>
                  <button
                    type="button"
                    className="button"
                    disabled={approve.isPending}
                    onClick={() => {
                      approve.mutate(vendor.id);
                    }}
                  >
                    Approve
                  </button>
                  {rowErrors[vendor.id] === undefined ? null : (
                    <p className="error" role="alert">
                      {rowErrors[vendor.id]}
                    </p>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
