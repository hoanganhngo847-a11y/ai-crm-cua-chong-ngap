import type { ReactNode } from "react";
// Authorization and tenant settings must be evaluated for every request.
export const dynamic = "force-dynamic";
export default function CampaignLayout({ children }: { children: ReactNode }) {
  return children;
}
