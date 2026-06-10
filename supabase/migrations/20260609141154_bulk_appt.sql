CREATE OR REPLACE FUNCTION bulk_copy_appointments(p_clinic_id TEXT) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE c BIGINT;
BEGIN
  INSERT INTO std_appointments (clinic_id, appointment_id, appointment_date, doctor, reason, status)
  SELECT 
    p_clinic_id,
    'AP' || a.record_num,
    COALESCE((a.appt_date)::date, '2020-01-01'::date),
    COALESCE(a.doctor, ''),
    COALESCE(a.reason, ''),
    'completed'
  FROM public.appointments a
  ON CONFLICT (clinic_id, appointment_id) DO NOTHING;
  GET DIAGNOSTICS c = ROW_COUNT;
  RETURN c;
END;
$$;
