import { prisma } from "@morfikos/database";

/** The one database client the API uses. Phase 6 adds tenant scoping here. */
export const db = prisma;
