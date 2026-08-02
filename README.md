# Speak English — 英単語SRS (for Japanese speakers)

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
node server/app.mjs   # serves dist/ + auth/sync/TTS API on :80
```

Server env: `PORT`, `RESEND_API_KEY` (password-reset email),
`TTS_PYTHON` (python with edge-tts installed), `TTS_VOICE`.

## Telegram bot

See `bot/README.md` — a zero-dependency bot with the same SRS engine and a
1,000-word useful-vocabulary deck (no function-word filler, no audio).

Data sources: OpenSubtitles frequency list; EJDict (英和辞典) glosses.
