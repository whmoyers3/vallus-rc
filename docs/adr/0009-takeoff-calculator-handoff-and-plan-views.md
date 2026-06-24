# 0009 — Takeoff↔calculator: generate-forward writes, read-only plan views (linked geometry or payload-synthesized schematic)

**Status:** Accepted (2026-06-23)

## Context

The takeoff tool authors geometry and generates a calculator payload; the calculator owns
load analysis, orientation, room-by-room refinement, save, airflow export, and the PDF
report. Two questions arose: how should the Calculate button relate the two tools, and can
the calculator show a plan rendering — including for the many existing plans that have a
`calculations` record but no takeoff.

Key technical fact: **the calculator payload is a lossy flattening of the takeoff.**
`buildVrcPayload` converts room polygons into per-room, per-direction *areas* (wall, glass,
door) plus floor area, volume, and ceiling height. The polygons, point coordinates,
openings, adjacency, and aligned layout exist **only** in the takeoff JSON and cannot be
reconstructed from the payload. Therefore geometry cannot "sync back" from the calculator —
there is nothing to sync from.

## Decision

**1. Writes are generate-forward only.** The takeoff owns geometry; the calculator owns
load-level refinements (orientation choice, CFM overrides, equipment, zone assignment, room
merges). The Calculate/handoff is a one-way *generate* into a linked `calculations` record
(linked by `calculation_id`). Re-generating from the takeoff **warns** and replaces the
generated content while preserving calculator-only fields where keys still match (consistent
with ADR 0001's "never silently overwrite; surface the conflict"). No geometry write-sync.

**2. Two surfaces, distinct roles.** The takeoff keeps a lightweight in-place **worst-case
preview** (the Calculate banner) for authoring feedback. A separate **"Open in Calculator"**
hands the payload to the calculator as a draft (via the existing `localStorage`+route
handoff pattern used by the airflow wizard), where refinement/output already live. The
calculator does **not** duplicate the takeoff's geometry editor.

**3. Read-only plan view in the calculator, from two sources.**
   - **Linked takeoff present** → render the real takeoff geometry, read-only (accurate).
   - **No takeoff** → render a **payload-synthesized schematic**: per room, a footprint of
     the payload floor area extruded to ceiling height, exterior walls sized from each
     orientation's net wall area, and one representative window/door per orientation sized to
     that direction's total glass/door area. Labeled "schematic."

   The schematic is a **pure read-only function of the payload** — recomputed each view, owns
   nothing — so it preserves single-source-of-truth (one model, many views; ADR 0006).

**4. Bidirectional data is explicitly out of scope.** "Bidirectional" splits into load-level
fields (exist in both representations; *could* round-trip) and geometry (exists only in the
takeoff; cannot). Geometry write-sync would mean merging the two tools into one and is not
pursued. Load-level field round-trip (stable IDs threading takeoff components → payload line
items, plus merge logic) is deferred until a concrete need appears.

## Schematic — scope and limits

- **Per-room / per-orientation only.** No coordinates or adjacency in the payload, so no
  whole-house *aligned* plan can be synthesized — only representative room boxes. The aligned
  plan is available only when a takeoff is linked.
- **Same-orientation walls merge.** A corner room (e.g. west + north walls) reconstructs
  faithfully. A bump-out/zigzag, where the payload has already summed multiple same-direction
  walls, renders as one flat wall — total load preserved, shape lost. Accepted; the view is a
  sense-check, not a design drawing.
- **Footprint shape is representative, not real** (area is real, outline invented); interior
  sides may be left open/ghosted where no exterior wall faces that way.

## Consequences

- Every `calculations` record gets a visual without authoring a takeoff for each.
- The calculator's plan panel has one render path with two data sources (linked vs schematic).
- The main implementation cost is extracting the takeoff's Three.js mesh builders from the
  4,900-line `TakeoffApp` monolith into a reusable read-only renderer; the schematic synthesis
  logic itself is small. Building the linked view and the schematic together shares that cost.

## Alternatives considered

- **Full bidirectional geometry sync.** Rejected: payload is lossy; the only real version is
  merging the tools (large), not syncing two divergent models.
- **No calculator plan view; takeoff-only.** Rejected: leaves existing no-takeoff plans with
  no visual and forces a takeoff per plan, which the user explicitly does not want.
- **Reconstruct a whole-house plan from the payload.** Rejected: impossible without
  coordinates/adjacency; only per-room schematics are derivable.
