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
const LOGO = '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';
const YEAR = new Date().getFullYear();

function email({ clinicName, ownerName, headline, body, buttonLabel, buttonUrl }) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#e8eef7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px">
  <tr><td align="center">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:460px">

      <!-- Logo card -->
      <tr><td style="background:#ffffff;border-radius:12px 12px 0 0;padding:28px 32px;border-bottom:1px solid #e8eef7">
        <img src="data:image/png;base64,${LOGO}" alt="Vet INC" height="36" style="display:block;border:0">
      </td></tr>

      <!-- Content card -->
      <tr><td style="background:#ffffff;padding:28px 32px 32px;border-radius:0 0 12px 12px">

        <div style="font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:10px">${clinicName}</div>

        <div style="font-size:22px;font-weight:700;color:#1e3a5f;line-height:1.25;margin-bottom:16px">Hi ${ownerName}, ${headline}</div>

        <div style="font-size:15px;color:#475569;line-height:1.65;margin-bottom:24px">${body}</div>

        <a href="${buttonUrl}" style="display:inline-block;background:#2563eb;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:13px 26px;border-radius:8px;margin-bottom:16px">${buttonLabel} →</a>

        <div style="font-size:12px;color:#94a3b8">No login required &nbsp;·&nbsp; Link expires in 7 days</div>

      </td></tr>

      <!-- Footer -->
      <tr><td style="padding:18px 0;font-size:11px;color:#94a3b8;text-align:center;line-height:1.8">
        © ${YEAR} Vet INC &nbsp;·&nbsp; jack@wildroseautomations.ca &nbsp;·&nbsp; <a href="#" style="color:#94a3b8;text-decoration:none">Unsubscribe</a>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

export async function sendReviewEmail({ to, ownerName, clinicName, flaggedCount, portalUrl }) {
  const transport = nodemailer.createTransport(SMTP);
  const name = ownerName || 'there';
  await transport.sendMail({
    from: FROM,
    to,
    subject: `You have ${flaggedCount} pricing items to review — ${clinicName}`,
    html: email({
      clinicName,
      ownerName: name,
      headline: 'you have pricing items to review',
      body: `There are <strong>${flaggedCount} items</strong> waiting for your approval. Click below to review them — it only takes a couple of minutes.`,
      buttonLabel: 'Review Items',
      buttonUrl: portalUrl,
    })
  });
  console.log(`  ✉  Review email sent to ${to}`);
}

export async function sendAlertEmail({ to, ownerName, clinicName, flaggedItems, portalUrl }) {
  const transport = nodemailer.createTransport(SMTP);
  const count = flaggedItems.length;
  const name = ownerName || 'there';
  await transport.sendMail({
    from: FROM,
    to,
    subject: `${count} price${count === 1 ? '' : 's'} need attention — ${clinicName}`,
    html: email({
      clinicName,
      ownerName: name,
      headline: `${count === 1 ? 'a price needs' : `${count} prices need`} your attention`,
      body: `${count === 1 ? 'One service' : `${count} services`} at ${clinicName} ${count === 1 ? 'is' : 'are'} underperforming since the last price change. Click below to review and adjust — it only takes a couple of minutes.`,
      buttonLabel: 'Review Now',
      buttonUrl: portalUrl,
    })
  });
  console.log(`  ✉  Alert email sent to ${to}`);
}
