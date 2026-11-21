/**
 * One CSV column: its header and how to read the value from a row.
 */
export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string | number | boolean | null | undefined;
}

/**
 * Escapes one CSV cell: wraps it in quotes when it contains a comma, quote
 * or line break, and neutralizes values Excel would run as a formula.
 *
 * @param value - The cell value.
 * @returns The escaped cell.
 */
function escapeCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }

  let text = String(value);

  // Text starting with = + - @ would be run as a formula in Excel.
  if (typeof value === "string" && /^[=+\-@]/.test(text)) {
    text = `'${text}`;
  }

  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Builds a CSV file (UTF-8 with a BOM, so Excel shows ₹ and Hindi text correctly).
 *
 * @param rows - The rows.
 * @param columns - The columns, in order.
 * @returns The CSV text.
 */
export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const lines = [
    columns.map((column) => escapeCell(column.header)).join(","),
    ...rows.map((row) => columns.map((column) => escapeCell(column.value(row))).join(",")),
  ];

  return `﻿${lines.join("\r\n")}\r\n`;
}
