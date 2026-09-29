import { PrismaClient } from "@prisma/client";

const menuItemSelect = { id: true, name: true, priceCents: true } as const;

async function withPrisma<T>(run: (prisma: PrismaClient) => Promise<T>): Promise<T> {
  const prisma = new PrismaClient();

  try {
    await prisma.$connect();
    return await run(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

export function readMenuItems() {
  return withPrisma((prisma) =>
    prisma.menuItem.findMany({
      orderBy: { name: "asc" },
      select: menuItemSelect,
    }),
  );
}

export function upsertMenuItem(item: { id: string; name: string; priceCents: number }) {
  return withPrisma((prisma) =>
    prisma.menuItem.upsert({
      where: { id: item.id },
      update: { name: item.name, priceCents: item.priceCents },
      create: item,
      select: menuItemSelect,
    }),
  );
}
