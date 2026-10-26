/**
 * Order money calculations. All amounts are integer paise so sums and
 * splits never suffer floating-point rounding errors; values are converted
 * to rupees only when reading from or writing to the database.
 */

/** A Prisma Decimal value, typed structurally. */
type DecimalValue = { toNumber(): number };

/**
 * Converts a rupee amount to integer paise.
 *
 * @param value - Rupees as a number or Prisma Decimal.
 * @returns The amount in paise.
 */
export function toPaise(value: number | DecimalValue): number {
  const rupees = typeof value === "number" ? value : value.toNumber();
  return Math.round(rupees * 100);
}

/**
 * Converts integer paise to rupees.
 *
 * @param paise - The amount in paise.
 * @returns The amount in rupees.
 */
export function fromPaise(paise: number): number {
  return paise / 100;
}

/** A billable order line. */
export interface PricedLine {
  /** Identifies the line in the result (e.g. the order item ID). */
  key: string;
  /** (unit price + addons) × quantity, in paise. */
  lineSubtotal: number;
  /** GST rate in percent, e.g. 5. */
  gstRate: number;
}

/** Discount and tax charged on one line, in paise. */
export interface LineCharges {
  key: string;
  discount: number;
  tax: number;
}

/** Order totals in paise. */
export interface OrderTotals {
  subtotal: number;
  discount: number;
  tax: number;
  roundOff: number;
  total: number;
  lines: LineCharges[];
}

/**
 * Calculates order totals with GST added on top of item prices.
 *
 * The order discount is capped at the subtotal and spread across lines in
 * proportion to their value (largest remainder, so shares add up exactly).
 * GST is charged on each line after its discount share, and the grand
 * total is rounded to the nearest rupee.
 *
 * @param lines - The billable lines (void lines excluded).
 * @param requestedDiscount - The flat order discount, in paise.
 * @returns The subtotal, discount, tax, round-off, total and per-line charges.
 */
export function calculateOrderTotals(
  lines: PricedLine[],
  requestedDiscount: number,
): OrderTotals {
  const subtotal = lines.reduce((sum, line) => sum + line.lineSubtotal, 0);
  const discount = Math.min(Math.max(requestedDiscount, 0), subtotal);

  const shares = lines.map((line) => {
    const exact = subtotal === 0 ? 0 : (discount * line.lineSubtotal) / subtotal;
    const floor = Math.floor(exact);
    return { line, share: floor, remainder: exact - floor };
  });

  // Hand the paise lost to flooring to the lines with the largest remainders.
  let leftover = discount - shares.reduce((sum, entry) => sum + entry.share, 0);
  const byRemainder = [...shares].sort((a, b) => b.remainder - a.remainder);

  for (const entry of byRemainder) {
    if (leftover <= 0) {
      break;
    }

    entry.share += 1;
    leftover -= 1;
  }

  const charged = shares.map(({ line, share }) => ({
    key: line.key,
    discount: share,
    tax: Math.round(((line.lineSubtotal - share) * line.gstRate) / 100),
  }));

  const tax = charged.reduce((sum, line) => sum + line.tax, 0);
  const gross = subtotal - discount + tax;
  const total = Math.round(gross / 100) * 100;

  return {
    subtotal,
    discount,
    tax,
    roundOff: total - gross,
    total,
    lines: charged,
  };
}

/** GST collected at one rate, split equally into CGST and SGST. */
export interface TaxBreakdownEntry {
  rate: number;
  taxableAmount: number;
  cgst: number;
  sgst: number;
  totalTax: number;
}

/**
 * Groups line taxes by GST rate for the bill, splitting each into CGST and
 * SGST halves (intra-state supply).
 *
 * @param lines - Lines with their rate, taxable value and tax, in paise.
 * @returns One entry per rate in rupees, ordered by rate.
 */
export function buildTaxBreakdown(
  lines: Array<{ gstRate: number; taxableAmount: number; tax: number }>,
): TaxBreakdownEntry[] {
  const byRate = new Map<number, { taxable: number; tax: number }>();

  for (const line of lines) {
    const entry = byRate.get(line.gstRate) ?? { taxable: 0, tax: 0 };
    entry.taxable += line.taxableAmount;
    entry.tax += line.tax;
    byRate.set(line.gstRate, entry);
  }

  return [...byRate.entries()]
    .sort(([rateA], [rateB]) => rateA - rateB)
    .map(([rate, { taxable, tax }]) => {
      const cgst = Math.round(tax / 2);

      return {
        rate,
        taxableAmount: fromPaise(taxable),
        cgst: fromPaise(cgst),
        sgst: fromPaise(tax - cgst),
        totalTax: fromPaise(tax),
      };
    });
}
