# 0006 — 3D as the primary envelope-authoring workspace; 2D plan as geometry authoring; one world-feet model

**Status:** Accepted (2026-06-23)

## Context

A single-floor Three.js view was built as a QA aid (ADR 0004 update). In use it became
clear that envelope work — placing windows and doors, tagging the space beyond a wall,
shaping ceilings — is spatial reasoning that people do as if standing in the building, and
that users will gravitate to the 3D view as the primary place to author the envelope as
soon as it is editable. This reframes 3D from a downstream QA render into a primary
authoring surface.

The risk is a forked model: once 3D is editable, it is tempting to manipulate geometry in
3D that the 2D plan cannot express, producing two sources of truth that drift. Geometry
authoring (footprint, room partition, calibration, alignment) is also genuinely better in
top-down 2D — drawing a footprint in perspective is worse, not better.

## Decision

**1. Division of labor.**
- **2D plan surface** authors *geometry*: footprint/perimeter, room partition (boolean
  slicing), scale calibration, floor alignment. Room geometry is created/edited only here.
- **3D authoring workspace** authors the *envelope*: windows, doors, boundary tags,
  ceiling profiles, and vertical data.

**2. Single source of truth.** The 2D plan polygons, in world feet, are the only geometric
truth. 3D edits write back as component/height *data* on existing room/opening records and
never create independent geometry. No edit may exist in 3D that the 2D model cannot
represent. (One model, two views.)

**3. Openings are dual-authored.** A window/door is one record (host wall/direction,
horizontal placement along the wall, explicit `sillHeight`/`headHeight`). A 2D wall click
sets host wall + horizontal placement + a *default* sill/head height. A 3D drag refines the
sill height and nudges horizontal position, **constrained to the host wall** — moving to a
different wall is a re-place, not a drag. This requires adding `sillHeight`/`headHeight` to
the opening schema and retires the current `3 + height/2` vertical heuristic in
`openingMeshForComponent`.

**4. Sequencing is unchanged; justification hardens.** The single-story round trip
(Langford B-C-D-E-F Slab — single level, slab, flat ceiling) still comes first (it proves
the payload contract and is independent of UI surface). The ADR 0004
feet-canonical refactor is **promoted from "soon" to a hard prerequisite** for 3D-primary:
a QA view tolerates pixel-derived scale, but an editing surface must be metrically truthful
(a 3-ft sill on a mis-scaled wall is a lie). Only after the feet/elevation refactor does
3D-primary editing get built.

## Consequences

- **Picking with write-back.** 3D needs raycaster picking that maps a click to (room, wall,
  edge, height) and mutates the 2D-owned state. The existing `userData.roomId` on opening
  groups is the seed.
- **Vertical schema growth.** Openings gain explicit sill/head heights; ceiling profiles
  already carry height data.
- **Incremental rendering.** The current full dispose-and-rebuild of the scene in one
  `useEffect` is correct for QA but too slow for interactive editing; static (floor/walls)
  and dynamic (item being dragged) meshes must be separated, or updates made incremental.
- **Modularization.** The ~4,800-line single `TakeoffApp.tsx` becomes untenable for an
  editor; the README's `three/ canvas/ panels/ geometry/` split becomes necessary.
- **Synergy with ADR 0005.** Pointing at a wall in 3D and tagging what lies beyond it is the
  natural UI for setting the structured `boundary` field.

## Alternatives considered

- **3D as QA-only (status quo).** Rejected: forgoes the authoring flow users will reach for.
- **3D owns geometry too (slice rooms in 3D).** Rejected: top-down is strictly better for
  footprint/partition; perspective geometry authoring is harder and invites the forked model.
- **3D owns openings exclusively.** Rejected in favor of dual-authoring: 2D placement with
  defaults plus 3D vertical refinement is faster and keeps one opening record.
