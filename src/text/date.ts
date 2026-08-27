/**
 * Dates — ISO 32000-2 §7.9.4.
 *
 * The form is `D:YYYYMMDDHHmmSSOHH'mm` (R-7.9.4-2). Every field after `D:YYYY`
 * is optional, and a field may be present only if all the fields before it are
 * (R-7.9.4-12); the APOSTROPHE may be present only if the hour offset is
 * (R-7.9.4-14), and the minute offset only if the APOSTROPHE is (R-7.9.4-15).
 *
 * ⚠️ ISO 32000-2 has **no terminating APOSTROPHE**. NOTE 2 of §7.9.4 records that
 * PDF up to and including 1.7 defined one, and recommends that processors accept
 * date strings that still carry it. `parsePdfDate` therefore accepts it and
 * `formatPdfDate` does not write it.
 */

/** A date string read back into its fields (§7.9.4). */
export interface PdfDate {
  /** `YYYY` (R-7.9.4-3). */
  readonly year: number;
  /** `MM`, 1–12. Defaults to 1 when absent (R-7.9.4-16). */
  readonly month: number;
  /** `DD`, 1–31. Defaults to 1 when absent (R-7.9.4-16). */
  readonly day: number;
  /** `HH`, 0–23. Defaults to 0 (R-7.9.4-16). */
  readonly hour: number;
  /** `mm`, 0–59. Defaults to 0 (R-7.9.4-16). */
  readonly minute: number;
  /** `SS`, 0–59. Defaults to 0 (R-7.9.4-16). */
  readonly second: number;
  /**
   * `O` — how local time relates to UT (R-7.9.4-9), or `null` when the string
   * carries no UT information, which the clause says shall be taken as GMT
   * (R-7.9.4-17).
   */
  readonly utRelationship: '+' | '-' | 'Z' | null;
  /** Absolute value of the offset from UT in hours, 0–23 (R-7.9.4-10). */
  readonly offsetHours: number;
  /** Absolute value of the offset from UT in minutes, 0–59 (R-7.9.4-11). */
  readonly offsetMinutes: number;
  /**
   * The instant as milliseconds since the epoch.
   *
   * The fields above are local time whether or not a time zone is given
   * (R-7.9.4-18); this is that local time converted to UT.
   *
   * ⚠️ The clause bounds `DD` at 01–31 without regard to the month, so
   * `D:20260231` is a well-formed date string. This field is computed with
   * `Date.UTC`, which rolls such a day into the following month. Read the
   * fields, not this, when the calendar day itself matters.
   */
  readonly epochMs: number;
}

/**
 * `D:` then YYYY, then each further field only if its predecessors are present
 * (R-7.9.4-12), then the UT relationship with its optional offset
 * (R-7.9.4-14/-15). The final `'?` is the terminating APOSTROPHE of PDF 1.7 and
 * earlier, accepted per NOTE 2.
 */
const DATE =
  /^D:(\d{4})(?:(\d{2})(?:(\d{2})(?:(\d{2})(?:(\d{2})(?:(\d{2}))?)?)?)?)?(?:([Z+-])(?:(\d{2})(?:'(?:(\d{2})'?)?)?)?)?$/;

function inRange(value: number, low: number, high: number): boolean {
  return Number.isInteger(value) && value >= low && value <= high;
}

/**
 * Read a date string (§7.9.4). Returns `null` when the string does not conform.
 *
 * `null` covers both "not a date" and "a date the clause does not allow", such as
 * a minute offset written without the APOSTROPHE before it (R-7.9.4-15) or a
 * month outside 01–12 (R-7.9.4-4). The caller decides what to do about it; this
 * function never guesses a value the string did not carry.
 */
export function parsePdfDate(value: string): PdfDate | null {
  const match = DATE.exec(value);
  if (match === null) return null;

  const year = Number(match[1]);
  // R-7.9.4-16 — MM and DD default to 01, every other numerical field to zero.
  const month = match[2] === undefined ? 1 : Number(match[2]);
  const day = match[3] === undefined ? 1 : Number(match[3]);
  const hour = match[4] === undefined ? 0 : Number(match[4]);
  const minute = match[5] === undefined ? 0 : Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const utRelationship = (match[7] ?? null) as '+' | '-' | 'Z' | null;
  const offsetHours = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinutes = match[9] === undefined ? 0 : Number(match[9]);

  if (
    !inRange(month, 1, 12) ||
    !inRange(day, 1, 31) ||
    !inRange(hour, 0, 23) ||
    !inRange(minute, 0, 59) ||
    !inRange(second, 0, 59) ||
    !inRange(offsetHours, 0, 23) ||
    !inRange(offsetMinutes, 0, 59)
  ) {
    return null;
  }
  // R-7.9.4-9 — Z signifies that local time is equal to UT. A non-zero offset
  // after Z contradicts the character it follows, so the string is not read.
  if (utRelationship === 'Z' && (offsetHours !== 0 || offsetMinutes !== 0)) return null;

  // R-7.9.4-17 — no UT information means GMT, so the offset is zero there too.
  const signedOffsetMinutes =
    utRelationship === '+'
      ? offsetHours * 60 + offsetMinutes
      : utRelationship === '-'
        ? -(offsetHours * 60 + offsetMinutes)
        : 0;

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    utRelationship,
    offsetHours,
    offsetMinutes,
    epochMs: Date.UTC(year, month - 1, day, hour, minute, second) - signedOffsetMinutes * 60_000,
  };
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/**
 * Write an instant as a date string (§7.9.4), in UT.
 *
 * The UT relationship is written as `+00'00` rather than `Z`: both are allowed by
 * R-7.9.4-9, and the offset form is what the clause's own example shows.
 *
 * No terminating APOSTROPHE is written — ISO 32000-2 does not have one (NOTE 2 of
 * §7.9.4 only recommends *accepting* the PDF 1.7 form on input).
 *
 * @throws RangeError when the year does not fit the four digits of `YYYY`.
 */
export function formatPdfDate(when: Date): string {
  const year = when.getUTCFullYear();
  if (!inRange(year, 0, 9999)) {
    throw new RangeError(
      `year ${year} does not fit the YYYY field of a PDF date string (§7.9.4, R-7.9.4-3)`,
    );
  }
  return (
    `D:${pad(year, 4)}${pad(when.getUTCMonth() + 1)}${pad(when.getUTCDate())}` +
    `${pad(when.getUTCHours())}${pad(when.getUTCMinutes())}${pad(when.getUTCSeconds())}+00'00`
  );
}
