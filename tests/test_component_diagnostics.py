from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path

from backend.api.component_diagnostics import build_component_diagnostics


FIXTURE_PATH = Path(__file__).parent / "reference_cases" / "hickory_c_slab.json"


def test_component_diagnostics_notes_takeoff_origin_and_exports_worst_case_rows():
    payload = deepcopy(json.loads(FIXTURE_PATH.read_text()))
    payload["project"].setdefault("metadata", {}).pop("salas_reference_orientation", None)

    report = build_component_diagnostics(payload)
    sweep_worst = max(report["orientation_sweep"], key=lambda row: row["sensible_cooling_btuh"])
    worst_case = report["worst_case_orientation"]

    assert any("salas_reference_orientation is expected to be null" in note for note in report["diagnostic_notes"])
    assert worst_case["facing"] == sweep_worst["facing"]
    assert worst_case["rotation_steps"] == sweep_worst["rotation_steps"]
    assert worst_case["system"]["sensible_cooling_btuh"] == sweep_worst["sensible_cooling_btuh"]
    assert len(worst_case["component_rows"]) == len(report["component_rows"])
    assert worst_case["glass_audit"]["summary"]["total_area"] == report["glass_audit"]["summary"]["total_area"]
