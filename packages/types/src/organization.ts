export type OrganizationStatus = "active" | "inactive"

export interface Organization {
  id: string
  name: string
  gstin: string
  state: string
  city: string
  businessType: string
  phone: string
  email: string
  createdAt: string
  status: OrganizationStatus
}

export interface OrganizationBranch {
  id: string
  name: string
  tables: number
}

export interface OrganizationDetails extends Organization {
  branches: OrganizationBranch[]
  totalStaff: number
}
