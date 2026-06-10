CREATE OR REPLACE FUNCTION standardize_avimark_transactions(p_clinic_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  year_inserted BIGINT;
  grand_total BIGINT := 0;
  yr INT;
BEGIN
  FOR yr IN SELECT generate_series(2019, 2026) LOOP
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
    WHERE EXTRACT(YEAR FROM COALESCE((s.service_date)::date, (s.created_at)::date)) = yr
    ON CONFLICT DO NOTHING;
    
    GET DIAGNOSTICS year_inserted = ROW_COUNT;
    grand_total := grand_total + year_inserted;
  END LOOP;
  
  SELECT COUNT(*) INTO grand_total FROM public.std_transactions WHERE clinic_id = p_clinic_id;
  RETURN jsonb_build_object('total_std', grand_total);
END;
$$;
