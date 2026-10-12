
import { SignJWT, jwtVerify } from "jose";

const secret = process.env.JWT_SECRET;

function getSecret(): Uint8Array {
  if (!secret || secret.length < 32) {
    throw new Error("JWT_SECRET must be configured with at least 32 characters");
  }

  return new TextEncoder().encode(secret);
}

export interface AccessTokenPayload {
  sub: string;
  role: string;
  organizationIds: string[];
  branchIds: string[];
}

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

export async function verifyAccessToken(token: string) {
  const result = await jwtVerify(token, getSecret(), {
    issuer: "morfikos-api",
    algorithms: ["HS256"],
  });

  return result.payload;
}