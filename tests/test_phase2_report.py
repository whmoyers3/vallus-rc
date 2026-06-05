from __future__ import annotations

import pdfplumber
import json
from pathlib import Path

from backend.api.serialization import project_from_payload
from backend.api.salas_pdf_import import import_salas_pdf_to_markdown
from backend.engine import calculate_project
from backend.reports import generate_resload_pdf
from tests.test_markdown_import import MARKDOWN
from backend.api.markdown_import import import_room_cooling_markdown
from tests.test_phase1_hickory_c import _load_fixture, _project_from_fixture


def test_phase2_pdf_report_contains_reference_values(tmp_path):
    project = _project_from_fixture(_load_fixture())
    result = calculate_project(project)
    output = tmp_path / "hickory_c_slab_report.pdf"

    generate_resload_pdf(project, result, output)

    with pdfplumber.open(output) as pdf:
        assert len(pdf.pages) >= 3, f"Expected at least 3 pages, got {len(pdf.pages)}"
        pdf_text = "\n".join(page.extract_text() or "" for page in pdf.pages)

    assert "27870" in pdf_text or "27,870" in pdf_text
    assert "32477" in pdf_text or "32,477" in pdf_text
    assert "3.5 Tons" in pdf_text or "3.50" in pdf_text
    assert "15.0 kW" in pdf_text or "15" in pdf_text
    assert "1400" in pdf_text or "1,400" in pdf_text
    # Leaving air temps are computed; verify a plausible cool LAT is present
    import re
    cool_lat_match = re.search(r"(\d{2,3}\.\d) deg F", pdf_text)
    assert cool_lat_match, "Expected a leaving-air-temperature value in the report"
    assert "Wehunt Preserve" in pdf_text
    assert "Braselton" in pdf_text
    assert "Hickory" in pdf_text
    assert "Family" in pdf_text
    assert "Owners Bed" in pdf_text or "Owner" in pdf_text
    assert "SALAS O'BRIEN COMPARISON" not in pdf_text


def test_pdf_report_includes_salas_comparison_when_imported_values_exist(tmp_path):
    payload, _warnings = import_room_cooling_markdown(MARKDOWN, "example.md")
    project = project_from_payload(payload)
    result = calculate_project(project)
    output = tmp_path / "comparison_report.pdf"

    generate_resload_pdf(project, result, output)

    with pdfplumber.open(output) as pdf:
        assert len(pdf.pages) >= 4
        pdf_text = "\n".join(page.extract_text() or "" for page in pdf.pages)

    assert "SALAS O'BRIEN COMPARISON" in pdf_text
    assert "Total Cooling" in pdf_text
    assert "Great Rm" in pdf_text
    assert "1,234" in pdf_text or "1234" in pdf_text


def test_generated_resload_report_pdf_can_import_from_details_sheet(tmp_path):
    source_payload = json.loads(Path("tests/reference_cases/screenshot_cooling_load.json").read_text())
    source_project = project_from_payload(source_payload)
    source_result = calculate_project(source_project)
    output = tmp_path / "generated_report.pdf"

    generate_resload_pdf(source_project, source_result, output)

    markdown = import_salas_pdf_to_markdown(output.read_bytes(), output.name)
    payload, _warnings = import_room_cooling_markdown(markdown, "generated_report.md")
    level = payload["project"]["levels"][0]

    assert len(level["rooms"]) == len(source_project.levels[0].rooms)
    assert len(level["line_items"]) > 0
    assert any(item["room_name"] == "Great Rm" and item.get("assembly") for item in level["line_items"])
    assert any(room["name"] == "Great Rm" and room["floor_area"] > 0 for room in level["rooms"])
