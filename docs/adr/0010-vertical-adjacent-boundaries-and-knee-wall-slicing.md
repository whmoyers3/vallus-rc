# 0010 — Vertical adjacent boundaries and knee-wall slicing

**Status:** Proposed (2026-06-26)

## Context

Adjacent spaces are currently 2D overlay polygons with a flat kind such as garage, attic,
crawl, covered porch, or exterior. That works for simple garage-adjacent wall treatment,
but it cannot describe a covered porch roof, porch ceiling, attic side volume, room over
garage, cantilever, or any two-story condition where the load boundary depends on both
plan overlap and height.

The existing 3D/ceiling work already points in this direction:

- rooms store `ceilingHeight`, vaulted ceiling values, ridge direction, and generated
  raised-wall / gable wall components;
- the 3D QA view already renders raised and vaulted knee-wall panels;
- wall suggestions are still based on a full room wall height, and adjacent-space
  detection only answers "what touches this exterior direction?" in plan view.

The covered porch case exposes the gap. A porch polygon may touch an exterior wall, but
only a horizontal slice of that wall, and only a vertical band, may actually become an
attic/knee-wall exposure because the porch roof creates an attic volume behind part of an
otherwise normal exterior wall. Treating the whole wall as either ordinary exterior or
knee wall is too coarse.

## Decision

**1. Adjacent spaces need vertical profiles, not just height.** Add optional vertical
metadata to `TakeoffAdjacentSpace`:

- `baseElevation` and `topElevation` for simple vertical extents;
- `ceilingGeometry` / `roofGeometry` for covered porch and attic-side spaces, including
  flat, sloped, gable, shed, and unknown profiles;
- `closedCeilingBelow` for porch ceilings/soffits that create a separated attic volume;
- `boundaryIntent`, such as garage, attic/knee-wall, crawlspace, outdoor, conditioned,
  or unknown.

The first implementation can use simplified primitives: flat height, shed slope, and
gable ridge. It does not need arbitrary 3D solid modeling.

**2. The engine should generate boundary candidates, not silently mutate walls.** When an
adjacent space's horizontal footprint touches a room wall and its vertical profile
overlaps only part of that wall, validation should produce a reviewable candidate:

- affected room and wall direction;
- horizontal span along the host wall;
- vertical interval on the wall;
- estimated area;
- recommended boundary and assembly, e.g. attic/knee-wall `W3`;
- confidence and reason, e.g. "covered porch roof with closed ceiling creates attic-side
  exposure from 9 ft to 13 ft over 11.5 lf."

**3. User resolution is explicit.** Present the user with the choices described in the
product discussion:

- slice the wall horizontally and vertically so only that section becomes a knee-wall
  exposure;
- treat the entire affected wall section as a knee wall;
- ignore the candidate and keep the current exterior wall treatment.

The resolution should be stored as structured data, not only as labels. At minimum the
resulting wall component needs `adjacency` and, once ADR 0005 is implemented, an explicit
engine `boundary` value.

**4. Slicing stays 2D-authored with vertical intervals.** ADR 0006 still stands: the 2D
plan owns geometry, and 3D owns envelope/vertical data. A wall slice is represented as a
host wall segment plus `zMin`/`zMax`, not as an independent 3D mesh that can drift from the
plan model. The 3D view visualizes and helps select the slice, but it writes back to the
same 2D-owned wall/boundary record.

**5. Multi-floor detection should use the same boundary model.** The same candidate
system should handle second-floor rooms over garages/exterior space and first-floor rooms
with conditioned space above. Floor polygons aligned in world feet provide horizontal
overlap; floor elevations and floor-to-floor heights provide vertical relationships.

## Proposed data shape

```ts
type TakeoffVerticalProfile =
  | { kind: "none" }
  | { kind: "flat"; zMin: number; zMax: number }
  | { kind: "shed"; zMin: number; lowSide: Direction; lowHeight: number; highHeight: number }
  | { kind: "gable"; zMin: number; lowHeight: number; peakHeight: number; ridgeDirection: "E-W" | "N-S"; ridgeOffset?: number }
  | { kind: "unknown"; zMin?: number; zMax?: number };

type TakeoffBoundaryCandidate = {
  id: string;
  roomId: string;
  adjacentSpaceId?: string;
  surface: "wall" | "floor" | "ceiling";
  direction?: Direction;
  spanStart?: number;
  spanEnd?: number;
  zMin?: number;
  zMax?: number;
  area: number;
  recommendedAdjacency: TakeoffWallAdjacency;
  recommendedAssembly: string;
  reason: string;
  resolution?: "slice" | "whole-section" | "ignore";
};
```

This can be normalized later, but the important part is that horizontal span and vertical
span are first-class.

## Smart rules

- A covered porch with a roof/ceiling profile and `closedCeilingBelow = true` can create
  an attic/knee-wall candidate where the porch roof intersects a conditioned exterior
  wall above the normal wall height.
- If the candidate covers most of the host wall area, suggest "treat entire wall section
  as knee wall" as the fastest option.
- If the candidate is narrow or partial height, prefer "slice wall" as the primary
  option.
- If geometry is incomplete, issue a warning and let the user keep the wall exterior until
  roof/ceiling heights are supplied.
- For floors above garage, porch, or exterior space, generate floor candidates such as
  `F1 garage floor` or cantilever/outdoor floor from plan overlap plus floor elevations.
- Do not auto-convert existing exterior wall components without user approval.

## Consequences

- The takeoff model becomes capable of representing the field condition that matters: not
  merely "this wall touches a porch," but "this exact span and height band touches an
  attic-like porch roof volume."
- 3D review becomes materially more useful because adjacent spaces can be drawn as
  translucent volumes/roof planes instead of flat colored overlays.
- Export logic must support multiple wall components on the same direction, including
  ordinary exterior wall area net of a knee-wall slice.
- ADR 0005 becomes more important. A sliced knee-wall component should export a structured
  boundary, not rely on the words "knee wall" in the line-item name.
- Validation needs candidate/resolution state so users are not warned repeatedly after
  intentionally ignoring a condition.

## Alternatives considered

- **Keep adjacent spaces flat and rely on manual wall components.** Rejected. It works as
  a manual escape hatch, but it cannot reliably warn about porch rooflines, rooms over
  garage, or cantilevers.
- **Treat any covered porch contact as a full knee wall.** Rejected. This overstates area
  in common partial-span cases and hides the framing choice the user needs to make.
- **Build arbitrary 3D solids now.** Rejected. The needed behavior can be represented with
  simple vertical profiles, host-wall spans, and z intervals while preserving the single
  source of truth from ADR 0006.
