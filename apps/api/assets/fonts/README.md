# Invoice fonts

The fiscal invoice PDF (`src/invoices/invoice-pdf.ts`) draws Nepali text with the files in this
directory. They are server assets, read once when the API starts.

| File                             | Required | Used for                                                   |
| -------------------------------- | -------- | ---------------------------------------------------------- |
| `NotoSansDevanagari-Regular.ttf` | yes      | every Devanagari run (names, the IRD's Nepali field names) |
| `NotoSansDevanagari-Bold.ttf`    | no       | Devanagari in headings; the regular weight without it      |
| `OFL.txt`                        | –        | the fonts' licence (SIL Open Font License 1.1)             |

- Without the regular file a development API prints Latin text only (Devanagari as `?`) and logs a
  warning at startup. **A production API refuses to print** (`503 INVOICE_PRINT_UNAVAILABLE`).
- Noto Sans Devanagari has no Latin letters, so Latin runs are drawn with the PDF's built-in
  Helvetica; the renderer switches font per script run.
- A container image must copy `apps/api/assets` next to `dist`.
- Source: https://github.com/notofonts/devanagari (hinted TTF).
