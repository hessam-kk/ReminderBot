-- Bot-first login: the bot (/web) issues codes tied to a Telegram account,
-- so the same table can carry codes generated from either side.
ALTER TABLE link_codes ADD COLUMN telegram_user_id INTEGER;
ALTER TABLE link_codes ADD COLUMN telegram_username TEXT;
