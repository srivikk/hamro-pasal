import type { Executor } from '@hamro-pasal/db';
import type { ExportKind, ExportParams } from '@hamro-pasal/shared-types';
import { Zip, ZipDeflate } from 'fflate';

import { CSV_BOM, csvRow } from './csv';
import { exportHeader, exportRows, type ExportScope } from './datasets';

/** Rows joined into one chunk before it is written out. */
const ROWS_PER_CHUNK = 500;

/** `hamro-pasal-orders-2026-10-01-to-2026-10-16.csv` */
export function exportFileName(kind: ExportKind, params: ExportParams, extension: 'csv' | 'zip') {
  return `hamro-pasal-${kind.toLowerCase().replace(/_/g, '-')}-${params.from}-to-${params.to}.${extension}`;
}

/** Some CSV text and how many rows it holds (a quoted cell may hold a line break). */
export interface CsvChunk {
  readonly text: string;
  readonly rows: number;
}

/**
 * The CSV of an export as text chunks: the BOM and the header, then the rows a few hundred at a
 * time.
 */
export async function* exportCsvChunks(
  db: Executor,
  kind: ExportKind,
  params: ExportParams,
  scope: ExportScope,
  options: { readonly maxRows?: number; readonly pageSize?: number } = {},
): AsyncGenerator<CsvChunk> {
  yield { text: CSV_BOM + csvRow(exportHeader(kind, params, scope)), rows: 0 };
  let chunk = '';
  let inChunk = 0;
  for await (const cells of exportRows(db, kind, params, scope, options)) {
    chunk += csvRow(cells);
    inChunk += 1;
    if (inChunk >= ROWS_PER_CHUNK) {
      yield { text: chunk, rows: inChunk };
      chunk = '';
      inChunk = 0;
    }
  }
  if (chunk !== '') yield { text: chunk, rows: inChunk };
}

export interface BuiltExport {
  /** The zip holding one CSV file. */
  readonly zip: Buffer;
  readonly rowCount: number;
  readonly fileName: string;
}

/**
 * A queued export: the CSV streamed straight into a zip (deflate), so only the compressed bytes
 * are held, never the rows or the whole CSV.
 */
export async function buildExportZip(
  db: Executor,
  kind: ExportKind,
  params: ExportParams,
  scope: ExportScope,
  options: { readonly pageSize?: number } = {},
): Promise<BuiltExport> {
  const parts: Uint8Array[] = [];
  // Written from fflate's callback, so read through an object (not narrowed away by TypeScript).
  const state: { failure: Error | null; done: boolean } = { failure: null, done: false };
  const zip = new Zip((error, data, final) => {
    if (error !== null) {
      state.failure = error;
      return;
    }
    parts.push(data);
    if (final) state.done = true;
  });
  const file = new ZipDeflate(exportFileName(kind, params, 'csv'), { level: 6 });
  zip.add(file);

  const encoder = new TextEncoder();
  let rowCount = 0;
  for await (const chunk of exportCsvChunks(db, kind, params, scope, options)) {
    rowCount += chunk.rows;
    file.push(encoder.encode(chunk.text));
    if (state.failure !== null) throw state.failure;
  }
  file.push(new Uint8Array(0), true);
  zip.end();
  if (state.failure !== null) throw state.failure;
  if (!state.done) throw new Error('The export zip was not finished');
  return {
    zip: Buffer.concat(parts),
    rowCount,
    fileName: exportFileName(kind, params, 'zip'),
  };
}
