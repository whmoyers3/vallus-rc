# Phase 2 — Room-by-Room Loads, Airflow, and PDF Report

Read `resload_roadmap_v3.docx` (Sections 2, 3.4, 6, and 7) before writing any code.
Phase 1 must be complete (all assertions green) before starting Phase 2.
Phase 2 is **not complete** until every assertion below passes.

---

## Objective

Extend the engine to produce:
1. Per-room sensible cooling load and heat loss (BTU/hr)
2. Per-room supply airflow: CFM Cool, CFM Heat, CFM Avg
3. PDF report matching the Salas O'Brien 3-page format (Section 6 of roadmap)

### Airflow formulas
```
CFM_cool = room_sensible_btuh / (1.1 × (room_temp - leaving_air_temp_cool))
CFM_heat = room_heat_loss_btuh / (1.1 × (leaving_air_temp_heat - room_temp))
CFM_avg  = round((CFM_cool + CFM_heat) / 2)
```

Leaving air temperatures for this project:
- Cooling: 57.2 °F  → ΔT = 75 - 57.2 = 17.8 °F → divisor = 1.1 × 17.8 = 19.58
- Heating: 103.9 °F → ΔT = 103.9 - 72 = 31.9 °F → divisor = 1.1 × 31.9 = 35.09

---

## Reference Case: Hickory C Slab — First Floor Room-Level Loads

All values are BTU/hr **before** the floor-level safety factor. Same project as Phase 1.

### First Floor Room Cooling Loads (BTU/hr)

| Room         | Cooling BTU/hr |
|--------------|---------------|
| Foyer & Hall | 846           |
| Study        | 1,582         |
| Powder       | 299           |
| Family       | 4,111         |
| Breakfast    | 1,680         |
| Kitchen      | 3,461         |
| Mud          | 395           |
| Pantry       | 155           |
| **Total**    | **12,530**    |

### First Floor Room Heating Loads (BTU/hr)

| Room         | Heating BTU/hr |
|--------------|---------------|
| Foyer & Hall | 1,451         |
| Study        | 3,053         |
| Powder       | 582           |
| Family       | 3,983         |
| Breakfast    | 1,896         |
| Kitchen      | 2,198         |
| Mud          | 796           |
| Pantry       | 213           |
| **Total**    | **14,171**    |

---

## First Floor Airflow Assertions

These are from the Salas O'Brien airflow summary page (authoritative output).

```python
# Foyer & Hall
assert foyer_cfm_cool == 47
assert foyer_cfm_heat == 72
assert foyer_cfm_avg  == 59

# Family  
assert family_cfm_cool == 227
assert family_cfm_heat == 197
assert family_cfm_avg  == 212

# Kitchen
assert kitchen_cfm_cool == 191
assert kitchen_cfm_heat == 109
assert kitchen_cfm_avg  == 150

# Study
assert study_cfm_cool == 87
assert study_cfm_heat == 151
assert study_cfm_avg  == 119
```

---

## Second Floor Room Cooling Loads (BTU/hr)

| Room          | Cooling | Heating |
|---------------|---------|---------|
| Stairs        | 580     | 844     |
| Hallway       | 594     | 516     |
| Bed 2 WIC     | 440     | 679     |
| Bed 2         | 1,499   | 1,855   |
| Bath 2        | 327     | 430     |
| Bed 3         | 1,169   | 1,141   |
| Bed 3 WIC     | 185     | 319     |
| Bed 4 WIC     | 275     | 532     |
| Bed 4         | 1,440   | 1,184   |
| Bath 3        | 286     | 377     |
| Owners Bed    | 3,178   | 3,201   |
| **Total**     | **~12,806** | **~14,070** |

---

## Second Floor Airflow Assertions

```python
assert owners_bed_cfm_cool == 176
assert owners_bed_cfm_heat == 159
assert owners_bed_cfm_avg  == 167

assert bed2_cfm_cool == 83
assert bed2_cfm_heat == 92
assert bed2_cfm_avg  == 87

assert bed3_cfm_cool == 65
assert bed3_cfm_heat == 57
assert bed3_cfm_avg  == 61
```

---

## PDF Report Assertions

The generated PDF must contain the following exact strings (use pdfplumber or similar to extract text):

```python
assert "27870" in pdf_text or "27,870" in pdf_text   # whole-house sensible cooling
assert "32477" in pdf_text or "32,477" in pdf_text   # whole-house heating
assert "3.5 Tons" in pdf_text or "3.50" in pdf_text  # system size
assert "15.0 kW" in pdf_text or "15" in pdf_text     # heat kW
assert "1400" in pdf_text or "1,400" in pdf_text     # system CFM
assert "57.2" in pdf_text                             # leaving air temp cooling
assert "103.9" in pdf_text                            # leaving air temp heating
assert "Wehunt Preserve" in pdf_text                 # project name
assert "Braselton" in pdf_text                        # location
assert "Hickory" in pdf_text                          # description
assert "Family" in pdf_text                           # room name present
assert "Owners Bed" in pdf_text or "Owner" in pdf_text
```

The report must be exactly 3 pages (or 2 if project fits on 2 levels). Confirm page count.

---

## Instructions

1. Extend `tests/test_phase2_hickory_c.py` with all room-level and CFM assertions above.
2. Implement the PDF report generator (WeasyPrint) in `backend/reports/`.
3. Add `tests/test_phase2_report.py` with the PDF text assertions.
4. `pytest tests/test_phase2_*.py` must exit green before Phase 2 is complete.
5. Update Phase 2 status in `resload_roadmap_v3.docx` and append a Changelog entry.
