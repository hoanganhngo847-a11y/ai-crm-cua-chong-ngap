# Features / Analytics — Milestone M9.5A: Secure Analytics Data Layer

## 1. Overview
The Analytics module provides company-wide management analytics for executive decision-makers (`BOSS_ADMIN`).

Milestone M9.5A establishes the **secure database and data access layer**. It guarantees strict tenant isolation, immutable metric semantics, date-range bounds, role authorization, and complete aggregate-only output before building the dashboard UI (Milestone M9.5B).

---

## 2. Security Boundary & Authorization Model

Human management analytics can only be invoked by active **`BOSS_ADMIN`** members of the target company.

```
Caller (authenticated user session)
  │
  ▼
auth.uid() (Supabase user session)
  │
  ▼
user_profiles.status = 'ACTIVE'
  │
  ▼
company_members.company_id = p_company_id
  AND company_members.status = 'ACTIVE'
  AND company_members.role = 'BOSS_ADMIN'
  │
  ▼
Read-Only Aggregate DB RPC (SECURITY DEFINER, search_path = '')
```

### Access Control Rules:
1. **Denied Roles**:
   - `SALE`: Cannot view company-wide financial snapshots or aggregated analytics.
   - `TECHNICIAN`: Cannot view business performance metrics.
   - `anon` / unauthenticated: Immediate rejection (`UNAUTHENTICATED`).
   - `service_role`: Banned from calling human analytics RPCs (privileges explicitly `REVOKE`d).
2. **Cross-Company Isolation**:
   - All RPCs require `p_company_id`. An actor from Company A cannot query analytics for Company B (`ACTOR_MEMBERSHIP_NOT_FOUND`).
3. **Fail-Closed Execution**:
   - Inactive accounts or revoked memberships fail closed with PostgreSQL error code `42501`.

---

## 3. Zero Raw / Private Data Exposure

Analytics queries exclusively perform **read-only aggregations** on public canonical tables:
- `public.customers`
- `public.customer_stage_histories`
- `public.response_sla_windows`
- `public.calls`
- `public.appointments`
- `public.surveys`
- `public.orders`
- `public.finance_summaries`
- `public.care_deliveries`

The analytics data layer **never touches raw or private tables**:
- `private.customer_private_contacts`
- `private.interaction_raw_contents`
- `private.call_transcripts`
- `payment_transactions`

Outputs are strictly aggregate counts, decimals, and summary arrays. No customer names, phone numbers, interaction texts, call recordings, or order IDs are returned.

---

## 4. Date-Range Semantics: `[from, to)`

All time-bounded analytics adhere to standard **half-open interval semantics**:
$$\text{from} \le \text{event\_time} < \text{to}$$
- `from`: Inclusive. An event timestamped exactly at `from` is counted.
- `to`: Exclusive. An event timestamped exactly at `to` is not counted.

### Technical Bounds:
- `p_from` and `p_to` are mandatory (`timestamptz`).
- `p_from < p_to` must hold strictly.
- Date range cannot exceed 366 days (`p_to - p_from <= interval '366 days'`).
- Violations raise `INVALID_ANALYTICS_RANGE` (`22000`). Dates are never silently swapped or defaulted.

---

## 5. Metric Semantics & Invariants

| Domain | Field | Metric Type | Source Canonical Table | Event Timestamp Used |
| :--- | :--- | :--- | :--- | :--- |
| **Customers** | `newCustomers` | Period | `public.customers` | `created_at` |
| **Customers** | `bySource` | Period | `public.customers` | `created_at` |
| **Customers** | `currentStageDistribution` | **Snapshot** | `public.customers` | N/A (current `stage`) |
| **Customers** | `stageTransitions` | Period | `public.customer_stage_histories` | `changed_at` |
| **SLA** | `windowsStarted` | Period | `public.response_sla_windows` | `started_at` |
| **SLA** | `saleRespondedWithin5m` | Period | `public.response_sla_windows` | `started_at` (`resolved_at <= deadline_at`) |
| **SLA** | `saleRespondedAfter5m` | Period | `public.response_sla_windows` | `started_at` (`resolved_at > deadline_at`) |
| **SLA** | `aiResponded` | Period | `public.response_sla_windows` | `started_at` |
| **Calls** | `totalCalls`, `inboundCalls`, `outboundCalls`, etc. | Period | `public.calls` | `started_at` |
| **Surveys** | `completedSurveys` | Period | `public.surveys` | `completed_at` |
| **Orders** | `ordersCreated`, `orderValueCreated` | Period | `public.orders` | `created_at` |
| **Finance** | `contractValue`, `collectedAmount`, `receivableAmount`, `completedRevenue` | **Snapshot** | `public.finance_summaries` | N/A (current order state "as of now") |
| **Care** | `careSent` | Period | `public.care_deliveries` | `sent_at` |
| **Care** | `careDelivered` | Period | `public.care_deliveries` | `delivered_at` |
| **Care** | `careResponded` | Period | `public.care_deliveries` | `responded_at` |
| **Care** | `careConvertedToSale` | Period | `public.care_deliveries` | `converted_to_sale_at` |

### Critical Semantic Distinctions:
1. **`currentStageDistribution` vs `stageTransitions`**:
   - `currentStageDistribution` is a snapshot of all customers currently in each pipeline stage. It is **not** a funnel conversion of the selected period.
   - `stageTransitions` counts transition events that occurred within `[from, to)`. A single customer may experience multiple stage transitions in a given period.
2. **`orderValueCreated != revenue`**:
   - `orderValueCreated` is the sum of `final_amount` on orders created within `[from, to)`. It does not indicate collected cash or completed revenue.
3. **Finance Snapshot is "As of Now"**:
   - `finance_summaries` reflects the latest state of all orders in the company. It is **not filtered by `[from, to)`** and cannot produce a historical daily trend.
4. **Care Delivery Integrity**:
   - Campaign counts are aggregated from event records in `care_deliveries`, never trusting unverified counters in `care_campaigns`.

---

## 6. Daily Time-Series Semantics

RPC `public.get_company_analytics_daily_series` provides chronological daily metrics for event-driven sources:
- UTC day buckets are generated using `generate_series`.
- Only trustworthy event-based metrics are included:
  - `newCustomers`
  - `ordersCreated`
  - `orderValueCreated`
  - `slaWindowsStarted`
  - `saleWithin5m`
  - `aiResponded`
  - `careConvertedToSale`
- **Finance metrics are excluded** because there is no historical daily revenue ledger.
- Days without activity return `0` counts and `"0.00"` money amounts.

---

## 7. Numeric & Currency Safety

- All money amounts are calculated via PostgreSQL `numeric(15,2)` and serialized to strings (e.g. `"12500000.00"`, `"0.00"`).
- Contract type: `type MoneyDecimal = string`.
- JavaScript binary floating-point (`number`) is forbidden for financial source-of-truth calculations.

---

## 8. Empty Dataset Semantics

When no data matches the query or the company is newly created:
- **Counts**: `0` (never `null`).
- **Money amounts**: `"0.00"` (never `null`).
- **Averages** (e.g., `avgSaleResponseSeconds`): `null` (never `NaN` or `Infinity`).
- **Arrays** (e.g., `bySource`, `byStatus`, `series`): `[]` (never `null`).
