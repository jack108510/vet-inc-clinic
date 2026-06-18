#!/usr/bin/env node
/**
 * Vet INC — Pricing Analysis Engine
 *
 * Scans all service prices in AVImark data, flags stale/underpriced services,
 * and auto-populates price_recommendations for the owner review queue.
 *
 * Usage:
 *   node analyze-prices.js [clinic_id] [review_id]
 *   node analyze-prices.js rosslyn q3-2026
 */

const CLINIC_ID  = process.argv[2] || 'rosslyn';
const REVIEW_ID  = process.argv[3] || (() => {
  const d = new Date();
  const q = Math.ceil((d.getMonth() + 1) / 3);
  return `q${q}-${d.getFullYear()}`;
})();

const SB_URL      = process.env.SB_URL      || 'https://rnqhhzatlxmyvccdvqkr.supabase.co';
const SB_KEY      = process.env.SB_SERVICE_KEY;
const MGMT_TOKEN  = process.env.SB_MGMT_TOKEN;
const PROJECT_REF = process.env.SB_PROJECT_REF || 'rnqhhzatlxmyvccdvqkr';

if (!SB_KEY || !MGMT_TOKEN) {
  console.error('Missing required env vars: SB_SERVICE_KEY and SB_MGMT_TOKEN');
  console.error('Copy .env.example to .env and fill in your Supabase credentials.');
  process.exit(1);
}

const HEADERS = {
  'apikey': SB_KEY,
  'Authorization': 'Bearer ' + SB_KEY,
  'Content-Type': 'application/json'
};

// Run raw SQL via Supabase Management API
async function runSQL(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + MGMT_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query })
  });
  if (!res.ok) throw new Error(`SQL error ${res.status}: ${await res.text()}`);
  return res.json();
}

// Thresholds
const MIN_ANNUAL_VOLUME    = 15;   // skip services with fewer than this visits/yr
const STALE_THRESHOLD      = 0.03; // flag if price grew < 3% year-over-year
const SUGGESTED_INCREASE   = 0.08; // suggest 8% increase (CPI-aligned)
// No cap — all flagged services are included in the review

const now        = new Date();
const oneYearAgo = new Date(now); oneYearAgo.setFullYear(now.getFullYear() - 1);
const twoYearAgo = new Date(now); twoYearAgo.setFullYear(now.getFullYear() - 2);

function isoDate(d) { return d.toISOString().slice(0, 10); }
function fmt$(n)    { return '$' + Number(n).toFixed(2); }

async function getAggregatePrices(dateFrom, dateTo) {
  const dateClauses = [];
  if (dateFrom) dateClauses.push(`service_date >= '${isoDate(dateFrom)}'`);
  if (dateTo)   dateClauses.push(`service_date < '${isoDate(dateTo)}'`);
  const where = `amount > 0${dateClauses.length ? ' AND ' + dateClauses.join(' AND ') : ''}`;

  const rows = await runSQL(`
    SELECT code, description, AVG(amount) AS avg_price, COUNT(*) AS cnt
    FROM services
    WHERE ${where} AND code IS NOT NULL AND code <> ''
    GROUP BY code, description
    ORDER BY cnt DESC
  `);
  return rows;
}

async function main() {
  console.log(`\n=== Vet INC Pricing Analysis ===`);
  console.log(`Clinic: ${CLINIC_ID} | Review: ${REVIEW_ID}`);
  console.log(`Scanning services from ${isoDate(oneYearAgo)} to ${isoDate(now)}\n`);

  // 1. Recent prices (last 12 months)
  console.log('Fetching recent prices (last 12 months)…');
  const recent = await getAggregatePrices(oneYearAgo, null);
  console.log(`  ${recent.length.toLocaleString()} distinct service codes found`);

  // 2. Historical prices (12–24 months ago)
  console.log('Fetching historical prices (12–24 months ago)…');
  const historical = await getAggregatePrices(twoYearAgo, oneYearAgo);
  const histMap = {};
  for (const h of historical) {
    histMap[h.code] = parseFloat(h.avg_price) || 0;
  }
  console.log(`  ${historical.length.toLocaleString()} codes with historical data`);

  // 4. Score each service
  console.log('Analyzing pricing gaps…\n');
  const flagged = [];

  for (const row of recent) {
    const code      = row.code;
    const avgPrice  = parseFloat(row.avg_price) || 0;
    const annualVol = parseInt(row.cnt)          || 0;

    if (avgPrice <= 0 || annualVol < MIN_ANNUAL_VOLUME) continue;

    const histPrice  = histMap[code] || 0;
    const hasPriorYear = histPrice > 0;

    // How much has the price changed year-over-year?
    const pctChange = hasPriorYear ? (avgPrice - histPrice) / histPrice : null;

    // Flag if: no prior year data (new or inconsistent) OR price grew < threshold
    const isStale = !hasPriorYear || pctChange < STALE_THRESHOLD;
    if (!isStale) continue;

    const suggestedPrice = parseFloat((avgPrice * (1 + SUGGESTED_INCREASE)).toFixed(2));
    // Round to nearest 50 cents for cleanliness
    const rounded = Math.round(suggestedPrice * 2) / 2;
    const newPrice = Math.max(rounded, avgPrice + 0.50);

    const estUplift = Math.round(annualVol * (newPrice - avgPrice));

    flagged.push({
      clinic_id:     CLINIC_ID,
      review_id:     REVIEW_ID,
      service_code:  code,
      service_name:  row.description || code,
      price_old:     parseFloat(avgPrice.toFixed(2)),
      price_new:     parseFloat(newPrice.toFixed(2)),
      source:        'ai-analysis',
      annual_volume: annualVol,
      est_uplift:    estUplift,
      status:        'pending',
      stale_pct:     pctChange !== null ? (pctChange * 100).toFixed(1) : null
    });
  }

  // Sort by estimated uplift descending — all flagged services included
  flagged.sort((a, b) => b.est_uplift - a.est_uplift);
  const totalAnalyzed = recent.length;
  const healthScore   = Math.round((1 - flagged.length / totalAnalyzed) * 100);
  const totalUplift   = flagged.reduce((s, i) => s + i.est_uplift, 0);

  console.log(`Found ${flagged.length} of ${totalAnalyzed} services with stale pricing`);
  console.log(`Health score: ${healthScore}/100`);
  console.log(`Top 10 by annual uplift:\n`);

  for (const item of flagged.slice(0, 10)) {
    const tag = item.stale_pct !== null ? `(${item.stale_pct}% YoY)` : '(no prior year)';
    console.log(`  ${item.service_code.padEnd(10)} ${fmt$(item.price_old)} → ${fmt$(item.price_new)}  ${item.annual_volume} visits/yr  +$${item.est_uplift.toLocaleString()}/yr  ${tag}`);
  }
  if (flagged.length > 10) console.log(`  … and ${flagged.length - 10} more`);
  console.log(`\n  Combined uplift potential: +$${totalUplift.toLocaleString()}/yr`);

  // 5. Write to Supabase — clear old pending rows, insert all flagged + summary meta row
  console.log(`\nWriting to price_recommendations…`);

  // Delete existing pending + meta rows for this clinic/review
  for (const status of ['pending', 'meta']) {
    const delRes = await fetch(
      `${SB_URL}/rest/v1/price_recommendations?clinic_id=eq.${CLINIC_ID}&review_id=eq.${REVIEW_ID}&status=eq.${status}`,
      { method: 'DELETE', headers: HEADERS }
    );
    if (!delRes.ok) console.warn(`  Warning: could not clear ${status} rows:`, await delRes.text());
  }
  console.log(`  Cleared existing rows for ${REVIEW_ID}`);

  // Write summary meta row — dashboard reads this for real health score
  const metaRow = {
    clinic_id:    CLINIC_ID,
    review_id:    REVIEW_ID,
    service_code: '_summary',
    service_name: 'Analysis Summary',
    price_old:    0,
    price_new:    0,
    source:       'ai-analysis',
    annual_volume: totalAnalyzed,   // total services scanned
    est_uplift:    flagged.length,  // number flagged
    status:       'meta'
  };
  const metaRes = await fetch(`${SB_URL}/rest/v1/price_recommendations`, {
    method: 'POST',
    headers: { ...HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify(metaRow)
  });
  if (!metaRes.ok) console.warn('  Warning: could not write summary row:', await metaRes.text());
  else console.log(`  Summary: ${flagged.length} flagged / ${totalAnalyzed} analyzed → score ${healthScore}`);

  // Insert all flagged rows in batches of 50
  const rows = flagged.map(({ stale_pct, ...rest }) => rest);
  const BATCH = 50;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const insRes = await fetch(`${SB_URL}/rest/v1/price_recommendations`, {
      method: 'POST',
      headers: { ...HEADERS, 'Prefer': 'return=minimal' },
      body: JSON.stringify(batch)
    });
    if (!insRes.ok) {
      console.error(`  Insert error (batch ${i}):`, await insRes.text());
    } else {
      inserted += batch.length;
      process.stdout.write(`\r  Inserted ${inserted}/${rows.length} rows…`);
    }
  }
  console.log(`\n\n✅ Done. ${inserted} price recommendations written.`);
  console.log(`   Review ID: ${REVIEW_ID} | Clinic: ${CLINIC_ID} | Score: ${healthScore}/100`);
  console.log(`   View in portal: https://jack108510.github.io/vet-inc-clinic/owner.html?review=${REVIEW_ID}&clinic=${CLINIC_ID}\n`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
