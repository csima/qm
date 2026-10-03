CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  ref TEXT NOT NULL DEFAULT '',
  subdir TEXT NOT NULL DEFAULT '',
  auto INTEGER NOT NULL DEFAULT 1,
  last_sha TEXT,
  last_build_at INTEGER,
  last_error TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (repo, ref, subdir)
);
