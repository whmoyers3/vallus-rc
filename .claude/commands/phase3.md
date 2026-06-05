# Phase 3 — Web UI, Project Save/Load, and Construction Assembly Library

Read `resload_roadmap_v3.docx` (Sections 2, 7, and 8) before writing any code.
Phases 1 and 2 must be complete before starting Phase 3.
Phase 3 is **not complete** until the acceptance criteria below are met.

---

## Objective

Build the React + TypeScript frontend and wire it to the Phase 1/2 engine via FastAPI:

1. **Project tree sidebar** — Project → Floor → Room navigation
2. **Room input form** — tabbed entry for walls, windows, roof, floor, internal gains, infiltration
3. **Live results panel** — real-time BTU/hr and CFM as inputs change
4. **Project summary view** — system sizing totals and room-by-room airflow table
5. **Project save/load** — SQLite persistence via FastAPI
6. **Construction assembly library** — pre-filled W1/W2/W3/R1/R2/F1/F2/G1 templates

---

## Acceptance Criterion — Round-Trip Test

The UI acceptance test is an end-to-end round-trip: enter the Hickory C Slab project through
the UI, save it, reload it, generate the report, and confirm the numbers match Phase 1/2.

### Manual acceptance checklist (run once, record result)

- [ ] Create new project: "Hickory C Slab Test", Braselton GA, 4 bedrooms, SEER 14
- [ ] Enter design conditions: 95/75°F cooling, 18/72°F heating, 0.25 ACH
- [ ] Add G1 assembly: U=0.35, SHGC=0.22, blinds/draperies
- [ ] Add first floor (9 ft ceiling, 1163 sf) with rooms and envelope data per Phase 1 fixture
- [ ] Confirm live results panel shows first floor cooling ≈ 12,530 BTU/hr (before SF)
- [ ] Confirm system summary shows 3.5 tons / 15 kW / 1400 CFM
- [ ] Save project → reload → totals unchanged
- [ ] Generate PDF → confirm it matches Phase 2 report assertions

### Automated API test

```python
# POST /api/projects with full Hickory C payload
response = client.post("/api/projects", json=hickory_c_payload)
assert response.status_code == 201
project_id = response.json()["id"]

# GET /api/projects/{id}/loads
loads = client.get(f"/api/projects/{project_id}/loads").json()
assert loads["whole_house_sensible_cooling"] == 27870
assert loads["whole_house_heating"] == 32477
assert loads["system_tons"] == 3.5
assert loads["system_kw"] == 15.0

# GET /api/projects/{id}/report (PDF)
report = client.get(f"/api/projects/{project_id}/report")
assert report.status_code == 200
assert report.headers["content-type"] == "application/pdf"
assert len(report.content) > 10000  # non-trivial PDF
```

---

## Construction Assembly Library

Pre-populate the database with these standard assemblies so users can select rather than type:

| Code | U-value | Label |
|------|---------|-------|
| W1   | 0.077   | Above Grade — 2×4 R-13 batt |
| W1   | 0.060   | Above Grade — 2×4 R-15 batt |
| W1   | 0.048   | Above Grade — 2×6 R-19 batt |
| D1   | 0.130   | Exterior Door R-7.7 |
| D1   | 0.200   | Exterior Door R-5 |
| D2   | 0.083   | Garage Door R-12 |
| D2   | 0.500   | Garage Door R-2 |
| R1   | 0.026   | Flat Ceiling R-38 blown |
| R1   | 0.033   | Flat Ceiling R-30 blown |
| R1   | 0.031   | Flat Ceiling R-30 sprayed |
| F2   | 0.100   | Slab on grade |
| F1   | 0.053   | Framed floor R-19 batt |
| F1   | 0.026   | Framed floor R-38 batt |
| G1   | 0.350   | Double insulated, SHGC 0.22 |
| G1   | 0.320   | Double insulated, SHGC 0.22 |
| G1   | 0.330   | Double insulated, SHGC 0.19 |
| G1   | 0.340   | Double insulated, SHGC 0.27 |

---

## Instructions

1. Build the FastAPI routes in `backend/api/` and connect to the Phase 1/2 engine.
2. Build the React frontend per the UI spec in `resload_roadmap_v3.docx` Section 7.
3. Implement SQLite project persistence.
4. Seed the construction assembly library on first run.
5. Write `tests/test_phase3_api.py` with the automated API test above.
6. Run the manual acceptance checklist and record pass/fail in the Changelog.
7. Update Phase 3 status in `resload_roadmap_v3.docx` and append a Changelog entry.
