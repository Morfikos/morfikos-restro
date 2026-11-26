export const queryKeys = {
  me: () => ["auth", "me"] as const,
  health: () => ["health"] as const,
  menu: (branchId: string) => ["branch", branchId, "menu"] as const,
  floors: (branchId: string) => ["branch", branchId, "floors"] as const,
  tables: (branchId: string) => ["branch", branchId, "tables"] as const,
  orders: (branchId: string, filters?: Record<string, unknown>) =>
    ["branch", branchId, "orders", filters ?? {}] as const,
  order: (orderId: string) => ["order", orderId] as const,
  kdsTickets: (branchId: string, station?: string) =>
    ["branch", branchId, "kds", station ?? "all"] as const,
  bills: (branchId: string, filters?: Record<string, unknown>) =>
    ["branch", branchId, "bills", filters ?? {}] as const,
  payments: (branchId: string, filters?: Record<string, unknown>) =>
    ["branch", branchId, "payments", filters ?? {}] as const,
  invoices: (branchId: string, filters?: Record<string, unknown>) =>
    ["branch", branchId, "invoices", filters ?? {}] as const,
  guestSession: (token: string) => ["guest", "session", token] as const,
};
