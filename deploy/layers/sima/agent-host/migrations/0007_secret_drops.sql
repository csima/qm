CREATE TABLE secret_drops (
  id TEXT PRIMARY KEY,
  sealed TEXT NOT NULL,
  from_instance TEXT NOT NULL,
  to_instance TEXT NOT NULL,
  task TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX secret_drops_by_expiry ON secret_drops (expires_at);
