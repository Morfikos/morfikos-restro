import { db as prisma } from "../../plugins/db.js";
import type { CreateOrganizationInput } from "@morfikos/validation"


export async function createOrganization(
  data: CreateOrganizationInput,
) {
  return prisma.organization.create({
    data: {
      name: data.name,
      gstin: data.gstin,
      state: data.state,
      city: data.city,
      businessType: data.businessType,
      phone: data.phone,
      email: data.email,
      status: "active",
    },
  })
}

export async function getOrganization(id: string) {
  const organization = await prisma.organization.findUnique({
    where: {
      id,
    },
    include: {
      branches: true,
    },
  })

  if (!organization) {
    return null
  }

  const totalStaff = await prisma.staff.count({
    where: {
      organizationId: id,
    },
  })

  return {
    id: organization.id,
    name: organization.name,
    gstin: organization.gstin,
    state: organization.state,
    city: organization.city,
    businessType: organization.businessType,
    phone: organization.phone,
    email: organization.email,
    createdAt: organization.createdAt.toISOString(),
    status: organization.status,

    branches: organization.branches.map((branch) => ({
      id: branch.id,
      name: branch.name,
      tables: branch.tables,
    })),

    totalStaff,
  }
}