export interface ApiErrorBody {
  success: false;
  message: string;
  code: string;
  details?: Record<string, unknown>;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiFetchOptions extends Omit<RequestInit, "body"> {
  baseUrl?: string;
  body?: unknown;
  accessToken?: string | null;
  branchId?: string | null;
  guestSessionToken?: string | null;
  overrideToken?: string | null;
  idempotencyKey?: string;
}

const envApiUrl = (
  globalThis as { process?: { env?: Record<string, string | undefined> } }
).process?.env?.API_INTERNAL_URL;

const DEFAULT_BASE_URL =
  typeof window === "undefined" ? (envApiUrl ?? "http://127.0.0.1:3000") : "";

/**
 * Shared typed HTTP client for Server Components and Client Components.
 * Always attaches `x-requested-with: morfikos` on writes for CSRF protection.
 */
export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const {
    baseUrl = DEFAULT_BASE_URL,
    body,
    accessToken,
    branchId,
    guestSessionToken,
    overrideToken,
    idempotencyKey,
    headers: customHeaders,
    method = "GET",
    ...rest
  } = options;

  const headers = new Headers(customHeaders);
  const isWrite = !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());

  if (isWrite) {
    headers.set("x-requested-with", "morfikos");
  }
  if (body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (accessToken) {
    headers.set("authorization", `Bearer ${accessToken}`);
  }
  if (branchId) {
    headers.set("x-branch-id", branchId);
  }
  if (guestSessionToken) {
    headers.set("x-session-token", guestSessionToken);
  }
  if (overrideToken) {
    headers.set("x-override-token", overrideToken);
  }
  if (idempotencyKey) {
    headers.set("idempotency-key", idempotencyKey);
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    credentials: "include",
    body: body !== undefined ? JSON.stringify(body) : undefined,
    ...rest,
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const err = payload as Partial<ApiErrorBody> | null;
    throw new ApiError(
      response.status,
      err?.code ?? "INTERNAL_SERVER_ERROR",
      err?.message ?? `Request failed (${response.status})`,
      err?.details,
    );
  }

  return payload as T;
}
