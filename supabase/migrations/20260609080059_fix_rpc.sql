-- Fix services: use DISTINCT ON to avoid duplicate conflict
CREATE OR REPLACE FUNCTION standardize_avimark_services(p_clinic_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  inserted BIGINT;
  total BIGINT;
BEGIN
  INSERT INTO public.std_services (clinic_id, code, name, category, price, cost, active)
  SELECT 
    p_clinic_id,
    sub.code,
    sub.name,
    COALESCE(sub.service_type, 'other'),
    sub.price,
    sub.cost,
    TRUE
  FROM (
    SELECT DISTINCT ON (i.code)
      i.code,
      COALESCE(i.name, i.code) as name,
      svc.service_type,
      MAX(svc.amount) OVER (PARTITION BY i.code) as price,
      i.unit_cost as cost
    FROM public.items i
    LEFT JOIN LATERAL (
      SELECT service_type FROM public.services s WHERE s.code = i.service_code LIMIT 1
    ) svc ON TRUE
    ORDER BY i.code, i.unit_cost DESC
  ) sub
  ON CONFLICT (clinic_id, code) 
  DO UPDATE SET 
    name = EXCLUDED.name,
    price = COALESCE(std_services.price, EXCLUDED.price),
    cost = COALESCE(EXCLUDED.cost, std_services.cost),
    updated_at = NOW();
  
  GET DIAGNOSTICS inserted = ROW_COUNT;
  SELECT COUNT(*) INTO total FROM public.std_services WHERE clinic_id = p_clinic_id;
  
  RETURN jsonb_build_object('upserted', inserted, 'total', total);
END;
$$;

-- Fix transactions: batch by year to avoid timeout
CREATE OR REPLACE FUNCTION standardize_avimark_transactions(p_clinic_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  year_total BIGINT;
  grand_total BIGINT := 0;
  yr TEXT;
BEGIN
  FOR yr IN SELECT DISTINCT EXTRACT(YEAR FROM COALESCE(service_date, created_at::date))::TEXT FROM public.services ORDER BY 1 LOOP
    INSERT INTO public.std_transactions (clinic_id, txn_date, txn_id, line_num, service_code, description, quantity, amount, service_type)
    SELECT 
      p_clinic_id,
      COALESCE(s.service_date, s.created_at::date, '2020-01-01'::date),
      'R' || s.record_num,
      ROW_NUMBER() OVER (PARTITION BY s.record_num ORDER BY s.id),
      s.code,
      s.description,
      COALESCE(s.quantity, 1),
      COALESCE(s.amount, 0),
      s.service_type
    FROM public.services s
    WHERE EXTRACT(YEAR FROM COALESCE(s.service_date, s.created_at::date))::TEXT = yr
      AND NOT EXISTS (
        SELECT 1 FROM public.std_transactions st 
        WHERE st.clinic_id = p_clinic_id 
          AND st.txn_id = 'R' || s.record_num
          AND st.service_code = s.code
      )
    ON CONFLICT DO NOTHING;
    
    GET DIAGNOSTICS year_total = ROW_COUNT;
    grand_total := grand_total + year_total;
  END LOOP;
  
  SELECT COUNT(*) INTO grand_total FROM public.std_transactions WHERE clinic_id = p_clinic_id;
  
  RETURN jsonb_build_object('inserted', year_total, 'std_total', grand_total);
END;
$$;
