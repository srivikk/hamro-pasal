/** "Rs. 2,500", "Rs. -1,00,000.50": lakh grouping, paisa only when present (as in the vendor SMS). */
export function formatNpr(amount: number): string {
  return `Rs. ${amount.toLocaleString('en-IN', {
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

/** The platform's operating time zone (Nepal Time, UTC+05:45). */
export const ADMIN_TIME_ZONE = 'Asia/Kathmandu';

const dateTimeParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: ADMIN_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** "2026-10-01 11:45:00" in Nepal Time, whatever the browser's zone. */
export function formatDateTime(iso: string): string {
  const parts = Object.fromEntries(
    dateTimeParts.formatToParts(new Date(iso)).map((part) => [part.type, part.value]),
  );
  const { year = '', month = '', day = '', hour = '', minute = '', second = '' } = parts;
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}
