export interface CreateSessionInput {
  userId: string;
  device?: string;
  expiresAt: Date;
}

export interface SessionData {
  id: string;
  userId: string;
  device: string | null;
  expiresAt: Date;
}

export function createSessionData(
  input: CreateSessionInput
): CreateSessionInput {
  return {
    userId: input.userId,
    device: input.device,
    expiresAt: input.expiresAt,
  };
}