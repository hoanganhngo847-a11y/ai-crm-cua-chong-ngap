import type { NextConfig } from "next";

import { NEXT_UPLOAD_TRANSPORT_MAX_BYTES } from "./config/upload-policy.ts";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: NEXT_UPLOAD_TRANSPORT_MAX_BYTES,
    },
    proxyClientMaxBodySize: NEXT_UPLOAD_TRANSPORT_MAX_BYTES,
  },
};

export default nextConfig;
