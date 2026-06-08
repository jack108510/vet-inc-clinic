-- Campaign Tracking Tables for Vet INC v1.1
-- Run these in Supabase SQL Editor

-- 1. Campaigns table
CREATE TABLE IF NOT EXISTS campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id TEXT NOT NULL DEFAULT 'rosslyn',
  campaign_type TEXT NOT NULL, -- 'inflation', '99-pricing', 'micro-margin'
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', -- 'draft', 'active', 'paused', 'completed'
  activated_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  total_items INT DEFAULT 0,
  implemented_items INT DEFAULT 0,
  total_potential NUMERIC DEFAULT 0,
  total_captured NUMERIC DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Campaign items (individual line items to track)
CREATE TABLE IF NOT EXISTS campaign_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID REFERENCES campaigns(id) ON DELETE CASCADE,
  treatment_code TEXT NOT NULL,
  treatment_name TEXT,
  old_price NUMERIC NOT NULL,
  suggested_price NUMERIC NOT NULL,
  current_price NUMERIC, -- updated by ETL check
  status TEXT DEFAULT 'pending', -- 'pending', 'implemented', 'skipped'
  implemented_at TIMESTAMPTZ,
  annual_volume INT DEFAULT 0,
  potential_uplift NUMERIC DEFAULT 0, -- annual
  captured_uplift NUMERIC DEFAULT 0, -- actual captured
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Campaign history (audit log)
CREATE TABLE IF NOT EXISTS campaign_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID REFERENCES campaigns(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL, -- 'activated', 'item_implemented', 'paused', 'completed'
  event_data JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Campaign snapshots (daily rollups for analytics)
CREATE TABLE IF NOT EXISTS campaign_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID REFERENCES campaigns(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL,
  implemented_count INT DEFAULT 0,
  total_count INT DEFAULT 0,
  captured_revenue NUMERIC DEFAULT 0,
  potential_revenue NUMERIC DEFAULT 0,
  UNIQUE(campaign_id, snapshot_date)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_campaign_items_campaign ON campaign_items(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_items_status ON campaign_items(status);
CREATE INDEX IF NOT EXISTS idx_campaign_history_campaign ON campaign_history(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_snapshots_campaign_date ON campaign_snapshots(campaign_id, snapshot_date);

-- Row Level Security
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_snapshots ENABLE ROW LEVEL SECURITY;

-- Policies (allow anon for now - tighten in production)
CREATE POLICY "Allow all for campaigns" ON campaigns FOR ALL USING (true);
CREATE POLICY "Allow all for campaign_items" ON campaign_items FOR ALL USING (true);
CREATE POLICY "Allow all for campaign_history" ON campaign_history FOR ALL USING (true);
CREATE POLICY "Allow all for campaign_snapshots" ON campaign_snapshots FOR ALL USING (true);
