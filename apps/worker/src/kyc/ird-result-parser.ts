import { IrdTransientError, type IrdLookupResult } from './ird-lookup';

/*
 * Reads the IRD PAN search's answer from the page as the page renders it (2026-10-21). The page
 * (https://ird.gov.np/pan-search/) fills `#result` with a "PAN Detail" table of <th>/<td> rows
 * ("Name (Eng)", "Name (Nep)", "Effective Registration Date" …) and a "Registration Details"
 * table whose 4th column is each registration's status, or writes a message into `#errdiv`:
 * "अवैध जानकारी।" (invalid information) when the IRD refuses the search, "Something went wrong.
 * Please try again." when its request failed.
 *
 * Anything else means the IRD changed its page: LAYOUT_CHANGED, so a person looks instead of the
 * worker guessing.
 */

const INVALID_INFORMATION = 'अवैध जानकारी';
const SOMETHING_WENT_WRONG = 'Something went wrong';

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
};

/** Text of an HTML fragment: tags dropped, the common entities decoded, spaces collapsed. */
export function htmlText(fragment: string): string {
  return fragment
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (entity, name: string) => {
      const known = ENTITIES[name.toLowerCase()];
      if (known !== undefined) return known;
      if (name.startsWith('#x') || name.startsWith('#X')) {
        return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
      }
      if (name.startsWith('#')) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
      return entity;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/** The <td> beside `<th>label</th>`, as text; undefined when there is no such row. */
function cellBeside(html: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(
    `<th[^>]*>\\s*${escaped}\\s*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>`,
    'i',
  ).exec(html);
  return match?.[1] === undefined ? undefined : htmlText(match[1]);
}

/** The page writes "-" for an empty value. */
function value(text: string | undefined): string | null {
  return text === undefined || text === '' || text === '-' ? null : text;
}

/** The 4th cell of each row of the "Registration Details" table body. */
function registrationStatuses(html: string): string[] {
  const start = html.search(/Registration Details/i);
  if (start < 0) return [];
  const body = /<tbody[^>]*>([\s\S]*?)<\/tbody>/i.exec(html.slice(start));
  if (body?.[1] === undefined) return [];
  const statuses: string[] = [];
  for (const row of body[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...(row[1] ?? '').matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) =>
      htmlText(cell[1] ?? ''),
    );
    const status = cells[3];
    if (cells.length >= 4 && status !== undefined && status !== '' && status !== '-') {
      statuses.push(status);
    }
  }
  return statuses;
}

export interface RenderedIrdAnswer {
  /** innerHTML of #result. */
  readonly resultHtml: string;
  /** textContent of #errdiv. */
  readonly errorText: string;
}

/**
 * The lookup's result. Throws IrdTransientError for the page's own "something went wrong" (its
 * request failed: worth another attempt).
 */
export function parseIrdResult(answer: RenderedIrdAnswer): IrdLookupResult {
  const errorText = answer.errorText.trim();
  if (/<table/i.test(answer.resultHtml)) {
    const english = cellBeside(answer.resultHtml, 'Name (Eng)');
    const nepali = cellBeside(answer.resultHtml, 'Name (Nep)');
    if (english === undefined && nepali === undefined) {
      return {
        kind: 'LAYOUT_CHANGED',
        detail: 'the result has no "Name (Eng)" or "Name (Nep)" row',
      };
    }
    return {
      kind: 'FOUND',
      businessName: value(english) ?? value(nepali) ?? '',
      registrationDate: value(cellBeside(answer.resultHtml, 'Effective Registration Date')),
      accountStatuses: registrationStatuses(answer.resultHtml),
    };
  }
  if (errorText.includes(INVALID_INFORMATION)) return { kind: 'NOT_FOUND' };
  if (errorText.includes(SOMETHING_WENT_WRONG)) {
    throw new IrdTransientError('the IRD search request failed ("Something went wrong")');
  }
  return {
    kind: 'LAYOUT_CHANGED',
    detail:
      errorText === ''
        ? 'neither a result table nor a message appeared'
        : `an unknown message: "${errorText.slice(0, 120)}"`,
  };
}
