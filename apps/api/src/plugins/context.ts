import fp from "fastify-plugin";
import { fastifyRequestContext, requestContext } from "@fastify/request-context";

/**
 * Caller identity stored per-request via AsyncLocalStorage.
 * Phase 4 expands this into the full StaffAuth | GuestAuth | DeviceAuth union.
 */
export interface RequestAuth {
  kind: "staff" | "guest" | "device";
  organizationId: string | null;
  [key: string]: unknown;
}

declare module "@fastify/request-context" {
  interface RequestContextData {
    auth: RequestAuth | null;
  }
}

export const contextPlugin = fp(async (app) => {
  await app.register(fastifyRequestContext, {
    defaultStoreValues: { auth: null },
  });
});

/** The caller of the current request, from anywhere in the call stack. */
export function currentAuth(): RequestAuth | null {
  return requestContext.get("auth") ?? null;
}
