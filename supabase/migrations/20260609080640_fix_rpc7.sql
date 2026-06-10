CREATE OR REPLACE FUNCTION standardize_avimark_transactions_range(p_clinic_id TEXT, p_start_date DATE, p_end_date DATE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  inserted BIGINT;
BEGIN
  INSERT INTO public.std_transactions (clinic_id, txn_date, txn_id, line_num, service_code, description, quantity, amount, service_type)
  SELECT 
    p_clinic_id,
    COALESCE((s.service_date)::date, (s.created_at)::date, '2020-01-01'::date),
    'R' || s.record_num,
    ROW_NUMBER() OVER (PARTITION BY s.record_num ORDER BY s.id),
    s.code,
    s.description,
    COALESCE(s.quantity, 1),
    COALESCE(s.amount, 0),
    s.service_type
  FROM public.services s
  WHERE (s.service_date)::date >= p_start_date
    AND (s.service_date)::date < p_end_date
  ON CONFLICT DO NOTHING;
  
  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN jsonb_build_object('range', p_start_date::text || ' to ' || p_end_date::text, 'inserted', inserted);
END;
$$;
