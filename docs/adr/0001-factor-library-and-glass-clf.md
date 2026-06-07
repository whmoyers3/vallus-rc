# 0001 — Factor resolution hierarchy, self-learning factor library, and the glass CLF formula

**Status:** Accepted (2026-06-07)

## Context

VRC re-derives every component CLF/CLTD from hardcoded constants and discards the
per-component factors present in each Salas import. This was believed to be the root of
the worst accuracy misses, and the proposed fix was to *consume and learn* the imported
factors so VRC could eventually reconstruct ASHRAE-style tables and become independent of
Salas.

Two premises in the original handoff turned out to be wrong on inspection of the source
PDFs:

1. **"Finley/Tranquility have a blank Location."** They do not — Gainesville GA and
   Jefferson GA are present; the importer's text extraction drops the positioned form cell.
2. **"Salas reports no ceiling line."** It does — `R1 Ceiling 55` appears with per-room
   Btu/hr. Another extraction gap, not a property of Salas.

Most consequentially, the glass CLF was believed to be an undiscovered Salas-internal
quantity that had to be learned. Decomposing the glass numbers across two PDFs showed it
is fully computed (see Decision §4).

The design also has to keep the test battery honest: once VRC resolves factors from
learned Salas-derived values, a naive VRC-vs-Salas comparison agrees by construction and
measures nothing.

## Decision

**1. Resolution hierarchy (four tiers, never collapse the fallback).**
A component's CLTD/CLF resolves in order: explicit per-project input → authoritative
source → learned library → computed formula fallback. The formula fallback is never
removed (it serves from-scratch projects and unlearned keys). Lower tiers are retained,
not deleted, when a higher tier supersedes — so superseding is non-destructive and the
learned-vs-authoritative comparison survives as a diagnostic.

**2. The learned library is a bridge, stored as a feature matrix, per factor family.**
A standalone, project-independent store (modeled on the `assemblies` table: no FK to
`calculations`, `ON CONFLICT DO NOTHING`, soft/denormalized provenance) so it survives
project deletion and idempotent re-import. **Separate tables per factor family** (glass
solar vs. opaque CLTD are different functions). Each row stores the factor value *next to
every observable component* (latitude, raw lat, location, U, SHGC, design temps, daily
range, house facing, internal shading, building type) plus provenance and tier — so the
table is a clean dataset to *reverse-engineer the underlying function*, not just a lookup.
Record components even when currently constant; record raw values, not derived; store
**true** orientation, not Salas's rotated label.

**3. Key by physics, reject unresolvable input.**
Factor key = `(latitude band, assembly code, orientation [, SHGC for glass])`. Latitude is
geocoded from the project location (deterministic offline lookup, same path for PDF import
and manual entry) and snapped to a band; raw latitude is kept so banding is re-derivable. A
location that cannot be geocoded is **rejected at entry**, never learned under a null key.
SHGC is in the glass key to prevent false conflicts. New key → create silently; same key +
different value → **factor conflict**: keep stored value, log both with provenance, surface
for review, never block.

**4. The glass CLF is computed, not learned — formula recovered and verified.**

> `glass Btu/hr·sf = U × 14 + SHGC × SHGF[true orientation]`

`14` = `GLASS_CLTD` (glass conduction CLTD); `SHGF` = `SCLEFF_BY_DIRECTION`
(`N 7, NE 14, E 38, SE 43, S 50, SW 97, W 111, NW 61, Shaded 7, Skylight 187`). Verified
across 10 orientations × 2 PDFs (Finley SHGC 0.20/U 0.29; Tranquility SHGC 0.18/U 0.30) =
20/20 matches to rounding. Requires (a) rotating each window's plan/building-relative
direction by **House Faces** to a true azimuth. SHGF is latitude/month-dependent; the
recovered table is north-Georgia only. **(Correction, verified against Evergreen TH:**
townhouses do *not* use this SHGF formula. `TOWNHOUSE_GLASS_LOAD_FACTORS` is a separate
**combined** Btu/hr-sf table applied directly per orientation — 9/10 match on Evergreen, NE
corrected 26→21 — and is *higher*/more E-W-symmetric than single-family, not "lower from
inter-unit shading" as originally assumed.)

**5. Three buckets, not two, for factor provenance.**
*Learned* (climate/orientation: directional wall CLTD, glass SHGF). *Per-project input*
(boundary conditions: attic/kneewall, ceiling/roof, garage, partition, floor-over-garage,
garage-door CLTD and U — set per `(code, variant)`; can differ within one house, e.g.
Finley W3=15 with R1=55). *Computed constant* (below-grade wall, slab, exterior door).
A Type is a `(code, variant)` entry carrying its own factor; `Assembly` is extended to
carry `cooling_cltd`/`cooling_load_factor`; manual-entry boundary defaults come from a
seeded boundary-Type catalog.

**6. Formula-first posture; battery measures the formula, not the crutch.**
For this phase the formula is the production value for climate/orientation; the learned
library runs as a **shadow diagnostic** (populated, compared, divergence recorded) and
graduates above the formula only when expanding past the calibrated climate. Consuming
imported **boundary inputs** is not the same as consuming learned **climate factors** — the
former are measurements, the latter would mask formula error. The battery's headline metric
is **formula-only vs. Salas**; production-resolution vs. Salas is demoted to a wiring check.
Keeping a formula-only baseline lets the next phase attribute new divergence to *input
methodology* rather than the engine.

## Consequences

- Near-term work is **fixing the glass formula and orientation rotation**, parsing
  `House Faces` and `Location`, and including ceiling in the comparison — not building a
  learning pipeline. The library/reverse-engineering effort narrows to recovering SHGF at
  *other latitudes*.
- The library, conflict log, and boundary-Type catalog fold into the Phase-1 migration in
  `ADMIN_PANEL_PLAN.md §1.1`.
- Learned values persist independently of source projects, so a wrong value needs its own
  edit/invalidate path (deleting the source project will not remove it).
- The shadow-diagnostic posture means VRC does not yet "become independent" via learning;
  independence is measured, and pursued through the formula.

## Alternatives considered

- *Overwrite learned values in place when the source is found* — rejected; destroys the
  divergence diagnostic that proves the bridge worked. Supersede by tier instead.
- *Learn the combined glass Btu/hr·sf as an opaque number* — unnecessary once the formula
  was recovered; would also have hidden the SHGC and latitude dependence.
- *One wide factor table with a kind discriminator* — rejected in favor of per-family
  tables; the families are different functions with different feature sets.
- *City string as the climate key* — rejected; latitude band correctly merges adjacent
  towns (Gainesville/Jefferson) that share a climate.
