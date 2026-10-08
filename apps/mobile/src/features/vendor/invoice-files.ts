import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { printVendorInvoicePdf } from '../../api/vendor-invoices';

export interface SavedInvoicePdf {
  readonly uri: string;
  readonly copyNumber: number;
  /** False when the device has no share sheet: the file is saved, nothing was opened. */
  readonly shared: boolean;
}

/** "HP-2082-000142.pdf" for the original, "HP-2082-000142-copy-2.pdf" for copy 2. */
export function invoiceFileName(invoiceSequence: string, copyNumber: number): string {
  // The sequence is the server's ("HP-2082-000142"); anything unexpected never reaches a path.
  const safe = invoiceSequence.replace(/[^A-Za-z0-9-]/g, '_');
  return copyNumber === 0 ? `${safe}.pdf` : `${safe}-copy-${String(copyNumber)}.pdf`;
}

/**
 * Downloads one print of an invoice, saves it in the app's cache and opens the system share sheet
 * (view, print, save to Files, send). The server numbers the print; the file name carries the
 * same number, so two downloads of one invoice never overwrite each other.
 */
export async function downloadInvoicePdf(
  invoiceId: string,
  invoiceSequence: string,
): Promise<SavedInvoicePdf> {
  const { bytes, copyNumber } = await printVendorInvoicePdf(invoiceId);
  const file = new File(Paths.cache, invoiceFileName(invoiceSequence, copyNumber));
  file.create({ overwrite: true });
  file.write(bytes);

  const shared = await Sharing.isAvailableAsync();
  if (shared) {
    await Sharing.shareAsync(file.uri, {
      mimeType: 'application/pdf',
      UTI: 'com.adobe.pdf',
      dialogTitle: invoiceSequence,
    });
  }
  return { uri: file.uri, copyNumber, shared };
}
