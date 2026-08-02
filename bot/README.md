# Speak English — Telegram bot

The same English SRS engine as the web app, delivered as a Telegram bot with a
Japanese interface. Zero npm dependencies (Node 20+ fetch only). Each Telegram
chat is its own account — deck, levels, streak and quota are stored per chat
in `bot/data/`.

## Setup

1. In Telegram, open **@BotFather** → `/newbot` → follow the prompts → copy the token.
2. Run the bot:

```bash
cd speak-english
TELEGRAM_BOT_TOKEN=123456:ABC-your-token node bot/bot.mjs
```

3. Open your bot in Telegram and send `/start`.

Keep it running with any process manager, e.g.:

```bash
TELEGRAM_BOT_TOKEN=... npx pm2 start bot/bot.mjs --name speak-english
```

Preview the whole conversation offline (no token needed):

```bash
node bot/bot.mjs --preview
```

## Commands

| Command | What it does |
|---|---|
| `/start`, `/study` | Start / continue reviewing (due cards first, then today's new-word quota) |
| `/stats` | Fluency %, word count, due cards, streak |
| `/quota 30` | Set new words per day (1–200, default 20) |
| `/help` | Command list |

## How reviewing works

The bot sends the English word → you tap **👁 答えを見る** → grade yourself
**✓ 正解 (+1 level)** or **✗ 不正解 (−1 level, back in 10 min)** — the same
scoring as the web app. Verb forms are separate cards for scheduling but roll
up into their word's mastery. Deck: 1,000 useful frequency-ordered words
(function-word filler like "the / be / and" excluded) + forms of the top 60
verbs.
