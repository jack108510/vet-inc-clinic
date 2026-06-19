#!/usr/bin/env node
/**
 * Vet INC — Daily Outcome Monitor
 *
 * Runs every day after the ETL pulls fresh clinic data.
 * For each approved price change, compares:
 *   - Baseline: the 30 days before the price was raised
 *   - Current:  the most recent 30 days of actual transactions
 *
 * If a service's visits or revenue has dropped significantly vs baseline,
 * it gets flagged for immediate owner review in the portal.
 *
 * Flags persist until the owner acts. Dismissed services ("monitoring") are
 * re-checked after 30 days and re-flagged if still underperforming.
 *
 * Usage:
 *   node track-outcomes.js [clinic_id]
 *   node track-outcomes.js rosslyn
 *
 * Cron (run daily at 6am after ETL):
 *   0 6 * * * cd /path/to/dashboard && node track-outcomes.js rosslyn
 */

import { sendAlertEmail } from './send-email.js';

// Clinic config — owner email per clinic_id
const CLINIC_CONFIG = {
  rosslyn: { name: 'Rosslyn Veterinary Clinic', ownerEmail: 'info@rosslynvet.com' }
};

const CLINIC_ID      = process.argv[2] || 'rosslyn';
const BASELINE_DAYS  = 30;   // window before price change (pre-change baseline)
const CURRENT_DAYS   = 30;   // most recent window to compare against
const MIN_DATA_DAYS  = 7;    // skip service if we have < 7 days of post-change data
const REVISIT_DAYS   = 30;   // re-check dismissed ("monitoring") services after this many days

// Thresholds — either triggers a flag
const REVENUE_DROP_THRESHOLD = -0.05;  // -5%  revenue vs baseline
const VISIT_DROP_THRESHOLD   = -0.15;  // -15% visits   vs baseline

const SB_URL      = process.env.SB_URL      || 'https://rnqhhzatlxmyvccdvqkr.supabase.co';
const SB_KEY      = process.env.SB_SERVICE_KEY;
const MGMT_TOKEN  = process.env.SB_MGMT_TOKEN;
const PROJECT_REF = process.env.SB_PROJECT_REF || 'rnqhhzatlxmyvccdvqkr';

if (!SB_KEY || !MGMT_TOKEN) {
  console.error('Missing env: SB_SERVICE_KEY and SB_MGMT_TOKEN');
  process.exit(1);
}

const HEADERS = {
  'apikey': SB_KEY,
  'Authorization': 'Bearer ' + SB_KEY,
  'Content-Type': 'application/json'
};

async function runSQL(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + MGMT_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query })
  });
  if (!res.ok) throw new Error(`SQL error ${res.status}: ${await res.text()}`);
  return res.json();
}

function isoDate(d) { return d.toISOString().slice(0, 10); }
function pct(v)     { return (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%'; }
function fmtK(n)    { return n >= 1000 ? '$' + (n / 1000).toFixed(1) + 'K' : '$' + Math.round(n); }
function safeSql(s) { return String(s).replace(/'/g, "''").slice(0, 50); }

async function getWindowMetrics(code, fromDate, toDate) {
  const rows = await runSQL(`
    SELECT COUNT(*)::int AS visits, COALESCE(SUM(amount), 0) AS revenue, COALESCE(AVG(amount), 0) AS avg_charge
    FROM services
    WHERE code = '${safeSql(code)}'
      AND service_date >= '${isoDate(fromDate)}'
      AND service_date < '${isoDate(toDate)}'
      AND amount > 0
  `);
  const r = rows[0] || {};
  const days = Math.max(1, Math.round((toDate - fromDate) / 86400000));
  return {
    visits:     parseInt(r.visits)    || 0,
    revenue:    parseFloat(r.revenue) || 0,
    avg_charge: parseFloat(r.avg_charge) || 0,
    // per-day rates for fair comparison across different window lengths
    visit_rate:   (parseInt(r.visits) || 0)    / days,
    revenue_rate: (parseFloat(r.revenue) || 0) / days,
  };
}

async function ensureTable() {
  await runSQL(`
    CREATE TABLE IF NOT EXISTS price_outcomes (
      id                uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
      clinic_id         text        NOT NULL,
      service_code      text        NOT NULL,
      service_name      text,
      review_id         text,
      approved_at       timestamptz,
      price_old         numeric,
      price_new         numeric,
      -- Baseline (30 days before price change)
      baseline_visits   integer,
      baseline_revenue  numeric,
      baseline_avg_charge numeric,
      -- Current (most recent 30 days)
      current_visits    integer,
      current_revenue   numeric,
      current_avg_charge  numeric,
      -- Deltas vs baseline (rate-adjusted)
      visit_delta_pct   numeric,
      revenue_delta_pct numeric,
      charge_gap_pct    numeric,
      -- Status lifecycle:
      --   ok         → performing fine
      --   flagged    → underperforming, needs owner review
      --   monitoring → owner dismissed, re-check after REVISIT_DAYS
      --   adjusted   → owner changed the price, resolved
      --   no_data    → not enough transactions to measure
      status            text        DEFAULT 'ok',
      last_flagged_at   timestamptz,
      dismissed_at      timestamptz,
      computed_at       timestamptz DEFAULT now(),
      UNIQUE(clinic_id, service_code, review_id)
    )
  `);
}

async function loadExistingOutcomes() {
  const res = await fetch(
    `${SB_URL}/rest/v1/price_outcomes?clinic_id=eq.${CLINIC_ID}&select=*`,
    { headers: HEADERS }
  );
  if (!res.ok) throw new Error('Cannot fetch outcomes: ' + await res.text());
  const rows = await res.json();
  const map = {};
  rows.forEach(r => { map[r.service_code + '::' + r.review_id] = r; });
  return map;
}

async function main() {
  const now = new Date();
  console.log(`\n=== Vet INC Daily Monitor — ${isoDate(now)} ===`);
  console.log(`Clinic: ${CLINIC_ID} | Baseline: ${BASELINE_DAYS}d before change | Current: last ${CURRENT_DAYS}d\n`);

  await ensureTable();

  // Most recent data date (ETL may lag)
  const [dateRow] = await runSQL(`SELECT MAX(service_date)::date AS latest FROM services WHERE amount > 0`);
  const dataEnd  = new Date(dateRow.latest + 'T00:00:00');
  const dataStart = new Date(dataEnd); dataStart.setDate(dataEnd.getDate() - CURRENT_DAYS);
  console.log(`Data current through: ${isoDate(dataEnd)}\n`);

  // Fetch all approved price changes for this clinic
  const appRes = await fetch(
    `${SB_URL}/rest/v1/price_approvals?clinic_id=eq.${CLINIC_ID}&status=eq.approved&select=*&order=approved_at.asc`,
    { headers: HEADERS }
  );
  if (!appRes.ok) throw new Error('Cannot fetch approvals: ' + await appRes.text());
  const approvals = await appRes.json();
  console.log(`${approvals.length} approved price changes to check\n`);

  const existingOutcomes = await loadExistingOutcomes();

  const upserts = [];
  let newFlags = 0, cleared = 0, skipped = 0;

  for (const a of approvals) {
    if (!a.approved_at) { skipped++; continue; }

    const approvedAt = new Date(a.approved_at);
    const daysSinceApproval = Math.round((dataEnd - approvedAt) / 86400000);

    // Not enough post-change data yet
    if (daysSinceApproval < MIN_DATA_DAYS) {
      skipped++;
      continue;
    }

    const key      = a.service_code + '::' + a.review_id;
    const existing = existingOutcomes[key];

    // Skip services the owner already addressed
    if (existing?.status === 'adjusted') { skipped++; continue; }

    // Skip "monitoring" services until revisit window has passed
    if (existing?.status === 'monitoring' && existing.dismissed_at) {
      const daysDismissed = Math.round((now - new Date(existing.dismissed_at)) / 86400000);
      if (daysDismissed < REVISIT_DAYS) { skipped++; continue; }
    }

    // Compute baseline (30 days before approval) and current (last 30 days of data)
    const baselineEnd   = new Date(approvedAt);
    const baselineStart = new Date(approvedAt); baselineStart.setDate(approvedAt.getDate() - BASELINE_DAYS);

    const [baseline, current] = await Promise.all([
      getWindowMetrics(a.service_code, baselineStart, baselineEnd),
      getWindowMetrics(a.service_code, dataStart, dataEnd)
    ]);

    const visitDelta   = baseline.visit_rate   > 0 ? (current.visit_rate   - baseline.visit_rate)   / baseline.visit_rate   : 0;
    const revDelta     = baseline.revenue_rate > 0 ? (current.revenue_rate - baseline.revenue_rate) / baseline.revenue_rate : 0;
    const chargeGap    = a.price_new > 0 ? (current.avg_charge - Number(a.price_new)) / Number(a.price_new) : 0;

    // Annualize for display
    const baseVisits  = Math.round(baseline.visit_rate   * 365);
    const curVisits   = Math.round(current.visit_rate    * 365);
    const baseRev     = Math.round(baseline.revenue_rate * 365);
    const curRev      = Math.round(current.revenue_rate  * 365);

    // Determine new status
    let status = 'ok';
    if (baseline.visits === 0 && current.visits === 0) {
      status = 'no_data';
    } else if (revDelta < REVENUE_DROP_THRESHOLD || visitDelta < VISIT_DROP_THRESHOLD) {
      status = 'flagged';
      if (!existing || existing.status !== 'flagged') newFlags++;
    } else if (existing?.status === 'flagged' || existing?.status === 'monitoring') {
      // Was flagged but now recovered
      cleared++;
    }

    const icon = status === 'flagged' ? '⚠' : status === 'ok' ? '✓' : '—';
    console.log(
      `  ${icon} ${a.service_code.padEnd(10)} ${(a.service_name||'').slice(0,26).padEnd(26)}` +
      `  visits: ${baseVisits}→${curVisits} (${pct(visitDelta)})` +
      `  rev: ${fmtK(baseRev)}→${fmtK(curRev)} (${pct(revDelta)})` +
      (chargeGap < -0.05 ? `  ⚠ AVG CHARGE GAP ${pct(chargeGap)}` : '')
    );

    upserts.push({
      clinic_id:            CLINIC_ID,
      service_code:         a.service_code,
      service_name:         a.service_name,
      review_id:            a.review_id,
      approved_at:          a.approved_at,
      price_old:            parseFloat(Number(a.price_old).toFixed(2)),
      price_new:            parseFloat(Number(a.price_new).toFixed(2)),
      baseline_visits:      baseVisits,
      baseline_revenue:     baseRev,
      baseline_avg_charge:  parseFloat(baseline.avg_charge.toFixed(2)),
      current_visits:       curVisits,
      current_revenue:      curRev,
      current_avg_charge:   parseFloat(current.avg_charge.toFixed(2)),
      visit_delta_pct:      parseFloat((visitDelta * 100).toFixed(1)),
      revenue_delta_pct:    parseFloat((revDelta   * 100).toFixed(1)),
      charge_gap_pct:       parseFloat((chargeGap  * 100).toFixed(1)),
      status,
      last_flagged_at:      status === 'flagged' ? now.toISOString() : (existing?.last_flagged_at || null),
      dismissed_at:         status === 'flagged' ? null : (existing?.dismissed_at || null),
      computed_at:          now.toISOString()
    });
  }

  // Upsert all results
  if (upserts.length) {
    const BATCH = 25;
    let written = 0;
    for (let i = 0; i < upserts.length; i += BATCH) {
      const res = await fetch(`${SB_URL}/rest/v1/price_outcomes`, {
        method: 'POST',
        headers: { ...HEADERS, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(upserts.slice(i, i + BATCH))
      });
      if (!res.ok) console.error(`  Batch ${i} error:`, await res.text());
      else written += Math.min(BATCH, upserts.length - i);
    }
    console.log(`\n  ${written} records updated`);
  }

  const flagged    = upserts.filter(u => u.status === 'flagged');
  const newlyFlagged = upserts.filter(u => u.status === 'flagged' && (
    !existingOutcomes[u.service_code + '::' + u.review_id] ||
    existingOutcomes[u.service_code + '::' + u.review_id].status !== 'flagged'
  ));

  const portalUrl = `https://jack108510.github.io/vet-inc-clinic/owner.html?clinic=${CLINIC_ID}`;
  console.log(`\n✅ Done. ${newFlags} new flags | ${cleared} cleared | ${skipped} skipped`);

  if (flagged.length) {
    console.log(`\n⚠  Active flags requiring owner review:`);
    flagged.forEach(o =>
      console.log(`   ${o.service_code}  "${o.service_name}"  visits ${pct(o.visit_delta_pct / 100)}  revenue ${pct(o.revenue_delta_pct / 100)}`)
    );
    console.log(`\n   Portal: ${portalUrl}`);
  } else {
    console.log('   All monitored services performing at or above baseline.');
  }

  // Email owner only for newly flagged services (not ones already flagged yesterday)
  if (newlyFlagged.length > 0) {
    const clinic = CLINIC_CONFIG[CLINIC_ID];
    if (clinic?.ownerEmail) {
      console.log(`\nSending alert email to owner (${newlyFlagged.length} newly flagged)…`);
      try {
        await sendAlertEmail({
          to:           clinic.ownerEmail,
          clinicName:   clinic.name,
          flaggedItems: newlyFlagged,
          portalUrl
        });
      } catch (err) {
        console.warn('  Email failed:', err.message);
      }
    }
  }
  console.log();
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
