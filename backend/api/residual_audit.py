"""Residual (non-envelope) load audit for the Salas test battery.

Compares Baseline's infiltration, lighting, people, and appliance loads against the
residual implied by Salas's room totals minus their reported component loads.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from backend.engine import calculate_project
from backend.engine.calculator import LineResult
from backend.engine.models import LineItem

from .serialization import project_from_payload


_ENVELOPE_KINDS = {"glass", "opaque"}


def _record_label(record: dict[str, Any], payload: dict[str, Any]) -> str:
    project = payload.get("project", {})
    meta = project.get("metadata", {})
    source_filename = meta.get("source_filename")
    if isinstance(source_filename, str) and source_filename.strip():
        return source_filename.strip()
    base = (record.get("plan_name") or record.get("name")
            or project.get("plan_name") or project.get("name") or "")
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


def _classify_line(item: LineItem | None, lr: LineResult) -> str:
    """Classify a Baseline line result as envelope or a specific residual category."""
    name_lower = lr.name.lower()
    if name_lower.startswith("auto infiltration - "):
        return "infiltration"
    if name_lower.startswith("auto lighting - "):
        return "lighting"
    if item is not None:
        if item.kind == "infiltration":
            return "infiltration"
        if item.kind == "internal_people":
            return "people"
        if item.kind == "internal_watts":
            return "appliances"
        if item.kind in _ENVELOPE_KINDS:
            return "envelope"
    return "other"


def _build_project_rows(record: dict[str, Any]) -> list[dict[str, Any]]:
    payload = record.get("payload_json")
    if not payload:
        return []

    project = project_from_payload(payload)
    result = calculate_project(project)

    meta = payload.get("project", {}).get("metadata", {})
    comparison = meta.get("salas_obrien_comparison")
    if not isinstance(comparison, dict) or not isinstance(comparison.get("rooms"), dict):
        return []

    snapshot = record.get("comparison_snapshot") or {}
    project_name = _record_label(record, payload)

    # Index Baseline line results by room, with their source items
    vrc_by_room: dict[str, list[tuple[LineItem | None, LineResult]]] = {}
    for level, level_result in zip(project.levels, result.levels):
        paired = list(zip(level.line_items, level_result.line_results))
        # Auto-generated results (lighting, infiltration) don't have source items
        auto_results = level_result.line_results[len(paired):]
        for item, lr in paired:
            if lr.room_name:
                vrc_by_room.setdefault(lr.room_name, []).append((item, lr))
        for lr in auto_results:
            if lr.room_name:
                vrc_by_room.setdefault(lr.room_name, []).append((None, lr))

    # Room-level data from Salas
    salas_rooms = comparison.get("rooms", {})
    snap_rooms = snapshot.get("rooms", [])

    rows: list[dict[str, Any]] = []
    for room_name, salas_room in salas_rooms.items():
        if not isinstance(salas_room, dict):
            continue

        salas_cool_total = salas_room.get("cooling_btuh") or 0
        salas_heat_total = salas_room.get("heating_btuh") or 0

        # Salas component (envelope) sum
        salas_components = salas_room.get("components", [])
        salas_comp_cool = sum(c.get("salas_cool_btuh") or 0 for c in salas_components if isinstance(c, dict))
        salas_comp_heat = sum(c.get("salas_heat_btuh") or 0 for c in salas_components if isinstance(c, dict))

        salas_residual_cool = salas_cool_total - salas_comp_cool
        salas_residual_heat = salas_heat_total - salas_comp_heat

        # Baseline breakdown by category
        vrc_loads: dict[str, dict[str, float]] = {
            "infiltration": {"cool": 0.0, "heat": 0.0},
            "lighting": {"cool": 0.0, "heat": 0.0},
            "people": {"cool": 0.0, "heat": 0.0},
            "appliances": {"cool": 0.0, "heat": 0.0},
            "other": {"cool": 0.0, "heat": 0.0},
        }
        for item, lr in vrc_by_room.get(room_name, []):
            cat = _classify_line(item, lr)
            if cat == "envelope":
                continue
            bucket = vrc_loads.get(cat, vrc_loads["other"])
            bucket["cool"] += lr.cooling_btuh
            bucket["heat"] += lr.heating_btuh

        vrc_residual_cool = sum(v["cool"] for v in vrc_loads.values())
        vrc_residual_heat = sum(v["heat"] for v in vrc_loads.values())

        # Room metadata
        room_obj = None
        for level in project.levels:
            for r in level.rooms:
                if r.name == room_name:
                    room_obj = r
                    break

        row: dict[str, Any] = {
            "project_id": record.get("id"),
            "project_name": project_name,
            "import_fidelity_passed": record.get("import_fidelity_passed"),
            "building_type": project.building_type,
            "room_name": room_name,
            "volume": room_obj.volume if room_obj else None,
            "floor_area": room_obj.floor_area if room_obj else None,
            "salas_cool_total": round(salas_cool_total),
            "salas_comp_cool": round(salas_comp_cool),
            "salas_residual_cool": round(salas_residual_cool),
            "vrc_residual_cool": round(vrc_residual_cool, 1),
            "delta_residual_cool": round(vrc_residual_cool - salas_residual_cool, 1),
            "salas_heat_total": round(salas_heat_total),
            "salas_residual_heat": round(salas_residual_heat),
            "vrc_residual_heat": round(vrc_residual_heat, 1),
            "delta_residual_heat": round(vrc_residual_heat - salas_residual_heat, 1),
            "vrc_infiltration_cool": round(vrc_loads["infiltration"]["cool"], 1),
            "vrc_lighting_cool": round(vrc_loads["lighting"]["cool"], 1),
            "vrc_people_cool": round(vrc_loads["people"]["cool"], 1),
            "vrc_appliances_cool": round(vrc_loads["appliances"]["cool"], 1),
            "vrc_other_cool": round(vrc_loads["other"]["cool"], 1),
            "vrc_infiltration_heat": round(vrc_loads["infiltration"]["heat"], 1),
            "vrc_people_heat": round(vrc_loads["people"]["heat"], 1),
            "vrc_appliances_heat": round(vrc_loads["appliances"]["heat"], 1),
        }
        rows.append(row)

    return rows


def _summarize(rows: list[dict[str, Any]]) -> dict[str, Any]:
    total_salas_res_cool = sum(r["salas_residual_cool"] for r in rows)
    total_vrc_res_cool = sum(r["vrc_residual_cool"] for r in rows)
    total_salas_res_heat = sum(r["salas_residual_heat"] for r in rows)
    total_vrc_res_heat = sum(r["vrc_residual_heat"] for r in rows)

    total_vrc_infil = sum(r["vrc_infiltration_cool"] for r in rows)
    total_vrc_light = sum(r["vrc_lighting_cool"] for r in rows)
    total_vrc_people = sum(r["vrc_people_cool"] for r in rows)
    total_vrc_appl = sum(r["vrc_appliances_cool"] for r in rows)

    exact_count = sum(1 for r in rows if round(r["delta_residual_cool"]) == 0)

    # Per-project aggregation
    by_project: dict[int, dict[str, float]] = {}
    for r in rows:
        pid = r["project_id"]
        bucket = by_project.setdefault(pid, {
            "name": r["project_name"],
            "salas_residual_cool": 0.0,
            "vrc_residual_cool": 0.0,
            "delta_residual_cool": 0.0,
            "room_count": 0,
        })
        bucket["salas_residual_cool"] += r["salas_residual_cool"]
        bucket["vrc_residual_cool"] += r["vrc_residual_cool"]
        bucket["delta_residual_cool"] += r["delta_residual_cool"]
        bucket["room_count"] += 1

    project_summary = sorted(
        [{"project_id": pid, **v} for pid, v in by_project.items()],
        key=lambda x: abs(x["delta_residual_cool"]),
        reverse=True,
    )
    for ps in project_summary:
        ps["salas_residual_cool"] = round(ps["salas_residual_cool"])
        ps["vrc_residual_cool"] = round(ps["vrc_residual_cool"], 1)
        ps["delta_residual_cool"] = round(ps["delta_residual_cool"], 1)

    return {
        "room_count": len(rows),
        "project_count": len(by_project),
        "exact_residual_count": exact_count,
        "exact_residual_rate": round(exact_count / len(rows) * 100, 1) if rows else None,
        "total_salas_residual_cool": round(total_salas_res_cool),
        "total_vrc_residual_cool": round(total_vrc_res_cool, 1),
        "total_delta_residual_cool": round(total_vrc_res_cool - total_salas_res_cool, 1),
        "total_salas_residual_heat": round(total_salas_res_heat),
        "total_vrc_residual_heat": round(total_vrc_res_heat, 1),
        "total_delta_residual_heat": round(total_vrc_res_heat - total_salas_res_heat, 1),
        "vrc_breakdown_cool": {
            "infiltration": round(total_vrc_infil, 1),
            "lighting": round(total_vrc_light, 1),
            "people": round(total_vrc_people, 1),
            "appliances": round(total_vrc_appl, 1),
        },
        "by_project": project_summary,
    }


def build_residual_audit(battery_records: list[dict[str, Any]]) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    for record in battery_records:
        try:
            project_rows = _build_project_rows(record)
            if project_rows:
                rows.extend(project_rows)
            else:
                skipped.append({"id": record.get("id"), "reason": "no_comparison_data"})
        except Exception as exc:
            skipped.append({"id": record.get("id"), "reason": str(exc)})

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "battery_count": len(battery_records),
        "summary": _summarize(rows),
        "rows": rows,
        "skipped": skipped,
    }
