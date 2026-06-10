"""Build a component-level variance report across the test battery.

Compares VRC engine output to Salas O'Brien's per-component BTU/hr values
extracted at PDF import time.  Output is a JSON file consumed by an analysis
skill — not a UI feature.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from backend.engine import calculate_project
from backend.engine.calculator import (
    LineResult,
    ProjectResult,
    infer_cooling_cltd,
)
from backend.engine.formulas import glass_load_factor, round_half_up_decimal
from backend.engine.models import LineItem

from .serialization import project_from_payload


# ── Helpers ──────────────────────────────────────────────────────────────────

_TYPE_FROM_CODE = {
    "G": "Glass",
    "W": "Wall",
    "C": "Ceiling",
    "F": "Floor",
    "D": "Door",
}


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


def _component_type(code: str) -> str:
    return _TYPE_FROM_CODE.get(code[0].upper(), code) if code else "Unknown"


def _assembly_spec_key(type_code: str, u_value: float | None, cltd_or_clf: float | None) -> tuple:
    return (type_code, u_value, cltd_or_clf)


def _vrc_spec_for_line(item: LineItem, lr: LineResult) -> tuple | None:
    """Derive the assembly spec key for a VRC line result.

    Returns None for items that should be excluded (infiltration, lighting,
    people, appliances).
    """
    if item.kind in ("infiltration", "internal_people", "internal_watts"):
        return None
    if lr.name.startswith("Auto infiltration - ") or lr.name.startswith("Auto lighting - "):
        return None

    assembly_code = item.assembly.code.upper() if item.assembly else ""
    if not assembly_code:
        return None
    u_value = item.assembly.u_value if item.assembly else None

    if item.kind == "glass":
        if item.assembly and item.assembly.u_value is not None and item.assembly.shgc is not None and item.direction:
            clf = glass_load_factor(
                item.direction,
                u_value=item.assembly.u_value,
                shgc=item.assembly.shgc,
            )
        else:
            clf = item.cooling_load_factor
        return _assembly_spec_key(assembly_code, u_value, clf)
    else:
        cltd = infer_cooling_cltd(item)
        return _assembly_spec_key(assembly_code, u_value, cltd)


# ── Per-project variance ────────────────────────────────────────────────────

def _build_room_variance(
    room_name: str,
    vrc_lines: list[tuple[LineItem, LineResult]],
    salas_components: list[dict[str, Any]],
) -> dict[str, Any]:
    """Build component variance data for a single room."""
    component_heat_available = any(
        comp.get("salas_heat_btuh") is not None
        for comp in salas_components
        if isinstance(comp, dict)
    )

    # Group VRC lines by assembly spec
    vrc_by_spec: dict[tuple, dict[str, float]] = {}
    for item, lr in vrc_lines:
        spec = _vrc_spec_for_line(item, lr)
        if spec is None:
            continue
        bucket = vrc_by_spec.setdefault(spec, {"cool": 0.0, "heat": 0.0, "qty": 0.0})
        bucket["cool"] += lr.cooling_btuh
        bucket["heat"] += lr.heating_btuh
        bucket["qty"] += item.area if item.area else item.quantity

    # Group Salas components by assembly spec
    salas_by_spec: dict[tuple, dict[str, float]] = {}
    for comp in salas_components:
        type_code = comp.get("type_code", "")
        if not type_code:
            continue
        comp_type = _component_type(type_code)
        if comp_type not in ("Glass", "Wall", "Ceiling", "Floor", "Door"):
            continue
        u_val = comp.get("u_value")
        if comp_type == "Glass":
            cltd_or_clf = comp.get("clf")
        else:
            cltd_or_clf = comp.get("cltd")
        spec = _assembly_spec_key(type_code, u_val, cltd_or_clf)
        bucket = salas_by_spec.setdefault(spec, {"cool": 0.0, "heat": 0.0, "qty": 0.0})
        bucket["cool"] += comp.get("salas_cool_btuh") or 0.0
        if component_heat_available:
            bucket["heat"] += comp.get("salas_heat_btuh") or 0.0
        bucket["qty"] += comp.get("qty") or 0.0

    # Merge specs from both sides
    all_specs = set(vrc_by_spec.keys()) | set(salas_by_spec.keys())

    by_type: dict[str, dict[str, float]] = {}
    components: list[dict[str, Any]] = []

    for spec in sorted(all_specs, key=str):
        type_code, u_value, cltd_or_clf = spec
        comp_type = _component_type(type_code)
        vrc = vrc_by_spec.get(spec, {"cool": 0.0, "heat": 0.0, "qty": 0.0})
        salas = salas_by_spec.get(spec, {"cool": 0.0, "heat": 0.0, "qty": 0.0})

        # Round for output
        s_cool = round(salas["cool"])
        v_cool = round(vrc["cool"])
        s_heat = round(salas["heat"])
        v_heat = round(vrc["heat"])
        d_cool = v_cool - s_cool
        d_heat = v_heat - s_heat

        # Type-level subtotals (include all, even zero-delta)
        type_bucket = by_type.setdefault(comp_type, {
            "salas_cool": 0, "vrc_cool": 0, "delta_cool": 0,
            "salas_heat": 0, "vrc_heat": 0, "delta_heat": 0,
        })
        type_bucket["salas_cool"] += s_cool
        type_bucket["vrc_cool"] += v_cool
        type_bucket["delta_cool"] += d_cool
        if component_heat_available:
            type_bucket["salas_heat"] += s_heat
            type_bucket["vrc_heat"] += v_heat
            type_bucket["delta_heat"] += d_heat

        # Only include non-zero-delta component rows
        if d_cool != 0 or (component_heat_available and d_heat != 0):
            row: dict[str, Any] = {
                "type": comp_type,
                "type_code": type_code,
                "u_value": u_value,
            }
            if comp_type == "Glass":
                row["clf"] = cltd_or_clf
            else:
                row["cltd"] = cltd_or_clf
            row.update({
                "salas_qty": round(salas["qty"], 1),
                "vrc_qty": round(vrc["qty"], 1),
                "salas_cool": s_cool,
                "vrc_cool": v_cool,
                "delta_cool": d_cool,
            })
            if component_heat_available:
                row.update({
                    "salas_heat": s_heat,
                    "vrc_heat": v_heat,
                    "delta_heat": d_heat,
                })
            components.append(row)

    if not component_heat_available:
        for totals in by_type.values():
            totals["salas_heat"] = None
            totals["vrc_heat"] = None
            totals["delta_heat"] = None

    return {
        "component_heat_available": component_heat_available,
        "by_type": by_type,
        "components": components,
    }


def _build_project_entry(
    record: dict[str, Any],
) -> dict[str, Any] | None:
    """Build a detail report entry for one battery project."""
    payload = record.get("payload_json")
    if not payload:
        return None

    project = project_from_payload(payload)
    result = calculate_project(project)

    meta = payload.get("project", {}).get("metadata", {})
    comparison = meta.get("salas_obrien_comparison")
    if not comparison:
        return None

    snapshot = record.get("comparison_snapshot") or {}
    system = snapshot.get("system", {})

    entry: dict[str, Any] = {
        "id": record["id"],
        "name": _record_label(record, payload),
        "import_fidelity_passed": record.get("import_fidelity_passed"),
        "system": {
            "salas_cool_btuh": system.get("salas_cooling_btuh"),
            "vrc_cool_btuh": system.get("vrc_cooling_btuh") or result.sensible_cooling,
            "delta_cool": (system.get("vrc_cooling_btuh") or result.sensible_cooling)
                         - (system.get("salas_cooling_btuh") or 0),
            "salas_heat_btuh": system.get("salas_heating_btuh"),
            "vrc_heat_btuh": system.get("vrc_heating_btuh") or result.heating,
            "delta_heat": (system.get("vrc_heating_btuh") or result.heating)
                         - (system.get("salas_heating_btuh") or 0),
        },
    }

    # Check for component-level Salas data
    salas_rooms = comparison.get("rooms")
    if not isinstance(salas_rooms, dict):
        entry["component_data_available"] = False
        entry["rooms"] = []
        return entry

    has_any_components = any(
        isinstance(r, dict) and "components" in r
        for r in salas_rooms.values()
    )
    if not has_any_components:
        entry["component_data_available"] = False
        entry["rooms"] = []
        return entry

    entry["component_data_available"] = True

    # Build line_items index by room_name
    line_items_by_room: dict[str, list[tuple[LineItem, LineResult]]] = {}
    for level, level_result in zip(project.levels, result.levels):
        for item, lr in zip(level.line_items, level_result.line_results):
            if lr.room_name:
                line_items_by_room.setdefault(lr.room_name, []).append((item, lr))

    rooms_out: list[dict[str, Any]] = []
    for room_name, salas_room in salas_rooms.items():
        if not isinstance(salas_room, dict):
            continue

        salas_components = salas_room.get("components", [])
        vrc_lines = line_items_by_room.get(room_name, [])

        # Get room-level totals from comparison snapshot rooms
        snap_rooms = snapshot.get("rooms", [])
        snap_room = next((r for r in snap_rooms if r.get("name") == room_name), {})
        vrc_cool = snap_room.get("vrc_cooling") or 0
        salas_cool = salas_room.get("cooling_btuh") or 0
        vrc_heat = snap_room.get("vrc_heating") or 0
        salas_heat = salas_room.get("heating_btuh") or 0

        room_entry: dict[str, Any] = {
            "name": room_name,
            "salas_cool_total": round(salas_cool),
            "vrc_cool_total": round(vrc_cool),
            "delta_cool": round(vrc_cool - salas_cool),
            "salas_heat_total": round(salas_heat),
            "vrc_heat_total": round(vrc_heat),
            "delta_heat": round(vrc_heat - salas_heat),
        }

        if salas_components:
            variance = _build_room_variance(room_name, vrc_lines, salas_components)
            room_entry["component_heat_available"] = variance["component_heat_available"]
            room_entry["by_type"] = variance["by_type"]
            room_entry["components"] = variance["components"]

        rooms_out.append(room_entry)

    entry["rooms"] = rooms_out
    return entry


# ── Public API ───────────────────────────────────────────────────────────────

def build_detail_report(battery_records: list[dict[str, Any]]) -> dict[str, Any]:
    """Build the full detail report from battery records.

    Each record should include payload_json, comparison_snapshot, and
    import_fidelity_passed.
    """
    projects: list[dict[str, Any]] = []
    for record in battery_records:
        try:
            entry = _build_project_entry(record)
            if entry:
                projects.append(entry)
        except Exception:
            continue

    # Build cross-battery summary by type
    summary_by_type: dict[str, dict[str, Any]] = {}
    for proj in projects:
        if not proj.get("component_data_available"):
            continue
        project_types_seen: set[str] = set()
        for room in proj.get("rooms", []):
            for comp_type, totals in room.get("by_type", {}).items():
                bucket = summary_by_type.setdefault(comp_type, {
                    "project_count": 0,
                    "total_salas_cool": 0,
                    "total_vrc_cool": 0,
                    "total_salas_heat": None,
                    "total_vrc_heat": None,
                    "_delta_pcts_cool": [],
                    "_delta_pcts_heat": [],
                })
                bucket["total_salas_cool"] += totals.get("salas_cool", 0)
                bucket["total_vrc_cool"] += totals.get("vrc_cool", 0)
                if room.get("component_heat_available"):
                    bucket["total_salas_heat"] = (bucket["total_salas_heat"] or 0) + totals.get("salas_heat", 0)
                    bucket["total_vrc_heat"] = (bucket["total_vrc_heat"] or 0) + totals.get("vrc_heat", 0)
                project_types_seen.add(comp_type)

        for comp_type in project_types_seen:
            summary_by_type[comp_type]["project_count"] += 1

    # Compute avg delta percentages and clean up internal accumulators
    for comp_type, bucket in summary_by_type.items():
        s_cool = bucket["total_salas_cool"]
        v_cool = bucket["total_vrc_cool"]
        bucket["avg_delta_pct_cool"] = round((v_cool - s_cool) / s_cool * 100, 1) if s_cool else None
        s_heat = bucket["total_salas_heat"]
        v_heat = bucket["total_vrc_heat"]
        bucket["avg_delta_pct_heat"] = round((v_heat - s_heat) / s_heat * 100, 1) if s_heat else None
        bucket["component_heat_available"] = s_heat is not None and v_heat is not None
        del bucket["_delta_pcts_cool"]
        del bucket["_delta_pcts_heat"]

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "battery_count": len(projects),
        "summary_by_type": summary_by_type,
        "projects": projects,
    }
