# VRC Admin Panel — Implementation Plan

## Overview

Build a model diagnostics and validation panel at `/admin` within the existing VRC app. The panel compares VRC engine output against Salas O'Brien reference calculations across a curated test battery, enabling model tuning with confidence.

Reference: `CONTEXT.md` for term definitions. `frontend/prototype-admin.html` for UI direction (Variants B and C).

---

## Phase 1: Schema & Data Layer

### 1.1 — Database migration

Add columns to `calculations` table:

```sql
-- Comparison snapshot (precomputed at save time)
ALTER TABLE calculations ADD COLUMN comparison_snapshot JSONB;

-- Salas reference orientation extracted from PDF
ALTER TABLE calculations ADD COLUMN salas_reference_orientation TEXT;

-- Import fidelity (computed at import time)
ALTER TABLE calculations ADD COLUMN import_fidelity_passed BOOLEAN;
ALTER TABLE calculations ADD COLUMN import_fidelity_details JSONB;

-- Test battery linkage
ALTER TABLE calculations ADD COLUMN parent_id BIGINT REFERENCES calculations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_calc_parent ON calculations(parent_id);
```

The `source` column already exists. Battery records use `source = 'test_battery'`.

### 1.2 — Comparison snapshot schema

The `comparison_snapshot` JSONB column stores:

```json
{
  "computed_at": "2026-06-06T14:30:00Z",
  "system": {
    "vrc_cooling_btuh": 25335,
    "salas_cooling_btuh": 25100,
    "vrc_heating_btuh": 28242,
    "salas_heating_btuh": 28500,
    "vrc_min_tons": 3.10,
    "salas_min_tons": 3.07
  },
  "rooms": [
    {
      "name": "Family",
      "vrc_cooling": 4111,
      "salas_cooling": 4050,
      "vrc_heating": 3983,
      "salas_heating": 4010
    }
  ]
}
```

### 1.3 — Import fidelity schema

The `import_fidelity_details` JSONB column stores:

```json
{
  "orientation_match": true,
  "salas_orientation": "S",
  "vrc_orientation": "S",
  "floor_area_match": true,
  "salas_floor_area": 2663,
  "vrc_floor_area": 2663,
  "volume_match": true,
  "salas_volume": 23237,
  "vrc_volume": 23237,
  "room_count_match": true,
  "salas_room_count": 19,
  "vrc_room_count": 19
}
```

---

## Phase 2: Backend Changes

### 2.1 — Fix orientation parsing in markdown_import.py

Currently `front_door_faces` is hardcoded to `"S"`. Change `import_room_cooling_markdown` to:

1. Parse `**House Facing:**` from the markdown text
2. Map the value to a compass direction
3. Set `front_door_faces` accordingly
4. Store the parsed value as `salas_reference_orientation` in comparison data

Remove the warning about defaulting to South for imports where facing is successfully parsed.

### 2.2 — Compute comparison snapshot at save time

Modify `create_project` and `update_project` in `database.py`:

1. Check if `metadata.salas_obrien_comparison` exists in the payload
2. If yes, run `calculate_project` on the payload
3. Diff VRC results against Salas reference values (system-level and per-room)
4. Write the diff to `comparison_snapshot` column
5. Compute and store import fidelity checks

### 2.3 — Compute import fidelity at save time

After import, compare:

- Total floor area: sum of VRC room areas vs. Salas reported floor area
- Total volume: sum of VRC room volumes vs. Salas reported volume
- Orientation: VRC `front_door_faces` vs. Salas `House Faces`
- Room count: number of VRC rooms vs. number of Salas rooms

Store result in `import_fidelity_passed` (boolean) and `import_fidelity_details` (JSONB).

### 2.4 — Batch calculate endpoint

New endpoint:

```
POST /api/calculate/batch
Body: { "projects": [ { "project": {...} }, { "project": {...} }, ... ] }
Response: { "results": [ { loads response }, { loads response }, ... ] }
```

Single serverless invocation, runs `calculate_project` sequentially for each payload. Keeps Vercel function invocations low and eliminates cold-start overhead for batch operations.

### 2.5 — Test battery API endpoints

```
GET    /api/battery                  — list all battery records
POST   /api/battery                  — create battery copy from source project
         Body: { "source_id": 123 }
         Logic: copy payload, lock orientation to Salas reference,
                verify eligibility, create record with source='test_battery'
DELETE /api/battery/{id}             — remove battery record
POST   /api/battery/{id}/refresh     — re-copy from parent, re-verify eligibility
GET    /api/battery/eligible         — list projects eligible for battery
         Filters: source='salas_import', has comparison data,
                  import fidelity passed, no existing battery copy
         Supports: ?search=query (searches plan/source filename,
                   builder_name, foundation, orientation/variation when present)
POST   /api/battery/snapshot/export  — write timestamped JSON to snapshots/
```

### 2.6 — Snapshot export

The export endpoint writes a JSON file to `snapshots/` in the project directory:

```
snapshots/
  2026-06-06T143000_after-wall-cltd-fix.json
```

File contains: timestamp, label (user-provided), engine version (git commit hash if available), and the full battery comparison results (system + room level for every battery member).

---

## Phase 3: Frontend — Admin Panel

### 3.1 — Route setup

Add `/admin` route to the React app. Same auth, same API base. Top-level layout distinct from the project editor.

### 3.2 — Top bar

Left side:
- Filter group: `Test Battery` (default) | `All Projects` | `Salas Imports`
- `Settings` button (toggles drawer)

Right side:
- View toggle: `Table` | `Columns` (segmented control)
- Unit toggle: `%` | `BTU/hr` (segmented control)
- `+ Add to Battery` button (opens modal)
- `Recompute All` button

### 3.3 — Settings drawer

Collapsed by default. Contains:

| Setting | Default | Type |
|---------|---------|------|
| Tolerance % | 5 | number input |
| Tolerance BTU/hr floor | 200 | number input |
| Accuracy threshold BTU/hr | 50 | number input |

All session-only (React state). Changes immediately recompute all derived indicators (accuracy status, room conformance, outlier counts) from the loaded snapshot data client-side.

### 3.4 — Table view (Variant B)

Sortable columns:
- Status (accuracy dot: green/grey/red)
- Plan name
- Foundation type
- Square footage
- Cooling Δ (% or BTU/hr based on unit toggle)
- Heating Δ (% or BTU/hr based on unit toggle)
- Min Tons Δ (always decimal)
- Rooms (conformance badge: green "OK" or amber with outlier count)
- Inputs (fidelity badge: green checkmark or amber warning)
- Change (direction indicator, only after recompute: Improved/Regressed/No change)

Click a row to expand inline room-detail table (same as card expansion).

### 3.5 — Status columns view (Variant C)

Three columns:
- **Accurate** (green) — system delta within accuracy threshold
- **Needs Review** (yellow) — outside threshold but no regression detected
- **Regressed** (red) — only after recompute, when delta moved further from Salas

Each card shows: plan name, foundation, square footage, room conformance badge, and the three metrics (cooling/heating/min tons) with per-metric change indicators after recompute.

### 3.6 — Recompute flow

1. User clicks `Recompute All`
2. Frontend fetches full payloads for all battery records
3. Calls `POST /api/calculate/batch` with all payloads
4. Stores fresh results in React state (not database)
5. Overlays fresh results on cards alongside stored snapshots
6. Shows recompute banner: "Recomputed at {time} — {n} improved, {n} regressed, {n} unchanged"
7. Banner includes `Save Snapshots` and `Export Snapshot` buttons

**Traffic light logic after recompute (per-metric):**
- Green ("Improved"): absolute delta moved closer to Salas reference
- Red ("Regressed"): absolute delta moved further from Salas reference
- Yellow ("No change"): change within 0.1% epsilon

**Accuracy status logic (always visible):**
- Green: system delta within accuracy threshold — regardless of change direction
- Grey: outside accuracy threshold

### 3.7 — Add to Battery modal

- Search box: free-text, filters across plan_name, description, builder_name, foundation, location
- Multi-select list of eligible projects (from `GET /api/battery/eligible?search=...`)
- Each item shows: full plan/source filename when available, builder, foundation, square footage
- "Add Selected (n)" button: calls `POST /api/battery` for each selected project
- Eligibility is enforced server-side: Salas data present, import fidelity passed, orientation matchable

### 3.7.1 — Source identity and duplicate replacement

- Admin labels prefer `project.metadata.source_filename`; fallback labels rebuild the structured name from `plan_name`, `elevation`, `foundation`, `orientation`, and `variations`.
- Bulk import and backend import replacement use full structured plan identity (`plan_name + foundation + elevation + orientation + variations`) instead of only plan/foundation/elevation. This prevents orientation or option variants from overwriting each other during large batch imports.
- Detail-report exports use the same display identity so each variance row can be traced back to the original Salas PDF.

### 3.8 — Per-card/row actions

- **Remove from Battery**: trash icon with confirmation dialog. Calls `DELETE /api/battery/{id}`.
- **Expand/collapse**: click to show per-room comparison table.
- Room-detail table columns: Room name, VRC Cool, Salas Cool, Δ Cool, VRC Heat, Salas Heat, Δ Heat, Status dot.
- Outlier rooms highlighted with red background row.

---

## Phase 4: Model Development Workflow

### 4.1 — MODEL_DEV.md

Create at project root. Contents:

1. **Quick start**: exact commands to run local server (`uvicorn`, frontend dev server)
2. **Making an engine change**: which files to edit (`backend/engine/constants.py`, `formulas.py`, `calculator.py`)
3. **Testing a change**: open `localhost:PORT/admin`, click Recompute All, interpret results
4. **Saving results**: Save Snapshots (updates DB), Export Snapshot (writes JSON to `snapshots/`)
5. **Pushing to production**: commit, push to main, verify on production `/admin`
6. **Rolling back**: revert commit, redeploy, recompute to verify

### 4.2 — model_changelog.md

Create at project root. Format:

```markdown
## 2026-06-06 — Adjusted wall CLTD values

**Changed:** `WALL_CLTD_BY_DIRECTION["N"]` from 13 to 12

**Reason:** Consistent +2% cooling bias on north-facing walls across 8 test battery projects.

**Result:** Cooling delta improved on 6/8 affected projects. No regressions. Snapshot: `snapshots/2026-06-06T143000.json`
```

### 4.3 — snapshots/ directory

Add to `.gitignore` exception (tracked in git). Each file is a timestamped JSON containing the full battery state at that point.

---

## Phase 5: Integration into Main Editor

### 5.1 — Battery controls on project editor

When viewing a saved project with `source = 'salas_import'`:
- If eligible and no battery copy exists: show "Add to Test Battery" button
- If battery copy exists: show "Refresh Battery Copy" button
- Both trigger the battery API endpoints

### 5.2 — Import fidelity display

After importing a Salas PDF and saving, show fidelity status in the project editor:
- Green badge if all checks pass
- Amber badge with detail on hover if any check fails (which values mismatched)

---

## Implementation Order

| Step | Description | Dependencies |
|------|-------------|-------------|
| 1 | Schema migration (1.1) | None |
| 2 | Fix orientation parsing (2.1) | None |
| 3 | Import fidelity computation (2.3) | Schema migration |
| 4 | Comparison snapshot computation (2.2) | Schema migration |
| 5 | Battery API endpoints (2.5) | Schema migration |
| 6 | Batch calculate endpoint (2.4) | None |
| 7 | Admin panel — table view (3.1–3.4) | Steps 1–6 |
| 8 | Admin panel — status columns view (3.5) | Step 7 |
| 9 | Admin panel — recompute flow (3.6) | Steps 6–8 |
| 10 | Admin panel — battery management (3.7–3.8) | Step 5, 7 |
| 11 | Settings drawer with dynamic thresholds (3.3) | Step 7 |
| 12 | Snapshot export (2.6) | Step 9 |
| 13 | Main editor integration (5.1–5.2) | Steps 3–5 |
| 14 | MODEL_DEV.md and changelog (4.1–4.3) | None |

Steps 1–6 are backend-only and can be developed and tested independently. Steps 7–13 are frontend work that builds on the backend. Step 14 can happen anytime.
