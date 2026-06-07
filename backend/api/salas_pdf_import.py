"""Convert Salas O'Brien resload PDFs into the Markdown import format."""

from __future__ import annotations

import os
import re
import tempfile
from pathlib import Path
from typing import Any

try:
    import pdfplumber
except ImportError:  # pragma: no cover - exercised only in missing dependency environments
    pdfplumber = None

MAX_FILE_SIZE = 10 * 1024 * 1024


def clean_num(value: Any) -> float | None:
    if value is None or str(value).strip() in {"", "-", "--"}:
        return None
    try:
        parsed = float(str(value).replace(" ", "").replace(",", ""))
    except ValueError:
        return None
    return parsed if parsed > 0 else None


def clean_g1_desc(description: str) -> str:
    cleaned = re.sub(r"\b(Right|Front|Left|Back)\b", "", str(description))
    cleaned = re.sub(r"\s*\([^)]+\)", "", cleaned)
    return " ".join(cleaned.split())


def fmt_qty(quantity: float) -> str:
    return str(int(quantity)) if quantity == int(quantity) else str(round(quantity, 3)).rstrip("0").rstrip(".")


SKIP_ROWS = {
    "Type", "COOLING LOAD CALCULATION", "Components",
    "Subtotal (Btu/hr)", "Safety Factor", "Sensible Cooling Load (Btu/hr)",
    "Nominal Tons Required (75% sens. cap.)", "System Selection",
    "Infiltration 0.25 ACH", "Volume", "Area", "Lights (W)",
    "HEATING LOAD CALCULATION",
}

REPORT_FLOOR_LABELS = [
    "Whole House",
    "Main Level",
    "First Floor",
    "Second Floor",
    "Third Floor",
    "Basement",
    "Owner Suite",
]
REPORT_COMPONENT_TYPES = {"Glass", "Door", "Wall", "Ceiling", "Floor", "People", "Appliance"}
REPORT_DIRECTIONS = {"N", "NE", "E", "SE", "S", "SW", "W", "NW", "Shaded", "Skylight"}


def extract_unit_info(pdf: Any) -> dict[str, Any]:
    p1_text = pdf.pages[0].extract_text() or ""
    units = []
    zone_to_unit = {}

    if len(pdf.pages) > 1:
        seen = set()
        for table in pdf.pages[1].extract_tables():
            if not table or not table[0] or not table[0][0]:
                continue
            cell = str(table[0][0])
            first_line = cell.split("\n")[0].strip()
            unit_match = re.match(r"Unit\s+(\d+)\s*(.*)", first_line)
            if not unit_match:
                continue
            unit_num = unit_match.group(1)
            zone_name = unit_match.group(2).strip()
            if re.search(r"(Unit\s+\d+|Continued|Airflows?)", zone_name, re.I):
                zone_name = ""
            size_match = re.search(r"Size\s+([\d.]+)\s*Tons?", cell)
            airflow_match = re.search(r"Airflow\s+([\d,]+)\s*CFM", cell)
            heat_match = re.search(r"Heat\s*kW\s+([\d.]+)", cell)
            if not size_match:
                continue
            key = (unit_num, zone_name)
            if key in seen:
                continue
            seen.add(key)
            units.append({
                "num": unit_num,
                "name": f"Unit {unit_num}",
                "zone": zone_name,
                "sys_size": f"{size_match.group(1)} Tons",
                "airflow": f"{airflow_match.group(1).replace(',', '')} CFM" if airflow_match else "?",
                "heat_kw": f"{heat_match.group(1)} kW" if heat_match else "?",
            })
            if zone_name:
                zone_to_unit[zone_name.lower()] = f"Unit {unit_num}"

    if not units:
        system_match = re.search(r"System Size\s+([\d.]+)\s*Tons?\s+([\d.]+)\s*kW", p1_text)
        units.append({
            "num": "1",
            "name": "Unit 1",
            "zone": "",
            "sys_size": f"{system_match.group(1)} Tons" if system_match else "?",
            "airflow": "?",
            "heat_kw": f"{system_match.group(2)} kW" if system_match else "?",
        })

    floor_area_match = re.search(r"Floor Area Served\s+([\d,]+\.?\d*)\s*SF", p1_text)
    load_match = re.search(r"Sensible Load\s+([\d,]+)\s*Btu/hr\s+([\d,]+)\s*Btu/hr", p1_text)
    bedrooms_match = re.search(r"^(\d+)\s+Range\s", p1_text, re.MULTILINE)
    volume_match = re.search(r"(?:Volume\s+)?([\d ,]+)\s*ft3", p1_text)
    p2_text = pdf.pages[1].extract_text() or "" if len(pdf.pages) > 1 else ""
    facing_match = re.search(r"House Faces:\s*(.+?)(?:\n|$)", f"{p1_text}\n{p2_text}")

    volume_str = None
    if volume_match:
        volume_str = volume_match.group(1).replace(" ", "").replace(",", "")

    header = extract_header_fields(pdf)
    facing = header.get("facing") or (facing_match.group(1).strip() if facing_match else "")
    # Strip any worst/best-case qualifier the flat-text fallback may carry through.
    facing = re.sub(r"^(worst|best)(\s+case)?\s+", "", facing, flags=re.IGNORECASE).strip()

    return {
        "units": units,
        "zone_to_unit": zone_to_unit,
        "floor_area": f"{floor_area_match.group(1).replace(',', '')} SF" if floor_area_match else "?",
        "cool_load": f"{load_match.group(1).replace(',', '')} Btu/hr" if load_match else "?",
        "heat_load": f"{load_match.group(2).replace(',', '')} Btu/hr" if load_match else "?",
        "facing": facing or "-",
        "location": header.get("location", ""),
        "engineer": header.get("engineer", ""),
        "project_name": header.get("project_name", ""),
        "date": header.get("date", ""),
        "description": header.get("description", ""),
        "bedrooms": int(bedrooms_match.group(1)) if bedrooms_match else None,
        "volume": f"{volume_str} CF" if volume_str else None,
    }


def _pdf_text_lines(pdf: Any) -> list[str]:
    lines: list[str] = []
    for page in pdf.pages:
        text = page.extract_text() or ""
        lines.extend(line.strip() for line in text.splitlines() if line.strip())
    return lines


def _header_value(text: str, label: str, next_label: str) -> str:
    match = re.search(rf"{re.escape(label)}:\s*(.+?)\s+{re.escape(next_label)}:", text, re.DOTALL)
    return " ".join(match.group(1).split()) if match else ""


def _cluster_header_lines(page: Any, max_top_frac: float = 0.45) -> list[str]:
    """Reconstruct header rows by clustering words on their vertical position.

    The Salas cover page puts field values in positioned form cells, so flat
    ``extract_text`` drops them (Location, House Faces). Grouping words by their
    ``top`` coordinate rebuilds each label/value row faithfully.
    """

    try:
        words = page.extract_words(use_text_flow=False, keep_blank_chars=False)
    except Exception:  # pragma: no cover - defensive
        return []
    cutoff = (page.height or 0) * max_top_frac
    rows: dict[int, list[dict[str, Any]]] = {}
    for word in words:
        if cutoff and word["top"] > cutoff:
            continue
        rows.setdefault(round(word["top"] / 3), []).append(word)
    lines: list[str] = []
    for key in sorted(rows):
        ordered = sorted(rows[key], key=lambda w: w["x0"])
        lines.append(" ".join(w["text"] for w in ordered))
    return lines


def extract_header_fields(pdf: Any) -> dict[str, str]:
    """Pull cover-page header fields positionally (Location, facing, etc.)."""

    text = "\n".join(_cluster_header_lines(pdf.pages[0])) if pdf.pages else ""

    def between(label: str, next_label: str) -> str:
        match = re.search(rf"{re.escape(label)}:\s*(.+?)\s+{re.escape(next_label)}:", text)
        return " ".join(match.group(1).split()) if match else ""

    def end_of_line(label: str) -> str:
        match = re.search(rf"{re.escape(label)}:\s*(.+?)\s*$", text, re.MULTILINE)
        return " ".join(match.group(1).split()) if match else ""

    facing = end_of_line("House Faces")
    # Drop the worst/best-case orientation qualifier; keep the compass facing.
    facing = re.sub(r"^(worst|best)(\s+case)?\s+", "", facing, flags=re.IGNORECASE).strip()

    return {
        "project_name": between("Project", "Date"),
        "date": end_of_line("Date"),
        "location": between("Location", "By"),
        "engineer": end_of_line("By"),
        "description": between("Description", "House Faces"),
        "facing": facing,
    }


def _report_assemblies(lines: list[str]) -> dict[str, dict[str, Any]]:
    assemblies: dict[str, dict[str, Any]] = {}
    pattern = re.compile(
        r"^(?P<code>[A-Z]\d+)\s+(?P<u>\d+(?:\.\d+)?)(?:\s+(?P<shgc>0?\.\d+))?\s+(?P<description>.+?)$"
    )
    for line in lines:
        match = pattern.match(line)
        if not match:
            continue
        code = match.group("code")
        assemblies[code] = {
            "code": code,
            "u_value": float(match.group("u")),
            "description": match.group("description").strip(),
        }
        if match.group("shgc") is not None:
            assemblies[code]["shgc"] = float(match.group("shgc"))
    return assemblies


def _report_unit_summary(lines: list[str]) -> dict[str, dict[str, str]]:
    summaries: dict[str, dict[str, str]] = {}
    pattern = re.compile(
        r"^(?P<unit>Unit\s+\d+)\s+-\s+(?P<name>.+?)\s+"
        r"(?P<area>[\d,]+(?:\.\d+)?)\s+SF\s+"
        r"(?P<cool>[\d,]+)\s+(?P<heat>[\d,]+)\s+"
        r"(?P<min_tons>[\d.]+)\s+(?P<selected_tons>[\d.]+)\s+"
        r"(?P<airflow>[\d,]+)\s+(?P<min_kw>[\d.]+)\s+(?P<selected_kw>[\d.]+)"
    )
    for line in lines:
        match = pattern.match(line)
        if not match:
            continue
        summaries[match.group("unit")] = {
            "name": match.group("name").strip(),
            "selected_tons": match.group("selected_tons"),
            "airflow": match.group("airflow"),
            "selected_kw": match.group("selected_kw"),
            "floor_area": match.group("area"),
            "cooling_btuh": match.group("cool"),
            "heating_btuh": match.group("heat"),
        }
    return summaries


def _split_report_room_prefix(prefix: str) -> tuple[str, str, str]:
    if prefix.endswith(" Whole House"):
        left = prefix[: -len(" Whole House")]
        for floor in REPORT_FLOOR_LABELS:
            suffix = f" {floor}"
            if left.endswith(suffix):
                return left[: -len(suffix)].strip(), floor, "Whole House"
        return left.strip(), "Whole House", "Whole House"
    if " Unit " not in prefix:
        return prefix.strip(), "Whole House", "Unit 1"
    left, unit_tail = prefix.rsplit(" Unit ", 1)
    assignment = f"Unit {unit_tail.strip()}"
    for floor in REPORT_FLOOR_LABELS:
        suffix = f" {floor}"
        if left.endswith(suffix):
            return left[: -len(suffix)].strip(), floor, assignment
    parts = left.rsplit(" ", 2)
    if len(parts) == 3:
        return parts[0].strip(), " ".join(parts[1:]).strip(), assignment
    return left.strip(), "Whole House", assignment


def _report_details(lines: list[str]) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]]]:
    rooms: dict[str, dict[str, Any]] = {}
    components: list[dict[str, Any]] = []
    detail_pattern = re.compile(
        r"^(?P<prefix>.+?)\s+"
        r"(?P<sf>\d+(?:\.\d+)?)\s+"
        r"(?P<height>\d+(?:\.\d+)?)\s+"
        r"(?P<volume>[\d,]+)\s+"
        r"(?P<input_type>Glass|Door|Wall|Ceiling|Floor|People|Appliance)\s+"
        r"(?P<rest>.+)$"
    )
    structural_pattern = re.compile(
        r"^(?P<code>[A-Z]\d+)\s+"
        r"(?:(?P<facing>N|NE|E|SE|S|SW|W|NW|Shaded|Skylight)\s+)?"
        r"(?P<label>.+?):\s*(?P<qty>[\d,]+(?:\.\d+)?)\s*sf$"
    )
    people_pattern = re.compile(r"^(.+?):\s*(?P<qty>[\d,]+(?:\.\d+)?)\s*people?$", re.IGNORECASE)
    appliance_pattern = re.compile(r"^(.+?):\s*(?P<qty>[\d,]+(?:\.\d+)?)\s*W$", re.IGNORECASE)

    for line in lines:
        match = detail_pattern.match(line)
        if not match:
            continue
        room_name, floor, assignment = _split_report_room_prefix(match.group("prefix"))
        if not room_name:
            continue
        unit_name = assignment.split("/", 1)[0].strip()
        zone_name = assignment.split("/", 1)[1].strip() if "/" in assignment else floor
        room = rooms.setdefault(room_name, {
            "name": room_name,
            "floor": floor,
            "unit": unit_name,
            "zone": zone_name,
            "sf": float(match.group("sf")),
            "height": float(match.group("height")),
            "volume": float(match.group("volume").replace(",", "")),
        })
        room["sf"] = float(match.group("sf"))
        room["height"] = float(match.group("height"))
        room["volume"] = float(match.group("volume").replace(",", ""))

        input_type = match.group("input_type")
        rest = match.group("rest").strip()
        if input_type in {"People", "Appliance"}:
            value_match = people_pattern.match(rest) if input_type == "People" else appliance_pattern.match(rest)
            if not value_match:
                continue
            components.append({
                "room": room_name,
                "type": "-",
                "description": "People" if input_type == "People" else "Appliances",
                "qty": float(value_match.group("qty").replace(",", "")),
                "unit": "person" if input_type == "People" else "W",
            })
            continue

        structural = structural_pattern.match(rest)
        if not structural:
            continue
        description = structural.group("label").strip()
        code = structural.group("code")
        facing = structural.group("facing")
        if facing and facing in REPORT_DIRECTIONS:
            description = f"{facing} {description}"
        components.append({
            "room": room_name,
            "type": code,
            "description": description,
            "qty": float(structural.group("qty").replace(",", "")),
            "unit": "sf",
        })
    return rooms, components


def _render_markdown_from_report_details(stem: str, pdf: Any) -> str | None:
    lines = _pdf_text_lines(pdf)
    if not any("DETAILS / TROUBLESHOOTING SHEET" in line for line in lines):
        return None
    all_text = "\n".join(lines)
    project_name = _header_value(all_text, "Project", "Date") or stem
    location = _header_value(all_text, "Location", "By")
    description = _header_value(all_text, "Description", "House Faces") or stem
    assemblies = _report_assemblies(lines)
    unit_summaries = _report_unit_summary(lines)
    rooms, components = _report_details(lines)
    if not rooms:
        return None

    units = sorted({room["unit"] for room in rooms.values()})
    lines_out = [
        f"# {project_name} - Cooling Load Data Export",
        "",
        f"**Project:** {description}",
        f"**Location:** {location}",
        "",
        "## SECTION 1 - Component Type Schedule",
        "",
        "| Type | Description | U-Value | SHGC |",
        "|------|-------------|--------:|-----:|",
    ]
    for code in sorted(assemblies):
        assembly = assemblies[code]
        lines_out.append(
            f"| {code} | {assembly.get('description', '')} | "
            f"{fmt_qty(float(assembly['u_value'])) if assembly.get('u_value') is not None else ''} | "
            f"{fmt_qty(float(assembly['shgc'])) if assembly.get('shgc') is not None else ''} |"
        )

    lines_out += ["", "### Unit Summary", "", "| Unit | Zone | System Size | Airflow | Heat | Total Floor Area | Sensible Cooling Load | Sensible Heating Load |", "|------|------|------------:|--------:|-----:|-----------------:|----------------------:|----------------------:|"]
    for unit in units:
        summary = unit_summaries.get(unit, {})
        lines_out.append(
            f"| {unit} |  | {summary.get('selected_tons', '1')} Tons | "
            f"{summary.get('airflow', '')} CFM | {summary.get('selected_kw', '5')} kW | "
            f"{summary.get('floor_area', '')} SF | {summary.get('cooling_btuh', '')} Btu/hr | "
            f"{summary.get('heating_btuh', '')} Btu/hr |"
        )

    lines_out += ["", "---", "", "## SECTION 3 - Room-by-Room User Inputs", ""]
    components_by_room: dict[str, list[dict[str, Any]]] = {}
    for component in components:
        components_by_room.setdefault(component["room"], []).append(component)
    for room_name, room in rooms.items():
        lines_out += [
            f"### {room_name}",
            f"**Unit:** {room['unit']} | **Zone:** {room['zone']} | **Ceiling Height:** {fmt_qty(room['height'])} ft  ",
            "",
            "| Type | Description | Qty |",
            "|------|-------------|----:|",
        ]
        for component in components_by_room.get(room_name, []):
            suffix = component["unit"]
            lines_out.append(
                f"| {component['type']} | {component['description']} | {fmt_qty(component['qty'])} {suffix} |"
            )
        lines_out += ["", "---", ""]
    return "\n".join(lines_out)


def extract_glass_specs(pdf: Any) -> dict[str, dict[str, str]]:
    specs = {}
    for table in pdf.pages[0].extract_tables():
        in_glass = False
        for row in table:
            row_flat = " ".join(str(cell or "") for cell in row)
            if "Glass Type" in row_flat and "U-Value" in row_flat:
                in_glass = True
                continue
            if not in_glass or not row or not row[1]:
                continue
            code = str(row[1] or "").strip()
            if not re.match(r"^G[123]$", code):
                break
            u_value = str(row[5] or "").strip() if len(row) > 5 else ""
            notes = str(row[7] or "").strip() if len(row) > 7 else ""
            glass_type = str(row[2] or "").strip() if len(row) > 2 else ""
            shgc_match = re.search(r"SHGC\s*([\d.]+)", notes, re.I)
            if u_value and re.match(r"^[\d.]+$", u_value):
                specs[code] = {
                    "uvalue": u_value,
                    "shgc": shgc_match.group(1) if shgc_match else "",
                    "glass_type": glass_type,
                }
    return specs


def extract_airflows(pdf: Any) -> dict[tuple[str, str], dict[str, int]]:
    airflows = {}
    if len(pdf.pages) < 2:
        return airflows
    for table in pdf.pages[1].extract_tables():
        if not table or not table[0] or not table[0][0]:
            continue
        unit_match = re.match(r"Unit\s+(\d+)", str(table[0][0]))
        if not unit_match:
            continue
        unit_name = f"Unit {unit_match.group(1)}"
        for row in table[1:]:
            if not row or not row[0]:
                continue
            room = str(row[0]).strip()
            if room in {"Room", "", "-"}:
                continue
            try:
                cool = float(str(row[1] or "0").replace(",", "").strip() or "0")
                heat = float(str(row[2] or "0").replace(",", "").strip() or "0")
                avg = float(str(row[3] or "0").replace(",", "").strip() or "0")
            except (ValueError, IndexError, TypeError):
                continue
            if cool > 0 or heat > 0:
                airflows[(room, unit_name)] = {"cool": int(cool), "heat": int(heat), "avg": int(avg)}
    return airflows


def extract_zones(pdf: Any, zone_to_unit: dict[str, str] | None = None) -> tuple[dict, list[str], dict, dict]:
    zone_to_unit = zone_to_unit or {}
    master_components: dict[str, dict[str, Any]] = {}
    room_order: list[str] = []
    room_meta: dict[str, dict[str, str]] = {}
    room_data: dict[str, dict[str, Any]] = {}
    seen_base_names = set()

    for page_index in range(2, len(pdf.pages)):
        page = pdf.pages[page_index]
        tables = page.extract_tables()
        if len(tables) < 2:
            continue
        zone_label = str(tables[0][0][0] or "").strip() or f"Zone {page_index - 1}"
        unit_name = zone_to_unit.get(zone_label.lower(), "Unit 1")
        table = tables[1]
        ceiling_row = table[0]
        name_row = table[1]
        rooms = []
        col = 9
        while col < len(name_row):
            raw_name = name_row[col]
            if raw_name and raw_name not in {"", "Qty", "Btu/hr", None}:
                room_name = raw_name.replace("\n", " ").strip()
                ceiling_height = str(ceiling_row[col] or "?").strip() if col < len(ceiling_row) else "?"
                if room_name in seen_base_names:
                    if room_name in room_data:
                        existing_zone = room_meta[room_name]["zone"]
                        renamed_existing = f"{room_name} - {existing_zone}"
                        room_order[room_order.index(room_name)] = renamed_existing
                        room_meta[renamed_existing] = room_meta.pop(room_name)
                        room_data[renamed_existing] = room_data.pop(room_name)
                    actual_key = f"{room_name} - {zone_label}"
                else:
                    actual_key = room_name
                    seen_base_names.add(room_name)
                rooms.append((actual_key, col, ceiling_height))
                if actual_key not in room_data:
                    room_order.append(actual_key)
                    room_meta[actual_key] = {"unit": unit_name, "zone": zone_label, "ceiling_ht": ceiling_height}
                    room_data[actual_key] = {}
            col += 2

        section = "cooling"
        for row in table[3:]:
            if not row or not any(cell for cell in row if cell):
                continue
            row0 = str(row[0] or "").strip()
            type_value = str(row[1] or "").strip()
            description = str(row[2] or "").strip() if len(row) > 2 else ""
            cltd_value = row[3] if len(row) > 3 else None
            u_value = row[4] if len(row) > 4 else None
            cooling_factor = str(row[5] or "").strip() if len(row) > 5 else ""

            if "HEATING" in row0 or any("HEATING" in str(cell or "") for cell in row[1:3]):
                section = "heating"
                continue
            if row0 == "Subtotal (Btu/hr)":
                key = "_cool_btuh" if section == "cooling" else "_heat_btuh"
                for actual_key, col, _ in rooms:
                    if col + 1 < len(row):
                        btuh = clean_num(str(row[col + 1] or "").replace(" ", ""))
                        if btuh and actual_key in room_data:
                            room_data[actual_key][key] = btuh
                continue
            if not type_value or type_value in SKIP_ROWS:
                continue
            if type_value in {"People", "Appliances (W)"}:
                if section != "cooling":
                    continue
                for actual_key, col, _ in rooms:
                    if col < len(row):
                        quantity = clean_num(row[col])
                        if quantity:
                            room_data[actual_key][type_value] = quantity
                continue

            description_clean = clean_g1_desc(description) if type_value == "G1" else description
            cltd_number = clean_num(cltd_value)
            u_number = clean_num(u_value)
            cltd_string = str(int(cltd_number)) if cltd_number is not None else "-"
            u_string = str(u_value).strip() if u_number is not None else "-"
            component_key = f"{type_value}|{description_clean}|{cltd_string}|{u_string}|{cooling_factor}"
            if section == "cooling":
                master_components.setdefault(component_key, {
                    "type": type_value,
                    "desc": description_clean,
                    "cltd": cltd_string,
                    "uvalue": u_string,
                    "clf": cooling_factor,
                })
                for actual_key, col, _ in rooms:
                    if col < len(row):
                        quantity = clean_num(row[col])
                        if quantity:
                            room_data[actual_key][component_key] = quantity
                            btuh_str = str(row[col + 1] or "").replace(" ", "") if col + 1 < len(row) else ""
                            btuh = clean_num(btuh_str)
                            if btuh:
                                room_data[actual_key][component_key + "|_cool"] = btuh
            else:
                for actual_key, col, _ in rooms:
                    if col + 1 < len(row) and actual_key in room_data:
                        btuh_str = str(row[col + 1] or "").replace(" ", "")
                        btuh = clean_num(btuh_str)
                        if btuh:
                            room_data[actual_key][component_key + "|_heat"] = btuh

    return master_components, room_order, room_meta, room_data


def render_markdown(
    filename: str,
    p1_text: str,
    unit_info: dict[str, Any],
    master_components: dict[str, dict[str, Any]],
    room_order: list[str],
    room_meta: dict[str, dict[str, str]],
    room_data: dict[str, dict[str, Any]],
    glass_specs: dict[str, dict[str, str]] | None = None,
    airflows: dict[tuple[str, str], dict[str, int]] | None = None,
) -> str:
    project_match = re.search(r"Project:\s*(.+?)\s+Date:\s*(.+)", p1_text)
    location_match = re.search(r"Location:\s*(.+?)\s+By:\s*(.+)", p1_text)
    description_match = re.search(r"Description:\s*(.+?)\s+House Faces", p1_text)
    # Positional header fields (extract_unit_info) are authoritative; flat-text regex is the fallback.
    project_name = unit_info.get("project_name") or (project_match.group(1).strip() if project_match else filename)
    date = unit_info.get("date") or (project_match.group(2).strip() if project_match else "-")
    location = unit_info.get("location") or (location_match.group(1).strip() if location_match else "-")
    engineer = unit_info.get("engineer") or (location_match.group(2).strip() if location_match else "-")
    description = unit_info.get("description") or (description_match.group(1).strip() if description_match else filename)
    lines = [
        f"# {filename} - Cooling Load Data Export",
        "",
        f"**Project:** {project_name}  ",
        f"**Date:** {date}  ",
        f"**Location:** {location}  ",
        f"**Engineer:** {engineer}  ",
        f"**Description:** {description}  ",
        f"**House Facing:** {unit_info.get('facing', '-')}  ",
        "",
        "---",
        "",
        "## SECTION 1 - Master Component Reference",
        "",
        "| Type | Description | CLTD (F) | U-Value (Btu/hr-sf-F) | Cooling Load Factor | Notes |",
        "|------|-------------|:--------:|:---------------------:|---------------------|-------|",
    ]
    glass_specs = glass_specs or {}
    g1_spec = glass_specs.get("G1", {})
    for component in master_components.values():
        if component["type"] == "G1":
            notes = f"SHGC {g1_spec.get('shgc', '')}".strip()
            glass_type = g1_spec.get("glass_type", "")
            if glass_type:
                notes = f"{glass_type}; {notes}" if notes else glass_type
            lines.append(f"| {component['type']} | {component['desc']} | {component['cltd']} | {g1_spec.get('uvalue', '-')} | {component['clf']} | {notes} |")
        else:
            lines.append(f"| {component['type']} | {component['desc']} | {component['cltd']} | {component['uvalue']} | {component['clf']} | |")
    lines += [
        "| - | People | - | - | 255 Btu/hr per person | |",
        "| - | Appliances | - | - | 3.413 Btu/hr per Watt | |",
        "",
        "---",
        "",
        "## SECTION 2 - Units & Zones",
        "",
        "### Unit Summary",
        "",
        "| Unit | Zone | System Size | Airflow | Heat | Total Floor Area | Sensible Cooling Load | Sensible Heating Load |",
        "|------|------|:-----------:|:-------:|:----:|:----------------:|:---------------------:|:---------------------:|",
    ]
    for unit in unit_info["units"]:
        zone_desc = unit["zone"] if unit["zone"] else "Whole House"
        lines.append(
            f"| {unit['name']} | {zone_desc} | {unit['sys_size']} | {unit['airflow']} | {unit['heat_kw']} | "
            f"{unit_info['floor_area']} | {unit_info['cool_load']} | {unit_info['heat_load']} |"
        )
    extra_lines = [
        "",
        f"**Total Floor Area:** {unit_info['floor_area']}  ",
        f"**House Sensible Cooling:** {unit_info['cool_load']}  ",
        f"**House Sensible Heating:** {unit_info['heat_load']}  ",
    ]
    if unit_info.get("bedrooms") is not None:
        extra_lines.append(f"**Bedrooms:** {unit_info['bedrooms']}  ")
    if unit_info.get("volume"):
        extra_lines.append(f"**Volume:** {unit_info['volume']}  ")
    extra_lines.append("")
    lines += extra_lines
    lines += [
        "---",
        "",
        "### Zone & Room Index",
        "",
    ]
    unit_zones: dict[tuple[str, str], list[str]] = {}
    for room_name in room_order:
        meta = room_meta[room_name]
        unit_zones.setdefault((meta["unit"], meta["zone"]), []).append(room_name)
    for (unit, zone), room_names in unit_zones.items():
        lines += [
            f"#### {unit} - Zone: {zone}",
            "",
            "| Room | Unit | Zone | Ceiling Height |",
            "|------|------|------|:--------------:|",
        ]
        for room_name in room_names:
            lines.append(f"| {room_name} | {unit} | {zone} | {room_meta[room_name]['ceiling_ht']} ft |")
        lines.append("")
    lines += [
        "---",
        "",
        "## SECTION 3 - Room-by-Room User Inputs",
        "",
        "Only components with a non-zero quantity are shown. Quantities are in sf for envelope components; People = count; Appliances = Watts.",
        "",
        "---",
        "",
    ]
    airflows = airflows or {}
    for room_name in room_order:
        meta = room_meta[room_name]
        data = room_data[room_name]
        base_name = room_name.rsplit(" - ", 1)[0] if " - " in room_name else room_name
        airflow = airflows.get((base_name, meta["unit"]), {})
        lines += [
            f"### {room_name}",
            f"**Unit:** {meta['unit']} | **Zone:** {meta['zone']} | **Ceiling Height:** {meta['ceiling_ht']} ft  ",
        ]
        load_parts = []
        if data.get("_cool_btuh"):
            load_parts.append(f"**Cooling Subtotal:** {int(data['_cool_btuh']):,} Btu/hr")
        if data.get("_heat_btuh"):
            load_parts.append(f"**Heating Subtotal:** {int(data['_heat_btuh']):,} Btu/hr")
        if load_parts:
            lines.append("  |  ".join(load_parts) + "  ")
        if airflow:
            lines.append(f"**Airflow:** {airflow['cool']} Cool / {airflow['heat']} Heat / {airflow['avg']} Avg CFM  ")
        lines += ["", "| Type | Description | Qty | Cool BTU/hr | Heat BTU/hr |", "|------|-------------|----:|------------:|------------:|"]
        for component_key, component in master_components.items():
            quantity = data.get(component_key)
            if quantity:
                cool_btuh = data.get(component_key + "|_cool")
                heat_btuh = data.get(component_key + "|_heat")
                cool_str = str(int(cool_btuh)) if cool_btuh else "-"
                heat_str = str(int(heat_btuh)) if heat_btuh else "-"
                lines.append(f"| {component['type']} | {component['desc']} | {fmt_qty(quantity)} sf | {cool_str} | {heat_str} |")
        for label, suffix in [("People", "person"), ("Appliances (W)", "W")]:
            value = data.get(label)
            if value:
                lines.append(f"| - | {label.replace(' (W)', '')} | {int(value)} {suffix} |")
        lines += ["", "---", ""]
    return "\n".join(lines)


def import_salas_pdf_to_markdown(pdf_bytes: bytes, filename: str = "resload.pdf") -> str:
    if pdfplumber is None:
        raise RuntimeError("pdfplumber is not installed.")
    if len(pdf_bytes) > MAX_FILE_SIZE:
        raise ValueError(f"PDF is too large; maximum size is {MAX_FILE_SIZE // 1024 // 1024} MB.")

    stem = Path(filename).stem or "resload"
    tmp_path = os.path.join(tempfile.gettempdir(), f"{stem}.pdf")
    with open(tmp_path, "wb") as tmp:
        tmp.write(pdf_bytes)
    try:
        with pdfplumber.open(tmp_path) as pdf:
            if len(pdf.pages) < 3:
                raise ValueError("PDF does not appear to be a Salas O'Brien resload report.")
            p1_text = pdf.pages[0].extract_text() or ""
            unit_info = extract_unit_info(pdf)
            glass_specs = extract_glass_specs(pdf)
            airflows = extract_airflows(pdf)
            master_components, room_order, room_meta, room_data = extract_zones(pdf, unit_info["zone_to_unit"])
            if not room_order:
                fallback = _render_markdown_from_report_details(stem, pdf)
                if fallback:
                    return fallback
        if not room_order:
            raise ValueError(
                "No room input tables were found. Import needs a Salas O'Brien room-input PDF "
                "or a ResLoad report that includes the Details / Troubleshooting Sheet; output-only "
                "load summary reports do not contain enough input data to recreate a project."
            )
        return render_markdown(stem, p1_text, unit_info, master_components, room_order, room_meta, room_data, glass_specs, airflows)
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
