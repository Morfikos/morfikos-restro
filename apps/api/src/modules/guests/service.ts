import { db as prisma } from "../../plugins/db.js";
import { GuestServiceErrorCode, type UserRole } from "@morfikos/auth";
import type {
  AdjustLoyaltyInput,
  CreateGuestInput,
  GuestConsentInput,
  GuestGroupValue,
  ListGuestsQuery,
  ListLoyaltyQuery,
  UpdateGuestInput,
} from "@morfikos/validation";

import { isPrismaUniqueConstraintError } from "../../utils/prisma-errors.js";
import { fromPaise } from "../orders/pricing.js";
import {
  CONSENT_FREQUENCY_FROM_API,
  CONSENT_STATUS_FROM_API,
  CONSENT_TYPE_FROM_API,
  ConsentSource,
  ConsentStatus,
  GuestGroup,
  LAPSED_AFTER_DAYS,
  LoyaltyTransactionType,
  REGULAR_MIN_VISITS,
  RETURNING_MIN_VISITS,
  VISIT_HISTORY_LIMIT,
} from "./constants.js";


const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The authenticated staff member performing a guest operation. Public
 * (QR menu) calls have no actor.
 */
export interface GuestActor {
  userId: string;
  role: UserRole;
  organizationId: string;
  branchIds: string[];
}

/**
 * Represents errors that can occur during guest operations.
 */
export class GuestServiceError extends Error {
  /**
   * Creates a guest service error.
   *
   * @param code - The standardized error code.
   * @param message - A description of the error.
   */
  constructor(
    public readonly code: GuestServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GuestServiceError";
  }
}

/**
 * Returns the cutoff before which a last visit counts as lapsed.
 *
 * @param now - The current time.
 * @returns The lapse cutoff.
 */
function getLapsedBefore(now: number = Date.now()): Date {
  return new Date(now - LAPSED_AFTER_DAYS * MS_PER_DAY);
}

/**
 * Computes a guest's segment. Checked in order: lapsed (no visit in 60+
 * days), regular (5+ visits), returning (2–4 visits), new.
 *
 * @param guest - The guest's visit count and last visit.
 * @param now - The current time.
 * @returns The guest group.
 */
export function getGuestGroup(
  guest: { totalVisits: number; lastVisitAt: Date | null },
  now: number = Date.now(),
): GuestGroup {
  if (guest.lastVisitAt && guest.lastVisitAt < getLapsedBefore(now)) {
    return GuestGroup.LAPSED;
  }

  if (guest.totalVisits >= REGULAR_MIN_VISITS) {
    return GuestGroup.REGULAR;
  }

  if (guest.totalVisits >= RETURNING_MIN_VISITS) {
    return GuestGroup.RETURNING;
  }

  return GuestGroup.NEW;
}

/**
 * Builds the database filter for a guest segment, matching {@link getGuestGroup}.
 *
 * @param group - The requested segment.
 * @param now - The current time.
 * @returns The Prisma where clause for the segment.
 */
function getGroupFilter(group: GuestGroupValue, now: number = Date.now()) {
  const lapsedBefore = getLapsedBefore(now);
  const active = { OR: [{ lastVisitAt: null }, { lastVisitAt: { gte: lapsedBefore } }] };

  switch (group) {
    case GuestGroup.LAPSED:
      return { lastVisitAt: { lt: lapsedBefore } };

    case GuestGroup.REGULAR:
      return { ...active, totalVisits: { gte: REGULAR_MIN_VISITS } };

    case GuestGroup.RETURNING:
      return {
        ...active,
        totalVisits: { gte: RETURNING_MIN_VISITS, lt: REGULAR_MIN_VISITS },
      };

    default:
      return { ...active, totalVisits: { lt: RETURNING_MIN_VISITS } };
  }
}

/**
 * Masks a phone number for public responses, keeping the country code and
 * the last four digits.
 *
 * @param phone - The E.164 phone number.
 * @returns The masked phone, e.g. "+91******3210".
 */
function maskPhone(phone: string): string {
  return `${phone.slice(0, 3)}${"*".repeat(Math.max(phone.length - 7, 0))}${phone.slice(-4)}`;
}

/** Fields returned for a guest's profile. */
const guestSelect = {
  id: true,
  organizationId: true,
  phone: true,
  name: true,
  email: true,
  notes: true,
  totalVisits: true,
  totalSpentPaise: true,
  loyaltyPoints: true,
  firstVisitAt: true,
  lastVisitAt: true,
  createdAt: true,
} as const;

type GuestRecord = {
  id: string;
  organizationId: string;
  phone: string;
  name: string | null;
  email: string | null;
  notes: string | null;
  totalVisits: number;
  totalSpentPaise: number;
  loyaltyPoints: number;
  firstVisitAt: Date | null;
  lastVisitAt: Date | null;
  createdAt: Date;
};

/**
 * Serializes a guest for staff, with spend in rupees and the segment.
 *
 * @param guest - A guest selected with {@link guestSelect}.
 * @returns The guest profile.
 */
function serializeGuest(guest: GuestRecord) {
  const { totalSpentPaise, ...guestData } = guest;

  return {
    ...guestData,
    group: getGuestGroup(guest),
    totalSpent: fromPaise(totalSpentPaise),
  };
}

/**
 * Serializes a guest for a public (QR menu) caller: no name, email or
 * notes, and a masked phone, so a phone number reveals nothing personal.
 *
 * @param guest - A guest selected with {@link guestSelect}.
 * @returns The limited guest view.
 */
function serializePublicGuest(guest: GuestRecord) {
  return {
    id: guest.id,
    phone: maskPhone(guest.phone),
    totalVisits: guest.totalVisits,
    loyaltyPoints: guest.loyaltyPoints,
  };
}

/**
 * Resolves the organization a guest call acts on. Staff use their own
 * organization; public calls are tied to the restaurant of the table QR
 * code they scanned.
 *
 * @param actor - The staff member, or null for a public call.
 * @param organizationId - The organization sent in the request, if any.
 * @param qrCode - The table QR code sent in the request, if any.
 * @returns The organization ID.
 * @throws GuestServiceError If the organization doesn't match or the QR code is missing/invalid.
 */
async function resolveOrganizationId(
  actor: GuestActor | null,
  organizationId: string | undefined,
  qrCode: string | undefined,
): Promise<string> {
  if (actor) {
    if (organizationId !== undefined && organizationId !== actor.organizationId) {
      throw new GuestServiceError(
        GuestServiceErrorCode.ORGANIZATION_ACCESS_DENIED,
        "You can only manage guests of your own organization",
      );
    }

    return actor.organizationId;
  }

  if (!qrCode) {
    throw new GuestServiceError(
      GuestServiceErrorCode.QR_CODE_REQUIRED,
      "Scan the table QR code to continue",
    );
  }

  const table = await prisma.diningTable.findUnique({
    where: { qrCode },
    select: {
      isActive: true,
      branch: {
        select: {
          status: true,
          organizationId: true,
          organization: { select: { status: true } },
        },
      },
    },
  });

  if (
    !table ||
    !table.isActive ||
    table.branch.status !== "active" ||
    table.branch.organization.status !== "active"
  ) {
    throw new GuestServiceError(
      GuestServiceErrorCode.TABLE_NOT_FOUND,
      "Table not found",
    );
  }

  if (organizationId !== undefined && organizationId !== table.branch.organizationId) {
    throw new GuestServiceError(
      GuestServiceErrorCode.ORGANIZATION_ACCESS_DENIED,
      "This QR code belongs to a different restaurant",
    );
  }

  return table.branch.organizationId;
}

/**
 * Finds a guest of the organization.
 *
 * @param organizationId - The organization ID.
 * @param guestId - The guest ID.
 * @returns The guest, or null if not found.
 */
async function findGuest(organizationId: string, guestId: string) {
  return prisma.guest.findFirst({
    where: { id: guestId, organizationId },
    select: guestSelect,
  });
}

/**
 * Creates a guest, or finds the existing one with this phone number.
 * Staff may update the name, email and notes. A public (QR) caller can
 * only fill in a name or email that is still empty, never overwrite one,
 * and gets a limited view.
 *
 * @param actor - The staff member, or null for a public call.
 * @param input - The validated guest details.
 * @returns The guest and whether it was just created.
 * @throws GuestServiceError If the organization or QR code is invalid.
 */
export async function createOrFindGuest(actor: GuestActor | null, input: CreateGuestInput) {
  const organizationId = await resolveOrganizationId(actor, input.organizationId, input.qrCode);

  const existing = await prisma.guest.findUnique({
    where: { organizationId_phone: { organizationId, phone: input.phone } },
    select: guestSelect,
  });

  let guest: GuestRecord;
  let created = false;

  if (existing) {
    const changes = actor
      ? {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.email !== undefined && { email: input.email }),
          ...(input.notes !== undefined && { notes: input.notes }),
        }
      : {
          ...(input.name !== undefined && existing.name === null && { name: input.name }),
          ...(input.email !== undefined && existing.email === null && { email: input.email }),
        };

    guest =
      Object.keys(changes).length > 0
        ? await prisma.guest.update({ where: { id: existing.id }, data: changes, select: guestSelect })
        : existing;
  } else {
    try {
      guest = await prisma.guest.create({
        data: {
          organizationId,
          phone: input.phone,
          name: input.name ?? null,
          email: input.email ?? null,
          notes: actor ? (input.notes ?? null) : null,
        },
        select: guestSelect,
      });
      created = true;
    } catch (error: unknown) {
      // Two calls for the same new phone at once: the other one created it.
      if (!isPrismaUniqueConstraintError(error)) {
        throw error;
      }

      guest = await prisma.guest.findUniqueOrThrow({
        where: { organizationId_phone: { organizationId, phone: input.phone } },
        select: guestSelect,
      });
    }
  }

  return {
    created,
    guest: actor ? serializeGuest(guest) : serializePublicGuest(guest),
  };
}

/**
 * Saves a guest's marketing consent for one channel (one current record
 * per channel). Granting records when; revoking records when and stops
 * messages on that channel.
 *
 * @param actor - The staff member, or null for a public call.
 * @param guestId - The guest ID.
 * @param input - The consent type, status and frequency.
 * @returns The saved consent.
 * @throws GuestServiceError If the guest or QR code is invalid.
 */
export async function saveGuestConsent(
  actor: GuestActor | null,
  guestId: string,
  input: GuestConsentInput,
) {
  const organizationId = await resolveOrganizationId(actor, undefined, input.qrCode);
  const guest = await findGuest(organizationId, guestId);

  if (!guest) {
    throw new GuestServiceError(
      GuestServiceErrorCode.GUEST_NOT_FOUND,
      "Guest not found",
    );
  }

  const type = CONSENT_TYPE_FROM_API[input.consentType];
  const status = CONSENT_STATUS_FROM_API[input.status];
  const isActive = status === ConsentStatus.ACTIVE;
  const now = new Date();

  const consentData = {
    status,
    frequency:
      isActive && input.frequency !== undefined
        ? CONSENT_FREQUENCY_FROM_API[input.frequency]
        : null,
    source: actor ? ConsentSource.STAFF : ConsentSource.QR,
    grantedAt: isActive ? now : undefined,
    revokedAt: isActive ? null : now,
  };

  const consent = await prisma.guestConsent.upsert({
    where: { guestId_type: { guestId: guest.id, type } },
    create: { guestId: guest.id, type, ...consentData },
    update: consentData,
    select: {
      id: true,
      guestId: true,
      type: true,
      status: true,
      frequency: true,
      source: true,
      grantedAt: true,
      revokedAt: true,
      updatedAt: true,
    },
  });

  return {
    ...consent,
    type: consent.type.toLowerCase(),
    status: consent.status.toLowerCase(),
    frequency: consent.frequency?.toLowerCase() ?? null,
    source: consent.source.toLowerCase(),
  };
}

/**
 * Retrieves a guest's full profile: totals, segment, consents, recent
 * visits (settled bills) and recent loyalty activity.
 *
 * @param actor - The staff member.
 * @param guestId - The guest ID.
 * @returns The guest profile, or null if not found.
 */
export async function getGuest(actor: GuestActor, guestId: string) {
  const guest = await findGuest(actor.organizationId, guestId);

  if (!guest) {
    return null;
  }

  const [consents, visits, loyalty] = await Promise.all([
    prisma.guestConsent.findMany({
      where: { guestId: guest.id },
      orderBy: { type: "asc" },
      select: { id: true, type: true, status: true, frequency: true, grantedAt: true, revokedAt: true },
    }),
    prisma.bill.findMany({
      where: { guestId: guest.id, status: "SETTLED" },
      orderBy: { settledAt: "desc" },
      take: VISIT_HISTORY_LIMIT,
      select: {
        id: true,
        billNumber: true,
        businessDate: true,
        settledAt: true,
        totalPaise: true,
        branch: { select: { id: true, name: true } },
        invoice: { select: { invoiceNumber: true } },
        loyaltyTransactions: {
          where: { type: LoyaltyTransactionType.EARN },
          select: { points: true },
        },
      },
    }),
    prisma.loyaltyTransaction.findMany({
      where: { guestId: guest.id },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, type: true, points: true, description: true, createdAt: true },
    }),
  ]);

  return {
    ...serializeGuest(guest),
    consents: consents.map((consent) => ({
      ...consent,
      type: consent.type.toLowerCase(),
      status: consent.status.toLowerCase(),
      frequency: consent.frequency?.toLowerCase() ?? null,
    })),
    visitHistory: visits.map((visit) => ({
      billId: visit.id,
      billNumber: visit.billNumber,
      businessDate: visit.businessDate,
      visitedAt: visit.settledAt,
      branch: visit.branch,
      invoiceNumber: visit.invoice?.invoiceNumber ?? null,
      total: fromPaise(visit.totalPaise),
      pointsEarned: visit.loyaltyTransactions[0]?.points ?? 0,
    })),
    recentLoyalty: loyalty.map((entry) => ({ ...entry, type: entry.type.toLowerCase() })),
  };
}

/**
 * Lists the organization's guests, most recent visitors first, filtered by
 * segment, last-visit date range or a name/phone/email search.
 *
 * @param actor - The owner or manager.
 * @param query - Validated filters and pagination.
 * @returns The guests and pagination metadata.
 * @throws GuestServiceError If another organization is requested.
 */
export async function listGuests(actor: GuestActor, query: ListGuestsQuery) {
  const organizationId = await resolveOrganizationId(actor, query.organizationId, undefined);
  const searchDigits = query.search?.replace(/\D/g, "") ?? "";

  const where = {
    organizationId,
    ...(query.group !== undefined && getGroupFilter(query.group)),
    ...((query.from !== undefined || query.to !== undefined) && {
      lastVisitDate: {
        ...(query.from !== undefined && { gte: query.from }),
        ...(query.to !== undefined && { lte: query.to }),
      },
    }),
    ...(query.search !== undefined && {
      AND: [
        {
          OR: [
            { name: { contains: query.search, mode: "insensitive" as const } },
            { email: { contains: query.search, mode: "insensitive" as const } },
            ...(searchDigits.length >= 3 ? [{ phone: { contains: searchDigits } }] : []),
          ],
        },
      ],
    }),
  };

  const [guests, total] = await Promise.all([
    prisma.guest.findMany({
      where,
      orderBy: [{ lastVisitAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      take: query.limit,
      skip: query.offset,
      select: guestSelect,
    }),
    prisma.guest.count({ where }),
  ]);

  const now = Date.now();

  return {
    total,
    limit: query.limit,
    offset: query.offset,
    guests: guests.map((guest) => ({
      id: guest.id,
      name: guest.name,
      phone: guest.phone,
      group: getGuestGroup(guest, now),
      visits: guest.totalVisits,
      totalSpent: fromPaise(guest.totalSpentPaise),
      loyaltyPoints: guest.loyaltyPoints,
      lastVisitAt: guest.lastVisitAt,
    })),
  };
}

/**
 * Updates a guest's name, email or staff notes. `null` clears a field.
 *
 * @param actor - The staff member.
 * @param guestId - The guest ID.
 * @param input - The validated changes.
 * @returns The updated guest, or null if not found.
 */
export async function updateGuest(
  actor: GuestActor,
  guestId: string,
  input: UpdateGuestInput,
) {
  const guest = await findGuest(actor.organizationId, guestId);

  if (!guest) {
    return null;
  }

  const updated = await prisma.guest.update({
    where: { id: guest.id },
    data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.email !== undefined && { email: input.email }),
      ...(input.notes !== undefined && { notes: input.notes }),
    },
    select: guestSelect,
  });

  return serializeGuest(updated);
}

/**
 * Adds or removes loyalty points by hand (e.g. a goodwill gesture or a
 * correction), with a reason kept in the ledger. Owners and managers only.
 *
 * @param actor - The owner or manager.
 * @param guestId - The guest ID.
 * @param input - The points (negative to remove) and reason.
 * @returns The new balance and the ledger entry, or null if not found.
 * @throws GuestServiceError If removing more points than the guest has.
 */
export async function adjustLoyaltyPoints(
  actor: GuestActor,
  guestId: string,
  input: AdjustLoyaltyInput,
) {
  const guest = await findGuest(actor.organizationId, guestId);

  if (!guest) {
    return null;
  }

  return prisma.$transaction(async (tx) => {
    const current = await tx.guest.findUniqueOrThrow({
      where: { id: guest.id },
      select: { loyaltyPoints: true },
    });

    if (current.loyaltyPoints + input.points < 0) {
      throw new GuestServiceError(
        GuestServiceErrorCode.INSUFFICIENT_POINTS,
        `This guest only has ${current.loyaltyPoints} points`,
      );
    }

    const updated = await tx.guest.update({
      where: { id: guest.id },
      data: { loyaltyPoints: { increment: input.points } },
      select: { loyaltyPoints: true },
    });

    const entry = await tx.loyaltyTransaction.create({
      data: {
        organizationId: actor.organizationId,
        guestId: guest.id,
        type: LoyaltyTransactionType.ADJUST,
        points: input.points,
        description: input.reason,
        createdById: actor.userId,
      },
      select: { id: true, type: true, points: true, description: true, createdAt: true },
    });

    return {
      guestId: guest.id,
      loyaltyPoints: updated.loyaltyPoints,
      transaction: { ...entry, type: entry.type.toLowerCase() },
    };
  });
}

/**
 * Lists a guest's loyalty ledger (earned, reversed and adjusted points),
 * newest first.
 *
 * @param actor - The staff member.
 * @param guestId - The guest ID.
 * @param query - Pagination.
 * @returns The balance, ledger entries and pagination metadata, or null if not found.
 */
export async function listLoyaltyTransactions(
  actor: GuestActor,
  guestId: string,
  query: ListLoyaltyQuery,
) {
  const guest = await findGuest(actor.organizationId, guestId);

  if (!guest) {
    return null;
  }

  const where = { guestId: guest.id };

  const [transactions, total] = await Promise.all([
    prisma.loyaltyTransaction.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: query.limit,
      skip: query.offset,
      select: {
        id: true,
        type: true,
        points: true,
        spendPaise: true,
        description: true,
        billId: true,
        createdAt: true,
        branch: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
      },
    }),
    prisma.loyaltyTransaction.count({ where }),
  ]);

  return {
    guestId: guest.id,
    loyaltyPoints: guest.loyaltyPoints,
    total,
    limit: query.limit,
    offset: query.offset,
    transactions: transactions.map(({ spendPaise, type, ...entry }) => ({
      ...entry,
      type: type.toLowerCase(),
      spend: fromPaise(spendPaise),
    })),
  };
}

/**
 * Checks whether an unknown value is a guest service error.
 *
 * @param error - The unknown value to validate.
 * @returns True if the value is a GuestServiceError with a known code.
 */
export function isGuestServiceError(error: unknown): error is GuestServiceError {
  return (
    error instanceof GuestServiceError &&
    Object.values(GuestServiceErrorCode).includes(error.code)
  );
}
