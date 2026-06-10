-- Vet INC — AVImark Raw Tables + Auto-Standardization Triggers
-- This is the data pipeline foundation. Every row that lands in raw_avimark_* 
-- gets validated, cleaned, and standardized into std_* automatically.

-- ============================================================
-- STEP 1: RAW AVIMARK TABLES (landing zone)
-- Data lands here EXACTLY as AVImark exports it.
-- clinic_id is stamped at upload time, never by the clinic.
-- ============================================================

CREATE TABLE IF NOT EXISTS raw_avimark_services (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id TEXT NOT NULL,
  record_num TEXT,
  service_type TEXT,
  code TEXT,
  description TEXT,
  amount NUMERIC,
  quantity NUMERIC,
  service_date TEXT,  -- AVImark stores as text: "2019-02-03 23:18:01"
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(clinic_id, record_num, code, service_date)
);
CREATE INDEX idx_raw_svc_clinic ON raw_avimark_services(clinic_id);
CREATE INDEX idx_raw_svc_date ON raw_avimark_services(clinic_id, service_date);

CREATE TABLE IF NOT EXISTS raw_avimark_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id TEXT NOT NULL,
  record_num TEXT,
  code TEXT,
  name TEXT,
  dosage_form TEXT,
  uom TEXT,
  pack_size TEXT,
  unit_cost NUMERIC,
  service_code TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(clinic_id, code)
);

CREATE TABLE IF NOT EXISTS raw_avimark_visits (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id TEXT NOT NULL,
  record_num TEXT,
  visit_date TEXT,
  type_code TEXT,
  ref_id TEXT,
  doctor TEXT,
  field_48 TEXT,
  field_53 TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(clinic_id, record_num)
);

CREATE TABLE IF NOT EXISTS raw_avimark_clients (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
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
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(clinic_id, record_num)
);

CREATE TABLE IF NOT EXISTS raw_avimark_animals (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id TEXT NOT NULL,
  record_num TEXT,
  client_record_num TEXT,  -- links to raw_avimark_clients.record_num
  name TEXT,
  species TEXT,
  breed TEXT,
  color TEXT,
  weight NUMERIC,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(clinic_id, record_num)
);

CREATE TABLE IF NOT EXISTS raw_avimark_appointments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id TEXT NOT NULL,
  record_num TEXT,
  appt_date TEXT,
  flags TEXT,
  doctor TEXT,
  reason TEXT,
  field_40 TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(clinic_id, record_num)
);

CREATE TABLE IF NOT EXISTS raw_avimark_vaccines (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id TEXT NOT NULL,
  record_num TEXT,
  vaccine_date TEXT,
  serial_number TEXT,
  doctor TEXT,
  manufacturer TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS raw_avimark_prescriptions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id TEXT NOT NULL,
  record_num TEXT,
  rx_date TEXT,
  flags TEXT,
  type_byte TEXT,
  ref_id TEXT,
  field_45 TEXT,
  field_46 TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS raw_avimark_procedures (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id TEXT NOT NULL,
  record_num TEXT,
  procedure_date TEXT,
  code TEXT,
  description TEXT,
  amount NUMERIC,
  field_type TEXT,
  ref_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Catch-all for anything unusual
CREATE TABLE IF NOT EXISTS raw_avimark_extras (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id TEXT NOT NULL,
  source_table TEXT NOT NULL,
  record_id TEXT,
  data JSONB,
  ingested_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- STEP 2: VALIDATION & CLEANING FUNCTIONS
-- ============================================================

-- Safe date parser — returns NULL for bad dates instead of crashing
CREATE OR REPLACE FUNCTION safe_date(date_text TEXT)
RETURNS DATE
LANGUAGE plpgsql IMMUTABLE
AS $$
BEGIN
  RETURN (date_text)::date;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

-- Species normalizer
CREATE OR REPLACE FUNCTION normalize_species(raw_species TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE
    WHEN LOWER(raw_species) IN ('canine','dog','dogs') THEN 'Canine'
    WHEN LOWER(raw_species) IN ('feline','cat','cats') THEN 'Feline'
    WHEN LOWER(raw_species) IN ('equine','horse','horses') THEN 'Equine'
    WHEN LOWER(raw_species) IN ('avian','bird','birds') THEN 'Avian'
    WHEN LOWER(raw_species) IN ('reptile','lizard','snake','turtle') THEN 'Reptile'
    WHEN LOWER(raw_species) IN ('rabbit','bunny','lagomorph') THEN 'Lagomorph'
    WHEN LOWER(raw_species) IN ('ferret') THEN 'Mustelid'
    WHEN LOWER(raw_species) IN ('rodent','hamster','guinea pig','mouse','rat') THEN 'Rodent'
    WHEN LOWER(raw_species) IN ('bovine','cow','cattle') THEN 'Bovine'
    WHEN LOWER(raw_species) IN ('porcine','pig','swine') THEN 'Porcine'
    ELSE COALESCE(INITCAP(raw_species), 'Unknown')
  END;
$$;

-- Province normalizer
CREATE OR REPLACE FUNCTION normalize_province(raw_prov TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE
    WHEN UPPER(raw_prov) IN ('ALBERTA','AB') THEN 'AB'
    WHEN UPPER(raw_prov) IN ('BRITISH COLUMBIA','BC') THEN 'BC'
    WHEN UPPER(raw_prov) IN ('SASKATCHEWAN','SK') THEN 'SK'
    WHEN UPPER(raw_prov) IN ('MANITOBA','MB') THEN 'MB'
    WHEN UPPER(raw_prov) IN ('ONTARIO','ON') THEN 'ON'
    WHEN UPPER(raw_prov) IN ('QUEBEC','QC') THEN 'QC'
    WHEN UPPER(raw_prov) IN ('NEW BRUNSWICK','NB') THEN 'NB'
    WHEN UPPER(raw_prov) IN ('NOVA SCOTIA','NS') THEN 'NS'
    WHEN UPPER(raw_prov) IN ('PRINCE EDWARD ISLAND','PE','PEI') THEN 'PE'
    WHEN UPPER(raw_prov) IN ('NEWFOUNDLAND','NL','NEWFOUNDLAND AND LABRADOR') THEN 'NL'
    WHEN UPPER(raw_prov) IN ('NORTHWEST TERRITORIES','NT') THEN 'NT'
    WHEN UPPER(raw_prov) IN ('YUKON','YT') THEN 'YT'
    WHEN UPPER(raw_prov) IN ('NUNAVUT','NU') THEN 'NU'
    ELSE UPPER(COALESCE(raw_prov, ''))
  END;
$$;

-- AVImark category mapper
CREATE OR REPLACE FUNCTION map_avimark_category(raw_type TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE
    WHEN UPPER(raw_type) IN ('OV','OP') THEN 'exam'
    WHEN UPPER(raw_type) IN ('SX') THEN 'surgery'
    WHEN UPPER(raw_type) IN ('TX','DX') THEN 'dental'
    WHEN UPPER(raw_type) IN ('VX') THEN 'vaccine'
    WHEN UPPER(raw_type) IN ('LAB') THEN 'lab'
    WHEN UPPER(raw_type) IN ('AI','AM','AS','DM') THEN 'pharmacy'
    WHEN UPPER(raw_type) IN ('AX') THEN 'imaging'
    WHEN UPPER(raw_type) IN ('MX') THEN 'emergency'
    WHEN UPPER(raw_type) IN ('PX') THEN 'boarding'
    WHEN UPPER(raw_type) IN ('RX') THEN 'other'
    ELSE COALESCE(LOWER(raw_type), 'other')
  END;
$$;

-- ============================================================
-- STEP 3: ROW-LEVEL STANDARDIZATION FUNCTIONS
-- Each returns the standardized row or logs an error.
-- ============================================================

-- Standardize a single transaction row
CREATE OR REPLACE FUNCTION std_insert_transaction()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  txn_date_val DATE;
BEGIN
  -- Parse and validate date
  txn_date_val := safe_date(NEW.service_date);
  IF txn_date_val IS NULL THEN
    txn_date_val := safe_date((NEW.created_at)::text);
  END IF;
  IF txn_date_val IS NULL THEN
    txn_date_val := '2020-01-01'::date;
  END IF;
  
  -- Skip if no code
  IF NEW.code IS NULL OR TRIM(NEW.code) = '' THEN
    INSERT INTO std_extractor_errors (clinic_id, extractor_type, source_table, source_row_id, error_type, error_message, raw_data, severity)
    VALUES (NEW.clinic_id, 'avimark', 'raw_avimark_services', NEW.record_num, 'null_field', 'Missing service code', to_jsonb(NEW), 'warning');
    RETURN NEW;
  END IF;
  
  -- Insert into standardized table
  INSERT INTO std_transactions (clinic_id, txn_date, txn_id, service_code, description, quantity, amount, service_type)
  VALUES (
    NEW.clinic_id,
    txn_date_val,
    'R' || COALESCE(NEW.record_num, ''),
    TRIM(NEW.code),
    TRIM(COALESCE(NEW.description, '')),
    COALESCE(NEW.quantity, 1),
    COALESCE(NEW.amount, 0),
    map_avimark_category(NEW.service_type)
  )
  ON CONFLICT DO NOTHING;
  
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO std_extractor_errors (clinic_id, extractor_type, source_table, source_row_id, error_type, error_message, raw_data, severity)
  VALUES (NEW.clinic_id, 'avimark', 'raw_avimark_services', NEW.record_num, 'exception', SQLERRM, to_jsonb(NEW), 'critical');
  RETURN NEW;
END;
$$;

-- Standardize a single item row (into std_services)
CREATE OR REPLACE FUNCTION std_insert_service()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.code IS NULL OR TRIM(NEW.code) = '' THEN
    RETURN NEW;
  END IF;
  
  INSERT INTO std_services (clinic_id, code, name, category, price, cost, active)
  VALUES (
    NEW.clinic_id,
    TRIM(NEW.code),
    COALESCE(TRIM(NEW.name), TRIM(NEW.code)),
    'other',  -- category updated when services reference it
    NULL,     -- price comes from transaction data
    NEW.unit_cost,
    TRUE
  )
  ON CONFLICT (clinic_id, code) 
  DO UPDATE SET 
    name = COALESCE(EXCLUDED.name, std_services.name),
    cost = COALESCE(EXCLUDED.cost, std_services.cost),
    updated_at = NOW()
  ;
  
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO std_extractor_errors (clinic_id, extractor_type, source_table, source_row_id, error_type, error_message, raw_data, severity)
  VALUES (NEW.clinic_id, 'avimark', 'raw_avimark_items', NEW.record_num, 'exception', SQLERRM, to_jsonb(NEW), 'warning');
  RETURN NEW;
END;
$$;

-- Standardize a single visit
CREATE OR REPLACE FUNCTION std_insert_visit()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  visit_date_val DATE;
BEGIN
  visit_date_val := safe_date(NEW.visit_date);
  IF visit_date_val IS NULL THEN
    INSERT INTO std_extractor_errors (clinic_id, extractor_type, source_table, source_row_id, error_type, error_message, raw_data)
    VALUES (NEW.clinic_id, 'avimark', 'raw_avimark_visits', NEW.record_num, 'bad_date', NEW.visit_date, to_jsonb(NEW));
    RETURN NEW;
  END IF;
  
  INSERT INTO std_visits (clinic_id, visit_date, visit_id, doctor, client_id, patient_id)
  VALUES (
    NEW.clinic_id,
    visit_date_val,
    'V' || NEW.record_num,
    TRIM(COALESCE(NEW.doctor, '')),
    CASE WHEN NEW.ref_id IS NOT NULL THEN 'C' || NEW.ref_id ELSE NULL END,
    CASE WHEN NEW.type_code IS NOT NULL THEN 'A' || NEW.type_code ELSE NULL END
  )
  ON CONFLICT (clinic_id, visit_id) DO NOTHING;
  
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO std_extractor_errors (clinic_id, extractor_type, source_table, source_row_id, error_type, error_message, raw_data)
  VALUES (NEW.clinic_id, 'avimark', 'raw_avimark_visits', NEW.record_num, 'exception', SQLERRM, to_jsonb(NEW));
  RETURN NEW;
END;
$$;

-- Standardize a single client
CREATE OR REPLACE FUNCTION std_insert_client()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO std_clients (clinic_id, client_id, first_name, last_name, phone, city, province, postal_code, first_visit)
  VALUES (
    NEW.clinic_id,
    'C' || NEW.record_num,
    TRIM(COALESCE(NEW.first_name, '')),
    TRIM(COALESCE(NEW.last_name, '')),
    TRIM(COALESCE(NEW.phone, NEW.phone2, '')),
    TRIM(COALESCE(NEW.city, '')),
    normalize_province(NEW.province),
    TRIM(COALESCE(NEW.postal_code, '')),
    safe_date((NEW.created_at)::text)
  )
  ON CONFLICT (clinic_id, client_id) 
  DO UPDATE SET
    first_name = COALESCE(NULLIF(TRIM(EXCLUDED.first_name), ''), std_clients.first_name),
    last_name = COALESCE(NULLIF(TRIM(EXCLUDED.last_name), ''), std_clients.last_name),
    phone = COALESCE(NULLIF(TRIM(EXCLUDED.phone), ''), std_clients.phone),
    city = COALESCE(NULLIF(TRIM(EXCLUDED.city), ''), std_clients.city),
    province = COALESCE(NULLIF(EXCLUDED.province, ''), std_clients.province),
    updated_at = NOW()
  ;
  
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO std_extractor_errors (clinic_id, extractor_type, source_table, source_row_id, error_type, error_message, raw_data)
  VALUES (NEW.clinic_id, 'avimark', 'raw_avimark_clients', NEW.record_num, 'exception', SQLERRM, to_jsonb(NEW));
  RETURN NEW;
END;
$$;

-- Standardize a single patient
CREATE OR REPLACE FUNCTION std_insert_patient()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO std_patients (clinic_id, patient_id, client_id, name, species, breed, weight)
  VALUES (
    NEW.clinic_id,
    'A' || NEW.record_num,
    CASE WHEN NEW.client_record_num IS NOT NULL THEN 'C' || NEW.client_record_num ELSE NULL END,
    TRIM(COALESCE(NEW.name, '')),
    normalize_species(NEW.species),
    TRIM(COALESCE(NEW.breed, '')),
    NEW.weight
  )
  ON CONFLICT (clinic_id, patient_id) 
  DO UPDATE SET
    name = COALESCE(NULLIF(TRIM(EXCLUDED.name), ''), std_patients.name),
    species = COALESCE(NULLIF(EXCLUDED.species, ''), std_patients.species),
    breed = COALESCE(NULLIF(TRIM(EXCLUDED.breed), ''), std_patients.breed),
    weight = COALESCE(EXCLUDED.weight, std_patients.weight),
    updated_at = NOW()
  ;
  
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO std_extractor_errors (clinic_id, extractor_type, source_table, source_row_id, error_type, error_message, raw_data)
  VALUES (NEW.clinic_id, 'avimark', 'raw_avimark_animals', NEW.record_num, 'exception', SQLERRM, to_jsonb(NEW));
  RETURN NEW;
END;
$$;

-- Standardize a single appointment
CREATE OR REPLACE FUNCTION std_insert_appointment()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  appt_date_val DATE;
BEGIN
  appt_date_val := safe_date(NEW.appt_date);
  IF appt_date_val IS NULL THEN
    RETURN NEW;
  END IF;
  
  INSERT INTO std_appointments (clinic_id, appointment_id, appointment_date, doctor, reason, status)
  VALUES (
    NEW.clinic_id,
    'AP' || NEW.record_num,
    appt_date_val,
    TRIM(COALESCE(NEW.doctor, '')),
    TRIM(COALESCE(NEW.reason, '')),
    'completed'
  )
  ON CONFLICT (clinic_id, appointment_id) DO NOTHING;
  
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO std_extractor_errors (clinic_id, extractor_type, source_table, source_row_id, error_type, error_message, raw_data)
  VALUES (NEW.clinic_id, 'avimark', 'raw_avimark_appointments', NEW.record_num, 'exception', SQLERRM, to_jsonb(NEW));
  RETURN NEW;
END;
$$;

-- Standardize a single vaccine
CREATE OR REPLACE FUNCTION std_insert_vaccine()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  vax_date_val DATE;
BEGIN
  vax_date_val := safe_date(NEW.vaccine_date);
  IF vax_date_val IS NULL THEN
    RETURN NEW;
  END IF;
  
  INSERT INTO std_vaccines (clinic_id, patient_id, vaccine_date, vaccine_name, doctor)
  VALUES (
    NEW.clinic_id,
    'A' || NEW.record_num,
    vax_date_val,
    TRIM(COALESCE(NEW.manufacturer, '')),
    TRIM(COALESCE(NEW.doctor, ''))
  );
  
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO std_extractor_errors (clinic_id, extractor_type, source_table, source_row_id, error_type, error_message, raw_data)
  VALUES (NEW.clinic_id, 'avimark', 'raw_avimark_vaccines', NEW.record_num, 'exception', SQLERRM, to_jsonb(NEW));
  RETURN NEW;
END;
$$;

-- ============================================================
-- STEP 4: ATTACH TRIGGERS TO RAW TABLES
-- ============================================================

CREATE TRIGGER trg_std_transaction
AFTER INSERT ON raw_avimark_services
FOR EACH ROW EXECUTE FUNCTION std_insert_transaction();

CREATE TRIGGER trg_std_service
AFTER INSERT ON raw_avimark_items
FOR EACH ROW EXECUTE FUNCTION std_insert_service();

CREATE TRIGGER trg_std_visit
AFTER INSERT ON raw_avimark_visits
FOR EACH ROW EXECUTE FUNCTION std_insert_visit();

CREATE TRIGGER trg_std_client
AFTER INSERT ON raw_avimark_clients
FOR EACH ROW EXECUTE FUNCTION std_insert_client();

CREATE TRIGGER trg_std_patient
AFTER INSERT ON raw_avimark_animals
FOR EACH ROW EXECUTE FUNCTION std_insert_patient();

CREATE TRIGGER trg_std_appointment
AFTER INSERT ON raw_avimark_appointments
FOR EACH ROW EXECUTE FUNCTION std_insert_appointment();

CREATE TRIGGER trg_std_vaccine
AFTER INSERT ON raw_avimark_vaccines
FOR EACH ROW EXECUTE FUNCTION std_insert_vaccine();

-- ============================================================
-- STEP 5: RLS ON RAW TABLES
-- ============================================================

ALTER TABLE raw_avimark_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE raw_avimark_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE raw_avimark_visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE raw_avimark_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE raw_avimark_animals ENABLE ROW LEVEL SECURITY;
ALTER TABLE raw_avimark_appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE raw_avimark_vaccines ENABLE ROW LEVEL SECURITY;
ALTER TABLE raw_avimark_prescriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE raw_avimark_procedures ENABLE ROW LEVEL SECURITY;
ALTER TABLE raw_avimark_extras ENABLE ROW LEVEL SECURITY;

-- Service role can do everything (standardizer + upload process)
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'raw_avimark_services','raw_avimark_items','raw_avimark_visits',
    'raw_avimark_clients','raw_avimark_animals','raw_avimark_appointments',
    'raw_avimark_vaccines','raw_avimark_prescriptions','raw_avimark_procedures',
    'raw_avimark_extras'
  ] LOOP
    EXECUTE format('CREATE POLICY "service_full" ON %I FOR ALL USING (auth.role() = ''service_role'') WITH CHECK (auth.role() = ''service_role'')', t);
  END LOOP;
END;
$$;

-- ============================================================
-- STEP 6: BULK MIGRATION FUNCTION
-- For initial load of existing data. Disable triggers, 
-- copy data, re-enable triggers.
-- ============================================================

CREATE OR REPLACE FUNCTION migrate_existing_avimark_data(p_clinic_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  svc_count BIGINT;
  txn_count BIGINT;
  visit_count BIGINT;
  client_count BIGINT;
  patient_count BIGINT;
  appt_count BIGINT;
  vax_count BIGINT;
  error_count BIGINT;
BEGIN
  -- Copy existing services (transactions) into raw table
  -- Triggers will fire and standardize each one
  INSERT INTO raw_avimark_services (clinic_id, record_num, service_type, code, description, amount, quantity, service_date)
  SELECT p_clinic_id, record_num, service_type, code, description, amount, quantity, service_date
  FROM public.services
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS txn_count = ROW_COUNT;
  
  -- Copy items
  INSERT INTO raw_avimark_items (clinic_id, record_num, code, name, dosage_form, uom, pack_size, unit_cost, service_code)
  SELECT p_clinic_id, record_num, code, name, dosage_form, uom, pack_size, unit_cost, service_code
  FROM public.items
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS svc_count = ROW_COUNT;
  
  -- Copy visits
  INSERT INTO raw_avimark_visits (clinic_id, record_num, visit_date, type_code, ref_id, doctor)
  SELECT p_clinic_id, record_num, visit_date::text, type_code, ref_id, doctor
  FROM public.visits
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS visit_count = ROW_COUNT;
  
  -- Copy clients
  INSERT INTO raw_avimark_clients (clinic_id, record_num, first_name, last_name, address, city, province, postal_code, phone, phone2)
  SELECT p_clinic_id, record_num, first_name, last_name, address, city, province, postal_code, phone, phone2
  FROM public.clients
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS client_count = ROW_COUNT;
  
  -- Copy animals
  INSERT INTO raw_avimark_animals (clinic_id, record_num, name, species, breed, color, weight)
  SELECT p_clinic_id, record_num, name, species, breed, color, weight
  FROM public.animals
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS patient_count = ROW_COUNT;
  
  -- Copy appointments
  INSERT INTO raw_avimark_appointments (clinic_id, record_num, appt_date, flags, doctor, reason)
  SELECT p_clinic_id, record_num, appt_date::text, flags, doctor, reason
  FROM public.appointments
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS appt_count = ROW_COUNT;
  
  -- Copy vaccines
  INSERT INTO raw_avimark_vaccines (clinic_id, record_num, vaccine_date, serial_number, doctor, manufacturer)
  SELECT p_clinic_id, record_num, vaccine_date::text, serial_number, doctor, manufacturer
  FROM public.vaccines
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS vax_count = ROW_COUNT;
  
  SELECT COUNT(*) INTO error_count FROM std_extractor_errors WHERE clinic_id = p_clinic_id;
  
  RETURN jsonb_build_object(
    'raw_inserted', jsonb_build_object(
      'transactions', txn_count,
      'services', svc_count,
      'visits', visit_count,
      'clients', client_count,
      'patients', patient_count,
      'appointments', appt_count,
      'vaccines', vax_count
    ),
    'errors', error_count
  );
END;
$$;
