-- Create RPC function to standardize transactions directly in DB
CREATE OR REPLACE FUNCTION standardize_avimark_transactions(p_clinic_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  inserted BIGINT;
  total_source BIGINT;
  total_existing BIGINT;
BEGIN
  -- Count source
  SELECT COUNT(*) INTO total_source FROM public.services;
  -- Count existing
  SELECT COUNT(*) INTO total_existing FROM public.std_transactions WHERE clinic_id = p_clinic_id;
  
  -- Insert all services that don't already exist in std_transactions
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
  WHERE NOT EXISTS (
    SELECT 1 FROM public.std_transactions st 
    WHERE st.clinic_id = p_clinic_id 
      AND st.txn_id = 'R' || s.record_num
      AND st.service_code = s.code
      AND st.txn_date = COALESCE(s.service_date, s.created_at::date, '2020-01-01'::date)
  )
  ON CONFLICT DO NOTHING;
  
  GET DIAGNOSTICS inserted = ROW_COUNT;
  
  SELECT COUNT(*) INTO total_existing FROM public.std_transactions WHERE clinic_id = p_clinic_id;
  
  RETURN jsonb_build_object(
    'source_total', total_source,
    'new_inserted', inserted,
    'std_total', total_existing
  );
END;
$$;

-- Same for services
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
    i.code,
    COALESCE(i.name, t.name, i.code),
    COALESCE(svc.service_type, 'other'),
    MAX(svc.amount),
    MAX(i.unit_cost),
    TRUE
  FROM public.items i
  LEFT JOIN public.treatments t ON t.code = i.code
  LEFT JOIN public.services svc ON svc.code = i.service_code
  GROUP BY i.code, i.name, t.name, svc.service_type
  ON CONFLICT (clinic_id, code) 
  DO UPDATE SET 
    name = EXCLUDED.name,
    price = EXCLUDED.price,
    cost = EXCLUDED.cost,
    updated_at = NOW();
  
  GET DIAGNOSTICS inserted = ROW_COUNT;
  SELECT COUNT(*) INTO total FROM public.std_services WHERE clinic_id = p_clinic_id;
  
  RETURN jsonb_build_object('upserted', inserted, 'total', total);
END;
$$;

-- Same for other tables
CREATE OR REPLACE FUNCTION standardize_avimark_all(p_clinic_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  svc_result JSONB;
  txn_result JSONB;
  visit_count BIGINT;
  client_count BIGINT;
  patient_count BIGINT;
  appt_count BIGINT;
  vax_count BIGINT;
  txn_count BIGINT;
BEGIN
  -- Services
  PERFORM standardize_avimark_services(p_clinic_id);
  SELECT COUNT(*) INTO visit_count FROM public.std_services WHERE clinic_id = p_clinic_id;
  svc_result := jsonb_build_object('services', visit_count);
  
  -- Visits
  INSERT INTO public.std_visits (clinic_id, visit_date, visit_id, doctor, client_id, patient_id)
  SELECT p_clinic_id, v.visit_date, 'V' || v.record_num, v.doctor, v.ref_id, v.type_code
  FROM public.visits v
  ON CONFLICT (clinic_id, visit_id) DO NOTHING;
  GET DIAGNOSTICS visit_count = ROW_COUNT;
  
  -- Clients
  INSERT INTO public.std_clients (clinic_id, client_id, first_name, last_name, phone, city, province, postal_code, first_visit)
  SELECT p_clinic_id, 'C' || c.record_num, c.first_name, c.last_name, COALESCE(c.phone, c.phone2), c.city, c.province, c.postal_code, c.created_at::date
  FROM public.clients c
  ON CONFLICT (clinic_id, client_id) DO NOTHING;
  GET DIAGNOSTICS client_count = ROW_COUNT;
  
  -- Patients
  INSERT INTO public.std_patients (clinic_id, patient_id, name, species, breed, weight)
  SELECT p_clinic_id, 'A' || a.record_num, a.name, a.species, a.breed, a.weight
  FROM public.animals a
  ON CONFLICT (clinic_id, patient_id) DO NOTHING;
  GET DIAGNOSTICS patient_count = ROW_COUNT;
  
  -- Appointments
  INSERT INTO public.std_appointments (clinic_id, appointment_id, appointment_date, doctor, reason, status)
  SELECT p_clinic_id, 'AP' || a.record_num, a.appt_date, a.doctor, a.reason, 'completed'
  FROM public.appointments a
  ON CONFLICT (clinic_id, appointment_id) DO NOTHING;
  GET DIAGNOSTICS appt_count = ROW_COUNT;
  
  -- Vaccines
  INSERT INTO public.std_vaccines (clinic_id, patient_id, vaccine_date, vaccine_name, doctor)
  SELECT p_clinic_id, 'A' || v.record_num, v.vaccine_date, v.manufacturer, v.doctor
  FROM public.vaccines v
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS vax_count = ROW_COUNT;
  
  -- Transactions (the big one)
  PERFORM standardize_avimark_transactions(p_clinic_id);
  SELECT COUNT(*) INTO txn_count FROM public.std_transactions WHERE clinic_id = p_clinic_id;
  
  RETURN jsonb_build_object(
    'services', svc_result,
    'transactions', txn_count,
    'visits', visit_count,
    'clients', client_count,
    'patients', patient_count,
    'appointments', appt_count,
    'vaccines', vax_count
  );
END;
$$;
