from __future__ import annotations

import json
from pathlib import Path

from backend.api.serialization import loads_response, project_from_payload
from backend.engine import calculate_project


def test_screenshot_fixture_uses_user_inputs_only():
    payload = json.loads(Path("tests/reference_cases/screenshot_cooling_load.json").read_text())
    level = payload["project"]["levels"][0]

    for item in level["line_items"]:
        assert "cooling_btuh" not in item
        assert "heating_btuh" not in item
        assert "cooling_load_factor" not in item
        assert "cooling_cltd" not in item
        assert item["name"] != "Lights"
        assert item["kind"] != "infiltration"

    result = loads_response(calculate_project(project_from_payload(payload)))

    assert result["levels"][0]["cooling_subtotal"] == 24792
    assert result["whole_house_sensible_cooling"] == 27271
    assert result["levels"][0]["heating_subtotal"] == 29203
    assert result["whole_house_heating"] == 33583

    rooms = {room["name"]: room for room in result["levels"][0]["rooms"]}
    assert rooms["Great Rm"]["cooling_btuh"] == 3658
    assert rooms["Bonus & Stairs"]["cooling_btuh"] == 5106
    assert rooms["Kitchen"]["cooling_btuh"] == 2854
