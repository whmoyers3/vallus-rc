# VRC Model Development Workflow

This document defines the end-to-end process for proposing, testing, implementing, and deploying changes to the VRC calculation engine. It is written for both human developers and Claude sessions (Cowork and Claude Code) to follow.

## Overview

The VRC engine mirrors Salas O'Brien's HVAC load calculations. Model changes — new formulas, corrected constants, added fields — must be validated against the test battery before going live. The workflow moves through four environments:

| Environment | Purpose | Tool |
|---|---|---|
| Admin panel (production) | Identify model gaps via snapshot review | Browser → `yourapp.vercel.app/admin` |
| Cowork | Design the fix — explore tradeoffs, define approach | Claude Cowork session |
| Localhost | Implement and validate the fix | Claude Code + admin panel on `localhost:5173/admin` |
| Production | Deploy the validated change | Git push → Vercel |

## Phase 1: Identify the Problem

**Where:** Production admin panel (`/admin`)

1. Open the admin panel in your browser.
2. Review the test battery dashboard. Look for:
   - **System-level patterns** — Are heating or cooling loads consistently high or low across multiple projects? A systematic bias points to a formula or constant issue.
   - **Room-level outliers** — Do individual rooms fail the conformance check (default: exceeds both 5% and 200 BTU/hr) even when the system total looks close? This suggests a per-room calculation error masked by cancelling differences.
   - **Import fidelity failures** — Are any test battery records flagged for input mismatches (floor area, volume, orientation, room count)? Fix these before drawing conclusions about engine accuracy.
3. Export a snapshot (`snapshots/` directory) to capture the current state before making changes.

**Output of this phase:** A clear description of the problem — which metric is off, by how much, across which project types, and a hypothesis about the cause.

## Phase 2: Design the Change

**Where:** Claude Cowork

Open a Cowork session and share your findings. Useful starting points:

- *"Here's a snapshot showing heating loads running 15% high across slab foundations. I think we're double-counting infiltration. Help me think through the fix."*
- *"We're missing solar heat gain on west-facing glass. I want to add SHGC as a calculation input. Walk me through the implications."*
- *"I want to add a new field to the model. Grill me on whether it belongs at the room level or the line-item level."*

Use `/grill-me` or `/grill-with-docs` to stress-test the design against the existing domain model and glossary (`CONTEXT.md`).

**What to resolve before moving to implementation:**

- What specifically changes in the engine (formulas, constants, data model)?
- Does this require a schema migration (new fields in `calculations` table)?
- Does this affect how Salas PDF data is imported (`salas_pdf_import.py`, `markdown_import.py`)?
- What does "correct" look like — which test battery projects should improve, and by roughly how much?
- Are there projects that might regress, and is that acceptable?

**Output of this phase:** A concrete plan — what to change, where, and what the expected impact is. If the Cowork session produces an implementation plan or updated CONTEXT.md entries, those carry directly into the next phase.

## Phase 3: Implement the Change

**Where:** Claude Code (localhost)

### 3a. Set up the local environment

```bash
# Start the backend
cd backend
uvicorn api.app:create_app --reload --port 8000

# Start the frontend (separate terminal)
cd frontend
npm run dev
```

Confirm `localhost:5173` loads the app and `localhost:5173/admin` loads the admin panel.

### 3b. Make the engine change

Open the project folder in Claude Code. Reference the plan from Phase 2:

- *"Implement the thermal mass correction from my Cowork session. The plan is in the conversation history / ADMIN_PANEL_PLAN.md."*
- *"Add the SHGC field to the Room dataclass and update cooling_component_load in formulas.py to use it."*

Key files you'll typically touch:

| File | Contains |
|---|---|
| `backend/engine/models.py` | Dataclasses: Project, Level, Room, LineItem, Assembly, etc. |
| `backend/engine/formulas.py` | Individual load formulas (glass, wall, roof, infiltration) |
| `backend/engine/calculator.py` | Orchestration: calculate_project, calculate_level, calculate_line_item |
| `backend/engine/constants.py` | Lookup tables: CLTD values, safety factors, SCLEFF, ton sizes |
| `backend/api/markdown_import.py` | Salas comparison data extraction |
| `backend/api/salas_pdf_import.py` | PDF parsing and field extraction |
| `supabase/schema.sql` | Database schema (if adding fields) |

### 3c. Validate on localhost

1. Open `localhost:5173/admin` in your browser.
2. Click **Recompute All**. This batch-runs every test battery record through your modified engine. Results are held in browser memory only — nothing is saved yet.
3. Read the traffic lights:
   - **Green** — metric improved (moved closer to Salas reference)
   - **Red** — metric regressed (moved further from Salas reference)
   - **Yellow** — no meaningful change (within accuracy threshold)
   - **Green (default, pre-recompute)** — already within accuracy threshold
4. Check room-level conformance. Expand individual projects to see if room outliers changed.
5. Adjust the tolerance band and accuracy threshold in the settings drawer if needed to understand edge cases.

### 3d. Iterate

If results aren't what you expected:

- Go back to Claude Code and refine the implementation.
- Recompute again on `/admin`. Each recompute is a fresh run — no stale state.
- If the design itself needs rethinking, go back to Cowork (Phase 2).

### 3e. Save and record

Once satisfied:

1. Click **Save** in the admin panel to persist the new comparison snapshots to Supabase.
2. Export a snapshot to `snapshots/` — this creates a timestamped JSON file for the git history.
3. Update `model_changelog.md` in the project root with a brief entry:

```markdown
## YYYY-MM-DD — [Short description]

**Problem:** [What the snapshot data showed]
**Change:** [What was modified in the engine]
**Impact:** [Summary — e.g., "Heating loads improved by ~8% across slab projects. Two projects regressed slightly (within 2%). No room conformance changes."]
**Snapshot:** snapshots/YYYY-MM-DD_description.json
```

### 3f. Run tests

```bash
cd backend
python -m pytest tests/
```

Ensure existing reference case tests still pass. If the engine change intentionally shifts expected values, update the test fixtures with justification.

## Phase 4: Deploy

**Where:** Git → Vercel

1. Commit all changes: engine files, schema migration (if any), updated snapshot, changelog entry, test fixtures.
2. Push to a feature branch. Vercel will create a preview deployment.
3. Open the preview deployment's `/admin` and do a final recompute against the live Supabase data to confirm results match what you saw on localhost.
4. Merge to main. Vercel deploys to production.
5. Open production `/admin` and verify the new snapshots are live.

## Known Model Assumptions (revisit if accuracy drifts)

These are deliberate simplifications backed by limited samples. If a new resload disagrees, this is the first place to look.

| Assumption | Where | Confirmed on | Revisit when / switch to |
|---|---|---|---|
| **Vaulted ceiling CLTD = 78** (= flat 55 × √2, a fixed 45° roof-slope factor). Salas's schedule *displays* 55 for vaulted but computes with ~78; importer skips populating C2 CLTD from the schedule. | `constants.py` `SPECIAL_CLTD["VAULTED_CEILING"]`; skip in `markdown_import.py` | Finley, Williams (both exactly 77.8) | A resload whose **effective vaulted CLTD ≠ 78** (ratio-to-55 ≠ √2 ≈ 1.414) → roof pitch isn't 45°. **Switch to Option B:** apply a per-project sloped-area factor to vaulted area instead of a fixed CLTD. |
| **Glass conduction CLTD = 14** (3–4 PM peak) | `constants.py` `GLASS_CLTD` | Finley, Tranquility + ASHRAE HoF | Out-of-region (non-north-GA) latitude. |
| **SHGF table = north-GA latitude only** | `SCLEFF_BY_DIRECTION` | lat ~34°N | Onboarding a second latitude → source ASHRAE SCL/SHGF for it. |
| **Townhouse glass = combined direct table** (not SHGF formula) | `TOWNHOUSE_GLASS_LOAD_FACTORS` | Evergreen TH (9/10; NE corrected) | More townhome resloads to re-confirm NE=21 and the rest. |
| **Imported room area/volume overrides component-area inference** | `salas_pdf_import.py` emits room `Floor Area` / `Volume`; `markdown_import.py` consumes them | Mansfield UBsmt, Tranquility UBsmt SW-Facing | Any import fidelity area/volume mismatch, especially basement or garage-adjacent rooms. Fix import fidelity before tuning engine formulas. |

## Quick Reference: Which Tool When

| I want to... | Use |
|---|---|
| Review model accuracy across all test projects | Production admin panel (`/admin`) |
| Understand *why* something is off and design a fix | Cowork session |
| Stress-test a design decision | Cowork → `/grill-me` or `/grill-with-docs` |
| Implement the fix in code | Claude Code (localhost) |
| See the impact of my code change before saving | Localhost admin panel → Recompute All |
| Record what changed and why | `model_changelog.md` + snapshot export |
| Analyze snapshot trends over time | Cowork session with snapshot JSON attached |
| Deploy the validated change | Git push → Vercel |

## For Claude Sessions

When a user opens a model development conversation, check for:

1. **In Cowork:** The user is likely in Phase 1 or 2. Help them analyze snapshot data, identify patterns, and design the engine change. Reference `CONTEXT.md` for domain terminology. Do not write engine code directly — produce a plan for Claude Code to execute.

2. **In Claude Code:** The user is in Phase 3. They should have a plan (from Cowork, from conversation, or described verbally). Implement it, run tests, and remind them to recompute on the admin panel and update `model_changelog.md`.
