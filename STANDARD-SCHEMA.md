# Vet INC Standard Data Schema

**Purpose:** A PMS-agnostic data layer. All extractors transform PMS-specific data into these tables. The dashboard, campaign engine, and insights engine ONLY read from these tables.

**Architecture:**
```
AVImark ──┐
Cornerstone ──→ Extractor → Standard Tables → Dashboard / Engine
Impromed ──┘
```

---

## Core Tables (Required)

### `std_services`
The master service catalog. Every billable item the clinic offers.

| Column | Type | Description |
|--------|------|-------------|
| clinic_id | text | Clinic identifier (e.g. "rosslyn") |
| code | text | Service code from PMS |
| name | text | Human-readable name |
| category | text | Service category (exam, surgery, lab, vaccine, etc.) |
| price | numeric | Current price |
| cost | numeric | Unit cost (if known) |
| active | boolean | Currently offered? |
| updated_at | timestamptz | Last price change |

### `std_transactions`
Every line-item charge. The raw revenue data.

| Column | Type | Description |
|--------|------|-------------|
| clinic_id | text | |
| txn_date | date | Date of transaction |
| txn_id | text | Unique transaction/visit ID |
| service_code | text | Links to std_services.code |
| description | text | What was done |
| quantity | numeric | How many units |
| amount | numeric | Line total (price × qty) |
| doctor | text | Attending veterinarian |
| client_id | text | Client reference |
| patient_id | text | Patient/animal reference |
| service_type | text | Category override if needed |

### `std_visits`
Aggregated visit-level data.

| Column | Type | Description |
|--------|------|-------------|
| clinic_id | text | |
| visit_date | date | |
| visit_id | text | Links to txn_id group |
| doctor | text | |
| reason | text | Visit reason (if available) |
| total_amount | numeric | Sum of all line items |
| line_item_count | integer | Number of services billed |
| client_id | text | |
| patient_id | text | |

### `std_daily_kpis`
Pre-computed daily metrics. Updated by the engine.

| Column | Type | Description |
|--------|------|-------------|
| clinic_id | text | |
| day | date | |
| revenue | numeric | Total revenue for the day |
| visits | integer | Number of visits |
| line_items | integer | Total services billed |
| avg_line_amount | numeric | Average charge per line item |
| unique_services | integer | Distinct service codes used |

---

## Campaign Tables (Engine-Managed)

### `campaigns`
Created by the pricing engine, not the extractor.

| Column | Type | Description |
|--------|------|-------------|
| clinic_id | text | |
| campaign_type | text | inflation_catchup / margin_growth / loss_leader / price_ending |
| status | text | active / implemented / archived |
| created_at | timestamptz | |
| total_potential | numeric | Sum of all item uplifts |

### `campaign_items`
Individual service-level recommendations within a campaign.

| Column | Type | Description |
|--------|------|-------------|
| campaign_id | text | Links to campaigns |
| clinic_id | text | |
| code | text | Service code |
| name | text | Service name |
| current_price | numeric | |
| suggested_price | numeric | |
| potential_uplift | numeric | Monthly revenue gain |
| price_changed | boolean | Has the clinic updated the price? |
| sales_since_change | integer | Transactions since price was changed |
| captured_uplift | numeric | Actual revenue captured after change |
| implemented_at | timestamptz | When clinic accepted |
| status | text | pending / implemented / dismissed |

### `campaign_baselines`
Snapshot of prices before a campaign starts.

| Column | Type | Description |
|--------|------|-------------|
| clinic_id | text | |
| campaign_id | text | |
| code | text | |
| price | numeric | Price at time of baseline capture |
| avg_monthly_volume | numeric | Historical monthly usage |
| captured_at | timestamptz | |

### `campaign_history`
Audit trail of all campaign actions.

| Column | Type | Description |
|--------|------|-------------|
| clinic_id | text | |
| campaign_id | text | |
| action | text | created / item_implemented / item_dismissed / completed |
| details | jsonb | Arbitrary metadata |
| performed_at | timestamptz | |

---

## Cost Tables (Optional — enhances margin analysis)

### `std_daily_cogs`
Daily cost of goods sold.

| Column | Type | Description |
|--------|------|-------------|
| clinic_id | text | |
| day | date | |
| cogs | numeric | Total COGS for the day |

### `std_daily_staff_cost`
Daily labor costs.

| Column | Type | Description |
|--------|------|-------------|
| clinic_id | text | |
| day | date | |
| staff_cost | numeric | Total staff cost |
| staff_hours | numeric | Total hours worked |
| staff_count | integer | Number of staff |
| shifts | integer | Number of shifts |

---

## Clinic Config

### `clinic_settings`
Per-clinic configuration.

| Column | Type | Description |
|--------|------|-------------|
| clinic_id | text | Primary key |
| name | text | Clinic display name |
| pms_type | text | avimark / cornerstone / impromed / intravet / other |
| currency | text | CAD / USD |
| timezone | text | |
| onboarded_at | timestamptz | |
| settings | jsonb | Arbitrary config (margin targets, etc.) |

---

## Extractor Contract

Each PMS extractor MUST:

1. **Write to `std_*` tables only** — never to raw PMS tables
2. **Include `clinic_id`** on every row
3. **Run idempotently** — safe to re-run for the same date range
4. **Handle duplicates** — upsert on (clinic_id, txn_id, service_code) or equivalent
5. **Normalize categories** — map PMS-specific categories to the standard set:
   - exam, surgery, lab, vaccine, dental, imaging, pharmacy, boarding, grooming, emergency, other

### Standard Category Mapping

Each extractor provides a mapping file:
```json
{
  "PMS_CATEGORY": "std_category",
  "OV": "exam",
  "SX": "surgery",
  "LAB": "lab",
  "VX": "vaccine"
}
```

---

## Migration Plan

1. Create `std_*` tables in Supabase
2. Build AVImark → std extractor (we have 622K Rosslyn services to convert)
3. Refactor dashboard to read from `std_*` instead of raw tables
4. Verify numbers match current dashboard
5. Cornerstone extractor becomes trivial — just a new mapping file
