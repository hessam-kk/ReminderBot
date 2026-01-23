-- Bot-issued /web codes have no web account yet, so web_user_id must be
-- nullable. SQLite can't drop a NOT NULL constraint in place — recreate.
ALTER TABLE link_codes RENAME TO link_codes_old;

CREATE TABLE link_codes (
  code_hash TEXT PRIMARY KEY,
  web_user_id INTEGER,
  telegram_user_id INTEGER,
  telegram_username TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

INSERT INTO link_codes (code_hash, web_user_id, telegram_user_id, telegram_username, created_at, expires_at)
  SELECT code_hash, web_user_id, telegram_user_id, telegram_username, created_at, expires_at
  FROM link_codes_old;

DROP TABLE link_codes_old;
