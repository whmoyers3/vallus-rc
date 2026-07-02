# Deprecated: Legacy Wall Slice Validation

Date: 2026-07-02

This note preserves the old generated wall-slice logic after disabling it in the active takeoff workflow. The old path tried to infer wall corrections from adjacent attic/roof profiles, ceiling profile bands, and rectangular span remainders. It produced useful early prototypes, but it also created repeated invalid suggestions: applying one incorrect fix often caused the next validation pass to propose another incorrect fix in the same area.

## Why It Was Deprecated

The legacy system was area/span first. It treated a room wall as a directional span, detected overlaps with adjacent spaces or ceiling profiles, and then suggested wall components such as "Slice wall", "Whole section", "Keep exterior", and "gap fill" panels. That made it easy to create wall fragments, but it did not prove that every generated panel edge had a valid mate, legal termination, or approved exception.

The result was fragile around vaulted rooms, attic knee walls, gable ends, and mismatched room shapes:

- tiny trace misalignments became real wall panels;
- slivers were sometimes promoted into load components;
- missing transition polygons were confused with slices of existing walls;
- saved generated wall components could survive after the ceiling or room geometry changed;
- validation could cycle through more suggested fixes instead of converging.

## Retired Active Entry Points

The following functions remain in the codebase as reference, but are disabled by feature flags in `frontend/src/takeoff/TakeoffApp.tsx`:

- `ceilingWallSuggestionsForRoom`
- `boundaryCandidatesForFloor`
- `wallSegmentContinuityGapFillSuggestionsForRoom`
- `wallGapFillSuggestionsForRoom`
- `ceilingWallMeshPartsForRoom`

The disabled validation and rendering flags are:

- `legacyWallSliceValidationEnabled`
- `legacyWallGapFillValidationEnabled`
- `legacyCeilingWallSuggestionEnabled`
- `legacyCeilingWallMeshRenderingEnabled`

## Replacement Direction

The replacement model is edge-continuity first, as described in `docs/adr/0013-envelope-edge-continuity.md`.

Generated envelope geometry should be built from explicit panels whose edges are checked against one of these outcomes:

- the edge mates to another panel edge;
- the edge terminates on a legal boundary such as floor, roof, ridge, or exterior trace end;
- the edge is covered by a known object such as a window, door, floor, ceiling, or band joist;
- the edge is an explicit, reviewed exception.

Missing transition areas, such as triangular gaps between a vaulted gable profile and an adjoining rectangular wall, should be created as new polygons. They should not be modeled as accidental remainders of another wall slice.

## Historical UX

The old user-facing actions are preserved here only as vocabulary:

- `Slice wall`: split a span where an adjacent attic/roof profile overlapped it.
- `Whole section`: classify the full span as the adjacent-wall treatment.
- `Keep exterior`: ignore the adjacent profile and preserve the exterior treatment.
- `Re-approve ceiling geometry`: regenerate old raised-wall, gable, and gap-fill components.

These actions should not be reintroduced unless they are backed by the edge-continuity graph and can prove convergence after application.
