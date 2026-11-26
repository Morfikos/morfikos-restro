import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(import.meta.dirname, "../../"),
  transpilePackages: [
    "@morfikos/ui",
    "@morfikos/api-client",
    "@morfikos/access",
    "@morfikos/types",
    "@morfikos/validation",
  ],
  async rewrites() {
    const apiTarget = process.env.API_INTERNAL_URL ?? "http://127.0.0.1:3000";
    return [
      {
        source: "/api/:path*",
        destination: `${apiTarget}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
