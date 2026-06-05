"""PDF report generation for VRC (Vallus Residential Calculator).

Report model:
  1. Overall Unit / Home Summary
  2. Salas O'Brien Comparison (only when imported reference values exist)
  3. Airflow Summary Sheet
  4. Details / Troubleshooting Sheet
"""

from __future__ import annotations

import io
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import landscape, letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from backend.engine.calculator import ProjectResult, UnitResult
from backend.engine.constants import CFM_PER_TON
from backend.engine.models import Level, LineItem, Project, Room
from backend.engine.formulas import round_half_up

_BLACK = colors.black
_WHITE = colors.white
_GRAY_HEAD = colors.HexColor("#BFBFBF")
_GRAY_ALT = colors.HexColor("#F2F2F2")
_BLUE_CELL = colors.HexColor("#D6E4F0")
_YELLOW_NOTE = colors.HexColor("#FFF8CC")

_DISCLAIMER = (
    "These loads depend on the project assumptions and room inputs summarized in this report. "
    "Any deviation during construction can change the cooling/heating load and equipment sizing. "
    "Use the Details / Troubleshooting Sheet to verify entered areas, construction types, "
    "orientations, people counts, appliance watts, and room assignments."
)


def _fmt_int(value: int | float | None) -> str:
    if value is None:
        return "-"
    return f"{round(value):,}"


def _fmt_f(value: float | int | None, places: int = 1) -> str:
    if value is None:
        return "-"
    return f"{float(value):.{places}f}"


def _base_style(extra: list | None = None) -> list:
    return [
        ("FONTSIZE", (0, 0), (-1, -1), 7.2),
        ("GRID", (0, 0), (-1, -1), 0.35, _BLACK),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 3),
        ("RIGHTPADDING", (0, 0), (-1, -1), 3),
        ("TOPPADDING", (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
        *(extra or []),
    ]


def _section_title(title: str) -> Table:
    table = Table([[title]], colWidths=[720], hAlign="LEFT")
    table.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, -1), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 14),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("BACKGROUND", (0, 0), (-1, -1), _GRAY_HEAD),
        ("BOX", (0, 0), (-1, -1), 1.0, _BLACK),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return table


def _project_header(project: Project, right_label: str = "") -> Table:
    meta = project.metadata
    front = meta.get("front_door_faces", "")
    house_faces = f"Worst {front}" if front else ""
    data = [
        ["Project:", project.name, "Date:", meta.get("date", "")],
        ["Location:", project.location, "By:", meta.get("by", "")],
        ["Description:", project.description, right_label or "House Faces:", right_label and "" or house_faces],
    ]
    table = Table(data, colWidths=[70, 380, 80, 190], hAlign="LEFT")
    table.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold"),
        ("FONTNAME", (2, 0), (2, -1), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("LINEBELOW", (1, 0), (1, -1), 0.6, _BLACK),
        ("LINEBELOW", (3, 0), (3, -1), 0.6, _BLACK),
        ("VALIGN", (0, 0), (-1, -1), "BOTTOM"),
        ("TOPPADDING", (0, 0), (-1, -1), 1),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1),
    ]))
    return table


def _unit_metadata(project: Project, result: ProjectResult) -> list[dict]:
    units = project.metadata.get("units") or []
    if not units:
        units = [{
            "id": "unit-whole-house",
            "name": "Whole House",
            "selected_tons": result.system_tons,
            "selected_kw": result.system_kw,
        }]
    normalized = []
    for index, unit in enumerate(units):
        normalized.append({
            "id": str(unit.get("id", f"unit-{index + 1}")),
            "name": str(unit.get("name", f"Unit {index + 1}")),
            "selected_tons": float(unit.get("selected_tons") or (result.system_tons if index == 0 else 0)),
            "selected_kw": float(unit.get("selected_kw") or (result.system_kw if index == 0 else 0)),
        })
    return normalized


def _zone_labels(project: Project) -> dict[str, str]:
    return {
        str(zone.get("id")): str(zone.get("name"))
        for zone in project.metadata.get("zones", [])
    }


def _rooms_by_unit(project: Project, result: ProjectResult) -> dict[str, list[tuple[str, Room]]]:
    units = _unit_metadata(project, result)
    primary_unit_id = units[0]["id"]
    grouped: dict[str, list[tuple[str, Room]]] = {unit["id"]: [] for unit in units}
    for level in project.levels:
        for room in level.rooms:
            unit_id = room.unit_id or primary_unit_id
            grouped.setdefault(unit_id, []).append((level.name, room))
    return grouped


def _room_result_lookup(result: ProjectResult) -> dict[str, object]:
    return {
        room.name: room
        for level in result.levels
        for room in level.room_results
    }


def _unit_result_lookup(result: ProjectResult) -> dict[str, UnitResult]:
    return {unit.id: unit for unit in result.unit_results}


def _component_label(item: LineItem) -> str:
    if item.kind == "internal_people":
        return "People"
    if item.kind == "internal_watts":
        return "Appliance"
    if item.kind == "glass":
        return "Glass"
    if item.kind == "infiltration":
        return "Infiltration"
    if item.assembly:
        code = item.assembly.code.upper()
        if code.startswith("G"):
            return "Glass"
        if code.startswith("D"):
            return "Door"
        if code.startswith(("C", "R")):
            return "Ceiling"
        if code.startswith("F"):
            return "Floor"
    return "Wall"


def _input_value(item: LineItem) -> str:
    if item.kind == "internal_people":
        return f"{_fmt_f(item.quantity, 0)} people"
    if item.kind == "internal_watts":
        return f"{_fmt_f(item.watts, 0)} W"
    if item.kind == "infiltration":
        return f"{_fmt_int(item.volume)} cf" if item.volume else "auto"
    if item.area:
        return f"{_fmt_f(item.area, 1)} sf"
    if item.quantity:
        return _fmt_f(item.quantity, 1)
    return "-"


def _room_area(room: Room) -> float:
    return float(room.floor_area or 0)


def _room_height(room: Room) -> float | None:
    if room.floor_area and room.volume:
        return room.volume / room.floor_area
    return None


def _home_summary_table(project: Project, result: ProjectResult) -> Table:
    total_area = sum(level.floor_area for level in project.levels)
    total_volume = sum(level.volume for level in project.levels)
    glass_area = sum(
        item.area
        for level in project.levels
        for item in level.line_items
        if item.kind == "glass"
    )
    glass_pct = glass_area / total_area * 100 if total_area else 0
    inf = project.infiltration
    data = [
        ["Home Summary", "Cooling", "Heating", "Reference"],
        ["Total Load", f"{_fmt_int(result.sensible_cooling)} Btu/hr", f"{_fmt_int(result.heating)} Btu/hr", ""],
        ["Minimum Capacity", f"{_fmt_f(result.tons_min, 2)} Tons", f"{_fmt_f(result.heating / 3412.0, 2)} kW", ""],
        ["Selected Capacity", f"{_fmt_f(result.system_tons, 1)} Tons", f"{_fmt_f(result.system_kw, 1)} kW", f"{_fmt_int(result.system_cfm)} CFM"],
        ["Floor Area / Volume", f"{_fmt_f(total_area, 1)} SF", f"{_fmt_int(total_volume)} CF", f"{_fmt_f(glass_pct, 1)}% glass"],
        ["Ventilation", "Mechanical" if inf.mode == "mechanical_ventilation" else "Standard ACH", f"{_fmt_int(inf.outside_air_cfm)} CFM" if inf.outside_air_cfm else "N/A CFM", ""],
    ]
    table = Table(data, colWidths=[165, 175, 175, 205], hAlign="LEFT")
    table.setStyle(TableStyle(_base_style([
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("BACKGROUND", (0, 0), (-1, 0), _GRAY_HEAD),
        ("BACKGROUND", (0, 1), (0, -1), _GRAY_ALT),
        ("ALIGN", (1, 1), (-1, -1), "RIGHT"),
    ])))
    return table


def _unit_summary_table(project: Project, result: ProjectResult) -> Table:
    units = _unit_metadata(project, result)
    unit_results = _unit_result_lookup(result)
    rooms_by_unit = _rooms_by_unit(project, result)
    dc = project.design_conditions
    rows = [[
        "Unit", "Area", "Cooling Load", "Heat Loss", "Min Tons", "Selected Tons",
        "Airflow", "Min kW", "Heat kW", "Cool LAT", "Heat LAT",
    ]]
    for index, unit in enumerate(units):
        unit_result = unit_results.get(unit["id"])
        selected_tons = unit["selected_tons"]
        selected_kw = unit["selected_kw"]
        cfm = round_half_up(selected_tons * CFM_PER_TON)
        sensible = unit_result.sensible_cooling if unit_result else 0
        heating = unit_result.heating if unit_result else 0
        area = sum(_room_area(room) for _, room in rooms_by_unit.get(unit["id"], []))
        cool_lat = dc.indoor_cooling_db - sensible / (1.1 * cfm) if cfm else None
        heat_lat = dc.indoor_heating_db + selected_kw * 3412.0 / (1.1 * cfm) if cfm else None
        rows.append([
            f"Unit {index + 1} - {unit['name']}",
            f"{_fmt_f(area, 1)} SF",
            f"{_fmt_int(sensible)}",
            f"{_fmt_int(heating)}",
            f"{_fmt_f(unit_result.tons_min if unit_result else 0, 2)}",
            f"{_fmt_f(selected_tons, 1)}",
            f"{_fmt_int(cfm)}",
            f"{_fmt_f(unit_result.kw_min if unit_result else 0, 2)}",
            f"{_fmt_f(selected_kw, 1)}",
            f"{_fmt_f(cool_lat, 1)} deg F",
            f"{_fmt_f(heat_lat, 1)} deg F",
        ])
    table = Table(rows, colWidths=[135, 58, 72, 72, 52, 66, 52, 52, 48, 54, 54], hAlign="LEFT", repeatRows=1)
    table.setStyle(TableStyle(_base_style([
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("BACKGROUND", (0, 0), (-1, 0), _BLUE_CELL),
        ("ALIGN", (1, 1), (-1, -1), "RIGHT"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [_WHITE, _GRAY_ALT]),
    ])))
    return table


def _construction_table(project: Project) -> Table:
    rows = [["Type", "U-Value", "SHGC", "Description"]]
    for code, assembly in sorted(project.assemblies.items()):
        rows.append([
            code,
            _fmt_f(assembly.u_value, 3) if assembly.u_value is not None else "",
            _fmt_f(assembly.shgc, 2) if assembly.shgc is not None else "",
            assembly.description or "",
        ])
    table = Table(rows, colWidths=[55, 70, 55, 590], hAlign="LEFT", repeatRows=1)
    table.setStyle(TableStyle(_base_style([
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("BACKGROUND", (0, 0), (-1, 0), _BLUE_CELL),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [_WHITE, _GRAY_ALT]),
    ])))
    return table


def _diff_text(model: int | float | None, reference: int | float | None, suffix: str = "") -> str:
    if model is None or reference is None:
        return "-"
    delta = float(model) - float(reference)
    sign = "+" if delta > 0 else ""
    return f"{sign}{_fmt_int(delta)}{suffix}"


def _comparison_section(project: Project, result: ProjectResult) -> list:
    comparison = project.metadata.get("salas_obrien_comparison")
    if not comparison:
        return []

    flowables: list = [Spacer(1, 8), _section_title("VRC vs. SALAS O'BRIEN COMPARISON"), Spacer(1, 6)]
    house = comparison.get("house", {})
    total_rows = [
        ["Metric", "ResLoad", "Salas O'Brien", "Delta"],
        [
            "Total Cooling",
            f"{_fmt_int(result.sensible_cooling)} Btu/hr",
            f"{_fmt_int(house.get('cooling_btuh'))} Btu/hr" if house.get("cooling_btuh") is not None else "-",
            f"{_diff_text(result.sensible_cooling, house.get('cooling_btuh'))} Btu/hr",
        ],
        [
            "Total Heating",
            f"{_fmt_int(result.heating)} Btu/hr",
            f"{_fmt_int(house.get('heating_btuh'))} Btu/hr" if house.get("heating_btuh") is not None else "-",
            f"{_diff_text(result.heating, house.get('heating_btuh'))} Btu/hr",
        ],
    ]
    total_table = Table(total_rows, colWidths=[180, 180, 180, 180], hAlign="LEFT")
    total_table.setStyle(TableStyle(_base_style([
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("BACKGROUND", (0, 0), (-1, 0), _BLUE_CELL),
        ("ALIGN", (1, 1), (-1, -1), "RIGHT"),
    ])))
    flowables.append(total_table)

    units = comparison.get("units") or []
    if units:
        flowables.append(Spacer(1, 6))
        unit_results = _unit_result_lookup(result)
        rows = [["Unit", "Model Cool", "Salas Cool", "Model Heat", "Salas Heat", "Model Tons", "Salas Tons", "Delta CFM"]]
        metadata_units = _unit_metadata(project, result)
        for index, reference_unit in enumerate(units):
            unit = metadata_units[index] if index < len(metadata_units) else {"id": "", "name": reference_unit.get("name", f"Unit {index + 1}"), "selected_tons": 0}
            unit_result = unit_results.get(unit["id"])
            model_cfm = round_half_up(float(unit.get("selected_tons") or 0) * CFM_PER_TON)
            rows.append([
                unit.get("name") or reference_unit.get("name", f"Unit {index + 1}"),
                _fmt_int(unit_result.sensible_cooling if unit_result else None),
                _fmt_int(reference_unit.get("cooling_btuh")),
                _fmt_int(unit_result.heating if unit_result else None),
                _fmt_int(reference_unit.get("heating_btuh")),
                _fmt_f(unit.get("selected_tons"), 1),
                _fmt_f(reference_unit.get("selected_tons"), 1),
                _diff_text(model_cfm, reference_unit.get("airflow_cfm"), " CFM"),
            ])
        unit_table = Table(rows, colWidths=[120, 78, 78, 78, 78, 70, 70, 90], hAlign="LEFT", repeatRows=1)
        unit_table.setStyle(TableStyle(_base_style([
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("BACKGROUND", (0, 0), (-1, 0), _BLUE_CELL),
            ("ALIGN", (1, 1), (-1, -1), "RIGHT"),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [_WHITE, _GRAY_ALT]),
        ])))
        flowables.append(unit_table)

    rooms = comparison.get("rooms") or {}
    if rooms:
        flowables.append(Spacer(1, 6))
        room_results = _room_result_lookup(result)
        rows = [[
            "Room", "Model Cool", "Salas Cool", "Δ Cool", "Model Heat", "Salas Heat",
            "Δ Heat", "Model CFM", "Salas CFM", "Δ CFM",
        ]]
        for room_name, reference_room in rooms.items():
            model_room = room_results.get(room_name)
            if model_room is None:
                continue
            rows.append([
                room_name,
                _fmt_int(model_room.cooling_btuh),
                _fmt_int(reference_room.get("cooling_btuh")),
                _diff_text(model_room.cooling_btuh, reference_room.get("cooling_btuh")),
                _fmt_int(model_room.heating_btuh),
                _fmt_int(reference_room.get("heating_btuh")),
                _diff_text(model_room.heating_btuh, reference_room.get("heating_btuh")),
                f"{_fmt_int(model_room.cfm_cool)}/{_fmt_int(model_room.cfm_heat)}/{_fmt_int(model_room.cfm_avg)}",
                f"{_fmt_int(reference_room.get('cfm_cool'))}/{_fmt_int(reference_room.get('cfm_heat'))}/{_fmt_int(reference_room.get('cfm_avg'))}",
                _diff_text(model_room.cfm_avg, reference_room.get("cfm_avg")),
            ])
        room_table = Table(rows, colWidths=[112, 62, 62, 54, 62, 62, 54, 76, 76, 54], hAlign="LEFT", repeatRows=1)
        room_table.setStyle(TableStyle(_base_style([
            ("FONTSIZE", (0, 0), (-1, -1), 6.4),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("BACKGROUND", (0, 0), (-1, 0), _BLUE_CELL),
            ("ALIGN", (1, 1), (-1, -1), "RIGHT"),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [_WHITE, _GRAY_ALT]),
        ])))
        flowables.append(room_table)
    return flowables


def _summary_page(project: Project, result: ProjectResult, styles: object) -> list:
    note_style = ParagraphStyle("report_note", parent=styles["Normal"], fontSize=7.5, leading=10)
    return [
        _project_header(project),
        Spacer(1, 8),
        _section_title("OVERALL UNIT / HOME SUMMARY"),
        Spacer(1, 7),
        Paragraph(_DISCLAIMER, note_style),
        Spacer(1, 8),
        _home_summary_table(project, result),
        Spacer(1, 8),
        _unit_summary_table(project, result),
        Spacer(1, 8),
        _construction_table(project),
    ]


def _comparison_page(project: Project, result: ProjectResult) -> list:
    section = _comparison_section(project, result)
    if not section:
        return []
    return [
        _project_header(project),
        *section,
    ]


def _airflow_rows_for_unit(project: Project, result: ProjectResult, unit_id: str) -> list[list]:
    room_results = _room_result_lookup(result)
    zones = _zone_labels(project)
    units = _unit_metadata(project, result)
    primary_unit_id = units[0]["id"]
    rows = []
    for level in project.levels:
        for room in level.rooms:
            room_unit_id = room.unit_id or primary_unit_id
            if room_unit_id != unit_id:
                continue
            room_result = room_results.get(room.name)
            if not room_result:
                continue
            rows.append([
                room.name,
                zones.get(str(room.zone_id), level.name),
                _fmt_f(_room_area(room), 1),
                _fmt_int(room_result.cooling_btuh),
                _fmt_int(room_result.heating_btuh),
                _fmt_int(room_result.cfm_cool),
                _fmt_int(room_result.cfm_heat),
                _fmt_int(room_result.cfm_avg),
                "",
            ])
    return rows


def _airflow_unit_table(project: Project, result: ProjectResult, unit: dict, index: int) -> Table:
    rows = _airflow_rows_for_unit(project, result, unit["id"])
    selected_cfm = round_half_up(unit["selected_tons"] * CFM_PER_TON)
    cool_total = sum(int(str(row[5]).replace(",", "")) for row in rows)
    heat_total = sum(int(str(row[6]).replace(",", "")) for row in rows)
    avg_total = sum(int(str(row[7]).replace(",", "")) for row in rows)
    data = [
        [f"Unit {index + 1} - {unit['name']}", "", "", "", "", f"Target: {_fmt_int(selected_cfm)} CFM", "", "", ""],
        ["Room", "Zone/Floor", "Area", "Cooling", "Heating", "CFM Cool", "CFM Heat", "CFM Avg", "Duct Size"],
        *rows,
        ["TOTAL / QA", "", "", "", "", _fmt_int(cool_total), _fmt_int(heat_total), _fmt_int(avg_total), ""],
    ]
    table = Table(data, colWidths=[135, 105, 55, 70, 70, 65, 65, 60, 60], hAlign="LEFT", repeatRows=2)
    table.setStyle(TableStyle(_base_style([
        ("SPAN", (0, 0), (4, 0)),
        ("SPAN", (5, 0), (8, 0)),
        ("FONTNAME", (0, 0), (-1, 1), "Helvetica-Bold"),
        ("BACKGROUND", (0, 0), (-1, 0), _GRAY_HEAD),
        ("BACKGROUND", (0, 1), (-1, 1), _BLUE_CELL),
        ("BACKGROUND", (0, -1), (-1, -1), _YELLOW_NOTE),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("ALIGN", (2, 2), (-1, -1), "RIGHT"),
        ("ROWBACKGROUNDS", (0, 2), (-1, -2), [_WHITE, _GRAY_ALT]),
    ])))
    return table


def _airflow_page(project: Project, result: ProjectResult) -> list:
    story = [
        _project_header(project),
        Spacer(1, 8),
        _section_title("AIRFLOW SUMMARY SHEET"),
        Spacer(1, 6),
    ]
    for index, unit in enumerate(_unit_metadata(project, result)):
        if index:
            story.append(Spacer(1, 8))
        story.append(_airflow_unit_table(project, result, unit, index))
    return story


def _components_by_room(level: Level) -> dict[str, list[LineItem]]:
    grouped: dict[str, list[LineItem]] = {room.name: [] for room in level.rooms}
    for item in level.line_items:
        if item.room_name:
            grouped.setdefault(item.room_name, []).append(item)
    return grouped


def _detail_rows(project: Project, result: ProjectResult) -> list[list]:
    zones = _zone_labels(project)
    units = {unit["id"]: unit["name"] for unit in _unit_metadata(project, result)}
    primary_unit_id = next(iter(units))
    rows: list[list] = []
    for level in project.levels:
        components = _components_by_room(level)
        for room in level.rooms:
            room_unit_id = room.unit_id or primary_unit_id
            assignment = units.get(room_unit_id, "Unit")
            if room.zone_id:
                assignment = f"{assignment} / {zones.get(str(room.zone_id), room.zone_id)}"
            room_components = components.get(room.name, [])
            if not room_components:
                rows.append([
                    room.name, level.name, assignment, _fmt_f(_room_area(room), 1),
                    _fmt_f(_room_height(room), 1), _fmt_int(room.volume),
                    "Room", "", "", "No components entered",
                ])
            for item in room_components:
                assembly = item.assembly.code if item.assembly else ""
                rows.append([
                    room.name,
                    level.name,
                    assignment,
                    _fmt_f(_room_area(room), 1),
                    _fmt_f(_room_height(room), 1),
                    _fmt_int(room.volume),
                    _component_label(item),
                    assembly,
                    item.direction or "",
                    f"{item.name}: {_input_value(item)}",
                ])
    return rows


def _detail_page(project: Project, result: ProjectResult) -> list:
    rows = _detail_rows(project, result)
    data = [[
        "Room", "Floor", "Unit / Zone", "Room SF", "Ht", "Vol", "Input Type",
        "Code", "Facing", "Entered Assumption",
    ], *rows]
    table = Table(data, colWidths=[82, 55, 92, 48, 35, 55, 62, 40, 45, 303], hAlign="LEFT", repeatRows=1)
    table.setStyle(TableStyle(_base_style([
        ("FONTSIZE", (0, 0), (-1, -1), 6.4),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("BACKGROUND", (0, 0), (-1, 0), _BLUE_CELL),
        ("ALIGN", (3, 1), (5, -1), "RIGHT"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [_WHITE, _GRAY_ALT]),
    ])))
    return [
        _project_header(project),
        Spacer(1, 8),
        _section_title("DETAILS / TROUBLESHOOTING SHEET"),
        Spacer(1, 6),
        table,
    ]


def generate_resload_pdf(
    project: Project,
    result: ProjectResult,
) -> bytes:
    """Generate the VRC load calculation PDF and return it as bytes.

    Uses io.BytesIO so no temporary file is written to disk — safe for
    serverless environments where the filesystem may be read-only.
    """
    styles = getSampleStyleSheet()
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=landscape(letter),
        rightMargin=36,
        leftMargin=36,
        topMargin=36,
        bottomMargin=36,
        pageCompression=0,
    )

    story: list = []
    story.extend(_summary_page(project, result, styles))
    comparison_page = _comparison_page(project, result)
    if comparison_page:
        story.append(PageBreak())
        story.extend(comparison_page)
    story.append(PageBreak())
    story.extend(_airflow_page(project, result))
    story.append(PageBreak())
    story.extend(_detail_page(project, result))
    doc.build(story)
    return buffer.getvalue()
