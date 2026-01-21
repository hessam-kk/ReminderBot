CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,            -- Telegram user id
  chat_id INTEGER NOT NULL,          -- chat where notifications are sent
  timezone TEXT NOT NULL DEFAULT 'Asia/Tehran',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  interval_days INTEGER NOT NULL,
  hour INTEGER NOT NULL DEFAULT 9,
  minute INTEGER NOT NULL DEFAULT 0,
  next_due INTEGER NOT NULL,         -- epoch seconds (UTC) of next fire
  active INTEGER NOT NULL DEFAULT 1,
  streak INTEGER NOT NULL DEFAULT 0,
  best_streak INTEGER NOT NULL DEFAULT 0,
  last_done_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders (active, next_due);

CREATE TABLE IF NOT EXISTS done_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reminder_id INTEGER NOT NULL,
  done_at INTEGER NOT NULL
);

-- Per-user conversation state (multi-step flows: add / custom interval / tz)
CREATE TABLE IF NOT EXISTS states (
  user_id INTEGER PRIMARY KEY,
  state TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);