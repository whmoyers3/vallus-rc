# Phase 1 — Core Calculation Engine

Read `resload_roadmap_v3.docx` (Sections 2 and 3) before writing any code.
Phase 1 is **not complete** until every assertion in this file passes to within ±1 BTU/hr.

---

## Objective

Build the pure Python calculation engine in `backend/engine/` covering:
- Glass cooling load: `GLF = round(SCLeff × SHGC + U × 14)` with confirmed SCLeff table
- Wall/roof/floor/door cooling: `CLTD × U × Area`
- Heating loads: `U × ΔT × Area` for all envelope components
- Internal gains: people = 255 BTU/hr sensible, lights/appliances = 3.413 BTU/hr per watt
- Infiltration: cooling = `0.09 × volume_cf`, heating = `0.24 × volume_cf` (0.25 ACH standard)
- Safety factors: 10% cooling, 15% heating
- System sizing: `tons = sensible / 9000`, `kW = heat_loss / 3412`, `CFM = tons × 400`

---

## Reference Case: Hickory C Slab — Wehunt Preserve, Davidson Homes, Braselton GA

### Construction Assemblies

| Code | U-value | Description |
|------|---------|-------------|
| W1   | 0.077   | Above grade wall, 2×4 R-13 batt |
| D1   | 0.130   | Exterior door R-7.7 |
| D2   | 0.083   | Garage door R-12 |
| R1   | 0.026   | Flat ceiling R-38 blown |
| F2   | 0.100   | Slab on grade |
| G1   | U=0.35, SHGC=0.22 | Double insulated, blinds/draperies |

### Design Conditions

| Parameter | Value |
|-----------|-------|
| Outdoor cooling DB | 95 °F |
| Outdoor heating DB | 18 °F |
| Indoor cooling DB  | 75 °F |
| Indoor heating DB  | 72 °F |
| Cooling ΔT         | 20 °F |
| Heating ΔT         | 54 °F |
| Slab/grade ΔT      | 27 °F |
| ACH infiltration   | 0.25 ACH — cooling factor 0.09 BTU/hr-cf, heating 0.24 BTU/hr-cf |

### House Faces: Worst East — Glass Load Factors (actual compass → GLF)

| Compass | GLF (BTU/hr-sf) | Formula check |
|---------|-----------------|---------------|
| N       | 6               | round(7×0.22 + 0.35×14) = round(6.44) = 6 |
| NE      | 8               | round(14×0.22 + 4.9) = round(7.98) = 8 |
| E       | 13              | round(38×0.22 + 4.9) = round(13.26) = 13 |
| SE      | 14              | round(43×0.22 + 4.9) = round(14.36) = 14 |
| S       | 16              | round(50×0.22 + 4.9) = round(15.9) = 16 |
| SW      | 26              | round(97×0.22 + 4.9) = round(26.24) = 26 |
| W       | 29              | round(111×0.22 + 4.9) = round(29.32) = 29 |
| NW      | 18              | round(61×0.22 + 4.9) = round(18.32) = 18 |
| Shaded  | 6               | round(7×0.22 + 4.9) = round(6.44) = 6 |
| Skylight| 46              | round(187×0.22 + 4.9) = round(46.04) = 46 |

---

## Component-Level Assertions

Test these in isolation before running floor-level aggregation.

### Cooling

```python
# Wall — W1 South face, 367 sf, CLTD=16
assert round(16 * 0.077 * 367) == 452

# Roof — R1 flat ceiling, 1499 sf (2nd floor), CLTD=55
assert round(55 * 0.026 * 1499) == 2144

# Slab — F2, 1163 sf, CLTD=0
assert round(0 * 0.100 * 1163) == 0

# Infiltration — first floor, volume=10467 cf
assert round(0.09 * 10467) == 942

# Glass heating factor — G1 U=0.35
assert round(54 * 0.35) == 19  # 18.9 → displayed as 18.9 BTU/hr-sf

# Slab heating — F2, 1163 sf, ΔT=27
assert round(27 * 0.100 * 1163) == 3140
```

---

## Floor-Level Assertions

### First Floor  (Area = 1,163 sf, Volume = 10,467 cf)

```python
assert first_floor_cooling_subtotal == 12530   # BTU/hr before safety factor
assert first_floor_cooling_load     == 13784   # BTU/hr after 10% SF
assert first_floor_tons_min         == pytest.approx(1.53, abs=0.01)
assert first_floor_tons_selected    == 1.5
assert first_floor_cfm              == 600

assert first_floor_heating_subtotal == 14171   # BTU/hr before safety factor
assert first_floor_heat_loss        == 16297   # BTU/hr after 15% SF
assert first_floor_kw_min           == pytest.approx(4.77, abs=0.01)
assert first_floor_kw_selected      == 8
```

### Second Floor  (Area = 1,500 sf, Volume = 12,770 cf)

```python
assert second_floor_cooling_subtotal == 12806
assert second_floor_cooling_load     == 14087
assert second_floor_tons_min         == pytest.approx(1.57, abs=0.01)
assert second_floor_tons_selected    == 2.0
assert second_floor_cfm             == 800

assert second_floor_heating_subtotal == 14070
assert second_floor_heat_loss        == 16180
assert second_floor_kw_min          == pytest.approx(4.74, abs=0.01)
assert second_floor_kw_selected     == 8
```

---

## Whole-House Summary Assertions

```python
assert whole_house_sensible_cooling == 27870   # BTU/hr
assert whole_house_heating          == 32477   # BTU/hr
assert whole_house_tons_min         == pytest.approx(3.10, abs=0.01)
assert whole_house_system_tons      == 3.5
assert whole_house_system_kw        == 15.0
assert whole_house_system_cfm       == 1400
```

---

## Instructions

1. Store inputs and expected values in `tests/reference_cases/hickory_c_slab.json`.
2. Write `tests/test_phase1_hickory_c.py` — all assertions above must pass via `pytest`.
3. Do not mark Phase 1 complete until `pytest tests/test_phase1_hickory_c.py` exits green.
4. Update Phase 1 status in `resload_roadmap_v3.docx` Section 2 and append a Changelog entry.
