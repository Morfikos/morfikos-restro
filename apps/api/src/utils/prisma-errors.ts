


/**
 * Checks whether an error is a Prisma unique constraint violation.
/** */
export function isPrismaUniqueConstraintError(
  error: unknown,
): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}