# 🤖 ReminderBot — recurring reminders on Telegram

A Telegram bot deployed on **Cloudflare Workers + D1**. You type what to be
reminded about (e.g. "Vitamin D pills"), pick an interval, and the bot pings
you on schedule — with inline buttons for everything.

## Features

- ➕ **Add reminders by typing** — any item name ("Vitamin D pills", "Water", "Backup laptop")
- ⏱ **Interval templates with inline buttons**: every day · every week · every 2 weeks · every month · every 3 months · every 6 months · every year · or **custom days**
- 🕐 **Pick a fire time** via quick buttons (09:00 / 12:00 / 18:00 / 21:00…) or type any `HH:MM`
- 📅 **Backdated start** — when adding, tell the bot when the last cycle happened (Today · 1d · 3d · 1w · 2w · 1m ago · custom) so the first reminder lands on the right phase (e.g. last took it a week ago + “every 2 weeks” → reminder in 1 week)
- 🔔 **Interactive notifications**: ✅ Done · ⏰ +1h · ⏰ +1d · 🗑 Delete
- 📋 **`/list` management with pagination**: tap an item to see details, then Pause/Resume, edit interval, or Delete (with confirmation)
- 🔥 **Streaks** — every ✅ Done counts; best streak is tracked forever
- ⏸ **Pause/Resume** — keep the item, silence it for a while
- 🌍 **Per-user timezone**, default **Asia/Tehran 🇮🇷** (presets + custom IANA name)
- 📊 **`/stats`** — active reminders, total completions, top streaks, upcoming
- 👥 **Multi-user** — anyone who starts the bot gets their own private list

The cron sweep runs **every 5 minutes**; reminders fire at the item's chosen
local time (e.g. 09:00 Tehran) on its interval.

## Project layout

```
src/index.ts     — worker entry: webhook (secret-token check) + cron scheduler
src/bot.ts       — command dispatch, add flow state machine, all button flows
src/cron.ts      — due-reminder sweep
src/db.ts        — D1 queries (users, states, reminders, history, stats)
src/keyboards.ts — every inline keyboard
src/time.ts      — timezone-aware scheduling math (DST-safe)
src/telegram.ts  — Telegram Bot API client
migrations/      — D1 schema
```

## Deploy

### 1. Install & log in

```bash
npm install
npx wrangler login
```

### 2. Create the D1 database

```bash
npx wrangler d1 create reminder-bot-db
```

Copy the printed `database_id` into `wrangler.toml`, then apply the schema:

```bash
npx wrangler d1 migrations apply reminder-bot-db --remote
```

### 3. Set secrets

Get a bot token from [@BotFather](https://t.me/BotFather) (create a bot →
`/newbot`). Then:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # any long random string
```

### 4. Deploy

```bash
npm run deploy
```

The cron trigger (`*/5 * * * *`) is configured in `wrangler.toml` and deploys
with the worker — no extra steps.

### 5. Point Telegram at the webhook

```bash
curl -F "url=https://YOUR-WORKER.workers.dev/webhook" \
     -F "secret_token=THE-SAME-SECRET-AS-STEP-3" \
     https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook
```

The `secret_token` must match `TELEGRAM_WEBHOOK_SECRET`; the worker verifies it
on every update. Done — open the bot in Telegram and send `/start`!

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in your tokens
npx wrangler d1 migrations apply reminder-bot-db --local
npm run dev                      # wrangler dev, http://localhost:8787
```

To feed updates manually (instead of a tunnel):

```bash
curl -X POST http://localhost:8787/webhook \
     -H "Content-Type: application/json" \
     -H "X-Telegram-Bot-Api-Secret-Token: THE-SECRET" \
     -d '{"update_id":1,"message":{"message_id":1,"chat":{"id":123},"from":{"id":123},"text":"/start"}}'
```

To test the reminder sweep locally:

```bash
npx wrangler dev --test-scheduled
curl -X POST http://localhost:8787/__scheduled?cron=*/5+*+*+*+*
```

## Commands

| Command | Action |
| --- | --- |
| `/start`, `/help` | Main menu |
| `/add` | Add a reminder (type item → pick interval → pick time) |
| `/list`, `/myreminders` | Manage reminders |
| `/stats` | Streaks, completions, upcoming |
| `/timezone` | Change timezone (default Tehran) |
| `/cancel` | Cancel the current flow |