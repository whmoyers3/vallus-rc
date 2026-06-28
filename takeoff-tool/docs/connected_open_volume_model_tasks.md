# Connected Open Volume Model Tasks

Last updated: 2026-06-28

This checklist captures the unbuilt model work surfaced during the Georgetown / Salas
O'Brien comparison. See `docs/adr/0011-connected-open-volumes.md` for the architectural
decision.

## Design Points Not Fully Built Yet

- Open-to-above currently changes room volume; it needs explicit envelope surfaces.
- Upper and lower footprints can differ for foyers, stairs, hallways, and loft openings.
- Ceiling area should be independently modeled; it should not always equal lower floor area.
- Vaulted ceilings sometimes have flat peaks and should split into flat and sloped ceiling
  line items instead of treating the whole room as one vaulted plane.
- Tray ceilings should have their own ceiling shape mode; they should not always follow
  every jog in the room footprint.
- Vertical transition faces need their own wall/knee-wall/attic-wall line items.
- Stair footprints across floors should be connectable without destructive room merges.
- Room merge remains post-calculation grouping; connected volume is pre-calculation envelope
  modeling.
- Band joist/floor-system height should remain independently toggleable from open-volume
  wall continuation.
- Diagnostic reports should identify whether a Salas gap comes from lower walls, band joist,
  open-volume wall continuation, ceiling area, transition walls, or room bucketing.

## Development Path

- [x] Document the connected-open-volume model decision.
- [x] Add takeoff data vocabulary for connected volumes and open-volume component sources.
- [x] Add opt-in open-to-above wall-extension export support.
- [x] Add validation that prompts the user before generating open-to-above wall extensions.
- [x] Add `Vault w/ flat peak` ceiling geometry with flat/sloped ceiling line-item split.
- [x] Add tray mode vocabulary and UI for smart box, double box, follow-room, and custom.
- [x] Suppress generated gable/knee-wall suggestions where a gable end is shared by a
  matching conditioned room with the same vault geometry.
- [x] Add a validation helper for like-labeled vertically aligned rooms, with reporting
  floor selection for stair-style connected volumes.
- [ ] Add a visible connected-volume editor for selecting linked rooms/footprints across
  floors.
- [ ] Add lower/upper/ceiling/transition footprint drawing and room attribution controls.
- [ ] Export connected-volume manual components as flattened calculator line items.
- [ ] Add ceiling controls for actual top ceiling area and transition wall area.
- [ ] Add custom drawn tray polygons and smarter tray placement that ignores incidental
  room jogs.
- [ ] Add stair-specific connected-volume workflow for lower/upper footprint mismatch.
- [ ] Extend diagnostics to group open-volume generated components separately.
- [ ] Add tests/fixtures using Georgetown-style foyer and stair cases.

## Current Behavior

Simple `open_to_above` links can now be marked to generate upper wall-extension line items.
Those line items preserve orientation and boundary metadata and are emitted only after the
user applies the validation suggestion. Existing projects remain volume-only unless the user
opts in.
