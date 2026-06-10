-- Vet INC Multi-Tenant Auth & RLS Setup
-- Deploys to: Cliniciq Supabase (rnqhhzatlxmyvccdvqkr.supabase.co)

-- ============================================================
-- 1. META TABLES — Users, Clinics, Access Control
-- ============================================================

-- Clinic registry (extends std_clinics with auth-related fields)
CREATE TABLE IF NOT EXISTS meta_clinics (
  clinic_id TEXT PRIMARY KEY REFERENCES std_clinics(clinic_id),
  slug TEXT UNIQUE NOT NULL,
  owner_email TEXT NOT NULL,
  plan TEXT DEFAULT 'free' CHECK (plan IN ('free','pro','enterprise')),
  active BOOLEAN DEFAULT TRUE,
  features JSONB DEFAULT '{"campaigns":true,"insights":true,"kpis":true}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Clinic users — who has access to what
CREATE TABLE IF NOT EXISTS meta_clinic_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL, -- links to auth.users
  clinic_id TEXT NOT NULL REFERENCES std_clinics(clinic_id),
  role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer','editor','admin','superadmin')),
  invited_at TIMESTAMPTZ DEFAULT NOW(),
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, clinic_id)
);
CREATE INDEX idx_clinic_users_user ON meta_clinic_users(user_id);
CREATE INDEX idx_clinic_users_clinic ON meta_clinic_users(clinic_id);

-- Invitations — for inviting new users to a clinic
CREATE TABLE IF NOT EXISTS meta_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id TEXT NOT NULL REFERENCES std_clinics(clinic_id),
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Audit log — every significant action
CREATE TABLE IF NOT EXISTS meta_audit_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id TEXT NOT NULL,
  user_id UUID,
  action TEXT NOT NULL,
  table_name TEXT,
  record_id TEXT,
  details JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_audit_clinic ON meta_audit_log(clinic_id);
CREATE INDEX idx_audit_user ON meta_audit_log(user_id);

-- ============================================================
-- 2. HELPER FUNCTIONS
-- ============================================================

-- Get the clinic_id(s) for the current authenticated user
CREATE OR REPLACE FUNCTION auth.clinic_ids()
RETURNS SETOF TEXT
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT clinic_id FROM meta_clinic_users
  WHERE user_id = auth.uid()
    AND accepted_at IS NOT NULL;
$$;

-- Check if current user has a specific role for a clinic
CREATE OR REPLACE FUNCTION auth.clinic_role(check_clinic_id TEXT)
RETURNS TEXT
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT role FROM meta_clinic_users
  WHERE user_id = auth.uid()
    AND clinic_id = check_clinic_id
    AND accepted_at IS NOT NULL;
$$;

-- Check if user is superadmin
CREATE OR REPLACE FUNCTION auth.is_superadmin()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM meta_clinic_users
    WHERE user_id = auth.uid()
      AND role = 'superadmin'
      AND accepted_at IS NOT NULL
  );
$$;

-- ============================================================
-- 3. RLS POLICIES — Data Isolation
-- ============================================================

-- Helper: Apply RLS to a table with clinic_id column
-- Pattern: users can only see data for clinics they belong to

-- --- std_services ---
ALTER TABLE std_services FORCE ROW LEVEL SECURITY;

CREATE POLICY "users_read_own_clinic" ON std_services
  FOR SELECT USING (
    clinic_id IN (SELECT auth.clinic_ids())
  );

CREATE POLICY "users_write_own_clinic" ON std_services
  FOR ALL USING (
    clinic_id IN (SELECT auth.clinic_ids())
    AND auth.clinic_role(clinic_id) IN ('editor','admin','superadmin')
  ) WITH CHECK (
    clinic_id IN (SELECT auth.clinic_ids())
    AND auth.clinic_role(clinic_id) IN ('editor','admin','superadmin')
  );

-- --- std_transactions ---
ALTER TABLE std_transactions FORCE ROW LEVEL SECURITY;

CREATE POLICY "users_read_own_clinic" ON std_transactions
  FOR SELECT USING (
    clinic_id IN (SELECT auth.clinic_ids())
  );

CREATE POLICY "users_write_own_clinic" ON std_transactions
  FOR ALL USING (
    clinic_id IN (SELECT auth.clinic_ids())
    AND auth.clinic_role(clinic_id) IN ('admin','superadmin')
  ) WITH CHECK (
    clinic_id IN (SELECT auth.clinic_ids())
    AND auth.clinic_role(clinic_id) IN ('admin','superadmin')
  );

-- --- std_visits ---
ALTER TABLE std_visits FORCE ROW LEVEL SECURITY;

CREATE POLICY "users_read_own_clinic" ON std_visits
  FOR SELECT USING (clinic_id IN (SELECT auth.clinic_ids()));

CREATE POLICY "users_write_own_clinic" ON std_visits
  FOR ALL USING (
    clinic_id IN (SELECT auth.clinic_ids())
    AND auth.clinic_role(clinic_id) IN ('admin','superadmin')
  ) WITH CHECK (
    clinic_id IN (SELECT auth.clinic_ids())
    AND auth.clinic_role(clinic_id) IN ('admin','superadmin')
  );

-- --- std_clients ---
ALTER TABLE std_clients FORCE ROW LEVEL SECURITY;

CREATE POLICY "users_read_own_clinic" ON std_clients
  FOR SELECT USING (clinic_id IN (SELECT auth.clinic_ids()));

CREATE POLICY "users_write_own_clinic" ON std_clients
  FOR ALL USING (
    clinic_id IN (SELECT auth.clinic_ids())
    AND auth.clinic_role(clinic_id) IN ('editor','admin','superadmin')
  ) WITH CHECK (
    clinic_id IN (SELECT auth.clinic_ids())
    AND auth.clinic_role(clinic_id) IN ('editor','admin','superadmin')
  );

-- --- std_patients ---
ALTER TABLE std_patients FORCE ROW LEVEL SECURITY;

CREATE POLICY "users_read_own_clinic" ON std_patients
  FOR SELECT USING (clinic_id IN (SELECT auth.clinic_ids()));

CREATE POLICY "users_write_own_clinic" ON std_patients
  FOR ALL USING (
    clinic_id IN (SELECT auth.clinic_ids())
    AND auth.clinic_role(clinic_id) IN ('editor','admin','superadmin')
  ) WITH CHECK (
    clinic_id IN (SELECT auth.clinic_ids())
    AND auth.clinic_role(clinic_id) IN ('editor','admin','superadmin')
  );

-- --- std_appointments ---
ALTER TABLE std_appointments FORCE ROW LEVEL SECURITY;

CREATE POLICY "users_read_own_clinic" ON std_appointments
  FOR SELECT USING (clinic_id IN (SELECT auth.clinic_ids()));

CREATE POLICY "users_write_own_clinic" ON std_appointments
  FOR ALL USING (
    clinic_id IN (SELECT auth.clinic_ids())
    AND auth.clinic_role(clinic_id) IN ('editor','admin','superadmin')
  ) WITH CHECK (
    clinic_id IN (SELECT auth.clinic_ids())
    AND auth.clinic_role(clinic_id) IN ('editor','admin','superadmin')
  );

-- --- std_vaccines ---
ALTER TABLE std_vaccines FORCE ROW LEVEL SECURITY;

CREATE POLICY "users_read_own_clinic" ON std_vaccines
  FOR SELECT USING (clinic_id IN (SELECT auth.clinic_ids()));

CREATE POLICY "users_write_own_clinic" ON std_vaccines
  FOR ALL USING (
    clinic_id IN (SELECT auth.clinic_ids())
    AND auth.clinic_role(clinic_id) IN ('admin','superadmin')
  ) WITH CHECK (
    clinic_id IN (SELECT auth.clinic_ids())
    AND auth.clinic_role(clinic_id) IN ('admin','superadmin')
  );

-- --- std_daily_kpis ---
ALTER TABLE std_daily_kpis FORCE ROW LEVEL SECURITY;

CREATE POLICY "users_read_own_clinic" ON std_daily_kpis
  FOR SELECT USING (clinic_id IN (SELECT auth.clinic_ids()));

-- KPIs are system-written, users shouldn't write directly

-- --- std_medical_records ---
ALTER TABLE std_medical_records FORCE ROW LEVEL SECURITY;

CREATE POLICY "users_read_own_clinic" ON std_medical_records
  FOR SELECT USING (clinic_id IN (SELECT auth.clinic_ids()));

-- --- std_inventory ---
ALTER TABLE std_inventory FORCE ROW LEVEL SECURITY;

CREATE POLICY "users_read_own_clinic" ON std_inventory
  FOR SELECT USING (clinic_id IN (SELECT auth.clinic_ids()));

CREATE POLICY "users_write_own_clinic" ON std_inventory
  FOR ALL USING (
    clinic_id IN (SELECT auth.clinic_ids())
    AND auth.clinic_role(clinic_id) IN ('editor','admin','superadmin')
  ) WITH CHECK (
    clinic_id IN (SELECT auth.clinic_ids())
    AND auth.clinic_role(clinic_id) IN ('editor','admin','superadmin')
  );

-- --- std_staff ---
ALTER TABLE std_staff FORCE ROW LEVEL SECURITY;

CREATE POLICY "users_read_own_clinic" ON std_staff
  FOR SELECT USING (clinic_id IN (SELECT auth.clinic_ids()));

CREATE POLICY "users_write_own_clinic" ON std_staff
  FOR ALL USING (
    clinic_id IN (SELECT auth.clinic_ids())
    AND auth.clinic_role(clinic_id) IN ('admin','superadmin')
  ) WITH CHECK (
    clinic_id IN (SELECT auth.clinic_ids())
    AND auth.clinic_role(clinic_id) IN ('admin','superadmin')
  );

-- --- std_shifts ---
ALTER TABLE std_shifts FORCE ROW LEVEL SECURITY;

CREATE POLICY "users_read_own_clinic" ON std_shifts
  FOR SELECT USING (clinic_id IN (SELECT auth.clinic_ids()));

-- --- std_extractor_log ---
ALTER TABLE std_extractor_log FORCE ROW LEVEL SECURITY;

CREATE POLICY "users_read_own_clinic" ON std_extractor_log
  FOR SELECT USING (clinic_id IN (SELECT auth.clinic_ids()));

-- --- meta tables ---

ALTER TABLE meta_clinic_users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_see_own_memberships" ON meta_clinic_users
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "admins_manage_clinic_users" ON meta_clinic_users
  FOR ALL USING (
    clinic_id IN (SELECT auth.clinic_ids())
    AND auth.clinic_role(clinic_id) IN ('admin','superadmin')
  ) WITH CHECK (
    clinic_id IN (SELECT auth.clinic_ids())
    AND auth.clinic_role(clinic_id) IN ('admin','superadmin')
  );

ALTER TABLE meta_clinics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_see_own_clinics" ON meta_clinics
  FOR SELECT USING (
    clinic_id IN (SELECT auth.clinic_ids())
  );

ALTER TABLE meta_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_see_own_clinic_audit" ON meta_audit_log
  FOR SELECT USING (
    clinic_id IN (SELECT auth.clinic_ids())
    AND auth.clinic_role(clinic_id) IN ('admin','superadmin')
  );

-- ============================================================
-- 4. AGGREGATION TABLES (per-clinic, dashboard-facing)
-- ============================================================

CREATE TABLE IF NOT EXISTS std_service_usage_agg (
  clinic_id TEXT NOT NULL,
  service_code TEXT NOT NULL,
  total_amount NUMERIC(12,2),
  total_qty NUMERIC(12,2),
  txn_count INTEGER,
  avg_price NUMERIC(10,2),
  service_type TEXT,
  period TEXT DEFAULT 'all', -- 'all', '30d', '90d', '365d'
  computed_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(clinic_id, service_code, period)
);

ALTER TABLE std_service_usage_agg FORCE ROW LEVEL SECURITY;

CREATE POLICY "users_read_own_clinic" ON std_service_usage_agg
  FOR SELECT USING (clinic_id IN (SELECT auth.clinic_ids()));

CREATE TABLE IF NOT EXISTS std_service_prices (
  clinic_id TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT,
  price NUMERIC(10,2),
  last_changed DATE,
  inflation_factor NUMERIC(6,4),
  suggested_price NUMERIC(10,2),
  gap_amount NUMERIC(10,2),
  gap_pct NUMERIC(6,4),
  annual_usage INTEGER,
  annual_uplift NUMERIC(12,2),
  computed_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(clinic_id, code)
);

ALTER TABLE std_service_prices FORCE ROW LEVEL SECURITY;

CREATE POLICY "users_read_own_clinic" ON std_service_prices
  FOR SELECT USING (clinic_id IN (SELECT auth.clinic_ids()));

-- ============================================================
-- 5. SEED — Vet INC Superadmin
-- ============================================================

-- Jack gets superadmin access to all clinics
-- Run after Jack's auth.users account is created:
-- INSERT INTO meta_clinic_users (user_id, clinic_id, role, accepted_at)
-- VALUES (jack_user_id, 'rosslyn', 'superadmin', NOW());

-- Register Rosslyn in meta
INSERT INTO meta_clinics (clinic_id, slug, owner_email, plan, active)
VALUES ('rosslyn', 'rosslyn', 'jack@vetinc.ca', 'pro', true)
ON CONFLICT DO NOTHING;
