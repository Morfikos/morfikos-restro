
// import { SignJWT, jwtVerify } from "jose";

// const secret = process.env.JWT_SECRET;

// function getSecret(): Uint8Array {
//   if (!secret || secret.length < 32) {
//     throw new Error("JWT_SECRET must be configured with at least 32 characters");
//   }

//   return new TextEncoder().encode(secret);
// }

// export interface AccessTokenPayload {
//   sub: string;
//   role: string;
//   organizationIds: string[];
//   branchIds: string[];
// }

// export async function createAccessToken(
//   payload: AccessTokenPayload,
// ): Promise<string> {
//   return new SignJWT({
//     role: payload.role,
//     organizationIds: payload.organizationIds,
//     branchIds: payload.branchIds,
//   })
//     .setProtectedHeader({ alg: "HS256" })
//     .setSubject(payload.sub)
//     .setIssuedAt()
//     .setExpirationTime("15m")
//     .setIssuer("morfikos-api")
//     .sign(getSecret());
// }

// export async function verifyAccessToken(token: string) {
//   const result = await jwtVerify(token, getSecret(), {
//     issuer: "morfikos-api",
//     algorithms: ["HS256"],
//   });

//   return result.payload;
// }

import { SignJWT, jwtVerify } from "jose";

/**
 * Retrieves and validates the JWT secret from environment variables.
 *
 * @throws {Error} If JWT_SECRET is missing or shorter than 32 characters.
 * @returns The JWT secret encoded as a Uint8Array.
 */
function getSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;

  if (!secret || secret.length < 32) {
    throw new Error(
      "JWT_SECRET must be configured with at least 32 characters",
    );
  }

  return new TextEncoder().encode(secret);
}

/**
 * Payload used to generate an access token.
 */
export interface AccessTokenPayload {
  /** User ID stored as the token subject. */
  sub: string;
  /** User's application role. */
  role: string;
  /** Organizations accessible to the user. */
  organizationIds: string[];
  /** Branches accessible to the user. */
  branchIds: string[];
}

/**
 * Generates a signed JWT access token valid for 15 minutes.
 *
 * @param payload - User identity and authorization details.
 * @returns The signed JWT.
 */
export async function createAccessToken(
  payload: AccessTokenPayload,
): Promise<string> {
  return new SignJWT({
    role: payload.role,
    organizationIds: payload.organizationIds,
    branchIds: payload.branchIds,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime("15m")
    .setIssuer("morfikos-api")
    .sign(getSecret());
}

/**
 * Verifies the signature, issuer, and algorithm of an access token.
 *
 * @param token - JWT to verify.
 * @returns The verified token payload.
 * @throws {Error} If verification fails.
 */
export async function verifyAccessToken(token: string) {
  const result = await jwtVerify(token, getSecret(), {
    issuer: "morfikos-api",
    algorithms: ["HS256"],
  });

  return result.payload;
}
