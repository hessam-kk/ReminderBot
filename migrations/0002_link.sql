-- One-account model: a web account can be bound to a Telegram account.
-- After binding, both UIs operate on the same reminder list (the Telegram
-- user id becomes the canonical space, since the bot notifies via Telegram).
ALTER TABLE web_users ADD COLUMN telegram_user_id INTEGER;
ALTER TABLE web_users ADD COLUMN telegram_username TEXT;

-- A Telegram account can only ever be bound to one web account.
CREATE UNIQUE INDEX IF NOT EXISTS idx_web_users_telegram ON web_users (telegram_user_id);

-- One-time link codes shown by the web app and confirmed via the bot.
CREATE TABLE IF NOT EXISTS link_codes (
  code_hash TEXT PRIMARY KEY,   -- sha256 of the code
  web_user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
