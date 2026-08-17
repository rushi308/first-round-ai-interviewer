import type { NextConfig } from "next";
import path from "node:path";

const api = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001").replace(/\/$/, "");

const nextConfig: NextConfig = {
  transpilePackages: ["@ai-interviewer/shared"],
  outputFileTracingRoot: path.join(__dirname, "../.."),
  async rewrites() {
    return [{ source: "/backend/:path*", destination: `${api}/:path*` }];
  },
};

export default nextConfig;
