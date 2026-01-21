-- Web app: accounts + sessions (separate from Telegram users).
CREATE TABLE IF NOT EXISTS web_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,          -- pbkdf2$iterations$salt$hash
  timezone TEXT NOT NULL DEFAULT 'Asia/Tehran',
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,                 -- epoch seconds; NULL = not locked
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,          -- sha256 of the cookie token
  user_id INTEGER NOT NULL,             -- -> web_users.id
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
