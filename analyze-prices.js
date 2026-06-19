#!/usr/bin/env node
/**
 * Vet INC — Pricing Analysis Engine
 *
 * Scans all service prices in AVImark data, flags stale/underpriced services,
 * and auto-populates price_recommendations for the owner review queue.
 * Emails the clinic owner when the review is ready.
 *
 * Usage:
 *   node analyze-prices.js [clinic_id] [review_id]
 *   node analyze-prices.js rosslyn q3-2026
 */

import { sendReviewEmail } from './send-email.js';

// Clinic config — owner email per clinic_id
const CLINIC_CONFIG = {
  rosslyn: { name: 'Rosslyn Veterinary Clinic', ownerEmail: 'info@rosslynvet.com' }
};

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

// Keywords for price-sensitive services (clients comparison-shop these)
const SHOPPABLE_KEYWORDS = [
  'vaccine','vaccin','vacc','neuter','spay','dental','rabies','heartworm',
  'dewormer','flea','tick','wellness','exam','nail trim','groom','boarding','bath','microchip'
];
function isShoppable(name = '') {
  const n = name.toLowerCase();
  return SHOPPABLE_KEYWORDS.some(k => n.includes(k));
}

// Round to nearest $0.50
function roundToHalf(n) { return Math.round(n * 2) / 2; }

async function fetchCPI() {
  // World Bank API — Canada annual CPI inflation (FP.CPI.TOTL.ZG), last 6 years
  try {
    const res = await fetch(
      'https://api.worldbank.org/v2/country/CA/indicator/FP.CPI.TOTL.ZG?format=json&mrv=6&per_page=6',
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const [, data] = await res.json();
    // Build year → rate map (only years with data)
    const history = {};
    for (const d of data) {
      if (d.value !== null) history[parseInt(d.date)] = d.value / 100;
    }
    const latest = Math.max(...Object.keys(history).map(Number));
    console.log(`  CPI history (World Bank Canada):`);
    Object.keys(history).sort().forEach(y => console.log(`    ${y}: ${(history[y]*100).toFixed(2)}%`));
    return { history, latest };
  } catch (err) {
    // Fallback: reasonable estimates for 2019-2024
    const fallback = { 2019:0.019, 2020:0.007, 2021:0.036, 2022:0.068, 2023:0.039, 2024:0.024 };
    console.warn(`  CPI fetch failed (${err.message}) — using fallback rates`);
    return { history: fallback, latest: 2024 };
  }
}

// Compound CPI from a given year through the latest available year.
// If yearFrom is before our CPI history, we assume the oldest known rate.
function compoundCPI(yearFrom, cpiHistory) {
  const years = Object.keys(cpiHistory).map(Number).sort();
  const latestYear = Math.max(...years);
  const oldestYear = Math.min(...years);
  let compound = 1;
  for (let y = Math.max(yearFrom, oldestYear); y <= latestYear; y++) {
    const rate = cpiHistory[y] ?? cpiHistory[oldestYear];
    compound *= (1 + rate);
  }
  return compound - 1; // total % increase needed to keep pace
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

  // Fetch real CPI history — used to compute compounded inflation per service
  console.log('Fetching Canada CPI history (World Bank)…');
  const { history: cpiHistory, latest: cpiLatestYear } = await fetchCPI();
  const latestCpiRate = cpiHistory[cpiLatestYear] || 0.024;
  console.log(`  Using rates from ${Math.min(...Object.keys(cpiHistory).map(Number))}–${cpiLatestYear}\n`);

  // 0. Determine the most recent data date (ETL may not be up to today)
  const [dateRow] = await runSQL(`SELECT MAX(service_date)::date AS latest FROM services WHERE amount > 0`);
  const latestDate    = new Date(dateRow.latest + 'T00:00:00');
  const latestYear    = latestDate.getFullYear();
  const dataActiveCutoff = new Date(latestDate); dataActiveCutoff.setDate(latestDate.getDate() - ACTIVE_DAYS);

  console.log(`Data current through: ${isoDate(latestDate)}`);
  console.log(`Active window:        last ${ACTIVE_DAYS} days (since ${isoDate(dataActiveCutoff)})\n`);

  // 1. Active service codes
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

  // 2. Recent prices (last 12 months)
  console.log('Fetching recent prices (last 12 months)…');
  const yearAgo    = new Date(latestDate); yearAgo.setFullYear(latestYear - 1);
  const recent     = await getAggregatePrices(yearAgo, latestDate);
  const recentActive = recent.filter(r => activeCodes.has(r.code));
  console.log(`  ${recentActive.length.toLocaleString()} active codes with recent data`);

  // 3. Historical snapshots — avg price per code going back 5 years
  //    Used to detect when a price was last meaningfully raised
  console.log('Fetching historical price snapshots (up to 5 years)…');
  const yearSnapshots = {}; // year → { code → avg_price }
  for (let y = 1; y <= 5; y++) {
    const from = new Date(latestDate); from.setFullYear(latestYear - y - 1);
    const to   = new Date(latestDate); to.setFullYear(latestYear - y);
    const rows = await getAggregatePrices(from, to);
    yearSnapshots[latestYear - y] = {};
    for (const r of rows) yearSnapshots[latestYear - y][r.code] = parseFloat(r.avg_price) || 0;
  }
  console.log(`  Snapshots loaded for years ${latestYear - 5}–${latestYear - 1}`);

  // 4. For each active service, find when it was last raised and compound CPI since then
  console.log('\nAnalyzing pricing gaps and computing CPI-compounded suggestions…\n');
  const flagged = [];
  const PRICE_CHANGE_THRESHOLD = 0.01; // 1% — treat smaller moves as rounding noise

  for (const row of recentActive) {
    const code      = row.code;
    const curPrice  = parseFloat(row.avg_price) || 0;
    const annualVol = parseInt(row.cnt) || 0;

    if (curPrice <= 0 || annualVol < MIN_ANNUAL_VOLUME) continue;

    // Walk backwards through year snapshots to find when price last changed meaningfully
    let lastChangedYear = latestYear; // default: assume never raised (will compound all CPI)
    let prevPrice = curPrice;
    for (let y = latestYear - 1; y >= latestYear - 5; y--) {
      const snap = yearSnapshots[y]?.[code] || 0;
      if (snap <= 0) break; // no data that far back — stop here
      const yoyChange = Math.abs((prevPrice - snap) / snap);
      if (yoyChange > PRICE_CHANGE_THRESHOLD) {
        // Price did change this year — last raise was in year y+1
        lastChangedYear = y + 1;
        break;
      }
      // Price was the same this year too — keep looking back
      lastChangedYear = y;
      prevPrice = snap;
    }

    // Compound real CPI from lastChangedYear through latest CPI year
    const cpiNeeded = compoundCPI(lastChangedYear, cpiHistory);
    if (cpiNeeded <= CPI_BUFFER) continue; // price is keeping up — not stale

    // Suggested price = compound the actual inflation since last raise
    const shoppable = isShoppable(row.description);
    const adjustedCpi = shoppable ? cpiNeeded * 0.5 : cpiNeeded; // softer nudge for shoppables
    const rawNew   = curPrice * (1 + adjustedCpi);
    const newPrice = Math.max(roundToHalf(rawNew), curPrice + 0.50);
    const estUplift = Math.round(annualVol * (newPrice - curPrice));
    const yearsSince = latestYear - lastChangedYear;

    flagged.push({
      clinic_id:     CLINIC_ID,
      review_id:     REVIEW_ID,
      service_code:  code,
      service_name:  row.description || code,
      price_old:     parseFloat(curPrice.toFixed(2)),
      price_new:     parseFloat(newPrice.toFixed(2)),
      source:        'ai-analysis',
      annual_volume: annualVol,
      est_uplift:    estUplift,
      status:        'pending',
      stale_pct:     (cpiNeeded * 100).toFixed(1),
      years_stale:   yearsSince
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
    const tag = `(stale ~${item.years_stale}yr, CPI owed ${item.stale_pct}%)`;
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
    cpi_rate:          latestCpiRate,
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

  const rows = flagged.map(({ stale_pct, years_stale, ...rest }) => rest);
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
  const portalUrl = `https://jack108510.github.io/vet-inc-clinic/owner.html?clinic=${CLINIC_ID}&review=${REVIEW_ID}`;
  console.log(`\n\n✅ Done.`);
  console.log(`   Report: ${REVIEW_ID} | Clinic: ${CLINIC_ID} | Score: ${healthScore}/100`);
  console.log(`   ${inserted} suggestions written | $${totalUplift.toLocaleString()}/yr opportunity`);
  console.log(`   Portal: ${portalUrl}\n`);

  // Email owner — review is ready
  const clinic = CLINIC_CONFIG[CLINIC_ID];
  if (clinic?.ownerEmail && inserted > 0) {
    console.log('Sending review email to owner…');
    try {
      const quarter = REVIEW_ID.startsWith('q') ? REVIEW_ID.toUpperCase().replace('-', ' ') : REVIEW_ID;
      await sendReviewEmail({
        to:               clinic.ownerEmail,
        clinicName:       clinic.name,
        reportTitle:      quarter,
        flaggedCount:     inserted,
        totalOpportunity: totalUplift,
        portalUrl
      });
    } catch (err) {
      console.warn('  Email failed:', err.message);
    }
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
