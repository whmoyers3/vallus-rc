"""Admin-only glass factor diagnostics for the Salas test battery."""

from __future__ import annotations

from datetime import datetime, timezone
from statistics import mean
from typing import Any

from backend.engine import calculate_project
from backend.engine.calculator import (
    LineResult,
    combined_glass_factors_for,
)
from backend.engine.constants import DIRECTIONS
from backend.engine.formulas import glass_load_factor, normalize_direction
from backend.engine.models import LineItem

from .serialization import project_from_payload


_AUDIT_DIRECTIONS = (*DIRECTIONS, "Shaded", "Skylight")


def _record_label(record: dict[str, Any], payload: dict[str, Any]) -> str:
    project = payload.get("project", {})
    meta = project.get("metadata", {})
    source_filename = meta.get("source_filename")
    if isinstance(source_filename, str) and source_filename.strip():
        return source_filename.strip()

    base = (record.get("plan_name") or record.get("name") or project.get("plan_name") or project.get("name") or "")
    details = [
        record.get("elevation") or project.get("elevation"),
        record.get("foundation") or project.get("foundation"),
        record.get("orientation") or project.get("orientation"),
        record.get("variations") or project.get("variations"),
    ]
    label_parts = [str(base).strip()] if str(base).strip() else []
    base_lower = str(base).lower()
    label_parts.extend(
        str(part).strip()
        for part in details
        if part and str(part).strip().lower() not in base_lower
    )
    return " ".join(label_parts)


def _close(a: float | None, b: float | None, tolerance: float = 0.001) -> bool:
    if a is None or b is None:
        return True
    return abs(a - b) <= tolerance


def _component_type(code: str) -> str:
    return code[0].upper() if code else ""


def _model_factor(item: LineItem, building_type: str | None) -> float | None:
    if item.assembly is None or item.assembly.u_value is None or item.assembly.shgc is None:
        return None
    if item.direction is None:
        return None
    combined = combined_glass_factors_for(building_type)
    key = normalize_direction(item.direction)
    if combined is not None:
        return combined.get(key)
    return glass_load_factor(
        item.direction,
        u_value=item.assembly.u_value,
        shgc=item.assembly.shgc,
    )


def _candidate_directions(
    *,
    u_value: float | None,
    shgc: float | None,
    building_type: str | None,
    lower_factor: float | None,
    upper_factor: float | None,
) -> list[str]:
    if u_value is None or shgc is None or lower_factor is None or upper_factor is None:
        return []
    matches: list[str] = []
    combined = combined_glass_factors_for(building_type)
    for direction in _AUDIT_DIRECTIONS:
        key = normalize_direction(direction)
        if combined is not None:
            factor = combined.get(key)
        else:
            factor = glass_load_factor(direction, u_value=u_value, shgc=shgc)
        if factor is not None and lower_factor <= factor <= upper_factor:
            matches.append(direction)
    return matches


def _classify(row: dict[str, Any]) -> str:
    if row["salas_qty"] is None or row["salas_cool"] is None:
        return "missing_salas_data"
    if row["vrc_qty"] is None:
        return "missing_vrc_match"
    if row["area_delta"] is not None and abs(row["area_delta"]) > 0.05:
        return "area_mismatch"
    if row["delta_cool"] == 0:
        return "exact_load"
    if row["model_factor_in_salas_interval"]:
        return "rounding_or_row_sum"
    direction = row.get("vrc_direction")
    candidates = row.get("candidate_matching_directions") or []
    if candidates and direction not in candidates:
        return "possible_direction_mismatch"
    if row["delta_factor"] is not None and abs(row["delta_factor"]) <= 1:
        return "small_factor_delta"
    return "factor_table_or_conversion"


def _vrc_glass_rows(project: Any, result: Any) -> dict[str, list[dict[str, Any]]]:
    by_room: dict[str, list[dict[str, Any]]] = {}
    for level, level_result in zip(project.levels, result.levels):
        for item, line_result in zip(level.line_items, level_result.line_results):
            if item.kind != "glass":
                continue
            room_name = item.room_name or ""
            assembly = item.assembly
            by_room.setdefault(room_name, []).append({
                "item": item,
                "line_result": line_result,
                "type_code": assembly.code.upper() if assembly else "",
                "u_value": assembly.u_value if assembly else None,
                "shgc": assembly.shgc if assembly else None,
                "area": item.area,
                "direction": item.direction,
                "source_label": item.name,
            })
    return by_room


def _match_vrc_row(
    salas_component: dict[str, Any],
    candidates: list[dict[str, Any]],
    used_indexes: set[int],
) -> tuple[int | None, dict[str, Any] | None]:
    type_code = str(salas_component.get("type_code", "")).upper()
    qty = salas_component.get("qty")
    u_value = salas_component.get("u_value")
    scored: list[tuple[float, float, int, dict[str, Any]]] = []
    for index, candidate in enumerate(candidates):
        if index in used_indexes:
            continue
        if candidate["type_code"] != type_code:
            continue
        if not _close(candidate["u_value"], u_value, tolerance=0.002):
            continue
        area_delta = abs((candidate["area"] or 0) - (qty or 0)) if qty is not None else 0
        salas_cool = salas_component.get("salas_cool_btuh")
        line_result: LineResult = candidate["line_result"]
        cool_delta = abs(round(line_result.cooling_btuh) - round(salas_cool or 0)) if salas_cool is not None else 0
        scored.append((area_delta, cool_delta, index, candidate))
    if not scored:
        return None, None
    scored.sort(key=lambda value: (value[0], value[1]))
    _, _, index, candidate = scored[0]
    used_indexes.add(index)
    return index, candidate


def _build_project_rows(record: dict[str, Any]) -> list[dict[str, Any]]:
    payload = record.get("payload_json")
    if not payload:
        return []

    project = project_from_payload(payload)
    result = calculate_project(project)
    comparison = payload.get("project", {}).get("metadata", {}).get("salas_obrien_comparison")
    if not isinstance(comparison, dict) or not isinstance(comparison.get("rooms"), dict):
        return []

    project_name = _record_label(record, payload)
    vrc_by_room = _vrc_glass_rows(project, result)
    rows: list[dict[str, Any]] = []

    for room_name, room_data in comparison["rooms"].items():
        if not isinstance(room_data, dict):
            continue
        salas_components = room_data.get("components") or []
        vrc_candidates = vrc_by_room.get(room_name, [])
        used_indexes: set[int] = set()
        for component in salas_components:
            type_code = str(component.get("type_code", "")).upper()
            if _component_type(type_code) != "G":
                continue
            _index, vrc = _match_vrc_row(component, vrc_candidates, used_indexes)
            item: LineItem | None = vrc["item"] if vrc else None
            line_result: LineResult | None = vrc["line_result"] if vrc else None

            salas_qty = component.get("qty")
            salas_cool = component.get("salas_cool_btuh")
            vrc_qty = vrc.get("area") if vrc else None
            vrc_cool = round(line_result.cooling_btuh) if line_result else None
            u_value = component.get("u_value") if component.get("u_value") is not None else (vrc.get("u_value") if vrc else None)
            shgc = vrc.get("shgc") if vrc else None
            salas_effective_factor = (
                salas_cool / salas_qty
                if salas_cool is not None and salas_qty not in (None, 0)
                else None
            )
            vrc_effective_factor = (
                line_result.cooling_btuh / vrc_qty
                if line_result is not None and vrc_qty not in (None, 0)
                else None
            )
            model_factor = _model_factor(item, project.building_type) if item else None
            lower_factor = (
                (salas_cool - 0.5) / salas_qty
                if salas_cool is not None and salas_qty not in (None, 0)
                else None
            )
            upper_factor = (
                (salas_cool + 0.5) / salas_qty
                if salas_cool is not None and salas_qty not in (None, 0)
                else None
            )
            candidates = _candidate_directions(
                u_value=u_value,
                shgc=shgc,
                building_type=project.building_type,
                lower_factor=lower_factor,
                upper_factor=upper_factor,
            )
            row = {
                "project_id": record.get("id"),
                "project_name": project_name,
                "import_fidelity_passed": record.get("import_fidelity_passed"),
                "building_type": project.building_type,
                "room_name": room_name,
                "type_code": type_code,
                "source_label": vrc.get("source_label") if vrc else None,
                "vrc_direction": vrc.get("direction") if vrc else None,
                "salas_reported_factor": component.get("clf"),
                "salas_qty": round(salas_qty, 3) if isinstance(salas_qty, (int, float)) else None,
                "vrc_qty": round(vrc_qty, 3) if isinstance(vrc_qty, (int, float)) else None,
                "area_delta": round((vrc_qty or 0) - (salas_qty or 0), 3) if vrc_qty is not None and salas_qty is not None else None,
                "u_value": u_value,
                "shgc": shgc,
                "salas_cool": round(salas_cool) if isinstance(salas_cool, (int, float)) else None,
                "vrc_cool": vrc_cool,
                "delta_cool": (vrc_cool - round(salas_cool)) if vrc_cool is not None and isinstance(salas_cool, (int, float)) else None,
                "salas_effective_factor": round(salas_effective_factor, 4) if salas_effective_factor is not None else None,
                "vrc_effective_factor": round(vrc_effective_factor, 4) if vrc_effective_factor is not None else None,
                "model_factor": model_factor,
                "delta_factor": round((model_factor - salas_effective_factor), 4) if model_factor is not None and salas_effective_factor is not None else None,
                "salas_factor_interval": [
                    round(lower_factor, 4),
                    round(upper_factor, 4),
                ] if lower_factor is not None and upper_factor is not None else None,
                "model_factor_in_salas_interval": (
                    lower_factor <= model_factor <= upper_factor
                    if lower_factor is not None and upper_factor is not None and model_factor is not None
                    else False
                ),
                "candidate_matching_directions": candidates,
            }
            row["classification"] = _classify(row)
            rows.append(row)
    return rows


def _summarize(rows: list[dict[str, Any]]) -> dict[str, Any]:
    by_direction: dict[str, dict[str, Any]] = {}
    by_classification: dict[str, int] = {}
    for row in rows:
        classification = row["classification"]
        by_classification[classification] = by_classification.get(classification, 0) + 1
        direction = row.get("vrc_direction") or "Unknown"
        bucket = by_direction.setdefault(direction, {
            "row_count": 0,
            "exact_load_count": 0,
            "exact_factor_count": 0,
            "total_salas_cool": 0,
            "total_vrc_cool": 0,
            "_delta_factors": [],
        })
        bucket["row_count"] += 1
        if row.get("delta_cool") == 0:
            bucket["exact_load_count"] += 1
        if row.get("model_factor_in_salas_interval"):
            bucket["exact_factor_count"] += 1
        bucket["total_salas_cool"] += row.get("salas_cool") or 0
        bucket["total_vrc_cool"] += row.get("vrc_cool") or 0
        if row.get("delta_factor") is not None:
            bucket["_delta_factors"].append(row["delta_factor"])

    for bucket in by_direction.values():
        bucket["total_delta_cool"] = bucket["total_vrc_cool"] - bucket["total_salas_cool"]
        bucket["avg_delta_factor"] = round(mean(bucket["_delta_factors"]), 4) if bucket["_delta_factors"] else None
        del bucket["_delta_factors"]

    exact_load = sum(1 for row in rows if row.get("delta_cool") == 0)
    exact_factor = sum(1 for row in rows if row.get("model_factor_in_salas_interval"))
    return {
        "row_count": len(rows),
        "project_count": len({row["project_id"] for row in rows}),
        "exact_load_count": exact_load,
        "exact_load_rate": round(exact_load / len(rows) * 100, 1) if rows else None,
        "exact_factor_count": exact_factor,
        "exact_factor_rate": round(exact_factor / len(rows) * 100, 1) if rows else None,
        "by_classification": dict(sorted(by_classification.items())),
        "by_direction": dict(sorted(by_direction.items())),
    }


def build_glass_factor_audit(battery_records: list[dict[str, Any]]) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    for record in battery_records:
        try:
            project_rows = _build_project_rows(record)
            if project_rows:
                rows.extend(project_rows)
            else:
                skipped.append({"id": record.get("id"), "reason": "no_glass_component_data"})
        except Exception as exc:
            skipped.append({"id": record.get("id"), "reason": str(exc)})

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "battery_count": len(battery_records),
        "summary": _summarize(rows),
        "rows": rows,
        "skipped": skipped,
    }
