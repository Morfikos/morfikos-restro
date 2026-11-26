export const ENTITLEMENTS = [
  "qr_ordering",
  "kds",
  "inventory",
  "guest_loyalty",
  "upi_payments",
  "advanced_reports",
  "multi_branch",
  "floor_ai_import",
] as const;

export const RELEASE_FLAGS = ["new_billing_screen"] as const;

export type Entitlement = (typeof ENTITLEMENTS)[number];
export type ReleaseFlag = (typeof RELEASE_FLAGS)[number];
export type FlagKey = Entitlement | ReleaseFlag;

export const PLANS = ["starter", "standard", "pro"] as const;
export type Plan = (typeof PLANS)[number];

export const PLAN_FEATURES: Record<Plan, Entitlement[]> = {
  starter: ["kds"],
  standard: ["kds", "qr_ordering", "upi_payments", "guest_loyalty"],
  pro: [...ENTITLEMENTS],
};
