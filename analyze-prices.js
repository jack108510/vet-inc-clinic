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
const MIN_ANNUAL_VOLUME    = 15;   // skip services with fewer than this visits/yr in last 12 months
const ACTIVE_DAYS          = 90;   // service must have been billed within this many days to be "active"
const CPI_BUFFER           = 0.02; // flag if price grew less than (CPI + this buffer) — rewards staying ahead of inflation
// STALE_THRESHOLD is set dynamically from real CPI data at runtime (see fetchCPI)
// SUGGESTED_INCREASE is set dynamically as CPI + 5% buffer

async function fetchCPI() {
  // World Bank API — Canada annual CPI inflation rate (FP.CPI.TOTL.ZG)
  // Returns the most recent year available (typically prior year)
  try {
    const res = await fetch(
      'https://api.worldbank.org/v2/country/CA/indicator/FP.CPI.TOTL.ZG?format=json&mrv=3&per_page=3',
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const [, data] = await res.json();
    // Find most recent year with a value
    const latest = data.find(d => d.value !== null);
    if (!latest) throw new Error('No CPI data');
    const rate = latest.value / 100;
    console.log(`  CPI source: World Bank — Canada ${latest.date} annual inflation = ${(rate * 100).toFixed(2)}%`);
    return { rate, year: latest.date };
  } catch (err) {
    const fallback = 0.027; // ~2.7% fallback if API unavailable
    console.warn(`  CPI fetch failed (${err.message}) — using fallback ${(fallback * 100).toFixed(1)}%`);
    return { rate: fallback, year: 'fallback' };
  }
}
// No cap — all flagged active services are included in the review

const now          = new Date();
const oneYearAgo   = new Date(now); oneYearAgo.setFullYear(now.getFullYear() - 1);
const twoYearAgo   = new Date(now); twoYearAgo.setFullYear(now.getFullYear() - 2);
const activeCutoff = new Date(now); activeCutoff.setDate(now.getDate() - ACTIVE_DAYS);

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

async function getActiveCodes() {
  // Returns the set of service codes billed within the last ACTIVE_DAYS days.
  // A code not billed recently is considered discontinued and excluded from recommendations.
  const rows = await runSQL(`
    SELECT DISTINCT code
    FROM services
    WHERE service_date >= '${isoDate(activeCutoff)}'
      AND amount > 0
      AND code IS NOT NULL AND code <> ''
  `);
  return new Set(rows.map(r => r.code));
}

async function main() {
  console.log(`\n=== Vet INC Pricing Analysis ===`);
  console.log(`Clinic: ${CLINIC_ID} | Review: ${REVIEW_ID}\n`);

  // Fetch real CPI — determines what counts as "stale"
  console.log('Fetching Canada CPI (World Bank)…');
  const { rate: cpiRate, year: cpiYear } = await fetchCPI();
  const STALE_THRESHOLD    = cpiRate + CPI_BUFFER;         // stale if below CPI + buffer
  const SUGGESTED_INCREASE = cpiRate + 0.05;               // suggest CPI + 5%
  console.log(`  Stale threshold: ${(STALE_THRESHOLD * 100).toFixed(2)}% (CPI ${(cpiRate*100).toFixed(2)}% + ${(CPI_BUFFER*100).toFixed(0)}% buffer)`);
  console.log(`  Suggested increase: ${(SUGGESTED_INCREASE * 100).toFixed(2)}% (CPI + 5% margin)\n`);

  // 0. Determine the most recent data date (ETL may not be up to today)
  const [dateRow] = await runSQL(`SELECT MAX(service_date)::date AS latest FROM services WHERE amount > 0`);
  const latestDate = new Date(dateRow.latest + 'T00:00:00');
  const dataOneYearAgo = new Date(latestDate); dataOneYearAgo.setFullYear(latestDate.getFullYear() - 1);
  const dataTwoYearAgo = new Date(latestDate); dataTwoYearAgo.setFullYear(latestDate.getFullYear() - 2);
  const dataActiveCutoff = new Date(latestDate); dataActiveCutoff.setDate(latestDate.getDate() - ACTIVE_DAYS);

  console.log(`Data current through: ${isoDate(latestDate)}`);
  console.log(`Active window:        last ${ACTIVE_DAYS} days (since ${isoDate(dataActiveCutoff)})`);
  console.log(`Recent window:        ${isoDate(dataOneYearAgo)} → ${isoDate(latestDate)}`);
  console.log(`Historical window:    ${isoDate(dataTwoYearAgo)} → ${isoDate(dataOneYearAgo)}\n`);

  // 1. Active service codes — billed in last 90 days (relative to latest data)
  console.log(`Fetching active service codes (billed in last ${ACTIVE_DAYS} days)…`);
  const rows_active = await runSQL(`
    SELECT DISTINCT code
    FROM services
    WHERE service_date >= '${isoDate(dataActiveCutoff)}'
      AND amount > 0
      AND code IS NOT NULL AND code <> ''
  `);
  const activeCodes = new Set(rows_active.map(r => r.code));
  console.log(`  ${activeCodes.size.toLocaleString()} active codes`);

  // 2. Recent prices (last 12 months relative to latest data)
  console.log('Fetching recent prices (last 12 months)…');
  const recent = await getAggregatePrices(dataOneYearAgo, latestDate);
  // Filter to only active codes
  const recentActive = recent.filter(r => activeCodes.has(r.code));
  console.log(`  ${recent.length.toLocaleString()} total codes, ${recentActive.length.toLocaleString()} active`);

  // 3. Historical prices (12–24 months ago relative to latest data)
  console.log('Fetching historical prices (12–24 months ago)…');
  const historical = await getAggregatePrices(dataTwoYearAgo, dataOneYearAgo);
  const histMap = {};
  for (const h of historical) {
    histMap[h.code] = parseFloat(h.avg_price) || 0;
  }
  console.log(`  ${historical.length.toLocaleString()} codes with historical data`);

  // 4. Score each active service
  console.log('Analyzing pricing gaps…\n');
  const flagged = [];

  for (const row of recentActive) {
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

  // Sort by estimated uplift descending — all flagged active services included
  flagged.sort((a, b) => b.est_uplift - a.est_uplift);
  // totalAnalyzed = active codes with enough volume to be meaningful
  const totalAnalyzed = recentActive.filter(r => parseFloat(r.avg_price) > 0 && parseInt(r.cnt) >= MIN_ANNUAL_VOLUME).length;
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

  // 5. Write to Supabase
  console.log(`\nWriting to Supabase…`);

  // 5a. Upsert the report record into clinic_reports
  const reportRow = {
    id:                REVIEW_ID,
    clinic_id:         CLINIC_ID,
    type:              process.argv[4] || 'quarterly',
    report_date:       isoDate(latestDate),
    health_score:      healthScore,
    total_services:    totalAnalyzed,
    flagged_services:  flagged.length,
    total_opportunity: totalUplift,
    cpi_rate:          cpiRate,
    status:            'active'
  };
  const reportRes = await fetch(`${SB_URL}/rest/v1/clinic_reports`, {
    method: 'POST',
    headers: { ...HEADERS, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(reportRow)
  });
  if (!reportRes.ok) console.warn('  Warning: could not write report record:', await reportRes.text());
  else console.log(`  Report saved: ${REVIEW_ID} | score ${healthScore}/100 | $${totalUplift.toLocaleString()} opportunity`);

  // 5b. Clear old pending rows for this review and insert fresh suggestions
  const delRes = await fetch(
    `${SB_URL}/rest/v1/price_recommendations?clinic_id=eq.${CLINIC_ID}&review_id=eq.${REVIEW_ID}&status=eq.pending`,
    { method: 'DELETE', headers: HEADERS }
  );
  if (!delRes.ok) console.warn(`  Warning: could not clear old suggestions:`, await delRes.text());

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
      process.stdout.write(`\r  Inserted ${inserted}/${rows.length} suggestions…`);
    }
  }
  console.log(`\n\n✅ Done.`);
  console.log(`   Report: ${REVIEW_ID} | Clinic: ${CLINIC_ID} | Score: ${healthScore}/100`);
  console.log(`   ${inserted} suggestions written | $${totalUplift.toLocaleString()}/yr opportunity`);
  console.log(`   Portal: https://jack108510.github.io/vet-inc-clinic/owner.html?clinic=${CLINIC_ID}\n`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
