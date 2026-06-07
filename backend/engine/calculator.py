"""Project, level, and line-item aggregation for the load engine."""

from __future__ import annotations

from dataclasses import dataclass, replace

from .constants import (
    BTUH_PER_KW,
    CFM_PER_TON,
    PEOPLE_SENSIBLE_BTUH,
    SCLEFF_BY_DIRECTION,
    SENSIBLE_BTUH_PER_NOMINAL_TON,
    SPECIAL_CLTD,
    STANDARD_TON_SIZES,
    TOWNHOUSE_GLASS_LOAD_FACTORS,
    WALL_CLTD_BY_DIRECTION,
    WATT_TO_BTUH,
)
from .formulas import (
    cooling_component_load,
    glass_load_factor,
    heating_component_load,
    normalize_direction,
    round_half_up,
    standard_infiltration_load,
    ventilation_load,
)
from .models import DesignConditions, Level, LineItem, Project, Room


@dataclass(frozen=True)
class LineResult:
    name: str
    cooling_btuh: float
    heating_btuh: float
    room_name: str | None = None


@dataclass(frozen=True)
class LevelResult:
    name: str
    raw_cooling_subtotal: float
    cooling_subtotal: int
    cooling_load: int
    tons_min: float
    tons_selected: float
    cfm: int
    raw_heating_subtotal: float
    heating_subtotal: int
    heat_loss: int
    kw_min: float
    kw_selected: float
    line_results: list[LineResult]
    room_results: list["RoomResult"]


@dataclass(frozen=True)
class ProjectResult:
    sensible_cooling: int
    heating: int
    tons_min: float
    system_tons: float
    system_kw: float
    system_cfm: int
    levels: list[LevelResult]
    unit_results: list["UnitResult"]


@dataclass(frozen=True)
class RoomResult:
    name: str
    cooling_btuh: int
    heating_btuh: int
    cfm_cool: int
    cfm_heat: int
    cfm_avg: int


@dataclass(frozen=True)
class UnitResult:
    id: str
    name: str
    cooling_subtotal: int
    heating_subtotal: int
    sensible_cooling: int
    heating: int
    tons_min: float
    recommended_tons: float
    kw_min: float


def _line_result(item: LineItem, cooling_btuh: float, heating_btuh: float) -> LineResult:
    return LineResult(item.name, cooling_btuh, heating_btuh, item.room_name)


def infer_cooling_cltd(item: LineItem) -> float:
    if item.cooling_cltd is not None:
        return item.cooling_cltd
    assembly_code = item.assembly.code.upper() if item.assembly else ""
    name = item.name.upper()
    direction = item.direction.upper() if item.direction else None

    if assembly_code == "W1" and direction in WALL_CLTD_BY_DIRECTION:
        return WALL_CLTD_BY_DIRECTION[direction]
    if assembly_code == "W1" and "GARAGE" in name:
        return SPECIAL_CLTD["GARAGE_WALL"]
    if assembly_code == "W1" and "PARTITION" in name:
        return SPECIAL_CLTD["PARTITION"]
    if assembly_code in {"W2"}:
        return 0.0
    if assembly_code in {"W3"}:
        return SPECIAL_CLTD["ATTIC_WALL"]
    if assembly_code in {"R1", "C1"}:
        return SPECIAL_CLTD["FLAT_CEILING"]
    if assembly_code in {"R2", "C2"}:
        return SPECIAL_CLTD["VAULTED_CEILING"]
    if assembly_code == "F2":
        return SPECIAL_CLTD["SLAB"]
    if assembly_code == "F1" and "GARAGE" in name:
        return SPECIAL_CLTD["FLOOR_OVER_GARAGE"]
    if assembly_code == "F1" and "CANTILEVER" in name:
        return SPECIAL_CLTD["CANTILEVER"]
    if assembly_code == "F1":
        return SPECIAL_CLTD["FRAMED_FLOOR"]
    if assembly_code == "D1":
        return SPECIAL_CLTD["EXTERIOR_DOOR"]
    if assembly_code == "D2":
        return SPECIAL_CLTD["GARAGE_DOOR"]
    return 0.0


def infer_heating_delta_t(item: LineItem, design_conditions: DesignConditions) -> float:
    if item.heating_delta_t is not None:
        return item.heating_delta_t
    assembly_code = item.assembly.code.upper() if item.assembly else ""
    name = item.name.upper()

    if assembly_code == "F2":
        return design_conditions.slab_delta_t
    if assembly_code == "W2":
        return design_conditions.slab_delta_t
    if assembly_code == "W1" and not item.direction and ("GARAGE" in name or "PARTITION" in name):
        return design_conditions.slab_delta_t
    return design_conditions.heating_delta_t


def calculate_room(
    room: Room,
    *,
    cooling_cfm_divisor: float,
    heating_cfm_divisor: float,
) -> RoomResult:
    raw_cfm_cool = room.cooling_btuh / cooling_cfm_divisor
    raw_cfm_heat = room.heating_btuh / heating_cfm_divisor
    cfm_cool = round_half_up(raw_cfm_cool)
    cfm_heat = round_half_up(raw_cfm_heat)
    return RoomResult(
        name=room.name,
        cooling_btuh=round_half_up(room.cooling_btuh),
        heating_btuh=round_half_up(room.heating_btuh),
        cfm_cool=cfm_cool,
        cfm_heat=cfm_heat,
        cfm_avg=round_half_up((raw_cfm_cool + raw_cfm_heat) / 2),
    )


def combined_glass_factors_for(building_type: str | None) -> dict[str, int] | None:
    """Return a *combined* per-direction glass cooling factor table (Btu/hr-sf), or None.

    Townhouses don't use the single-family SHGF formula (U*14 + SHGC*SCLEFF). Salas
    applies a separate combined load-factor table directly per orientation
    (``TOWNHOUSE_GLASS_LOAD_FACTORS``), verified against the Evergreen TH resload.
    Single-family returns None → the SHGF formula in ``glass_load_factor`` is used.
    """

    if building_type and building_type.strip().lower() in {"townhouse", "townhome", "town_house", "th"}:
        return TOWNHOUSE_GLASS_LOAD_FACTORS
    return None


def calculate_line_item(
    item: LineItem,
    *,
    design_conditions: DesignConditions,
    level_volume: float,
    ventilation_cfm: float | None = None,
    combined_glass_factors: dict[str, int] | None = None,
    infiltration_scale: float = 1.0,
) -> LineResult:
    if item.kind == "manual":
        return _line_result(item, item.cooling_btuh or 0.0, item.heating_btuh or 0.0)

    if item.kind == "glass":
        if item.assembly is None or item.assembly.u_value is None or item.assembly.shgc is None:
            raise ValueError(f"Glass item {item.name!r} requires assembly U-value and SHGC")
        if item.direction is None:
            raise ValueError(f"Glass item {item.name!r} requires direction")
        cooling_factor = item.cooling_load_factor
        if cooling_factor is None and combined_glass_factors is not None:
            # Townhouse: combined Btu/hr-sf table applied directly (not the SHGF formula).
            key = normalize_direction(item.direction)
            if key not in combined_glass_factors:
                raise KeyError(f"Unknown glass direction {item.direction!r}")
            cooling_factor = combined_glass_factors[key]
        if cooling_factor is None:
            cooling_factor = glass_load_factor(
                item.direction,
                u_value=item.assembly.u_value,
                shgc=item.assembly.shgc,
            )
        cooling = item.area * cooling_factor
        heating = heating_component_load(
            item.heating_area if item.heating_area is not None else item.area,
            item.assembly.u_value,
            infer_heating_delta_t(item, design_conditions),
        )
        return _line_result(item, cooling, heating)

    if item.kind == "opaque":
        if item.assembly is None or item.assembly.u_value is None:
            raise ValueError(f"Opaque item {item.name!r} requires assembly U-value")
        cooling_cltd = infer_cooling_cltd(item)
        cooling = cooling_component_load(
            item.area,
            item.assembly.u_value,
            cooling_cltd,
        ) if item.cooling_load_factor is None else item.area * item.cooling_load_factor
        heating = heating_component_load(
            item.heating_area if item.heating_area is not None else item.area,
            item.assembly.u_value,
            infer_heating_delta_t(item, design_conditions),
        )
        return _line_result(item, cooling, heating)

    if item.kind == "internal_people":
        return _line_result(item, item.quantity * PEOPLE_SENSIBLE_BTUH, 0.0)

    if item.kind == "internal_watts":
        return _line_result(item, item.watts * WATT_TO_BTUH, 0.0)

    if item.kind == "infiltration":
        infiltration_volume = item.volume if item.volume is not None else level_volume
        if ventilation_cfm is not None:
            return _line_result(
                item,
                ventilation_load(ventilation_cfm, design_conditions.cooling_delta_t),
                ventilation_load(ventilation_cfm, design_conditions.heating_delta_t),
            )
        return _line_result(
            item,
            standard_infiltration_load(infiltration_volume, mode="cooling", scale=infiltration_scale),
            standard_infiltration_load(infiltration_volume, mode="heating", scale=infiltration_scale),
        )

    raise ValueError(f"Unsupported line item kind: {item.kind}")


def calculate_level(
    level: Level,
    *,
    design_conditions: DesignConditions,
    ventilation_cfm: float | None = None,
    combined_glass_factors: dict[str, int] | None = None,
    infiltration_scale: float = 1.0,
) -> LevelResult:
    line_results = [
        calculate_line_item(
            item,
            design_conditions=design_conditions,
            level_volume=level.volume,
            ventilation_cfm=ventilation_cfm,
            combined_glass_factors=combined_glass_factors,
            infiltration_scale=infiltration_scale,
        )
        for item in level.line_items
    ]
    for room in level.rooms:
        lighting_area = room.lighting_area if room.lighting_area is not None else room.floor_area
        if level.auto_lighting_w_per_sf and lighting_area:
            watts = lighting_area * level.auto_lighting_w_per_sf
            line_results.append(
                LineResult(
                    name=f"Auto lighting - {room.name}",
                    cooling_btuh=watts * WATT_TO_BTUH,
                    heating_btuh=0.0,
                    room_name=room.name,
                )
            )
        if level.auto_infiltration and room.volume is not None and room.volume > 0:
            line_results.append(
                LineResult(
                    name=f"Auto infiltration - {room.name}",
                    cooling_btuh=standard_infiltration_load(room.volume, mode="cooling", scale=infiltration_scale),
                    heating_btuh=standard_infiltration_load(room.volume, mode="heating", scale=infiltration_scale),
                    room_name=room.name,
                )
            )
    raw_cooling_subtotal = sum(result.cooling_btuh for result in line_results)
    raw_heating_subtotal = sum(result.heating_btuh for result in line_results)
    cooling_subtotal = round_half_up(raw_cooling_subtotal)
    heating_subtotal = round_half_up(raw_heating_subtotal)
    cooling_load = round_half_up(raw_cooling_subtotal * design_conditions.cooling_safety_factor)
    heat_loss = round_half_up(raw_heating_subtotal * design_conditions.heating_safety_factor)
    assigned_room_loads: dict[str, list[float]] = {}
    for result in line_results:
        if result.room_name:
            loads = assigned_room_loads.setdefault(result.room_name, [0.0, 0.0])
            loads[0] += result.cooling_btuh
            loads[1] += result.heating_btuh

    room_names = list(dict.fromkeys([room.name for room in level.rooms] + list(assigned_room_loads)))
    room_lookup = {room.name: room for room in level.rooms}
    room_results = []
    for name in room_names:
        base_room = room_lookup.get(name, Room(name=name))
        assigned = assigned_room_loads.get(name, [0.0, 0.0])
        room_results.append(
            calculate_room(
                Room(
                    name=name,
                    cooling_btuh=base_room.cooling_btuh + assigned[0],
                    heating_btuh=base_room.heating_btuh + assigned[1],
                ),
                cooling_cfm_divisor=level.cooling_cfm_divisor if level.cooling_cfm_divisor is not None else 18.1,
                heating_cfm_divisor=level.heating_cfm_divisor if level.heating_cfm_divisor is not None else 20.2,
            )
        )
    return LevelResult(
        name=level.name,
        raw_cooling_subtotal=raw_cooling_subtotal,
        cooling_subtotal=cooling_subtotal,
        cooling_load=cooling_load,
        tons_min=cooling_load / SENSIBLE_BTUH_PER_NOMINAL_TON,
        tons_selected=level.selected_tons,
        cfm=round_half_up(level.selected_tons * CFM_PER_TON),
        raw_heating_subtotal=raw_heating_subtotal,
        heating_subtotal=heating_subtotal,
        heat_loss=heat_loss,
        kw_min=heat_loss / BTUH_PER_KW,
        kw_selected=level.selected_kw,
        line_results=line_results,
        room_results=room_results,
    )


def _allocate_proportional_cfm(loads: list[int], total_cfm: int) -> list[int]:
    """Allocate integer CFM by load share while preserving the exact system total."""
    total_load = sum(loads)
    if total_cfm <= 0 or total_load <= 0:
        return [0 for _ in loads]
    raw_allocations = [load / total_load * total_cfm for load in loads]
    allocations = [int(value) for value in raw_allocations]
    remaining = total_cfm - sum(allocations)
    order = sorted(
        range(len(loads)),
        key=lambda index: (raw_allocations[index] - allocations[index], loads[index]),
        reverse=True,
    )
    for index in order[:remaining]:
        allocations[index] += 1
    return allocations


def recommended_standard_tons(tons_min: float) -> float:
    """Return the nominal size using the project's standard upsize thresholds."""
    if tons_min <= STANDARD_TON_SIZES[0]:
        return STANDARD_TON_SIZES[0]
    for current, next_size in zip(STANDARD_TON_SIZES, STANDARD_TON_SIZES[1:]):
        threshold = 0.25 if current == 4.0 and next_size == 5.0 else 0.10
        if tons_min < current + threshold:
            return current
        if tons_min <= next_size:
            return next_size
    return STANDARD_TON_SIZES[-1]


def _allocate_unit_room_airflows(project: Project, levels: list[LevelResult]) -> list[LevelResult]:
    units = project.metadata.get("units", [])
    if not units:
        units = [{"id": "unit-whole-house", "name": "Whole House", "selected_tons": project.selected_system_tons}]
    primary_unit_id = units[0]["id"]
    unit_tons = {
        unit["id"]: float(
            unit.get("selected_tons")
            if unit.get("selected_tons") is not None
            else (project.selected_system_tons or 0) if index == 0 else 0
        )
        for index, unit in enumerate(units)
    }
    room_entries: dict[str, list[tuple[int, int, RoomResult]]] = {unit["id"]: [] for unit in units}
    for level_index, (level, level_result) in enumerate(zip(project.levels, levels)):
        room_unit_lookup = {room.name: room.unit_id or primary_unit_id for room in level.rooms}
        for room_index, room_result in enumerate(level_result.room_results):
            unit_id = room_unit_lookup.get(room_result.name, primary_unit_id)
            room_entries.setdefault(unit_id, []).append((level_index, room_index, room_result))

    replacements: dict[tuple[int, int], RoomResult] = {}
    for unit_id, entries in room_entries.items():
        total_cfm = round_half_up(unit_tons.get(unit_id, 0.0) * CFM_PER_TON)
        cooling_allocations = _allocate_proportional_cfm([entry[2].cooling_btuh for entry in entries], total_cfm)
        heating_allocations = _allocate_proportional_cfm([entry[2].heating_btuh for entry in entries], total_cfm)
        for entry, cfm_cool, cfm_heat in zip(entries, cooling_allocations, heating_allocations):
            level_index, room_index, room_result = entry
            replacements[(level_index, room_index)] = replace(
                room_result,
                cfm_cool=cfm_cool,
                cfm_heat=cfm_heat,
                cfm_avg=round_half_up((cfm_cool + cfm_heat) / 2),
            )

    return [
        replace(
            level_result,
            room_results=[
                replacements.get((level_index, room_index), room_result)
                for room_index, room_result in enumerate(level_result.room_results)
            ],
        )
        for level_index, level_result in enumerate(levels)
    ]


def _ventilation_cfm_by_level(project: Project) -> list[float | None]:
    if project.infiltration.mode != "mechanical_ventilation":
        return [None for _ in project.levels]
    if project.infiltration.outside_air_cfm is None:
        raise ValueError("Mechanical ventilation mode requires outside_air_cfm")
    total_volume = sum(level.volume for level in project.levels)
    if total_volume == 0:
        raise ValueError("Total building volume is zero; cannot distribute ventilation CFM")
    return [
        project.infiltration.outside_air_cfm * (level.volume / total_volume)
        for level in project.levels
    ]


def calculate_project(project: Project) -> ProjectResult:
    ventilation_by_level = _ventilation_cfm_by_level(project)
    combined_glass_factors = combined_glass_factors_for(project.building_type)
    # Effective air-change rate drives the infiltration load. The standard factors
    # correspond to 0.25 ACH, so scale = effective_ach / 0.25 (None → 1.0, current model).
    #  - Mechanical ventilation (tight/ACH50 homes): outside-air CFM supersedes natural
    #    infiltration, effective ACH = cfm * 60 / volume. (mode stays "standard_ach" so the
    #    legacy explicit-line-item ventilation path is not also triggered.)
    #  - Legacy ACH-scaled imports: natural_ach read straight from the PDF.
    inf = project.infiltration
    total_volume = sum(level.volume for level in project.levels)
    if inf.mode != "mechanical_ventilation" and inf.outside_air_cfm and total_volume:
        effective_ach = inf.outside_air_cfm * 60 / total_volume
    else:
        effective_ach = inf.natural_ach
    infiltration_scale = (effective_ach / 0.25) if effective_ach else 1.0
    levels = [
        calculate_level(
            level,
            design_conditions=project.design_conditions,
            ventilation_cfm=ventilation_by_level[index],
            combined_glass_factors=combined_glass_factors,
            infiltration_scale=infiltration_scale,
        )
        for index, level in enumerate(project.levels)
    ]
    levels = _allocate_unit_room_airflows(project, levels)
    dc = project.design_conditions
    sensible_cooling = round_half_up(
        sum(level.raw_cooling_subtotal for level in levels) * dc.cooling_safety_factor
    )
    heating = round_half_up(
        sum(level.raw_heating_subtotal for level in levels) * dc.heating_safety_factor
    )
    system_tons = (
        project.selected_system_tons
        if project.selected_system_tons is not None
        else sum(level.tons_selected for level in levels)
    )
    system_kw = (
        project.selected_system_kw
        if project.selected_system_kw is not None
        else sum(level.kw_selected for level in levels)
    )
    units = project.metadata.get("units", [])
    if not units:
        units = [{"id": "unit-whole-house", "name": "Whole House"}]
    room_unit_lookup = {
        room.name: (room.unit_id or units[0]["id"])
        for level in project.levels
        for room in level.rooms
    }
    raw_unit_loads = {unit["id"]: [0.0, 0.0] for unit in units}
    for level, level_result in zip(project.levels, levels):
        for room in level.rooms:
            unit_id = room_unit_lookup.get(room.name, units[0]["id"])
            loads = raw_unit_loads.setdefault(unit_id, [0.0, 0.0])
            loads[0] += room.cooling_btuh
            loads[1] += room.heating_btuh
        for line_result in level_result.line_results:
            unit_id = room_unit_lookup.get(line_result.room_name or "", units[0]["id"])
            loads = raw_unit_loads.setdefault(unit_id, [0.0, 0.0])
            loads[0] += line_result.cooling_btuh
            loads[1] += line_result.heating_btuh
    unit_results = [
        UnitResult(
            id=unit["id"],
            name=unit["name"],
            cooling_subtotal=round_half_up(raw_unit_loads.get(unit["id"], [0.0, 0.0])[0]),
            heating_subtotal=round_half_up(raw_unit_loads.get(unit["id"], [0.0, 0.0])[1]),
            sensible_cooling=round_half_up(raw_unit_loads.get(unit["id"], [0.0, 0.0])[0] * dc.cooling_safety_factor),
            heating=round_half_up(raw_unit_loads.get(unit["id"], [0.0, 0.0])[1] * dc.heating_safety_factor),
            tons_min=raw_unit_loads.get(unit["id"], [0.0, 0.0])[0] * dc.cooling_safety_factor / SENSIBLE_BTUH_PER_NOMINAL_TON,
            recommended_tons=recommended_standard_tons(
                raw_unit_loads.get(unit["id"], [0.0, 0.0])[0]
                * dc.cooling_safety_factor
                / SENSIBLE_BTUH_PER_NOMINAL_TON
            ),
            kw_min=raw_unit_loads.get(unit["id"], [0.0, 0.0])[1] * dc.heating_safety_factor / BTUH_PER_KW,
        )
        for unit in units
    ]
    return ProjectResult(
        sensible_cooling=sensible_cooling,
        heating=heating,
        tons_min=sensible_cooling / SENSIBLE_BTUH_PER_NOMINAL_TON,
        system_tons=system_tons,
        system_kw=system_kw,
        system_cfm=round_half_up(system_tons * CFM_PER_TON),
        levels=levels,
        unit_results=unit_results,
    )
