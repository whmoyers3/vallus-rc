"""Payload-level component diagnostics for calculator and takeoff exports."""

from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timezone
from typing import Any

from backend.engine import calculate_project
from backend.engine.calculator import (
    ProjectResult,
    calculate_line_item,
    combined_glass_factors_for,
    infer_cooling_cltd,
    infer_heating_delta_t,
    recommended_standard_tons,
)
from backend.engine.constants import DIRECTIONS
from backend.engine.formulas import glass_load_factor, normalize_direction, round_half_up
from backend.engine.models import Level, LineItem, Project

from .serialization import project_from_payload


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _project_label(payload: dict[str, Any]) -> str:
    project = payload.get("project", {})
    return str(project.get("description") or project.get("name") or "component-diagnostics").strip()


def _safe_filename_part(value: str) -> str:
    safe = "".join(char for char in value if char.isalnum() or char in {" ", "-", "_"}).strip()
    return "-".join(safe.split()) or "component-diagnostics"


def diagnostics_filename(payload: dict[str, Any], suffix: str) -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M%S")
    return f"{_safe_filename_part(_project_label(payload))}-{suffix}-{stamp}.json"


def _rotate_direction(direction: str | None, steps: int) -> str | None:
    if direction not in DIRECTIONS:
        return direction
    index = DIRECTIONS.index(direction)
    return DIRECTIONS[(index + steps) % len(DIRECTIONS)]


def _orientation_label(project: Project, steps: int) -> str:
    front = project.metadata.get("front_door_faces") or "S"
    if front not in DIRECTIONS:
        front = "S"
    return _rotate_direction(front, steps) or front


def _rotate_item(item: LineItem, steps: int) -> LineItem:
    return replace(item, direction=_rotate_direction(item.direction, steps))


def _rotate_level(level: Level, steps: int) -> Level:
    return replace(level, line_items=[_rotate_item(item, steps) for item in level.line_items])


def _rotate_project(project: Project, steps: int) -> Project:
    return replace(project, levels=[_rotate_level(level, steps) for level in project.levels])


def _ventilation_by_level(project: Project) -> list[float | None]:
    if project.infiltration.mode != "mechanical_ventilation":
        return [None for _ in project.levels]
    if project.infiltration.outside_air_cfm is None:
        return [None for _ in project.levels]
    total_volume = sum(level.volume for level in project.levels)
    if total_volume <= 0:
        return [None for _ in project.levels]
    return [
        project.infiltration.outside_air_cfm * (level.volume / total_volume)
        for level in project.levels
    ]


def _infiltration_scale(project: Project) -> float:
    total_volume = sum(level.volume for level in project.levels)
    inf = project.infiltration
    if inf.mode != "mechanical_ventilation" and inf.outside_air_cfm and total_volume:
        effective_ach = inf.outside_air_cfm * 60 / total_volume
    else:
        effective_ach = inf.natural_ach
    return (effective_ach / 0.25) if effective_ach else 1.0


def _line_result_for_item(project: Project, level_index: int, item: LineItem, steps: int = 0):
    rotated = _rotate_item(item, steps)
    ventilation = _ventilation_by_level(project)[level_index]
    return rotated, calculate_line_item(
        rotated,
        design_conditions=project.design_conditions,
        level_volume=project.levels[level_index].volume,
        ventilation_cfm=ventilation,
        combined_glass_factors=combined_glass_factors_for(project.building_type),
        infiltration_scale=_infiltration_scale(project),
    )


def _component_type(item: LineItem) -> str:
    code = item.assembly.code.upper() if item.assembly else ""
    if item.kind == "glass" or code.startswith("G"):
        return "Glass"
    if code.startswith("W"):
        return "Wall"
    if code.startswith("C") or code.startswith("R"):
        return "Ceiling"
    if code.startswith("F"):
        return "Floor"
    if code.startswith("D"):
        return "Door"
    if item.kind == "infiltration":
        return "Infiltration"
    if item.kind.startswith("internal"):
        return "Internal"
    return item.kind.title()


def _cooling_factor(item: LineItem, project: Project) -> float | None:
    if item.cooling_load_factor is not None:
        return item.cooling_load_factor
    if item.kind != "glass" or item.assembly is None or item.direction is None:
        return None
    if item.assembly.u_value is None or item.assembly.shgc is None:
        return None
    combined = combined_glass_factors_for(project.building_type)
    key = normalize_direction(item.direction)
    if combined is not None:
        return combined.get(key)
    return glass_load_factor(item.direction, u_value=item.assembly.u_value, shgc=item.assembly.shgc)


def _component_row(
    *,
    project: Project,
    result: ProjectResult,
    level_index: int,
    item_index: int,
    item: LineItem,
) -> dict[str, Any]:
    line_result = result.levels[level_index].line_results[item_index]
    assembly = item.assembly
    row: dict[str, Any] = {
        "level": project.levels[level_index].name,
        "index": item_index,
        "room_name": item.room_name,
        "name": item.name,
        "kind": item.kind,
        "component_type": _component_type(item),
        "assembly": assembly.code if assembly else None,
        "assembly_description": assembly.description if assembly else None,
        "direction": item.direction,
        "boundary": item.boundary,
        "area": item.area,
        "heating_area": item.heating_area,
        "volume": item.volume,
        "quantity": item.quantity,
        "watts": item.watts,
        "u_value": assembly.u_value if assembly else None,
        "shgc": assembly.shgc if assembly else None,
        "cooling_factor": _cooling_factor(item, project),
        "cooling_cltd": infer_cooling_cltd(item) if item.kind == "opaque" else item.cooling_cltd,
        "heating_delta_t": infer_heating_delta_t(item, project.design_conditions) if assembly else item.heating_delta_t,
        "cooling_btuh_raw": line_result.cooling_btuh,
        "heating_btuh_raw": line_result.heating_btuh,
        "cooling_btuh_with_safety": line_result.cooling_btuh * project.design_conditions.cooling_safety_factor,
        "heating_btuh_with_safety": line_result.heating_btuh * project.design_conditions.heating_safety_factor,
    }
    if item.kind == "glass" and item.area:
        row["effective_cooling_btuh_per_sf"] = line_result.cooling_btuh / item.area
    return row


def _system_summary(project: Project, result: ProjectResult) -> dict[str, Any]:
    return {
        "sensible_cooling_btuh": result.sensible_cooling,
        "heating_btuh": result.heating,
        "tons_min": result.tons_min,
        "recommended_tons": recommended_standard_tons(result.tons_min),
        "selected_tons": result.system_tons,
        "selected_kw": result.system_kw,
        "system_cfm": result.system_cfm,
        "cooling_safety_factor": project.design_conditions.cooling_safety_factor,
        "heating_safety_factor": project.design_conditions.heating_safety_factor,
    }


def _orientation_sweep(project: Project) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for steps in range(len(DIRECTIONS)):
        rotated = _rotate_project(project, steps)
        result = calculate_project(rotated)
        glass_by_direction: dict[str, float] = {}
        for level in rotated.levels:
            for item in level.line_items:
                if item.kind == "glass":
                    direction = item.direction or "None"
                    glass_by_direction[direction] = glass_by_direction.get(direction, 0.0) + item.area
        entries.append({
            "facing": _orientation_label(project, steps),
            "rotation_steps": steps,
            "sensible_cooling_btuh": result.sensible_cooling,
            "heating_btuh": result.heating,
            "tons_min": result.tons_min,
            "recommended_tons": recommended_standard_tons(result.tons_min),
            "glass_area_by_direction": dict(sorted(glass_by_direction.items())),
        })
    return entries


def _orientation_sensitivity(project: Project, sweep: list[dict[str, Any]]) -> dict[str, Any]:
    if not sweep:
        return {"comparison": None, "rows": []}
    ranked = sorted(sweep, key=lambda row: row["sensible_cooling_btuh"], reverse=True)
    best = ranked[0]
    comparison = ranked[1] if len(ranked) > 1 else ranked[0]
    rows: list[dict[str, Any]] = []
    for level_index, level in enumerate(project.levels):
        for item_index, item in enumerate(level.line_items):
            best_item, best_result = _line_result_for_item(project, level_index, item, best["rotation_steps"])
            comparison_item, comparison_result = _line_result_for_item(project, level_index, item, comparison["rotation_steps"])
            cooling_delta = best_result.cooling_btuh - comparison_result.cooling_btuh
            heating_delta = best_result.heating_btuh - comparison_result.heating_btuh
            if abs(cooling_delta) < 0.01 and abs(heating_delta) < 0.01:
                continue
            rows.append({
                "level": level.name,
                "index": item_index,
                "room_name": item.room_name,
                "name": item.name,
                "kind": item.kind,
                "component_type": _component_type(item),
                "assembly": item.assembly.code if item.assembly else None,
                "area": item.area,
                "original_direction": item.direction,
                "best_facing": best["facing"],
                "best_direction": best_item.direction,
                "best_cooling_btuh_raw": best_result.cooling_btuh,
                "comparison_facing": comparison["facing"],
                "comparison_direction": comparison_item.direction,
                "comparison_cooling_btuh_raw": comparison_result.cooling_btuh,
                "delta_cooling_btuh_raw": cooling_delta,
                "delta_cooling_btuh_with_safety": cooling_delta * project.design_conditions.cooling_safety_factor,
                "delta_heating_btuh_raw": heating_delta,
                "delta_heating_btuh_with_safety": heating_delta * project.design_conditions.heating_safety_factor,
            })
    rows.sort(key=lambda row: abs(row["delta_cooling_btuh_raw"]), reverse=True)
    return {
        "comparison": {
            "best_facing": best["facing"],
            "comparison_facing": comparison["facing"],
            "cooling_gap_btuh": best["sensible_cooling_btuh"] - comparison["sensible_cooling_btuh"],
            "heating_gap_btuh": best["heating_btuh"] - comparison["heating_btuh"],
        },
        "rows": rows,
    }


def _glass_audit_from_rows(component_rows: list[dict[str, Any]]) -> dict[str, Any]:
    rows = [row for row in component_rows if row["kind"] == "glass"]
    by_direction: dict[str, dict[str, Any]] = {}
    for row in rows:
        direction = row.get("direction") or "None"
        bucket = by_direction.setdefault(direction, {
            "row_count": 0,
            "area": 0.0,
            "cooling_btuh_raw": 0.0,
            "heating_btuh_raw": 0.0,
        })
        bucket["row_count"] += 1
        bucket["area"] += row.get("area") or 0.0
        bucket["cooling_btuh_raw"] += row.get("cooling_btuh_raw") or 0.0
        bucket["heating_btuh_raw"] += row.get("heating_btuh_raw") or 0.0

    for bucket in by_direction.values():
        area = bucket["area"]
        bucket["effective_cooling_btuh_per_sf"] = bucket["cooling_btuh_raw"] / area if area else None
        bucket["area"] = round(bucket["area"], 3)
        bucket["cooling_btuh_raw"] = round_half_up(bucket["cooling_btuh_raw"])
        bucket["heating_btuh_raw"] = round_half_up(bucket["heating_btuh_raw"])

    return {
        "summary": {
            "row_count": len(rows),
            "total_area": round(sum(row.get("area") or 0.0 for row in rows), 3),
            "total_cooling_btuh_raw": round_half_up(sum(row.get("cooling_btuh_raw") or 0.0 for row in rows)),
            "total_heating_btuh_raw": round_half_up(sum(row.get("heating_btuh_raw") or 0.0 for row in rows)),
            "by_direction": dict(sorted(by_direction.items())),
        },
        "rows": rows,
    }


def build_component_diagnostics(payload: dict[str, Any]) -> dict[str, Any]:
    project = project_from_payload(payload)
    result = calculate_project(project)
    component_rows: list[dict[str, Any]] = []
    generated_rows: list[dict[str, Any]] = []

    for level_index, level in enumerate(project.levels):
        level_result = result.levels[level_index]
        for item_index, item in enumerate(level.line_items):
            component_rows.append(
                _component_row(
                    project=project,
                    result=result,
                    level_index=level_index,
                    item_index=item_index,
                    item=item,
                )
            )
        for generated in level_result.line_results[len(level.line_items):]:
            generated_rows.append({
                "level": level.name,
                "room_name": generated.room_name,
                "name": generated.name,
                "cooling_btuh_raw": generated.cooling_btuh,
                "heating_btuh_raw": generated.heating_btuh,
                "cooling_btuh_with_safety": generated.cooling_btuh * project.design_conditions.cooling_safety_factor,
                "heating_btuh_with_safety": generated.heating_btuh * project.design_conditions.heating_safety_factor,
            })

    sweep = _orientation_sweep(project)
    glass_audit = _glass_audit_from_rows(component_rows)
    return {
        "generated_at": _now_iso(),
        "project": {
            "name": project.name,
            "location": project.location,
            "description": project.description,
            "building_type": project.building_type,
            "front_door_faces": project.metadata.get("front_door_faces"),
            "salas_reference_orientation": project.metadata.get("salas_reference_orientation"),
        },
        "system": _system_summary(project, result),
        "level_summary": [
            {
                "name": level.name,
                "floor_area": level.floor_area,
                "volume": level.volume,
                "raw_cooling_subtotal": level_result.raw_cooling_subtotal,
                "cooling_load": level_result.cooling_load,
                "raw_heating_subtotal": level_result.raw_heating_subtotal,
                "heat_loss": level_result.heat_loss,
            }
            for level, level_result in zip(project.levels, result.levels)
        ],
        "room_summary": [
            {
                "level": level.name,
                "name": room.name,
                "cooling_btuh": room.cooling_btuh,
                "heating_btuh": room.heating_btuh,
                "cfm_cool": room.cfm_cool,
                "cfm_heat": room.cfm_heat,
                "cfm_avg": room.cfm_avg,
            }
            for level, level_result in zip(project.levels, result.levels)
            for room in level_result.room_results
        ],
        "component_rows": component_rows,
        "generated_rows": generated_rows,
        "glass_audit": glass_audit,
        "orientation_sweep": sweep,
        "orientation_sensitivity": _orientation_sensitivity(project, sweep),
    }
