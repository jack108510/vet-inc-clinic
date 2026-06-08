-- Campaign Health Tracking - Vet INC v1.4
-- Run these in Supabase SQL Editor

-- 1. Extend campaign_snapshots with health metrics
ALTER TABLE campaign_snapshots ADD COLUMN IF NOT EXISTS daily_revenue NUMERIC;
ALTER TABLE campaign_snapshots ADD COLUMN IF NOT EXISTS daily_visits INT;
ALTER TABLE campaign_snapshots ADD COLUMN IF NOT EXISTS exam_count INT;
ALTER TABLE campaign_snapshots ADD COLUMN IF NOT EXISTS exam_revenue NUMERIC;
ALTER TABLE campaign_snapshots ADD COLUMN IF NOT EXISTS avg_visit_value NUMERIC;
ALTER TABLE campaign_snapshots ADD COLUMN IF NOT EXISTS unique_clients INT;

-- 2. Campaign baselines (pre-change averages)
CREATE TABLE IF NOT EXISTS campaign_baselines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID REFERENCES campaigns(id) ON DELETE CASCADE,
  metric TEXT NOT NULL,
  baseline_value NUMERIC NOT NULL,
  baseline_period TEXT DEFAULT '90d',
  alert_threshold NUMERIC DEFAULT -10,
  captured_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(campaign_id, metric)
);

-- 3. Campaign alerts (automatic dip detection)
CREATE TABLE IF NOT EXISTS campaign_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID REFERENCES campaigns(id) ON DELETE CASCADE,
  alert_date DATE NOT NULL,
  metric TEXT NOT NULL,
  baseline_value NUMERIC NOT NULL,
  actual_value NUMERIC NOT NULL,
  pct_change NUMERIC NOT NULL,
  severity TEXT DEFAULT 'warning',
  acknowledged BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_baselines_campaign ON campaign_baselines(campaign_id);
CREATE INDEX IF NOT EXISTS idx_alerts_campaign ON campaign_alerts(campaign_id);
CREATE INDEX IF NOT EXISTS idx_alerts_date ON campaign_alerts(alert_date);
CREATE INDEX IF NOT EXISTS idx_alerts_ack ON campaign_alerts(acknowledged);
CREATE INDEX IF NOT EXISTS idx_snapshots_date ON campaign_snapshots(snapshot_date);

-- RLS
ALTER TABLE campaign_baselines ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for campaign_baselines" ON campaign_baselines FOR ALL USING (true);
CREATE POLICY "Allow all for campaign_alerts" ON campaign_alerts FOR ALL USING (true);
