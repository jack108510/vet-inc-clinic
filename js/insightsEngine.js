// insightsEngine.js — Backend-driven Insights Inbox for Vet INC
// All insights live in Supabase `insights` table

const InsightsEngine = (() => {
  function sbUrl(table, query) { return `${window.SB_URL}/rest/v1/${table}?${query}`; }
  function sbHeaders() { return { apikey: window.SB_KEY, Authorization: 'Bearer ' + window.SB_KEY }; }

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

  // --- Load and render ---
  async function load() {
    const inbox = document.querySelector('#tab-insights .insight-inbox');
    if (!inbox) return;

    try {
      const insights = await sbGet('insights',
        `select=*&clinic_id=eq.rosslyn&status=eq.active&order=created_at.desc&limit=50`
      );

      // Keep the title, replace the rest
      const title = inbox.querySelector('.settings-card-title');
      inbox.innerHTML = '';
      if (title) inbox.appendChild(title);

      // Add badge
      const badge = document.createElement('span');
      badge.id = 'insightCount';
      badge.style.cssText = 'font-size:0.75rem;background:var(--primary);color:#fff;padding:2px 8px;border-radius:10px;margin-left:8px';
      badge.textContent = insights.length;
      if (title) title.appendChild(badge);

      if (!insights.length) {
        inbox.insertAdjacentHTML('beforeend',
          '<div style="color:var(--muted);font-size:0.85rem;text-align:center;padding:1.5rem">All caught up — no active insights ✅</div>'
        );
        return;
      }

      for (const ins of insights) {
        const sevColors = { critical: '#ef4444', warning: '#ea580c', info: '#2563eb' };
        const sevColor = sevColors[ins.severity] || '#64748b';
        const sevLabel = ins.severity.toUpperCase();
        const date = new Date(ins.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const sourceLabel = { campaign_alert: 'Campaign', margin: 'Margin', anomaly: 'Anomaly', system: 'System' }[ins.source] || ins.source;

        const el = document.createElement('div');
        el.className = 'insight-item';
        el.style.borderLeft = `3px solid ${sevColor}`;
        el.onclick = function() { this.classList.toggle('open'); };
        el.innerHTML = `
          <div class="insight-title">${date} — ${ins.title}</div>
          <div class="insight-body">${ins.body || ''}</div>
          <div class="insight-actions">
            <span class="insight-pill" style="background:${sevColor}15;color:${sevColor}">${sevLabel}</span>
            <span class="insight-pill" style="background:#eef2ff;color:#4338ca">${sourceLabel}</span>
            <span class="insight-pill" style="cursor:pointer" onclick="event.stopPropagation();InsightsEngine.acknowledge('${ins.id}')">Acknowledge</span>
          </div>
          <div class="insight-detail">${ins.detail || ''}</div>
        `;
        inbox.appendChild(el);
      }
    } catch (e) {
      console.error('Failed to load insights', e);
    }
  }

  // --- Acknowledge ---
  async function acknowledge(id) {
    await sbPatch('insights', `id=eq.${id}`, {
      status: 'acknowledged',
      acknowledged_at: new Date().toISOString()
    });
    await load();
  }

  // --- Create insight (used by other modules) ---
  async function create({ source, severity, title, body, detail, sourceId, sourceData }) {
    return sbPost('insights', {
      clinic_id: 'rosslyn',
      source: source || 'system',
      severity: severity || 'info',
      title,
      body: body || null,
      detail: detail || null,
      status: 'active',
      source_id: sourceId || null,
      source_data: sourceData || null
    });
  }

  // --- Create from campaign alert ---
  async function createFromAlert(alert) {
    const metric = alert.metric || '';
    let label = metric;
    if (metric.startsWith('item_')) {
      const parts = metric.replace('item_', '').split('_');
      label = parts[0] + ' ' + parts.slice(1).join(' ');
    }
    const pct = parseFloat(alert.pct_change).toFixed(1);
    const isBad = alert.pct_change < 0;

    return create({
      source: 'campaign_alert',
      severity: alert.severity || 'warning',
      title: `${label} ${isBad ? 'dropped' : 'up'} ${pct}%`,
      body: `Actual: ${formatVal(metric, alert.actual_value)} vs Baseline: ${formatVal(metric, alert.baseline_value)} (${alert.alert_date})`,
      detail: 'This item\'s performance changed after a price adjustment. The baseline was captured from the 90 days before the change was applied.',
      sourceId: alert.id,
      sourceData: alert
    });
  }

  function formatVal(metric, val) {
    if (metric.includes('revenue') || metric.includes('price')) return '$' + (val || 0).toFixed(2);
    return (val || 0).toFixed(1);
  }

  return { load, acknowledge, create, createFromAlert };
})();
