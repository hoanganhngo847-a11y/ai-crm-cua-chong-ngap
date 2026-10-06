# Staging Host Evaluation — Commercial-Use Hosting Options

**Evaluation Date:** October 2026  
**Evaluation Scope:** Zero-cost / free-tier hosting for dedicated staging deployment of `ai-crm-cua-chong-ngap`.  
**Context:** Vercel Hobby was disqualified in STG-002 because its Terms of Service restrict usage to non-commercial personal projects. This CRM is a commercial enterprise application with sales, ordering, manufacturing, installation, and billing workflows.

---

## Evaluation Summary & Decision Matrix

| Hosting Provider / Tier | Commercial-Use Permitted? | Next.js 16 Runtime Compatibility | 10 MiB Upload Contract Preserved? | Status / Decision |
|:---|:---:|:---:|:---:|:---|
| **Koyeb Free** | **YES** (Standard MSA) | **Full Node.js Web Service** | **YES** (full HTTP streaming/buffering) | **PREFERRED CANDIDATE** (Not yet deployed) |
| **Render Free** | **YES** | Full Node.js Web Service | **YES** | **FALLBACK CANDIDATE** |
| **Netlify Free** | **YES** | Serverless Functions | **NO** (6 MB payload limit) | **REJECTED** |
| **Cloudflare Workers Free** | **YES** | OpenNext / Edge Runtime | **RISK** (10 ms CPU limit) | **REJECTED** |
| **Vercel Hobby** | **NO** (Personal use only) | Native | **NO** (disqualified by TOS) | **DISQUALIFIED (STG-002)** |
| **Vercel Pro** | **YES** | Native | **YES** | **PAID OPTION ($20/mo)** |

---

## 1. Preferred Candidate — Koyeb Free

- **Status:** `PREFERRED STAGING CANDIDATE — NOT YET DEPLOYED`
- **Runtime Model:** Full Node.js Web Service running in a lightweight microVM (Kuma engine).
- **Next.js Support:** Official Koyeb Next.js deployment support with zero edge runtime polyfill requirements.
- **Free Instance Allocation:**
  - **Memory:** 512 MB RAM (Eco instance)
  - **CPU:** 0.1 vCPU
  - **Disk:** 2 GB SSD local ephemeral storage (not used for persistent data)
  - **Service Quota:** 1 free web service per organization
- **Regions for Free Tier:** Frankfurt (`fra`), Washington, D.C. (`was`).
- **Idle Behavior & Spin-down:**
  - Standard Koyeb Free web services scale to zero after 1 hour of zero traffic.
  - **Continuous SLA Scheduler Interaction:** Because `cron-job.org` invokes `/api/cron/response-sla-worker` every 1 minute, the staging instance will normally remain awake once scheduler jobs are active.
- **Commercial / Professional Terms:** Koyeb Master Services Agreement (MSA) is written for customer professional and business use; commercial use is permitted across all tiers including Free.
- **Production Guard:** Koyeb Free instances are strictly **NOT** approved for production use.
- **Payment Verification Requirement:** Koyeb Starter plan requires a valid payment method / card validation for account anti-abuse verification, even though the Eco web instance itself incurs $0 charges.
- **Realistic Capacity Disclaimer:**
  - Koyeb Free offers **no contractual SLA** or uptime guarantee.
  - 0.1 vCPU and 512 MB RAM are **not yet proven** sufficient for heavy concurrent loads; real runtime behavior, memory consumption under 10 MiB uploads, and Turbopack SSR performance must be measured empirically during the STG-004 staging smoke test.

---

## 2. Fallback Candidate — Render Free

- **Status:** `FALLBACK CANDIDATE`
- **Runtime Model:** Full Node.js Web Service.
- **Free Instance Allocation:**
  - 512 MB RAM
  - 0.1 CPU
  - 750 free instance-hours per workspace per calendar month
  - Zero payment method required for initial account creation
- **Idle Behavior:**
  - Spins down after 15 minutes of inactivity.
  - Cold start latency: ~50–60 seconds upon first HTTP request.
- **Why It Is Fallback Rather Than Preferred:**
  - The external 1-minute Response SLA worker (`cron-job.org` triggering `/api/cron/response-sla-worker`) will generate constant requests every 60 seconds.
  - Constant requests prevent the 15-minute idle spin-down, keeping the service awake 24/7 (720–744 hours per month).
  - This would consume nearly the entire 750 monthly free instance-hour quota, leaving little to no margin for preview branches or end-of-month outages.

---

## 3. Rejected Candidate — Netlify Free

- **Status:** `CURRENTLY REJECTED`
- **Reason:** Transport Payload Truncation Conflicts with 10 MiB Upload Contract.
- **Evidence:**
  - Netlify provides strong Next.js support and commercial use on Free.
  - However, Netlify serverless functions enforce a strict **6 MB payload limit** on buffered request bodies.
  - In practice, binary multipart file uploads over Server Actions or API routes fail above approximately **4.5 MB**.
  - This directly violates the application's canonical 10 MiB upload requirement (`PRODUCT_UPLOAD_MAX_BYTES = 10 * 1024 * 1024`) for survey photos, installation field evidence, and signed contract PDFs.
- **Reconsideration Condition:** Netlify could only be reconsidered if the application upload architecture is completely redesigned to bypass function execution (e.g. direct client-to-storage signed uploads), which would require extensive architectural re-review.

---

## 4. Rejected Candidate — Cloudflare Workers Free

- **Status:** `CURRENTLY REJECTED`
- **Reason:** Strict CPU Execution Limits.
- **Evidence:**
  - Cloudflare OpenNext supports Next.js with high free request quotas (100,000 requests/day).
  - However, Cloudflare Workers Free enforces a maximum **10 ms CPU execution time** per request.
  - Server-side image binary signature validation, PDF structure inspection with `pdf-lib`, cryptographic HMAC computations, and session token verification routinely require 15–50 ms of active CPU time.
- **Reconsideration Condition:** Cloudflare Workers requires a paid Workers Paid plan ($5/mo) and a complete Node runtime migration audit before it could be considered safe for this CRM.

---

## Next Steps for STG-004

1. Deploy application to Koyeb Free Web Service using the canonical contract defined in `docs/STAGING_DEPLOYMENT.md`.
2. Conduct the real-browser hosted-upload smoke test specification (10 MiB JPEG/PDF roundtrip).
3. Benchmark memory consumption under 512 MB constraints during concurrent file handling.
