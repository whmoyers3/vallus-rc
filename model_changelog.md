# VRC Engine Changelog

Record engine changes here with the snapshot filename so results can be traced back.

## Format

```
## YYYY-MM-DD — Short description

**Changed:** which constant, formula, or file

**Reason:** what bias or error motivated the change

**Result:** how many battery projects improved/regressed. Snapshot file name.
```

---

<!-- Add entries below, newest first -->

## 2026-06-30 — Foamed/sprayed attic W3 cooling CLTD

**Changed:**
- `calculator.py` now detects project-level foamed/sprayed attic evidence from roof/ceiling assemblies (`R1`/`R2`/`C1`/`C2`) or explicit metadata flags and applies W3 cooling CLTD `15` instead of the vented-attic W3 default `55`.
- The rule does not trigger from W3 alone. If multiple roof/ceiling assemblies are present and any ordinary/blank condition remains, global W3 reduction is withheld unless the W3 row has an explicit `cooling_cltd` override.
- Component diagnostics and detail-report variance keys now use the same project-level W3 method as the load calculation.

**Reason:** Dusty King's load-design/component evidence showed `R1`/`R2` as sprayed roof/ceiling insulation. Salas treated the W3 attic/kneewall cooling row with CLTD `15`, while the default VRC attic-wall CLTD `55` over-predicted cooling. This implements the general rule from the baseline-takeoff handoff while preserving W3 geometry and full heating delta-T.

**Result:** Focused W3 inference tests cover default, sprayed/foam, ordinary, and mixed ceiling evidence. Explicit row `cooling_cltd` still wins.

## 2026-06-07 — UBsmt room metrics, source filename identity, and directional wall inference

**Changed:**
- `salas_pdf_import.py` now preserves the uploaded Salas PDF filename in the generated Markdown title and emits per-room `Floor Area` / `Volume` rows from both the normal room-input tables and the Details / Troubleshooting fallback.
- `markdown_import.py` now prefers explicit per-room floor area and volume over inferred component-area heuristics.
- `calculator.py` gives directional W1 walls precedence over garage/partition name matching, so a room named `Garage Entry Hall` does not cause a normal `SouthEast` exterior wall to be treated as a garage boundary.
- `database.py`, `detail_report.py`, and the admin UI now use/display the full source identity where available. Battery duplicate replacement keys on `plan_name + foundation + elevation + orientation + variations`, and labels prefer `metadata.source_filename`.

**Reason:** The detail report showed the largest misses concentrated in failed-fidelity UBsmt imports. The old importer guessed room area/volume from envelope components, which overcounted basement/garage-adjacent spaces (e.g. Mansfield UBsmt imported as 3,550 sf / 30,564 cf vs Salas 3,326 sf / 28,548 cf). Separately, admin labels collapsed source variants to generic names like `Mansfield`, allowing variant duplicates to overwrite each other, and `Garage Entry Hall SouthEast` was misclassified because name matching saw `Garage`.

**Result:** Fresh import checks now match Salas area/volume exactly for the UBsmt samples. Mansfield P UBsmt improved from report delta `+537 cool / +467 heat` to `-83 cool / -90 heat`. Tranquility UBsmt SW-Facing improved from `-116 cool / -567 heat` to `+16 cool / -77 heat`. Focused import/wall/screenshot tests pass; frontend build passes. Full suite still has unrelated pre-existing report-signature and live-Supabase test failures.

## 2026-06-07 — Mechanical ventilation: editor toggle + bedroom-derived default CFM

**Finding:** Salas's ventilation CFM is `15 × (bedrooms + 1)` (15 CFM per assumed occupant) — exact on all six ACH50 examples (3-bed→60, 4-bed→75, 6-bed→105); floor area does not enter.

**Changed:**
- `calculator.py` now derives the infiltration scale from `outside_air_cfm` when present (effective ACH = `cfm × 60 / volume`), else `natural_ach` — one formula, in the engine. (Importer passes Salas's CFM as `outside_air_cfm` instead of pre-computing the ACH.)
- `frontend/main.tsx` adds a **"Mechanical ventilation" checkbox**; when on it reveals a **Ventilation CFM** field pre-filled with `15 × (bedrooms + 1)` and overridable (type 100 for a specific design). Round-trips via `infiltration.outside_air_cfm`; legacy `natural_ach` is preserved as a pass-through.

**Result:** ACH50 imports unchanged (Finley −0.4%, Six Sisters −1.1%); non-ACH50 unchanged; from-scratch projects get an automatic, code-based default they can override. Frontend `tsc` clean; engine + import tests pass (18). Closes the "surface a mech-vent field in the UI" item from the prior entry; latent load remains the open refinement.

## 2026-06-07 — Mechanical ventilation (ACH50 tight homes) modeling

**Methodology (reverse-engineered from ACH50 vs non-ACH50 twins):** Salas's `…ACH50` reports model a home tight enough (lower blower-door ACH50, e.g. 3.0 vs 5.0) to require mechanical ventilation per ASHRAE 62.2. Page 0 shows "Mechanical Ventilation YES" + a "House Outside Air CFM" (e.g. 75). The natural infiltration drops to a blower-door-derived rate (Finley: 58.70 CFM ≈ 0.145 ACH; infiltration cooling = `1.08 × 58.70 × ΔT = 1268`, verified exactly), and the **outside-air ventilation CFM drives the effective air load** — the net air load equals `1.08 × outside_air_cfm × ΔT` (Finley 30,044→29,424 = −620 = `(0.25-ACH − 75-CFM) × 1.1`). So the ventilation requirement supersedes the reduced natural infiltration.

**Changed:** `salas_pdf_import.py` extracts the mech-vent CFM from page 0 and emits `**Mechanical Ventilation CFM:**`. `markdown_import.py` models it as an effective `natural_ach = outside_air_cfm × 60 / volume`, routed through the existing infiltration-scale path (the same machinery as the legacy-ACH override), and records `mechanical_ventilation` + `outside_air_cfm` in metadata.

**Result (6 ACH50 examples):** Finley −0.4%, Tranquility −0.1%, Ash B −0.3%, Belfort −0.1%, Carrington −0.1%, Six Sisters −1.1%. Non-ACH50 set unchanged (Finley/Tranquility/Williams/Dogwood). Engine + import tests pass (18).

**Path / future refinements:** (1) This models ventilation as an effective infiltration ACH — numerically faithful to Salas's *sensible* loads. A fully native model would carry `mode = mechanical_ventilation` + `outside_air_cfm` through the engine's ventilation path (already exists for explicit infiltration line items) and make the auto-infiltration path honor it. (2) **Latent load** from outdoor air isn't modeled (VRC is sensible-only today). (3) Air load currently uses ventilation CFM directly; the stricter rule is `max(natural infiltration, required ventilation)` — matters only if a tight home's infiltration exceeds its 62.2 requirement. (4) Six Sisters (−1.1%, basement) suggests a basement-infiltration nuance worth a look. (5) Surface a mech-vent / outside-air-CFM field in the editor UI.

## 2026-06-07 — Dogwood: per-unit summary parse + building-type detection fix

**Changed:**
- `salas_pdf_import.py` `extract_unit_info` now parses **per-unit** floor area / cooling / heating from page 0 (the columns are unit-ordered, 2 cols per unit) and assigns them per unit; `render_markdown`'s Unit Summary uses the per-unit values. House totals are the sums.
- `markdown_import.py` building-type auto-detect no longer treats **multiple units** as a townhome — it keys on the plan-name keyword only.

**Reason:** Dogwood is a two-unit building (Unit 1 First Floor / Unit 2 Second Floor). (1) The importer extracted only the first unit's load/area and mirrored it onto every unit, so Unit 2 duplicated Unit 1 (1,182 SF / 13,319) — the long-standing import-doubling bug; Dogwood had been *excluded* from accuracy stats because of it. (2) Multi-unit also tripped the townhouse detector, but stacked floor-zoned units are single-family, not townhomes (those import as separate single-unit PDFs).

**Result:** Dogwood Unit Summary now distinct (Unit 1 1,182 SF/13,319/17,811; Unit 2 1,492 SF/14,533/17,803), matching Salas page 0. With correct single-family typing, Dogwood system cooling is **+0.2%** vs Salas (was the +110% doubling artifact). Single-unit projects unchanged (Finley −0.4%, Williams −0.3%); Evergreen still townhouse via name (+0.2%). **All five test homes now within ±0.4%.** Dogwood can be re-included in battery accuracy stats. Engine + import tests pass (18).

## 2026-06-07 — Legacy natural-ACH infiltration as a non-destructive import override

**Changed:** `models.py` adds `Infiltration.natural_ach` (default None). `formulas.py` `standard_infiltration_load` takes a `scale` (default 1.0). `calculator.py` computes `infiltration_scale = natural_ach / 0.25` (1.0 when None) and threads it through level/line-item. `salas_pdf_import.py` extracts natural ACH from the cooling-table infiltration row and emits `**Natural ACH:**`; `markdown_import.py` reads it onto `infiltration.natural_ach`.

**Reason:** Williams is a pre-state-code-change calc where Salas scaled infiltration by the natural ACH (0.35 → factor 0.13 = 0.09 × 0.35/0.25), under-counting VRC by ~1,016 BTU/hr (the entire −3.5%). The current 0.09/0.24 model (= 0.25 ACH) is correct for newer calcs and from-scratch, so it must not change. Per Will: keep the current model, apply the old method only when the import carries it.

**Result (non-destructive):** Williams −3.5% → **−0.3%**. The 0.25-ACH imports (Finley −0.4%, Tranquility −0.4%, Evergreen +0.2%) are unchanged because scale = 1.0. From-scratch projects have `natural_ach = None` → current model untouched. **All four test homes now within ±0.4% at the system level, with every component category matching.** Engine + import tests pass (18).

**Note:** This assumes the legacy linear relationship (factor = 0.36 × ACH cooling, 0.96 × ACH heating, baseline 0.25 ACH). Detection is "ACH printed in the infiltration row" — if a *new-method* PDF also prints an ACH but doesn't follow this linear scaling, gate the override on calc date/era instead.

## 2026-06-07 — Per-room CLTD in SECTION 3 fixes garage-door (D2) variance

**Changed:** `salas_pdf_import.py` adds a per-room **CLTD column** to the SECTION 3 room table (the value is already known per room — `room_data` is keyed by the full component key incl. CLTD). `markdown_import.py` now populates a line item's `cooling_cltd` from that per-room CLTD (non-directional opaque, except vaulted C2), falling back to the schedule; the comparison parser uses it for the match key too.

**Reason:** Doors swung ±25–66% because D2 garage doors carry different CLTDs per instance (e.g. Finley first-floor 30 vs second-floor 15), but they share the `(code, "Door")` variant — so the schedule lookup collapsed to the last value. The per-room CLTD de-collapses them. This generalizes to any component that shares a `(code, variant)` but differs by room.

**Result:** Doors now match exactly — Finley 336/336, Tranquility 514/515, Evergreen 336/336, Williams 577/576 (was −45% to +66%). System totals: Finley −0.4%, Tranquility −0.4%, Evergreen +0.2%, Williams −3.5%. Backward compatible (older 3-col SECTION 3 markdown still imports — col 5 is read only when present). Engine + import tests pass (18).

**Remaining:** Williams system −3.5% is now traceable to **non-envelope** loads (infiltration / internal gains), since all envelope components (glass, wall, ceiling, door) match closely. Vaulted C2 still pairs as separate specs in the per-component view (salas key 55 vs VRC 78) though by-type ceiling nets ~0 — cosmetic.

## 2026-06-07 — Vaulted ceiling CLTD 55 → 78 (Option A: fixed 45° slope factor)

**Changed:** `constants.py` `SPECIAL_CLTD["VAULTED_CEILING"]` 55 → 78; `markdown_import.py` now skips populating C2 (vaulted) CLTD from the schedule so the engine default is used.

**Reason:** Salas's reported vaulted-ceiling loads imply an effective CLTD of **77.8 = 55 × √2** on both Finley and Williams (a 45° roof-slope factor: sloped area = projected × √2). Its schedule *displays* 55 for vaulted but computes with ~78, so reading 55 from the schedule under-predicted vaulted by ~30%.

**Result:** Ceiling now matches Salas across all four test PDFs (deltas 0.0–0.3%). C2 vaulted exact (e.g. Williams salas 1,752 / vrc 1,756). System totals: Finley −0.9%, Tranquility −0.8%, Evergreen +1.2%, Williams −3.0% (all improved). Engine + import tests pass (18).

**⚠️ Option A assumption (how to know when to switch to B):** This assumes a fixed 45° pitch. If a future resload shows an **effective vaulted CLTD ≠ 78** (ratio-to-55 ≠ √2 ≈ 1.414), the roof pitch differs — switch to **Option B**: apply a per-project sloped-area factor to the vaulted *area* instead of a fixed CLTD. Documented at `constants.py` `VAULTED_CEILING` and in `MODEL_DEV.md` → "Known Model Assumptions."

## 2026-06-07 — Full-precision U-values from construction schedule (fixes wall/ceiling variance)

**Changed:** `salas_pdf_import.py` — new `_construction_u_values()` parses the cover-page Construction Descriptions table (page 0) for full-precision U; `render_markdown` uses it for the SECTION 1 U column instead of the 2-decimal value shown in the per-component cooling tables.

**Reason:** The cooling tables display U rounded to 2 decimals (0.077→0.08, 0.033→0.03, 0.053→0.05), and the importer was sourcing U from there. Salas computes loads with full precision, so VRC over/under-predicted every opaque component: walls +3.9% (0.08 vs 0.077), flat ceiling −9% (0.03 vs 0.033). This was the "variance that shouldn't be there" since inputs are pulled directly from Salas.

**Result (component-level vs Salas, after fix):** Walls ~0% (was +3.5%); flat ceiling C1 now exact (Finley salas 5,277 / vrc 5,276; Williams 4,573 / 4,587). System totals shifted (Finley −0.6%→−2.5%, Tranquility −1.7%→−3.4%, Williams −6.0%→−4.8%, Evergreen +2.2%→+0.7%) because the old wall over-prediction had been *canceling* real under-predictions — components are now honest. Engine + import tests pass (18).

**Remaining (diagnosed, not yet fixed):**
- **Vaulted ceiling (C2):** Salas effective CLTD ≈ 77.8 (= 55 × √2 slope factor) in both Finley and Williams; engine uses 55. The schedule shows 55 but Salas computes with ~78. Candidate fix: `VAULTED_CEILING` 55 → 78, and don't let the importer overwrite it with the schedule's 55.
- **Garage door (D2):** `(code, "Door")` variant collapse — first/second-floor D2 carry different CLTDs (30/15) and only the last survives.

## 2026-06-07 — Detail report: Salas ceiling values were dropped (R→C code mismatch)

**Changed:** `markdown_import.py` `_comparison_from_markdown` now normalizes component codes with `_normalized_code` (R1→C1, R2→C2) in both the `_master_specs` keying and the 5-col room-component parse.

**Reason:** The detail report showed `Ceiling total_salas_cool = 0` while VRC had loads. The engine normalizes ceiling codes R1/R2→C1/C2, but the comparison parser kept the raw Salas `R1`/`R2`. `_component_type("R1")` returns `"R1"` (R not in the type map), which fails the `(Glass, Wall, Ceiling, Floor, Door)` filter, so every Salas ceiling row was silently dropped — Salas ceiling read 0 and VRC ceiling had no match. Wall/Glass/Door codes already matched, which is why only Ceiling was affected.

**Result:** Finley detail report Ceiling now Salas 6,716 vs VRC 6,753 (**+0.6%**) instead of 0. Engine + import tests pass (18). Observed separately (not yet fixed): Door shows ~−45% (VRC under-predicts) — partly the D2 garage-door `(code, "Door")` variant collapse where first/second-floor doors carry different CLTDs; small absolute load, flagged for follow-up.

## 2026-06-07 — Townhouse glass verified against Evergreen TH; application corrected

**Changed:**
- `calculator.py` — townhouse glass no longer goes through the SHGF formula. `TOWNHOUSE_GLASS_LOAD_FACTORS` is a **combined** Btu/hr-sf table applied directly per true orientation. Renamed `glass_table_for` → `combined_glass_factors_for`; threaded `combined_glass_factors` through level/line-item; single-family path unchanged.
- `constants.py` — `TOWNHOUSE_GLASS_LOAD_FACTORS["NE"]` 26 → 21 to match Salas (single-sample; flagged for re-confirmation).

**Reason:** Verifying against `Evergreen TH A Slab Left RH-Garage` showed the prior wiring (treating the townhouse table as an SHGF: `U×14 + SHGC×table`) produced ~13 Btu/hr-sf for west glass vs Salas's 37. Decoding the PDF by true orientation (house faces East) showed the stored table *is* the combined factor: 9/10 orientations matched exactly (NE was 26 vs Salas 21). Townhouse factors are higher and more E/W-symmetric than single-family — so the earlier "townhouses use a lower SHGF table (inter-unit shading)" assumption in ADR 0001 was wrong.

**Result:** Evergreen detected as townhouse, engine cooling 24,693 vs Salas 24,156 (**+2.2%**). Glass now 10/10 vs Salas after the NE fix. Single-family unchanged (Finley −0.6%, Tranquility −1.7%). Engine + import tests pass (18). ADR 0001 / CONTEXT.md building-type note corrected.

## 2026-06-07 — Building type (SFD/townhome) selector + detail-report keying fix

**Changed:**
- `models.py` / `calculator.py` / `serialization.py` — added `Project.building_type` (default `single_family`). New `glass_table_for()` selects `TOWNHOUSE_GLASS_LOAD_FACTORS` for townhomes; threaded `scleff_by_direction` through `calculate_project → calculate_level → calculate_line_item` into the glass formula. Single-family passes `None` → unchanged default `SCLEFF_BY_DIRECTION`.
- `markdown_import.py` — `_comparison_from_markdown` now keys `_master_specs` by **(code, variant)** and the 5-col room parser reads the variant (col 1) it previously dropped, so the detail-report match key `(type_code, u_value, cltd/clf)` no longer collapses (kills the phantom "orientation mismatch"). Importer auto-detects `building_type` from plan naming / multi-unit structure (overridable).
- `frontend/src/main.tsx` — "Building type" selector (Single-family detached / Townhome) bound to `project.building_type`; round-trips through save/load and the calculate payload.

**Reason:** The townhouse SHGF table (`TOWNHOUSE_GLASS_LOAD_FACTORS`) existed but was never wired — townhomes were getting single-family solar gains. Separately, the comparison parser still collapsed per-variant factors to one row per code, corrupting the detail-report match key.

**Result:**
- SFD output unchanged (Finley 29,852 / Tranquility 30,710 — identical to prior run). Forcing townhome lowers cooling (Finley 28,494 / Tranquility 29,820) via the lower solar table.
- Comparison components now carry per-variant factors (W3 = 15, glass CLF per true direction) instead of the collapsed value.
- Both test PDFs auto-detect `single_family`. Frontend `tsc --noEmit` clean; engine + import tests pass (18). Detail-report match-key fix from prior follow-up list is now closed.

## 2026-06-07 — Importer fixes: positional header extraction + boundary CLTD as input

**Changed:**
- `salas_pdf_import.py` — added `extract_header_fields()` / `_cluster_header_lines()` that reconstruct cover-page rows by clustering words on their `top` coordinate, replacing flat `extract_text` for Location and House Faces. Wired into `extract_unit_info` and `render_markdown`. Strips the "Worst/Best" orientation qualifier from facing.
- `markdown_import.py` — SECTION 1 now builds a `variant_specs[(code, variant)]` map (keyed by code **and** description) instead of collapsing to one row per code. Boundary (non-directional) opaque line items get `cooling_cltd` populated from the schedule; glass and directional walls stay formula-driven.

**Reason:** Location came back blank and Tranquility's facing was garbage ("9.0 ft 12621") — both were positioned form cells that flat text dropped. Separately, every W3 attic/kneewall used the hardcoded vented-attic CLTD 55, but Finley/Tranquility are conditioned attics (Salas CLTD 15), driving a ~+6.7% cooling over-prediction.

**Result (Finley / Tranquility, sensible cooling vs Salas):**
- Finley: **+6.7% → −0.6%**; Tranquility: **+6.6% → −1.7%**. Heating unchanged (+1.3% / +0.9%).
- Location now "Jefferson, GA" / "Gainesville, GA"; facing NE / SW (no fallback warning); W3 `cooling_cltd` = 15 from import.
- Tests: `test_phase1_hickory_c`, `test_phase2_hickory_c` pass (no regression); `test_markdown_import` updated to assert boundary items carry imported CLTD while climate/orientation stay formula-driven. (API tests need live Supabase; not run here.)

**Not done (follow-ups):** `_comparison_from_markdown` still keys `_master_specs` by code only — the detail-report match key (comparison view, not engine accuracy) still needs the (code, variant) fix. Townhouse SHGF-table selection in `calculator.py` glass path is still unwired (deferred; no townhouse in this batch).

## 2026-06-07 — Glass cooling load formula reverse-engineered (verified)

**Changed:** Not yet implemented — finding recorded ahead of the engine change. See ADR 0001.

**Reason:** The glass CLF was believed to be an undiscovered Salas-internal value to be cataloged/learned. Decomposing the per-orientation glass numbers in `Finley 2A Slab CBonus` (SHGC 0.20, U 0.29) and `Tranquility UBsmt SW-Facing` (SHGC 0.18, U 0.30) shows it is fully computed:

> `glass Btu/hr·sf = U × 14 + SHGC × SHGF[true orientation]`

where `14` is the existing `GLASS_CLTD` and `SHGF` is the existing `SCLEFF_BY_DIRECTION` table. Verified across all 10 orientations × both houses = 20/20 matches to rounding (e.g. West: Finley `0.29×14 + 0.20×111 = 26.3 ≈ 26`; Tranquility `0.30×14 + 0.18×111 = 24.2 ≈ 24`). Two prerequisites surfaced: (1) **orientation must be rotated by house facing** to a true azimuth — both PDFs collapse onto one SHGF table only after rotation; the hardcoded `front_door_faces:"S"` defeats this; (2) **SHGF is latitude/month-dependent** — the recovered table is valid for north-Georgia latitude only.

**Result:** No snapshot yet. Implementation work: apply the formula for glass, parse `House Faces` and rotate orientation, select SF vs. townhouse SHGF table. The per-latitude SHGF table becomes the sole learned quantity for glass (the "bridge").

**ASHRAE provenance (confirmed against published sources, 2026-06-07):** Salas states the report is "based on ASHRAE Handbook of Fundamentals." Our recovered structure is exactly the ASHRAE **CLTD/SCL/CLF method**: `Q_glass = A·SC·SCL + A·U·CLTD` (SC≈SHGC; our `SCLEFF` = the SCL table; our `14` = the glass-conduction CLTD). The glass CLTD table peaks at **14 at solar hours 15–16 (3–4 PM)** — independently confirmed in two ASHRAE-derived course references — which is why our table is afternoon-asymmetric (E 38 ≪ W 111: east glass has no direct sun at 3 PM). Reference day July 21. To extend beyond north Georgia, source **Table 36 (SCL)** and **Table 34 (glass CLTD)** from HoF 1997 Ch. 28 at the target latitude; ASHRAE tabulates solar factors every 4° (32°N and 36°N bracket the Macon 32.8°N–Dalton 34.8°N region). Open item: diff `SCLEFF` against Table 36 at 32°/36°/40°N to confirm which latitude Salas's program embeds (determines whether GA needs one fixed table or per-latitude tables). **24°N ruled out (2026-06-07):** `SCLEFF` North = 7 vs. 24°N North = 27–43 across all zones/hours; `SCLEFF` North = Shaded = 7 means Salas treats north glass as diffuse-only, which only occurs well north of 24° — consistent with site latitude (~34°N) or a fixed 40°N. Next pull: Zone A (Soft) SCL at 32°N (and 40°N). Note SC ≈ SHGC/0.87, so published West SCL ≈ 96–111. Sources: energy-models.com (Varkie Thomas, IIT); ASHRAE 1997 Fundamentals Ch. 28 (tagengineering mirror); lorisweb HVAC course M06-004.

## 2026-06-06 — Dogwood excluded from aggregate accuracy stats

**Changed:** Battery record for Dogwood (two-unit townhome). `reference_valid = false` in the `calculations` table.

**Reason:** The Salas comparison snapshot for Dogwood shows Unit 2 with identical loads to Unit 1 (1,182 sf, same BTU/hr). VRC's inputs are correct (volume within 114 cf of Salas). The duplication is a `salas_pdf_import.py` parser bug that mirrors Unit 1 into Unit 2. Including Dogwood inflates aggregate cooling error by ~14,600 BTU/hr (109%) making it a statistical outlier.

**Result:** Dogwood excluded from `Recompute All` aggregate accuracy metrics and battery refresh totals until the PDF parser bug is fixed. Root cause is tracked separately — investigate `salas_pdf_import.py` unit summary section parsing.

**Action required:** Set `reference_valid = false` and `notes = 'Unit 2 Salas reference duplicates Unit 1 — parser bug in salas_pdf_import.py'` on the Dogwood battery row via Supabase dashboard or migration.
