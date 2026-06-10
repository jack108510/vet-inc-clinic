CREATE OR REPLACE FUNCTION migrate_avimark_transactions_range(p_clinic_id TEXT, p_start TEXT, p_end TEXT) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE c BIGINT;
BEGIN
  INSERT INTO raw_avimark_services (clinic_id, record_num, service_type, code, description, amount, quantity, service_date)
  SELECT p_clinic_id, record_num, service_type, code, description, amount, quantity, service_date
  FROM public.services
  WHERE (service_date)::date >= p_start::date AND (service_date)::date < p_end::date
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS c = ROW_COUNT; RETURN c;
END; $$;
