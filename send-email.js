/**
 * Vet INC — Email Module
 *
 * Two functions:
 *   sendReviewEmail()  — quarterly review is ready, owner needs to approve changes
 *   sendAlertEmail()   — one or more confirmed price changes are underperforming
 *
 * Only called when action is needed. Never sends routine updates.
 */

import nodemailer from 'nodemailer';

const SMTP = {
  host: 'smtp.agentmail.to',
  port: 465,
  secure: true,
  auth: {
    user: 'wildroseautomations@agentmail.to',
    pass: 'am_us_eb590201635e5a67541a0e4c6eb32c5d6b144eb5cf48a5ca7ce9bece7940c11f'
  }
};

const FROM = '"Vet INC" <jack@wildroseautomations.ca>';

function fmt$(n) {
  return '$' + Number(n).toLocaleString('en-CA', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function pct(v) {
  return (v >= 0 ? '+' : '') + Number(v).toFixed(1) + '%';
}

function emailBase(bodyContent) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0f6ff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f6ff;padding:32px 16px">
  <tr><td align="center">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">

      <!-- Header -->
      <tr><td style="background:linear-gradient(135deg,#1d4ed8,#2563eb,#3b82f6);border-radius:12px 12px 0 0;padding:28px 32px">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:rgba(255,255,255,0.7);margin-bottom:6px">VET INC</div>
        <div style="font-size:22px;font-weight:900;color:#fff;line-height:1.15">Pricing Management</div>
      </td></tr>

      <!-- Body -->
      <tr><td style="background:#fff;padding:32px;border-left:1px solid #dbeafe;border-right:1px solid #dbeafe">
        ${bodyContent}
      </td></tr>

      <!-- Footer -->
      <tr><td style="background:#f8fafc;border:1px solid #dbeafe;border-top:none;border-radius:0 0 12px 12px;padding:16px 32px;font-size:11px;color:#94a3b8;line-height:1.5">
        Vet INC by Wilde Automations · <a href="https://wildroseautomations.ca" style="color:#2563eb;text-decoration:none">wildroseautomations.ca</a><br>
        You're receiving this because a pricing action is needed for your clinic.
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

/**
 * Quarterly review email — sent when analyze-prices.js generates new recommendations.
 *
 * @param {object} opts
 * @param {string} opts.to            - owner email
 * @param {string} opts.clinicName    - e.g. "Rosslyn Veterinary Clinic"
 * @param {string} opts.reportTitle   - e.g. "Q2 2026"
 * @param {number} opts.flaggedCount  - number of services flagged
 * @param {number} opts.totalOpportunity - estimated annual uplift in $
 * @param {string} opts.portalUrl     - direct link to owner portal
 */
export async function sendReviewEmail({ to, clinicName, reportTitle, flaggedCount, totalOpportunity, portalUrl }) {
  const transport = nodemailer.createTransport(SMTP);

  const body = `
    <p style="font-size:16px;font-weight:700;color:#0f172a;margin:0 0 8px">Your ${reportTitle} pricing review is ready.</p>
    <p style="font-size:14px;color:#475569;margin:0 0 24px;line-height:1.6">
      We've analyzed ${clinicName}'s pricing data and identified <strong>${flaggedCount} service${flaggedCount !== 1 ? 's' : ''}</strong> where prices haven't kept pace with inflation.
    </p>

    <!-- Opportunity callout -->
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#eff6ff;border:1px solid #bfdbfe;border-left:4px solid #2563eb;border-radius:8px;margin-bottom:24px">
      <tr><td style="padding:16px 20px">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#2563eb;margin-bottom:4px">Estimated Annual Uplift</div>
        <div style="font-size:28px;font-weight:900;color:#0f172a">+${fmt$(totalOpportunity)}<span style="font-size:14px;font-weight:500;color:#64748b">/yr</span></div>
        <div style="font-size:12px;color:#64748b;margin-top:2px">if all suggested changes are accepted</div>
      </td></tr>
    </table>

    <p style="font-size:13px;color:#475569;margin:0 0 20px;line-height:1.6">
      The review takes about 5 minutes. You'll see every suggested price, the estimated impact, and you can accept, adjust, or skip each one individually.
    </p>

    <!-- CTA button -->
    <table cellpadding="0" cellspacing="0" style="margin-bottom:24px">
      <tr><td style="background:#2563eb;border-radius:8px;padding:13px 28px">
        <a href="${portalUrl}" style="color:#fff;font-size:15px;font-weight:700;text-decoration:none;display:block">Review Your Pricing →</a>
      </td></tr>
    </table>

    <p style="font-size:12px;color:#94a3b8;margin:0;line-height:1.5">
      Or paste this link in your browser:<br>
      <a href="${portalUrl}" style="color:#2563eb;font-size:11px">${portalUrl}</a>
    </p>`;

  await transport.sendMail({
    from: FROM,
    to,
    subject: `${reportTitle} pricing review ready — ${flaggedCount} items, +${fmt$(totalOpportunity)}/yr opportunity`,
    html: emailBase(body)
  });

  console.log(`  ✉  Review email sent to ${to}`);
}

/**
 * Performance alert email — sent when track-outcomes.js newly flags one or more services.
 * Only called for services that are NEWLY flagged (status just changed to 'flagged').
 *
 * @param {object} opts
 * @param {string} opts.to           - owner email
 * @param {string} opts.clinicName
 * @param {Array}  opts.flaggedItems - price_outcomes rows with status='flagged'
 * @param {string} opts.portalUrl    - direct link to owner portal
 */
export async function sendAlertEmail({ to, clinicName, flaggedItems, portalUrl }) {
  const transport = nodemailer.createTransport(SMTP);

  const count = flaggedItems.length;
  const rows = flaggedItems.map(o => {
    const vd = Number(o.visit_delta_pct);
    const rd = Number(o.revenue_delta_pct);
    const vColor = vd < -15 ? '#dc2626' : '#64748b';
    const rColor = rd < -5  ? '#dc2626' : '#64748b';
    return `
    <tr style="border-bottom:1px solid #f1f5f9">
      <td style="padding:10px 12px;font-size:13px;font-weight:600;color:#0f172a">${o.service_name || o.service_code}</td>
      <td style="padding:10px 12px;font-size:13px;color:${vColor};text-align:right;font-weight:700">${pct(vd)}</td>
      <td style="padding:10px 12px;font-size:13px;color:${rColor};text-align:right;font-weight:700">${pct(rd)}</td>
    </tr>`;
  }).join('');

  const body = `
    <p style="font-size:16px;font-weight:700;color:#dc2626;margin:0 0 8px">
      Price reconsideration needed${count > 1 ? ` — ${count} services` : ''}.
    </p>
    <p style="font-size:14px;color:#475569;margin:0 0 20px;line-height:1.6">
      ${count === 1
        ? `<strong>${flaggedItems[0].service_name || flaggedItems[0].service_code}</strong> is underperforming since its price was raised. Revenue or visit volume has dropped below the threshold we watch for.`
        : `${count} services at ${clinicName} are underperforming since their prices were raised.`
      }
    </p>

    <!-- Service table -->
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #fecaca;border-radius:8px;overflow:hidden;margin-bottom:24px;font-size:12px">
      <tr style="background:#fef2f2">
        <th style="padding:8px 12px;text-align:left;color:#7f1d1d;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em">Service</th>
        <th style="padding:8px 12px;text-align:right;color:#7f1d1d;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em">Visits</th>
        <th style="padding:8px 12px;text-align:right;color:#7f1d1d;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em">Revenue</th>
      </tr>
      ${rows}
    </table>

    <p style="font-size:13px;color:#475569;margin:0 0 20px;line-height:1.6">
      You can lower the price to a level that works, or keep it and check back in 30 days. Takes less than 2 minutes.
    </p>

    <!-- CTA button -->
    <table cellpadding="0" cellspacing="0" style="margin-bottom:24px">
      <tr><td style="background:#dc2626;border-radius:8px;padding:13px 28px">
        <a href="${portalUrl}" style="color:#fff;font-size:15px;font-weight:700;text-decoration:none;display:block">Review Now →</a>
      </td></tr>
    </table>

    <p style="font-size:12px;color:#94a3b8;margin:0;line-height:1.5">
      Or paste this link in your browser:<br>
      <a href="${portalUrl}" style="color:#2563eb;font-size:11px">${portalUrl}</a>
    </p>`;

  await transport.sendMail({
    from: FROM,
    to,
    subject: count === 1
      ? `Price reconsideration needed — ${flaggedItems[0].service_name || flaggedItems[0].service_code}`
      : `${count} prices need reconsideration — ${clinicName}`,
    html: emailBase(body)
  });

  console.log(`  ✉  Alert email sent to ${to} (${count} flagged service${count !== 1 ? 's' : ''})`);
}
