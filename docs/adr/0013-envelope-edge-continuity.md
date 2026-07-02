# 0013 - Envelope edge continuity as the compiled geometry invariant

**Status:** Proposed (2026-07-02)

## Context

Recent 3D QA work exposed a recurring failure mode: wall, ceiling, roof, attic, and
transition panels can be individually plausible while still forming a nonsensical building
envelope. Examples include duplicated knee-wall panels on the same wall plane, missing
triangular transition panels between a vaulted closet and an adjoining rectangular room,
and small generated slices whose edges float in space rather than connecting to another
construction surface.

The earlier question was whether every 3D wall-panel vertex must correspond to a traced
2D plan vertex. That is too strict. Many legitimate vertices are produced by vertical
geometry: vaulted ceiling shoulders, flat peak edges, gable peaks, knee-wall tops,
openings, story elevations, and roof/attic profile intersections.

The better invariant is edge-based, not vertex-source-based.

## Decision

Compiled building-envelope geometry must satisfy **edge continuity**:

Every exposed envelope panel edge must either:

- mate to another envelope panel edge;
- terminate on an approved construction boundary such as floor, ceiling, roof plane,
  ridge, exterior trace, opening, story elevation, or an approved transition/fill panel;
- or be explicitly tagged as an approved exposed-edge exception.

The compiler and validator should therefore reason about panel edges as first-class
topology, not only about panel area.

## Approved floating-edge exception

The currently accepted exception is a cantilevered floor / exterior band-joist condition.
A band joist around a cantilevered floor may point downward from the wall line and terminate
in exterior space, because the builder is expected to finish the underside/fascia condition
with exterior cladding or soffit treatment.

This exception should be represented explicitly, for example:

```ts
type EnvelopeEdgeTermination =
  | "mated_panel_edge"
  | "floor_boundary"
  | "ceiling_boundary"
  | "roof_plane_boundary"
  | "ridge_boundary"
  | "opening_boundary"
  | "exterior_trace_boundary"
  | "approved_transition_panel"
  | "cantilever_band_joist_exterior_termination";
```

It should not be inferred from an arbitrary floating edge. The edge must belong to a
band-joist / rim-joist condition at an exposed cantilevered floor or comparable approved
exterior floor-system condition.

## Validation implications

- A panel may have vertices that do not project to plan vertices, but each such vertex and
  its incident edges must be explainable by a parent source: ceiling profile, roof profile,
  opening, story elevation, adjacent-space profile, or approved transition.
- Overlap validation is necessary but not sufficient. Two panels can avoid overlap and
  still leave a floating edge or triangular hole.
- Missing-panel validation should be edge-aware: a gap between two nonmatching wall
  profiles is a request for a new transition/fill polygon, not a request to stretch or
  mutate one existing wall panel.
- The diagnostic sheet should label both panels and unmatched edges so a user can verify
  whether each exposed edge is real construction or compiler noise.
- User-dismissed validations must remain dismissed unless the underlying edge topology
  materially changes.

## Consequences

- The envelope compiler should eventually emit a topology graph: panels, edges, edge
  endpoints, edge mates, termination types, and source geometry.
- 3D QA can surface higher-quality errors: "floating edge," "duplicate same-plane panel,"
  "missing transition panel," and "unapproved exposed band-joist termination."
- This clarifies why the walk-in closet vaulted wall issue is not merely a slicing bug:
  the missing triangular pieces are new transition panels required to connect unmatched
  wall-profile edges.
- ADR 0006 still stands: 2D plan geometry owns the footprint and room loops. 3D may help
  select, label, and validate envelope edges, but it does not create an independent
  geometric source of truth.
- ADR 0010 still stands: vertical adjacent boundaries are spans and z-intervals. This ADR
  adds the stricter requirement that the resulting slices must form a connected envelope
  edge graph.

## Alternatives considered

- **Require every 3D vertex to map to a plan vertex.** Rejected. Vaults, gables,
  knee-walls, roof intersections, openings, and story transitions legitimately create
  section-derived vertices.
- **Area-only validation.** Rejected. Area can balance while edges overlap, float, or leave
  visible construction gaps.
- **Auto-fill every floating edge.** Rejected. Some floating edges are legitimate approved
  exceptions, and ambiguous gaps should be surfaced for user verification rather than
  silently invented.
