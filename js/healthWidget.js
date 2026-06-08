// CampaignHealth.js — Before/after health tracking for Vet INC v1.4
// Tracks revenue, visits, exams, and alerts after price changes

const CampaignHealth = (() => {
  const METRICS = [
    { key: 'daily_revenue', label: 'Revenue', fmt: v => '$' + (v||0).toLocaleString('en-US', {maximumFractionDigits:0}), color: '#2563eb' },
    { key: 'daily_visits', label: 'Visits', fmt: v => (v||0).toFixed(1), color: '#7c3aed' },
    { key: 'exam_count', label: 'Exams', fmt: v => (v||0).toFixed(1), color: '#ea580c' },
    { key: 'avg_visit_value', label: 'Avg Visit $', fmt: v => '$' + (v||0).toFixed(0), color: '#059669' },
  ];

  let currentMetric = 'daily_revenue';
  let chartInstance = null;

  // --- Supabase helpers (reuse global SB_URL/SB_KEY) ---
  function sbUrl(table, query) {
    return `${window.SB_URL}/rest/v1/${table}?${query}`;
  }
  function sbHeaders() {
    return { apikey: window.SB_KEY, Authorization: 'Bearer ' + window.SB_KEY };
  }
  async function sbGet(table, query) {
    const res = await fetch(sbUrl(table, query), { headers: sbHeaders() });
    if (!res.ok) throw new Error(`SB ${res.status}: ${await res.text()}`);
    return res.json();
  }
  async function sbPost(table, data) {
    const res = await fetch(sbUrl(table, ''), {
      method: 'POST',
      headers: { ...sbHeaders(), 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error(`SB ${res.status}: ${await res.text()}`);
    return res.json();
  }
  async function sbPatch(table, query, data) {
    const res = await fetch(sbUrl(table, query), {
      method: 'PATCH',
      headers: { ...sbHeaders(), 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error(`SB ${res.status}: ${await res.text()}`);
    return res.json();
  }
  async function sbUpsert(table, data) {
    const res = await fetch(sbUrl(table, ''), {
      method: 'POST',
      headers: { ...sbHeaders(), 'Content-Type': 'application/json', 'Prefer': 'return=representation,resolution=merge-duplicates' },
      body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error(`SB ${res.status}: ${await res.text()}`);
    return res.json();
  }

  // --- Init ---
  async function init() {
    document.getElementById('healthLoading').style.display = 'none';
    document.getElementById('healthContent').style.display = 'block';
    renderMetricToggles();
    await loadCampaigns();
    document.getElementById('healthCampaignSelect').addEventListener('change', onCampaignChange);
  }

  function renderMetricToggles() {
    const container = document.getElementById('healthMetricToggles');
    container.innerHTML = METRICS.map(m =>
      `<button class="health-metric-toggle${m.key === currentMetric ? ' active' : ''}" data-metric="${m.key}" onclick="CampaignHealth.setMetric('${m.key}')" style="padding:5px 12px;border:1px solid var(--border);border-radius:6px;font-size:0.78rem;font-weight:600;cursor:pointer;background:${m.key === currentMetric ? m.color : 'var(--surface2)'};color:${m.key === currentMetric ? '#fff' : 'var(--text)'}">${m.label}</button>`
    ).join('');
  }

  function setMetric(key) {
    currentMetric = key;
    renderMetricToggles();
    renderChart();
  }

  // --- Load campaigns ---
  async function loadCampaigns() {
    try {
      const campaigns = await sbGet('campaigns', 'select=*&clinic_id=eq.rosslyn&order=activated_at.desc');
      const sel = document.getElementById('healthCampaignSelect');
      sel.innerHTML = '<option value="">Select a campaign...</option>' +
        campaigns.map(c => `<option value="${c.id}">${c.name} (${c.status})</option>`).join('');
    } catch (e) {
      console.error('Failed to load campaigns', e);
    }
  }

  function getSelectedCampaignId() {
    return document.getElementById('healthCampaignSelect').value;
  }

  async function onCampaignChange() {
    const id = getSelectedCampaignId();
    document.getElementById('captureBaselineBtn').style.display = id ? 'inline-block' : 'none';
    if (id) await refresh();
  }

  // --- Main refresh ---
  async function refresh() {
    const cid = getSelectedCampaignId();
    if (!cid) return;
    try {
      const [baselines, snapshots, alerts] = await Promise.all([
        sbGet('campaign_baselines', `select=*&campaign_id=eq.${cid}`),
        sbGet('campaign_snapshots', `select=*&campaign_id=eq.${cid}&order=snapshot_date.asc&limit=90`),
        sbGet('campaign_alerts', `select=*&campaign_id=eq.${cid}&acknowledged=eq.false&order=alert_date.desc&limit=20`)
      ]);
      renderBaselineCards(baselines);
      renderChart(snapshots, baselines);
      renderAlerts(alerts);
    } catch (e) {
      console.error('Health refresh failed', e);
    }
  }

  // --- Baseline cards ---
  function renderBaselineCards(baselines) {
    const container = document.getElementById('healthBaselineCards');
    if (!baselines.length) {
      container.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--muted);padding:2rem;font-size:0.9rem">No baseline captured yet. Click "Capture Baseline" to record current metrics before a price change.</div>';
      return;
    }
    container.innerHTML = baselines.map(b => {
      const m = METRICS.find(x => x.key === b.metric) || { label: b.metric, fmt: v => v, color: '#64748b' };
      return `<div style="background:var(--surface);border-radius:10px;border:1px solid var(--border);padding:1rem">
        <div style="font-size:0.72rem;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.04em">${m.label} Baseline</div>
        <div style="font-size:1.4rem;font-weight:800;color:${m.color};margin-top:4px">${m.fmt(b.baseline_value)}</div>
        <div style="font-size:0.7rem;color:var(--muted);margin-top:4px">${b.baseline_period || '90d'} avg · alert at ${b.alert_threshold || -10}%</div>
      </div>`;
    }).join('');
  }

  // --- Chart ---
  function renderChart(snapshots, baselines) {
    const canvas = document.getElementById('healthChart');
    const emptyMsg = document.getElementById('healthChartEmpty');
    
    if (!snapshots || !snapshots.length) {
      canvas.style.display = 'none';
      emptyMsg.style.display = 'block';
      return;
    }
    canvas.style.display = 'block';
    emptyMsg.style.display = 'none';

    const metric = currentMetric;
    const labels = snapshots.map(s => s.snapshot_date);
    const values = snapshots.map(s => parseFloat(s[metric]) || 0);
    const baseline = baselines?.find(b => b.metric === metric);
    const baselineValue = baseline ? parseFloat(baseline.baseline_value) : null;

    // Find alerts for this metric
    const alertDates = new Set();
    // We'll mark alert points from the data

    if (chartInstance) chartInstance.destroy();

    const datasets = [{
      label: METRICS.find(m => m.key === metric)?.label || metric,
      data: values,
      borderColor: METRICS.find(m => m.key === metric)?.color || '#2563eb',
      backgroundColor: METRICS.find(m => m.key === metric)?.color + '20' || '#2563eb20',
      borderWidth: 2.5,
      pointRadius: 3,
      pointBackgroundColor: values.map((v, i) => {
        if (baselineValue && v < baselineValue * (1 + (baseline.alert_threshold || -10) / 100)) {
          return '#ef4444'; // red for below threshold
        }
        return METRICS.find(m => m.key === metric)?.color || '#2563eb';
      }),
      pointRadius: values.map((v) => {
        if (baselineValue && v < baselineValue * (1 + (baseline.alert_threshold || -10) / 100)) return 6;
        return 3;
      }),
      fill: true,
      tension: 0.3,
    }];

    if (baselineValue !== null) {
      datasets.push({
        label: 'Baseline',
        data: Array(labels.length).fill(baselineValue),
        borderColor: '#94a3b8',
        borderWidth: 2,
        borderDash: [8, 4],
        pointRadius: 0,
        fill: false,
      });
    }

    chartInstance = new Chart(canvas, {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: true, position: 'top', labels: { font: { size: 11 }, usePointStyle: true } },
          tooltip: {
            callbacks: {
              label: ctx => {
                const m = METRICS.find(x => x.key === metric);
                return `${ctx.dataset.label}: ${m ? m.fmt(ctx.parsed.y) : ctx.parsed.y}`;
              }
            }
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 45 } },
          y: { grid: { color: '#f1f5f9' }, ticks: { font: { size: 10 } } }
        }
      }
    });
  }

  // --- Alerts ---
  function renderAlerts(alerts) {
    const container = document.getElementById('healthAlerts');
    const badge = document.getElementById('alertCount');

    if (!alerts.length) {
      container.innerHTML = '<div style="color:var(--muted);font-size:0.85rem;text-align:center;padding:1.5rem">No active alerts — everything looks healthy ✅</div>';
      badge.style.display = 'none';
      return;
    }

    badge.style.display = 'inline';
    badge.textContent = alerts.length;

    container.innerHTML = alerts.map(a => {
      const m = METRICS.find(x => x.key === a.metric) || { label: a.metric, fmt: v => v };
      const pct = parseFloat(a.pct_change).toFixed(1);
      const isBad = pct < 0;
      return `<div style="display:flex;align-items:center;gap:1rem;padding:0.75rem 1rem;border-radius:8px;background:${isBad ? '#fef2f2' : '#f0fdf4'};border:1px solid ${isBad ? '#fecaca' : '#bbf7d0'};margin-bottom:0.5rem">
        <div style="font-size:1.2rem">${isBad ? '🔴' : '🟢'}</div>
        <div style="flex:1">
          <div style="font-weight:600;font-size:0.85rem">${m.label}: ${isBad ? '' : '+'}${pct}% vs baseline</div>
          <div style="font-size:0.75rem;color:var(--muted)">${a.alert_date} · Actual: ${m.fmt(a.actual_value)} · Baseline: ${m.fmt(a.baseline_value)}</div>
        </div>
        <button onclick="CampaignHealth.acknowledgeAlert('${a.id}')" style="padding:4px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;font-size:0.75rem;cursor:pointer;font-weight:600">Acknowledge</button>
      </div>`;
    }).join('');
  }

  // --- Capture Baseline ---
  async function captureBaseline() {
    const cid = getSelectedCampaignId();
    if (!cid) return alert('Select a campaign first');

    const btn = document.getElementById('captureBaselineBtn');
    btn.textContent = '⏳ Capturing...';
    btn.disabled = true;

    try {
      const since = new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0];

      // Fetch data for baseline calculation
      const [revenueData, visitsData, clientVisits, examData] = await Promise.all([
        sbGet('csi_pf_totals', `select=*&date=gte.${since}&order=date.asc`),
        sbGet('visits', `select=visit_date&visit_date=gte.${since}`),
        sbGet('visits', `select=visit_date,ref_id&visit_date=gte.${since}`),
        sbGet('services', `select=description,amount,service_date&or=(description.like.*HC%,description.like.*HEF%)&service_date=gte.${since}`)
      ]);

      // Revenue
      let totalRevenue = 0, revenueDays = 0;
      for (const r of revenueData) {
        const rev = parseFloat(r.ros) || 0;
        if (rev > 0) { totalRevenue += rev; revenueDays++; }
      }
      const avgRevenue = revenueDays > 0 ? totalRevenue / revenueDays : 0;

      // Visits
      const visitByDay = {};
      for (const v of visitsData) visitByDay[v.visit_date] = (visitByDay[v.visit_date] || 0) + 1;
      const vDays = Object.keys(visitByDay).length;
      const totalVisits = Object.values(visitByDay).reduce((a, b) => a + b, 0);
      const avgVisits = vDays > 0 ? totalVisits / vDays : 0;

      // Clients
      const clientsByDay = {};
      for (const v of clientVisits) {
        if (!clientsByDay[v.visit_date]) clientsByDay[v.visit_date] = new Set();
        if (v.ref_id) clientsByDay[v.visit_date].add(v.ref_id);
      }
      const cDays = Object.keys(clientsByDay).length;
      const totalClients = Object.values(clientsByDay).reduce((s, set) => s + set.size, 0);
      const avgClients = cDays > 0 ? totalClients / cDays : 0;

      // Exams
      const examsByDay = {};
      let totalExamRev = 0;
      for (const s of examData) {
        if (!s.service_date) continue;
        if (!examsByDay[s.service_date]) examsByDay[s.service_date] = { count: 0, rev: 0 };
        examsByDay[s.service_date].count++;
        examsByDay[s.service_date].rev += parseFloat(s.amount) || 0;
        totalExamRev += parseFloat(s.amount) || 0;
      }
      const eDays = Object.keys(examsByDay).length;
      const totalExams = Object.values(examsByDay).reduce((s, e) => s + e.count, 0);
      const avgExams = eDays > 0 ? totalExams / eDays : 0;
      const avgExamRev = eDays > 0 ? totalExamRev / eDays : 0;

      // Avg visit value
      const avgVV = totalVisits > 0 ? totalRevenue / totalVisits : 0;

      // Store baselines
      const baselines = [
        { campaign_id: cid, metric: 'daily_revenue', baseline_value: Math.round(avgRevenue * 100) / 100, baseline_period: '90d' },
        { campaign_id: cid, metric: 'daily_visits', baseline_value: Math.round(avgVisits * 100) / 100, baseline_period: '90d' },
        { campaign_id: cid, metric: 'exam_count', baseline_value: Math.round(avgExams * 100) / 100, baseline_period: '90d' },
        { campaign_id: cid, metric: 'exam_revenue', baseline_value: Math.round(avgExamRev * 100) / 100, baseline_period: '90d' },
        { campaign_id: cid, metric: 'avg_visit_value', baseline_value: Math.round(avgVV * 100) / 100, baseline_period: '90d' },
        { campaign_id: cid, metric: 'unique_clients', baseline_value: Math.round(avgClients * 100) / 100, baseline_period: '90d' },
      ];

      for (const b of baselines) await sbUpsert('campaign_baselines', b);

      btn.textContent = '✅ Baseline Captured!';
      setTimeout(() => { btn.textContent = '📊 Capture Baseline'; btn.disabled = false; }, 2000);
      await refresh();
    } catch (e) {
      console.error('Baseline capture failed', e);
      btn.textContent = '📊 Capture Baseline';
      btn.disabled = false;
      alert('Failed to capture baseline: ' + e.message);
    }
  }

  // --- Acknowledge alert ---
  async function acknowledgeAlert(alertId) {
    await sbPatch('campaign_alerts', `id=eq.${alertId}`, { acknowledged: true });
    // Also inject alerts into the Insights Inbox
    injectInsightAlerts(alerts);
  }

  // --- Inject health alerts into Insights & Actions inbox ---
  function injectInsightAlerts(alerts) {
    const inbox = document.querySelector('#tab-insights .insight-inbox');
    if (!inbox) return;

    // Remove previous health alerts
    inbox.querySelectorAll('.health-alert-insight').forEach(el => el.remove());

    if (!alerts.length) return;

    // Insert after the title
    const titleEl = inbox.querySelector('.settings-card-title');
    const alertHtml = alerts.map(a => {
      const label = formatMetricLabel(a.metric);
      const pct = parseFloat(a.pct_change).toFixed(1);
      const icon = pct < 0 ? '🔴' : '🟢';
      const severity = a.severity === 'critical' ? 'CRITICAL' : 'WARNING';
      const sevColor = a.severity === 'critical' ? '#ef4444' : '#ea580c';
      const campaign = a._campaignName || 'Campaign';
      return `<div class="insight-item health-alert-insight" onclick="this.classList.toggle('open')" style="border-left:3px solid ${sevColor}">
        <div class="insight-title">${icon} ${label} dropped ${pct}%</div>
        <div class="insight-body">${campaign} — Actual: ${formatMetricValue(a.metric, a.actual_value)} vs Baseline: ${formatMetricValue(a.metric, a.baseline_value)} (${a.alert_date})</div>
        <div class="insight-actions">
          <span class="insight-pill" style="background:${sevColor}15;color:${sevColor}">${severity}</span>
          <span class="insight-pill" style="cursor:pointer" onclick="event.stopPropagation();CampaignHealth.acknowledgeAlert('${a.id}')">Acknowledge</span>
        </div>
        <div class="insight-detail">This item's performance dropped after a price change. The baseline was captured from the 90 days before the change was applied.</div>
      </div>`;
    }).join('');

    const wrapper = document.createElement('div');
    wrapper.innerHTML = alertHtml;
    // Insert right after the title
    if (titleEl && titleEl.nextSibling) {
      while (wrapper.firstChild) {
        inbox.insertBefore(wrapper.firstChild, titleEl.nextSibling);
      }
    } else {
      // Append at end
      while (wrapper.firstChild) inbox.appendChild(wrapper.firstChild);
    }
  }

  // --- Load alerts into Insights inbox (called on page load and insights tab switch) ---
  async function loadInsightAlerts() {
    try {
      // Get all active campaigns
      const campaigns = await sbGet('campaigns', 'select=id,name&clinic_id=eq.rosslyn&status=eq.active');
      if (!campaigns.length) return;

      const allAlerts = [];
      for (const c of campaigns) {
        const alerts = await sbGet('campaign_alerts', `select=*&campaign_id=eq.${c.id}&acknowledged=eq.false&order=alert_date.desc&limit=10`);
        alerts.forEach(a => a._campaignName = c.name);
        allAlerts.push(...alerts);
      }
      injectInsightAlerts(allAlerts);
    } catch (e) {
      console.error('Failed to load insight alerts', e);
    }
  }

  function formatMetricLabel(metric) {
    if (metric.startsWith('item_')) {
      const parts = metric.replace('item_', '').split('_');
      const code = parts[0];
      const type = parts.slice(1).join('_');
      const typeLabel = type === 'daily_volume' ? 'Volume' : type === 'daily_revenue' ? 'Revenue' : type === 'avg_price' ? 'Avg Price' : type;
      return `${code} ${typeLabel}`;
    }
    const m = METRICS.find(x => x.key === metric);
    return m ? m.label : metric;
  }

  function formatMetricValue(metric, value) {
    if (metric.includes('revenue') || metric.includes('price')) return '$' + (value||0).toFixed(2);
    return (value||0).toFixed(1);
  }

  return { init, refresh, setMetric, captureBaseline, acknowledgeAlert, loadInsightAlerts };})();
