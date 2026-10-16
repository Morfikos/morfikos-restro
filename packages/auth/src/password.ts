import { hash, verify, type Algorithm } from "@node-rs/argon2";

// Algorithm.Argon2id. The const enum can't be imported under verbatimModuleSyntax.
const ARGON2ID = 2 as Algorithm;

export async function hashPassword(password: string): Promise<string> {
  return hash(password, {
    algorithm: ARGON2ID,
  });
}

export async function verifyPassword(
  password: string,
  passwordHash: string,
): Promise<boolean> {
  return verify(passwordHash, password);
}
