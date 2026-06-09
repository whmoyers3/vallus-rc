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
- `backend/api/airflow_export.py` — builds the field airflow balancing spreadsheet (.xlsx) from a calculated draft; served by `POST /api/export/airflow`
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

## Admin Panel — Implemented

Model diagnostics panel at `/admin`. Full plan in `ADMIN_PANEL_PLAN.md`. All five phases are complete.

- **Schema:** `calculations` table has `comparison_snapshot`, `salas_reference_orientation`, `import_fidelity_passed`, `import_fidelity_details`, `parent_id` columns. See `supabase/schema.sql`.
- **Backend:** batch calculate endpoint, full battery CRUD + refresh + snapshot export, import fidelity + comparison snapshot computed at save time, `**House Facing:**` parsing fixed.
- **Admin panel:** `/admin` route, table + kanban views, unit toggle, settings drawer, Recompute All, Save Snapshots, Export Snapshot, Add to Battery modal, Remove from Battery.
- **Workflow:** `MODEL_DEV.md`, `model_changelog.md`, `snapshots/` directory all present.
- **Editor integration:** battery buttons (+ Battery / ↻ Battery) and import fidelity badge in main toolbar.

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
