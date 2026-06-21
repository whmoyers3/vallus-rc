# VRC Takeoff Tool - Agent Instructions

## Mission

Build a web-based plan takeoff authoring tool for VRC. The tool lets users upload or reference a plan PDF page, trace conditioned space, partition it into non-overlapping rooms, place windows and doors, assign boundary conditions, and generate the exact room/component inputs expected by the existing VRC load calculation engine and Markdown importer.

This is not a general CAD system. The plan image is a tracing background; the editable takeoff JSON is the geometry source of truth; the generated VRC payload and Markdown are the calculation/export products.

## Repository Placement

This folder is intentionally nested inside the existing VRC project because the takeoff tool must share:

- the VRC engine payload contract in `backend/engine/models.py`
- the payload serializer in `backend/api/serialization.py`
- the Markdown import/export expectations in `backend/api/markdown_import.py`
- the assembly catalog and CLTD/SHGC conventions in `backend/engine/constants.py`
- Supabase project storage in `backend/api/database.py` and `supabase/schema.sql`
- the frontend project shell in `frontend/src/main.tsx`

Do not split this into a separate repository until the API contracts are stable and the user explicitly asks to do so.

## Development And Verification Preference

The preferred verification workflow for this tool is GitHub branch -> Vercel preview deployment -> browser verification on the live preview URL. Localhost is useful for quick developer checks, but it should not be assumed as the primary user validation path because the user prefers hosted preview verification over starting and stopping local servers.

When building takeoff features:

1. Keep changes in the existing app as a route/tab/module unless the user asks for a separate deployed app.
2. Run local build/tests when practical to catch obvious breakage before pushing.
3. Push to GitHub so Vercel creates a preview deployment.
4. Verify behavior on the Vercel preview URL.
5. Promote/merge only after the preview is accurate and workable.

The production VRC site should not receive unfinished takeoff work directly. Use preview deployments or feature-gated routes/tabs for early validation.

## Core Product Rules

1. Rooms on the same floor must never overlap. Treat rooms as a partition of the locked conditioned footprint.
2. The conditioned floor perimeter is the exterior-wall reference. Interior room lines are only attribution boundaries.
3. Interior walls do not create load components unless they become an explicit boundary condition such as garage, attic/kneewall, or partition.
4. Windows snap only to conditioned exterior perimeter segments. Do not allow ordinary windows in garage/exterior space.
5. Doors use the same placement workflow as windows but export as opaque `D1`/`D2` components or a custom door assembly.
6. Garage-adjacent conditioned walls receive garage load treatment.
7. Floor and ceiling exposure can be partial by room. Do not assume every room has full ceiling load or full floor load.
8. Multiple floors belong in one takeoff project when one load calculation/system design spans them.
9. Units and zones are assignments across rooms, not necessarily floors. A system may serve rooms on multiple levels.
10. Preserve editable takeoff JSON separately from generated load payloads.
11. Provide a grid/manual drafting fallback for skewed, low-quality, or unreliable plan pages. In this mode the user can draw on a blank scaled grid, optionally place the plan image/PDF as a visual reference, and snap geometry to entered dimensions/grid increments.

## Canonical Data Flow

```text
PDF/page image
  -> visual tracing background only

takeoff_json
  -> editable geometry, pages, floors, rooms, openings, overlays, validation state

generated payload_json
  -> VRC calculation input, stored in calculations.payload_json

generated Markdown
  -> import/export bridge compatible with the current Markdown importer
```

## Storage Direction

Preferred Supabase model:

```text
calculations
  id
  payload_json
  existing VRC fields

takeoff_projects
  id
  calculation_id references calculations(id)
  name
  takeoff_json jsonb not null
  generated_payload_json jsonb
  generated_markdown text
  schema_version text
  created_at
  updated_at

Supabase Storage
  plan PDFs and rendered page images
```

Avoid storing large PDF binaries inside `payload_json` or `takeoff_json`. Store file references/URLs instead.

## Takeoff JSON Principles

The JSON should preserve enough information to reopen and edit a project without retracing:

- project metadata and schema version
- plan pages, PDF storage refs, page dimensions, render scale
- floor definitions and calibrated scale
- north/front orientation
- conditioned perimeter polygons
- non-overlapping room polygons
- openings with wall attachment, size, assembly, and orientation
- exterior/unconditioned overlays such as garage or attic-adjacent spaces
- vertical overlays such as slab, crawlspace, garage below, conditioned above, attic above, open-to-below
- ceiling profiles including flat, taller flat, vaulted, gable, and kneewall cases
- unit/zone/thermostat assignments
- validation results and unresolved issues
- drafting mode: PDF/page trace, image trace, or blank grid/manual

## Generated VRC Payload Rules

Generated payloads should use the existing VRC model:

- rooms: `name`, `floor_area`, `ceiling_height`, `volume`, `lighting_area`, `unit_id`, `zone_id`
- line items:
  - `W1` directional exterior walls
  - undirected/name-tagged `W1 garage wall` for garage-adjacent walls where current engine behavior expects it
  - `W3` attic/kneewall walls
  - `C1` flat ceiling and `C2` vaulted ceiling
  - `F1` framed/garage/cantilever floors and `F2` slab
  - `G1/G2/G3` glass with direction
  - `D1/D2` doors as opaque components

Use explicit `cooling_cltd`, `heating_delta_t`, or `heating_area` for unusual boundary conditions where the generated item name alone is too fragile.

## Development Guardrails

- Keep the load calculation engine independent of drawing geometry.
- Keep geometry logic testable outside React.
- Prefer exact geometry libraries for polygon operations once implementation starts.
- Validate before export: no room overlaps, no unassigned conditioned floor area, no openings off valid wall segments, and no missing unit/zone assignments.
- Preserve round-trip tests: generated Markdown should import back through `backend/api/markdown_import.py`.
- Follow existing frontend design conventions; do not build a marketing page.
- Grid/manual drafting mode must produce the same takeoff JSON and generated payload as PDF tracing. It is a different authoring surface, not a different calculation path.

## First Files To Read In Future Sessions

1. `takeoff-tool/AGENTS.md`
2. `takeoff-tool/README.md`
3. `takeoff-tool/ROADMAP.md`
4. `takeoff-tool/DEPLOYMENT.md`
5. `takeoff-tool/CHANGELOG.md`
6. `CLAUDE.md`
7. `CONTEXT.md`
8. `backend/api/markdown_import.py`
9. `backend/engine/calculator.py`
10. `backend/api/serialization.py`
11. `supabase/schema.sql`
