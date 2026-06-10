CREATE OR REPLACE FUNCTION migrate_avimark_transactions_2019_h1(p_clinic_id TEXT) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE c BIGINT;
BEGIN
  INSERT INTO raw_avimark_services (clinic_id, record_num, service_type, code, description, amount, quantity, service_date)
  SELECT p_clinic_id, record_num, service_type, code, description, amount, quantity, service_date
  FROM public.services
  WHERE (service_date)::date >= '2019-01-01' AND (service_date)::date < '2019-07-01'
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS c = ROW_COUNT; RETURN c;
END; $$;

CREATE OR REPLACE FUNCTION migrate_avimark_transactions_2019_h2(p_clinic_id TEXT) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE c BIGINT;
BEGIN
  INSERT INTO raw_avimark_services (clinic_id, record_num, service_type, code, description, amount, quantity, service_date)
  SELECT p_clinic_id, record_num, service_type, code, description, amount, quantity, service_date
  FROM public.services
  WHERE (service_date)::date >= '2019-07-01' AND (service_date)::date < '2020-01-01'
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS c = ROW_COUNT; RETURN c;
END; $$;
