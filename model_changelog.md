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
