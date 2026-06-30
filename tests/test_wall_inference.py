from backend.engine import Assembly, DesignConditions, Infiltration, Level, LineItem, Project, calculate_project
from backend.engine.calculator import (
    infer_cooling_cltd,
    infer_heating_delta_t,
    project_uses_foamed_attic_w3_method,
)


def test_directional_wall_in_garage_named_room_uses_directional_boundary():
    item = LineItem(
        name="Garage Entry Hall SouthEast",
        kind="opaque",
        assembly=Assembly(code="W1", u_value=0.077),
        direction="SE",
        area=121,
    )

    assert infer_cooling_cltd(item) == 21
    assert infer_heating_delta_t(item, DesignConditions()) == 54


def test_non_directional_garage_wall_still_uses_garage_boundary():
    item = LineItem(
        name="Garage Entry Hall Garage",
        kind="opaque",
        assembly=Assembly(code="W1", u_value=0.077),
        area=47,
    )

    assert infer_cooling_cltd(item) == 30
    assert infer_heating_delta_t(item, DesignConditions()) == 27


def test_structured_boundary_overrides_directional_wall_cltd_for_knee_wall():
    item = LineItem(
        name="Bedroom East porch slice",
        kind="opaque",
        assembly=Assembly(code="W3", u_value=0.053),
        direction="E",
        area=46,
        boundary="attic_knee_wall",
    )

    assert infer_cooling_cltd(item) == 55
    assert infer_cooling_cltd(item, foamed_attic_w3=True) == 15
    assert infer_heating_delta_t(item, DesignConditions()) == 54


def test_structured_garage_boundary_does_not_depend_on_name():
    item = LineItem(
        name="Bedroom wall",
        kind="opaque",
        assembly=Assembly(code="W1", u_value=0.077),
        direction="E",
        area=80,
        boundary="garage_wall",
    )

    assert infer_cooling_cltd(item) == 30
    assert infer_heating_delta_t(item, DesignConditions()) == 27


def _w3_project(assemblies: dict[str, Assembly]) -> Project:
    return Project(
        name="W3 foam attic rule",
        location="Commerce, GA",
        description="W3 foam attic rule",
        design_conditions=DesignConditions(),
        infiltration=Infiltration(),
        selected_system_tons=1.5,
        selected_system_kw=5,
        assemblies=assemblies,
        levels=[
            Level(
                name="Main",
                floor_area=1000,
                volume=9000,
                selected_tons=1.5,
                selected_kw=5,
                line_items=[
                    LineItem(
                        name="W3 kneewall",
                        kind="opaque",
                        assembly=assemblies["W3"],
                        area=100,
                        boundary="attic",
                    )
                ],
            )
        ],
    )


def test_foamed_roof_ceiling_assembly_switches_w3_cooling_cltd_to_15():
    assemblies = {
        "W3": Assembly(code="W3", u_value=0.1, description="Attic kneewall R-13 batt"),
        "R1": Assembly(code="R1", u_value=0.044, description="Flat Ceiling R-21 sprayed"),
        "R2": Assembly(code="R2", u_value=0.048, description="Vaulted Ceiling R-21 sprayed"),
    }
    project = _w3_project(assemblies)

    assert project_uses_foamed_attic_w3_method(project)
    result = calculate_project(project)

    assert result.levels[0].line_results[0].cooling_btuh == 150
    assert result.levels[0].line_results[0].heating_btuh == 540


def test_ordinary_ceiling_keeps_w3_default_attic_cltd():
    assemblies = {
        "W3": Assembly(code="W3", u_value=0.1, description="Attic kneewall R-13 batt"),
        "C1": Assembly(code="C1", u_value=0.033, description="Flat Ceiling R-30 blown"),
    }
    project = _w3_project(assemblies)

    assert not project_uses_foamed_attic_w3_method(project)
    assert calculate_project(project).levels[0].line_results[0].cooling_btuh == 550


def test_mixed_roof_ceiling_evidence_requires_explicit_w3_override():
    assemblies = {
        "W3": Assembly(code="W3", u_value=0.1, description="Attic kneewall R-13 batt"),
        "C1": Assembly(code="C1", u_value=0.033, description="Flat Ceiling R-30 sprayed"),
        "C2": Assembly(code="C2", u_value=0.033, description="Vaulted Ceiling R-30 blown"),
    }
    project = _w3_project(assemblies)

    assert not project_uses_foamed_attic_w3_method(project)
    assert calculate_project(project).levels[0].line_results[0].cooling_btuh == 550


def test_blank_roof_ceiling_evidence_does_not_globally_reduce_w3():
    assemblies = {
        "W3": Assembly(code="W3", u_value=0.1, description="Attic kneewall R-13 batt"),
        "R1": Assembly(code="R1", u_value=0.044, description="Flat Ceiling R-21 sprayed"),
        "R2": Assembly(code="R2", u_value=0.048, description=""),
    }
    project = _w3_project(assemblies)

    assert not project_uses_foamed_attic_w3_method(project)
    assert calculate_project(project).levels[0].line_results[0].cooling_btuh == 550
