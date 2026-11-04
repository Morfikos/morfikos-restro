import { InventoryServiceErrorCode } from "@morfikos/auth";

/**
 * Represents errors that can occur during inventory operations.
 */
export class InventoryServiceError extends Error {
  /**
   * Creates an inventory service error.
   *
   * @param code - The standardized error code.
   * @param message - A description of the error.
   */
  constructor(
    public readonly code: InventoryServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "InventoryServiceError";
  }
}

/**
 * Checks whether an unknown value is an inventory service error.
 *
 * @param error - The unknown value to validate.
 * @returns True if the value is an InventoryServiceError with a known code.
 */
export function isInventoryServiceError(error: unknown): error is InventoryServiceError {
  return (
    error instanceof InventoryServiceError &&
    Object.values(InventoryServiceErrorCode).includes(error.code)
  );
}
