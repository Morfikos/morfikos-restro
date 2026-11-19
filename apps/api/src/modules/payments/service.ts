import { randomInt } from "node:crypto";

import QRCode from "qrcode";

import { createPrismaClient } from "@morfikos/database";
import { PaymentServiceErrorCode, type UserRole } from "@morfikos/auth";
import type {
  ConfirmPaymentRequestInput,
  CreateGuestPaymentInput,
  CreatePaymentRequestInput,
  ListPaymentRequestsQuery,
  SubmitGuestPaymentInput,
  UpdatePaymentSettingsInput,
} from "@morfikos/validation";

import { isPrismaUniqueConstraintError } from "../../utils/prisma-errors.js";
import { recordPaymentsInTx } from "../billing/service.js";
import { BillStatus, PaymentMethod } from "../billing/constants.js";
import { publishKitchenEvent } from "../kitchen/events.js";
import { getLiveSession } from "../qr/service.js";
import {
  CONFIRMABLE_PAYMENT_STATUSES,
  DEFAULT_PAYMENT_SETTINGS,
  OPEN_PAYMENT_STATUSES,
  PAYMENT_STATUS_FROM_API,
  PaymentEventName,
  PaymentRequestSource,
  PaymentRequestStatus,
  REFERENCE_ALPHABET,
  REFERENCE_SUFFIX_LENGTH,
} from "./constants.js";

const prisma = createPrismaClient();

/** The Prisma client available inside an interactive transaction. */
type TransactionClient = Omit<
  typeof prisma,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends"
>;

/**
 * The authenticated staff member handling payments.
 */
export interface PaymentActor {
  userId: string;
  role: UserRole;
  organizationId: string;
  branchIds: string[];
}

/**
 * Represents errors that can occur during UPI payment operations.
 */
export class PaymentServiceError extends Error {
  /**
   * Creates a payment service error.
   *
   * @param code - The standardized error code.
   * @param message - A description of the error.
   */
  constructor(
    public readonly code: PaymentServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PaymentServiceError";
  }
}

type PaymentSettingsValues = {
  upiEnabled: boolean;
  upiVpa: string | null;
  payeeName: string | null;
  merchantCode: string | null;
  guestPaymentsEnabled: boolean;
  requestExpiryMinutes: number;
};

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Formats paise as rupees for messages.
 *
 * @param paise - The amount in paise.
 * @returns e.g. "₹1,234.50".
 */
function formatRupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Throws unless the staff member can access the branch.
 *
 * @param actor - The staff member.
 * @param branchId - The branch ID.
 * @throws PaymentServiceError If the branch is not accessible.
 */
function assertBranchAccess(actor: PaymentActor, branchId: string): void {
  if (!actor.branchIds.includes(branchId)) {
    throw new PaymentServiceError(PaymentServiceErrorCode.BRANCH_ACCESS_DENIED, "Access denied for this branch");
  }
}

/**
 * Loads a branch's payment settings, falling back to the defaults.
 *
 * @param client - The Prisma client or transaction client.
 * @param branchId - The branch ID.
 * @returns The settings.
 */
async function getSettings(client: TransactionClient, branchId: string): Promise<PaymentSettingsValues> {
  const settings = await client.paymentSettings.findUnique({
    where: { branchId },
    select: {
      upiEnabled: true,
      upiVpa: true,
      payeeName: true,
      merchantCode: true,
      guestPaymentsEnabled: true,
      requestExpiryMinutes: true,
    },
  });

  return settings ?? { ...DEFAULT_PAYMENT_SETTINGS };
}

/**
 * Throws unless the branch has UPI switched on with a UPI ID.
 *
 * @param settings - The branch's payment settings.
 * @returns The UPI ID.
 * @throws PaymentServiceError If UPI isn't set up.
 */
function assertUpiReady(settings: PaymentSettingsValues): string {
  if (!settings.upiEnabled || !settings.upiVpa) {
    throw new PaymentServiceError(
      PaymentServiceErrorCode.UPI_NOT_CONFIGURED,
      "UPI payments aren't set up for this branch. Add the UPI ID in payment settings.",
    );
  }

  return settings.upiVpa;
}

/**
 * Builds the UPI deep link (NPCI format) that GPay, PhonePe, Paytm and
 * BHIM open with the amount filled in. `tr`/`mc` are added only for
 * merchant UPI IDs: personal UPI IDs can fail with them.
 *
 * @param settings - The payee's UPI details.
 * @param amountPaise - The amount.
 * @param reference - The payment reference.
 * @param note - Text shown to the payer.
 * @returns The `upi://pay?...` link.
 */
function buildUpiUri(
  settings: PaymentSettingsValues & { upiVpa: string },
  amountPaise: number,
  reference: string,
  note: string,
): string {
  const params = new URLSearchParams({
    pa: settings.upiVpa,
    pn: settings.payeeName ?? "Restaurant",
    am: (amountPaise / 100).toFixed(2),
    cu: "INR",
    tn: note.slice(0, 50),
  });

  if (settings.merchantCode) {
    params.set("tr", reference);
    params.set("mc", settings.merchantCode);
  }

  // URLSearchParams encodes spaces as "+", which some UPI apps show literally.
  return `upi://pay?${params.toString().replace(/\+/g, "%20")}`;
}

/**
 * Builds a short, readable payment reference for the UPI note, e.g. "B18-K7Q2".
 *
 * @param billNumber - The bill number.
 * @returns The reference.
 */
function generateReference(billNumber: number): string {
  let suffix = "";

  for (let index = 0; index < REFERENCE_SUFFIX_LENGTH; index += 1) {
    suffix += REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)];
  }

  return `B${billNumber}-${suffix}`;
}

/**
 * Marks QRs that ran out of time as expired. Submitted ones stay (the
 * guest says they paid; staff must check).
 *
 * @param where - Which requests to check.
 */
async function expireStale(where: { branchId?: string; billId?: string; id?: string }): Promise<void> {
  await prisma.paymentRequest.updateMany({
    where: { ...where, status: PaymentRequestStatus.PENDING, expiresAt: { lt: new Date() } },
    data: { status: PaymentRequestStatus.EXPIRED },
  });
}

/**
 * Sends a payment event to the branch's live POS screens.
 *
 * @param branchId - The branch ID.
 * @param event - The event name.
 * @param data - The event payload.
 */
function publishPaymentEvent(branchId: string, event: PaymentEventName, data: unknown): void {
  publishKitchenEvent(branchId, { event, data });
}

/** Fields of a payment request used in responses. */
const requestSelect = {
  id: true,
  branchId: true,
  billId: true,
  splitPartId: true,
  sessionId: true,
  reference: true,
  amountPaise: true,
  upiUri: true,
  status: true,
  source: true,
  utr: true,
  payerName: true,
  submittedAt: true,
  expiresAt: true,
  confirmedAt: true,
  billPaymentId: true,
  rejectReason: true,
  createdAt: true,
  confirmedBy: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  bill: { select: { billNumber: true, table: { select: { name: true } } } },
} as const;

type RequestRecord = {
  id: string;
  branchId: string;
  billId: string;
  splitPartId: string | null;
  sessionId: string | null;
  reference: string;
  amountPaise: number;
  upiUri: string;
  status: string;
  source: string;
  utr: string | null;
  payerName: string | null;
  submittedAt: Date | null;
  expiresAt: Date;
  confirmedAt: Date | null;
  billPaymentId: string | null;
  rejectReason: string | null;
  createdAt: Date;
  confirmedBy: { id: string; name: string } | null;
  createdBy: { id: string; name: string } | null;
  bill: { billNumber: number; table: { name: string } | null };
};

/**
 * Serializes a payment request, optionally with its QR images.
 *
 * @param request - The request.
 * @param withQr - Include the QR as SVG and PNG data URL.
 * @returns The request view.
 */
async function serializeRequest(request: RequestRecord, withQr: boolean) {
  const [partNumber, qr] = await Promise.all([
    request.splitPartId
      ? prisma.billSplitPart.findUnique({ where: { id: request.splitPartId }, select: { partNumber: true, label: true } })
      : Promise.resolve(null),
    withQr && OPEN_PAYMENT_STATUSES.includes(request.status as PaymentRequestStatus)
      ? Promise.all([
          QRCode.toString(request.upiUri, { type: "svg", margin: 1, errorCorrectionLevel: "M" }),
          QRCode.toDataURL(request.upiUri, { margin: 1, width: 360, errorCorrectionLevel: "M" }),
        ])
      : Promise.resolve(null),
  ]);

  const { bill, splitPartId, ...data } = request;

  return {
    ...data,
    status: request.status.toLowerCase(),
    source: request.source.toLowerCase(),
    billNumber: bill.billNumber,
    tableName: bill.table?.name ?? null,
    part: partNumber ? { partNumber: partNumber.partNumber, label: partNumber.label } : null,
    ...(qr && { qrSvg: qr[0], qrDataUrl: qr[1] }),
  };
}

/**
 * Works out what can be paid on a bill (or one of its split parts).
 *
 * @param client - The Prisma client or transaction client.
 * @param billId - The bill ID.
 * @param partNumber - The split part, when the bill is split.
 * @returns The bill number, the part (if any) and the amount due.
 * @throws PaymentServiceError If the bill isn't open, a part is needed or nothing is due.
 */
async function getPayable(client: TransactionClient, billId: string, partNumber: number | undefined) {
  const bill = await client.bill.findUniqueOrThrow({
    where: { id: billId },
    select: {
      id: true,
      billNumber: true,
      status: true,
      totalPaise: true,
      paidPaise: true,
      splitMode: true,
      splitParts: {
        where: partNumber !== undefined ? { partNumber } : { id: "none" },
        select: { id: true, partNumber: true, label: true, amountPaise: true, paidPaise: true },
      },
    },
  });

  if (bill.status !== BillStatus.OPEN) {
    throw new PaymentServiceError(
      PaymentServiceErrorCode.BILL_NOT_OPEN,
      bill.status === BillStatus.SETTLED ? "This bill is already paid" : "This bill is cancelled",
    );
  }

  if (bill.splitMode && partNumber === undefined) {
    throw new PaymentServiceError(PaymentServiceErrorCode.SPLIT_PART_REQUIRED, "This bill is split. Choose which part to pay.");
  }

  if (!bill.splitMode && partNumber !== undefined) {
    throw new PaymentServiceError(PaymentServiceErrorCode.SPLIT_PART_NOT_FOUND, "This bill isn't split");
  }

  const part = bill.splitParts[0] ?? null;

  if (partNumber !== undefined && !part) {
    throw new PaymentServiceError(PaymentServiceErrorCode.SPLIT_PART_NOT_FOUND, `Part ${partNumber} not found on this bill`);
  }

  const duePaise = part ? part.amountPaise - part.paidPaise : bill.totalPaise - bill.paidPaise;

  if (duePaise <= 0) {
    throw new PaymentServiceError(PaymentServiceErrorCode.NOTHING_DUE, part ? `${part.label ?? `Part ${part.partNumber}`} is already paid` : "Nothing is due on this bill");
  }

  return { bill, part, duePaise };
}

/**
 * Creates (or reuses) a dynamic UPI QR for a bill or split part. An open
 * QR for the same amount is reused; other waiting QRs for it are
 * cancelled so only one is live.
 *
 * @param tx - The transaction client.
 * @param data - The bill, part, amount, source and creator.
 * @returns The request ID and whether it is new.
 * @throws PaymentServiceError If UPI isn't set up or the amount is wrong.
 */
async function createRequestInTx(
  tx: TransactionClient,
  data: {
    organizationId: string;
    branchId: string;
    billId: string;
    partNumber: number | undefined;
    amountPaise: number | undefined;
    source: PaymentRequestSource;
    sessionId: string | null;
    createdById: string | null;
  },
): Promise<{ id: string; created: boolean }> {
  const settings = await getSettings(tx, data.branchId);
  const vpa = assertUpiReady(settings);
  const { bill, part, duePaise } = await getPayable(tx, data.billId, data.partNumber);
  const amountPaise = data.amountPaise ?? duePaise;

  if (amountPaise > duePaise) {
    throw new PaymentServiceError(
      PaymentServiceErrorCode.AMOUNT_EXCEEDS_DUE,
      `${formatRupees(amountPaise)} is more than the ${formatRupees(duePaise)} due`,
    );
  }

  const now = new Date();
  const existing = await tx.paymentRequest.findFirst({
    where: {
      billId: bill.id,
      splitPartId: part?.id ?? null,
      status: PaymentRequestStatus.PENDING,
      amountPaise,
      expiresAt: { gt: now },
    },
    select: { id: true },
  });

  if (existing) {
    return { id: existing.id, created: false };
  }

  await tx.paymentRequest.updateMany({
    where: { billId: bill.id, splitPartId: part?.id ?? null, status: PaymentRequestStatus.PENDING },
    data: { status: PaymentRequestStatus.CANCELLED },
  });

  const reference = generateReference(bill.billNumber);
  const note = part ? `Bill ${bill.billNumber} ${part.label ?? `part ${part.partNumber}`} ${reference}` : `Bill ${bill.billNumber} ${reference}`;

  const request = await tx.paymentRequest.create({
    data: {
      organizationId: data.organizationId,
      branchId: data.branchId,
      billId: bill.id,
      splitPartId: part?.id ?? null,
      sessionId: data.sessionId,
      reference,
      amountPaise,
      upiUri: buildUpiUri({ ...settings, upiVpa: vpa }, amountPaise, reference, note),
      source: data.source,
      expiresAt: new Date(now.getTime() + settings.requestExpiryMinutes * 60_000),
      createdById: data.createdById,
    },
    select: { id: true },
  });

  return { id: request.id, created: true };
}

/**
 * Loads a request with its full view fields.
 *
 * @param requestId - The request ID.
 * @returns The request.
 */
async function loadRequest(requestId: string): Promise<RequestRecord> {
  return prisma.paymentRequest.findUniqueOrThrow({ where: { id: requestId }, select: requestSelect });
}

/**
 * Loads a request of the staff member's branches.
 *
 * @param actor - The staff member.
 * @param requestId - The request ID.
 * @returns The request, or null if not found.
 */
async function findStaffRequest(actor: PaymentActor, requestId: string) {
  await expireStale({ id: requestId });

  return prisma.paymentRequest.findFirst({
    where: { id: requestId, organizationId: actor.organizationId, branchId: { in: actor.branchIds } },
    select: requestSelect,
  });
}

// ─── Settings ───────────────────────────────────────────────────────────

/**
 * Retrieves a branch's UPI payment settings.
 *
 * @param actor - The staff member.
 * @param branchId - The branch ID.
 * @returns The settings.
 */
export async function getPaymentSettings(actor: PaymentActor, branchId: string) {
  assertBranchAccess(actor, branchId);

  return { branchId, ...(await getSettings(prisma, branchId)) };
}

/**
 * Updates a branch's UPI payment settings. UPI can only be switched on
 * with a UPI ID.
 *
 * @param actor - The owner or manager.
 * @param branchId - The branch ID.
 * @param input - The settings to change.
 * @returns The updated settings.
 * @throws PaymentServiceError If the branch isn't found or UPI is switched on without a UPI ID.
 */
export async function updatePaymentSettings(actor: PaymentActor, branchId: string, input: UpdatePaymentSettingsInput) {
  assertBranchAccess(actor, branchId);

  const branch = await prisma.branch.findFirst({
    where: { id: branchId, organizationId: actor.organizationId },
    select: { id: true, name: true },
  });

  if (!branch) {
    throw new PaymentServiceError(PaymentServiceErrorCode.BRANCH_NOT_FOUND, "Branch not found");
  }

  const current = await getSettings(prisma, branch.id);
  const next = { ...current, ...input };

  if (next.upiEnabled && !next.upiVpa) {
    throw new PaymentServiceError(PaymentServiceErrorCode.UPI_NOT_CONFIGURED, "Add a UPI ID before switching UPI on");
  }

  return prisma.paymentSettings.upsert({
    where: { branchId: branch.id },
    create: { branchId: branch.id, ...input, payeeName: input.payeeName ?? branch.name },
    update: input,
    select: {
      branchId: true,
      upiEnabled: true,
      upiVpa: true,
      payeeName: true,
      merchantCode: true,
      guestPaymentsEnabled: true,
      requestExpiryMinutes: true,
      updatedAt: true,
    },
  });
}

// ─── Staff payment requests ─────────────────────────────────────────────

/**
 * Creates a dynamic UPI QR for a bill (or one split part) to show on the
 * POS or print. The guest scans it with any UPI app; the amount is filled
 * in and the money goes straight to the restaurant's account.
 *
 * @param actor - The staff member.
 * @param branchId - The branch ID.
 * @param billId - The bill ID.
 * @param input - Optional split part and amount (defaults to what's due).
 * @returns The request with its QR, and whether it is new.
 * @throws PaymentServiceError If the bill isn't found, UPI isn't set up or the amount is wrong.
 */
export async function createPaymentRequest(
  actor: PaymentActor,
  branchId: string,
  billId: string,
  input: CreatePaymentRequestInput,
) {
  assertBranchAccess(actor, branchId);

  const bill = await prisma.bill.findFirst({
    where: { id: billId, branchId, organizationId: actor.organizationId },
    select: { id: true },
  });

  if (!bill) {
    throw new PaymentServiceError(PaymentServiceErrorCode.BILL_NOT_FOUND, "Bill not found");
  }

  const result = await runWithReferenceRetry(() =>
    prisma.$transaction((tx) =>
      createRequestInTx(tx, {
        organizationId: actor.organizationId,
        branchId,
        billId: bill.id,
        partNumber: input.partNumber,
        amountPaise: input.amountPaise,
        source: PaymentRequestSource.STAFF,
        sessionId: null,
        createdById: actor.userId,
      }),
    ),
  );

  const request = await serializeRequest(await loadRequest(result.id), true);

  if (result.created) {
    publishPaymentEvent(branchId, PaymentEventName.REQUESTED, {
      requestId: request.id,
      billNumber: request.billNumber,
      tableName: request.tableName,
      amountPaise: request.amountPaise,
    });
  }

  return { created: result.created, request };
}

/**
 * Retries work once more when a random payment reference collided.
 *
 * @param work - The work creating a request.
 * @returns The work's result.
 */
async function runWithReferenceRetry<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (error: unknown) {
      if (attempt < 3 && isPrismaUniqueConstraintError(error)) {
        continue;
      }

      throw error;
    }
  }
}

/**
 * Lists a branch's UPI payment requests, newest first.
 *
 * @param actor - The staff member.
 * @param branchId - The branch ID.
 * @param query - Status, bill, open-only and pagination.
 * @returns The requests and pagination metadata.
 */
export async function listPaymentRequests(actor: PaymentActor, branchId: string, query: ListPaymentRequestsQuery) {
  assertBranchAccess(actor, branchId);
  await expireStale({ branchId });

  const where = {
    branchId,
    organizationId: actor.organizationId,
    ...(query.billId !== undefined && { billId: query.billId }),
    ...(query.status !== undefined
      ? { status: PAYMENT_STATUS_FROM_API[query.status] }
      : query.open
        ? { status: { in: OPEN_PAYMENT_STATUSES } }
        : {}),
  };

  const [requests, total] = await Promise.all([
    prisma.paymentRequest.findMany({
      where,
      // Guests who said they paid come first: staff must check those.
      orderBy: [{ submittedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      take: query.limit,
      skip: query.offset,
      select: requestSelect,
    }),
    prisma.paymentRequest.count({ where }),
  ]);

  return {
    total,
    limit: query.limit,
    offset: query.offset,
    requests: await Promise.all(requests.map((request) => serializeRequest(request, false))),
  };
}

/**
 * Retrieves a payment request with its QR (the POS polls this for status).
 *
 * @param actor - The staff member.
 * @param requestId - The request ID.
 * @returns The request, or null if not found.
 */
export async function getPaymentRequest(actor: PaymentActor, requestId: string) {
  const request = await findStaffRequest(actor, requestId);

  return request ? serializeRequest(request, true) : null;
}

/**
 * Confirms the money arrived (checked in the UPI app or bank SMS): records
 * a UPI payment on the bill (or split part) with the UTR as reference.
 * When the bill is fully paid it settles and its GST invoice is issued.
 *
 * @param actor - The cashier.
 * @param requestId - The request ID.
 * @param input - Optional UTR and amount actually received.
 * @returns The confirmed request and the bill's status, or null if not found.
 * @throws PaymentServiceError If it's already closed or the UTR was used before.
 */
export async function confirmPaymentRequest(actor: PaymentActor, requestId: string, input: ConfirmPaymentRequestInput) {
  const request = await findStaffRequest(actor, requestId);

  if (!request) {
    return null;
  }

  if (!CONFIRMABLE_PAYMENT_STATUSES.includes(request.status as PaymentRequestStatus)) {
    throw new PaymentServiceError(
      PaymentServiceErrorCode.PAYMENT_REQUEST_CLOSED,
      `This payment request is already ${request.status.toLowerCase()}`,
    );
  }

  const utr = input.utr ?? request.utr;
  const amountPaise = input.amountPaise ?? request.amountPaise;

  await prisma.$transaction(async (tx) => {
    if (utr) {
      const reused = await tx.paymentRequest.findFirst({
        where: {
          organizationId: actor.organizationId,
          utr,
          status: PaymentRequestStatus.CONFIRMED,
          id: { not: request.id },
        },
        select: { reference: true },
      });

      if (reused) {
        throw new PaymentServiceError(
          PaymentServiceErrorCode.DUPLICATE_UTR,
          `UTR ${utr} was already used for payment ${reused.reference}`,
        );
      }
    }

    // Claim it so two cashiers can't record the same money twice.
    const claimed = await tx.paymentRequest.updateMany({
      where: { id: request.id, status: { in: CONFIRMABLE_PAYMENT_STATUSES } },
      data: { status: PaymentRequestStatus.CONFIRMED, confirmedAt: new Date(), confirmedById: actor.userId, utr },
    });

    if (claimed.count === 0) {
      throw new PaymentServiceError(PaymentServiceErrorCode.PAYMENT_REQUEST_CLOSED, "This payment was already handled");
    }

    const [payment] = await recordPaymentsInTx(
      tx,
      actor,
      request.billId,
      [
        {
          method: PaymentMethod.UPI,
          amountPaise,
          reference: utr ?? request.reference,
          idempotencyKey: `upi:${request.id}`,
        },
      ],
      request.splitPartId ?? undefined,
    );

    await tx.paymentRequest.update({ where: { id: request.id }, data: { billPaymentId: payment!.id } });
  });

  const [confirmed, bill] = await Promise.all([
    loadRequest(request.id),
    prisma.bill.findUniqueOrThrow({
      where: { id: request.billId },
      select: { status: true, totalPaise: true, paidPaise: true, invoice: { select: { id: true, invoiceNumber: true } } },
    }),
  ]);

  publishPaymentEvent(request.branchId, PaymentEventName.CONFIRMED, {
    requestId: request.id,
    billNumber: request.bill.billNumber,
    amountPaise,
    billSettled: bill.status === BillStatus.SETTLED,
  });

  return {
    request: await serializeRequest(confirmed, false),
    bill: {
      status: bill.status.toLowerCase(),
      totalPaise: bill.totalPaise,
      paidPaise: bill.paidPaise,
      remainingPaise: Math.max(bill.totalPaise - bill.paidPaise, 0),
      invoice: bill.invoice,
    },
  };
}

/**
 * Rejects a payment request (e.g. the UTR doesn't match any money received).
 *
 * @param actor - The cashier.
 * @param requestId - The request ID.
 * @param reason - Why it was rejected (the guest sees it).
 * @returns The request, or null if not found.
 * @throws PaymentServiceError If it's already closed.
 */
export async function rejectPaymentRequest(actor: PaymentActor, requestId: string, reason: string) {
  const request = await findStaffRequest(actor, requestId);

  if (!request) {
    return null;
  }

  const updated = await prisma.paymentRequest.updateMany({
    where: { id: request.id, status: { in: OPEN_PAYMENT_STATUSES } },
    data: { status: PaymentRequestStatus.REJECTED, rejectReason: reason, confirmedById: actor.userId },
  });

  if (updated.count === 0) {
    throw new PaymentServiceError(PaymentServiceErrorCode.PAYMENT_REQUEST_CLOSED, `This payment request is already ${request.status.toLowerCase()}`);
  }

  publishPaymentEvent(request.branchId, PaymentEventName.REJECTED, { requestId: request.id, billNumber: request.bill.billNumber, reason });

  return serializeRequest(await loadRequest(request.id), false);
}

/**
 * Cancels a waiting QR (e.g. the guest paid by cash instead).
 *
 * @param actor - The staff member.
 * @param requestId - The request ID.
 * @returns The request, or null if not found.
 * @throws PaymentServiceError If it isn't pending.
 */
export async function cancelPaymentRequest(actor: PaymentActor, requestId: string) {
  const request = await findStaffRequest(actor, requestId);

  if (!request) {
    return null;
  }

  const updated = await prisma.paymentRequest.updateMany({
    where: { id: request.id, status: PaymentRequestStatus.PENDING },
    data: { status: PaymentRequestStatus.CANCELLED },
  });

  if (updated.count === 0) {
    throw new PaymentServiceError(
      PaymentServiceErrorCode.PAYMENT_REQUEST_CLOSED,
      request.status === PaymentRequestStatus.SUBMITTED
        ? "The guest says they paid. Confirm or reject it instead."
        : `This payment request is already ${request.status.toLowerCase()}`,
    );
  }

  return serializeRequest(await loadRequest(request.id), false);
}

// ─── Guest (QR session) ─────────────────────────────────────────────────

/**
 * Finds the open bill of a guest's table session.
 *
 * @param token - The session token.
 * @returns The session and its bill (or null when not billed yet).
 */
async function getSessionBill(token: string) {
  const session = await getLiveSession(token);
  const order = session.orderId
    ? await prisma.order.findUnique({ where: { id: session.orderId }, select: { billId: true } })
    : null;

  return { session, billId: order?.billId ?? null };
}

/**
 * The guest's bill from the table QR: totals, what's paid and due, the
 * split parts (if split), whether UPI pay is available, and their payment
 * requests.
 *
 * @param token - The session token.
 * @returns The bill view (bill is null until the staff prints it).
 */
export async function getGuestBill(token: string) {
  const { session, billId } = await getSessionBill(token);
  const settings = await getSettings(prisma, session.branchId);
  const canPayByUpi = settings.upiEnabled && Boolean(settings.upiVpa) && settings.guestPaymentsEnabled;

  if (!billId) {
    return { bill: null, canPayByUpi, message: "Your bill isn't ready yet. Tap “Ask for bill” to get it." };
  }

  await expireStale({ billId });

  const bill = await prisma.bill.findUniqueOrThrow({
    where: { id: billId },
    select: {
      id: true,
      billNumber: true,
      status: true,
      subtotalPaise: true,
      discountPaise: true,
      taxPaise: true,
      roundOffPaise: true,
      totalPaise: true,
      paidPaise: true,
      splitMode: true,
      invoice: { select: { invoiceNumber: true } },
      splitParts: {
        orderBy: { partNumber: "asc" },
        select: { partNumber: true, label: true, amountPaise: true, paidPaise: true },
      },
      paymentRequests: {
        where: { sessionId: session.id },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: { id: true, amountPaise: true, status: true, rejectReason: true, createdAt: true, splitPartId: true },
      },
    },
  });

  return {
    canPayByUpi: canPayByUpi && bill.status === BillStatus.OPEN,
    bill: {
      billId: bill.id,
      billNumber: bill.billNumber,
      status: bill.status.toLowerCase(),
      subtotalPaise: bill.subtotalPaise,
      discountPaise: bill.discountPaise,
      taxPaise: bill.taxPaise,
      roundOffPaise: bill.roundOffPaise,
      totalPaise: bill.totalPaise,
      paidPaise: bill.paidPaise,
      duePaise: Math.max(bill.totalPaise - bill.paidPaise, 0),
      invoiceNumber: bill.invoice?.invoiceNumber ?? null,
      split: bill.splitMode
        ? {
            mode: bill.splitMode.toLowerCase(),
            parts: bill.splitParts.map((part) => ({
              ...part,
              duePaise: Math.max(part.amountPaise - part.paidPaise, 0),
              paid: part.paidPaise >= part.amountPaise,
            })),
          }
        : null,
    },
    payments: bill.paymentRequests.map(({ splitPartId, status, ...request }) => ({
      ...request,
      status: status.toLowerCase(),
    })),
  };
}

/**
 * A guest starts paying from the table QR: returns the UPI link (tap to
 * open GPay/PhonePe/Paytm with the amount filled in) and a QR.
 *
 * @param token - The session token.
 * @param input - Their split part, if the bill is split.
 * @returns The payment request with its link and QR.
 * @throws PaymentServiceError If guest payment is off, the bill isn't ready or nothing is due.
 */
export async function createGuestPayment(token: string, input: CreateGuestPaymentInput) {
  const { session, billId } = await getSessionBill(token);
  const settings = await getSettings(prisma, session.branchId);

  if (!settings.guestPaymentsEnabled) {
    throw new PaymentServiceError(PaymentServiceErrorCode.GUEST_PAYMENTS_DISABLED, "Paying from the table is turned off. Please pay at the counter.");
  }

  if (!billId) {
    throw new PaymentServiceError(PaymentServiceErrorCode.BILL_NOT_READY, "Your bill isn't ready yet. Please ask for the bill first.");
  }

  const result = await runWithReferenceRetry(() =>
    prisma.$transaction((tx) =>
      createRequestInTx(tx, {
        organizationId: session.organizationId,
        branchId: session.branchId,
        billId,
        partNumber: input.partNumber,
        amountPaise: undefined,
        source: PaymentRequestSource.QR,
        sessionId: session.id,
        createdById: null,
      }),
    ),
  );

  const request = await serializeRequest(await loadRequest(result.id), true);

  if (result.created) {
    publishPaymentEvent(session.branchId, PaymentEventName.REQUESTED, {
      requestId: request.id,
      billNumber: request.billNumber,
      tableName: session.table.name,
      amountPaise: request.amountPaise,
      fromGuest: true,
    });
  }

  return guestView(request);
}

/**
 * Hides staff-only fields from a request shown to a guest.
 *
 * @param request - The serialized request.
 * @returns The guest view.
 */
function guestView(request: Awaited<ReturnType<typeof serializeRequest>>) {
  const { confirmedBy, createdBy, billPaymentId, sessionId, branchId, ...data } = request;

  return data;
}

/**
 * Loads a payment request that belongs to the guest's session.
 *
 * @param token - The session token.
 * @param requestId - The request ID.
 * @returns The session and request.
 * @throws PaymentServiceError If the request isn't this session's.
 */
async function findGuestRequest(token: string, requestId: string) {
  const session = await getLiveSession(token);
  await expireStale({ id: requestId });

  const request = await prisma.paymentRequest.findFirst({
    where: { id: requestId, sessionId: session.id },
    select: requestSelect,
  });

  if (!request) {
    throw new PaymentServiceError(PaymentServiceErrorCode.PAYMENT_REQUEST_NOT_FOUND, "Payment not found");
  }

  return { session, request };
}

/**
 * Status of a guest's payment (the guest's phone polls this).
 *
 * @param token - The session token.
 * @param requestId - The request ID.
 * @returns The request (QR included while it's still open).
 */
export async function getGuestPayment(token: string, requestId: string) {
  const { request } = await findGuestRequest(token, requestId);

  return guestView(await serializeRequest(request, true));
}

/**
 * The guest says they paid and enters the UTR from their UPI app. Staff
 * are alerted to check it and confirm.
 *
 * @param token - The session token.
 * @param requestId - The request ID.
 * @param input - The UTR and payer name.
 * @returns The request, now waiting for staff.
 * @throws PaymentServiceError If it's closed or the UTR was already used.
 */
export async function submitGuestPayment(token: string, requestId: string, input: SubmitGuestPaymentInput) {
  const { session, request } = await findGuestRequest(token, requestId);

  if (request.status !== PaymentRequestStatus.PENDING && request.status !== PaymentRequestStatus.EXPIRED) {
    throw new PaymentServiceError(
      PaymentServiceErrorCode.PAYMENT_REQUEST_CLOSED,
      request.status === PaymentRequestStatus.SUBMITTED
        ? "Already sent. The staff is checking your payment."
        : `This payment is ${request.status.toLowerCase()}`,
    );
  }

  const reused = await prisma.paymentRequest.findFirst({
    where: { organizationId: session.organizationId, utr: input.utr, id: { not: request.id }, status: { in: [PaymentRequestStatus.SUBMITTED, PaymentRequestStatus.CONFIRMED] } },
    select: { id: true },
  });

  if (reused) {
    throw new PaymentServiceError(PaymentServiceErrorCode.DUPLICATE_UTR, "This transaction ID was already used. Please check and try again.");
  }

  await prisma.paymentRequest.update({
    where: { id: request.id },
    data: {
      status: PaymentRequestStatus.SUBMITTED,
      utr: input.utr,
      payerName: input.payerName ?? null,
      submittedAt: new Date(),
    },
  });

  publishPaymentEvent(session.branchId, PaymentEventName.SUBMITTED, {
    requestId: request.id,
    billNumber: request.bill.billNumber,
    tableName: session.table.name,
    amountPaise: request.amountPaise,
    utr: input.utr,
    payerName: input.payerName ?? null,
  });

  return guestView(await serializeRequest(await loadRequest(request.id), false));
}

/**
 * Checks whether an unknown value is a payment service error.
 *
 * @param error - The unknown value to validate.
 * @returns True if the value is a PaymentServiceError with a known code.
 */
export function isPaymentServiceError(error: unknown): error is PaymentServiceError {
  return (
    error instanceof PaymentServiceError &&
    Object.values(PaymentServiceErrorCode).includes(error.code)
  );
}
