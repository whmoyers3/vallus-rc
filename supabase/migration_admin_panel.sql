-- Admin panel schema migration
-- Run in Supabase SQL editor

ALTER TABLE calculations ADD COLUMN IF NOT EXISTS comparison_snapshot JSONB;
ALTER TABLE calculations ADD COLUMN IF NOT EXISTS salas_reference_orientation TEXT;
ALTER TABLE calculations ADD COLUMN IF NOT EXISTS import_fidelity_passed BOOLEAN;
ALTER TABLE calculations ADD COLUMN IF NOT EXISTS import_fidelity_details JSONB;
ALTER TABLE calculations ADD COLUMN IF NOT EXISTS parent_id BIGINT REFERENCES calculations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_calc_parent ON calculations(parent_id);
