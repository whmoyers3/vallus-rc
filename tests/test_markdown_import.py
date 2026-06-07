from fastapi.testclient import TestClient

from backend.api import create_app
from backend.api.markdown_import import import_room_cooling_markdown


MARKDOWN = """# Example Plan — Cooling Load Data Export
**Project:** Example Community; Builder
**Location:** Flowery Branch, GA

## SECTION 1 — Master Component Reference

| Type | Description | CLTD (°F) | U-Value (Btu/hr-sf-°F) | SHGC | Cooling Load Factor |
|------|-------------|-----------|--------------------------|------|---------------------|
| G1 | West (Glass) | — | 0.35 | 0.22 | 29 Btu/hr-sf |
| W1 | West — Above Grade Wall | 23 | 0.08 | — | 1.77 Btu/hr-sf |
| R1 | Flat Ceiling | 55 | 0.03 | — | 1.43 Btu/hr-sf |
| F2 | Slab | 0 | 0.10 | — | 0.00 Btu/hr-sf |
| — | People | — | — | — | 255 Btu/hr per person |

## SECTION 2 — Units & Zones

### Unit Summary

| Unit | Description | System Size | Airflow | Heat | Total Floor Area | Sensible Cooling Load | Sensible Heating Load |
|------|-------------|-------------|---------|------|------------------|-----------------------|-----------------------|
| Unit 1 | Whole House | 2.0 Tons | 800 CFM | 10 kW | 120 SF | 99,999 Btu/hr | 99,999 Btu/hr |

## SECTION 3 — Room-by-Room User Inputs

### Great Rm
**Unit:** Unit 1 | **Zone:** First Floor | **Ceiling Height:** 9 ft
**Cooling Subtotal:** 1,234 Btu/hr  |  **Heating Subtotal:** 2,345 Btu/hr
**Airflow:** 67 Cool / 89 Heat / 78 Avg CFM

| Type | Description | Qty |
|------|-------------|----:|
| G1 | West (Glass) | 20 sf |
| W1 | West — Above Grade Wall | 100 sf |
| R1 | Flat Ceiling | 120 sf |
| F2 | Slab | 120 sf |
| — | People | 1 person |
"""


def test_markdown_import_builds_editable_user_input_payload():
    payload, warnings = import_room_cooling_markdown(MARKDOWN, "example.md")
    project = payload["project"]
    level = project["levels"][0]

    assert project["name"] == "Example Plan"
    assert project["assemblies"]["G1"]["u_value"] == 0.35
    assert project["assemblies"]["G1"]["shgc"] == 0.22
    assert project["assemblies"]["C1"]["u_value"] == 0.03
    assert level["rooms"][0]["zone_id"] == "zone-unit-1-first-floor"
    assert level["rooms"][0]["floor_area"] == 120
    assert level["line_items"][0]["direction"] == "W"
    assert all("cooling_btuh" not in item and "heating_btuh" not in item for item in level["line_items"])
    # Climate/orientation factors (glass, directional walls) stay formula-driven —
    # no per-item override. Boundary CLTDs (ceiling, slab) are imported from the
    # schedule as per-project inputs.
    climate_items = [i for i in level["line_items"] if i.get("direction") or str(i.get("assembly", "")).startswith("G")]
    assert all("cooling_load_factor" not in i and "cooling_cltd" not in i for i in climate_items)
    boundary = {i["assembly"]: i for i in level["line_items"] if not i.get("direction") and i.get("kind") == "opaque"}
    assert boundary["C1"]["cooling_cltd"] == 55
    assert boundary["F2"]["cooling_cltd"] == 0
    comparison = project["metadata"]["salas_obrien_comparison"]
    assert comparison["units"][0]["cooling_btuh"] == 99999
    assert comparison["rooms"]["Great Rm"]["cooling_btuh"] == 1234
    assert comparison["rooms"]["Great Rm"]["cfm_avg"] == 78
    assert "Front door facing" in warnings[0]


def test_pdf_markdown_import_uses_uploaded_pdf_filename_as_plan_name():
    pdf_markdown = MARKDOWN.replace(
        "# Example Plan — Cooling Load Data Export",
        "# Ash B Slab Bed4 Loft Resload.pdf — Cooling Load Data Export",
    ).replace(
        "**Location:** Flowery Branch, GA",
        "**Description:** Ash - B, Slab, Bed4 Loft\n**Location:** Flowery Branch, GA",
    )

    payload, _warnings = import_room_cooling_markdown(pdf_markdown, "Ash B Slab Bed4 Loft Resload.md")
    project = payload["project"]

    assert project["name"] == "Ash B Slab Bed4 Loft Resload.pdf"
    assert project["plan_name"] == "Ash B Slab Bed4 Loft Resload.pdf"
    assert project["foundation"] == "Slab"
    assert project["elevation"] == "B"
    assert project["metadata"]["source_filename"] == "Ash B Slab Bed4 Loft Resload.pdf"
    assert project["metadata"]["salas_plan_name"] == "Ash"


def test_markdown_import_prefers_explicit_room_area_and_volume():
    explicit_metrics = MARKDOWN.replace(
        "**Unit:** Unit 1 | **Zone:** First Floor | **Ceiling Height:** 9 ft",
        "**Unit:** Unit 1 | **Zone:** First Floor | **Ceiling Height:** 9 ft\n"
        "**Floor Area:** 100 SF\n"
        "**Volume:** 900 CF",
    ).replace(
        "| F2 | Slab | 120 sf |",
        "| F2 | Slab | 160 sf |",
    )

    payload, _warnings = import_room_cooling_markdown(explicit_metrics, "example.md")
    room = payload["project"]["levels"][0]["rooms"][0]

    assert room["floor_area"] == 100
    assert room["lighting_area"] == 100
    assert room["volume"] == 900


def test_markdown_import_requires_glass_u_value_and_shgc():
    missing = MARKDOWN.replace("| G1 | West (Glass) | — | 0.35 | 0.22 |", "| G1 | West (Glass) | — | — | — |")
    client = TestClient(create_app(":memory:"))

    response = client.post("/api/import/room-cooling-markdown", json={"filename": "missing.md", "text": missing})

    assert response.status_code == 422
    assert "missing U-value or SHGC for G1" in response.json()["detail"]


def test_markdown_import_sums_all_unit_system_sizes():
    multi_unit = MARKDOWN.replace(
        "| Unit 1 | Whole House | 2.0 Tons | 800 CFM | 10 kW | 120 SF | 99,999 Btu/hr | 99,999 Btu/hr |",
        "| Unit 1 | Main | 2.0 Tons | 800 CFM | 10 kW | 120 SF | 99,999 Btu/hr | 99,999 Btu/hr |\n"
        "| Unit 2 | Accessory | 1.5 Tons | 600 CFM | 5 kW | 80 SF | 99,999 Btu/hr | 99,999 Btu/hr |",
    ).replace(
        "### Great Rm\n**Unit:** Unit 1 | **Zone:** First Floor | **Ceiling Height:** 9 ft",
        "### Great Rm\n**Unit:** Unit 1 | **Zone:** First Floor | **Ceiling Height:** 9 ft",
    )
    multi_unit += """

### Studio
**Unit:** Unit 2 | **Zone:** Default | **Ceiling Height:** 8 ft

| Type | Description | Qty |
|------|-------------|----:|
| F2 | Slab | 80 sf |
"""

    payload, _warnings = import_room_cooling_markdown(multi_unit, "multi.md")
    project = payload["project"]
    units = project["metadata"]["units"]

    assert units[0]["selected_tons"] == 2.0
    assert units[1]["selected_tons"] == 1.5
    assert project["selected_system_tons"] == 3.5
    assert project["selected_system_kw"] == 15
