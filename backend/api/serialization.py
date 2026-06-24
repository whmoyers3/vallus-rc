"""Convert API payloads into engine objects and response dictionaries."""

from __future__ import annotations

from typing import Any

from backend.engine import Assembly, DesignConditions, Infiltration, Level, LineItem, Project, Room
from backend.engine.calculator import ProjectResult


def assembly_from_dict(data: dict[str, Any]) -> Assembly:
    return Assembly(
        code=data["code"],
        u_value=data.get("u_value"),
        shgc=data.get("shgc"),
        description=data.get("description", data.get("label", "")),
    )


def line_item_from_dict(data: dict[str, Any], assemblies: dict[str, Assembly]) -> LineItem:
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


def project_from_payload(payload: dict[str, Any]) -> Project:
    project_data = payload["project"]
    assemblies = {
        key: assembly_from_dict(value)
        for key, value in project_data.get("assemblies", {}).items()
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
                    lighting_area=room.get("lighting_area"),
                    unit_id=room.get("unit_id"),
                    zone_id=room.get("zone_id"),
                    room_type=room.get("room_type"),
                    people_override=room.get("people_override"),
                    appliance_watts_override=room.get("appliance_watts_override"),
                )
                for room in level.get("rooms", [])
            ],
            cooling_cfm_divisor=level.get("cooling_cfm_divisor"),
            heating_cfm_divisor=level.get("heating_cfm_divisor"),
            auto_lighting_w_per_sf=level.get("auto_lighting_w_per_sf"),
            auto_infiltration=level.get("auto_infiltration", False),
            auto_internal_gains=level.get("auto_internal_gains", False),
            line_items=[
                line_item_from_dict(item, assemblies)
                for item in level.get("line_items", [])
            ],
        )
        for level in project_data["levels"]
    ]
    dc_fields = {f.name for f in DesignConditions.__dataclass_fields__.values()}
    inf_fields = {f.name for f in Infiltration.__dataclass_fields__.values()}
    return Project(
        name=project_data["name"],
        location=project_data["location"],
        description=project_data["description"],
        design_conditions=DesignConditions(**{k: v for k, v in project_data["design_conditions"].items() if k in dc_fields}),
        infiltration=Infiltration(**{k: v for k, v in project_data["infiltration"].items() if k in inf_fields}),
        levels=levels,
        selected_system_tons=project_data.get("selected_system_tons"),
        selected_system_kw=project_data.get("selected_system_kw"),
        building_type=(
            project_data.get("building_type")
            or project_data.get("metadata", {}).get("building_type")
            or "single_family"
        ),
        metadata=project_data.get("metadata", {}),
        assemblies=assemblies,
    )


def loads_response(result: ProjectResult) -> dict[str, Any]:
    return {
        "whole_house_sensible_cooling": result.sensible_cooling,
        "whole_house_heating": result.heating,
        "tons_min": result.tons_min,
        "system_tons": result.system_tons,
        "system_kw": result.system_kw,
        "system_cfm": result.system_cfm,
        "units": [
            {
                "id": unit.id,
                "name": unit.name,
                "cooling_subtotal": unit.cooling_subtotal,
                "heating_subtotal": unit.heating_subtotal,
                "sensible_cooling": unit.sensible_cooling,
                "heating": unit.heating,
                "tons_min": unit.tons_min,
                "recommended_tons": unit.recommended_tons,
                "kw_min": unit.kw_min,
            }
            for unit in result.unit_results
        ],
        "levels": [
            {
                "name": level.name,
                "cooling_subtotal": level.cooling_subtotal,
                "cooling_load": level.cooling_load,
                "tons_min": level.tons_min,
                "tons_selected": level.tons_selected,
                "cfm": level.cfm,
                "heating_subtotal": level.heating_subtotal,
                "heat_loss": level.heat_loss,
                "kw_min": level.kw_min,
                "kw_selected": level.kw_selected,
                "rooms": [
                    {
                        "name": room.name,
                        "cooling_btuh": room.cooling_btuh,
                        "heating_btuh": room.heating_btuh,
                        "cfm_cool": room.cfm_cool,
                        "cfm_heat": room.cfm_heat,
                        "cfm_avg": room.cfm_avg,
                    }
                    for room in level.room_results
                ],
            }
            for level in result.levels
        ],
    }
