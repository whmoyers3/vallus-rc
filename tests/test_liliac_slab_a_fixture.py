import json
from pathlib import Path

import pdfplumber

from backend.api.serialization import project_from_payload
from backend.engine.calculator import calculate_project
from backend.reports import generate_resload_pdf


def test_liliac_slab_a_fixture_calculates_from_room_inputs():
    payload = json.loads(Path("frontend/src/fixtures/liliac_slab_a_room_cooling_loads.json").read_text())

    result = calculate_project(project_from_payload(payload))

    assert result.sensible_cooling == 24699
    assert result.heating == 27954
    assert result.system_tons == 3
    assert result.unit_results[0].sensible_cooling == result.sensible_cooling
    assert result.unit_results[0].heating == result.heating
    assert result.system_kw == 10
    assert result.system_cfm == 1200
    assert result.levels[0].cooling_subtotal == 22454
    assert result.levels[0].heating_subtotal == 24307
    assert len(result.levels[0].room_results) == 19


def test_c1_ceiling_rows_contribute_cooling_load():
    payload = json.loads(Path("frontend/src/fixtures/liliac_slab_a_room_cooling_loads.json").read_text())

    result = calculate_project(project_from_payload(payload))
    laundry = next(room for room in result.levels[0].room_results if room.name == "Laundry")

    assert laundry.cooling_btuh > 0


def test_liliac_slab_a_internal_gains_match_edited_report():
    payload = json.loads(Path("frontend/src/fixtures/liliac_slab_a_room_cooling_loads.json").read_text())
    line_items = payload["project"]["levels"][0]["line_items"]

    people_rooms = [
        item["room_name"]
        for item in line_items
        if item["kind"] == "internal_people"
    ]
    appliances = {
        item["room_name"]: item["watts"]
        for item in line_items
        if item["kind"] == "internal_watts"
    }

    assert people_rooms == [
        "Flex / Study",
        "Great Rm",
        "Master Bed",
        "Bed 4",
        "Bed 3",
        "Bed 2",
    ]
    assert appliances == {"Great Rm": 250, "Kitchen": 680, "Laundry": 200}
    assert "Master Bath" not in appliances


def test_liliac_slab_a_reference_orientation_is_east():
    payload = json.loads(Path("frontend/src/fixtures/liliac_slab_a_room_cooling_loads.json").read_text())

    assert payload["project"]["metadata"]["front_door_faces"] == "E"


def test_liliac_report_contains_redesigned_report_sections(tmp_path):
    payload = json.loads(Path("frontend/src/fixtures/liliac_slab_a_room_cooling_loads.json").read_text())
    project = project_from_payload(payload)
    result = calculate_project(project)
    output = tmp_path / "liliac_report.pdf"

    generate_resload_pdf(project, result, output)

    with pdfplumber.open(output) as pdf:
        text = "\n".join(page.extract_text() or "" for page in pdf.pages)

    assert "OVERALL UNIT / HOME SUMMARY" in text
    assert "AIRFLOW SUMMARY SHEET" in text
    assert "DETAILS / TROUBLESHOOTING SHEET" in text
    assert "TOTAL / QA" in text
    assert "Foyer" in text
    assert "Flex / Study" in text
    assert "Master Bed" in text
    assert "Bed 2" in text
    assert "House Faces:" in text
    assert "Worst E" in text
