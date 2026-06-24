# 0005 — Structured boundary input; demote name-substring matching to legacy fallback

**Status:** Accepted (2026-06-23)

## Context

The engine resolves a component's cooling CLTD and heating ΔT for boundary-condition
assemblies (garage wall, partition, attic kneewall, floor over garage, cantilever, slab)
by **substring-matching the line-item name** in `infer_cooling_cltd` /
`infer_heating_delta_t` (`"GARAGE" in name`, `"PARTITION" in name`, `"CANTILEVER" in
name`). The `LineItem` already accepts an explicit `cooling_cltd` / `heating_delta_t`, and
name-matching is only the fallback — but there is no structured *boundary* field, so the
boundary condition is encoded either as a raw number or as a magic English word.

This worked while data came from Salas imports, where rooms and assemblies arrived
pre-labelled with the right words. For takeoff-authored projects the boundary is known
structurally — the takeoff's adjacent-space tagging records that a wall abuts a garage, an
attic, a crawl space, or another conditioned room — but that knowledge is currently lost
unless the emitted name happens to contain the right substring. The result is a payload
that *calculates* and is *silently wrong*: an untagged-by-name garage wall gets ordinary
exterior-wall CLTD.

The domain model already names the correct structured home for this: the **Boundary-Type
catalog** and the **Type (assembly variant)** (e.g. `W3/Attic-conditioned`,
`R1/Ceiling-vented`) in `CONTEXT.md`. The pipeline simply collapses it to a name string.

## Decision

**1. Add a structured `boundary` field** to the takeoff room component and to the engine
`LineItem`. It identifies the boundary condition (garage, partition, attic-vented,
attic-conditioned, crawl, floor-over-garage, cantilever, slab, …).

**2. Resolve from the boundary field via the Boundary-Type catalog as the primary path.**
`infer_cooling_cltd` / `infer_heating_delta_t` consult `item.boundary` (after an explicit
per-component CLTD/ΔT, consistent with the existing resolution hierarchy) and look up the
Boundary-Type catalog default before any name inspection.

**3. Keep name-substring matching as a retained legacy fallback**, never deleted — it still
serves older imports and hand-entered names — but it is the last resort, not the source of
truth. This mirrors ADR 0001's "never collapse the fallback" principle.

**4. The takeoff fills `boundary` from adjacent-space tagging**, so a garage/attic/crawl
wall, a partition, or a floor-over-garage is resolved structurally and never depends on an
English word appearing in the label.

## Consequences

- Eliminates the silent-wrong-CLTD failure mode for takeoff-authored projects.
- Slots into the existing four-tier resolution hierarchy without disturbing imports.
- Makes the round-trip test trustworthy: a garage wall is provably treated as a garage
  wall regardless of its label (relevant once the round-trip plan includes a garage).
- Requires a payload/serialization schema addition (`boundary` on line items) and a
  Boundary-Type catalog lookup in the engine inference functions.

## Alternatives considered

- **Keep name-substring matching as the source of truth.** Rejected: silent wrong answers,
  and it couples correctness to label wording.
- **Require an explicit numeric CLTD on every boundary component from the takeoff.**
  Rejected: pushes catalog knowledge into the UI and loses the "resolve a named boundary
  type" abstraction the catalog exists to provide; the numeric path remains available as
  the highest-precedence override.
