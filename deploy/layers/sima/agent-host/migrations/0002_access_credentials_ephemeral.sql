CREATE TABLE agent_access (
  agent TEXT PRIMARY KEY,
  use_list TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE user_credentials (
  owner TEXT NOT NULL,
  agent TEXT NOT NULL,
  sealed TEXT NOT NULL,
  names TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner, agent)
);

ALTER TABLE instances ADD COLUMN ephemeral INTEGER NOT NULL DEFAULT 0;
CREATE INDEX instances_by_owner ON instances (owner, status);
