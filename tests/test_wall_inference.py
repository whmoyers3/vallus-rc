from backend.engine import Assembly, DesignConditions, LineItem
from backend.engine.calculator import infer_cooling_cltd, infer_heating_delta_t


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
