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

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'takeoff-references',
  'takeoff-references',
  FALSE,
  7340032,
  ARRAY['application/pdf', 'image/png', 'image/jpeg', 'image/webp']::text[]
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

CREATE TABLE IF NOT EXISTS takeoff_assets (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  takeoff_project_id  BIGINT REFERENCES takeoff_projects(id) ON DELETE SET NULL,

  floor_id            TEXT NOT NULL DEFAULT '',
  page_number         INTEGER NOT NULL DEFAULT 1,
  storage_bucket      TEXT NOT NULL DEFAULT 'takeoff-references',
  storage_path        TEXT NOT NULL UNIQUE,
  filename            TEXT NOT NULL DEFAULT '',
  mime_type           TEXT NOT NULL DEFAULT '',
  size_bytes          BIGINT NOT NULL DEFAULT 0,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_takeoff_assets_project ON takeoff_assets(takeoff_project_id);
CREATE INDEX IF NOT EXISTS idx_takeoff_assets_floor   ON takeoff_assets(floor_id);

DROP TRIGGER IF EXISTS takeoff_assets_updated_at ON takeoff_assets;
CREATE TRIGGER takeoff_assets_updated_at
  BEFORE UPDATE ON takeoff_assets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
