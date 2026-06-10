from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend.engine import (
    Assembly,
    DesignConditions,
    Infiltration,
    Level,
    LineItem,
    Project,
    Room,
    calculate_project,
    cooling_component_load,
    glass_load_factor,
    heating_component_load,
    standard_infiltration_load,
)


FIXTURE_PATH = Path(__file__).parent / "reference_cases" / "hickory_c_slab.json"


def _load_fixture() -> dict:
    return json.loads(FIXTURE_PATH.read_text())


def _assembly_from_dict(data: dict) -> Assembly:
    return Assembly(
        code=data["code"],
        u_value=data.get("u_value"),
        shgc=data.get("shgc"),
        description=data.get("description", ""),
    )


def _line_item_from_dict(data: dict, assemblies: dict[str, Assembly]) -> LineItem:
    assembly = assemblies.get(data["assembly"]) if "assembly" in data else None
    return LineItem(
        name=data["name"],
        kind=data["kind"],
        room_name=data.get("room_name"),
        area=data.get("area", 0.0),
        heating_area=data.get("heating_area"),
        volume=data.get("volume"),
        quantity=data.get("quantity", 0.0),
        watts=data.get("watts", 0.0),
        assembly=assembly,
        direction=data.get("direction"),
        cooling_load_factor=data.get("cooling_load_factor"),
        cooling_cltd=data.get("cooling_cltd"),
        heating_delta_t=data.get("heating_delta_t"),
        cooling_btuh=data.get("cooling_btuh"),
        heating_btuh=data.get("heating_btuh"),
    )


def _project_from_fixture(data: dict) -> Project:
    project_data = data["project"]
    assemblies = {
        key: _assembly_from_dict(value)
        for key, value in project_data["assemblies"].items()
    }
    levels = [
        Level(
            name=level["name"],
            floor_area=level["floor_area"],
            volume=level["volume"],
            selected_tons=level["selected_tons"],
            selected_kw=level["selected_kw"],
            rooms=[
                Room(
                    name=room["name"],
                    cooling_btuh=room.get("cooling_btuh", 0.0),
                    heating_btuh=room.get("heating_btuh", 0.0),
                    floor_area=room.get("floor_area", 0.0),
                    volume=room.get("volume", 0.0),
                )
                for room in level.get("rooms", [])
            ],
            cooling_cfm_divisor=level.get("cooling_cfm_divisor"),
            heating_cfm_divisor=level.get("heating_cfm_divisor"),
            auto_lighting_w_per_sf=level.get("auto_lighting_w_per_sf"),
            auto_infiltration=level.get("auto_infiltration", False),
            line_items=[
                _line_item_from_dict(item, assemblies)
                for item in level["line_items"]
            ],
        )
        for level in project_data["levels"]
    ]
    return Project(
        name=project_data["name"],
        location=project_data["location"],
        description=project_data["description"],
        design_conditions=DesignConditions(**project_data["design_conditions"]),
        infiltration=Infiltration(**project_data["infiltration"]),
        levels=levels,
        selected_system_tons=project_data.get("selected_system_tons"),
        selected_system_kw=project_data.get("selected_system_kw"),
        assemblies=assemblies,
    )


def test_component_level_assertions():
    assert round(cooling_component_load(367, 0.077, 16)) == 451
    assert round(cooling_component_load(1499, 0.026, 55)) == 2144
    assert round(cooling_component_load(1163, 0.100, 0)) == 0
    assert round(standard_infiltration_load(10467, mode="cooling")) == 942
    assert round(heating_component_load(1, 0.35, 54)) == 19
    assert round(heating_component_load(1163, 0.100, 27)) == 3140


@pytest.mark.parametrize(
    ("direction", "expected"),
    [
        # Fractional factors (u=0.35, shgc=0.22): SCLeff * 0.22 + 0.35 * 14
        ("N", 6.44),
        ("NE", 7.8326),  # SCLeff 13.33
        ("E", 13.26),
        ("SE", 14.36),
        ("S", 15.90),
        ("SW", 26.24),
        ("W", 29.32),
        ("NW", 18.32),
        ("Shaded", 6.44),
        ("Skylight", 46.04),
    ],
)
def test_hickory_glass_load_factors(direction: str, expected: float):
    assert glass_load_factor(direction, u_value=0.35, shgc=0.22) == pytest.approx(expected, abs=0.01)


def test_floor_level_hickory_reference_case():
    fixture = _load_fixture()
    result = calculate_project(_project_from_fixture(fixture))
    expected = fixture["expected"]

    first = result.levels[0]
    first_expected = expected["first_floor"]
    assert first.cooling_subtotal == first_expected["cooling_subtotal"]
    assert first.cooling_load == first_expected["cooling_load"]
    assert first.tons_min == pytest.approx(first_expected["tons_min"], abs=0.01)
    assert first.tons_selected == first_expected["tons_selected"]
    assert first.cfm == first_expected["cfm"]
    assert first.heating_subtotal == first_expected["heating_subtotal"]
    assert first.heat_loss == first_expected["heat_loss"]
    assert first.kw_min == pytest.approx(first_expected["kw_min"], abs=0.01)
    assert first.kw_selected == first_expected["kw_selected"]

    second = result.levels[1]
    second_expected = expected["second_floor"]
    assert second.cooling_subtotal == second_expected["cooling_subtotal"]
    assert second.cooling_load == second_expected["cooling_load"]
    assert second.tons_min == pytest.approx(second_expected["tons_min"], abs=0.01)
    assert second.tons_selected == second_expected["tons_selected"]
    assert second.cfm == second_expected["cfm"]
    assert second.heating_subtotal == second_expected["heating_subtotal"]
    assert second.heat_loss == second_expected["heat_loss"]
    assert second.kw_min == pytest.approx(second_expected["kw_min"], abs=0.01)
    assert second.kw_selected == second_expected["kw_selected"]


def test_whole_house_hickory_reference_case():
    fixture = _load_fixture()
    result = calculate_project(_project_from_fixture(fixture))
    expected = fixture["expected"]["whole_house"]

    assert result.sensible_cooling == expected["sensible_cooling"]
    assert result.heating == expected["heating"]
    assert result.tons_min == pytest.approx(expected["tons_min"], abs=0.01)
    assert result.system_tons == expected["system_tons"]
    assert result.system_kw == expected["system_kw"]
    assert result.system_cfm == expected["system_cfm"]
