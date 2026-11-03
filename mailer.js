const nodemailer = require('nodemailer');

// Set SMTP_URL (e.g. smtps://user:pass@smtp.example.com) to send real emails.
// Without it, emails are printed to the server console, which is only acceptable in development.
const transport = process.env.SMTP_URL ? nodemailer.createTransport(process.env.SMTP_URL) : null;
const FROM = process.env.MAIL_FROM || 'Zingo <no-reply@localhost>';

if (!transport && process.env.NODE_ENV === 'production') {
  throw new Error('SMTP_URL must be set in production so codes are emailed, not logged.');
}

async function sendEmail(to, subject, text) {
  if (!transport) {
    console.log(`[dev email] To ${to}: ${text}`);
    return;
  }
  await transport.sendMail({ from: FROM, to, subject, text });
}

module.exports = { sendEmail };
