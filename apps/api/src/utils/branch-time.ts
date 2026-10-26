/** Timezone used when a branch has an invalid timezone configured. */
const FALLBACK_TIMEZONE = "Asia/Kolkata";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Returns the local calendar date and time of an instant in a timezone.
 *
 * @param timezone - An IANA timezone, e.g. "Asia/Kolkata".
 * @param now - The instant to convert.
 * @returns The local year, month (1-12), day, hour and minute.
 */
function getLocalParts(timezone: string, now: Date) {
  let formatter: Intl.DateTimeFormat;

  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    // An unknown timezone throws a RangeError; fall back to the default.
    return getLocalParts(FALLBACK_TIMEZONE, now);
  }

  const parts = formatter.formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((entry) => entry.type === type)?.value ?? 0);

  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute"),
  };
}

/**
 * Returns the branch's business day (YYYY-MM-DD) for an instant.
 *
 * Sales made before the branch's business-day cutoff (e.g. 04:00) belong
 * to the previous day, so a late-night shift stays on one business day.
 *
 * @param timezone - The branch's IANA timezone.
 * @param businessDayCutoff - The cutoff stored as a UTC time on 1970-01-01, or null.
 * @param now - The instant to convert.
 * @returns The business date in YYYY-MM-DD format.
 */
export function getBusinessDate(
  timezone: string,
  businessDayCutoff: Date | null,
  now: Date = new Date(),
): string {
  const local = getLocalParts(timezone, now);
  let date = new Date(Date.UTC(local.year, local.month - 1, local.day));

  if (businessDayCutoff) {
    const cutoffMinutes =
      businessDayCutoff.getUTCHours() * 60 + businessDayCutoff.getUTCMinutes();

    if (local.hour * 60 + local.minute < cutoffMinutes) {
      date = new Date(date.getTime() - MS_PER_DAY);
    }
  }

  return date.toISOString().slice(0, 10);
}

/**
 * Returns the Indian financial year (April-March) of a business date in
 * YY-YY format, matching the branch invoice sequence format.
 *
 * @param businessDate - A date in YYYY-MM-DD format.
 * @returns The financial year, e.g. "26-27".
 */
export function getFinancialYear(businessDate: string): string {
  const [year, month] = businessDate.split("-").map(Number);
  const startYear = month >= 4 ? year : year - 1;

  return `${String(startYear).slice(-2)}-${String(startYear + 1).slice(-2)}`;
}
