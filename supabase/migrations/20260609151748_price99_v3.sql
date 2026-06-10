CREATE OR REPLACE FUNCTION analyze_99_pricing_clean(p_clinic_id TEXT, p_year INT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  result JSONB;
BEGIN
  SELECT jsonb_build_object(
    'year', p_year,
    'total_line_items', COUNT(*),
    'clean_items', SUM(CASE WHEN amount > 0 AND quantity >= 1 AND description NOT ILIKE '%DECLINED%' THEN 1 ELSE 0 END),
    'items_eligible', SUM(CASE 
      WHEN amount > 0 AND quantity >= 1 
        AND description NOT ILIKE '%DECLINED%'
        AND (amount / quantity) >= 2 
        AND (ROUND((amount / quantity) * 100) % 100) NOT IN (99, 95) 
      THEN 1 ELSE 0 END),
    'total_potential', ROUND(SUM(
      CASE 
        WHEN amount > 0 AND quantity >= 1 
          AND description NOT ILIKE '%DECLINED%'
          AND (amount / quantity) >= 2
          AND (ROUND((amount / quantity) * 100) % 100) NOT IN (99, 95) 
        THEN
          (CASE 
            WHEN (FLOOR(amount / quantity) + 0.99) > (amount / quantity) 
              THEN (FLOOR(amount / quantity) + 0.99) - (amount / quantity)
            ELSE (FLOOR(amount / quantity) + 1.99) - (amount / quantity)
          END) * quantity
        ELSE 0 
      END
    )::numeric, 2),
    'top_opportunities', (
      SELECT jsonb_agg(sub)
      FROM (
        SELECT jsonb_build_object(
          'code', service_code,
          'name', MIN(description),
          'unit_price', ROUND(AVG(amount / NULLIF(quantity, 0)), 2),
          'transactions', COUNT(*),
          'total_units', SUM(quantity),
          'potential', ROUND(SUM(
            CASE 
              WHEN (amount / quantity) >= 2
                AND (ROUND((amount / quantity) * 100) % 100) NOT IN (99, 95)
              THEN
                (CASE 
                  WHEN (FLOOR(amount / quantity) + 0.99) > (amount / quantity) 
                    THEN (FLOOR(amount / quantity) + 0.99) - (amount / quantity)
                  ELSE (FLOOR(amount / quantity) + 1.99) - (amount / quantity)
                END) * quantity
              ELSE 0 
            END
          )::numeric, 2)
        ) as sub
        FROM std_transactions
        WHERE clinic_id = p_clinic_id
          AND EXTRACT(YEAR FROM txn_date) = p_year
          AND amount > 0
          AND quantity >= 1
          AND description NOT ILIKE '%DECLINED%'
        GROUP BY service_code
        HAVING SUM(
          CASE 
            WHEN (amount / quantity) >= 2
              AND (ROUND((amount / quantity) * 100) % 100) NOT IN (99, 95)
            THEN
              (CASE 
                WHEN (FLOOR(amount / quantity) + 0.99) > (amount / quantity) 
                  THEN (FLOOR(amount / quantity) + 0.99) - (amount / quantity)
                ELSE (FLOOR(amount / quantity) + 1.99) - (amount / quantity)
              END) * quantity
            ELSE 0 
          END
        ) > 0
        ORDER BY SUM(
          CASE 
            WHEN (amount / quantity) >= 2
              AND (ROUND((amount / quantity) * 100) % 100) NOT IN (99, 95)
            THEN
              (CASE 
                WHEN (FLOOR(amount / quantity) + 0.99) > (amount / quantity) 
                  THEN (FLOOR(amount / quantity) + 0.99) - (amount / quantity)
                ELSE (FLOOR(amount / quantity) + 1.99) - (amount / quantity)
              END) * quantity
            ELSE 0 
          END
        ) DESC
        LIMIT 15
      ) sub
    )
  ) INTO result
  FROM std_transactions
  WHERE clinic_id = p_clinic_id
    AND EXTRACT(YEAR FROM txn_date) = p_year;
  
  RETURN result;
END;
$$;
