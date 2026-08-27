let nodemailer;
try {
  nodemailer = require('nodemailer');
} catch (e) {
  nodemailer = null;
}

/**
 * Creates an email transporter from environment variables.
 * Supported env vars:
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, SMTP_SECURE
 *   or GMAIL_USER + GMAIL_APP_PASSWORD
 */
function getTransporter() {
  if (!nodemailer) return null;

  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true' || Number(process.env.SMTP_PORT) === 465,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }

  if (process.env.GMAIL_USER && (process.env.GMAIL_APP_PASSWORD || process.env.GMAIL_PASS)) {
    return nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD || process.env.GMAIL_PASS,
      },
    });
  }

  if (process.env.RESEND_API_KEY) {
    return nodemailer.createTransport({
      host: 'smtp.resend.com',
      port: 465,
      secure: true,
      auth: {
        user: 'resend',
        pass: process.env.RESEND_API_KEY,
      },
    });
  }

  if (process.env.SENDGRID_API_KEY) {
    return nodemailer.createTransport({
      host: 'smtp.sendgrid.net',
      port: 587,
      secure: false,
      auth: {
        user: 'apikey',
        pass: process.env.SENDGRID_API_KEY,
      },
    });
  }

  if (process.env.BREVO_API_KEY || process.env.BREVO_SMTP_KEY) {
    return nodemailer.createTransport({
      host: 'smtp-relay.brevo.com',
      port: 587,
      secure: false,
      auth: {
        user: process.env.BREVO_USER || process.env.SMTP_USER,
        pass: process.env.BREVO_API_KEY || process.env.BREVO_SMTP_KEY,
      },
    });
  }

  return null;
}

const FROM_NAME = process.env.SMTP_FROM_NAME || 'Howl A/G Studio';
const FROM_EMAIL = process.env.SMTP_FROM || process.env.SMTP_USER || process.env.GMAIL_USER || 'onboarding@resend.dev';

/**
 * Sends a confirmation email to a user who wishlisted a game.
 */
async function sendWishlistConfirmation({ to, name, gameTitle, gameSlug, notifyNews, notifyDevlog, siteUrl, studioName }) {
  if (!to) return;
  const studio = studioName || 'Howl A/G Studio';
  const url = siteUrl || 'https://howl-ag-studio.onrender.com';
  const gameUrl = `${url}/games/${gameSlug}`;
  const greeting = name ? `Hi ${name},` : 'Hello,';

  const subject = `You're on the wishlist for ${gameTitle}! 🐺`;

  const textBody = `${greeting}

Thank you for wishlisting ${gameTitle}!

You will be notified again when the game status changes.

Your notification preferences:
${notifyNews !== false ? '✓ News & release updates' : '✗ News & release updates'}
${notifyDevlog !== false ? '✓ Devlog & behind-the-scenes posts' : '✗ Devlog & behind-the-scenes posts'}

View the game page: ${gameUrl}
Read our Devlog: ${url}/devlog

— The team at ${studio}
`;

  const htmlBody = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${subject}</title>
</head>
<body style="margin:0;padding:0;background-color:#0b0e14;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#e6edf3;">
  <table width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color:#0b0e14;padding:30px 15px;">
    <tr>
      <td align="center">
        <table width="100%" max-width="580" border="0" cellspacing="0" cellpadding="0" style="max-width:580px;background-color:#161b22;border:1px solid #30363d;border-radius:12px;overflow:hidden;">
          <!-- Header -->
          <tr>
            <td style="padding:28px 32px;background:linear-gradient(135deg,#0d1117,#1f2937);border-bottom:1px solid #30363d;">
              <h2 style="margin:0;font-size:22px;color:#a3e635;letter-spacing:1px;text-transform:uppercase;">🐺 ${studio}</h2>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:32px;">
              <p style="font-size:16px;color:#e6edf3;margin-top:0;">${greeting}</p>
              <h1 style="font-size:22px;color:#ffffff;margin:12px 0 16px;">Thank you for wishlisting <span style="color:#a3e635;">${gameTitle}</span>!</h1>
              <p style="font-size:15px;line-height:1.6;color:#8b949e;">
                You will be notified again when the game status changes. We're building this world with care, and your interest helps us prove real player demand.
              </p>

              <!-- Preferences Box -->
              <div style="background-color:#0d1117;border:1px solid #30363d;border-radius:8px;padding:18px 20px;margin:24px 0;">
                <p style="margin:0 0 10px;font-size:13px;font-weight:600;color:#8b949e;text-transform:uppercase;letter-spacing:0.5px;">Your Update Preferences</p>
                <div style="font-size:14px;color:#e6edf3;margin-bottom:6px;">
                  <span style="color:${notifyNews !== false ? '#a3e635' : '#8b949e'};font-weight:bold;">${notifyNews !== false ? '✓' : '✗'}</span> News &amp; Major Announcements
                </div>
                <div style="font-size:14px;color:#e6edf3;">
                  <span style="color:${notifyDevlog !== false ? '#a3e635' : '#8b949e'};font-weight:bold;">${notifyDevlog !== false ? '✓' : '✗'}</span> Devlogs &amp; Behind-The-Scenes Posts
                </div>
              </div>

              <!-- Button -->
              <div style="margin:28px 0;">
                <a href="${gameUrl}" style="display:inline-block;background-color:#a3e635;color:#0b0e14;font-weight:700;font-size:14px;text-decoration:none;padding:12px 24px;border-radius:6px;letter-spacing:0.5px;">View ${gameTitle}</a>
              </div>

              <hr style="border:none;border-top:1px solid #30363d;margin:28px 0;">
              <p style="font-size:13px;color:#8b949e;margin:0;">
                Follow our journey in the open: <a href="${url}/devlog" style="color:#a3e635;text-decoration:none;">Devlog</a> · <a href="${url}/news" style="color:#a3e635;text-decoration:none;">News</a>
              </p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:20px 32px;background-color:#0d1117;border-top:1px solid #30363d;font-size:12px;color:#8b949e;text-align:center;">
              Sent by ${studio} · You received this because you wishlisted ${gameTitle}.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;

  const transporter = getTransporter();
  if (!transporter) {
    console.log(`[email] (Simulation) Wishlist confirmation sent to "${to}" for "${gameTitle}". [SMTP not configured in .env]`);
    return;
  }

  try {
    await transporter.sendMail({
      from: `"${FROM_NAME}" <${FROM_EMAIL}>`,
      to,
      subject,
      text: textBody,
      html: htmlBody,
    });
    console.log(`[email] Successfully sent wishlist confirmation to "${to}" for "${gameTitle}".`);
  } catch (err) {
    console.error(`[email] Error sending email to "${to}":`, err.message);
  }
}

/**
 * Sends a thank you email to a donor.
 */
async function sendDonationThankYou({ to, donorName, gameTitle, amount, siteUrl, studioName }) {
  if (!to) return;
  const studio = studioName || 'Howl A/G Studio';
  const url = siteUrl || 'https://howl-ag-studio.onrender.com';
  const greeting = donorName && donorName !== 'Anonymous' ? `Hi ${donorName},` : 'Hello,';
  const subject = `Thank you for backing ${gameTitle}! 🐺`;

  const textBody = `${greeting}

Thank you so much for your generous donation of $${Number(amount).toFixed(2)} towards ${gameTitle}!

Your contribution directly funds the development, artwork, music, and voice acting for the game.

View the fundraiser progress: ${url}/games

— With gratitude from the entire pack at ${studio}
`;

  const htmlBody = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${subject}</title>
</head>
<body style="margin:0;padding:0;background-color:#0b0e14;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#e6edf3;">
  <table width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color:#0b0e14;padding:30px 15px;">
    <tr>
      <td align="center">
        <table width="100%" max-width="580" border="0" cellspacing="0" cellpadding="0" style="max-width:580px;background-color:#161b22;border:1px solid #30363d;border-radius:12px;overflow:hidden;">
          <tr>
            <td style="padding:28px 32px;background:linear-gradient(135deg,#0d1117,#1f2937);border-bottom:1px solid #30363d;">
              <h2 style="margin:0;font-size:22px;color:#a3e635;letter-spacing:1px;text-transform:uppercase;">🐺 ${studio}</h2>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              <p style="font-size:16px;color:#e6edf3;margin-top:0;">${greeting}</p>
              <h1 style="font-size:22px;color:#ffffff;margin:12px 0 16px;">Thank you for backing <span style="color:#a3e635;">${gameTitle}</span>!</h1>
              <p style="font-size:15px;line-height:1.6;color:#8b949e;">
                We received your generous contribution of <strong style="color:#a3e635;font-size:18px;">$${Number(amount).toFixed(2)} USD</strong>.
              </p>
              <p style="font-size:15px;line-height:1.6;color:#8b949e;">
                Your support directly helps make this game a reality. You are an essential part of bringing this vision to life.
              </p>
              <div style="margin:28px 0;">
                <a href="${url}" style="display:inline-block;background-color:#a3e635;color:#0b0e14;font-weight:700;font-size:14px;text-decoration:none;padding:12px 24px;border-radius:6px;">Visit Studio Website</a>
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;

  const transporter = getTransporter();
  if (!transporter) {
    console.log(`[email] (Simulation) Donation thank you sent to "${to}" ($${amount}) for "${gameTitle}".`);
    return;
  }

  try {
    await transporter.sendMail({
      from: `"${FROM_NAME}" <${FROM_EMAIL}>`,
      to,
      subject,
      text: textBody,
      html: htmlBody,
    });
    console.log(`[email] Successfully sent donation receipt to "${to}".`);
  } catch (err) {
    console.error(`[email] Error sending donation receipt to "${to}":`, err.message);
  }
}

module.exports = { sendWishlistConfirmation, sendDonationThankYou, getTransporter };
