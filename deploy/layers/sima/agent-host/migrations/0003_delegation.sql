ALTER TABLE tasks ADD COLUMN parent TEXT;
ALTER TABLE tasks ADD COLUMN chain TEXT;
CREATE INDEX tasks_by_parent ON tasks (parent);
