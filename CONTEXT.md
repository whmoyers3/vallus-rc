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
- **Room conformance** — A pass/fail summary indicating whether all rooms fall within the active tolerance band, or whether outlier rooms exist. Catches the "cancelling outliers" case that system delta misses.
- **Tolerance band** — The threshold pair (percentage + absolute BTU/hr floor) used to determine room conformance. Default: 5% and 200 BTU/hr. Adjustable per session in the admin panel; not persisted.
- **Accuracy threshold** — The absolute BTU/hr margin within which a project is considered to match the Salas reference. Default: 50 BTU/hr. Adjustable per session alongside the tolerance band. Projects within this threshold display as green (accurate) regardless of change direction.
- **Import fidelity** — Validation that VRC's project inputs faithfully reproduce what was extracted from the Salas PDF. Checks total floor area, total volume, orientation, and room count. Computed at import time and stored. Poor import fidelity renders output comparison unreliable.

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
