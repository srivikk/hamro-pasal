import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type SyntheticEvent } from 'react';

import { ApiError } from '../../api/client';
import { useAdminApi } from '../../app-context';
import { formatDateTime } from '../../lib/format';
import {
  EMERGENCY_STOP_WARNING,
  feeChangeNote,
  freeDeliveryChangeNote,
  formFromLogistics,
  isEmergencyStop,
  logisticsChanged,
  logisticsErrorMessage,
  modeDisableWarning,
  validateLogisticsForm,
  type LogisticsFormField,
  type LogisticsFormValues,
  type LogisticsSettingsView,
  type LogisticsSettingsWrite,
} from './logistics-rules';

const LOGISTICS_KEY = ['admin', 'logistics'] as const;

/**
 * Platform logistics (SPEC Super Admin flow step 4, Dual-Fulfillment "Delivery Modularity"): which
 * delivery modes vendors may use, and the platform's own delivery charge. Reads and writes
 * /api/admin/settings/logistics; the server audits every change.
 */
export function LogisticsScreen() {
  const api = useAdminApi();
  const query = useQuery({ queryKey: LOGISTICS_KEY, queryFn: () => api.getLogisticsSettings() });

  if (query.isPending) return <p className="muted">Loading…</p>;
  if (query.isError) {
    return (
      <p className="error" role="alert">
        {query.error instanceof ApiError && query.error.code === 'NETWORK_ERROR'
          ? 'The API cannot be reached.'
          : 'The logistics settings could not be loaded.'}{' '}
        <button type="button" className="link" onClick={() => void query.refetch()}>
          Try again
        </button>
      </p>
    );
  }
  return <LogisticsPanel settings={query.data} />;
}

function LogisticsPanel({ settings }: { readonly settings: LogisticsSettingsView }) {
  const api = useAdminApi();
  const queryClient = useQueryClient();
  const formId = useId();
  const [values, setValues] = useState<LogisticsFormValues>(() => formFromLogistics(settings));
  const [fieldErrors, setFieldErrors] = useState<
    Readonly<Partial<Record<LogisticsFormField, string>>>
  >({});
  // The mode warning the admin has been shown; saving needs a second press on the same values.
  const [warned, setWarned] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (request: LogisticsSettingsWrite) => api.updateLogisticsSettings(request),
    onSuccess: (stored) => {
      // Show what the server stored at once; the refetch below confirms it and the shop counts.
      queryClient.setQueryData<LogisticsSettingsView>(LOGISTICS_KEY, stored);
      setValues(formFromLogistics(stored));
      setWarned(null);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: LOGISTICS_KEY }),
  });

  const change = (patch: Partial<LogisticsFormValues>) => {
    setValues((current) => ({ ...current, ...patch }));
    setWarned(null);
    save.reset();
  };

  const result = validateLogisticsForm(values);
  const dirty = !result.ok || logisticsChanged(settings, result.request);
  const feeNote = result.ok ? feeChangeNote(settings, result.request) : null;
  const freeNote = result.ok ? freeDeliveryChangeNote(settings, result.request) : null;

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (save.isPending) return;
    if (!result.ok) {
      setFieldErrors(result.errors);
      return;
    }
    setFieldErrors({});
    const warning = modeDisableWarning(settings, result.request);
    if (warning !== null && warned !== warning) {
      setWarned(warning);
      return;
    }
    save.mutate(result.request);
  };

  const errorOf = (name: LogisticsFormField) =>
    fieldErrors[name] === undefined ? null : (
      <span className="error small" role="alert">
        {fieldErrors[name]}
      </span>
    );

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Logistics</h2>
          <p className="muted">
            Platform-wide delivery settings. A vendor can use only a mode that is enabled here; a
            shop whose mode is switched off is not orderable until it picks an enabled one. Last
            changed {formatDateTime(settings.updated_at)} (Nepal Time).
          </p>
        </div>
      </div>

      {isEmergencyStop(settings) && (
        <p className="warning emergency" role="status">
          <strong>Emergency stop is on.</strong> {EMERGENCY_STOP_WARNING}
        </p>
      )}

      <form className="panel" onSubmit={submit} noValidate>
        <fieldset className="setting" disabled={save.isPending}>
          <legend>Delivery modes</legend>

          <label className="check">
            <input
              type="checkbox"
              role="switch"
              checked={values.selfDeliveryEnabled}
              onChange={(event) => {
                change({ selfDeliveryEnabled: event.target.checked });
              }}
            />
            Self delivery
          </label>
          <p className="muted small setting-help">
            The shop’s own staff deliver and the shop sets its own delivery charge.{' '}
            {settings.self_delivery_vendor_count} live shop
            {settings.self_delivery_vendor_count === 1 ? '' : 's'} on it.
          </p>

          <label className="check">
            <input
              type="checkbox"
              role="switch"
              checked={values.platformFleetEnabled}
              onChange={(event) => {
                change({ platformFleetEnabled: event.target.checked });
              }}
            />
            Platform fleet
          </label>
          <p className="muted small setting-help">
            Platform riders deliver (“Platform delivery” in the Vendor App) at the charge below.{' '}
            {settings.platform_fleet_vendor_count} live shop
            {settings.platform_fleet_vendor_count === 1 ? '' : 's'} on it.
          </p>
        </fieldset>

        <div className="setting">
          <label htmlFor={`${formId}-fee`}>Platform delivery charge (NPR)</label>
          <input
            id={`${formId}-fee`}
            className="stock-input"
            inputMode="decimal"
            value={values.platformDeliveryFee}
            aria-invalid={fieldErrors.platformDeliveryFee !== undefined}
            disabled={save.isPending}
            onChange={(event) => {
              change({ platformDeliveryFee: event.target.value });
            }}
          />
          <p className="muted small setting-help">
            What a customer pays for a platform fleet delivery. Vendors cannot edit it; it does not
            apply to self delivery.
          </p>
          {errorOf('platformDeliveryFee')}
          {feeNote !== null && <p className="muted small setting-help">{feeNote}</p>}
        </div>

        <div className="setting">
          <label htmlFor={`${formId}-free-above`}>Free delivery above (NPR)</label>
          <input
            id={`${formId}-free-above`}
            className="stock-input"
            inputMode="decimal"
            placeholder="Off"
            value={values.freeDeliveryAbove}
            aria-invalid={fieldErrors.freeDeliveryAbove !== undefined}
            disabled={save.isPending}
            onChange={(event) => {
              change({ freeDeliveryAbove: event.target.value });
            }}
          />
          <p className="muted small setting-help">
            Orders whose goods reach this amount after discounts ship free at every shop. Hamro
            Pasal pays the fee to whoever delivers. Leave empty to switch it off.
          </p>
          {errorOf('freeDeliveryAbove')}
          {freeNote !== null && <p className="muted small setting-help">{freeNote}</p>}
        </div>

        {warned !== null && (
          <p className="warning" role="alert">
            {warned}
          </p>
        )}

        {save.isError && (
          <p className="error" role="alert">
            {logisticsErrorMessage(save.error)}
          </p>
        )}

        <div className="panel-actions">
          {save.isSuccess && !dirty && (
            <span className="muted small" role="status">
              Saved.
            </span>
          )}
          <button
            type="button"
            className="button ghost"
            disabled={!dirty || save.isPending}
            onClick={() => {
              setValues(formFromLogistics(settings));
              setFieldErrors({});
              setWarned(null);
              save.reset();
            }}
          >
            Discard changes
          </button>
          <button
            type="submit"
            className={`button ${warned === null ? 'primary' : 'danger'}`}
            disabled={!dirty || save.isPending}
          >
            {save.isPending ? 'Saving…' : warned === null ? 'Save settings' : 'Confirm and save'}
          </button>
        </div>
      </form>
    </section>
  );
}
