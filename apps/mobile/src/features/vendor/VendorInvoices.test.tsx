import { vendorInvoiceSummarySchema, type VendorInvoiceSummary } from '@hamro-pasal/shared-types';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { delay, http, HttpResponse } from 'msw';

import VendorInvoicesScreen from '../../../app/(vendor)/invoices';
import { INVOICE_COPY_NUMBER_HEADER, VENDOR_INVOICES_PATH } from '../../api/vendor-invoices';
import { useAuthStore } from '../../store/useAuthStore';
import { useToastStore } from '../../store/useToastStore';
import { errorBody } from '../../test/api-fixtures';
import { mockFiles } from '../../test/fake-files';
import {
  apiUrl,
  capture,
  server,
  setupApiTestEnvironment,
  TEST_ACCESS_TOKEN,
  type CapturedRequest,
} from '../../test/msw';
import { renderWithProviders } from '../../test/render';
import { invoiceFileName } from './invoice-files';

setupApiTestEnvironment();

/**
 * The vendor's Invoices screen over msw (SPEC core 10, vendor flow step 16): the list from
 * GET /api/vendor/invoices and "Download PDF", which fetches GET …/:id/pdf, saves the bytes with
 * expo-file-system and opens the share sheet with expo-sharing (both replaced by in-memory
 * stand-ins here).
 */

const FIRST = '11111111-1111-4111-8111-111111111111';
const SECOND = '11111111-1111-4111-8111-111111111112';
const THIRD = '11111111-1111-4111-8111-111111111113';
/** "%PDF-1.3" and a little more: what the server's document starts with. */
const PDF_BYTES = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x33, 0x0a, 0x01]);

const invoice = (overrides: Partial<VendorInvoiceSummary> = {}): VendorInvoiceSummary =>
  vendorInvoiceSummarySchema.parse({
    id: FIRST,
    document_type: 'INVOICE',
    order_id: '22222222-2222-4222-8222-2222224fa5b6',
    fiscal_year: '2082/083',
    bill_number: 142,
    invoice_sequence: 'HP-2082-000142',
    issued_at: '2025-10-08T06:00:00.000Z',
    issued_date_bs: '2082-06-22',
    buyer_name: 'सीता गुरुङ',
    payment_method: 'COD',
    grand_total_npr: 860,
    print_count: 0,
    ...overrides,
  });

const toast = () => useToastStore.getState().toast;

/** The list endpoint with one page; the PDF endpoint numbering each print like the server. */
function invoicesApi(invoices: VendorInvoiceSummary[]) {
  const state = { prints: 0, pdfRequests: [] as CapturedRequest[] };
  server.use(
    http.get(apiUrl(VENDOR_INVOICES_PATH), () =>
      HttpResponse.json({
        invoices: invoices.map((each) =>
          each.id === FIRST ? { ...each, print_count: each.print_count + state.prints } : each,
        ),
        next_cursor: null,
      }),
    ),
    http.get(apiUrl(`${VENDOR_INVOICES_PATH}/:id/pdf`), async ({ request }) => {
      state.pdfRequests.push(await capture(request));
      const copy = state.prints;
      state.prints += 1;
      return new HttpResponse(PDF_BYTES, {
        headers: {
          'Content-Type': 'application/pdf',
          [INVOICE_COPY_NUMBER_HEADER]: String(copy),
        },
      });
    }),
  );
  return state;
}

beforeEach(() => {
  mockFiles.reset();
  useToastStore.setState({ toast: null });
});

describe('invoiceFileName', () => {
  it('names the original after the invoice and each copy after its number', () => {
    expect(invoiceFileName('HP-2082-000142', 0)).toBe('HP-2082-000142.pdf');
    expect(invoiceFileName('HP-2082-000142', 2)).toBe('HP-2082-000142-copy-2.pdf');
  });

  it('never lets an unexpected sequence reach a path', () => {
    expect(invoiceFileName('../../etc/passwd', 0)).toBe('______etc_passwd.pdf');
  });
});

describe('Vendor invoices: the list (GET /api/vendor/invoices)', () => {
  it('lists each invoice with its number, bill, order, BS date, buyer, total and print state', async () => {
    invoicesApi([
      invoice(),
      invoice({ id: SECOND, invoice_sequence: 'HP-2082-000141', bill_number: 141, print_count: 2 }),
    ]);
    renderWithProviders(<VendorInvoicesScreen />);

    const row = within(await screen.findByTestId(`invoice-row-${FIRST}`));
    expect(row.getByText('HP-2082-000142')).toBeOnTheScreen();
    expect(row.getByText('Rs. 860')).toBeOnTheScreen();
    expect(row.getByText('Bill 000142 · FY 2082/083')).toBeOnTheScreen();
    // A Nepali buyer name is shown as stored.
    expect(row.getByText('Order #4FA5B6 · 2082-06-22 BS · सीता गुरुङ')).toBeOnTheScreen();
    expect(screen.getByTestId(`invoice-prints-${FIRST}`)).toHaveTextContent(
      'Not printed yet: the next download is the original.',
    );
    expect(screen.getByTestId(`invoice-prints-${SECOND}`)).toHaveTextContent(
      'Printed 2 time(s): the next download is a copy.',
    );
    // Every download is a numbered print: the screen says so before any is made.
    expect(screen.getByTestId('invoice-print-note')).toBeOnTheScreen();
  });

  it('shows the empty state for a shop without invoices', async () => {
    invoicesApi([]);
    renderWithProviders(<VendorInvoicesScreen />);

    expect(await screen.findByTestId('invoice-list-empty')).toBeOnTheScreen();
    expect(screen.queryByTestId('invoice-print-note')).toBeNull();
  });

  it('loads the next page with the cursor when the list is scrolled to its end', async () => {
    const cursors: (string | null)[] = [];
    server.use(
      http.get(apiUrl(VENDOR_INVOICES_PATH), ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        cursors.push(cursor);
        return HttpResponse.json(
          cursor === null
            ? {
                invoices: [invoice(), invoice({ id: SECOND, bill_number: 141 })],
                next_cursor: SECOND,
              }
            : { invoices: [invoice({ id: THIRD, bill_number: 140 })], next_cursor: null },
        );
      }),
    );
    renderWithProviders(<VendorInvoicesScreen />);
    await screen.findByTestId(`invoice-row-${SECOND}`);

    act(() => {
      (screen.getByTestId('invoice-list').props as { onEndReached: () => void }).onEndReached();
    });

    expect(await screen.findByTestId(`invoice-row-${THIRD}`)).toBeOnTheScreen();
    expect(cursors).toEqual([null, SECOND]);
  });

  it('keeps the invoices already listed when a later page fails, and retries it from below', async () => {
    let failNext = true;
    server.use(
      http.get(apiUrl(VENDOR_INVOICES_PATH), ({ request }) => {
        if (new URL(request.url).searchParams.get('cursor') === null) {
          return HttpResponse.json({ invoices: [invoice()], next_cursor: FIRST });
        }
        return failNext
          ? HttpResponse.json(errorBody('INVALID_CURSOR'), { status: 400 })
          : HttpResponse.json({ invoices: [invoice({ id: SECOND })], next_cursor: null });
      }),
    );
    renderWithProviders(<VendorInvoicesScreen />);
    await screen.findByTestId(`invoice-row-${FIRST}`);
    act(() => {
      (screen.getByTestId('invoice-list').props as { onEndReached: () => void }).onEndReached();
    });

    const retry = await screen.findByTestId('invoices-load-more');
    expect(screen.getByTestId(`invoice-row-${FIRST}`)).toBeOnTheScreen();
    failNext = false;
    fireEvent.press(retry);
    expect(await screen.findByTestId(`invoice-row-${SECOND}`)).toBeOnTheScreen();
  });

  it('offers a retry when the list cannot be loaded', async () => {
    let fail = true;
    server.use(
      http.get(apiUrl(VENDOR_INVOICES_PATH), () =>
        fail
          ? HttpResponse.json(errorBody('VENDOR_NOT_FOUND'), { status: 404 })
          : HttpResponse.json({ invoices: [invoice()], next_cursor: null }),
      ),
    );
    renderWithProviders(<VendorInvoicesScreen />);

    await screen.findByTestId('invoices-error');
    fail = false;
    fireEvent.press(screen.getByText('Try again'));
    expect(await screen.findByTestId(`invoice-row-${FIRST}`)).toBeOnTheScreen();
  });
});

describe('Vendor invoices: Download PDF (GET /api/vendor/invoices/:id/pdf)', () => {
  it('fetches the server’s PDF with the session, saves its bytes and opens the share sheet', async () => {
    const api = invoicesApi([invoice()]);
    renderWithProviders(<VendorInvoicesScreen />);
    fireEvent.press(await screen.findByTestId(`download-invoice-${FIRST}`));

    await waitFor(() => {
      expect(mockFiles.shared).toHaveLength(1);
    });
    expect(api.pdfRequests).toHaveLength(1);
    expect(api.pdfRequests[0]?.url.pathname).toBe(`${VENDOR_INVOICES_PATH}/${FIRST}/pdf`);
    expect(api.pdfRequests[0]?.headers.get('authorization')).toBe(`Bearer ${TEST_ACCESS_TOKEN}`);
    expect(api.pdfRequests[0]?.headers.get('accept')).toContain('application/pdf');

    // The file is the document byte for byte, in the app's cache, named after the invoice.
    const uri = 'file:///cache/HP-2082-000142.pdf';
    expect([...(mockFiles.written.get(uri) ?? [])]).toEqual([...PDF_BYTES]);
    expect(mockFiles.shared[0]).toEqual({
      uri,
      options: { mimeType: 'application/pdf', UTI: 'com.adobe.pdf', dialogTitle: 'HP-2082-000142' },
    });
    await waitFor(() => {
      expect(toast()?.message).toBe('Invoice HP-2082-000142 saved (original).');
    });
  });

  it('saves a second download as copy 1 under its own name, and shows the new print count', async () => {
    invoicesApi([invoice()]);
    renderWithProviders(<VendorInvoicesScreen />);
    fireEvent.press(await screen.findByTestId(`download-invoice-${FIRST}`));
    await waitFor(() => {
      expect(screen.getByTestId(`invoice-prints-${FIRST}`)).toHaveTextContent(/Printed 1 time/);
    });

    fireEvent.press(screen.getByTestId(`download-invoice-${FIRST}`));

    await waitFor(() => {
      expect(mockFiles.shared).toHaveLength(2);
    });
    expect([...mockFiles.written.keys()]).toEqual([
      'file:///cache/HP-2082-000142.pdf',
      'file:///cache/HP-2082-000142-copy-1.pdf',
    ]);
    await waitFor(() => {
      expect(toast()?.message).toBe('Invoice HP-2082-000142 saved (copy 1).');
    });
    await waitFor(() => {
      expect(screen.getByTestId(`invoice-prints-${FIRST}`)).toHaveTextContent(/Printed 2 time/);
    });
  });

  it('downloads one invoice at a time: every button waits while a print is being made', async () => {
    const api = invoicesApi([
      invoice(),
      invoice({ id: SECOND, invoice_sequence: 'HP-2082-000141' }),
    ]);
    server.use(
      http.get(apiUrl(`${VENDOR_INVOICES_PATH}/:id/pdf`), async ({ request }) => {
        api.pdfRequests.push(await capture(request));
        await delay(150);
        return new HttpResponse(PDF_BYTES, {
          headers: { 'Content-Type': 'application/pdf', [INVOICE_COPY_NUMBER_HEADER]: '0' },
        });
      }),
    );
    renderWithProviders(<VendorInvoicesScreen />);
    const first = await screen.findByTestId(`download-invoice-${FIRST}`);

    fireEvent.press(first);
    expect(first).toHaveTextContent('Downloading…');
    expect(first).toBeDisabled();
    expect(screen.getByTestId(`download-invoice-${SECOND}`)).toBeDisabled();
    // A second tap makes no second print.
    fireEvent.press(first);

    await waitFor(() => {
      expect(first).toHaveTextContent('Download PDF');
    });
    expect(api.pdfRequests).toHaveLength(1);
  });

  it('saves the file without opening anything on a device with no share sheet', async () => {
    invoicesApi([invoice()]);
    mockFiles.sharingAvailable = false;
    renderWithProviders(<VendorInvoicesScreen />);
    fireEvent.press(await screen.findByTestId(`download-invoice-${FIRST}`));

    await waitFor(() => {
      expect(mockFiles.written.size).toBe(1);
    });
    expect(mockFiles.shared).toHaveLength(0);
  });

  it.each([
    [
      'INVOICE_PRINT_UNAVAILABLE',
      503,
      "Invoices can't be printed right now. Please try again later.",
    ],
    ['INVOICE_NOT_FOUND', 404, 'This invoice is no longer available.'],
    [
      'INTERNAL_SERVER_ERROR',
      500,
      "Couldn't download the invoice. Check your connection and try again.",
    ],
  ])('explains %s, saves nothing and never retries by itself', async (code, status, message) => {
    let requests = 0;
    invoicesApi([invoice()]);
    server.use(
      http.get(apiUrl(`${VENDOR_INVOICES_PATH}/:id/pdf`), () => {
        requests += 1;
        return HttpResponse.json(errorBody(code), { status });
      }),
    );
    renderWithProviders(<VendorInvoicesScreen />);
    fireEvent.press(await screen.findByTestId(`download-invoice-${FIRST}`));

    await waitFor(() => {
      expect(toast()?.message).toBe(message);
    });
    // A retried print would be a second numbered copy.
    expect(requests).toBe(1);
    expect(mockFiles.written.size).toBe(0);
    expect(mockFiles.shared).toHaveLength(0);
  });

  it('refuses an answer that is not a PDF', async () => {
    invoicesApi([invoice()]);
    server.use(
      http.get(apiUrl(`${VENDOR_INVOICES_PATH}/:id/pdf`), () =>
        HttpResponse.text('<html>gateway timeout</html>', {
          headers: { [INVOICE_COPY_NUMBER_HEADER]: '0' },
        }),
      ),
    );
    renderWithProviders(<VendorInvoicesScreen />);
    fireEvent.press(await screen.findByTestId(`download-invoice-${FIRST}`));

    await waitFor(() => {
      expect(toast()?.tone).toBe('error');
    });
    expect(mockFiles.written.size).toBe(0);
  });

  it('renews an expired session once, then downloads: the refused request printed nothing', async () => {
    const api = invoicesApi([invoice()]);
    let attempts = 0;
    server.use(
      http.get(apiUrl(`${VENDOR_INVOICES_PATH}/:id/pdf`), async ({ request }) => {
        attempts += 1;
        if (attempts === 1) {
          return HttpResponse.json(errorBody('UNAUTHENTICATED'), { status: 401 });
        }
        api.pdfRequests.push(await capture(request));
        return new HttpResponse(PDF_BYTES, {
          headers: { 'Content-Type': 'application/pdf', [INVOICE_COPY_NUMBER_HEADER]: '0' },
        });
      }),
      http.post(apiUrl('/api/auth/token/refresh'), () =>
        HttpResponse.json({
          token_type: 'Bearer',
          access_token: 'new.access.token',
          access_token_expires_in: 900,
        }),
      ),
    );
    useAuthStore.getState().setSession({ accessToken: TEST_ACCESS_TOKEN, refreshToken: 'r.e.f' });
    renderWithProviders(<VendorInvoicesScreen />);
    fireEvent.press(await screen.findByTestId(`download-invoice-${FIRST}`));

    await waitFor(() => {
      expect(mockFiles.shared).toHaveLength(1);
    });
    expect(attempts).toBe(2);
    expect(api.pdfRequests[0]?.headers.get('authorization')).toBe('Bearer new.access.token');
  });
});
