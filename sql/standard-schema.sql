-- Vet INC Standard Data Schema
-- PMS-agnostic. All extractors write here. Dashboard/engine reads only from here.
-- Deploy to: Cliniciq Supabase (rnqhhzatlxmyvccdvqkr.supabase.co)

-- ============================================================
-- CLINIC CONFIG
-- ============================================================

CREATE TABLE IF NOT EXISTS std_clinics (
  clinic_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  pms_type TEXT NOT NULL CHECK (pms_type IN ('avimark','cornerstone','impromed','intravet','other')),
  currency TEXT DEFAULT 'CAD',
  timezone TEXT DEFAULT 'America/Edmonton',
  country TEXT DEFAULT 'CA',
  onboarded_at TIMESTAMPTZ DEFAULT NOW(),
  settings JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- SERVICE CATALOG
-- ============================================================

CREATE TABLE IF NOT EXISTS std_services (
  clinic_id TEXT NOT NULL REFERENCES std_clinics(clinic_id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('exam','surgery','lab','vaccine','dental','imaging','pharmacy','boarding','grooming','emergency','wellness','nutrition','behaviour','other')),
  price NUMERIC(10,2),
  cost NUMERIC(10,2),
  active BOOLEAN DEFAULT TRUE,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(clinic_id, code)
);

-- ============================================================
-- TRANSACTIONS (line items)
-- ============================================================

CREATE TABLE IF NOT EXISTS std_transactions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id TEXT NOT NULL REFERENCES std_clinics(clinic_id),
  txn_date DATE NOT NULL,
  txn_id TEXT NOT NULL,
  line_num INTEGER DEFAULT 1,
  service_code TEXT NOT NULL,
  description TEXT,
  quantity NUMERIC(10,2) DEFAULT 1,
  amount NUMERIC(10,2) NOT NULL,
  doctor TEXT,
  client_id TEXT,
  patient_id TEXT,
  service_type TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(clinic_id, txn_id, line_num)
);
CREATE INDEX idx_txn_clinic_date ON std_transactions(clinic_id, txn_date);
CREATE INDEX idx_txn_clinic_code ON std_transactions(clinic_id, service_code);
CREATE INDEX idx_txn_clinic_doctor ON std_transactions(clinic_id, doctor);

-- ============================================================
-- VISITS
-- ============================================================

CREATE TABLE IF NOT EXISTS std_visits (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id TEXT NOT NULL REFERENCES std_clinics(clinic_id),
  visit_date DATE NOT NULL,
  visit_id TEXT NOT NULL,
  doctor TEXT,
  reason TEXT,
  total_amount NUMERIC(10,2),
  line_item_count INTEGER DEFAULT 0,
  client_id TEXT,
  patient_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(clinic_id, visit_id)
);
CREATE INDEX idx_visits_clinic_date ON std_visits(clinic_id, visit_date);

-- ============================================================
-- CLIENTS
-- ============================================================

CREATE TABLE IF NOT EXISTS std_clients (
  clinic_id TEXT NOT NULL REFERENCES std_clinics(clinic_id),
  client_id TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  email TEXT,
  phone TEXT,
  city TEXT,
  province TEXT,
  postal_code TEXT,
  first_visit DATE,
  last_visit DATE,
  total_visits INTEGER DEFAULT 0,
  total_revenue NUMERIC(10,2) DEFAULT 0,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(clinic_id, client_id)
);

-- ============================================================
-- PATIENTS (animals)
-- ============================================================

CREATE TABLE IF NOT EXISTS std_patients (
  clinic_id TEXT NOT NULL REFERENCES std_clinics(clinic_id),
  patient_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  name TEXT,
  species TEXT,
  breed TEXT,
  date_of_birth DATE,
  weight NUMERIC(6,2),
  sex TEXT,
  neutered BOOLEAN,
  deceased BOOLEAN DEFAULT FALSE,
  deceased_date DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(clinic_id, patient_id)
);

-- ============================================================
-- APPOINTMENTS
-- ============================================================

CREATE TABLE IF NOT EXISTS std_appointments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id TEXT NOT NULL REFERENCES std_clinics(clinic_id),
  appointment_id TEXT NOT NULL,
  appointment_date DATE NOT NULL,
  appointment_time TIME,
  doctor TEXT,
  client_id TEXT,
  patient_id TEXT,
  reason TEXT,
  status TEXT CHECK (status IN ('scheduled','completed','cancelled','no_show','rescheduled')),
  duration_minutes INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(clinic_id, appointment_id)
);
CREATE INDEX idx_appt_clinic_date ON std_appointments(clinic_id, appointment_date);

-- ============================================================
-- VACCINES
-- ============================================================

CREATE TABLE IF NOT EXISTS std_vaccines (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id TEXT NOT NULL REFERENCES std_clinics(clinic_id),
  patient_id TEXT NOT NULL,
  client_id TEXT,
  vaccine_date DATE NOT NULL,
  vaccine_name TEXT,
  service_code TEXT,
  doctor TEXT,
  next_due DATE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_vax_clinic_patient ON std_vaccines(clinic_id, patient_id);

-- ============================================================
-- PRESCRIPTIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS std_prescriptions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id TEXT NOT NULL REFERENCES std_clinics(clinic_id),
  prescription_id TEXT NOT NULL,
  patient_id TEXT,
  client_id TEXT,
  doctor TEXT,
  prescribed_date DATE,
  product_name TEXT,
  product_code TEXT,
  quantity NUMERIC(10,2),
  refills INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(clinic_id, prescription_id)
);

-- ============================================================
-- INVENTORY
-- ============================================================

CREATE TABLE IF NOT EXISTS std_inventory (
  clinic_id TEXT NOT NULL REFERENCES std_clinics(clinic_id),
  product_code TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT,
  quantity_on_hand NUMERIC(10,2) DEFAULT 0,
  unit_cost NUMERIC(10,2),
  unit_price NUMERIC(10,2),
  reorder_point NUMERIC(10,2),
  vendor TEXT,
  last_ordered DATE,
  active BOOLEAN DEFAULT TRUE,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(clinic_id, product_code)
);

-- ============================================================
-- PURCHASE ORDERS
-- ============================================================

CREATE TABLE IF NOT EXISTS std_purchase_orders (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id TEXT NOT NULL REFERENCES std_clinics(clinic_id),
  order_date DATE NOT NULL,
  vendor TEXT,
  total_cost NUMERIC(10,2),
  items JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- STAFF
-- ============================================================

CREATE TABLE IF NOT EXISTS std_staff (
  clinic_id TEXT NOT NULL REFERENCES std_clinics(clinic_id),
  staff_id TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT,
  is_vet BOOLEAN DEFAULT FALSE,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(clinic_id, staff_id)
);

-- ============================================================
-- SHIFTS
-- ============================================================

CREATE TABLE IF NOT EXISTS std_shifts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id TEXT NOT NULL REFERENCES std_clinics(clinic_id),
  staff_id TEXT NOT NULL,
  shift_date DATE NOT NULL,
  hours_worked NUMERIC(5,2),
  cost NUMERIC(10,2),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_shifts_clinic_date ON std_shifts(clinic_id, shift_date);

-- ============================================================
-- DAILY KPIs (computed)
-- ============================================================

CREATE TABLE IF NOT EXISTS std_daily_kpis (
  clinic_id TEXT NOT NULL REFERENCES std_clinics(clinic_id),
  day DATE NOT NULL,
  revenue NUMERIC(12,2),
  visits INTEGER,
  line_items INTEGER,
  avg_line_amount NUMERIC(10,2),
  unique_services INTEGER,
  new_clients INTEGER DEFAULT 0,
  returning_clients INTEGER DEFAULT 0,
  no_shows INTEGER DEFAULT 0,
  cogs NUMERIC(10,2),
  staff_cost NUMERIC(10,2),
  gross_margin NUMERIC(10,2),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(clinic_id, day)
);

-- ============================================================
-- MEDICAL RECORDS (for AI Assistant)
-- ============================================================

CREATE TABLE IF NOT EXISTS std_medical_records (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id TEXT NOT NULL REFERENCES std_clinics(clinic_id),
  visit_id TEXT,
  patient_id TEXT,
  client_id TEXT,
  doctor TEXT,
  record_date DATE NOT NULL,
  record_type TEXT,
  diagnosis TEXT,
  treatment TEXT,
  notes TEXT,
  weight NUMERIC(6,2),
  temperature NUMERIC(4,1),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_med_clinic_patient ON std_medical_records(clinic_id, patient_id);
CREATE INDEX idx_med_clinic_date ON std_medical_records(clinic_id, record_date);

-- ============================================================
-- DIAGNOSES
-- ============================================================

CREATE TABLE IF NOT EXISTS std_diagnoses (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id TEXT NOT NULL REFERENCES std_clinics(clinic_id),
  patient_id TEXT,
  visit_id TEXT,
  diagnosis_date DATE NOT NULL,
  diagnosis_code TEXT,
  diagnosis_name TEXT,
  doctor TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- EXTRACTOR LOG (audit trail)
-- ============================================================

CREATE TABLE IF NOT EXISTS std_extractor_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id TEXT NOT NULL,
  extractor_type TEXT NOT NULL,
  run_at TIMESTAMPTZ DEFAULT NOW(),
  date_from DATE,
  date_to DATE,
  rows_processed INTEGER,
  rows_inserted INTEGER,
  rows_updated INTEGER,
  status TEXT CHECK (status IN ('success','partial','failed')),
  error_message TEXT,
  duration_ms INTEGER
);

-- ============================================================
-- RLS — enable on all tables
-- ============================================================

ALTER TABLE std_clinics ENABLE ROW LEVEL SECURITY;
ALTER TABLE std_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE std_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE std_visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE std_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE std_patients ENABLE ROW LEVEL SECURITY;
ALTER TABLE std_appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE std_vaccines ENABLE ROW LEVEL SECURITY;
ALTER TABLE std_prescriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE std_inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE std_purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE std_staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE std_shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE std_daily_kpis ENABLE ROW LEVEL SECURITY;
ALTER TABLE std_medical_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE std_diagnoses ENABLE ROW LEVEL SECURITY;
ALTER TABLE std_extractor_log ENABLE ROW LEVEL SECURITY;

-- Service role full access (what the extractor/dashboard use)
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'std_clinics','std_services','std_transactions','std_visits',
    'std_clients','std_patients','std_appointments','std_vaccines',
    'std_prescriptions','std_inventory','std_purchase_orders',
    'std_staff','std_shifts','std_daily_kpis',
    'std_medical_records','std_diagnoses','std_extractor_log'
  ] LOOP
    EXECUTE format('CREATE POLICY "service_full" ON %I FOR ALL USING (auth.role() = ''service_role'') WITH CHECK (auth.role() = ''service_role'')', t);
  END LOOP;
END;
$$;

-- ============================================================
-- VIEWS for dashboard compatibility (drop-in replacement)
-- ============================================================

-- Drop existing views if they exist (these replace the raw PMS queries)
-- The dashboard will eventually point directly at std_* tables,
-- but these views ease migration:

CREATE OR REPLACE VIEW v_daily_kpis AS
SELECT clinic_id, day, revenue, visits, line_items, avg_line_amount, unique_services, cogs, staff_cost
FROM std_daily_kpis;

CREATE OR REPLACE VIEW v_service_usage AS
SELECT
  clinic_id,
  service_code AS code,
  SUM(amount) AS total_amount,
  SUM(quantity) AS total_qty,
  COUNT(*) AS txn_count,
  FIRST_VALUE(service_type) OVER (PARTITION BY clinic_id, service_code ORDER BY txn_date DESC) AS service_type
FROM std_transactions
GROUP BY clinic_id, service_code;

CREATE OR REPLACE VIEW v_service_prices AS
SELECT
  s.clinic_id,
  s.code,
  s.name,
  s.category AS service_type,
  s.price,
  s.cost,
  s.updated_at AS price_changed,
  COALESCE(usage.txn_count, 0) AS sales_since_change
FROM std_services s
LEFT JOIN LATERAL (
  SELECT COUNT(*) AS txn_count
  FROM std_transactions t
  WHERE t.clinic_id = s.clinic_id
    AND t.service_code = s.code
    AND t.txn_date >= s.updated_at
) usage ON TRUE;
