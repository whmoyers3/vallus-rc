from __future__ import annotations

from fastapi.testclient import TestClient

from backend.api import create_app
from backend.api.code_compliance import build_code_compliance_warnings


def _payload(location: str, assemblies: dict) -> dict:
    return {
        "project": {
                "name": "Code Check",
                "location": location,
            "description": "Code Check",
            "design_conditions": {
                "outdoor_cooling_db": 95,
                "outdoor_heating_db": 18,
                "indoor_cooling_db": 75,
                "indoor_heating_db": 72,
            },
            "infiltration": {"mode": "standard_ach"},
            "assemblies": assemblies,
            "levels": [
                {
                    "name": "Main",
                    "floor_area": 1000,
                    "volume": 9000,
                    "selected_tons": 2,
                    "selected_kw": 10,
                    "line_items": [],
                }
            ],
        }
    }


def test_georgia_code_warnings_use_form_component_values():
    warnings = build_code_compliance_warnings(
        _payload(
            "Commerce, GA",
            {
                "W1": {"code": "W1", "u_value": 0.077, "description": "Above Grade - 2x4 R-13 batt"},
                "G1": {"code": "G1", "u_value": 0.35, "shgc": 0.28, "description": "Window SHGC 0.28"},
                "R1": {"code": "R1", "u_value": 0.026, "description": "Flat Ceiling R-38 blown"},
                "F1": {"code": "F1", "u_value": 0.053, "description": "Framed floor R-19 batt"},
            },
        )
    )

    assert warnings[0].startswith("Advisory Georgia code-minimum screening")
    assert any("G1" in warning and "above GA 3A glazed fenestration maximum SHGC 0.27" in warning for warning in warnings)
    assert not any("W1" in warning for warning in warnings)
    assert not any("R1" in warning for warning in warnings)
    assert not any("F1" in warning for warning in warnings)


def test_georgia_wall_warning_starts_below_r13():
    warnings = build_code_compliance_warnings(
        _payload(
            "Commerce, GA",
            {"W1": {"code": "W1", "u_value": 0.090, "description": "Above Grade - 2x4 R-11 batt"}},
        )
    )

    assert any("W1" in warning and "below GA 3A wood-frame wall minimum R-13" in warning for warning in warnings)


def test_georgia_zone_four_uses_amended_r38_ceiling_minimum():
    warnings = build_code_compliance_warnings(
        _payload(
            "Union County, GA",
            {"R1": {"code": "R1", "u_value": 0.026, "description": "Flat Ceiling R-38 blown"}},
        )
    )

    assert warnings == []


def test_georgia_r30_ceiling_allowance_requires_context():
    warnings = build_code_compliance_warnings(
        _payload(
            "Commerce, GA",
            {"R1": {"code": "R1", "description": "Flat Ceiling R-30 blown"}},
        )
    )

    assert any("GA R-30 ceiling allowance" in warning and "top plate" in warning for warning in warnings)


def test_georgia_r30_ceiling_with_raised_heel_does_not_warn():
    assert build_code_compliance_warnings(
        _payload(
            "Commerce, GA",
            {"R1": {"code": "R1", "description": "Flat Ceiling R-30 blown raised heel full-height over top plate"}},
        )
    ) == []


def test_georgia_spray_foam_roof_deck_uses_conditional_attic_allowance():
    warnings = build_code_compliance_warnings(
        _payload(
            "Commerce, GA",
            {"C1": {"code": "C1", "description": "Sprayed foam roof deck R-20 indirectly conditioned attic"}},
        )
    )

    assert any("indirectly conditioned attic allowance" in warning for warning in warnings)
    assert not any("below GA 3A ceiling minimum R-38" in warning for warning in warnings)


def test_georgia_attic_kneewall_requires_r18_when_roofline_not_insulated():
    warnings = build_code_compliance_warnings(
        _payload(
            "Commerce, GA",
            {"W3": {"code": "W3", "description": "Attic kneewall R-13 batt"}},
        )
    )

    assert any("W3" in warning and "attic kneewall minimum R-18" in warning for warning in warnings)


def test_georgia_cantilevered_floor_over_outside_air_requires_r30():
    warnings = build_code_compliance_warnings(
        _payload(
            "Commerce, GA",
            {"F2": {"code": "F2", "description": "Cantilevered floor over outside air R-19 batt"}},
        )
    )

    assert any("F2" in warning and "cantilevered floor over outside air minimum R-30" in warning for warning in warnings)


def test_georgia_skylight_uses_skylight_u_factor():
    warnings = build_code_compliance_warnings(
        _payload(
            "Commerce, GA",
            {"G2": {"code": "G2", "u_value": 0.60, "description": "Skylight U 0.60"}},
        )
    )

    assert any("G2" in warning and "skylight maximum U 0.55" in warning for warning in warnings)


def test_non_georgia_location_does_not_warn():
    assert build_code_compliance_warnings(
        _payload(
            "Asheville, NC",
            {"W1": {"code": "W1", "u_value": 0.077, "description": "Above Grade - 2x4 R-13 batt"}},
        )
    ) == []


def test_calculate_endpoint_returns_code_warnings(tmp_path):
    app = create_app(tmp_path / "code_compliance.sqlite3")
    client = TestClient(app)

    response = client.post(
        "/api/calculate",
        json=_payload(
            "Commerce, GA",
            {"W1": {"code": "W1", "u_value": 0.090, "description": "Above Grade - 2x4 R-11 batt"}},
        ),
    )

    assert response.status_code == 200
    assert any("below GA 3A wood-frame wall minimum R-13" in warning for warning in response.json()["warnings"])
