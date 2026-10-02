import { SignJWT, jwtVerify } from "jose";

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error("JWT_SECRET is not configured");
}

const secret = new TextEncoder().encode(JWT_SECRET);

export interface AccessTokenPayload {
  userId: string;
  role: string;
}

export async function createAccessToken(
  payload: AccessTokenPayload,
): Promise<string> {
  return new SignJWT({
    userId: payload.userId,
    role: payload.role,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(secret);
}

export async function verifyAccessToken(
  token: string,
): Promise<AccessTokenPayload> {
  const { payload } = await jwtVerify(token, secret);

  if (
    typeof payload.userId !== "string" ||
    typeof payload.role !== "string"
  ) {
    throw new Error("Invalid access token payload");
  }

  return {
    userId: payload.userId,
    role: payload.role,
  };
}