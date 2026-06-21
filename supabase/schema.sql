-- VRC (Vallus Residential Calculator)
-- Supabase / PostgreSQL schema
-- Run this in the Supabase SQL editor to initialize the database.
-- Includes: test battery, comparison snapshots, import fidelity columns.

-- ──────────────────────────────────────────────
-- CALCULATIONS
-- Replaces the local SQLite "projects" table.
-- Each row is one load calculation entry.
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS calculations (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- Legacy/engine fields (kept for frontend backward-compat)
  name          TEXT NOT NULL DEFAULT '',
  location      TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL DEFAULT '',

  -- Structured hierarchy fields
  -- Generated filename formula:
  --   {plan_name} {elevation} {foundation} {orientation} {variations}-vrc.pdf
  builder_name  TEXT NOT NULL DEFAULT '',
  project_name  TEXT NOT NULL DEFAULT '',
  plan_name     TEXT NOT NULL DEFAULT '',
  elevation     TEXT,
  foundation    TEXT,
  orientation   TEXT,
  variations    TEXT,

  -- Source tracking: 'vrc' | 'salas_import' | 'test_battery'
  source        TEXT NOT NULL DEFAULT 'vrc',

  -- Test battery: points back to the salas_import this copy was made from
  parent_id     BIGINT REFERENCES calculations(id) ON DELETE SET NULL,

  -- Salas comparison snapshot (computed at save time for salas_import rows)
  comparison_snapshot          JSONB,
  salas_reference_orientation  TEXT,

  -- Import fidelity (computed at save time for salas_import rows)
  import_fidelity_passed   BOOLEAN,
  import_fidelity_details  JSONB,

  -- Optional exclusion flag for battery records with known-broken Salas reference data
  reference_valid  BOOLEAN,
  notes            TEXT,

  -- Full engine payload
  payload_json  JSONB NOT NULL,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_calc_builder   ON calculations(builder_name);
CREATE INDEX IF NOT EXISTS idx_calc_project   ON calculations(project_name);
CREATE INDEX IF NOT EXISTS idx_calc_plan      ON calculations(plan_name);
CREATE INDEX IF NOT EXISTS idx_calc_source    ON calculations(source);
CREATE INDEX IF NOT EXISTS idx_calc_updated   ON calculations(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_calc_parent    ON calculations(parent_id);

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS calculations_updated_at ON calculations;
CREATE TRIGGER calculations_updated_at
  BEFORE UPDATE ON calculations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ──────────────────────────────────────────────
-- TAKEOFF PROJECTS
-- Editable takeoff authoring JSON, stored separately from finalized
-- calculation payloads but linkable when a generated calculation exists.
-- ──────────────────────────────────────────────
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


-- ──────────────────────────────────────────────
-- ASSEMBLIES
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS assemblies (
  id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code      TEXT NOT NULL,
  u_value   REAL,
  shgc      REAL,
  label     TEXT NOT NULL,
  UNIQUE (code, u_value, shgc, label)
);

INSERT INTO assemblies (code, u_value, shgc, label) VALUES
  ('W1', 0.077, NULL, 'Above Grade - 2x4 R-13 batt'),
  ('W1', 0.060, NULL, 'Above Grade - 2x4 R-15 batt'),
  ('W1', 0.048, NULL, 'Above Grade - 2x6 R-19 batt'),
  ('D1', 0.130, NULL, 'Exterior Door R-7.7'),
  ('D1', 0.200, NULL, 'Exterior Door R-5'),
  ('D2', 0.083, NULL, 'Garage Door R-12'),
  ('D2', 0.500, NULL, 'Garage Door R-2'),
  ('R1', 0.026, NULL, 'Flat Ceiling R-38 blown'),
  ('R1', 0.033, NULL, 'Flat Ceiling R-30 blown'),
  ('R1', 0.031, NULL, 'Flat Ceiling R-30 sprayed'),
  ('F2', 0.100, NULL, 'Slab on grade'),
  ('F1', 0.053, NULL, 'Framed floor R-19 batt'),
  ('F1', 0.026, NULL, 'Framed floor R-38 batt'),
  ('G1', 0.350, 0.22, 'Double insulated, SHGC 0.22'),
  ('G1', 0.320, 0.22, 'Double insulated, SHGC 0.22'),
  ('G1', 0.330, 0.19, 'Double insulated, SHGC 0.19'),
  ('G1', 0.340, 0.27, 'Double insulated, SHGC 0.27')
ON CONFLICT DO NOTHING;
