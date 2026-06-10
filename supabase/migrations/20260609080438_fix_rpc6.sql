-- Insert transactions by month to avoid statement timeout
CREATE OR REPLACE FUNCTION standardize_avimark_transactions_month(p_clinic_id TEXT, p_year INT, p_month INT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  inserted BIGINT;
  total BIGINT;
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
  WHERE EXTRACT(YEAR FROM COALESCE((s.service_date)::date, (s.created_at)::date)) = p_year
    AND EXTRACT(MONTH FROM COALESCE((s.service_date)::date, (s.created_at)::date)) = p_month
  ON CONFLICT DO NOTHING;
  
  GET DIAGNOSTICS inserted = ROW_COUNT;
  SELECT COUNT(*) INTO total FROM public.std_transactions WHERE clinic_id = p_clinic_id;
  RETURN jsonb_build_object('month_inserted', inserted, 'total_std', total);
END;
$$;
