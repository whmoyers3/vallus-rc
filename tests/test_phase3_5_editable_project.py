from __future__ import annotations

from fastapi.testclient import TestClient

from backend.api import create_app
from backend.engine.calculator import recommended_standard_tons


def editable_one_room_payload() -> dict:
    return {
        "project": {
            "name": "Manual One Room Test",
            "location": "Braselton, GA",
            "description": "Editable component input smoke test",
            "design_conditions": {
                "outdoor_cooling_db": 95,
                "outdoor_heating_db": 18,
                "indoor_cooling_db": 75,
                "indoor_heating_db": 72,
                "slab_delta_t": 27,
            },
            "infiltration": {"mode": "standard_ach"},
            "selected_system_tons": 1.0,
            "selected_system_kw": 5.0,
            "assemblies": {
                "W1": {
                    "code": "W1",
                    "u_value": 0.077,
                    "description": "Above Grade - 2x4 R-13 batt",
                },
                "G1": {
                    "code": "G1",
                    "u_value": 0.35,
                    "shgc": 0.22,
                    "description": "Double insulated, SHGC 0.22",
                },
            },
            "levels": [
                {
                    "name": "First Floor",
                    "floor_area": 120,
                    "volume": 1000,
                    "selected_tons": 1.0,
                    "selected_kw": 5.0,
                    "cooling_cfm_divisor": 18.1,
                    "heating_cfm_divisor": 20.2,
                    "auto_lighting_w_per_sf": 0.5,
                    "auto_infiltration": True,
                    "rooms": [{"name": "Test Room", "floor_area": 120, "volume": 1000}],
                    "line_items": [
                        {
                            "name": "South wall",
                            "kind": "opaque",
                            "room_name": "Test Room",
                            "assembly": "W1",
                            "area": 100,
                            "cooling_cltd": 16,
                            "heating_delta_t": 54,
                        },
                        {
                            "name": "West window",
                            "kind": "glass",
                            "room_name": "Test Room",
                            "assembly": "G1",
                            "direction": "W",
                            "area": 20,
                            "heating_delta_t": 54,
                        },
                    ],
                }
            ],
        }
    }


def test_editable_component_project_round_trip(tmp_path):
    client = TestClient(create_app(tmp_path / "editable.sqlite3"))
    payload = editable_one_room_payload()

    for level in payload["project"]["levels"]:
        for room in level["rooms"]:
            assert "cooling_btuh" not in room
            assert "heating_btuh" not in room

    created = client.post("/api/projects", json=payload)
    assert created.status_code == 201
    project_id = created.json()["id"]

    loads = client.get(f"/api/projects/{project_id}/loads")
    assert loads.status_code == 200
    data = loads.json()

    assert data["whole_house_sensible_cooling"] == 1098
    assert data["whole_house_heating"] == 1189
    assert data["system_tons"] == 1.0
    assert data["system_kw"] == 5.0
    assert data["system_cfm"] == 400

    level = data["levels"][0]
    assert level["cooling_subtotal"] == 998
    assert level["heating_subtotal"] == 1034

    room = level["rooms"][0]
    assert room["name"] == "Test Room"
    assert room["cooling_btuh"] == 998
    assert room["heating_btuh"] == 1034
    assert room["cfm_cool"] == 400
    assert room["cfm_heat"] == 400
    assert room["cfm_avg"] == 400

    report = client.get(f"/api/projects/{project_id}/report")
    assert report.status_code == 200
    assert report.headers["content-type"].startswith("application/pdf")
    assert len(report.content) > 5000


def test_recommended_standard_tons_uses_special_four_to_five_threshold():
    assert recommended_standard_tons(3.09) == 3.0
    assert recommended_standard_tons(3.10) == 3.5
    assert recommended_standard_tons(4.24) == 4.0
    assert recommended_standard_tons(4.25) == 5.0
