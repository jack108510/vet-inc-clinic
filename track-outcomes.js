#!/usr/bin/env node
/**
 * Vet INC — Outcome Tracker
 *
 * For each approved price change, computes pre vs post metrics (visits, revenue)
 * using the actual AVImark transaction data, then writes results to price_outcomes.
 *
 * Run this weekly, or before generating each new quarterly report:
 *   node track-outcomes.js [clinic_id]
 *   node track-outcomes.js rosslyn
 */

const CLINIC_ID   = process.argv[2] || 'rosslyn';
const WINDOW_DAYS = 90;  // compare 90-day window before vs after each price change
const MIN_POST_DAYS = 14; // skip if we don't have at least 14 days of post data

const SB_URL      = process.env.SB_URL      || 'https://rnqhhzatlxmyvccdvqkr.supabase.co';
const SB_KEY      = process.env.SB_SERVICE_KEY;
const MGMT_TOKEN  = process.env.SB_MGMT_TOKEN;
const PROJECT_REF = process.env.SB_PROJECT_REF || 'rnqhhzatlxmyvccdvqkr';

if (!SB_KEY || !MGMT_TOKEN) {
  console.error('Missing required env vars: SB_SERVICE_KEY and SB_MGMT_TOKEN');
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
function pct(val)   { return (val >= 0 ? '+' : '') + val.toFixed(1) + '%'; }
function fmtK(n)    { return n >= 1000 ? '$' + (n / 1000).toFixed(1) + 'K' : '$' + Math.round(n); }

// Basic sanitization — service codes are internal but let's be safe
function safeLiteral(s) { return String(s).replace(/'/g, "''").slice(0, 50); }

async function main() {
  console.log(`\n=== Vet INC Outcome Tracker ===`);
  console.log(`Clinic: ${CLINIC_ID} | Window: ${WINDOW_DAYS} days pre/post each change\n`);

  // 1. Ensure price_outcomes table exists
  await runSQL(`
    CREATE TABLE IF NOT EXISTS price_outcomes (
      id              uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
      clinic_id       text        NOT NULL,
      service_code    text        NOT NULL,
      service_name    text,
      review_id       text,
      approved_at     timestamptz,
      price_old       numeric,
      price_new       numeric,
      -- Pre-period metrics (WINDOW_DAYS before approval date)
      pre_visits      integer,
      pre_revenue     numeric,
      pre_avg_charge  numeric,
      -- Post-period metrics (up to WINDOW_DAYS after approval date)
      post_visits     integer,
      post_revenue    numeric,
      post_avg_charge numeric,
      -- Deltas (annualized to make windows comparable)
      visit_delta_pct   numeric,
      revenue_delta_pct numeric,
      charge_gap_pct    numeric,  -- how far actual avg charge is from confirmed price_new
      -- ok | flagged | no_data
      status          text        DEFAULT 'ok',
      computed_at     timestamptz DEFAULT now(),
      UNIQUE(clinic_id, service_code, review_id)
    )
  `);
  console.log('price_outcomes table ready.\n');

  // 2. Fetch all approved price changes for this clinic
  const appRes = await fetch(
    `${SB_URL}/rest/v1/price_approvals?clinic_id=eq.${CLINIC_ID}&status=eq.approved&select=*&order=approved_at.asc`,
    { headers: HEADERS }
  );
  if (!appRes.ok) throw new Error('Could not fetch approvals: ' + await appRes.text());
  const approvals = await appRes.json();

  console.log(`${approvals.length} approved changes found for ${CLINIC_ID}\n`);
  if (!approvals.length) {
    console.log('Nothing to track yet.');
    return;
  }

  const now = new Date();
  const outcomes = [];
  let skipped = 0;

  // 3. For each approved change, compute pre/post metrics
  for (const a of approvals) {
    if (!a.approved_at) { skipped++; continue; }

    const approvedAt = new Date(a.approved_at);
    const preStart   = new Date(approvedAt); preStart.setDate(approvedAt.getDate() - WINDOW_DAYS);
    const postEnd    = new Date(approvedAt); postEnd.setDate(approvedAt.getDate() + WINDOW_DAYS);
    const postActual = postEnd > now ? now : postEnd;

    const postDays = Math.max(1, Math.round((postActual - approvedAt) / 86400000));
    if (postDays < MIN_POST_DAYS) {
      console.log(`  SKIP ${a.service_code} — only ${postDays} days of post data`);
      skipped++;
      continue;
    }

    const code = safeLiteral(a.service_code);

    const [preRows, postRows] = await Promise.all([
      runSQL(`
        SELECT COUNT(*) AS visits, SUM(amount) AS revenue, AVG(amount) AS avg_charge
        FROM services
        WHERE code = '${code}'
          AND service_date >= '${isoDate(preStart)}'
          AND service_date < '${isoDate(approvedAt)}'
          AND amount > 0
      `),
      runSQL(`
        SELECT COUNT(*) AS visits, SUM(amount) AS revenue, AVG(amount) AS avg_charge
        FROM services
        WHERE code = '${code}'
          AND service_date >= '${isoDate(approvedAt)}'
          AND service_date < '${isoDate(postActual)}'
          AND amount > 0
      `)
    ]);

    const pre  = preRows[0]  || {};
    const post = postRows[0] || {};

    // Normalize to per-day rates so different window lengths are comparable
    const preRate  = { v: parseFloat(pre.visits  || 0) / WINDOW_DAYS, r: parseFloat(pre.revenue  || 0) / WINDOW_DAYS };
    const postRate = { v: parseFloat(post.visits || 0) / postDays,    r: parseFloat(post.revenue || 0) / postDays    };

    // Annualize for display
    const preVisits  = Math.round(preRate.v  * 365);
    const postVisits = Math.round(postRate.v * 365);
    const preRev     = Math.round(preRate.r  * 365);
    const postRev    = Math.round(postRate.r * 365);
    const preAvg     = parseFloat(pre.avg_charge  || 0);
    const postAvg    = parseFloat(post.avg_charge || 0);

    const visitDelta   = preRate.v > 0 ? ((postRate.v - preRate.v) / preRate.v * 100) : 0;
    const revDelta     = preRate.r > 0 ? ((postRate.r - preRate.r) / preRate.r * 100) : 0;
    // How far actual average charge deviates from the confirmed new price
    // Negative = charge is lower than confirmed (price wasn't entered, or discounts being applied)
    const chargeGap    = a.price_new > 0 ? ((postAvg - Number(a.price_new)) / Number(a.price_new) * 100) : 0;

    // Flagging logic: revenue down >5% OR visits down >15%
    let status = 'ok';
    if (preVisits === 0 && postVisits === 0) status = 'no_data';
    else if (revDelta < -5 || visitDelta < -15) status = 'flagged';

    outcomes.push({
      clinic_id:         CLINIC_ID,
      service_code:      a.service_code,
      service_name:      a.service_name,
      review_id:         a.review_id,
      approved_at:       a.approved_at,
      price_old:         parseFloat(Number(a.price_old).toFixed(2)),
      price_new:         parseFloat(Number(a.price_new).toFixed(2)),
      pre_visits:        preVisits,
      pre_revenue:       preRev,
      pre_avg_charge:    parseFloat(preAvg.toFixed(2)),
      post_visits:       postVisits,
      post_revenue:      postRev,
      post_avg_charge:   parseFloat(postAvg.toFixed(2)),
      visit_delta_pct:   parseFloat(visitDelta.toFixed(1)),
      revenue_delta_pct: parseFloat(revDelta.toFixed(1)),
      charge_gap_pct:    parseFloat(chargeGap.toFixed(1)),
      status,
      computed_at:       now.toISOString()
    });

    const icon = status === 'flagged' ? '⚠' : status === 'no_data' ? '—' : '✓';
    const revStr  = `${fmtK(preRev)}→${fmtK(postRev)} (${pct(revDelta)})`;
    const visStr  = `${preVisits}→${postVisits} (${pct(visitDelta)})`;
    const gapStr  = chargeGap < -5 ? ` AVG GAP ${pct(chargeGap)}` : '';
    console.log(`  ${icon} ${a.service_code.padEnd(10)} ${(a.service_name || '').slice(0, 28).padEnd(28)} visits: ${visStr.padEnd(22)} rev: ${revStr}${gapStr}`);
  }

  if (!outcomes.length) {
    console.log(`\nNothing written (${skipped} skipped — insufficient post-period data).`);
    return;
  }

  // 4. Upsert to price_outcomes (merge on clinic_id + service_code + review_id)
  console.log(`\nWriting ${outcomes.length} outcomes to Supabase…`);
  const BATCH = 25;
  let written = 0;
  for (let i = 0; i < outcomes.length; i += BATCH) {
    const batch = outcomes.slice(i, i + BATCH);
    const res = await fetch(`${SB_URL}/rest/v1/price_outcomes`, {
      method: 'POST',
      headers: { ...HEADERS, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(batch)
    });
    if (!res.ok) console.error(`  Batch ${i} error:`, await res.text());
    else written += batch.length;
  }

  // Summary
  const flagged = outcomes.filter(o => o.status === 'flagged');
  const goodOnes = outcomes.filter(o => o.status === 'ok');
  const totalPreRev  = outcomes.filter(o => o.status !== 'no_data').reduce((s, o) => s + o.pre_revenue,  0);
  const totalPostRev = outcomes.filter(o => o.status !== 'no_data').reduce((s, o) => s + o.post_revenue, 0);
  const overallRevDelta = totalPreRev > 0 ? ((totalPostRev - totalPreRev) / totalPreRev * 100) : 0;

  console.log(`\n✅ Done. ${written} outcomes written | ${skipped} skipped.`);
  console.log(`   Overall revenue change: ${pct(overallRevDelta)} (${goodOnes.length} good, ${flagged.length} flagged)`);

  if (flagged.length) {
    console.log(`\n⚠  Flagged services (review before next round of increases):`);
    flagged.forEach(o =>
      console.log(`   ${o.service_code}  ${(o.service_name || '').slice(0, 30)}  visits ${pct(o.visit_delta_pct)}  revenue ${pct(o.revenue_delta_pct)}`)
    );
  }
  console.log();
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
