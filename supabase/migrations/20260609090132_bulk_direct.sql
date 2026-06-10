-- Direct bulk copy: bypass triggers, insert straight from source to std_*
-- Then re-enable triggers for future data

CREATE OR REPLACE FUNCTION bulk_copy_remaining_transactions(p_clinic_id TEXT, p_year INT) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE c BIGINT;
BEGIN
  -- Disable trigger on raw table (we're writing directly to std)
  INSERT INTO std_transactions (clinic_id, txn_date, txn_id, service_code, description, quantity, amount, service_type)
  SELECT 
    p_clinic_id,
    COALESCE((s.service_date)::date, (s.created_at)::date, '2020-01-01'::date),
    'R' || s.record_num,
    s.code,
    s.description,
    COALESCE(s.quantity, 1),
    COALESCE(s.amount, 0),
    map_avimark_category(s.service_type)
  FROM public.services s
  WHERE EXTRACT(YEAR FROM (s.service_date)::date) = p_year
    AND NOT EXISTS (
      SELECT 1 FROM std_transactions st
      WHERE st.clinic_id = p_clinic_id
        AND st.txn_date = COALESCE((s.service_date)::date, (s.created_at)::date, '2020-01-01'::date)
        AND st.txn_id = 'R' || s.record_num
        AND st.service_code = s.code
    )
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS c = ROW_COUNT;
  RETURN c;
END;
$$;
