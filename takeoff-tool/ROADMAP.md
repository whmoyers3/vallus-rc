# Baseline Takeoff Tool Roadmap

## Roadmap Status

This roadmap captures the product/design decisions developed in planning sessions. It is intended for future Baseline development sessions and should be updated as implementation decisions become real code.

## Delivery Strategy

Build the takeoff tool as a tab/route/module inside the existing Baseline web app first. Use GitHub branches and Vercel preview deployments as the preferred verification environment.

Localhost may be used for quick developer checks, but the planned workflow should not require the user to start and stop local servers. Each meaningful implementation phase should end with:

- local build/tests when practical
- push to GitHub
- Vercel preview deployment
- verification on the hosted preview URL
- merge/promote only after the hosted preview is accurate and workable

Early takeoff work should be feature-gated or isolated behind a route/tab so unfinished workflows do not disrupt the current production load calculation tool.

## Phase 0 - Contract And Prototype Spike

Goal: prove the data path before building the full editor.

Deliverables:

- Define `takeoff_json` schema version `v1`.
- Define geometry-to-payload mapping.
- Define Markdown export mapping compatible with `backend/api/markdown_import.py`.
- Create a hand-written takeoff JSON fixture.
- Generate a Baseline payload from that fixture.
- Generate Markdown from that fixture.
- Verify generated payload can be calculated.
- Verify generated Markdown can import back into Baseline.
- Add a feature-gated or isolated takeoff route/tab shell suitable for Vercel preview verification.

Acceptance criteria:

- Payload runs through the existing calculation endpoint.
- Markdown imports through `/api/import/room-cooling-markdown`.
- Round trip preserves room area, volume, assemblies, directions, windows, and doors.
- A Vercel preview deployment can be used to open and inspect the takeoff shell.

## Phase 1 - Single-Floor Manual Takeoff MVP

Goal: one floor, one PDF page, room partitioning, no advanced ceiling complexity.

Deliverables:

- PDF/page upload or selection.
- Page rendering.
- Scale calibration by two clicked points.
- Blank grid/manual drafting mode with configurable scale and snap increments.
- North/front orientation setup.
- Conditioned perimeter tracing.
- Lockable perimeter.
- Non-overlapping room creation using polygon and rectangle tools.
- Add/subtract room shape operations that preserve non-overlap.
- Highlight unassigned floor area.
- Save/reopen takeoff JSON from Supabase.
- Generate calculation payload and Markdown.

Acceptance criteria:

- Sum of room areas equals conditioned footprint within tolerance.
- User cannot create overlapping rooms.
- Saved takeoff can be reopened and edited.
- Generated project links to a Baseline calculation record.
- Grid/manual mode can create the same perimeter and room partition data without a PDF background.

## Phase 1.5 - Room Profiles And Basic Load Surfaces

Goal: make drawn rooms editable after creation and capture the first room-level load-surface choices before exterior component placement.

Deliverables:

- Select a room from the plan or room list.
- Edit a room name after creation.
- Edit ceiling height after room creation.
- Add multiple per-room floor component rows with assembly code, area, and label.
- Add multiple per-room ceiling component rows with assembly code, area, and label.
- Check floor and ceiling component area totals against measured room area.
- Persist room profile settings in editable takeoff JSON.
- Reflect room component settings in the generated payload preview with `C1`, `C2`, `C3`, `F1`, and `F2` line items.

Acceptance criteria:

- Room profile edits survive save/reopen.
- Changing room height updates room volume in the payload preview.
- Rooms can split floor or ceiling area across multiple component rows.
- Floor and ceiling component totals show open or over-assigned area against measured geometry.
- Simple partial floor/ceiling cases work until full boundary overlays arrive.

## Phase 1.6 - Component Schedule And Library

Goal: define the project-level component schedule before geometry-driven exterior components are placed.

Deliverables:

- Top-level Component Schedule control.
- Search existing library components.
- Add library components to the takeoff project schedule.
- Create one-off project-only components.
- Save new reusable components to the shared library.
- Persist the project component schedule in editable takeoff JSON.
- Let room component rows select from the project schedule.

Acceptance criteria:

- Schedule edits survive save/reopen.
- Saved library components are available in future takeoffs.
- Project payload preview uses scheduled U-values, SHGC values, and descriptions.
- One-off components can be used without saving to the shared library.

## Phase 2 - Exterior Walls, Windows, And Doors

Goal: produce useful room load components, not just floor areas.

Deliverables:

- Exterior perimeter segment detection.
- Segment orientation from north/front reference.
- Assign exterior wall segments to rooms.
- Window schedule panel for predefined and custom glass.
- Manual room-profile fallback for wall, window, and door rows before click-to-place is complete.
- Click-to-place windows on exterior conditioned walls.
- Door schedule panel for exterior, garage, and custom doors.
- Prevent ordinary windows in garage/exterior spaces.
- Generate `W1`, `G1/G2/G3`, `D1`, and `D2` line items.

Acceptance criteria:

- Rooms export directional exterior wall components.
- Windows export directional glass components.
- Doors export opaque door components.
- Garage-adjacent walls export garage-treated wall components.

## Phase 3 - Boundary Overlays

Goal: support garage, attic, crawlspace, slab, and partial floor/ceiling exposure.

Deliverables:

- Exterior/unconditioned overlay polygons for garage, porch/outdoor, and attic-adjacent spaces.
- Height/profile metadata for adjacent spaces, including covered porch roof/ceiling primitives.
- Vertical overlays for slab, crawlspace below, garage below, conditioned above, attic above, open-to-below, and cantilever/outdoor below.
- Partial-area overlays for ceiling and floor components.
- Boundary-candidate validation for partial horizontal/vertical wall slices.
- Validation panel for missing or conflicting boundary conditions.

Acceptance criteria:

- Foyer-style partial ceiling case is supported.
- Covered porch roof/ceiling conditions can flag partial attic/knee-wall exposure on an exterior wall.
- Second-floor room over garage exports `F1 garage floor`.
- Slab ranch can be finished quickly with global defaults.

## Phase 4 - Ceiling Height And 3D Room Preview

Goal: answer height/vault/kneewall questions with visual feedback.

Deliverables:

- Global floor default ceiling height.
- Per-room height override.
- Ceiling profile wizard for flat, taller flat, vaulted, gable, kneewall, and partial conditioned-above cases.
- Lightweight Three.js room preview.
- 3D adjacent-space preview for porch/garage/attic volumes that can explain generated boundary candidates.
- Generated wall/ceiling/volume changes from the ceiling profile.

Acceptance criteria:

- Height changes update room volume.
- User can see which surfaces are being added.
- Vaulted and kneewall choices generate explainable line items.

## Phase 5 - Multi-Floor Alignment

Goal: model full houses across PDF pages/floors.

Deliverables:

- Multiple floors per takeoff project.
- One PDF/page/background per floor.
- Floor-level scale/orientation inheritance and override.
- Floor alignment using reference points.
- Ghost overlay upper/lower floors.
- Cross-floor vertical relationship assignment.
- Cross-floor validation.
- Shared boundary-candidate rules for floor-over-garage, cantilever, exterior-below, and conditioned-above overlaps.

Acceptance criteria:

- Two-story plan can be modeled in one file.
- First-floor rooms can receive partial conditioned-above vs ceiling-load areas.
- Second-floor rooms can receive floor-over-garage/cantilever conditions.

## Phase 6 - Systems, Zones, And Thermostats

Goal: support real HVAC zoning across floors.

Deliverables:

- Unit/system assignment mode.
- Zone assignment mode.
- Multi-select rooms across floors.
- Thermostat marker placement.
- Room assignment validation.
- Export `unit_id` and `zone_id`.

Acceptance criteria:

- A system can serve rooms across multiple floors.
- A split system such as left-side downstairs plus left-side upstairs can be modeled.
- Existing airflow/export tooling can consume the generated unit/zone assignments.

## Phase 7 - Production Polish

Goal: make the tool reliable enough for repeated internal use.

Deliverables:

- Undo/redo history.
- Autosave.
- Schema migrations for takeoff JSON.
- Import/export takeoff JSON.
- Improved snapping.
- Pre-export QA report.
- Regression fixtures from known Salas examples.
- Performance tuning for larger plans.

Acceptance criteria:

- Takeoffs survive reloads and schema upgrades.
- Known reference plans generate stable payloads.
- Validation catches missing/unassigned geometry before calculation.

## MVP Boundary

The first useful MVP is Phases 0 through 2 plus basic save/reopen. Defer automatic recognition, CAD import, and advanced vertical inference until the manual workflow proves the data model.

## Open Product Questions

- Should generated wall components be exported as many segment rows or as aggregate rows per room/orientation/boundary?
- What exact tolerance should determine "unassigned sliver" warnings?
- Should garage-adjacent doors default to `D2` or prompt every time?
- How much of the 3D ceiling preview must be editable versus explanatory?
- Should takeoff projects be listed in the same saved-project list or a filtered takeoff tab?
- Should the takeoff preview route be hidden behind a URL hash, an admin-only toggle, or a database/user feature flag during early development?
- What default grid increments should be offered: 1 ft, 6 in, 3 in, and custom?
