# VRC — Vallus Residential Calculator

## Project Overview

VRC is an HVAC load calculation tool that imports Salas O'Brien resload PDFs, extracts their raw inputs, and runs them through our own calculation engine to produce comparable results. The goal is to match Salas O'Brien's output closely enough to use VRC as a fast, independent load calculator.

**Stack:** React + TypeScript + Vite (frontend), Python/FastAPI (backend), Supabase/PostgreSQL (database), Vercel (deploy).

## Key Files

- `backend/engine/calculator.py` — core calculation engine
- `backend/engine/constants.py` — CLTD values, safety factors, infiltration rates
- `backend/engine/formulas.py` — formula primitives (glass load factor, component loads)
- `backend/engine/models.py` — data structures (Project, Level, Room, LineItem)
- `backend/api/app.py` — FastAPI routes
- `backend/api/database.py` — Supabase persistence layer
- `backend/api/salas_pdf_import.py` — PDF extraction to markdown
- `backend/api/markdown_import.py` — markdown to engine payload (also extracts Salas comparison data)
- `backend/api/serialization.py` — payload ↔ engine object conversion
- `supabase/schema.sql` — database schema
- `frontend/src/main.tsx` — single-file React frontend

## Domain Glossary

See `CONTEXT.md` for canonical term definitions. Key terms:

- **Minimum tonnage** (`tons_min`) — continuous decimal before rounding to catalog size
- **Selected tonnage** (`selected_tons`) — catalog equipment size (1.5, 2.0, ... 5.0)
- **Test battery** — curated set of frozen project copies for model validation
- **Comparison snapshot** — precomputed VRC vs. Salas deltas stored per-project
- **Import fidelity** — validation that VRC inputs match Salas PDF extraction
- **Accuracy threshold** — BTU/hr margin within which a project is "accurate" (default 50)
- **Tolerance band** — % + BTU/hr floor for room conformance (default 5% + 200 BTU/hr)

## Current Work: Admin Panel

The next major feature is a model diagnostics panel at `/admin`. Full plan in `ADMIN_PANEL_PLAN.md`. UI prototype in `frontend/prototype-admin.html`.

### Implementation phases (work in order):

**Phase 1 — Schema migration.** Add columns to `calculations` table: `comparison_snapshot` (JSONB), `salas_reference_orientation` (TEXT), `import_fidelity_passed` (BOOLEAN), `import_fidelity_details` (JSONB), `parent_id` (BIGINT FK). See ADMIN_PANEL_PLAN.md §1.1 for exact SQL.

**Phase 2 — Backend changes.**
1. Fix `markdown_import.py` to parse `**House Facing:**` instead of hardcoding `front_door_faces: "S"`
2. Compute comparison snapshot at save time in `database.py` (run engine, diff against `salas_obrien_comparison`)
3. Compute import fidelity at save time (compare floor area, volume, orientation, room count)
4. Add `POST /api/calculate/batch` endpoint (array of payloads in, array of results out)
5. Add battery API: `GET/POST/DELETE /api/battery`, `POST /api/battery/{id}/refresh`, `GET /api/battery/eligible?search=`, `POST /api/battery/snapshot/export`

**Phase 3 — Frontend admin panel.**
1. Add `/admin` route
2. Two toggleable views: Table (sortable rows) and Status Columns (kanban by accuracy status)
3. Unit toggle (% vs BTU/hr) in top bar
4. Settings drawer with adjustable tolerance band and accuracy threshold — changes dynamically recompute all indicators client-side
5. Recompute All: calls batch endpoint, holds results in memory, shows change direction indicators (green/red/yellow per-metric)
6. Save Snapshots: writes recomputed values to DB
7. Export Snapshot: writes timestamped JSON to `snapshots/`
8. Add to Battery modal with search and multi-select
9. Per-card Remove from Battery action

**Phase 4 — Model development workflow.**
1. Create `MODEL_DEV.md` (local server runbook)
2. Create `model_changelog.md` (decision log for engine changes)
3. Set up `snapshots/` directory

**Phase 5 — Main editor integration.**
1. "Add to Test Battery" / "Refresh Battery Copy" button on saved Salas imports
2. Import fidelity badge display after import

### Key architectural decisions

- Test battery records are **frozen copies** in the same `calculations` table with `source = 'test_battery'` and `parent_id` linking to the original. Orientation locked to Salas reference. Eligibility enforced server-side.
- Comparison snapshots computed **at save time** — admin panel renders from stored data without re-running engine.
- Recompute runs via **single batch endpoint** to minimize Vercel function invocations.
- Tolerance/accuracy settings are **session-only** (React state), not persisted.
- Snapshot analysis is a **workflow** (feed JSON to Claude), not a built-in dashboard.

## Testing

- `tests/test_phase1_hickory_c.py` — reference fixture loading
- `tests/test_phase2_hickory_c.py` — room-level load and airflow accuracy
- `tests/test_phase3_api.py` — API endpoint tests
- `tests/test_phase3_5_editable_project.py` — editable project workflow
- Reference cases in `tests/reference_cases/`
- Example Salas PDFs in `Example resloads - Salas/`

## Environment

Requires `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `APP_PASSWORD` env vars. See `.env.example`.
