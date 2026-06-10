CREATE OR REPLACE FUNCTION migrate_avimark_items(p_clinic_id TEXT) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE c BIGINT;
BEGIN
  INSERT INTO raw_avimark_items (clinic_id, record_num, code, name, dosage_form, uom, pack_size, unit_cost, service_code)
  SELECT p_clinic_id, record_num, code, name, dosage_form, uom, pack_size, unit_cost, service_code
  FROM public.items ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS c = ROW_COUNT; RETURN c;
END; $$;

CREATE OR REPLACE FUNCTION migrate_avimark_visits(p_clinic_id TEXT) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE c BIGINT;
BEGIN
  INSERT INTO raw_avimark_visits (clinic_id, record_num, visit_date, type_code, ref_id, doctor)
  SELECT p_clinic_id, record_num, visit_date::text, type_code, ref_id, doctor
  FROM public.visits ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS c = ROW_COUNT; RETURN c;
END; $$;

CREATE OR REPLACE FUNCTION migrate_avimark_clients(p_clinic_id TEXT) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE c BIGINT;
BEGIN
  INSERT INTO raw_avimark_clients (clinic_id, record_num, first_name, last_name, address, city, province, postal_code, phone, phone2)
  SELECT p_clinic_id, record_num, first_name, last_name, address, city, province, postal_code, phone, phone2
  FROM public.clients ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS c = ROW_COUNT; RETURN c;
END; $$;

CREATE OR REPLACE FUNCTION migrate_avimark_animals(p_clinic_id TEXT) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE c BIGINT;
BEGIN
  INSERT INTO raw_avimark_animals (clinic_id, record_num, name, species, breed, color, weight)
  SELECT p_clinic_id, record_num, name, species, breed, color, weight
  FROM public.animals ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS c = ROW_COUNT; RETURN c;
END; $$;

CREATE OR REPLACE FUNCTION migrate_avimark_appointments(p_clinic_id TEXT) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE c BIGINT;
BEGIN
  INSERT INTO raw_avimark_appointments (clinic_id, record_num, appt_date, flags, doctor, reason)
  SELECT p_clinic_id, record_num, appt_date::text, flags, doctor, reason
  FROM public.appointments ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS c = ROW_COUNT; RETURN c;
END; $$;

CREATE OR REPLACE FUNCTION migrate_avimark_vaccines(p_clinic_id TEXT) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE c BIGINT;
BEGIN
  INSERT INTO raw_avimark_vaccines (clinic_id, record_num, vaccine_date, serial_number, doctor, manufacturer)
  SELECT p_clinic_id, record_num, vaccine_date::text, serial_number, doctor, manufacturer
  FROM public.vaccines ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS c = ROW_COUNT; RETURN c;
END; $$;

-- Services/transactions by year (to avoid timeout)
CREATE OR REPLACE FUNCTION migrate_avimark_transactions_year(p_clinic_id TEXT, p_year INT) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE c BIGINT;
BEGIN
  INSERT INTO raw_avimark_services (clinic_id, record_num, service_type, code, description, amount, quantity, service_date)
  SELECT p_clinic_id, record_num, service_type, code, description, amount, quantity, service_date
  FROM public.services
  WHERE EXTRACT(YEAR FROM (service_date)::date) = p_year
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS c = ROW_COUNT; RETURN c;
END; $$;
