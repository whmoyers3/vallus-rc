# 0011 - Connected open volumes for open-to-below foyers, stairs, and loft/hall overlaps

**Status:** Proposed (2026-06-28)

## Context

Georgetown exposed a modeling gap that is not well described by a simple room height or a
post-calculation room merge. The first-floor foyer is open to a second-floor circulation
area, but the lower and upper footprints do not appear to be identical. The lower footprint
is roughly rectangular; the upper opening can include portions of hallway, loft, and stair
circulation. That means the modeled volume, exterior wall continuation, ceiling area, and
attic/transition wall area can have different plan footprints.

The current takeoff model supports `open_to_above` as a vertical room link. That correctly
raises effective room height and volume, but it does not create explicit upper exterior wall
continuation, shifted ceiling area, or transition-wall line items. The result can be a room
whose volume is close to Salas O'Brien while its envelope components remain short.

This is separate from ADR 0002 room merges. A room merge groups calculation results after
the physics are calculated. A connected open volume changes envelope physics and therefore
must be represented before payload generation.

## Missing design points from the Georgetown review

- Open-to-above should not mean only "increase this room's ceiling height." It should be
  capable of generating explicit envelope surfaces.
- The upper footprint of an open volume may be wider, offset, clipped, or composed from
  adjacent second-floor spaces. It should not be forced to match the lower room rectangle.
- Ceiling load area may be larger or smaller than the lower floor footprint. Foyer-style
  rooms can have a top ceiling footprint that belongs visually to upstairs circulation.
- Exterior wall continuation should be a distinct line item by orientation so diagnostics
  can explain the wall-area gap.
- Vertical transition faces, often reported like knee-wall or attic-wall area, need their
  own reviewed component rather than being hidden in a ceiling-area adjustment.
- Stair lower and upper footprints can differ while still representing one connected
  circulation volume.
- Band-joist/floor-system height and open-volume wall continuation are related but distinct
  envelope conventions. They should remain independently reviewable.
- The calculator should continue receiving flattened rooms and line items. Rich open-volume
  geometry belongs in the takeoff JSON and is flattened during handoff.

## Decision

Introduce a **connected open volume** model in the takeoff layer. A connected volume is a
pre-calculation envelope object that can reference rooms on multiple floors and describe
how their floor, ceiling, wall, and transition surfaces relate.

The model should support:

- lower and upper footprints by floor;
- references to source rooms, such as `Foyer`, `Upstairs Hall`, `Loft`, and `Stairs`;
- an assignment/reporting room for calculator payload line items;
- generated exterior wall continuation by direction;
- explicit ceiling/roof area at the top of the volume;
- explicit attic/transition/knee-wall faces where the footprint changes;
- a review state so generated components can be accepted, edited, or ignored.

**Update 2026-06-28: derived thermal surface segmentation.** Open-volume wall continuation
is a derived surface, not a resize of the lower room's base wall component. The takeoff
should classify each wall band from the geometry around it: source room edge, target-floor
exterior/conditioned footprint, adjacent spaces, and vertical interval. If an upper band is
adjacent to conditioned space, it is not exported as a heat-bearing garage/exterior wall
even when the lower band is a garage/exterior wall. If it remains adjacent to outside,
garage, attic, or crawlspace, it exports as a separate generated component with its own
orientation, boundary, `zMin`/`zMax`, and geometry label.

This keeps regular wall review focused on the base room wall slice and prevents generated
open-volume extensions from being double-counted as manually resized room walls. It also
establishes the path for future diagonal stair cases: the wall face should be clipped into
surface segments by adjacent-space/vertical profiles, then each segment should be classified
and exported independently.

`open_to_above` remains the simple path. For simple stacked rooms, it can generate the same
derived components from the source room footprint. For irregular foyers and stairs, the user
can promote the condition to a connected open volume with custom upper/lower footprints.

## Development path

1. **Data vocabulary.** Add takeoff types for connected volumes, footprint references, and
   derived open-volume component sources. Do not change existing payload totals by default.
2. **Review-only diagnostics.** Warn when an `open_to_above` room has tall volume but lacks
   corresponding upper wall continuation or reviewed ceiling/transition components.
3. **Simple envelope generation.** For explicitly approved simple `open_to_above` links,
   generate wall-extension line items by orientation from exterior segments and added height.
4. **Connected-volume authoring.** Add UI for selecting rooms/areas across floors and
   defining lower/upper footprints without destructive room merges.
5. **Ceiling and transition controls.** Allow actual top ceiling area and transition wall
   area to be entered, generated, and exported as distinct line items.
6. **Stair support.** Let stair lower and upper footprints participate in one connected
   volume while preserving room-level floor area, internal gains, and diagnostic labels.
7. **Diagnostic comparison.** Report connected-volume components separately so Salas
   O'Brien differences can be traced to wall continuation, transition wall, ceiling area,
   band joist, or room bucketing.

## Consequences

- The takeoff JSON becomes the source of truth for irregular multi-floor envelope geometry.
- The calculator contract remains stable because the handoff still exports flattened room
  and line-item payloads.
- Users get an explicit place to model discretionary foyer/stair/hall methodology instead
  of hiding it in manual wall components.
- Existing projects remain safe if new envelope generation is opt-in or review-gated.
- Generated open-volume components must remain separate from user-authored base wall
  components so validation and payload export do not count the same surface twice.

## Alternatives considered

- **Merge rooms across floors and recalculate as one room.** Rejected. It conflicts with
  ADR 0002 and would blur floor area, internal gains, and room diagnostics.
- **Keep open-to-above as volume-only and rely on manual wall components.** Rejected as the
  long-term model because it hides the exact envelope gap we need diagnostics to explain.
- **Force upper and lower footprints to match.** Rejected. Georgetown shows that real plans
  often have shifted or broader upper circulation around open spaces.
