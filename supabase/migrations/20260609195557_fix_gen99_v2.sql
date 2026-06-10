CREATE OR REPLACE FUNCTION generate_99_campaign(p_clinic_id TEXT, p_min_unit NUMERIC DEFAULT 5, p_year INT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_campaign_id TEXT;
  v_year INT;
  inserted BIGINT;
  total_potential NUMERIC;
BEGIN
  v_year := COALESCE(p_year, EXTRACT(YEAR FROM NOW())::INT);
  v_campaign_id := 'price_ending_' || v_year || '_' || to_char(NOW(), 'YYYYMMDD_HH24MISS');
  
  IF EXISTS (SELECT 1 FROM std_approval_queue WHERE clinic_id = p_clinic_id AND strategy = 'price_ending' AND status = 'pending') THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'pending recommendations already exist');
  END IF;
  
  INSERT INTO std_approval_queue (
    clinic_id, campaign_id, service_code, service_name, strategy,
    old_price, suggested_price, price_increase_pct,
    expected_monthly_uplift, expected_annual_uplift, volume_risk, priority
  )
  SELECT 
    p_clinic_id,
    v_campaign_id,
    sub.service_code,
    sub.svc_name,
    'price_ending',
    sub.avg_unit,
    sub.new_price,
    sub.pct_increase,
    sub.monthly_uplift,
    sub.annual_uplift,
    sub.risk,
    sub.pri
  FROM (
    SELECT 
      service_code,
      MAX(description) as svc_name,
      ROUND((SUM(amount) / NULLIF(SUM(quantity), 0))::numeric, 2) as avg_unit,
      ROUND((CASE 
        WHEN (FLOOR(SUM(amount) / NULLIF(SUM(quantity), 0)) + 0.99) > (SUM(amount) / NULLIF(SUM(quantity), 0))
        THEN (FLOOR(SUM(amount) / NULLIF(SUM(quantity), 0)) + 0.99)
        ELSE (FLOOR(SUM(amount) / NULLIF(SUM(quantity), 0)) + 1.99)
      END)::numeric, 2) as new_price,
      ROUND(((CASE 
        WHEN (FLOOR(SUM(amount) / NULLIF(SUM(quantity), 0)) + 0.99) > (SUM(amount) / NULLIF(SUM(quantity), 0))
        THEN (FLOOR(SUM(amount) / NULLIF(SUM(quantity), 0)) + 0.99) - (SUM(amount) / NULLIF(SUM(quantity), 0))
        ELSE (FLOOR(SUM(amount) / NULLIF(SUM(quantity), 0)) + 1.99) - (SUM(amount) / NULLIF(SUM(quantity), 0))
      END) / NULLIF(SUM(amount) / NULLIF(SUM(quantity), 0), 0) * 100)::numeric, 1) as pct_increase,
      ROUND((SUM(
        CASE WHEN (ROUND((amount / quantity) * 100) % 100) NOT IN (99, 95) THEN
          (CASE 
            WHEN (FLOOR(amount / quantity) + 0.99) > (amount / quantity) THEN (FLOOR(amount / quantity) + 0.99) - (amount / quantity)
            ELSE (FLOOR(amount / quantity) + 1.99) - (amount / quantity)
          END) * quantity
        ELSE 0 END
      ) / 12)::numeric, 2) as monthly_uplift,
      ROUND(SUM(
        CASE WHEN (ROUND((amount / quantity) * 100) % 100) NOT IN (99, 95) THEN
          (CASE 
            WHEN (FLOOR(amount / quantity) + 0.99) > (amount / quantity) THEN (FLOOR(amount / quantity) + 0.99) - (amount / quantity)
            ELSE (FLOOR(amount / quantity) + 1.99) - (amount / quantity)
          END) * quantity
        ELSE 0 END
      )::numeric, 2) as annual_uplift,
      CASE 
        WHEN (0.99 / AVG(amount / NULLIF(quantity, 0))) * 100 < 3 THEN 'low'
        WHEN (0.99 / AVG(amount / NULLIF(quantity, 0))) * 100 < 8 THEN 'medium'
        ELSE 'high'
      END as risk,
      ROUND(SUM(CASE WHEN (ROUND((amount / quantity) * 100) % 100) NOT IN (99, 95) THEN
        (CASE 
          WHEN (FLOOR(amount / quantity) + 0.99) > (amount / quantity) THEN (FLOOR(amount / quantity) + 0.99) - (amount / quantity)
          ELSE (FLOOR(amount / quantity) + 1.99) - (amount / quantity)
        END) * quantity
      ELSE 0 END)::numeric, 0)::int as pri
    FROM std_transactions
    WHERE clinic_id = p_clinic_id
      AND EXTRACT(YEAR FROM txn_date) = v_year
      AND amount > 0 AND quantity >= 1
      AND description NOT ILIKE '%DECLINED%'
      AND (amount / quantity) >= p_min_unit
      AND (ROUND((amount / quantity) * 100) % 100) NOT IN (99, 95)
    GROUP BY service_code
    HAVING SUM(CASE WHEN (ROUND((amount / quantity) * 100) % 100) NOT IN (99, 95) THEN
      (CASE 
        WHEN (FLOOR(amount / quantity) + 0.99) > (amount / quantity) THEN (FLOOR(amount / quantity) + 0.99) - (amount / quantity)
        ELSE (FLOOR(amount / quantity) + 1.99) - (amount / quantity)
      END) * quantity
    ELSE 0 END) > 0
  ) sub;
  
  GET DIAGNOSTICS inserted = ROW_COUNT;
  
  SELECT ROUND(SUM(expected_annual_uplift)::numeric, 2) INTO total_potential
  FROM std_approval_queue WHERE clinic_id = p_clinic_id AND campaign_id = v_campaign_id;
  
  RETURN jsonb_build_object(
    'campaign_id', v_campaign_id,
    'recommendations', inserted,
    'total_annual_potential', total_potential
  );
END;
$$;
