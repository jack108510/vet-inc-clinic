#!/usr/bin/env node
/**
 * Vet INC Data Standardizer
 * Maps existing AVImark tables → std_* tables for Rosslyn clinic
 * 
 * Usage: node standardize-rosslyn.js [--dry-run]
 */

const SUPABASE_URL = 'https://rnqhhzatlxmyvccdvqkr.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJucWhoemF0bHhteXZjY2R2cWtyIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTAxNDk4NSwiZXhwIjoyMDkwNTkwOTg1fQ.Js6sEzcCbIkIx5QDtk4TDtSliUeD52e2H2D-Sxatg2w';
const CLINIC_ID = 'rosslyn';

const headers = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=representation'
};

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

async function sbGet(table, query = '') {
  const url = `${SUPABASE_URL}/rest/v1/${table}${query ? '?' + query : ''}`;
  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error(`${table}: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

async function sbPost(table, data) {
  if (dryRun) {
    console.log(`  [DRY RUN] Would insert ${data.length} rows into ${table}`);
    return [];
  }
  const url = `${SUPABASE_URL}/rest/v1/${table}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Prefer': 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(data)
  });
  if (!resp.ok) {
    const err = await resp.text();
    console.error(`  Insert error on ${table}: ${err.substring(0, 200)}`);
    return [];
  }
  return resp.json();
}

async function sbUpsert(table, data, onConflict) {
  if (dryRun) {
    console.log(`  [DRY RUN] Would upsert ${data.length} rows into ${table}`);
    return [];
  }
  const url = `${SUPABASE_URL}/rest/v1/${table}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Prefer': `resolution=merge-duplicates,return=representation` },
    body: JSON.stringify(data)
  });
  if (!resp.ok) {
    const err = await resp.text();
    console.error(`  Upsert error on ${table}: ${err.substring(0, 200)}`);
    return [];
  }
  return resp.json();
}

function log(stage, msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${stage}: ${msg}`);
}

// ========================================
// STEP 0: Register clinic
// ========================================
async function registerClinic() {
  log('Clinic', 'Registering Rosslyn...');
  await sbUpsert('std_clinics', [{
    clinic_id: CLINIC_ID,
    name: 'Rosslyn Veterinary Clinic',
    pms_type: 'avimark',
    currency: 'CAD',
    timezone: 'America/Edmonton',
    country: 'CA'
  }]);
  log('Clinic', '✓ Rosslyn registered');
}

// ========================================
// STEP 1: std_services — from items table
// ========================================
async function standardizeServices() {
  log('Services', 'Loading items from AVImark...');
  const items = await sbGet('items', 'select=code,name,service_code,unit_cost&limit=5000');
  
  // Also get current prices from services table (latest price per code)
  const svcRaw = await sbGet('services', 'select=code,description,amount,service_type&limit=100000');
  
  // Build price map: latest price per code
  const priceMap = {};
  const nameMap = {};
  const catMap = {};
  for (const s of svcRaw) {
    if (!priceMap[s.code] || s.created_at > priceMap[s.code].created_at) {
      priceMap[s.code] = s;
    }
    nameMap[s.code] = s.description || s.code;
    catMap[s.code] = s.service_type || 'other';
  }
  
  // Build from items (master catalog)
  const stdServices = items.map(item => ({
    clinic_id: CLINIC_ID,
    code: item.code,
    name: item.name || nameMap[item.code] || item.code,
    category: catMap[item.service_code || item.code] || 'other',
    price: priceMap[item.code]?.amount || null,
    cost: item.unit_cost || null,
    active: true
  }));
  
  log('Services', `Mapping ${stdServices.length} services...`);
  await sbUpsert('std_services', stdServices);
  log('Services', `✓ ${stdServices.length} standardized`);
}

// ========================================
// STEP 2: std_transactions — from services (line items)
// ========================================
async function standardizeTransactions() {
  const BATCH = 2000;
  
  log('Transactions', 'Counting rows...');
  
  // Paginate by date range to avoid timeouts
  const years = ['2019','2020','2021','2022','2023','2024','2025','2026'];
  const months = ['01','02','03','04','05','06','07','08','09','10','11','12'];
  let total = 0;
  
  for (const year of years) {
    for (const month of months) {
      const prefix = `${year}-${month}`;
      const countResp = await fetch(`${SUPABASE_URL}/rest/v1/services?select=code&service_date=like.${prefix}*&limit=1`, {
        headers: { ...headers, 'Prefer': 'count=exact' }
      });
      const contentRange = countResp.headers.get('content-range');
      const monthTotal = contentRange ? parseInt(contentRange.split('/')[1]) : 0;
      if (monthTotal === 0) continue;
      
      let offset = 0;
      while (offset < monthTotal) {
        try {
          const batch = await sbGet('services', `select=record_num,service_type,code,description,amount,quantity,created_at,service_date&service_date=like.${prefix}*&order=id.asc&limit=${BATCH}&offset=${offset}`);
          if (batch.length === 0) break;
          
          const rows = batch.map((s, i) => ({
            clinic_id: CLINIC_ID,
            txn_date: s.service_date || s.created_at?.split('T')[0] || '2020-01-01',
            txn_id: `R${s.record_num}`,
            line_num: offset + i + 1,
            service_code: s.code,
            description: s.description,
            quantity: s.quantity || 1,
            amount: s.amount || 0,
            service_type: s.service_type || null
          }));
          
          await sbPost('std_transactions', rows);
          total += batch.length;
          offset += BATCH;
        } catch (e) {
          if (e.message && e.message.includes('timeout')) {
            offset += BATCH; // skip timed out batch
          } else {
            throw e;
          }
        }
      }
      process.stdout.write(`  ${prefix}: ${total.toLocaleString()} total\r`);
    }
  }
  log('Transactions', `✓ ${total.toLocaleString()} standardized`);
}

// ========================================
// STEP 3: std_visits — from visits table
// ========================================
async function standardizeVisits() {
  log('Visits', 'Loading visits...');
  const BATCH = 5000;
  let offset = 0;
  let total = 0;
  
  while (true) {
    const batch = await sbGet('visits', `select=record_num,visit_date,type_code,ref_id,doctor&order=record_num.asc&limit=${BATCH}&offset=${offset}`);
    if (batch.length === 0) break;
    
    const rows = batch.map(v => ({
      clinic_id: CLINIC_ID,
      visit_date: v.visit_date,
      visit_id: `V${v.record_num}`,
      doctor: v.doctor,
      total_amount: null, // will be computed from transactions
      client_id: v.ref_id || null,
      patient_id: v.type_code || null
    }));
    
    await sbPost('std_visits', rows);
    total += batch.length;
    offset += BATCH;
    process.stdout.write(`  ${total.toLocaleString()}\r`);
  }
  log('Visits', `✓ ${total.toLocaleString()} standardized`);
}

// ========================================
// STEP 4: std_clients — from clients table
// ========================================
async function standardizeClients() {
  log('Clients', 'Loading clients...');
  const BATCH = 5000;
  let offset = 0;
  let total = 0;
  
  while (true) {
    const batch = await sbGet('clients', `select=record_num,first_name,last_name,address,city,province,postal_code,phone,phone2,created_at&order=id.asc&limit=${BATCH}&offset=${offset}`);
    if (batch.length === 0) break;
    
    const rows = batch.map(c => ({
      clinic_id: CLINIC_ID,
      client_id: `C${c.record_num}`,
      first_name: c.first_name,
      last_name: c.last_name,
      phone: c.phone || c.phone2,
      city: c.city,
      province: c.province,
      postal_code: c.postal_code,
      first_visit: c.created_at?.split('T')[0] || null,
      last_visit: null
    }));
    
    await sbPost('std_clients', rows);
    total += batch.length;
    offset += BATCH;
    process.stdout.write(`  ${total.toLocaleString()}\r`);
  }
  log('Clients', `✓ ${total.toLocaleString()} standardized`);
}

// ========================================
// STEP 5: std_patients — from animals table
// ========================================
async function standardizePatients() {
  log('Patients', 'Loading animals...');
  const BATCH = 5000;
  let offset = 0;
  let total = 0;
  
  while (true) {
    const batch = await sbGet('animals', `select=id,record_num,name,species,breed,weight,created_at&order=id.asc&limit=${BATCH}&offset=${offset}`);
    if (batch.length === 0) break;
    
    const rows = batch.map(a => ({
      clinic_id: CLINIC_ID,
      patient_id: `A${a.record_num}`,
      name: a.name,
      species: a.species,
      breed: a.breed,
      weight: a.weight
    }));
    
    await sbPost('std_patients', rows);
    total += batch.length;
    offset += BATCH;
    process.stdout.write(`  ${total.toLocaleString()}\r`);
  }
  log('Patients', `✓ ${total.toLocaleString()} standardized`);
}

// ========================================
// STEP 6: std_appointments — from appointments table
// ========================================
async function standardizeAppointments() {
  log('Appointments', 'Loading appointments...');
  const BATCH = 5000;
  let offset = 0;
  let total = 0;
  
  while (true) {
    const batch = await sbGet('appointments', `select=record_num,appt_date,doctor,reason,flags&order=record_num.asc&limit=${BATCH}&offset=${offset}`);
    if (batch.length === 0) break;
    
    const rows = batch.map(a => ({
      clinic_id: CLINIC_ID,
      appointment_id: `AP${a.record_num}`,
      appointment_date: a.appt_date,
      doctor: a.doctor,
      reason: a.reason,
      status: 'completed' // AVImark doesn't have status, assume completed
    }));
    
    await sbPost('std_appointments', rows);
    total += batch.length;
    offset += BATCH;
    process.stdout.write(`  ${total.toLocaleString()}\r`);
  }
  log('Appointments', `✓ ${total.toLocaleString()} standardized`);
}

// ========================================
// STEP 7: std_vaccines — from vaccines table
// ========================================
async function standardizeVaccines() {
  log('Vaccines', 'Loading vaccines...');
  const BATCH = 5000;
  let offset = 0;
  let total = 0;
  
  while (true) {
    const batch = await sbGet('vaccines', `select=record_num,vaccine_date,serial_number,doctor,manufacturer&order=record_num.asc&limit=${BATCH}&offset=${offset}`);
    if (batch.length === 0) break;
    
    const rows = batch.map(v => ({
      clinic_id: CLINIC_ID,
      patient_id: `A${v.record_num}`,
      vaccine_date: v.vaccine_date,
      vaccine_name: v.manufacturer || null,
      doctor: v.doctor
    }));
    
    await sbPost('std_vaccines', rows);
    total += batch.length;
    offset += BATCH;
    process.stdout.write(`  ${total.toLocaleString()}\r`);
  }
  log('Vaccines', `✓ ${total.toLocaleString()} standardized`);
}

// ========================================
// STEP 8: std_daily_kpis — compute from transactions
// ========================================
async function computeDailyKPIs() {
  log('KPIs', 'Computing daily KPIs from transactions...');
  
  // This runs as a SQL query via a batch approach
  // Group transactions by date and compute metrics
  const BATCH = 10000;
  let offset = 0;
  const kpiMap = {};
  
  while (true) {
    const batch = await sbGet('std_transactions', `select=txn_date,amount,service_code&order=id.asc&limit=${BATCH}&offset=${offset}`);
    if (batch.length === 0) break;
    
    for (const t of batch) {
      const day = t.txn_date;
      if (!kpiMap[day]) {
        kpiMap[day] = { revenue: 0, line_items: 0, services: new Set() };
      }
      kpiMap[day].revenue += parseFloat(t.amount || 0);
      kpiMap[day].line_items += 1;
      kpiMap[day].services.add(t.service_code);
    }
    offset += BATCH;
    process.stdout.write(`  Processing row ${offset.toLocaleString()}\r`);
  }
  
  const kpis = Object.entries(kpiMap).map(([day, data]) => ({
    clinic_id: CLINIC_ID,
    day,
    revenue: Math.round(data.revenue * 100) / 100,
    visits: null,
    line_items: data.line_items,
    avg_line_amount: data.line_items > 0 ? Math.round((data.revenue / data.line_items) * 100) / 100 : 0,
    unique_services: data.services.size
  }));
  
  log('KPIs', `Inserting ${kpis.length} daily KPIs...`);
  // Insert in chunks of 500
  for (let i = 0; i < kpis.length; i += 500) {
    await sbPost('std_daily_kpis', kpis.slice(i, i + 500));
  }
  log('KPIs', `✓ ${kpis.length} days computed`);
}

// ========================================
// MAIN
// ========================================
async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log(' Vet INC Data Standardizer — Rosslyn (AVImark)');
  console.log('═══════════════════════════════════════════════');
  if (dryRun) console.log(' *** DRY RUN — no data will be written ***');
  console.log();
  
  const start = Date.now();
  
  try {
    await registerClinic();
    await standardizeServices();
    await standardizeTransactions();  // 622K rows — takes a while
    await standardizeVisits();
    await standardizeClients();
    await standardizePatients();
    await standardizeAppointments();
    await standardizeVaccines();
    await computeDailyKPIs();
  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`);
    process.exit(1);
  }
  
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n✅ Standardization complete in ${elapsed}s`);
}

main();
