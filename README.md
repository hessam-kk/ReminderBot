# 🤖 ReminderBot — recurring reminders on Telegram

A Telegram bot deployed on **Cloudflare Workers + D1**. You type what to be
reminded about (e.g. "Vitamin D pills"), pick an interval, and the bot pings
you on schedule — with inline buttons for everything.

## Features

- ➕ **Add reminders by typing** — any item name ("Vitamin D pills", "Water", "Backup laptop")
- ⏱ **Interval templates with inline buttons**: every day · every week · every 2 weeks · every month · every 3 months · every 6 months · every year · or **custom days**
- 🕐 **Pick a fire time** via quick buttons (09:00 / 12:00 / 18:00 / 21:00…) or type any `HH:MM`
- 📅 **Backdated start** — when adding, tell the bot when the last cycle happened (Today · 1d · 3d · 1w · 2w · 1m ago · custom) so the first reminder lands on the right phase (e.g. last took it a week ago + “every 2 weeks” → reminder in 1 week). Same “templates + ✏️ Custom” pattern on the web
- 🧹 **Clean add flow** — each interval/start/time message is deleted from the chat once you tap a button, so the conversation doesn't pile up
- 🎛 **Rich `/start` menu** — a two-column button grid: ➕ Add · 📋 My reminders · 📊 Stats · 🌍 Timezone · 🔑 Web login code · 🌐 Open web app · ❓ Help (with a URL button that opens the web app in Telegram)
- 🔔 **Interactive notifications**: ✅ Done · ⏰ +1h · ⏰ +1d · 🗑 Delete
- 📋 **`/list` management with pagination**: tap an item to see details, then Pause/Resume, edit interval, or Delete (with confirmation)
- 🔥 **Streaks** — every ✅ Done counts; best streak is tracked forever
- ⏸ **Pause/Resume** — keep the item, silence it for a while
- 🌍 **Per-user timezone**, default **Asia/Tehran 🇮🇷** (presets + custom IANA name)
- 📊 **`/stats`** — active reminders, total completions, top streaks, upcoming
- 👥 **Multi-user** — anyone who starts the bot gets their own private list
- 🌐 **Web app** — the same reminders, managed from the browser at `https://reminder-bot.hessam2.workers.dev/` (own account per person, login/register)
- 🧭 **Web list tabs** — **Upcoming**, **Today / overdue**, and **Paused**, each with live count badges, filtered in your timezone
- 📊 **Web stats** — colored stat cards (active/total/completed/best streak) plus **top streaks** and **upcoming** panels, mirroring the bot's `/stats`
- 🌗 **Light/dark theme** — toggle with a sun/moon button (persisted), or follow your OS
- 🔍 **Polish** — SVG icon set, hover tooltips on every control, themed scrollbars, custom-IANA timezone picker, show/hide password toggle
- 🔗 **One account, both UIs** — link your web account to Telegram with a one-time code (`/link <code>` in the bot, code from the web app); after linking, bot and web share a single reminder list and the bot keeps delivering the notifications
- 🪪 **Bot-first login** — send `/web` to the bot, get an 8-char code, enter it under the “Telegram” tab on the web app; your account is created, linked, and you're signed in — no username/password needed

Feature-for-feature, the bot and web are kept in sync (see the module note
below); anything you can do in one, you can do in the other.

The cron sweep runs **every 5 minutes**; reminders fire at the item's chosen
local time (e.g. 09:00 Tehran) on its interval. Unlinked web accounts follow
the same schedule and show as “due” on the page; linking them to Telegram
also wires up push notifications.

## Project layout

```
src/index.ts     — worker entry: webhook (secret-token check) + cron scheduler + /api routing
src/bot.ts       — command dispatch, add flow state machine, all button flows, /link
src/cron.ts      — due-reminder sweep
src/db.ts        — D1 queries (users, states, reminders, history, stats, web users/sessions, links)
src/keyboards.ts — every inline keyboard
src/time.ts      — timezone-aware scheduling math (DST-safe)
src/web.ts       — web API: PBKDF2 auth, session cookies, user-scoped CRUD, link & login codes, custom timezone
src/telegram.ts  — Telegram Bot API client
public/          — browser frontend (index.html, style.css, app.js), served as static assets
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
| `/start`, `/help` | Main menu (two-column button grid incl. web links) |
| `/add` | Add a reminder (type item → pick interval → pick time) |
| `/list`, `/myreminders` | Manage reminders |
| `/stats` | Streaks, completions, upcoming |
| `/timezone` | Change timezone (default Tehran, presets + custom IANA) |
| `/web` | Get an 8-char code to sign in to the web app (bot-first login) |
| `/link <code>` | Link this Telegram account to your web account |
| `/cancel` | Cancel the current flow |