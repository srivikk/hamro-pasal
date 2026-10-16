import { adminExportKinds } from '@hamro-pasal/shared-types';
import { useMutation } from '@tanstack/react-query';
import { useId, useState } from 'react';

import { useAdminApi } from '../../app-context';
import {
  EXPORT_KIND_LABELS,
  exportErrorMessage,
  KINDS_WITH_VENDOR_FILTER,
  queuedText,
  validateExportDraft,
  type AdminExportKind,
} from './export-rules';

/** Today in Nepal Time, `YYYY-MM-DD`. */
function nepalToday(): string {
  return new Date(Date.now() + (5 * 60 + 45) * 60_000).toISOString().slice(0, 10);
}

/** Saves a Blob as a file through a temporary link (the browser's own download). */
function save(file: Blob, name: string): void {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Data exports (step 7.6, SPEC core 11): vendors, customers, orders, payouts or the audit log for
 * a date range (Nepal Time) as CSV. Up to 5 000 rows download at once; a larger export is built in
 * the background and emailed (attached if under 7 MB, else a 7-day link). Every export is audited.
 */
export function ExportScreen() {
  const api = useAdminApi();
  const ids = { kind: useId(), from: useId(), to: useId(), vendor: useId() };
  const [kind, setKind] = useState<AdminExportKind>('ORDERS');
  const [from, setFrom] = useState(nepalToday);
  const [to, setTo] = useState(nepalToday);
  const [vendorId, setVendorId] = useState('');
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  const request = useMutation({
    mutationFn: (input: Parameters<typeof api.requestExport>[0]) => api.requestExport(input),
    onSuccess: (answer) => {
      if (answer.kind === 'FILE') {
        save(answer.file, answer.fileName);
        setMessage({ tone: 'success', text: `Downloaded ${answer.fileName}.` });
      } else {
        setMessage({ tone: 'success', text: queuedText(answer.job) });
      }
    },
    onError: (error) => {
      setMessage({ tone: 'error', text: exportErrorMessage(error) });
    },
  });

  const onExport = () => {
    if (request.isPending) return;
    const result = validateExportDraft({ kind, from, to, vendorId });
    if (!result.ok) {
      setMessage({ tone: 'error', text: result.error });
      return;
    }
    setMessage(null);
    request.mutate(result.request);
  };

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Exports</h2>
          <p className="muted">
            CSV for a date range in Nepal Time. Up to 5 000 rows download now; larger exports are
            emailed to you. Text that a spreadsheet would run as a formula is written as plain text.
            Every export is audited.
          </p>
        </div>
      </div>
      <fieldset className="card" disabled={request.isPending}>
        <label htmlFor={ids.kind}>What</label>
        <select
          id={ids.kind}
          value={kind}
          onChange={(event) => {
            setKind(event.target.value as AdminExportKind);
          }}
        >
          {adminExportKinds.map((option) => (
            <option key={option} value={option}>
              {EXPORT_KIND_LABELS[option]}
            </option>
          ))}
        </select>
        <label htmlFor={ids.from}>From</label>
        <input
          id={ids.from}
          type="date"
          value={from}
          onChange={(event) => {
            setFrom(event.target.value);
          }}
        />
        <label htmlFor={ids.to}>To</label>
        <input
          id={ids.to}
          type="date"
          value={to}
          onChange={(event) => {
            setTo(event.target.value);
          }}
        />
        {KINDS_WITH_VENDOR_FILTER.has(kind) ? (
          <>
            <label htmlFor={ids.vendor}>One shop only (vendor id, optional)</label>
            <input
              id={ids.vendor}
              value={vendorId}
              onChange={(event) => {
                setVendorId(event.target.value);
              }}
            />
          </>
        ) : null}
        {message === null ? null : (
          <p className={message.tone} role={message.tone === 'error' ? 'alert' : undefined}>
            {message.text}
          </p>
        )}
        <button type="button" className="button primary" onClick={onExport}>
          {request.isPending ? 'Exporting…' : 'Export CSV'}
        </button>
      </fieldset>
    </section>
  );
}
