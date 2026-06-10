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
      pavg.avg_price as price,
      i.unit_cost as cost
    FROM public.items i
    LEFT JOIN LATERAL (
      SELECT service_type FROM public.services s WHERE s.code = i.service_code LIMIT 1
    ) svc ON TRUE
    LEFT JOIN LATERAL (
      SELECT AVG(amount) as avg_price FROM public.services s WHERE s.code = i.code
    ) pavg ON TRUE
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
