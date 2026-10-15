import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { http, HttpResponse } from 'msw';

import { useToastStore } from '../../store/useToastStore';
import { useVendorShopStore } from '../../store/useVendorShopStore';
import { apiUrl, server, setupApiTestEnvironment } from '../../test/msw';
import { renderWithProviders } from '../../test/render';
import { VendorOnlineToggle } from './VendorOnlineToggle';

setupApiTestEnvironment();

beforeEach(() => {
  useVendorShopStore.getState().setOnline(true);
});

describe('the Online / Offline switch (step 7.3: server-driven)', () => {
  it('shows the shop as Online and turns it Offline and back through the server', async () => {
    renderWithProviders(<VendorOnlineToggle />);

    await waitFor(() => {
      expect(screen.getByTestId('vendor-online-label')).toHaveTextContent('Online');
    });

    fireEvent(screen.getByTestId('vendor-online-toggle'), 'valueChange', false);
    await waitFor(() => {
      expect(screen.getByTestId('vendor-online-label')).toHaveTextContent('Offline');
    });
    expect(useVendorShopStore.getState().online).toBe(false);

    fireEvent(screen.getByTestId('vendor-online-toggle'), 'valueChange', true);
    await waitFor(() => {
      expect(screen.getByTestId('vendor-online-label')).toHaveTextContent('Online');
    });
    expect(useVendorShopStore.getState().online).toBe(true);
  });

  it('says Paused when the server auto-paused the shop', async () => {
    server.use(
      http.get(apiUrl('/api/vendor/availability'), () =>
        HttpResponse.json({
          vendor_id: '7b1f0c8e-0000-4000-8000-0000000000aa',
          mode: 'AUTO',
          override_until: null,
          has_hours: false,
          auto_paused_at: '2026-10-15T08:00:00.000Z',
          consecutive_missed_orders: 3,
          open_now: false,
          closed_reason: 'AUTO_PAUSED',
        }),
      ),
    );
    renderWithProviders(<VendorOnlineToggle />);

    await waitFor(() => {
      expect(screen.getByTestId('vendor-online-label')).toHaveTextContent('Paused');
    });
    expect(useVendorShopStore.getState().online).toBe(false);
  });

  it('keeps the switch and shows an error toast when the server refuses', async () => {
    server.use(
      http.put(apiUrl('/api/vendor/availability'), () =>
        HttpResponse.json({ error: { code: 'INTERNAL', message: 'boom' } }, { status: 500 }),
      ),
    );
    renderWithProviders(<VendorOnlineToggle />);
    await waitFor(() => {
      expect(screen.getByTestId('vendor-online-label')).toHaveTextContent('Online');
    });

    fireEvent(screen.getByTestId('vendor-online-toggle'), 'valueChange', false);

    await waitFor(() => {
      expect(useToastStore.getState().toast?.message).toBe(
        "Couldn't change your shop. Check your connection and try again.",
      );
    });
    expect(screen.getByTestId('vendor-online-label')).toHaveTextContent('Online');
  });
});
