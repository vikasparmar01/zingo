# Zingo

Random one-on-one text and video chats with real people, built to ease loneliness and help people
practise talking to someone new. No profiles, no followers, no pressure.

Zingo is a Node.js web app: Express for the API, Socket.IO for live chat and matching, WebRTC for
video that goes straight between the two people, and SQLite for storage.

## Features

- **Text and video chat** with a random person, with topic matching and Gender / Country filters
  that work both ways.
- **Icebreakers**, a one-tap **Skip**, and a red flag **Report** button in every chat.
- **Accounts** with email or phone number (country dial codes), password sign-in, and forgot
  password by code.
- **Safety by default**
  - 18+ only, with the birthday locked after sign-up and under-18s blocked for good.
  - Emails, phone numbers and links are hidden in messages.
  - A stranger's video is blurred until you choose to show it.
  - Three different reporters suspend an account for 24 hours; two "seems under 18" reports pause
    it for review.
  - Passwords and session tokens are stored only as hashes; rate limits on codes and sign-ins.
- **Progress tracking** on the device: conversations, minutes, and how each chat felt.
- **Creators** page for partnership applications and **Suggestions** page for ideas and problem
  reports, both reviewed in an **admin inbox**.

## Run it locally

You need Node.js 22.5 or newer (Zingo uses the built-in `node:sqlite`).

```bash
npm install
npm start
```

Open http://localhost:3000. In development, sign-up codes are printed in the terminal instead of
being emailed or texted.

To try matching on one computer, use two different browsers, or `localhost` in one tab and
`127.0.0.1` in another: each keeps its own sign-in.

### Make yourself an admin

Sign up, then:

```bash
node scripts/make-admin.js you@example.com    # or a phone number with its country code: +447911123456
```

Reload the page and an **Admin** link appears.

## Tests

```bash
npm test          # 40 tests: accounts, security rules, chat matching, reports, forms, admin
npm run load      # load test: simulated people chatting in waves; see load/RESULTS.md
```

## Configuration

Set these as environment variables.

| Variable | What it does |
|---|---|
| `PORT` | Port to listen on. Default `3000`. |
| `NODE_ENV` | Set to `production` for live use: secure cookies, and the server refuses to start without email and SMS set up. |
| `DATA_DIR` | Folder for the SQLite database. Default `./data`. |
| `SMTP_URL` | Email server for sign-up and reset codes, e.g. `smtps://user:pass@smtp.example.com`. |
| `MAIL_FROM` | Sender address, e.g. `Zingo <no-reply@yourdomain.com>`. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | Twilio account for text-message codes. |
| `TRUST_PROXY` | Number of proxies in front of Zingo (for example `1` behind Cloudflare or a load balancer), so rate limits see each visitor's real address. |
| `ZINGO_SHOW_CODES` | Test mode only: shows sign-up codes on screen for a shared test link. Anyone can then sign up with any email, so it refuses to run in production. |

## Project layout

```
server.js            Express app, Socket.IO matching, chat, video signalling, reports
auth.js              Sign-up, sign-in, forgot password, profile, sessions
forms.js             Creator applications and suggestions
admin.js             Admin inbox API
db.js                SQLite schema and queries
mailer.js, sms.js    Email and text-message delivery
public/              The web app: index.html, app.js, style.css, countries.js
scripts/             make-admin.js
test/                Automated tests (node --test)
load/                Load test and its results
```

## Before a public launch

Zingo is not ready for strangers on the open internet yet. Still to do:

- A moderation queue in the admin page for reported and paused accounts.
- Delete-my-account and download-my-data, plus Terms, Privacy Policy and Community Guidelines.
- A video relay (TURN) server, so calls connect on mobile networks.
- Real age verification and automated video moderation; a typed-in birthday is not enough under
  laws like the UK Online Safety Act.
- Self-hosted fonts, backups, monitoring, and a review by a lawyer.

## License

[MIT](LICENSE) © 2026 Vikas Parmar
