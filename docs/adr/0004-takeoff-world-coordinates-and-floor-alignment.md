# 0004 — Takeoff geometry in world feet; calibration and floor alignment as non-destructive transforms

**Status:** Accepted (2026-06-23)

## Context

The takeoff tool (branch `codex/takeoff-v1-scaffold`) currently stores all geometry in
each floor's own page/pixel coordinate space, and calibration **mutates** the stored
points in place by multiplying them by a scale factor (`scaleRoom`/`scalePoint` in
`frontend/src/takeoff/TakeoffApp.tsx`). The schema is nominally multi-floor
(`TakeoffProject.floors[]`) but every code path is hardcoded to `floors[0]`; there is no
floor switcher, no floor-to-floor alignment data, and no floor elevation field. There is
no 3D code at all.

The product goal (see the screenshot reviewed in planning, and ROADMAP Phases 4–5) is an
exploded 3D scene of translucent room volumes stacked over aligned plan pages — multiple
floors registered into one space. That requires every room on every floor to resolve to a
single shared coordinate frame. Two problems block it:

1. **Destructive calibration.** Re-calibrating compounds rounding and discards the raw
   trace. Single-floor this is a latent bug; multi-floor it is fatal, because a
   pixel-to-pixel alignment transform between two independently-mutated floors silently
   bakes scale + rotation + translation into one un-debuggable matrix.
2. **No common frame.** Floors traced from different PDF pages, cropped differently and
   calibrated to different feet-per-pixel, have no origin in common, so they cannot be
   stacked or aligned.

A staging question was raised: must the full refactor happen before any further feature
work? The conclusion was no — only the parts that are cheaper now than later.

## Decision

**1. World feet is the canonical frame.** All takeoff geometry is stored in a single
project-level coordinate space in real-world feet with a common origin. Per-floor page
pixels and PDF crops are authoring inputs only; geometry is normalized to feet per floor
*before* any cross-floor operation. Consequence: differing crops/zoom between plan pages
cannot propagate scale error across floors, because floors only ever meet in feet.

**2. Calibration is non-destructive.** Calibration records a feet-per-pixel factor and
preserves the raw traced points; it never overwrites geometry. Re-calibration recomputes
from the raw trace, so it cannot compound error and the original is always recoverable.
This replaces the current `scaleRoom`/`scalePoint` mutation.

**3. Floor alignment is a similarity transform from shared reference points.** Registering
one floor onto another uses point pairs the user clicks on both plans, identifying the
same physical location (shared structural features — envelope corners, stairwell, bearing
wall — not interior room features). The transform is a **similarity** transform:
translation + rotation + one *uniform* scale (4 DOF). One pair gives translation only; two
pairs solve the full transform including scale; three or more overdetermine it and yield a
least-squares fit plus a residual used as the confidence readout. Uniform scale only: a
poor fit is **warned**, never absorbed by shear/anisotropic scaling (the genuinely
stretched-screenshot case is handled by grid/manual mode instead).

**4. Scale carries across floors automatically.** Because the reference points are shared
physical points, aligning a new floor to an already-calibrated reference floor recovers
the new floor's scale from the transform's uniform-scale term, regardless of its crop.
Independent per-floor calibration and alignment-derived scale are kept as **mutual
checks**: disagreement beyond tolerance flags a misplaced reference point rather than
silently winning.

**5. Alignment is pairwise and retroactive; floors carry elevation.** Floors may be added
and aligned at any time and need not be imported together; the natural workflow is to take
off floor 1 fully, then add and align floor 2 later. Each floor stores an `elevation` /
floor-to-floor height (z-offset) for stacking, distinct from per-room ceiling height.

**6. Staging.** Do **now**, while single-floor and cheap: items 1 and 2 (feet canonical,
non-destructive calibration), plus *dormant* schema fields for alignment
(`referencePoints`, `transform`) and `elevation`/`floorToFloorHeight`, unused until
multi-floor is built. **Defer** the alignment UX, floor switcher, ghost overlay, and
Three.js extrusion to the multi-floor / 3D phases. Once geometry resolves to world feet +
elevation, extrusion is trivial.

## Consequences

- Single-floor takeoffs convert losslessly today (`floors[0]` is reinterpreted as world
  feet); the conversion is far cheaper now than after multi-floor geometry and 3D both
  depend on the pixel model.
- The destructive-recalibration bug is fixed as a side effect.
- Alignment transforms are debuggable (clean feet-to-feet similarity with a visible
  residual) and self-checking against independent calibration.
- The dormant fields let the multi-floor "capability" exist in the schema without building
  its UI, satisfying the staging goal.

## Update (2026-06-23) — 3D QA landed before the refactor

A single-floor Three.js QA view (`elevation`/"3D QA" mode) was implemented in
`TakeoffApp.tsx` before this refactor: floor/wall/opening meshes, vaulted ceilings with
kneewall and gable-end panels, a crop-mapped plan underlay, and correct GPU disposal on
teardown. It is built directly on the current un-normalized per-floor coordinates and
`types.ts` still has no `elevation`/`alignment`/world-frame fields. This does not change
the decision; it *raises its priority*: the coordinate model now has a second dependent
(the mesh builders), and multi-floor stacking — the product goal — is unreachable until
`elevation` and a shared world frame exist. The mesh builders already treat coordinates as
1:1 with feet-valued heights, so normalizing storage to world feet mainly makes the scene
metrically correct and lets `referencePlaneForFloor` be offset by `elevation` to stack
floors. Migrating the mesh builders is now part of the item-1/2 scope. Separately, the 3D
builder already computes vaulted kneewall (`W3`) and gable-end (`W1`) geometry that the
payload export (`payloadComponentsForRoom`) does not yet emit; that geometry should feed
the export rather than a parallel path.

## Update (2026-06-23) — crop must preserve aspect ratio

The crop tool currently stretches the cropped region to fill, distorting the PDF's aspect
ratio (non-uniform x vs y scaling). This is not merely a cosmetic "squashed view" problem:
a single uniform calibration factor (or an averaged horizontal+vertical factor) **cannot
undo anisotropic distortion** — recovering it would require independent x and y factors,
which breaks the uniform-scale (similarity) model this ADR commits to for both calibration
and alignment. Therefore the crop tool must preserve the source aspect ratio (fit/letterbox,
never stretch-to-fill). Aspect-preserving crop is a correctness requirement, not a display
preference: it is what makes one-factor scale-from-points valid.

## Alternatives considered

- **Keep per-floor pixel coordinates, align pixel-to-pixel.** Rejected: bakes scale into
  the alignment matrix, un-debuggable, and compounds with destructive calibration.
- **Full affine alignment (allow shear/anisotropic scale).** Rejected for PDF pages: a bad
  reference-point pick would "succeed" by distorting the building and hide the error.
  Reserved conceptually for the stretched-screenshot case, which grid/manual mode covers.
- **Do the whole refactor plus alignment UX up front.** Rejected: only items 1–2 are
  cheaper now; the rest is purely additive and can wait.
