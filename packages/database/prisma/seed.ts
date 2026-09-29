import { PrismaClient } from "@prisma/client";
import { menuSeed } from "../src/menu-seed.ts";

const prisma = new PrismaClient();

for (const item of menuSeed) {
  await prisma.menuItem.upsert({
    where: { id: item.id },
    update: { name: item.name, priceCents: item.priceCents },
    create: item,
  });
}

await prisma.$disconnect();
