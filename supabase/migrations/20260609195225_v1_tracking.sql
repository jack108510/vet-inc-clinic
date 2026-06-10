-- ============================================================
-- V1 TRACKING: std_service_daily + campaign approval + results
-- This is the foundation. V2 adds guard triggers on top.
-- ============================================================

-- 1. Daily performance per service
CREATE TABLE IF NOT EXISTS std_service_daily (
  clinic_id TEXT NOT NULL,
  service_code TEXT NOT NULL,
  day DATE NOT NULL,
  price NUMERIC(10,2),           -- average unit price that day
  min_price NUMERIC(10,2),       -- lowest price sold that day
  max_price NUMERIC(10,2),       -- highest price sold that day
  quantity NUMERIC(10,2),        -- total units sold
  revenue NUMERIC(12,2),         -- total revenue
  transactions INTEGER,          -- number of line items
  unique_clients INTEGER,        -- distinct client_ids (approx via txn_id grouping)
  computed_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(clinic_id, service_code, day)
);

ALTER TABLE std_service_daily ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full" ON std_service_daily FOR ALL 
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
CREATE POLICY "users_read_own" ON std_service_daily FOR SELECT 
  USING (clinic_id IN (SELECT clinic_id FROM meta_clinic_users WHERE user_id = auth.uid()));

CREATE INDEX idx_svc_daily_clinic_day ON std_service_daily(clinic_id, day);
CREATE INDEX idx_svc_daily_clinic_code ON std_service_daily(clinic_id, service_code);

-- 2. Baseline snapshots (captured before any changes)
CREATE TABLE IF NOT EXISTS std_service_baselines (
  clinic_id TEXT NOT NULL,
  service_code TEXT NOT NULL,
  campaign_id TEXT,
  baseline_date DATE NOT NULL,         -- when the baseline was captured
  avg_daily_revenue NUMERIC(12,2),      -- average daily revenue before change
  avg_daily_volume NUMERIC(10,2),       -- average daily units before change
  avg_unit_price NUMERIC(10,2),         -- average price per unit before change
  period_days INTEGER,                  -- how many days of history (e.g. 90)
  old_price NUMERIC(10,2),              -- price before change
  new_price NUMERIC(10,2),             -- price after change
  expected_daily_uplift NUMERIC(10,2),  -- how much more per day we expect
  status TEXT DEFAULT 'active' CHECK (status IN ('active','completed','rolled_back')),
  approved_at TIMESTAMPTZ,
  approved_by UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(clinic_id, service_code, campaign_id)
);

ALTER TABLE std_service_baselines ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full" ON std_service_baselines FOR ALL 
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- 3. Campaign results tracking (computed daily per service)
CREATE TABLE IF NOT EXISTS std_campaign_results (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id TEXT NOT NULL,
  service_code TEXT NOT NULL,
  campaign_id TEXT,
  day DATE NOT NULL,
  baseline_daily_revenue NUMERIC(12,2),  -- what they would have made
  actual_daily_revenue NUMERIC(12,2),     -- what they actually made
  captured_uplift NUMERIC(12,2),          -- the difference (our value)
  baseline_daily_volume NUMERIC(10,2),    -- expected volume
  actual_daily_volume NUMERIC(10,2),      -- actual volume
  volume_change_pct NUMERIC(6,2),         -- e.g. -5.2% means volume dropped
  price_implemented BOOLEAN,              -- is the new price actually in effect?
  computed_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(clinic_id, service_code, campaign_id, day)
);

ALTER TABLE std_campaign_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full" ON std_campaign_results FOR ALL 
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
CREATE POLICY "users_read_own" ON std_campaign_results FOR SELECT 
  USING (clinic_id IN (SELECT clinic_id FROM meta_clinic_users WHERE user_id = auth.uid()));

CREATE INDEX idx_campaign_res_clinic_day ON std_campaign_results(clinic_id, day);

-- 4. Approval queue (clinic owner approves/dismisses recommendations)
CREATE TABLE IF NOT EXISTS std_approval_queue (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id TEXT NOT NULL,
  campaign_id TEXT,
  service_code TEXT NOT NULL,
  service_name TEXT,
  strategy TEXT NOT NULL,               -- 'inflation_catchup' / 'price_ending' / 'margin_growth' / 'loss_leader'
  old_price NUMERIC(10,2),
  suggested_price NUMERIC(10,2),
  price_increase_pct NUMERIC(6,2),
  expected_monthly_uplift NUMERIC(12,2),
  expected_annual_uplift NUMERIC(12,2),
  volume_risk TEXT DEFAULT 'low' CHECK (volume_risk IN ('low','medium','high')),
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','approved','dismissed','implemented','rolled_back')),
  approved_at TIMESTAMPTZ,
  approved_by UUID,
  implemented_at TIMESTAMPTZ,
  dismissed_reason TEXT,
  priority INTEGER DEFAULT 0,           -- higher = shown first
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE std_approval_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full" ON std_approval_queue FOR ALL 
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
CREATE POLICY "users_read_own" ON std_approval_queue FOR SELECT 
  USING (clinic_id IN (SELECT clinic_id FROM meta_clinic_users WHERE user_id = auth.uid()));

-- ============================================================
-- FUNCTIONS
-- ============================================================

-- Compute std_service_daily from transactions for a given day range
CREATE OR REPLACE FUNCTION compute_service_daily(p_clinic_id TEXT, p_start_date DATE, p_end_date DATE)
RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  inserted BIGINT;
BEGIN
  DELETE FROM std_service_daily 
  WHERE clinic_id = p_clinic_id AND day >= p_start_date AND day < p_end_date;
  
  INSERT INTO std_service_daily (clinic_id, service_code, day, price, min_price, max_price, quantity, revenue, transactions)
  SELECT 
    p_clinic_id,
    service_code,
    txn_date,
    ROUND((SUM(amount) / NULLIF(SUM(quantity), 0))::numeric, 2),
    ROUND(MIN(amount / NULLIF(quantity, 0))::numeric, 2),
    ROUND(MAX(amount / NULLIF(quantity, 0))::numeric, 2),
    SUM(quantity),
    SUM(amount),
    COUNT(*)
  FROM std_transactions
  WHERE clinic_id = p_clinic_id
    AND txn_date >= p_start_date
    AND txn_date < p_end_date
    AND amount > 0
    AND quantity > 0
    AND description NOT ILIKE '%DECLINED%'
  GROUP BY service_code, txn_date
  ON CONFLICT (clinic_id, service_code, day) DO UPDATE SET
    price = EXCLUDED.price,
    min_price = EXCLUDED.min_price,
    max_price = EXCLUDED.max_price,
    quantity = EXCLUDED.quantity,
    revenue = EXCLUDED.revenue,
    transactions = EXCLUDED.transactions,
    computed_at = NOW();
  
  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted;
END;
$$;

-- Generate 99-cent pricing recommendations into approval queue
CREATE OR REPLACE FUNCTION generate_99_campaign(p_clinic_id TEXT, p_min_unit NUMERIC DEFAULT 5)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  campaign_id TEXT;
  inserted BIGINT;
  total_potential NUMERIC;
BEGIN
  campaign_id := 'price_ending_' || to_char(NOW(), 'YYYYMMDD_HH24MISS');
  
  -- Find active campaign of same type and skip if exists
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
    campaign_id,
    service_code,
    MAX(description),
    'price_ending',
    ROUND((SUM(amount) / NULLIF(SUM(quantity), 0))::numeric, 2),
    ROUND((CASE 
      WHEN (FLOOR(SUM(amount) / NULLIF(SUM(quantity), 0)) + 0.99) > (SUM(amount) / NULLIF(SUM(quantity), 0))
      THEN (FLOOR(SUM(amount) / NULLIF(SUM(quantity), 0)) + 0.99)
      ELSE (FLOOR(SUM(amount) / NULLIF(SUM(quantity), 0)) + 1.99)
    END)::numeric, 2),
    ROUND(((CASE 
      WHEN (FLOOR(SUM(amount) / NULLIF(SUM(quantity), 0)) + 0.99) > (SUM(amount) / NULLIF(SUM(quantity), 0))
      THEN (FLOOR(SUM(amount) / NULLIF(SUM(quantity), 0)) + 0.99) - (SUM(amount) / NULLIF(SUM(quantity), 0))
      ELSE (FLOOR(SUM(amount) / NULLIF(SUM(quantity), 0)) + 1.99) - (SUM(amount) / NULLIF(SUM(quantity), 0)
    )
    END) / NULLIF(SUM(amount) / NULLIF(SUM(quantity), 0), 0) * 100)::numeric, 1),
    ROUND((SUM(
      CASE WHEN (ROUND((amount / quantity) * 100) % 100) NOT IN (99, 95) THEN
        (CASE 
          WHEN (FLOOR(amount / quantity) + 0.99) > (amount / quantity) THEN (FLOOR(amount / quantity) + 0.99) - (amount / quantity)
          ELSE (FLOOR(amount / quantity) + 1.99) - (amount / quantity)
        END) * quantity
      ELSE 0 END
    ) / 12)::numeric, 2),
    ROUND(SUM(
      CASE WHEN (ROUND((amount / quantity) * 100) % 100) NOT IN (99, 95) THEN
        (CASE 
          WHEN (FLOOR(amount / quantity) + 0.99) > (amount / quantity) THEN (FLOOR(amount / quantity) + 0.99) - (amount / quantity)
          ELSE (FLOOR(amount / quantity) + 1.99) - (amount / quantity)
        END) * quantity
      ELSE 0 END
    )::numeric, 2),
    CASE 
      WHEN (0.99 / AVG(amount / NULLIF(quantity, 0))) * 100 < 3 THEN 'low'
      WHEN (0.99 / AVG(amount / NULLIF(quantity, 0))) * 100 < 8 THEN 'medium'
      ELSE 'high'
    END,
    ROUND(SUM(CASE WHEN (ROUND((amount / quantity) * 100) % 100) NOT IN (99, 95) THEN
      (CASE 
        WHEN (FLOOR(amount / quantity) + 0.99) > (amount / quantity) THEN (FLOOR(amount / quantity) + 0.99) - (amount / quantity)
        ELSE (FLOOR(amount / quantity) + 1.99) - (amount / quantity)
      END) * quantity
    ELSE 0 END)::numeric, 0)::int
  FROM std_transactions
  WHERE clinic_id = p_clinic_id
    AND EXTRACT(YEAR FROM txn_date) = EXTRACT(YEAR FROM NOW())
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
  ELSE 0 END) > 0;
  
  GET DIAGNOSTICS inserted = ROW_COUNT;
  
  SELECT ROUND(SUM(expected_annual_uplift)::numeric, 2) INTO total_potential
  FROM std_approval_queue WHERE clinic_id = p_clinic_id AND campaign_id = campaign_id;
  
  RETURN jsonb_build_object(
    'campaign_id', campaign_id,
    'recommendations', inserted,
    'total_annual_potential', total_potential
  );
END;
$$;

-- Approve a recommendation — captures baseline and marks approved
CREATE OR REPLACE FUNCTION approve_recommendation(p_queue_id BIGINT, p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  rec RECORD;
  baseline_days INTEGER := 90;
  avg_rev NUMERIC;
  avg_vol NUMERIC;
  avg_price NUMERIC;
BEGIN
  SELECT * INTO rec FROM std_approval_queue WHERE id = p_queue_id AND status = 'pending';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not found or not pending');
  END IF;
  
  -- Compute baseline from last 90 days
  SELECT ROUND(AVG(revenue)::numeric, 2), ROUND(AVG(quantity)::numeric, 2), ROUND(AVG(price)::numeric, 2)
  INTO avg_rev, avg_vol, avg_price
  FROM std_service_daily
  WHERE clinic_id = rec.clinic_id
    AND service_code = rec.service_code
    AND day >= (NOW() - (baseline_days || ' days')::interval)::date
    AND day < NOW()::date;
  
  -- Save baseline
  INSERT INTO std_service_baselines (
    clinic_id, service_code, campaign_id, baseline_date,
    avg_daily_revenue, avg_daily_volume, avg_unit_price, period_days,
    old_price, new_price, expected_daily_uplift,
    status, approved_at, approved_by
  ) VALUES (
    rec.clinic_id, rec.service_code, rec.campaign_id, NOW()::date,
    COALESCE(avg_rev, 0), COALESCE(avg_vol, 0), COALESCE(avg_price, rec.old_price), baseline_days,
    rec.old_price, rec.suggested_price, ROUND((rec.expected_monthly_uplift / 30)::numeric, 2),
    'active', NOW(), p_user_id
  );
  
  -- Mark approved
  UPDATE std_approval_queue SET status = 'approved', approved_at = NOW(), approved_by = p_user_id
  WHERE id = p_queue_id;
  
  RETURN jsonb_build_object(
    'status', 'approved',
    'service', rec.service_code,
    'old_price', rec.old_price,
    'new_price', rec.suggested_price,
    'baseline_daily_revenue', avg_rev,
    'baseline_daily_volume', avg_vol
  );
END;
$$;

-- Dismiss a recommendation
CREATE OR REPLACE FUNCTION dismiss_recommendation(p_queue_id BIGINT, p_reason TEXT DEFAULT '')
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE std_approval_queue SET status = 'dismissed', dismissed_reason = p_reason
  WHERE id = p_queue_id AND status = 'pending';
  RETURN FOUND;
END;
$$;

-- Compute campaign results for a given day
CREATE OR REPLACE FUNCTION compute_campaign_results(p_clinic_id TEXT, p_day DATE)
RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  c BIGINT;
BEGIN
  INSERT INTO std_campaign_results (
    clinic_id, service_code, campaign_id, day,
    baseline_daily_revenue, actual_daily_revenue, captured_uplift,
    baseline_daily_volume, actual_daily_volume, volume_change_pct,
    price_implemented
  )
  SELECT 
    b.clinic_id,
    b.service_code,
    b.campaign_id,
    p_day,
    b.avg_daily_revenue,
    COALESCE(d.revenue, 0),
    COALESCE(d.revenue, 0) - b.avg_daily_revenue,
    b.avg_daily_volume,
    COALESCE(d.quantity, 0),
    CASE WHEN b.avg_daily_volume > 0 
      THEN ROUND(((COALESCE(d.quantity, 0) - b.avg_daily_volume) / b.avg_daily_volume * 100)::numeric, 1)
      ELSE 0 
    END,
    COALESCE(d.price = b.new_price, FALSE)
  FROM std_service_baselines b
  LEFT JOIN std_service_daily d ON d.clinic_id = b.clinic_id AND d.service_code = b.service_code AND d.day = p_day
  WHERE b.clinic_id = p_clinic_id
    AND b.status = 'active'
  ON CONFLICT (clinic_id, service_code, campaign_id, day) DO UPDATE SET
    baseline_daily_revenue = EXCLUDED.baseline_daily_revenue,
    actual_daily_revenue = EXCLUDED.actual_daily_revenue,
    captured_uplift = EXCLUDED.captured_uplift,
    baseline_daily_volume = EXCLUDED.baseline_daily_volume,
    actual_daily_volume = EXCLUDED.actual_daily_volume,
    volume_change_pct = EXCLUDED.volume_change_pct,
    price_implemented = EXCLUDED.price_implemented,
    computed_at = NOW();
  
  GET DIAGNOSTICS c = ROW_COUNT;
  RETURN c;
END;
$$;

