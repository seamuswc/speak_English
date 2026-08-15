# Eigobot — 英単語SRS (for Japanese speakers)

A spaced-repetition web app that takes Japanese speakers of English from 0 →
fluent. Same engine and layout as the Govoru Russian app, with an English deck
and a fully Japanese UI.

## What's in the box

- **8,000 English word cards**, frequency-ordered (OpenSubtitles frequency
  list), glossed in Japanese (EJDict 英和辞典, core translations only).
- **577 verb-form cards** for the top ~184 verbs (3rd person, past, past
  participle, -ing). Every form is its own card with its own schedule, but all
  forms roll up into the mastery of their base verb.
- **Audio**: tap the speaker (or press `f` / `h` / `p`) to hear the word —
  server-side edge-tts (`en-US-JennyNeural`), cached on disk.
- **Accounts**: email + password, server-synced progress, password reset via
  Resend email. Signed-out visitors get a fixed 20-word demo (unsaved).
- **Payments**: ¥800 / 31 days via Stripe Checkout (credit card). No account
  is created until Stripe confirms the payment.

## How reviewing works

- **Space** — reveal the answer; **space again** — correct (+1 level).
- **Any other key** — wrong (−1 level, back in 10 min).
- **Backspace** — undo the last grade.
- Toggle to 4-grade scoring (もう一度 / 難しい / 良い / 簡単) in the review
  header if you prefer finer control.

## Run it

```bash
npm install
npm run dev        # dev server
npm run build      # → dist/
cd server && npm install   # stripe
node server/app.mjs        # serves dist/ + auth/sync/payment/TTS API on :80
```

Server env (set in the environment or in `server/.env`, which is gitignored):

| Var | Purpose |
| --- | --- |
| `PORT` | listen port (default `80`) |
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_…`) — enables payments; without it the app is free/open |
| `SUB_DAYS` | days of access per ¥800 payment (default `31`) |
| `RESEND_API_KEY` | password-reset email |
| `TTS_PYTHON` / `TTS_VOICE` | python with edge-tts installed / voice name |
| `MAINTENANCE` | `1` = serve the maintenance page (`server/maintenance.html`) and 503 the API |

## Payments

Two plans, both ¥800 (JPY only, Japanese Stripe Checkout):

- **月額 (sub)** — auto-renewing monthly subscription (`mode: subscription`).
  Each paid renewal invoice hits `/api/webhook/stripe` (signature-verified)
  and extends access by 31 days. Users can cancel auto-renew from the account
  screen (`/api/pay/cancel` cancels at period end; access runs to `subUntil`).
- **1か月のみ (month)** — one-time payment, 31 days, no renewal.

Registration stores credentials in `pendingRegs`, creates a Stripe Checkout
session and redirects the browser to Stripe. After payment, Stripe returns to
`/?session_id=…`; the app verifies the session server-side
(replay-protected) and only then creates the account. If a customer pays but
never completes the redirect, re-registering with the same email claims the
paid session instead of charging twice. Every session and payment is tagged
`site: eigobot` so revenue stays filterable when this Stripe account hosts
multiple sites.

## Maintenance mode

```bash
sudo systemctl edit eigobot   # add:  [Service]  Environment=MAINTENANCE=1
sudo systemctl restart eigobot
# …do the upgrade…
sudo systemctl revert eigobot && sudo systemctl restart eigobot
```

## Telegram bot

See `bot/README.md` — a zero-dependency bot with the same SRS engine and a
1,000-word useful-vocabulary deck (no function-word filler, no audio).

Data sources: OpenSubtitles frequency list; EJDict (英和辞典) glosses.
