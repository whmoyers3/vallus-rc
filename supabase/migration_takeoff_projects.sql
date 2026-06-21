-- VRC Takeoff Tool editable JSON persistence.
-- Run once in the Supabase SQL editor for existing databases.

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS takeoff_projects (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  calculation_id  BIGINT REFERENCES calculations(id) ON DELETE SET NULL,

  name            TEXT NOT NULL DEFAULT '',
  location        TEXT NOT NULL DEFAULT '',
  description     TEXT NOT NULL DEFAULT '',
  schema_version  TEXT NOT NULL DEFAULT 'takeoff.v1',

  takeoff_json    JSONB NOT NULL,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_takeoff_calc      ON takeoff_projects(calculation_id);
CREATE INDEX IF NOT EXISTS idx_takeoff_name      ON takeoff_projects(name);
CREATE INDEX IF NOT EXISTS idx_takeoff_updated   ON takeoff_projects(updated_at DESC);

DROP TRIGGER IF EXISTS takeoff_projects_updated_at ON takeoff_projects;
CREATE TRIGGER takeoff_projects_updated_at
  BEFORE UPDATE ON takeoff_projects
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
