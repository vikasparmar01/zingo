// Sends text messages through Twilio's REST API when TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and
// TWILIO_FROM are set. Without them, messages are printed to the server console (development only).
const SID = process.env.TWILIO_ACCOUNT_SID;
const TOKEN = process.env.TWILIO_AUTH_TOKEN;
const FROM = process.env.TWILIO_FROM;

if (!SID && process.env.NODE_ENV === 'production') {
  throw new Error('TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM must be set in production.');
}

async function sendSms(to, text) {
  if (!SID) {
    console.log(`[dev sms] To ${to}: ${text}`);
    return;
  }
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, From: FROM, Body: text }),
  });
  if (!res.ok) throw new Error(`Twilio responded ${res.status}: ${await res.text()}`);
}

module.exports = { sendSms };
