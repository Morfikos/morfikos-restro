
import { createPrismaClient } from "@morfikos/database";
import type {
  CreateBranchInput,
  UpdateBranchInput,
} from "@morfikos/validation";

const prisma = createPrismaClient();

export class BranchServiceError extends Error {
  constructor(
    public readonly code:
      | "ORGANIZATION_NOT_FOUND"
      | "BRANCH_NOT_FOUND"
      | "BRANCH_CODE_CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "BranchServiceError";
  }
}

function getCurrentFinancialYear(date = new Date()): string {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const startYear = month >= 4 ? year : year - 1;

  return `${String(startYear).slice(-2)}-${String(startYear + 1).slice(-2)}`;
}

function generateBranchCode(name: string): string {
  const firstWord = name.trim().split(/\s+/)[0] ?? "";

  return (
    firstWord.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10) ||
    "BRANCH"
  );
}

function toDatabaseTime(value: string): Date {
  const [hours, minutes] = value.split(":").map(Number);

  return new Date(Date.UTC(1970, 0, 1, hours, minutes));
}

function toApiTime(value: Date | null): string | null {
  if (!value) return null;
  return value.toISOString().slice(11, 16);
}

function serializeBranch<
  T extends { businessDayCutoff: Date | null },
>(branch: T) {
  return {
    ...branch,
    businessDayCutoff: toApiTime(branch.businessDayCutoff),
  };
}

/**
 * POST /api/v1/branches
 */
export async function createBranch(data: CreateBranchInput) {
  const organization = await prisma.organization.findUnique({
    where: { id: data.organizationId },
    select: { id: true, status: true },
  });

  if (!organization || organization.status !== "active") {
    throw new BranchServiceError(
      "ORGANIZATION_NOT_FOUND",
      "Active organization not found",
    );
  }

  const financialYear = getCurrentFinancialYear();

  return prisma.$transaction(async (tx) => {
    const baseCode = generateBranchCode(data.name);
    let code = baseCode;
    let suffix = 2;

    while (
      await tx.branch.findFirst({
        where: {
          organizationId: data.organizationId,
          code,
        },
        select: { id: true },
      })
    ) {
      const suffixText = String(suffix);
      code = `${baseCode.slice(0, 10 - suffixText.length)}${suffixText}`;
      suffix += 1;
    }

    const branch = await tx.branch.create({
      data: {
        organizationId: data.organizationId,
        name: data.name,
        code,
        address: data.address,
        city: data.city,
        state: data.state,
        phone: data.phone,
        gstin: data.gstin,
        fssaiNo: data.fssaiNo || null,
        tables: data.noOfTables,
        timezone: data.timezone,
        businessDays: data.businessDays,
        businessDayCutoff: data.businessDayCutoff
          ? toDatabaseTime(data.businessDayCutoff)
          : null,
        googleReviewUrl: data.googleReviewUrl || null,
        status: "active",
        invoiceFy: financialYear,
invoiceLastNumber: 0,
        settings: {
          autoAcceptOrders: false,
          defaultOrderType: "dine-in",
          discountApprovalAbove: 10,
          walletCommission: 2.0,
          businessHours: {
            open: "10:00",
            close: "23:00",
          },
        },
      },
    });

    const invoiceSequence = await tx.invoiceSequence.create({
      data: {
        branchId: branch.id,
        financialYear,
        lastNumber: 0,
      },
    });

    return {
      ...serializeBranch(branch),
      invoiceSequence: {
        fy: invoiceSequence.financialYear,
        lastNumber: invoiceSequence.lastNumber,
      },
    };
  });
}

/**
 * GET /api/v1/branches/:id
 */
export async function getBranch(id: string, organizationId: string) {
  const branch = await prisma.branch.findFirst({
    where: { id, organizationId },
    include: {
      invoiceSequences: {
        orderBy: { financialYear: "desc" },
      },
    },
  });

  if (!branch) return null;

  const { invoiceSequences, ...branchData } = branch;

  return {
    ...serializeBranch(branchData),
    invoiceSequences: invoiceSequences.map((sequence) => ({
      fy: sequence.financialYear,
      lastNumber: sequence.lastNumber,
    })),
  };
}

/**
 * GET /api/v1/branches?status=active&limit=50&offset=0
 */
export async function listBranches(
  organizationId: string,
  status: "active" | "inactive",
  limit: number,
  offset: number,
) {
  const where = { organizationId, status };

  const [branches, total] = await Promise.all([
    prisma.branch.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.branch.count({ where }),
  ]);

  return {
    total,
    limit,
    offset,
    branches: branches.map((branch) => serializeBranch(branch)),
  };
}

/**
 * PUT /api/v1/branches/:id
 */
export async function updateBranch(
  id: string,
  organizationId: string,
  data: UpdateBranchInput,
) {
  const existing = await prisma.branch.findFirst({
    where: { id, organizationId },
    select: { id: true },
  });

  if (!existing) return null;

  const updated = await prisma.branch.update({
    where: { id: existing.id },
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.address !== undefined ? { address: data.address } : {}),
      ...(data.city !== undefined ? { city: data.city } : {}),
      ...(data.state !== undefined ? { state: data.state } : {}),
      ...(data.phone !== undefined ? { phone: data.phone } : {}),
      ...(data.gstin !== undefined ? { gstin: data.gstin } : {}),
      ...(data.fssaiNo !== undefined
        ? { fssaiNo: data.fssaiNo || null }
        : {}),
      ...(data.noOfTables !== undefined
        ? { tables: data.noOfTables }
        : {}),
      ...(data.timezone !== undefined ? { timezone: data.timezone } : {}),
      ...(data.businessDays !== undefined
        ? { businessDays: data.businessDays }
        : {}),
      ...(data.businessDayCutoff !== undefined
        ? {
            businessDayCutoff: data.businessDayCutoff
              ? toDatabaseTime(data.businessDayCutoff)
              : null,
          }
        : {}),
      ...(data.googleReviewUrl !== undefined
        ? { googleReviewUrl: data.googleReviewUrl || null }
        : {}),
    },
  });

  return serializeBranch(updated);
}

/**
 * DELETE /api/v1/branches/:id
 * Soft-deactivate the branch; preserve financial history.
 */
export async function deactivateBranch(
  id: string,
  organizationId: string,
) {
  const existing = await prisma.branch.findFirst({
    where: { id, organizationId },
    select: { id: true, status: true },
  });

  if (!existing) return null;

  if (existing.status === "inactive") {
    return existing;
  }

  return prisma.branch.update({
    where: { id: existing.id },
    data: { status: "inactive" },
    select: {
      id: true,
      status: true,
      updatedAt: true,
    },
  });
}