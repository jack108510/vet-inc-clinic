# Vet INC — Multi-Tenant Architecture Plan

## The Problem

Right now everything is hardcoded to Rosslyn. One clinic, one Supabase project, one dashboard. We need to support N clinics without rebuilding for each one.

## Architecture Options

### Option A: Shared Database, Row-Level Isolation
Every clinic shares the same `std_*` tables. Data is isolated by `clinic_id` column.

```
std_transactions
├── clinic_id = "rosslyn" → 622K rows
├── clinic_id = "clinic_b" → their rows
└── clinic_id = "clinic_c" → their rows
```

**Pros:**
- Single database to manage
- Cross-clinic analytics possible (benchmarking, industry reports)
- Easy to add new clinics — just insert rows with a new clinic_id
- Cheaper — one Supabase project

**Cons:**
- If one clinic's data gets corrupted, it affects the shared tables
- Row-level security (RLS) is critical — a misconfigured policy leaks data
- Performance degrades as total rows grow across all clinics
- Hard to give a clinic their own database access

### Option B: Separate Schemas Per Clinic
Each clinic gets their own schema within the same Supabase project.

```
clinic_rosslyn.std_transactions
clinic_b.std_transactions
clinic_c.std_transactions
```

**Pros:**
- Strong isolation — no risk of cross-clinic data leaks
- Can optimize per-clinic (indexes, partitions)
- Easier to delete/export a clinic's data
- RLS is simpler — each schema is already isolated

**Cons:**
- Schema migrations need to run N times (one per clinic)
- Cross-clinic analytics requires querying across schemas (harder)
- More complex dashboard — needs to know which schema to hit
- Still one Supabase project — storage/performance is shared

### Option C: Separate Supabase Projects Per Clinic
Each clinic gets their own Supabase project entirely.

**Pros:**
- Maximum isolation
- No shared performance concerns
- Clinic can be given admin access to their own project
- Easy to delete — just delete the project
- No RLS complexity

**Cons:**
- Expensive (each project has costs)
- Migrations must run across N projects
- No cross-clinic analytics without a separate aggregation layer
- Operational complexity — managing many projects

### RECOMMENDATION: Option A with a twist

**Shared tables with `clinic_id`, plus a master analytics schema.**

```
std_transactions (shared, RLS by clinic_id)
std_services (shared, RLS by clinic_id)
std_daily_kpis (shared, RLS by clinic_id)
...

meta_clinics (clinic registry)
meta_users (login, clinic access)
meta_benchmarks (cross-clinic aggregated stats)
```

**Why:**
1. Vet INC's future value is in benchmarking — "your exam margin is 15% below the average for your region." That only works with shared data.
2. We're early. We won't have 100 clinics tomorrow. Shared tables won't have performance issues for a long time.
3. Adding a new clinic is just INSERT rows — no schema changes, no new projects.
4. If we ever need to split, we can migrate a clinic to their own project later.

## Multi-Tenant Data Flow

```
┌─────────────┐
│  Clinic A    │──┐
│  (AVImark)   │  │
└─────────────┘  │     ┌──────────────┐     ┌──────────────┐
                  ├────▶│ Standardizer │────▶│  std_*       │
┌─────────────┐  │     │  (per PMS)   │     │  tables      │
│  Clinic B    │──┤     └──────────────┘     │  (shared)    │
│(Cornerstone) │  │                           │              │
└─────────────┘  │     ┌──────────────┐     │  RLS by      │
                  ├────▶│ Standardizer │────▶│  clinic_id   │
┌─────────────┐  │     │  (per PMS)   │     └──────┬───────┘
│  Clinic C    │──┘     └──────────────┘             │
│  (Impromed)  │                                     ▼
└─────────────┘                              ┌──────────────┐
                                             │  Dashboard   │
                                             │  (reads by   │
                                             │  clinic_id)  │
                                             └──────────────┘
```

## Authentication & Access Control

### How it works:
1. User logs in (email/password or magic link)
2. `meta_users` table links user to one or more clinics
3. Dashboard fetches the user's clinic_id from auth
4. Every Supabase query adds `?clinic_id=eq.{their_clinic}`
5. RLS policies enforce this at the database level — even if the frontend is compromised, they can't see another clinic's data

### Tables needed:
```sql
meta_users (
  id uuid PRIMARY KEY,
  email text,
  name text,
  role text DEFAULT 'clinic_admin',
  created_at timestamptz
)

meta_clinic_users (
  user_id uuid REFERENCES meta_users(id),
  clinic_id text REFERENCES std_clinics(clic_id),
  role text DEFAULT 'viewer', -- viewer, editor, admin
  PRIMARY KEY (user_id, clinic_id)
)
```

### Supabase Auth + RLS:
- Use Supabase built-in Auth (not custom)
- RLS policies check `auth.uid()` against `meta_clinic_users`
- The dashboard uses the user's JWT token, not a service role key
- Service role key only used by backend processes (standardizer, aggregations)

## Onboarding a New Clinic

**Step 1:** Register clinic
```sql
INSERT INTO std_clinics (clinic_id, name, pms_type, currency, timezone, country)
VALUES ('belvedere', 'Belvedere Vet Clinic', 'cornerstone', 'CAD', 'America/Edmonton', 'CA');
```

**Step 2:** Create clinic admin user
```sql
-- Via Supabase Auth API
-- Then link:
INSERT INTO meta_clinic_users (user_id, clinic_id, role)
VALUES (new_user_id, 'belvedere', 'admin');
```

**Step 3:** Run PMS standardizer
```bash
node standardize-cornerstone.js --clinic-id belvedere --input ./data/belvedere-export/
```

**Step 4:** Pre-compute aggregation tables
```sql
-- Refresh materialized views or run aggregation functions
SELECT refresh_clinic_aggregates('belvedere');
```

**Step 5:** Clinic admin logs in → sees their dashboard

## Aggregation Strategy

Raw `std_transactions` is too large for the dashboard to query directly (622K rows for one clinic, millions for many).

**Pre-computed per clinic:**
```sql
-- Refreshed daily or on new data load
std_service_usage_agg (
  clinic_id, service_code, 
  total_amount, total_qty, txn_count, 
  avg_price, service_type, period
)

std_service_prices (
  clinic_id, code, price, 
  last_changed, inflation_factor, suggested_price
)

std_daily_kpis (already exists)

std_monthly_kpis (
  clinic_id, month, revenue, visits, avg_invoice, unique_services
)
```

These are computed by a scheduled function (Supabase pg_cron or external cron) that runs:
```sql
SELECT refresh_clinic_aggregates('rosslyn');
```

## What NOT to Do (Traps to Avoid)

1. **Don't hardcode clinic_id in the frontend** — always derive from auth
2. **Don't use the anon key for authenticated users** — use their JWT
3. **Don't query raw transaction tables from the dashboard** — always use aggregation tables
4. **Don't build clinic-specific features in the dashboard HTML** — feature flags per clinic, same UI
5. **Don't skip RLS** — even if only one clinic, build it right from day one
6. **Don't use separate repos/deployments per clinic** — one dashboard, configured by clinic_id
7. **Don't put PMS-specific logic in the dashboard** — that belongs in the standardizer only

## Migration Plan

### Phase 1: Current State → Multi-Tenant Ready
- [x] Create `std_*` tables
- [ ] Fix standardizer to run full 622K Rosslyn data cleanly
- [ ] Create `meta_users` and `meta_clinic_users` tables
- [ ] Enable Supabase Auth on the project
- [ ] Add RLS policies to all `std_*` tables
- [ ] Refactor dashboard to read from `std_*` instead of raw tables
- [ ] Test: Rosslyn dashboard works identically on `std_*` data

### Phase 2: Multi-Tenant Dashboard
- [ ] Add login page (Supabase Auth)
- [ ] Dashboard reads clinic_id from JWT
- [ ] All queries include clinic_id filter
- [ ] Clinic selector for users with multiple clinics
- [ ] Test with a second clinic's data

### Phase 3: Self-Service Onboarding
- [ ] Upload flow for PMS data files
- [ ] Auto-detect PMS type
- [ ] Run standardizer in background
- [ ] Email notification when dashboard is ready

## Cost Estimate (Supabase)

- **Free tier:** 500MB database, 1GB bandwidth — enough for a few clinics
- **Pro tier ($25/mo):** 8GB database — enough for ~20 clinics
- **Team tier ($599/mo):** Only needed when we want SOC2, SSO, etc.

We're nowhere near needing more than Pro for a long time.
