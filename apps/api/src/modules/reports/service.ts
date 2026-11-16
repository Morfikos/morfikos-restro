import { createPrismaClient } from "@morfikos/database";
import { ReportServiceErrorCode, type UserRole } from "@morfikos/auth";
import type {
  DashboardQuery,
  ItemSalesReportQuery,
  ReportRangeQuery,
} from "@morfikos/validation";

import { getBusinessDate } from "../../utils/branch-time.js";
import {
  DASHBOARD_TOP_ITEMS,
  DISCOUNT_BILLS_LIMIT,
  MAX_REPORT_DAYS,
  QR_MENU_STAFF_LABEL,
  VOID_LIST_LIMIT,
  WEEKDAY_NAMES,
} from "./constants.js";

const prisma = createPrismaClient();

/** A Prisma Decimal value, typed structurally. */
type DecimalValue = { toNumber(): number };

/**
 * The owner or manager viewing reports.
 */
export interface ReportActor {
  userId: string;
  role: UserRole;
  organizationId: string;
  branchIds: string[];
}

/**
 * Represents errors that can occur while building reports.
 */
export class ReportServiceError extends Error {
  /**
   * Creates a report service error.
   *
   * @param code - The standardized error code.
   * @param message - A description of the error.
   */
  constructor(
    public readonly code: ReportServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ReportServiceError";
  }
}

/** A business-date range (YYYY-MM-DD, inclusive). */
interface DateRange {
  from: string;
  to: string;
}

type ReportBranch = Awaited<ReturnType<typeof getReportBranch>>;

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Converts paise to rupees.
 *
 * @param paise - The amount in paise.
 * @returns The amount in rupees.
 */
function rupees(paise: number | null | undefined): number {
  return Math.round(paise ?? 0) / 100;
}

/**
 * Rounds a rupee amount to paise.
 *
 * @param value - The amount.
 * @returns The rounded amount.
 */
function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Converts a Prisma decimal (or null) to a number.
 *
 * @param value - The decimal.
 * @returns The number, or 0 for null.
 */
function toNumber(value: DecimalValue | null | undefined): number {
  return value ? value.toNumber() : 0;
}

/**
 * Works out a share of a total as a percentage.
 *
 * @param part - The part.
 * @param total - The total.
 * @returns The percentage (2 decimals), or 0 when the total is 0.
 */
function percent(part: number, total: number): number {
  return total > 0 ? roundMoney((part / total) * 100) : 0;
}

/**
 * Works out the % change from a previous value.
 *
 * @param current - This period's value.
 * @param previous - The earlier value.
 * @returns The change in %, or null when there was nothing before.
 */
function change(current: number, previous: number): number | null {
  return previous > 0 ? roundMoney(((current - previous) / previous) * 100) : null;
}

/**
 * Moves a YYYY-MM-DD date by a number of days.
 *
 * @param date - The date.
 * @param days - Days to add (negative to go back).
 * @returns The new date.
 */
function addDays(date: string, days: number): string {
  const time = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;

  return new Date(time).toISOString().slice(0, 10);
}

/**
 * Loads a branch the actor can report on.
 *
 * @param actor - The owner or manager.
 * @param branchId - The branch ID.
 * @returns The branch's name and clock settings.
 * @throws ReportServiceError If the branch isn't accessible or found.
 */
async function getReportBranch(actor: ReportActor, branchId: string) {
  if (!actor.branchIds.includes(branchId)) {
    throw new ReportServiceError(ReportServiceErrorCode.BRANCH_ACCESS_DENIED, "Access denied for this branch");
  }

  const branch = await prisma.branch.findFirst({
    where: { id: branchId, organizationId: actor.organizationId },
    select: { id: true, name: true, timezone: true, businessDayCutoff: true },
  });

  if (!branch) {
    throw new ReportServiceError(ReportServiceErrorCode.BRANCH_NOT_FOUND, "Branch not found");
  }

  return branch;
}

/**
 * Fills in a report's dates: no dates means the branch's current business
 * day; only `from` runs up to today; only `to` is that single day.
 *
 * @param branch - The branch.
 * @param query - The requested range.
 * @returns The full range.
 * @throws ReportServiceError If the range is longer than allowed.
 */
function resolveRange(
  branch: { timezone: string; businessDayCutoff: Date | null },
  query: { from?: string; to?: string },
): DateRange {
  const today = getBusinessDate(branch.timezone, branch.businessDayCutoff);
  const from = query.from ?? query.to ?? today;
  const to = query.to ?? (query.from && query.from > today ? query.from : today);

  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 >= MAX_REPORT_DAYS) {
    throw new ReportServiceError(
      ReportServiceErrorCode.INVALID_RANGE,
      `A report can cover at most ${MAX_REPORT_DAYS} days`,
    );
  }

  return { from, to };
}

/**
 * The filter for bills settled at a branch in a range — the basis of every
 * sales figure (open and cancelled bills are not sales).
 *
 * @param branchId - The branch ID.
 * @param range - The business-date range.
 * @returns The Prisma where clause for bills.
 */
function settledBills(branchId: string, range: DateRange) {
  return {
    branchId,
    status: "SETTLED" as const,
    businessDate: { gte: range.from, lte: range.to },
  };
}

// ─── Building blocks ────────────────────────────────────────────────────

/**
 * Sales totals for a range: gross, discounts, net, GST, round-off, total,
 * bills, average bill, items sold, cancelled bills and refunds.
 *
 * @param branchId - The branch ID.
 * @param range - The business-date range.
 * @returns The totals in rupees.
 */
async function getSalesTotals(branchId: string, range: DateRange) {
  const billWhere = settledBills(branchId, range);

  const [bills, invoices, cancelled, refunds, items] = await Promise.all([
    prisma.bill.aggregate({
      where: billWhere,
      _count: { _all: true },
      _sum: { subtotalPaise: true, discountPaise: true, taxPaise: true, roundOffPaise: true, totalPaise: true },
    }),
    prisma.invoice.aggregate({
      where: { branchId, businessDate: { gte: range.from, lte: range.to } },
      _sum: { cgstPaise: true, sgstPaise: true },
    }),
    prisma.bill.aggregate({
      where: { branchId, status: "CANCELLED", businessDate: { gte: range.from, lte: range.to } },
      _count: { _all: true },
      _sum: { totalPaise: true },
    }),
    prisma.creditNote.aggregate({
      where: { branchId, businessDate: { gte: range.from, lte: range.to } },
      _count: { _all: true },
      _sum: { creditAmountPaise: true, taxPaise: true },
    }),
    prisma.orderItem.aggregate({
      where: { status: { not: "VOID" }, order: { bill: billWhere } },
      _sum: { quantity: true },
    }),
  ]);

  const billCount = bills._count._all;
  const gross = rupees(bills._sum.subtotalPaise);
  const discounts = rupees(bills._sum.discountPaise);
  const total = rupees(bills._sum.totalPaise);
  const refundAmount = rupees(refunds._sum.creditAmountPaise);

  return {
    bills: billCount,
    itemsSold: items._sum.quantity ?? 0,
    grossSales: gross,
    discounts,
    netSales: roundMoney(gross - discounts),
    tax: rupees(bills._sum.taxPaise),
    cgst: rupees(invoices._sum.cgstPaise),
    sgst: rupees(invoices._sum.sgstPaise),
    roundOff: rupees(bills._sum.roundOffPaise),
    totalSales: total,
    averageBillValue: billCount > 0 ? roundMoney(total / billCount) : 0,
    refunds: { creditNotes: refunds._count._all, amount: refundAmount, tax: rupees(refunds._sum.taxPaise) },
    netAfterRefunds: roundMoney(total - refundAmount),
    cancelledBills: { count: cancelled._count._all, value: rupees(cancelled._sum.totalPaise) },
  };
}

/**
 * Money collected per payment method for bills settled in a range.
 *
 * @param branchId - The branch ID.
 * @param range - The business-date range.
 * @returns One row per method with its share.
 */
async function getPaymentSplit(branchId: string, range: DateRange) {
  const rows = await prisma.billPayment.groupBy({
    by: ["method"],
    where: { bill: settledBills(branchId, range) },
    _count: { _all: true },
    _sum: { amountPaise: true },
  });

  const total = rows.reduce((sum, row) => sum + (row._sum.amountPaise ?? 0), 0);

  return ["CASH", "UPI", "CARD"].map((method) => {
    const row = rows.find((entry) => entry.method === method);
    const amount = row?._sum.amountPaise ?? 0;

    return {
      method: method.toLowerCase(),
      payments: row?._count._all ?? 0,
      amount: rupees(amount),
      share: percent(amount, total),
    };
  });
}

/** One dish's sales. */
interface ItemSalesRow {
  menuItemId: string | null;
  name: string;
  categoryId: string | null;
  categoryName: string | null;
  quantity: number;
  revenue: number;
  orders: number;
}

/**
 * Dish sales for bills settled in a range (void lines excluded). Revenue
 * is before tax and after discounts.
 *
 * @param branchId - The branch ID.
 * @param range - The business-date range.
 * @param categoryId - Limit to one menu category.
 * @returns One row per dish (custom items grouped by name).
 */
async function getItemSalesRows(branchId: string, range: DateRange, categoryId: string | null) {
  const rows = await prisma.$queryRaw<ItemSalesRow[]>`
    SELECT
      oi."menuItemId" AS "menuItemId",
      MAX(oi."name") AS "name",
      mi."categoryId" AS "categoryId",
      MAX(mc."name") AS "categoryName",
      SUM(oi."quantity")::int AS "quantity",
      SUM(oi."lineSubtotal" - oi."discountAmount")::float8 AS "revenue",
      COUNT(DISTINCT o."id")::int AS "orders"
    FROM "OrderItem" oi
    JOIN "Order" o ON o."id" = oi."orderId"
    JOIN "Bill" b ON b."id" = o."billId"
    LEFT JOIN "MenuItem" mi ON mi."id" = oi."menuItemId"
    LEFT JOIN "MenuCategory" mc ON mc."id" = mi."categoryId"
    WHERE b."branchId" = ${branchId}
      AND b."status" = 'SETTLED'
      AND b."businessDate" BETWEEN ${range.from} AND ${range.to}
      AND oi."status" <> 'VOID'
      AND (${categoryId}::text IS NULL OR mi."categoryId" = ${categoryId})
    GROUP BY oi."menuItemId", mi."categoryId", CASE WHEN oi."menuItemId" IS NULL THEN oi."name" END
  `;

  return rows.map((row) => ({ ...row, revenue: roundMoney(row.revenue) }));
}

/**
 * Bills and sales per hour of the day (branch local time of settlement)
 * and per weekday.
 *
 * @param branch - The branch.
 * @param range - The business-date range.
 * @returns 24 hourly buckets and 7 weekday buckets.
 */
async function getTimeBuckets(branch: ReportBranch, range: DateRange) {
  const [hours, weekdays] = await Promise.all([
    prisma.$queryRaw<{ hour: number; bills: number; sales: number }[]>`
      SELECT
        EXTRACT(HOUR FROM (b."settledAt" AT TIME ZONE 'UTC') AT TIME ZONE ${branch.timezone})::int AS "hour",
        COUNT(*)::int AS "bills",
        SUM(b."totalPaise")::float8 AS "sales"
      FROM "Bill" b
      WHERE b."branchId" = ${branch.id}
        AND b."status" = 'SETTLED'
        AND b."businessDate" BETWEEN ${range.from} AND ${range.to}
        AND b."settledAt" IS NOT NULL
      GROUP BY 1
    `,
    prisma.$queryRaw<{ weekday: number; bills: number; sales: number; days: number }[]>`
      SELECT
        EXTRACT(ISODOW FROM b."businessDate"::date)::int AS "weekday",
        COUNT(*)::int AS "bills",
        SUM(b."totalPaise")::float8 AS "sales",
        COUNT(DISTINCT b."businessDate")::int AS "days"
      FROM "Bill" b
      WHERE b."branchId" = ${branch.id}
        AND b."status" = 'SETTLED'
        AND b."businessDate" BETWEEN ${range.from} AND ${range.to}
      GROUP BY 1
    `,
  ]);

  const hourly = Array.from({ length: 24 }, (_, hour) => {
    const row = hours.find((entry) => entry.hour === hour);

    return {
      hour,
      label: `${String(hour).padStart(2, "0")}:00–${String((hour + 1) % 24).padStart(2, "0")}:00`,
      bills: row?.bills ?? 0,
      sales: rupees(row?.sales),
    };
  });

  const byWeekday = Array.from({ length: 7 }, (_, index) => {
    const weekday = index + 1;
    const row = weekdays.find((entry) => entry.weekday === weekday);
    const sales = rupees(row?.sales);

    return {
      weekday,
      day: WEEKDAY_NAMES[weekday],
      bills: row?.bills ?? 0,
      sales,
      averagePerDay: row?.days ? roundMoney(sales / row.days) : 0,
    };
  });

  return { hourly, byWeekday };
}

// ─── Reports ────────────────────────────────────────────────────────────

/**
 * The live dashboard for one business day: today's sales against
 * yesterday and the same day last week, payment split, top dishes, sales
 * by hour, and what's happening now (running tables, QR orders waiting,
 * table requests, low-stock alerts).
 *
 * @param actor - The owner or manager.
 * @param branchId - The branch ID.
 * @param query - The day (defaults to today).
 * @returns The dashboard.
 */
export async function getDashboard(actor: ReportActor, branchId: string, query: DashboardQuery) {
  const branch = await getReportBranch(actor, branchId);
  const date = query.date ?? getBusinessDate(branch.timezone, branch.businessDayCutoff);
  const day = { from: date, to: date };
  const yesterday = { from: addDays(date, -1), to: addDays(date, -1) };
  const lastWeek = { from: addDays(date, -7), to: addDays(date, -7) };

  const [today, previousDay, sameDayLastWeek, payments, items, time, running, pendingQrOrders, openRequests, stockAlerts, openSessions] =
    await Promise.all([
      getSalesTotals(branch.id, day),
      getSalesTotals(branch.id, yesterday),
      getSalesTotals(branch.id, lastWeek),
      getPaymentSplit(branch.id, day),
      getItemSalesRows(branch.id, day, null),
      getTimeBuckets(branch, day),
      prisma.order.aggregate({
        where: { branchId: branch.id, status: { in: ["OPEN", "BILLED"] } },
        _count: { _all: true },
        _sum: { totalAmount: true },
      }),
      prisma.qrOrder.count({ where: { branchId: branch.id, status: "PENDING" } }),
      prisma.serviceRequest.count({ where: { branchId: branch.id, status: { in: ["OPEN", "ACKNOWLEDGED"] } } }),
      prisma.stockAlert.count({ where: { branchId: branch.id, status: { in: ["ACTIVE", "ACKNOWLEDGED"] } } }),
      prisma.tableSession.count({ where: { branchId: branch.id, status: "OPEN" } }),
    ]);

  const occupiedTables = await prisma.order.findMany({
    where: { branchId: branch.id, status: { in: ["OPEN", "BILLED"] }, tableId: { not: null } },
    select: { tableId: true },
    distinct: ["tableId"],
  });

  const busiest = time.hourly.reduce((best, hour) => (hour.sales > best.sales ? hour : best), time.hourly[0]!);

  return {
    branch: { id: branch.id, name: branch.name },
    date,
    sales: today,
    comparison: {
      yesterday: {
        date: yesterday.from,
        totalSales: previousDay.totalSales,
        bills: previousDay.bills,
        change: change(today.totalSales, previousDay.totalSales),
      },
      sameDayLastWeek: {
        date: lastWeek.from,
        totalSales: sameDayLastWeek.totalSales,
        bills: sameDayLastWeek.bills,
        change: change(today.totalSales, sameDayLastWeek.totalSales),
      },
    },
    payments,
    topItems: [...items]
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, DASHBOARD_TOP_ITEMS)
      .map(({ menuItemId, name, quantity, revenue }) => ({ menuItemId, name, quantity, revenue })),
    hourly: time.hourly,
    peakHour: busiest && busiest.sales > 0 ? busiest : null,
    live: {
      runningOrders: running._count._all,
      runningOrdersValue: roundMoney(toNumber(running._sum.totalAmount)),
      occupiedTables: occupiedTables.length,
      openQrSessions: openSessions,
      pendingQrOrders,
      openTableRequests: openRequests,
      lowStockAlerts: stockAlerts,
    },
  };
}

/**
 * Sales summary (day-end / Z report) for a range: totals, GST, refunds,
 * cancelled bills, payment split, order-type and channel split, and one
 * row per day.
 *
 * @param actor - The owner or manager.
 * @param branchId - The branch ID.
 * @param query - The business-date range.
 * @returns The summary.
 */
export async function getSalesSummary(actor: ReportActor, branchId: string, query: ReportRangeQuery) {
  const branch = await getReportBranch(actor, branchId);
  const range = resolveRange(branch, query);
  const billWhere = settledBills(branch.id, range);

  const [totals, payments, byOrderType, bySource, days] = await Promise.all([
    getSalesTotals(branch.id, range),
    getPaymentSplit(branch.id, range),
    prisma.order.groupBy({
      by: ["orderType"],
      where: { status: { not: "CANCELLED" }, bill: billWhere },
      _count: { _all: true },
      _sum: { totalAmount: true },
    }),
    prisma.order.groupBy({
      by: ["source"],
      where: { status: { not: "CANCELLED" }, bill: billWhere },
      _count: { _all: true },
      _sum: { totalAmount: true },
    }),
    prisma.bill.groupBy({
      by: ["businessDate"],
      where: billWhere,
      orderBy: { businessDate: "asc" },
      _count: { _all: true },
      _sum: { subtotalPaise: true, discountPaise: true, taxPaise: true, totalPaise: true },
    }),
  ]);

  /**
   * Shapes an order group-by row.
   *
   * @param key - The group value.
   * @param row - The group-by row.
   * @returns The row with its share of sales.
   */
  const splitRow = (key: string, row: { _count: { _all: number }; _sum: { totalAmount: DecimalValue | null } }) => {
    const amount = roundMoney(toNumber(row._sum.totalAmount));

    return { key: key.toLowerCase(), orders: row._count._all, amount, share: percent(amount, totals.totalSales) };
  };

  return {
    branch: { id: branch.id, name: branch.name },
    ...range,
    totals,
    payments,
    byOrderType: byOrderType.map((row) => splitRow(row.orderType, row)),
    bySource: bySource.map((row) => splitRow(row.source, row)),
    days: days.map((row) => {
      const gross = rupees(row._sum.subtotalPaise);
      const discounts = rupees(row._sum.discountPaise);
      const total = rupees(row._sum.totalPaise);

      return {
        date: row.businessDate,
        bills: row._count._all,
        grossSales: gross,
        discounts,
        netSales: roundMoney(gross - discounts),
        tax: rupees(row._sum.taxPaise),
        totalSales: total,
        averageBillValue: row._count._all > 0 ? roundMoney(total / row._count._all) : 0,
      };
    }),
  };
}

/**
 * Item-wise sales: quantity, revenue (before tax, after discounts), share
 * and average price per dish.
 *
 * @param actor - The owner or manager.
 * @param branchId - The branch ID.
 * @param query - Range, category, sort and limit.
 * @returns The dishes and totals.
 */
export async function getItemSalesReport(actor: ReportActor, branchId: string, query: ItemSalesReportQuery) {
  const branch = await getReportBranch(actor, branchId);
  const range = resolveRange(branch, query);
  const rows = await getItemSalesRows(branch.id, range, query.categoryId ?? null);

  const totalRevenue = rows.reduce((sum, row) => sum + row.revenue, 0);
  const totalQuantity = rows.reduce((sum, row) => sum + row.quantity, 0);

  rows.sort((a, b) => (query.sort === "quantity" ? b.quantity - a.quantity : b.revenue - a.revenue));

  return {
    branch: { id: branch.id, name: branch.name },
    ...range,
    totals: { dishes: rows.length, quantity: totalQuantity, revenue: roundMoney(totalRevenue) },
    items: rows.slice(0, query.limit).map((row, index) => ({
      rank: index + 1,
      menuItemId: row.menuItemId,
      name: row.name,
      category: row.categoryName ?? (row.menuItemId ? "Uncategorized" : "Custom item"),
      quantity: row.quantity,
      revenue: row.revenue,
      averagePrice: row.quantity > 0 ? roundMoney(row.revenue / row.quantity) : 0,
      orders: row.orders,
      revenueShare: percent(row.revenue, totalRevenue),
      quantityShare: percent(row.quantity, totalQuantity),
    })),
  };
}

/**
 * Category-wise sales, built from the item sales.
 *
 * @param actor - The owner or manager.
 * @param branchId - The branch ID.
 * @param query - The business-date range.
 * @returns The categories (highest revenue first) and totals.
 */
export async function getCategorySalesReport(actor: ReportActor, branchId: string, query: ReportRangeQuery) {
  const branch = await getReportBranch(actor, branchId);
  const range = resolveRange(branch, query);
  const rows = await getItemSalesRows(branch.id, range, null);

  const byCategory = new Map<string, { categoryId: string | null; name: string; quantity: number; revenue: number; dishes: number }>();

  for (const row of rows) {
    const key = row.categoryId ?? (row.menuItemId ? "uncategorized" : "custom");
    const entry = byCategory.get(key) ?? {
      categoryId: row.categoryId,
      name: row.categoryName ?? (row.menuItemId ? "Uncategorized" : "Custom items"),
      quantity: 0,
      revenue: 0,
      dishes: 0,
    };

    entry.quantity += row.quantity;
    entry.revenue += row.revenue;
    entry.dishes += 1;
    byCategory.set(key, entry);
  }

  const totalRevenue = rows.reduce((sum, row) => sum + row.revenue, 0);

  return {
    branch: { id: branch.id, name: branch.name },
    ...range,
    totals: { categories: byCategory.size, revenue: roundMoney(totalRevenue) },
    categories: [...byCategory.values()]
      .sort((a, b) => b.revenue - a.revenue)
      .map((entry) => ({
        ...entry,
        revenue: roundMoney(entry.revenue),
        revenueShare: percent(entry.revenue, totalRevenue),
      })),
  };
}

/**
 * Sales by hour of the day and by weekday, with the peak hour and day.
 *
 * @param actor - The owner or manager.
 * @param branchId - The branch ID.
 * @param query - The business-date range.
 * @returns Hourly and weekday buckets.
 */
export async function getHourlySalesReport(actor: ReportActor, branchId: string, query: ReportRangeQuery) {
  const branch = await getReportBranch(actor, branchId);
  const range = resolveRange(branch, query);
  const { hourly, byWeekday } = await getTimeBuckets(branch, range);

  const peakHour = hourly.reduce((best, hour) => (hour.sales > best.sales ? hour : best), hourly[0]!);
  const peakDay = byWeekday.reduce((best, day) => (day.sales > best.sales ? day : best), byWeekday[0]!);

  return {
    branch: { id: branch.id, name: branch.name },
    ...range,
    timezone: branch.timezone,
    peakHour: peakHour.sales > 0 ? peakHour : null,
    peakDay: peakDay.sales > 0 ? peakDay : null,
    hourly,
    byWeekday,
  };
}

/**
 * Payment-mode report: totals per method, per day and per staff member
 * who collected the money.
 *
 * @param actor - The owner or manager.
 * @param branchId - The branch ID.
 * @param query - The business-date range.
 * @returns The payment breakdowns.
 */
export async function getPaymentReport(actor: ReportActor, branchId: string, query: ReportRangeQuery) {
  const branch = await getReportBranch(actor, branchId);
  const range = resolveRange(branch, query);

  const [methods, days, staff] = await Promise.all([
    getPaymentSplit(branch.id, range),
    prisma.$queryRaw<{ date: string; method: string; amount: number; payments: number }[]>`
      SELECT b."businessDate" AS "date", p."method"::text AS "method",
             SUM(p."amountPaise")::float8 AS "amount", COUNT(*)::int AS "payments"
      FROM "BillPayment" p
      JOIN "Bill" b ON b."id" = p."billId"
      WHERE b."branchId" = ${branch.id}
        AND b."status" = 'SETTLED'
        AND b."businessDate" BETWEEN ${range.from} AND ${range.to}
      GROUP BY 1, 2
      ORDER BY 1
    `,
    prisma.billPayment.groupBy({
      by: ["receivedById", "method"],
      where: { bill: settledBills(branch.id, range) },
      _count: { _all: true },
      _sum: { amountPaise: true },
    }),
  ]);

  const users = await prisma.user.findMany({
    where: { id: { in: [...new Set(staff.map((row) => row.receivedById))] } },
    select: { id: true, name: true },
  });
  const nameById = new Map(users.map((user) => [user.id, user.name]));

  const dayMap = new Map<string, { date: string; cash: number; upi: number; card: number; total: number }>();

  for (const row of days) {
    const entry = dayMap.get(row.date) ?? { date: row.date, cash: 0, upi: 0, card: 0, total: 0 };
    const amount = rupees(row.amount);
    const method = row.method.toLowerCase() as "cash" | "upi" | "card";

    entry[method] = roundMoney(entry[method] + amount);
    entry.total = roundMoney(entry.total + amount);
    dayMap.set(row.date, entry);
  }

  const staffMap = new Map<string, { userId: string; name: string; cash: number; upi: number; card: number; total: number; payments: number }>();

  for (const row of staff) {
    const entry = staffMap.get(row.receivedById) ?? {
      userId: row.receivedById,
      name: nameById.get(row.receivedById) ?? "Unknown",
      cash: 0,
      upi: 0,
      card: 0,
      total: 0,
      payments: 0,
    };
    const amount = rupees(row._sum.amountPaise);
    const method = row.method.toLowerCase() as "cash" | "upi" | "card";

    entry[method] = roundMoney(entry[method] + amount);
    entry.total = roundMoney(entry.total + amount);
    entry.payments += row._count._all;
    staffMap.set(row.receivedById, entry);
  }

  return {
    branch: { id: branch.id, name: branch.name },
    ...range,
    total: roundMoney(methods.reduce((sum, row) => sum + row.amount, 0)),
    methods,
    days: [...dayMap.values()],
    byStaff: [...staffMap.values()].sort((a, b) => b.total - a.total),
  };
}

/**
 * GST report for filing: invoice totals (taxable value, CGST, SGST),
 * rate-wise summary, HSN summary and credit notes. All sales are B2C, as
 * customer GSTINs aren't recorded on bills.
 *
 * @param actor - The owner or manager.
 * @param branchId - The branch ID.
 * @param query - The business-date range.
 * @returns The GST report.
 */
export async function getGstReport(actor: ReportActor, branchId: string, query: ReportRangeQuery) {
  const branch = await getReportBranch(actor, branchId);
  const range = resolveRange(branch, query);
  const invoiceWhere = { branchId: branch.id, businessDate: { gte: range.from, lte: range.to } };

  const [invoices, first, last, rates, hsn, creditNotes, creditReasons, gstin] = await Promise.all([
    prisma.invoice.aggregate({
      where: invoiceWhere,
      _count: { _all: true },
      _sum: { subtotalPaise: true, discountPaise: true, cgstPaise: true, sgstPaise: true, taxPaise: true, roundOffPaise: true, totalPaise: true },
    }),
    prisma.invoice.findFirst({ where: invoiceWhere, orderBy: { issuedAt: "asc" }, select: { invoiceNumber: true } }),
    prisma.invoice.findFirst({ where: invoiceWhere, orderBy: { issuedAt: "desc" }, select: { invoiceNumber: true } }),
    prisma.$queryRaw<{ rate: number; taxable: number; cgst: number; sgst: number; tax: number }[]>`
      SELECT (e->>'rate')::float8 AS "rate",
             SUM((e->>'taxablePaise')::bigint)::float8 AS "taxable",
             SUM((e->>'cgstPaise')::bigint)::float8 AS "cgst",
             SUM((e->>'sgstPaise')::bigint)::float8 AS "sgst",
             SUM((e->>'taxPaise')::bigint)::float8 AS "tax"
      FROM "Invoice" i, jsonb_array_elements(i."taxBreakdown") e
      WHERE i."branchId" = ${branch.id}
        AND i."businessDate" BETWEEN ${range.from} AND ${range.to}
      GROUP BY 1
      ORDER BY 1
    `,
    prisma.$queryRaw<{ hsn: string | null; rate: number; quantity: number; taxable: number; tax: number }[]>`
      SELECT oi."hsn" AS "hsn", oi."gstRate"::float8 AS "rate",
             SUM(oi."quantity")::int AS "quantity",
             SUM(oi."lineSubtotal" - oi."discountAmount")::float8 AS "taxable",
             SUM(oi."taxAmount")::float8 AS "tax"
      FROM "OrderItem" oi
      JOIN "Order" o ON o."id" = oi."orderId"
      JOIN "Bill" b ON b."id" = o."billId"
      WHERE b."branchId" = ${branch.id}
        AND b."status" = 'SETTLED'
        AND b."businessDate" BETWEEN ${range.from} AND ${range.to}
        AND oi."status" <> 'VOID'
      GROUP BY 1, 2
      ORDER BY 1, 2
    `,
    prisma.creditNote.aggregate({
      where: invoiceWhere,
      _count: { _all: true },
      _sum: { creditAmountPaise: true, taxPaise: true },
    }),
    prisma.creditNote.groupBy({
      by: ["reasonCode"],
      where: invoiceWhere,
      _count: { _all: true },
      _sum: { creditAmountPaise: true },
    }),
    prisma.branch.findUnique({ where: { id: branch.id }, select: { gstin: true } }),
  ]);

  const taxable = (invoices._sum.subtotalPaise ?? 0) - (invoices._sum.discountPaise ?? 0);
  const creditTax = creditNotes._sum.taxPaise ?? 0;

  return {
    branch: { id: branch.id, name: branch.name, gstin: gstin?.gstin ?? null },
    ...range,
    supplyType: "B2C",
    invoices: {
      count: invoices._count._all,
      firstInvoiceNumber: first?.invoiceNumber ?? null,
      lastInvoiceNumber: last?.invoiceNumber ?? null,
      taxableValue: rupees(taxable),
      cgst: rupees(invoices._sum.cgstPaise),
      sgst: rupees(invoices._sum.sgstPaise),
      totalTax: rupees(invoices._sum.taxPaise),
      roundOff: rupees(invoices._sum.roundOffPaise),
      invoiceValue: rupees(invoices._sum.totalPaise),
    },
    rateWise: rates.map((row) => ({
      rate: row.rate,
      taxableValue: rupees(row.taxable),
      cgst: rupees(row.cgst),
      sgst: rupees(row.sgst),
      totalTax: rupees(row.tax),
    })),
    hsnSummary: hsn.map((row) => {
      const tax = roundMoney(row.tax);
      const cgst = roundMoney(tax / 2);

      return {
        hsn: row.hsn ?? "—",
        rate: row.rate,
        quantity: row.quantity,
        taxableValue: roundMoney(row.taxable),
        cgst,
        sgst: roundMoney(tax - cgst),
        totalTax: tax,
      };
    }),
    creditNotes: {
      count: creditNotes._count._all,
      amount: rupees(creditNotes._sum.creditAmountPaise),
      taxReversed: rupees(creditTax),
      byReason: creditReasons.map((row) => ({
        reason: row.reasonCode,
        count: row._count._all,
        amount: rupees(row._sum.creditAmountPaise),
      })),
    },
    netTaxPayable: rupees((invoices._sum.taxPaise ?? 0) - creditTax),
  };
}

/**
 * Discount report: how much was given, by reason, type and staff member,
 * and the biggest discounted bills.
 *
 * @param actor - The owner or manager.
 * @param branchId - The branch ID.
 * @param query - The business-date range.
 * @returns The discount report.
 */
export async function getDiscountReport(actor: ReportActor, branchId: string, query: ReportRangeQuery) {
  const branch = await getReportBranch(actor, branchId);
  const range = resolveRange(branch, query);
  const billWhere = settledBills(branch.id, range);
  const discountedWhere = { ...billWhere, discountPaise: { gt: 0 } };

  const [all, discounted, byReason, byType, byStaff, byApprover, bills] = await Promise.all([
    prisma.bill.aggregate({ where: billWhere, _count: { _all: true }, _sum: { subtotalPaise: true } }),
    prisma.bill.aggregate({ where: discountedWhere, _count: { _all: true }, _sum: { discountPaise: true } }),
    prisma.bill.groupBy({ by: ["discountReasonCode"], where: discountedWhere, _count: { _all: true }, _sum: { discountPaise: true } }),
    prisma.bill.groupBy({ by: ["discountType"], where: discountedWhere, _count: { _all: true }, _sum: { discountPaise: true } }),
    prisma.bill.groupBy({ by: ["discountAppliedById"], where: discountedWhere, _count: { _all: true }, _sum: { discountPaise: true } }),
    prisma.bill.groupBy({ by: ["discountApprovedById"], where: { ...discountedWhere, discountApprovedById: { not: null } }, _count: { _all: true }, _sum: { discountPaise: true } }),
    prisma.bill.findMany({
      where: discountedWhere,
      orderBy: { discountPaise: "desc" },
      take: DISCOUNT_BILLS_LIMIT,
      select: {
        id: true,
        billNumber: true,
        businessDate: true,
        subtotalPaise: true,
        discountPaise: true,
        totalPaise: true,
        discountType: true,
        discountValue: true,
        discountReasonCode: true,
        couponCode: true,
        table: { select: { name: true } },
        discountAppliedBy: { select: { id: true, name: true } },
        discountApprovedBy: { select: { id: true, name: true } },
      },
    }),
  ]);

  const userIds = [...byStaff.map((row) => row.discountAppliedById), ...byApprover.map((row) => row.discountApprovedById)];
  const users = await prisma.user.findMany({
    where: { id: { in: userIds.filter((id): id is string => id !== null) } },
    select: { id: true, name: true },
  });
  const nameById = new Map(users.map((user) => [user.id, user.name]));
  const totalDiscount = discounted._sum.discountPaise ?? 0;

  return {
    branch: { id: branch.id, name: branch.name },
    ...range,
    totals: {
      bills: all._count._all,
      discountedBills: discounted._count._all,
      discountedBillShare: percent(discounted._count._all, all._count._all),
      totalDiscount: rupees(totalDiscount),
      discountOfGrossSales: percent(totalDiscount, all._sum.subtotalPaise ?? 0),
    },
    byReason: byReason
      .map((row) => ({ reason: row.discountReasonCode ?? "No reason", bills: row._count._all, amount: rupees(row._sum.discountPaise) }))
      .sort((a, b) => b.amount - a.amount),
    byType: byType.map((row) => ({ type: row.discountType?.toLowerCase() ?? "item", bills: row._count._all, amount: rupees(row._sum.discountPaise) })),
    byStaff: byStaff
      .map((row) => ({
        userId: row.discountAppliedById,
        name: row.discountAppliedById ? (nameById.get(row.discountAppliedById) ?? "Unknown") : "Item discounts",
        bills: row._count._all,
        amount: rupees(row._sum.discountPaise),
      }))
      .sort((a, b) => b.amount - a.amount),
    byApprover: byApprover.map((row) => ({
      userId: row.discountApprovedById,
      name: nameById.get(row.discountApprovedById as string) ?? "Unknown",
      bills: row._count._all,
      amount: rupees(row._sum.discountPaise),
    })),
    bills: bills.map((bill) => ({
      billId: bill.id,
      billNumber: bill.billNumber,
      date: bill.businessDate,
      table: bill.table?.name ?? null,
      grossAmount: rupees(bill.subtotalPaise),
      discount: rupees(bill.discountPaise),
      discountPercent: percent(bill.discountPaise, bill.subtotalPaise),
      total: rupees(bill.totalPaise),
      type: bill.discountType?.toLowerCase() ?? null,
      value: bill.discountValue ? toNumber(bill.discountValue) : null,
      reason: bill.discountReasonCode,
      couponCode: bill.couponCode,
      appliedBy: bill.discountAppliedBy,
      approvedBy: bill.discountApprovedBy,
    })),
  };
}

/**
 * Void and cancellation report: items voided after going to the kitchen,
 * cancelled orders, cancelled bills and refunds, by reason and staff.
 *
 * @param actor - The owner or manager.
 * @param branchId - The branch ID.
 * @param query - The business-date range.
 * @returns The void report.
 */
export async function getVoidReport(actor: ReportActor, branchId: string, query: ReportRangeQuery) {
  const branch = await getReportBranch(actor, branchId);
  const range = resolveRange(branch, query);
  const dateRange = { gte: range.from, lte: range.to };
  const voidWhere = { status: "VOID" as const, order: { branchId: branch.id, businessDate: dateRange } };

  const [voidTotals, voidByReason, voidByStaff, voidItems, cancelledOrders, cancelledBills, refunds] = await Promise.all([
    prisma.orderItem.aggregate({ where: voidWhere, _count: { _all: true }, _sum: { quantity: true, lineSubtotal: true } }),
    prisma.orderItem.groupBy({ by: ["voidReason"], where: voidWhere, _count: { _all: true }, _sum: { lineSubtotal: true } }),
    prisma.orderItem.groupBy({ by: ["voidedById"], where: voidWhere, _count: { _all: true }, _sum: { lineSubtotal: true } }),
    prisma.orderItem.findMany({
      where: voidWhere,
      orderBy: { voidedAt: "desc" },
      take: VOID_LIST_LIMIT,
      select: {
        id: true,
        name: true,
        variantName: true,
        quantity: true,
        lineSubtotal: true,
        voidReason: true,
        voidedAt: true,
        voidedBy: { select: { id: true, name: true } },
        order: { select: { id: true, orderNumber: true, table: { select: { name: true } } } },
      },
    }),
    prisma.order.findMany({
      where: { branchId: branch.id, status: "CANCELLED", businessDate: dateRange },
      orderBy: { cancelledAt: "desc" },
      select: {
        id: true,
        orderNumber: true,
        totalAmount: true,
        cancelReason: true,
        cancelledAt: true,
        cancelledBy: { select: { id: true, name: true } },
        table: { select: { name: true } },
      },
    }),
    prisma.bill.findMany({
      where: { branchId: branch.id, status: "CANCELLED", businessDate: dateRange },
      orderBy: { cancelledAt: "desc" },
      select: {
        id: true,
        billNumber: true,
        totalPaise: true,
        cancelReason: true,
        cancelledAt: true,
        cancelledBy: { select: { id: true, name: true } },
      },
    }),
    prisma.creditNote.aggregate({
      where: { branchId: branch.id, businessDate: dateRange },
      _count: { _all: true },
      _sum: { creditAmountPaise: true },
    }),
  ]);

  const users = await prisma.user.findMany({
    where: { id: { in: voidByStaff.flatMap((row) => (row.voidedById ? [row.voidedById] : [])) } },
    select: { id: true, name: true },
  });
  const nameById = new Map(users.map((user) => [user.id, user.name]));

  /**
   * Counts cancellations per staff member.
   *
   * @param rows - Cancelled orders or bills.
   * @param value - Reads a row's value in rupees.
   * @returns One row per staff member.
   */
  const groupByCanceller = <T extends { cancelledBy: { id: string; name: string } | null }>(rows: T[], value: (row: T) => number) => {
    const map = new Map<string, { userId: string | null; name: string; count: number; value: number }>();

    for (const row of rows) {
      const key = row.cancelledBy?.id ?? "unknown";
      const entry = map.get(key) ?? { userId: row.cancelledBy?.id ?? null, name: row.cancelledBy?.name ?? "Unknown", count: 0, value: 0 };
      entry.count += 1;
      entry.value = roundMoney(entry.value + value(row));
      map.set(key, entry);
    }

    return [...map.values()].sort((a, b) => b.value - a.value);
  };

  return {
    branch: { id: branch.id, name: branch.name },
    ...range,
    voidedItems: {
      lines: voidTotals._count._all,
      quantity: voidTotals._sum.quantity ?? 0,
      value: roundMoney(toNumber(voidTotals._sum.lineSubtotal)),
      byReason: voidByReason
        .map((row) => ({ reason: row.voidReason ?? "No reason", lines: row._count._all, value: roundMoney(toNumber(row._sum.lineSubtotal)) }))
        .sort((a, b) => b.value - a.value),
      byStaff: voidByStaff
        .map((row) => ({
          userId: row.voidedById,
          name: row.voidedById ? (nameById.get(row.voidedById) ?? "Unknown") : "Unknown",
          lines: row._count._all,
          value: roundMoney(toNumber(row._sum.lineSubtotal)),
        }))
        .sort((a, b) => b.value - a.value),
      items: voidItems.map((item) => ({
        orderItemId: item.id,
        name: item.variantName ? `${item.name} (${item.variantName})` : item.name,
        quantity: item.quantity,
        value: toNumber(item.lineSubtotal),
        reason: item.voidReason,
        voidedAt: item.voidedAt,
        voidedBy: item.voidedBy,
        orderNumber: item.order.orderNumber,
        table: item.order.table?.name ?? null,
      })),
    },
    cancelledOrders: {
      count: cancelledOrders.length,
      value: roundMoney(cancelledOrders.reduce((sum, order) => sum + toNumber(order.totalAmount), 0)),
      byStaff: groupByCanceller(cancelledOrders, (order) => toNumber(order.totalAmount)),
      orders: cancelledOrders.slice(0, VOID_LIST_LIMIT).map((order) => ({
        orderId: order.id,
        orderNumber: order.orderNumber,
        table: order.table?.name ?? null,
        value: toNumber(order.totalAmount),
        reason: order.cancelReason,
        cancelledAt: order.cancelledAt,
        cancelledBy: order.cancelledBy,
      })),
    },
    cancelledBills: {
      count: cancelledBills.length,
      value: rupees(cancelledBills.reduce((sum, bill) => sum + bill.totalPaise, 0)),
      byStaff: groupByCanceller(cancelledBills, (bill) => rupees(bill.totalPaise)),
      bills: cancelledBills.slice(0, VOID_LIST_LIMIT).map((bill) => ({
        billId: bill.id,
        billNumber: bill.billNumber,
        value: rupees(bill.totalPaise),
        reason: bill.cancelReason,
        cancelledAt: bill.cancelledAt,
        cancelledBy: bill.cancelledBy,
      })),
    },
    refunds: { creditNotes: refunds._count._all, amount: rupees(refunds._sum.creditAmountPaise) },
  };
}

/**
 * Staff performance: per person, orders taken and their value, average
 * order value, bills created, money collected by method, discounts given,
 * items voided and orders cancelled. QR menu orders appear as "QR menu".
 *
 * @param actor - The owner or manager.
 * @param branchId - The branch ID.
 * @param query - The business-date range.
 * @returns One row per staff member, highest sales first.
 */
export async function getStaffReport(actor: ReportActor, branchId: string, query: ReportRangeQuery) {
  const branch = await getReportBranch(actor, branchId);
  const range = resolveRange(branch, query);
  const billWhere = settledBills(branch.id, range);
  const dateRange = { gte: range.from, lte: range.to };

  const [orders, bills, payments, discounts, voids, cancellations] = await Promise.all([
    prisma.order.groupBy({
      by: ["createdById"],
      where: { status: { not: "CANCELLED" }, bill: billWhere },
      _count: { _all: true },
      _sum: { totalAmount: true },
    }),
    prisma.bill.groupBy({ by: ["createdById"], where: billWhere, _count: { _all: true } }),
    prisma.billPayment.groupBy({
      by: ["receivedById", "method"],
      where: { bill: billWhere },
      _sum: { amountPaise: true },
    }),
    prisma.bill.groupBy({
      by: ["discountAppliedById"],
      where: { ...billWhere, discountPaise: { gt: 0 }, discountAppliedById: { not: null } },
      _count: { _all: true },
      _sum: { discountPaise: true },
    }),
    prisma.orderItem.groupBy({
      by: ["voidedById"],
      where: { status: "VOID", voidedById: { not: null }, order: { branchId: branch.id, businessDate: dateRange } },
      _count: { _all: true },
      _sum: { lineSubtotal: true },
    }),
    prisma.order.groupBy({
      by: ["cancelledById"],
      where: { branchId: branch.id, status: "CANCELLED", businessDate: dateRange, cancelledById: { not: null } },
      _count: { _all: true },
    }),
  ]);

  type StaffRow = {
    userId: string | null;
    name: string;
    ordersTaken: number;
    salesValue: number;
    averageOrderValue: number;
    billsCreated: number;
    collected: { cash: number; upi: number; card: number; total: number };
    discounts: { bills: number; amount: number };
    voids: { lines: number; value: number };
    ordersCancelled: number;
  };

  const rows = new Map<string, StaffRow>();

  /**
   * Gets (or starts) the row for a staff member.
   *
   * @param userId - The user ID, or null for QR menu orders.
   * @returns The row.
   */
  const rowFor = (userId: string | null): StaffRow => {
    const key = userId ?? "qr";
    let row = rows.get(key);

    if (!row) {
      row = {
        userId,
        name: userId ? "" : QR_MENU_STAFF_LABEL,
        ordersTaken: 0,
        salesValue: 0,
        averageOrderValue: 0,
        billsCreated: 0,
        collected: { cash: 0, upi: 0, card: 0, total: 0 },
        discounts: { bills: 0, amount: 0 },
        voids: { lines: 0, value: 0 },
        ordersCancelled: 0,
      };
      rows.set(key, row);
    }

    return row;
  };

  for (const entry of orders) {
    const row = rowFor(entry.createdById);
    row.ordersTaken = entry._count._all;
    row.salesValue = roundMoney(toNumber(entry._sum.totalAmount));
  }

  for (const entry of bills) {
    rowFor(entry.createdById).billsCreated = entry._count._all;
  }

  for (const entry of payments) {
    const row = rowFor(entry.receivedById);
    const amount = rupees(entry._sum.amountPaise);
    const method = entry.method.toLowerCase() as "cash" | "upi" | "card";

    row.collected[method] = roundMoney(row.collected[method] + amount);
    row.collected.total = roundMoney(row.collected.total + amount);
  }

  for (const entry of discounts) {
    rowFor(entry.discountAppliedById).discounts = { bills: entry._count._all, amount: rupees(entry._sum.discountPaise) };
  }

  for (const entry of voids) {
    rowFor(entry.voidedById).voids = { lines: entry._count._all, value: roundMoney(toNumber(entry._sum.lineSubtotal)) };
  }

  for (const entry of cancellations) {
    rowFor(entry.cancelledById).ordersCancelled = entry._count._all;
  }

  const users = await prisma.user.findMany({
    where: { id: { in: [...rows.values()].flatMap((row) => (row.userId ? [row.userId] : [])) } },
    select: { id: true, name: true, role: true },
  });
  const userById = new Map(users.map((user) => [user.id, user]));

  return {
    branch: { id: branch.id, name: branch.name },
    ...range,
    staff: [...rows.values()]
      .map((row) => {
        const user = row.userId ? userById.get(row.userId) : undefined;

        return {
          ...row,
          name: user?.name ?? (row.name || "Unknown"),
          role: user?.role ?? null,
          averageOrderValue: row.ordersTaken > 0 ? roundMoney(row.salesValue / row.ordersTaken) : 0,
        };
      })
      .sort((a, b) => b.salesValue - a.salesValue),
  };
}

/**
 * Branch comparison for the owner's master dashboard: each accessible
 * branch's sales, bills, average bill and payment split, plus totals.
 * Without dates, each branch shows its own current business day.
 *
 * @param actor - The owner or manager.
 * @param query - The business-date range.
 * @returns One row per branch and the combined totals.
 */
export async function getBranchComparison(actor: ReportActor, query: ReportRangeQuery) {
  const branches = await prisma.branch.findMany({
    where: { id: { in: actor.branchIds }, organizationId: actor.organizationId, status: "active" },
    orderBy: { name: "asc" },
    select: { id: true, name: true, timezone: true, businessDayCutoff: true },
  });

  const rows = await Promise.all(
    branches.map(async (branch) => {
      const range = resolveRange(branch, query);
      const [totals, payments] = await Promise.all([getSalesTotals(branch.id, range), getPaymentSplit(branch.id, range)]);

      return {
        branchId: branch.id,
        name: branch.name,
        ...range,
        bills: totals.bills,
        netSales: totals.netSales,
        totalSales: totals.totalSales,
        averageBillValue: totals.averageBillValue,
        discounts: totals.discounts,
        refunds: totals.refunds.amount,
        payments: Object.fromEntries(payments.map((row) => [row.method, row.amount])),
      };
    }),
  );

  const totalSales = roundMoney(rows.reduce((sum, row) => sum + row.totalSales, 0));
  const bills = rows.reduce((sum, row) => sum + row.bills, 0);

  return {
    branches: rows.map((row) => ({ ...row, share: percent(row.totalSales, totalSales) })).sort((a, b) => b.totalSales - a.totalSales),
    totals: {
      branches: rows.length,
      bills,
      netSales: roundMoney(rows.reduce((sum, row) => sum + row.netSales, 0)),
      totalSales,
      averageBillValue: bills > 0 ? roundMoney(totalSales / bills) : 0,
      discounts: roundMoney(rows.reduce((sum, row) => sum + row.discounts, 0)),
      refunds: roundMoney(rows.reduce((sum, row) => sum + row.refunds, 0)),
    },
  };
}

/**
 * Checks whether an unknown value is a report service error.
 *
 * @param error - The unknown value to validate.
 * @returns True if the value is a ReportServiceError with a known code.
 */
export function isReportServiceError(error: unknown): error is ReportServiceError {
  return (
    error instanceof ReportServiceError &&
    Object.values(ReportServiceErrorCode).includes(error.code)
  );
}
