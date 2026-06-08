// captureBaseline.js — Captures pre-change baseline metrics for a campaign
// Usage: node captureBaseline.js <campaign_id>
// Run BEFORE activating a price change

const SB_URL = 'https://rnqhhzatlxmyvccdvqkr.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJucWhoemF0bHhteXZjY2R2cWtyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUwMTQ5ODUsImV4cCI6MjA5MDU5MDk4NX0.zokle21pVEPG5bIOFiyZIWYkYIwhkolWNOhJ7Cbub30';

async function sbFetch(table, query) {
  const url = `${SB_URL}/rest/v1/${table}?${query}`;
  const res = await fetch(url, {
    headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` }
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

async function sbUpsert(table, data) {
  const url = `${SB_URL}/rest/v1/${table}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation,resolution=merge-duplicates'
    },
    body: JSON.stringify(data)
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

async function captureBaseline(campaignId) {
  const daysBack = 90;
  const since = new Date(Date.now() - daysBack * 86400000).toISOString().split('T')[0];

  console.log(`Capturing ${daysBack}-day baseline since ${since}...`);

  // 1. Daily revenue from csi_pf_totals
  const revenueData = await sbFetch('csi_pf_totals',
    `select=*&date=gte.${since}&order=date.asc`
  );

  let totalRevenue = 0, revenueDays = 0;
  for (const row of revenueData) {
    const rev = parseFloat(row.ros) || 0;
    if (rev > 0) { totalRevenue += rev; revenueDays++; }
  }
  const avgDailyRevenue = revenueDays > 0 ? totalRevenue / revenueDays : 0;

  // 2. Visit counts
  const visitsData = await sbFetch('visits',
    `select=visit_date&visit_date=gte.${since}`
  );
  const visitCounts = {};
  const uniqueClientsPerDay = {};
  for (const v of visitsData) {
    const d = v.visit_date;
    visitCounts[d] = (visitCounts[d] || 0) + 1;
  }
  const visitDays = Object.keys(visitCounts).length;
  const totalVisits = Object.values(visitCounts).reduce((a, b) => a + b, 0);
  const avgDailyVisits = visitDays > 0 ? totalVisits / visitDays : 0;

  // 3. Unique clients (need ref_id)
  // Fetch visits with ref_id for client counting
  const clientVisits = await sbFetch('visits',
    `select=visit_date,ref_id&visit_date=gte.${since}`
  );
  const clientsByDay = {};
  for (const v of clientVisits) {
    if (!clientsByDay[v.visit_date]) clientsByDay[v.visit_date] = new Set();
    if (v.ref_id) clientsByDay[v.visit_date].add(v.ref_id);
  }
  const clientDays = Object.keys(clientsByDay).length;
  const totalUniqueClients = Object.values(clientsByDay).reduce((s, set) => s + set.size, 0);
  const avgDailyClients = clientDays > 0 ? totalUniqueClients / clientDays : 0;

  // 4. Exam counts (HC = canine exam, HEF = feline exam)
  const examData = await sbFetch('services',
    `select=description,amount,service_date&or=(description.like.*HC%,description.like.*HEF%)&service_date=gte.${since}`
  );

  // Group exams by date
  const examsByDay = {};
  let totalExamRevenue = 0;
  for (const s of examData) {
    const d = s.service_date;
    if (!d) continue;
    if (!examsByDay[d]) examsByDay[d] = { count: 0, revenue: 0 };
    examsByDay[d].count++;
    examsByDay[d].revenue += parseFloat(s.amount) || 0;
    totalExamRevenue += parseFloat(s.amount) || 0;
  }
  const examDays = Object.keys(examsByDay).length;
  const totalExams = Object.values(examsByDay).reduce((s, e) => s + e.count, 0);
  const avgDailyExams = examDays > 0 ? totalExams / examDays : 0;
  const avgDailyExamRevenue = examDays > 0 ? totalExamRevenue / examDays : 0;

  // 5. Avg visit value
  const avgVisitValue = totalVisits > 0 ? totalRevenue / totalVisits : 0;

  // Store baselines
  const baselines = [
    { campaign_id: campaignId, metric: 'daily_revenue', baseline_value: Math.round(avgDailyRevenue * 100) / 100 },
    { campaign_id: campaignId, metric: 'daily_visits', baseline_value: Math.round(avgDailyVisits * 100) / 100 },
    { campaign_id: campaignId, metric: 'exam_count', baseline_value: Math.round(avgDailyExams * 100) / 100 },
    { campaign_id: campaignId, metric: 'exam_revenue', baseline_value: Math.round(avgDailyExamRevenue * 100) / 100 },
    { campaign_id: campaignId, metric: 'avg_visit_value', baseline_value: Math.round(avgVisitValue * 100) / 100 },
    { campaign_id: campaignId, metric: 'unique_clients', baseline_value: Math.round(avgDailyClients * 100) / 100 },
  ];

  for (const b of baselines) {
    await sbUpsert('campaign_baselines', { ...b, baseline_period: `${daysBack}d` });
    console.log(`  ${b.metric}: ${b.baseline_value}`);
  }

  console.log(`\n✅ Baseline captured for campaign ${campaignId}`);
  return baselines;
}

// CLI usage
const campaignId = process.argv[2];
if (!campaignId) {
  console.error('Usage: node captureBaseline.js <campaign_id>');
  process.exit(1);
}
captureBaseline(campaignId).catch(e => { console.error(e); process.exit(1); });

// Export for dashboard use
if (typeof module !== 'undefined') module.exports = { captureBaseline };
