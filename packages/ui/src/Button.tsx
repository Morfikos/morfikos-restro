import type { ComponentPropsWithoutRef, ReactNode } from "react";

export interface ButtonProps extends ComponentPropsWithoutRef<"button"> {
  variant?: "primary" | "secondary";
  children?: ReactNode;
}

export function Button({
  variant = "primary",
  style,
  ...props
}: ButtonProps) {
  const isPrimary = variant === "primary";
  return (
    <button
      {...props}
      style={{
        padding: "8px 14px",
        borderRadius: "var(--radius-md)",
        border: isPrimary ? "none" : "1px solid var(--border-primary)",
        backgroundColor: isPrimary ? "var(--brand-600)" : "var(--bg-primary)",
        color: isPrimary ? "#ffffff" : "var(--text-primary)",
        fontWeight: 600,
        fontSize: "14px",
        cursor: "pointer",
        ...style,
      }}
    />
  );
}
