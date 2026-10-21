// import { PrismaClient } from "@prisma/client";
// import { hashPassword } from "@morfikos/auth";

// const prisma = new PrismaClient();

// // Development admin. Override with SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD.
// const adminEmail = (process.env.SEED_ADMIN_EMAIL ?? "admin@morfikos.local")
//   .trim()
//   .toLowerCase();
// const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? "Admin@12345";

// try {
//   const admin = await prisma.user.upsert({
//     where: { email: adminEmail },
//     update: {},
//     create: {
//       name: "Admin",
//       email: adminEmail,
//       passwordHash: await hashPassword(adminPassword),
//       role: "admin",
//     },
//   });

//   console.log(`Seeded admin user: ${admin.email}`);
// } finally {
//   await prisma.$disconnect();
// }

import { PrismaClient } from "@prisma/client";
import { hashPassword } from "@morfikos/auth";

const prisma = new PrismaClient();

// Development admin. Override with SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD.
const adminEmail = (process.env.SEED_ADMIN_EMAIL ?? "admin@morfikos.local")
  .trim()
  .toLowerCase();

const adminPassword =
  process.env.SEED_ADMIN_PASSWORD ?? "Admin@12345";

const systemRoleNames = [
  "admin",
  "owner",
  "manager",
  "waiter",
  "staff",
] as const;

try {
  // Create the admin user if it does not already exist.
  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      name: "Admin",
      email: adminEmail,
      passwordHash: await hashPassword(adminPassword),
      role: "admin",
    },
  });

  console.log(`Seeded admin user: ${admin.email}`);

  // Create missing global system roles.
  // Role currently has no unique constraint on its name.
  for (const name of systemRoleNames) {
    const existingRole = await prisma.role.findFirst({
      where: {
        name,
        organizationId: null,
        isSystem: true,
      },
      select: {
        id: true,
      },
    });

    if (!existingRole) {
      await prisma.role.create({
        data: {
          name,
          organizationId: null,
          isSystem: true,
        },
      });

      console.log(`Seeded system role: ${name}`);
    }
  }
} finally {
  await prisma.$disconnect();
}
