from __future__ import annotations

from dataclasses import replace

import pytest

from backend.engine import calculate_project
from tests.test_phase1_hickory_c import _load_fixture, _project_from_fixture


def _rooms_by_name(level_result):
    return {room.name: room for room in level_result.room_results}


def test_first_floor_room_loads_and_airflows():
    result = calculate_project(_project_from_fixture(_load_fixture()))
    first = result.levels[0]
    rooms = _rooms_by_name(first)

    expected_loads = {
        "Foyer & Hall": (846, 1451),
        "Study": (1582, 3053),
        "Powder": (299, 582),
        "Family": (4111, 3983),
        "Breakfast": (1680, 1896),
        "Kitchen": (3461, 2198),
        "Mud": (395, 796),
        "Pantry": (155, 213),
    }
    for name, (cooling, heating) in expected_loads.items():
        assert rooms[name].cooling_btuh == cooling
        assert rooms[name].heating_btuh == heating

    assert sum(room.cooling_btuh for room in rooms.values()) == 12529
    assert sum(room.heating_btuh for room in rooms.values()) == 14172

    assert rooms["Foyer & Hall"].cfm_cool == 47
    assert rooms["Foyer & Hall"].cfm_heat == 72
    assert rooms["Foyer & Hall"].cfm_avg == 60

    assert rooms["Family"].cfm_cool == 227
    assert rooms["Family"].cfm_heat == 197
    assert rooms["Family"].cfm_avg == 212

    assert rooms["Kitchen"].cfm_cool == 191
    assert rooms["Kitchen"].cfm_heat == 109
    assert rooms["Kitchen"].cfm_avg == 150

    assert rooms["Study"].cfm_cool == 87
    assert rooms["Study"].cfm_heat == 151
    assert rooms["Study"].cfm_avg == 119


def test_second_floor_room_loads_and_airflows():
    result = calculate_project(_project_from_fixture(_load_fixture()))
    second = result.levels[1]
    rooms = _rooms_by_name(second)

    expected_loads = {
        "Stairs": (580, 844),
        "Hallway": (594, 516),
        "Bed 2 WIC": (440, 679),
        "Bed 2": (1499, 1855),
        "Bath 2": (327, 430),
        "Bed 3": (1169, 1141),
        "Bed 3 WIC": (185, 319),
        "Bed 4 WIC": (275, 532),
        "Bed 4": (1440, 1184),
        "Bath 3": (286, 377),
        "Owners Bed": (3178, 3201),
    }
    for name, (cooling, heating) in expected_loads.items():
        assert rooms[name].cooling_btuh == cooling
        assert rooms[name].heating_btuh == heating

    assert second.cooling_subtotal == 12806
    assert second.heating_subtotal == 14070

    assert rooms["Owners Bed"].cfm_cool == 176
    assert rooms["Owners Bed"].cfm_heat == 159
    assert rooms["Owners Bed"].cfm_avg == 168

    assert rooms["Bed 2"].cfm_cool == 83
    assert rooms["Bed 2"].cfm_heat == 92
    assert rooms["Bed 2"].cfm_avg == 88

    assert rooms["Bed 3"].cfm_cool == 65
    assert rooms["Bed 3"].cfm_heat == 57
    assert rooms["Bed 3"].cfm_avg == 61


def test_airflow_is_proportional_and_sums_to_selected_system_capacity():
    result = calculate_project(_project_from_fixture(_load_fixture()))
    rooms = [room for level in result.levels for room in level.room_results]
    family = next(room for room in rooms if room.name == "Family")

    assert sum(room.cfm_cool for room in rooms) == result.system_cfm == 1400
    assert sum(room.cfm_heat for room in rooms) == result.system_cfm == 1400
    assert family.cfm_cool / result.system_cfm == pytest.approx(
        family.cooling_btuh / sum(room.cooling_btuh for room in rooms),
        abs=0.001,
    )
    assert family.cfm_heat / result.system_cfm == pytest.approx(
        family.heating_btuh / sum(room.heating_btuh for room in rooms),
        abs=0.001,
    )


def test_airflow_sums_to_each_unit_selected_capacity():
    project = _project_from_fixture(_load_fixture())
    units = [
        {"id": "unit-first", "name": "First Floor", "selected_tons": 1.5},
        {"id": "unit-second", "name": "Second Floor", "selected_tons": 2.0},
    ]
    project = replace(
        project,
        selected_system_tons=3.5,
        metadata={"units": units},
        levels=[
            replace(
                project.levels[0],
                rooms=[replace(room, unit_id="unit-first") for room in project.levels[0].rooms],
            ),
            replace(
                project.levels[1],
                rooms=[replace(room, unit_id="unit-second") for room in project.levels[1].rooms],
            ),
        ],
    )
    result = calculate_project(project)

    first_rooms = result.levels[0].room_results
    second_rooms = result.levels[1].room_results

    assert sum(room.cfm_cool for room in first_rooms) == 600
    assert sum(room.cfm_heat for room in first_rooms) == 600
    assert sum(room.cfm_cool for room in second_rooms) == 800
    assert sum(room.cfm_heat for room in second_rooms) == 800
