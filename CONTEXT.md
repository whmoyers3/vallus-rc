# VRC Domain Glossary

## Tonnage

- **Minimum tonnage** — The continuous decimal tonnage requirement calculated from sensible cooling load divided by 9,000 BTU/hr per ton. Raw engine output before rounding. Code: `tons_min`. Example: 3.07 tons.
- **Selected tonnage** — The standard catalog equipment size chosen by the engineer from discrete steps (1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0). Code: `selected_tons`. Example: 3.5 tons.

## Sources

- **VRC calculation** — A load calculation produced by the VRC engine from imported or manually entered inputs.
- **Salas reference** — The output values (cooling/heating BTU/hr, airflows, tonnage) extracted from a Salas O'Brien PDF for the same set of inputs. Stored in `metadata.salas_obrien_comparison`.

## Comparison & Diagnostics

- **System delta** — The signed difference between VRC and Salas values at the whole-house or whole-unit level (cooling BTU/hr, heating BTU/hr, minimum tonnage).
- **Room variance** — The signed per-room difference between VRC and Salas output values (cooling BTU/hr, heating BTU/hr).
- **Component variance** — The signed difference between VRC and Salas BTU/hr at the assembly-spec level (grouped by component type + U-value + CLTD/CLF) within a room. More granular than room variance; used in the detail report to isolate which component type is responsible for a discrepancy.
- **Assembly spec** — The parameter set that uniquely identifies a calculation method for a component: type code (W1, G1, F2, etc.), U-value, and CLTD or cooling load factor. Two components with the same assembly spec should produce identical BTU/hr per square foot. Used as the grouping key for component variance analysis.
- **Room conformance** — A pass/fail summary indicating whether all rooms fall within the active tolerance band, or whether outlier rooms exist. Catches the "cancelling outliers" case that system delta misses.
- **Tolerance band** — The threshold pair (percentage + absolute BTU/hr floor) used to determine room conformance. Default: 5% and 200 BTU/hr. Adjustable per session in the admin panel; not persisted.
- **Accuracy threshold** — The absolute BTU/hr margin within which a project is considered to match the Salas reference. Default: 50 BTU/hr. Adjustable per session alongside the tolerance band. Projects within this threshold display as green (accurate) regardless of change direction.
- **Import fidelity** — Validation that VRC's project inputs faithfully reproduce what was extracted from the Salas PDF. Checks total floor area, total volume, orientation, and room count. Computed at import time and stored. Poor import fidelity renders output comparison unreliable.

## Factor Resolution & Learning

- **Boundary-condition assembly** — An assembly whose CLTD/heat behavior is set by the physical condition on the *other side* of it (vented attic vs. conditioned attic, garage, partition, grade, floor-over-garage), not by climate or orientation. Varies per project independent of location, so it is a per-project input, never learned. Example: a vented hot attic kneewall (~55) vs. a sealed conditioned attic (~15) in the same town.
- **Assembly** — The construction spec of a building component: code (`W1`, `G1`, `F2`…), U-value, SHGC, description. Answers "what is this made of."
- **Type (assembly variant)** — A `(code, variant)` entry mirroring one row of the Salas schedule: an assembly plus a variant — orientation for climate factors (`W1/SW`, `G1/W`, `G1/Skylight`), or boundary condition for boundary factors (`W3/Attic-conditioned`, `R1/Ceiling-vented`). Each Type carries its own CLTD or CLF. The unit at which factors attach.
- **Boundary-Type catalog** — A seeded, extensible store of boundary-condition Types (vented vs. conditioned attic, garage, partition, grade) and their default CLTDs, used when building a project from scratch where there is no PDF to read the value from. Distinct from the learned factor library, which holds only climate/orientation factors.
- **Climate/orientation factor** — A CLTD or cooling load factor determined by design conditions, latitude, and orientation (directional wall CLTD, glass CLF by orientation, skylight, shaded). The same physics yields the same value across projects, so these are learnable.
- **Learned factor library** — A standalone, project-independent store of climate/orientation factors accumulated from Salas imports. Each value is recorded once per physics key; an existing key is never overwritten by a later import. Acts as a *bridge* that empirically reconstructs the factor tables until the authoritative source is found.
- **Authoritative CLF source** — The published source the factors derive from: the ASHRAE *Handbook of Fundamentals* Solar Heat Gain Factor tables, keyed by latitude and design month. At the north-Georgia latitude this table has been recovered exactly (it equals `SCLEFF_BY_DIRECTION`); it is "undiscovered" only for *other* latitudes. When a latitude's table is obtained, its values occupy the highest factor tier and supersede learned values; the swap is validated against the test battery before being committed.
- **Solar heat gain factor (SHGF)** — The per-orientation solar-gain table that, scaled by a window's SHGC, produces the solar portion of glass cooling load. Varies by latitude and design month. At the north-Georgia latitude: `N 7, NE 14, E 38, SE 43, S 50, SW 97, W 111, NW 61, Shaded 7, Skylight 187`. This is the one quantity the glass factor library learns per latitude band; everything else in the glass load is computed.
- **Glass cooling load factor** — The per-square-foot glass cooling load. The conduction portion is computed from U-value and a fixed glass conduction CLTD; the solar portion is the window's SHGC times the SHGF for its true orientation. Not a learned primitive — it is *derived* from SHGF, SHGC, U, and orientation.
- **True orientation** — The actual compass azimuth a surface faces, obtained by rotating its plan/drawing direction by the project's house facing. Solar factors must be resolved against true orientation. Salas reports orientation under a building-relative label (Front/Right/Back/Left) plus a plan direction; these collapse to nonsense unless rotated by the facing.
- **Building type** — Single-family detached vs. townhouse. Selects how glass cooling is computed. Single-family uses the SHGF formula (`U×14 + SHGC×SCLEFF`). Townhouses use a **separate combined per-direction load-factor table** (`TOWNHOUSE_GLASS_LOAD_FACTORS`, Btu/hr-sf) applied *directly* — not an SHGF, and not simply "lower": verified against the Evergreen TH resload, townhouse factors are actually higher and more east/west-symmetric than single-family. Auto-detected on import from plan naming / multi-unit structure; user-overridable in the editor.
- **Resolution hierarchy** — The ordered fallback by which the engine resolves a component's CLTD/CLF, highest precedence to lowest: explicit per-project input → authoritative source → learned library → computed formula fallback. Resolution selects the highest available tier for a key. The formula fallback is never removed, preserving independent calculation for from-scratch projects.
- **Factor tier (provenance)** — The rank a stored factor value was resolved from, mirroring the resolution hierarchy: `imported` (explicit per-project input), `authoritative`, `learned`, `vrc_default` (formula fallback). Lower tiers are retained, not deleted, when a higher tier supersedes them.
- **Factor key** — The tuple a climate/orientation factor is stored and retrieved under: latitude band + assembly code + orientation. Two components sharing a factor key resolve to the same factor value.
- **Latitude band** — The climate dimension of a factor key: a latitude geocoded from the project's location and snapped to a fixed step, so nearby projects in one climate share a band (Gainesville and Jefferson, ~15 mi apart, both resolve to one band). A location that cannot be resolved to a latitude is rejected at entry rather than learned under a null key. Raw latitude is retained as metadata so banding can be re-derived.
- **Divergence diagnostic** — A recorded comparison between what the engine *would* derive or has *learned* and the value actually imported from Salas, so the test battery measures VRC's own model rather than echoing Salas. The signal that would auto-surface anomalies like the conditioned-attic CLTD split.
- **Factor conflict** — When an import produces a *different* value for an existing factor key. The stored value is kept (never overwritten); the conflict is logged with both values and provenance and surfaced for review, but does not block the import. Signals a Salas table revision, a rounding change, or a still-hidden key dimension. The glass key includes SHGC precisely to avoid false conflicts.

## Card Status Indicators

- **Accuracy status** — Always visible. Green when the project's system delta is within the accuracy threshold. Grey/neutral when outside. Indicates whether the current model is accurate for this project, independent of any recompute.
- **Change direction** — Visible only after a recompute. Green if the absolute delta moved closer to the Salas reference (improved). Red if it moved further (regressed). Yellow if it didn't meaningfully change (within 0.1%). Applied per-metric (cooling, heating, minimum tonnage), not per-card.

## Model Validation

- **Test battery** — A deliberately curated subset of projects selected for maximum input variance (foundation types, volumes, insulation, window types) used to evaluate model performance. Battery records are frozen copies of eligible projects, stored with `source = 'test_battery'` and a `parent_id` linking to the original. Orientation is locked to match the Salas reference at creation time.
- **Battery eligibility** — A project is eligible for the test battery only if it has Salas reference data, passing import fidelity, and an orientation match. Enforced at copy-creation time.
- **Comparison snapshot** — Precomputed per-room and system-level VRC vs. Salas deltas stored on the calculation record. Enables the admin panel to render cards without re-running the engine. Computed at save time for projects with Salas data.
- **Recompute** — A batch operation that re-runs every test battery project through the current engine via a single `POST /api/calculate/batch` endpoint. Results are held in browser memory until explicitly saved.
- **Snapshot export** — A timestamped JSON file written to `snapshots/` in the repo containing the full test battery results at a point in time. Git-tracked alongside engine changes. Used for longitudinal analysis via Claude Code or Cowork.

## Admin Panel

- **Views** — Two toggleable layouts: Table view (scannable rows, sortable columns) and Status Columns view (kanban-style triage by accuracy status). Toggle in the top bar.
- **Unit toggle** — Switches delta display between percentage and absolute BTU/hr across both views. Segmented control in the top bar.
- **Battery management** — Add via multi-select modal with search (from admin panel or main editor). Remove via per-card/row action. Refresh battery copy from main editor when parent is updated.
- **Bulk import** — Upload multiple Salas PDFs at once from the admin panel. Each PDF goes through the full pipeline (extract → import → save as `salas_import` → create `test_battery` copy) sequentially. Warnings are stored on the record, not blocking. If a matching record already exists (by plan_name + foundation + elevation), the old record and its battery copy are replaced. Progress shown per-file.
- **Battery reset** — Delete all `test_battery` records and their `salas_import` parents in one action. Used when the importer has changed and all records need re-importing from scratch. Requires explicit confirmation.

## Model Development

- **Model development workspace** — The VRC project folder itself, used with a local server to develop and test engine changes before pushing to production. Governed by `MODEL_DEV.md` (runbook) and `model_changelog.md` (decision log).
- **Snapshot analysis** — A workflow (not a UI feature) where historical snapshot files and the model changelog are fed to Claude for pattern detection, regression identification, and model performance assessment. Can be formalized as a skill or saved prompt.
