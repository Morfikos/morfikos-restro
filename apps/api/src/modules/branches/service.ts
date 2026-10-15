
import { createPrismaClient } from "@morfikos/database";
import type {
  CreateBranchInput,
  UpdateBranchInput,
} from "@morfikos/validation";

const prisma = createPrismaClient();

/**
 * Represents errors that can occur during branch operations.
 */
export class BranchServiceError extends Error {
  /**
   * Creates a branch service error.
   *
   * @param code - The standardized error code.
   * @param message - A description of the error.
   */
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

/**
 * Gets the current financial year in YY-YY format.
 *
 * The financial year starts in April.
 *
 * @param date - The date used to determine the financial year.
 * @returns The financial year, such as "26-27".
 */
function getCurrentFinancialYear(date = new Date()): string {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const startYear = month >= 4 ? year : year - 1;

  return `${String(startYear).slice(-2)}-${String(startYear + 1).slice(-2)}`;
}

/**
 * Generates a base branch code from the branch name.
 *
 * @param name - The branch name.
 * @returns An uppercase alphanumeric branch code.
 */
function generateBranchCode(name: string): string {
  const firstWord = name.trim().split(/\s+/)[0] ?? "";

  return (
    firstWord.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10) ||
    "BRANCH"
  );
}

/**
 * Converts an API time string into a Date for database storage.
 *
 * @param value - The time in HH:mm format.
 * @returns A Date representing the supplied UTC time.
 */
function toDatabaseTime(value: string): Date {
  const [hours, minutes] = value.split(":").map(Number);

  return new Date(Date.UTC(1970, 0, 1, hours, minutes));
}

/**
 * Converts a database Date into an API time string.
 *
 * @param value - The database time, or null.
 * @returns The time in HH:mm format, or null.
 */
function toApiTime(value: Date | null): string | null {
  if (!value) return null;

  return value.toISOString().slice(11, 16);
}

/**
 * Serializes a branch by converting its business day cutoff to API format.
 *
 * @param branch - A branch record containing a business day cutoff.
 * @returns The branch with a serialized business day cutoff.
 */
function serializeBranch<
  T extends { businessDayCutoff: Date | null },
>(branch: T) {
  return {
    ...branch,
    businessDayCutoff: toApiTime(branch.businessDayCutoff),
  };
}

/**
 * Creates a branch and initializes its invoice sequence.
 *
 * Only active organizations can have new branches created.
 * Branch creation and invoice sequence creation happen in one transaction.
 *
 * @param data - The validated branch creation details.
 * @returns The created branch and its initial invoice sequence.
 * @throws BranchServiceError If the organization does not exist or is inactive.
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
 * Retrieves a branch belonging to the specified organization.
 *
 * @param id - The branch ID.
 * @param organizationId - The owning organization ID.
 * @returns The branch with its invoice sequences, or null if not found.
 */
export async function getBranch(
  id: string,
  organizationId: string,
) {
  const branch = await prisma.branch.findFirst({
    where: { id, organizationId },
    include: {
      invoiceSequences: {
        orderBy: { financialYear: "desc" },
      },
    },
  });

  if (!branch) {
    return null;
  }

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
 * Retrieves a paginated list of branches for an organization.
 *
 * @param organizationId - The owning organization ID.
 * @param status - The branch status to filter by.
 * @param limit - The maximum number of branches to return.
 * @param offset - The number of branches to skip.
 * @returns The branches and pagination metadata.
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
 * Updates the provided fields of a branch belonging to an organization.
 *
 * Fields not provided in the input are left unchanged.
 *
 * @param id - The branch ID.
 * @param organizationId - The owning organization ID.
 * @param data - The validated fields to update.
 * @returns The updated branch, or null if the branch is not found.
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

  if (!existing) {
    return null;
  }

  const updated = await prisma.branch.update({
    where: { id: existing.id },
    data: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.address !== undefined && { address: data.address }),
      ...(data.city !== undefined && { city: data.city }),
      ...(data.state !== undefined && { state: data.state }),
      ...(data.phone !== undefined && { phone: data.phone }),
      ...(data.gstin !== undefined && { gstin: data.gstin }),
      ...(data.fssaiNo !== undefined && {
        fssaiNo: data.fssaiNo || null,
      }),
      ...(data.noOfTables !== undefined && {
        tables: data.noOfTables,
      }),
      ...(data.timezone !== undefined && {
        timezone: data.timezone,
      }),
      ...(data.businessDays !== undefined && {
        businessDays: data.businessDays,
      }),
      ...(data.businessDayCutoff !== undefined && {
        businessDayCutoff: data.businessDayCutoff
          ? toDatabaseTime(data.businessDayCutoff)
          : null,
      }),
      ...(data.googleReviewUrl !== undefined && {
        googleReviewUrl: data.googleReviewUrl || null,
      }),
    },
  });

  return serializeBranch(updated);
}

/**
 * Soft-deactivates a branch without deleting its financial history.
 *
 * @param id - The branch ID.
 * @param organizationId - The owning organization ID.
 * @returns The branch status details, or null if the branch is not found.
 */
export async function deactivateBranch(
  id: string,
  organizationId: string,
) {
  const existing = await prisma.branch.findFirst({
    where: { id, organizationId },
    select: {
      id: true,
      status: true,
      updatedAt: true,
    },
  });

  if (!existing) {
    return null;
  }

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

/**
 * Checks whether an unknown value matches a known branch service error.
 *
 * @param error - The unknown value to validate.
 * @returns True if the value contains a recognized branch error code
 * and a string message.
 */
export function isBranchServiceError(
  error: unknown,
): error is BranchServiceError {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    !("message" in error)
  ) {
    return false;
  }

  return (
    typeof error.code === "string" &&
    typeof error.message === "string" &&
    (
      error.code === "ORGANIZATION_NOT_FOUND" ||
      error.code === "BRANCH_NOT_FOUND" ||
      error.code === "BRANCH_CODE_CONFLICT"
    )
  );
}
