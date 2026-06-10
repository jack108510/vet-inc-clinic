# Vet INC — Current System Architecture

**Live at:** clinic.vetinc.ca (repo: vet-inc-clinic)
**Supabase:** rnqhhzatlxmyvccdvqkr.supabase.co (Clinic IQ project)
**Data source:** Rosslyn Veterinary Clinic (AVImark PMS)
**Last updated:** June 8, 2026

---

## Data Flow Overview

```
AVImark (Rosslyn) → CSV export → Supabase raw tables → Dashboard reads directly
```

There is NO middle layer. The dashboard HTML makes direct fetch() calls to Supabase REST API using the anon key (public, read-only). No backend, no n8n, no API server.

---

## Supabase Tables (Current System)

### Raw AVImark Data (populated from CSV imports)
| Table | Rows | Purpose |
|-------|------|---------|
| `services` | 622,881 | Every line-item transaction. Code, description, amount, quantity, service_type, service_date, record_num |
| `items` | 4,998 | Service/product catalog. Code, name, dosage_form, unit_cost, service_code |
| `visits` | 46,182 | Visit records. record_num, visit_date, doctor, type_code, ref_id |
| `clients` | 13,967 | Client info. record_num, first_name, last_name, address, city, phone |
| `animals` | 26,687 | Patient records. record_num, name, species, breed, weight |
| `appointments` | 106,128 | Appointment history. record_num, appt_date, doctor, reason, flags |
| `vaccines` | 32,121 | Vaccination records. record_num, vaccine_date, doctor, manufacturer |
| `prescriptions` | 75,071 | Prescription records. record_num, rx_date, flags, ref_id |
| `procedures` | 407,606 | Procedure history. record_num, procedure_date, code, description, amount |

### Pre-Computed / Aggregated Tables
| Table | Rows | Purpose |
|-------|------|---------|
| `service_usage_agg` | ~5,000 | Aggregated service usage (code, total_amount, total_qty, txn_count, service_type) |
| `micro_margin_agg` | ~4,000 | Margin analysis per service (code, price, price_changed, sales_since_change, potential_uplift) |
| `prices` | ~5,000 | Current prices (treatment_code, price, updated_at) |
| `treatments` | ~5,000 | Treatment catalog (code, name, type_flag) |
| `item_names` | ~5,000 | Item name lookup (code, name) |
| `accounts` | ~100K+ | Financial transactions (txn_date, amount_raw, type_flag) |
| `item_unit_costs` | ~5,000 | Unit costs per item (code, unit_cost) |

### Daily KPI Tables (pre-computed)
| Table | Rows | Columns |
|-------|------|---------|
| `daily_kpis` | 3,051 | txn_day, visits, line_items, revenue, units_sold, unique_services, avg_line_amount |
| `daily_cogs` | 61 | day, revenue, visits, line_items, unique_services, cogs |
| `daily_staff_cost` | 226 | day, staff_cost, staff_hours, staff_count, shifts |
| `csi_pf_totals` | 2,791 | Multi-clinic daily totals (ros, gcc, rvv, tg, lmc, upc — clinic codes for daily revenue targets) |

### Campaign Tables (dashboard-managed)
| Table | Rows | Purpose |
|-------|------|---------|
| `campaigns` | 2 | Active campaigns (clinic_id=rosslyn, campaign_type, status, total_potential, total_items, implemented_items) |
| `campaign_items` | 43 | Individual service recommendations (campaign_id, code, name, current_price, suggested_price, potential_uplift, status) |
| `campaign_baselines` | 40 | Price snapshots at campaign start (campaign_id, code, price) |
| `campaign_history` | 0 | Audit trail (empty) |
| `campaign_alerts` | 0 | Campaign alerts |
| `campaign_snapshots` | 0 | Campaign snapshots |

### Other Tables
| Table | Rows | Purpose |
|-------|------|---------|
| `clinic_settings` | 1 | Clinic config (JSON settings) |
| `exam_pairings_mv` | 164 | Materialized view linking exams to other services |
| `price_watch` | 0 | Price change tracking |
| `insights` | 0 | Generated insights |

---

## Dashboard Tabs — Exact Data Sources

### Tab 1: Key Indicators (analytics)
**Function:** `loadDataAndBuild()` → `buildAnalytics()`
**Reads from:**
1. `service_usage_agg` — all service aggregated usage
2. `prices` — current prices
3. `treatments` — treatment catalog
4. `item_names` — name lookup
5. `accounts` — financial data
6. `micro_margin_agg` — margin data
7. `items` — for inventory usage estimation

**Also reads (on tab click):**
8. `daily_kpis` — KPI chart data (via click handler at line 4307)
9. `daily_cogs` — cost of goods
10. `daily_staff_cost` — labor costs
11. `csi_pf_totals` — multi-clinic revenue comparison
12. `services` — raw transaction search for specific dates

### Tab 2: Pricing Intelligence (campaigns)
**Function:** `loadCampaignState()` + campaign activation functions
**Reads from:**
1. `campaigns` — active campaign state (filtered by `clinic_id=rosslyn`)
2. `campaign_items` — individual recommendations per campaign
3. `campaign_baselines` — price snapshots
4. `micro_margin_agg` — for generating recommendations

**Writes to:**
1. `campaigns` — creates new campaigns
2. `campaign_items` — creates recommendations
3. `campaign_baselines` — captures baseline prices

**Campaign types:**
- `inflation_catchup` (campaign 1)
- `margin_growth` (campaign 2)
- `price_ending` (campaign 3) — the 99-cent pricing
- `loss_leader` (campaign 4)

### Tab 3: Insights & Actions
**Function:** `calLoad()` in insightsEngine.js
**Reads from:**
1. `services` — raw transaction patterns
2. `items` — catalog with costs
3. `exam_pairings_mv` — exam-to-service relationships
4. `price_watch` — price changes

### Tab 7: Settings
**Reads from:** `clinic_settings`

---

## Authentication

The dashboard uses the **anon key** (public, read-only):
```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJucWhoemF0bHhteXZjY2R2cWtyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUwMTQ5ODUsImV4cCI6MjA5MDU5MDk4NX0.zokle21pVEPG5bIOFiyZIWYkYIwhkolWNOhJ7Cbub30
```

Campaign writes also use the anon key (Supabase RLS allows it for the campaigns tables).

**Also defined in index.html:**
```javascript
const SB_URL = 'https://rnqhhzatlxmyvccdvqkr.supabase.co';
const SB_KEY = '<service_role_key>'; // Full access key used in some places
```

---

## Hardcoded Values

- **Clinic ID:** `rosslyn` — hardcoded in campaign queries
- **Clinic name:** "Rosslyn Veterinary Clinic" — hardcoded in header
- **Supabase URL + keys** — hardcoded inline in multiple places

---

## What Needs to Change for Multi-Tenant

1. **Remove hardcoded `clinic_id=rosslyn`** → use a variable from `clinic_settings` or URL param
2. **Point dashboard at `std_*` tables** instead of raw AVImark tables
3. **Pre-computed tables** (`service_usage_agg`, `micro_margin_agg`, etc.) need `clinic_id` column
4. **Campaign functions** already support `clinic_id` — just need to pass it dynamically
5. **CSI tables** (`csi_pf_totals`) are multi-clinic already (ros, gcc, rvv columns) — this is a different architecture than the standard schema

---

## Backup Strategy

The raw AVImark tables (`services`, `items`, `visits`, etc.) will be KEPT as-is. The `std_*` tables are a parallel standardized layer. If anything goes wrong, the current dashboard still reads from the original tables.

**Migration path:**
1. Keep current dashboard reading from raw tables (it works)
2. Build standardized layer alongside (`std_*` tables — DONE)
3. Refactor dashboard to read from `std_*` tables
4. Test numbers match
5. Deploy

At any point we can revert by pointing the dashboard back at the raw tables.

---

## Future System Design Notes (from Jack, June 8)

### Campaign 2: 99-Cent Pricing
- Must calculate per **individual line item**, NOT averaged prices
- For each transaction: round up to nearest X.99, sum the difference
- This captures quantity variations, price changes, and discounts that averaging hides

### Campaign 3: Margin Growth
- Container for **multiple sub-campaign types**, not a single calculation
- Sub-types could include:
  - Volume-based price bumps
  - Category-wide adjustments (e.g., all exams +5%)
  - Doctor-specific margin fixes
  - New service pricing
  - Custom per-clinic strategies
- Each sub-campaign has its own logic but lives under Margin Growth umbrella

### General Principle
- All calculations should work off individual transactions (`std_transactions`), not pre-aggregated data
- Pre-computed aggregation tables are for display/charts only, not pricing decisions
