CREATE TABLE versions (
  agent TEXT NOT NULL,
  version TEXT NOT NULL,
  image TEXT NOT NULL,
  commit_sha TEXT,
  source TEXT,
  manifest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (agent, version)
);

CREATE TABLE instances (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  version TEXT NOT NULL,
  owner TEXT NOT NULL,
  sharing TEXT NOT NULL,
  size TEXT NOT NULL,
  status TEXT NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  instance TEXT NOT NULL,
  session TEXT NOT NULL,
  caller TEXT NOT NULL,
  via TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  error TEXT,
  callback_url TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX tasks_by_instance ON tasks (instance, created_at);

CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  via TEXT NOT NULL,
  action TEXT NOT NULL,
  instance TEXT,
  session TEXT,
  detail TEXT
);
CREATE INDEX audit_by_instance ON audit (instance, at);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  owner TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
