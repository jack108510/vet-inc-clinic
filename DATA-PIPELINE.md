# Vet INC — Data Extraction & Standardization Pipeline

## Overview

Every clinic's PMS data follows this path:

```
PMS Export → Raw Tables (as-is) → Standardizer → std_* Tables (clean)
```

Nothing touches the dashboard until it's been standardized.

---

## Step 1: Raw Tables (Landing Zone)

Each PMS type has its own set of raw tables. Data lands exactly as the PMS exports it — no transformation, no cleaning, no filtering.

### AVImark Raw Tables
```sql
raw_avimark_services (
  id BIGINT GENERATED ALWAYS AS IDENTITY,
  clinic_id TEXT NOT NULL,
  record_num TEXT,
  service_type TEXT,
  code TEXT,
  description TEXT,
  amount NUMERIC,
  quantity NUMERIC,
  service_date DATE,
  created_at TIMESTAMPTZ DEFAULT NOW()
)

raw_avimark_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY,
  clinic_id TEXT NOT NULL,
  record_num TEXT,
  code TEXT,
  name TEXT,
  dosage_form TEXT,
  uom TEXT,
  pack_size TEXT,
  unit_cost NUMERIC,
  service_code TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
)

raw_avimark_visits (
  id BIGINT GENERATED ALWAYS AS IDENTITY,
  clinic_id TEXT NOT NULL,
  record_num TEXT,
  visit_date DATE,
  type_code TEXT,
  ref_id TEXT,
  doctor TEXT,
  field_48 TEXT,
  field_53 TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
)

raw_avimark_clients (
  id BIGINT GENERATED ALWAYS AS IDENTITY,
  clinic_id TEXT NOT NULL,
  record_num TEXT,
  first_name TEXT,
  last_name TEXT,
  address TEXT,
  city TEXT,
  province TEXT,
  postal_code TEXT,
  phone TEXT,
  phone2 TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
)

raw_avimark_animals (
  id BIGINT GENERATED ALWAYS AS IDENTITY,
  clinic_id TEXT NOT NULL,
  record_num TEXT,
  name TEXT,
  species TEXT,
  breed TEXT,
  color TEXT,
  weight NUMERIC,
  created_at TIMESTAMPTZ DEFAULT NOW()
)

raw_avimark_appointments (
  id BIGINT GENERATED ALWAYS AS IDENTITY,
  clinic_id TEXT NOT NULL,
  record_num TEXT,
  appt_date DATE,
  flags TEXT,
  doctor TEXT,
  reason TEXT,
  field_40 TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
)

raw_avimark_vaccines (
  id BIGINT GENERATED ALWAYS AS IDENTITY,
  clinic_id TEXT NOT NULL,
  record_num TEXT,
  vaccine_date DATE,
  serial_number TEXT,
  doctor TEXT,
  manufacturer TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
)

raw_avimark_prescriptions (
  id BIGINT GENERATED ALWAYS AS IDENTITY,
  clinic_id TEXT NOT NULL,
  record_num TEXT,
  rx_date DATE,
  flags TEXT,
  type_byte TEXT,
  ref_id TEXT,
  field_45 TEXT,
  field_46 TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
)

raw_avimark_procedures (
  id BIGINT GENERATED ALWAYS AS IDENTITY,
  clinic_id TEXT NOT NULL,
  record_num TEXT,
  procedure_date DATE,
  code TEXT,
  description TEXT,
  amount NUMERIC,
  field_type TEXT,
  ref_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
)

raw_avimark_extras (
  id BIGINT GENERATED ALWAYS AS IDENTITY,
  clinic_id TEXT NOT NULL,
  source_table TEXT NOT NULL,
  record_id TEXT,
  data JSONB,
  ingested_at TIMESTAMPTZ DEFAULT NOW()
)
```

### Cornerstone Raw Tables (structure TBD once we get a sample export)
```sql
raw_cornerstone_services (...)
raw_cornerstone_patients (...)
raw_cornerstone_invoices (...)
raw_cornerstone_extras (...)
```

---

## Step 2: Standardizer

The standardizer is a Node.js script that reads from raw tables, validates, cleans, and writes to `std_*` tables.

### Per-PMS standardizer:
```
standardizers/
├── avimark.js          # Maps raw_avimark_* → std_*
├── cornerstone.js      # Maps raw_cornerstone_* → std_*
├── impromed.js         # Maps raw_impromed_* → std_*
└── shared/
    ├── validator.js    # Common validation rules
    ├── cleaner.js      # Common cleaning functions
    └── reporter.js     # Data quality reporting
```

### Usage:
```bash
# Standardize a specific clinic
node standardizers/avimark.js --clinic-id rosslyn

# Standardize all clinics of a PMS type
node standardizers/avimark.js --all

# Dry run (validate only, no writes)
node standardizers/avimark.js --clinic-id belvedere --dry-run

# Incremental (only new/changed rows since last run)
node standardizers/avimark.js --clinic-id rosslyn --incremental
```

### What the standardizer does:

**1. Validate**
- Check required fields (service code, amount, date)
- Check data types (dates are dates, numbers are numbers)
- Check reasonable ranges (no $50,000 nail trims, no dates from 1899)
- Check for duplicates (same record_num + code + date)

**2. Clean**
- Trim whitespace from all text fields
- Normalize service names (trim, title case)
- Normalize species ("canine"/"CANINE"/"Dog" → "Canine")
- Normalize provinces ("alberta"/"AB" → "AB")
- Handle null/empty fields appropriately

**3. Map**
- Transform raw columns to `std_*` columns
- Assign correct `category` from PMS-specific type codes
- Generate unique IDs where needed
- Set `clinic_id` on every row

**4. Write**
- Upsert into `std_*` tables (idempotent — safe to re-run)
- Log every row that fails validation to `std_extractor_errors`
- Log the overall run to `std_extractor_log`
- Return a summary report

**5. Report**
```
═══════════════════════════════════════════
 Standardization Report — rosslyn (AVImark)
═══════════════════════════════════════════
 Duration: 47.2s

 Source: raw_avimark_*
 ┌──────────────────┬──────────┬──────────┬────────┐
 │ Table            │ Raw      │ Clean    │ Errors │
 ├──────────────────┼──────────┼──────────┼────────┤
 │ services         │ 622,881  │ 622,104  │ 777    │
 │ items            │ 4,998    │ 4,998    │ 0      │
 │ visits           │ 46,182   │ 46,180   │ 2      │
 │ clients          │ 13,967   │ 13,960   │ 7      │
 │ animals          │ 26,687   │ 26,500   │ 187    │
 │ appointments     │ 106,128  │ 106,128  │ 0      │
 │ vaccines         │ 32,121   │ 32,121   │ 0      │
 │ prescriptions    │ 75,071   │ 75,071   │ 0      │
 └──────────────────┴──────────┴──────────┴────────┘

 Error breakdown:
   null_field:      412 (67%)
   duplicate:       156 (25%)
   out_of_range:    38 (6%)
   bad_date:        12 (2%)

 Total: 99.87% success rate
 Status: SUCCESS
═══════════════════════════════════════════
```

---

## Step 3: Error Handling

### Row-level errors
```sql
std_extractor_errors (
  id BIGINT GENERATED ALWAYS AS IDENTITY,
  clinic_id TEXT NOT NULL,
  run_id UUID,               -- links to std_extractor_log
  extractor_type TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_row_id TEXT,
  error_type TEXT NOT NULL,   -- null_field, bad_date, duplicate, out_of_range, type_mismatch
  error_message TEXT,
  raw_data JSONB,             -- the full row that failed
  severity TEXT DEFAULT 'warning',  -- warning, critical
  resolved BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
)
```

### Alert thresholds
- **>1% error rate** → Telegram alert
- **>5% error rate** → Critical alert, pause standardization
- **0 rows processed** → Something broke, alert immediately
- **New error type** → Alert so we can investigate

---

## Step 4: Incremental Updates

For clinics with daily data feeds, the standardizer supports `--incremental`:

1. Check `std_extractor_log` for last successful run date
2. Only process raw rows created after that date
3. Upsert into `std_*` (existing rows updated, new rows inserted)
4. Refresh affected aggregation tables

This avoids re-processing 622K rows every time 50 new ones come in.

---

## AVImark Category Mapping

AVImark uses single-letter or short codes for service types. The standardizer maps them:

```json
{
  "OV": "exam",
  "OP": "exam",
  "SX": "surgery",
  "TX": "dental",
  "VX": "vaccine",
  "LAB": "lab",
  "AI": "pharmacy",
  "AM": "pharmacy",
  "AS": "pharmacy",
  "AX": "imaging",
  "MX": "other",
  "PX": "other",
  "RX": "other"
}
```

Clinics can customize this mapping in their `clinic_settings` if they use non-standard codes.

---

## Species Normalization

```json
{
  "canine": "Canine",
  "dog": "Canine",
  "feline": "Feline",
  "cat": "Feline",
  "equine": "Equine",
  "horse": "Equine",
  "avian": "Avian",
  "bird": "Avian",
  "reptile": "Reptile",
  "rabbit": "Lagomorph",
  "bunny": "Lagomorph",
  "rodent": "Rodent",
  "ferret": "Mustelid"
}
```

---

## Onboarding Checklist (Per Clinic)

1. [ ] Clinic registered in `std_clinics` + `meta_clinics`
2. [ ] PMS type identified
3. [ ] Raw data uploaded to `raw_{pms}_*` tables with `clinic_id`
4. [ ] Run standardizer with `--dry-run` → review data quality report
5. [ ] Fix any critical errors in raw data (or adjust mapping)
6. [ ] Run standardizer for real
7. [ ] Verify row counts match (raw vs std)
8. [ ] Run aggregation refresh
9. [ ] Dashboard accessible and numbers look correct
10. [ ] Create clinic admin account
11. [ ] Send login credentials to clinic owner
