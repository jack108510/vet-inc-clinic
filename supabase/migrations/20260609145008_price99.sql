-- 99-cent pricing analysis: per-line-item, 2025 only
-- For each transaction, round up to nearest X.99, sum the difference
CREATE OR REPLACE FUNCTION analyze_99_pricing(p_clinic_id TEXT, p_year INT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  result JSONB;
BEGIN
  SELECT jsonb_build_object(
    'year', p_year,
    'total_line_items', COUNT(*),
    'items_not_99', SUM(CASE WHEN (ROUND(amount * 100) % 100) NOT IN (99, 95) AND amount >= 2 THEN 1 ELSE 0 END),
    'avg_price', ROUND(AVG(CASE WHEN amount >= 2 THEN amount END), 2),
    'total_potential', ROUND(SUM(
      CASE 
        WHEN amount >= 2 AND (ROUND(amount * 100) % 100) NOT IN (99, 95) THEN
          -- Round up to nearest X.99
          CASE 
            WHEN (FLOOR(amount) + 0.99) > amount THEN (FLOOR(amount) + 0.99) - amount
            ELSE (FLOOR(amount) + 1.99) - amount
          END
        ELSE 0 
      END
    )::numeric, 2),
    'top_opportunities', (
      SELECT jsonb_agg(sub)
      FROM (
        SELECT jsonb_build_object(
          'code', service_code,
          'name', MIN(description),
          'avg_price', ROUND(AVG(amount), 2),
          'count', COUNT(*),
          'potential', ROUND(SUM(
            CASE 
              WHEN (ROUND(amount * 100) % 100) NOT IN (99, 95) AND amount >= 2 THEN
                CASE 
                  WHEN (FLOOR(amount) + 0.99) > amount THEN (FLOOR(amount) + 0.99) - amount
                  ELSE (FLOOR(amount) + 1.99) - amount
                END
              ELSE 0 
            END
          )::numeric, 2)
        ) as sub
        FROM std_transactions
        WHERE clinic_id = p_clinic_id
          AND EXTRACT(YEAR FROM txn_date) = p_year
          AND amount >= 2
        GROUP BY service_code
        HAVING SUM(
          CASE 
            WHEN (ROUND(amount * 100) % 100) NOT IN (99, 95) THEN
              CASE 
                WHEN (FLOOR(amount) + 0.99) > amount THEN (FLOOR(amount) + 0.99) - amount
                ELSE (FLOOR(amount) + 1.99) - amount
              END
            ELSE 0 
          END
        ) > 0
        ORDER BY SUM(
          CASE 
            WHEN (ROUND(amount * 100) % 100) NOT IN (99, 95) THEN
              CASE 
                WHEN (FLOOR(amount) + 0.99) > amount THEN (FLOOR(amount) + 0.99) - amount
                ELSE (FLOOR(amount) + 1.99) - amount
              END
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
