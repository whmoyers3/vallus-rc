"""Import structured room cooling-load Markdown exports as editable projects."""

from __future__ import annotations

import re
from typing import Any


DIRECTION_CODES = {
    "North": "N",
    "NorthEast": "NE",
    "East": "E",
    "SouthEast": "SE",
    "South": "S",
    "SouthWest": "SW",
    "West": "W",
    "NorthWest": "NW",
}
DEFAULT_DESCRIPTIONS = {
    "W1": "Above Grade Wall",
    "W2": "Grade Wall",
    "W3": "Attic Wall / Kneewall",
    "D1": "Exterior Door",
    "D2": "Garage Door",
    "C1": "Flat Ceiling",
    "C2": "Vaulted Ceiling",
    "F1": "Framed / Garage Floor",
    "F2": "Slab",
    "G1": "Glass",
}


KNOWN_FOUNDATIONS = {"Slab", "CBsmt", "UBsmt", "Crawl"}


def _parse_hierarchy(description: str, project_field: str, filename: str) -> dict[str, str]:
    """Extract plan_name, elevation, foundation, variations, builder_name, project_name
    from Salas PDF Description/Project fields, falling back to filename parsing."""
    result: dict[str, str] = {}

    # Parse Project field: "ProjectName; BuilderName"
    if project_field and project_field != filename:
        parts = [p.strip() for p in project_field.split(";", 1)]
        if len(parts) == 2:
            result["project_name"] = parts[0]
            result["builder_name"] = parts[1]
        elif parts[0]:
            result["project_name"] = parts[0]

    # Parse Description field: "Plan - Elevation, Foundation[, Variations...]"
    if description and description != filename:
        dash_parts = description.split(" - ", 1)
        result["plan_name"] = dash_parts[0].strip()
        if len(dash_parts) > 1:
            tokens = [t.strip() for t in dash_parts[1].split(",") if t.strip()]
            if tokens:
                if tokens[0] in KNOWN_FOUNDATIONS:
                    result["foundation"] = tokens[0]
                    if len(tokens) > 1:
                        result["variations"] = ", ".join(tokens[1:])
                else:
                    result["elevation"] = tokens[0]
                    if len(tokens) > 1:
                        result["foundation"] = tokens[1]
                    if len(tokens) > 2:
                        result["variations"] = ", ".join(tokens[2:])
        return result

    # Fallback: parse filename (strip Resload/ACH50 suffixes)
    name = re.sub(
        r"\s+(?:ACH50\s+)?Resload(?:\s+ACH50)?$", "", filename, flags=re.IGNORECASE
    ).strip()
    foundation_match = re.search(r"\b(Slab|CBsmt|UBsmt|Crawl)\b", name)
    if foundation_match:
        before = name[: foundation_match.start()].strip()
        result["foundation"] = foundation_match.group(1)
        after = name[foundation_match.end() :].strip()
        if after:
            result["variations"] = after
        # Last token before foundation may be an elevation code
        before_tokens = before.rsplit(None, 1)
        if len(before_tokens) == 2:
            potential_plan, potential_elev = before_tokens
            if re.fullmatch(r"[A-Z0-9](?:[A-Z0-9/\-]*[A-Z0-9])?", potential_elev):
                result["plan_name"] = potential_plan
                result["elevation"] = potential_elev
            else:
                result["plan_name"] = before
        else:
            result["plan_name"] = before
    else:
        result["plan_name"] = name

    return result


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-") or "item"


def _number(value: str) -> float | None:
    match = re.search(r"-?\d[\d,]*(?:\.\d+)?", value)
    return float(match.group(0).replace(",", "")) if match else None


def _table_rows(text: str) -> list[list[str]]:
    rows = []
    for line in text.splitlines():
        if not line.strip().startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if cells and not all(re.fullmatch(r":?-+:?", cell) for cell in cells):
            rows.append(cells)
    return rows


def _normalized_code(code: str) -> str:
    code = code.strip().upper()
    if code.startswith("R"):
        return "C" + code[1:]
    return code


def _direction(description: str) -> str | None:
    for label, code in DIRECTION_CODES.items():
        if re.match(rf"^{label}\b", description, re.IGNORECASE):
            return code
    if re.match(r"^Sky\s*Light\b", description, re.IGNORECASE):
        return "Skylight"
    if re.match(r"^Shaded\b", description, re.IGNORECASE):
        return "Shaded"
    return None


def _table_dicts(rows: list[list[str]]) -> list[dict[str, str]]:
    if not rows:
        return []
    headers = [header.strip().lower() for header in rows[0]]
    return [
        {headers[index]: cell for index, cell in enumerate(row) if index < len(headers)}
        for row in rows[1:]
    ]


def _comparison_from_markdown(text: str) -> dict[str, Any] | None:
    comparison: dict[str, Any] = {"source": "Salas O'Brien"}

    house_cooling = re.search(r"^\*\*House Sensible Cooling:\*\*\s*(.+?)\s*$", text, re.MULTILINE)
    house_heating = re.search(r"^\*\*House Sensible Heating:\*\*\s*(.+?)\s*$", text, re.MULTILINE)
    house_floor_area = re.search(r"^\*\*Total Floor Area:\*\*\s*(.+?)\s*$", text, re.MULTILINE)
    house_volume = re.search(r"^\*\*Volume:\*\*\s*(.+?)\s*$", text, re.MULTILINE)
    house_facing = re.search(r"^\*\*House Facing:\*\*\s*(.+?)\s*$", text, re.MULTILINE)
    house: dict[str, Any] = {}
    if house_cooling:
        value = _number(house_cooling.group(1))
        if value is not None:
            house["cooling_btuh"] = value
    if house_heating:
        value = _number(house_heating.group(1))
        if value is not None:
            house["heating_btuh"] = value
    if house_floor_area:
        value = _number(house_floor_area.group(1))
        if value is not None:
            house["floor_area"] = value
    if house_volume:
        value = _number(house_volume.group(1))
        if value is not None:
            house["volume"] = value
    if house_facing:
        raw = house_facing.group(1).strip().rstrip(" ").strip()
        worst = re.search(r"Worst\s+(\w+)", raw, re.IGNORECASE)
        facing = worst.group(1).upper() if worst else raw.upper()
        _FULL_TO_ABBREV = {
            "NORTH": "N", "NORTHEAST": "NE", "EAST": "E", "SOUTHEAST": "SE",
            "SOUTH": "S", "SOUTHWEST": "SW", "WEST": "W", "NORTHWEST": "NW",
        }
        _ABBREVS = {"N", "NE", "E", "SE", "S", "SW", "W", "NW"}
        resolved = _FULL_TO_ABBREV.get(facing, facing)
        if resolved in _ABBREVS:
            house["orientation"] = resolved
    if house:
        comparison["house"] = house

    summary_match = re.search(r"### Unit Summary(.*?)(?:\n---|\n###)", text, re.DOTALL)
    summary_rows = _table_rows(summary_match.group(1) if summary_match else "")
    units = []
    for row in _table_dicts(summary_rows):
        unit = {
            "name": row.get("unit", ""),
            "zone": row.get("zone", ""),
        }
        mappings = {
            "system size": "selected_tons",
            "airflow": "airflow_cfm",
            "heat": "selected_kw",
            "total floor area": "floor_area",
            "sensible cooling load": "cooling_btuh",
            "sensible heating load": "heating_btuh",
        }
        for source_key, target_key in mappings.items():
            value = _number(row.get(source_key, ""))
            if value is not None:
                unit[target_key] = value
        if any(key.endswith("_btuh") or key in {"selected_tons", "selected_kw", "airflow_cfm"} for key in unit):
            units.append(unit)
    if units:
        comparison["units"] = units
        # Derive house-level min_tons from unit cooling loads
        total_cooling = sum(u.get("cooling_btuh", 0) for u in units)
        if total_cooling > 0 and "house" not in comparison:
            house = {}
            comparison["house"] = house
        if total_cooling > 0:
            comparison["house"]["min_tons"] = round(total_cooling / 9000, 2)
        # Derive house-level floor area from units if not already set
        if comparison.get("house", {}).get("floor_area") is None:
            total_area = sum(u.get("floor_area", 0) for u in units)
            if total_area > 0:
                comparison.setdefault("house", {})["floor_area"] = total_area

    rooms: dict[str, dict[str, Any]] = {}
    section_three = text.split("## SECTION 3", 1)[1] if "## SECTION 3" in text else ""
    for block in re.split(r"(?=^###\s+)", section_three, flags=re.MULTILINE):
        room_match = re.match(r"^###\s+(.+?)\s*$", block, re.MULTILINE)
        if not room_match:
            continue
        room_name = room_match.group(1).strip()
        room: dict[str, Any] = {}
        metadata_match = re.search(r"\*\*Unit:\*\*\s*(.+?)\s*\|\s*\*\*Zone:\*\*\s*(.+?)\s*\|", block)
        if metadata_match:
            room["unit"] = metadata_match.group(1).strip()
            room["zone"] = metadata_match.group(2).strip()
        cooling_match = re.search(r"\*\*Cooling Subtotal:\*\*\s*([\d,]+(?:\.\d+)?)\s*Btu/hr", block)
        heating_match = re.search(r"\*\*Heating Subtotal:\*\*\s*([\d,]+(?:\.\d+)?)\s*Btu/hr", block)
        airflow_match = re.search(r"\*\*Airflow:\*\*\s*(\d+)\s*Cool\s*/\s*(\d+)\s*Heat\s*/\s*(\d+)\s*Avg\s*CFM", block)
        if cooling_match:
            room["cooling_btuh"] = float(cooling_match.group(1).replace(",", ""))
        if heating_match:
            room["heating_btuh"] = float(heating_match.group(1).replace(",", ""))
        if airflow_match:
            room["cfm_cool"] = int(airflow_match.group(1))
            room["cfm_heat"] = int(airflow_match.group(2))
            room["cfm_avg"] = int(airflow_match.group(3))
        if any(key in room for key in {"cooling_btuh", "heating_btuh", "cfm_cool", "cfm_heat", "cfm_avg"}):
            rooms[room_name] = room
    if rooms:
        comparison["rooms"] = rooms

    return comparison if any(key in comparison for key in {"house", "units", "rooms"}) else None


def import_room_cooling_markdown(text: str, filename: str = "") -> tuple[dict[str, Any], list[str]]:
    if "SECTION 3" not in text or "Room-by-Room User Inputs" not in text:
        raise ValueError("This Markdown file does not contain a Room-by-Room User Inputs section.")

    title_match = re.search(r"^#\s+(.+?)\s+[—-]\s+Cooling Load Data Export\s*$", text, re.MULTILINE)
    project_match = re.search(r"^\*\*Project:\*\*\s*(.+?)\s*$", text, re.MULTILINE)
    description_field_match = re.search(r"^\*\*Description:\*\*\s*(.+?)\s*$", text, re.MULTILINE)
    location_match = re.search(r"^\*\*Location:\*\*\s*(.+?)\s*$", text, re.MULTILINE)
    facing_match = re.search(r"^\*\*House Facing:\*\*\s*(.+?)\s*$", text, re.MULTILINE)
    plan_name = title_match.group(1).strip() if title_match else re.sub(r"\.md$", "", filename, flags=re.IGNORECASE)
    project_description = project_match.group(1).strip() if project_match else "Imported Markdown project"
    salas_description = description_field_match.group(1).strip() if description_field_match else ""
    location = location_match.group(1).strip() if location_match else ""

    _FACING_MAP = {
        "N": "N", "NORTH": "N",
        "NE": "NE", "NORTHEAST": "NE",
        "E": "E", "EAST": "E",
        "SE": "SE", "SOUTHEAST": "SE",
        "S": "S", "SOUTH": "S",
        "SW": "SW", "SOUTHWEST": "SW",
        "W": "W", "WEST": "W",
        "NW": "NW", "NORTHWEST": "NW",
    }
    _WORST_RE = re.compile(r"Worst\s+(\w+)", re.IGNORECASE)
    salas_reference_orientation: str | None = None
    front_door_faces = "S"
    facing_parsed = False
    if facing_match:
        raw = facing_match.group(1).strip().rstrip(" -").strip()
        worst = _WORST_RE.search(raw)
        candidate = worst.group(1).upper() if worst else raw.upper()
        if candidate in _FACING_MAP:
            front_door_faces = _FACING_MAP[candidate]
            salas_reference_orientation = front_door_faces
            facing_parsed = True

    comparison = _comparison_from_markdown(text)
    summary_match = re.search(r"### Unit Summary(.*?)(?:\n---|\n###)", text, re.DOTALL)
    summary_rows = _table_rows(summary_match.group(1) if summary_match else "")
    unit_sizing: dict[str, dict[str, float]] = {}
    for summary in summary_rows[1:]:
        if not summary:
            continue
        unit_sizing[summary[0]] = {
            "selected_tons": _number(summary[2]) if len(summary) > 2 else 1,
            "selected_kw": _number(summary[4]) if len(summary) > 4 else 5,
        }

    master_match = re.search(r"## SECTION 1.*?(?=## SECTION 2)", text, re.DOTALL)
    master_rows = _table_rows(master_match.group(0) if master_match else "")
    assemblies: dict[str, dict[str, Any]] = {}
    master_headers = [header.lower() for header in master_rows[0]] if master_rows else []
    u_value_index = next((index for index, header in enumerate(master_headers) if "u-value" in header), 3)
    shgc_index = next((index for index, header in enumerate(master_headers) if "shgc" in header), None)
    for row in master_rows[1:]:
        if len(row) < 5 or row[0] in {"—", "-"}:
            continue
        code = _normalized_code(row[0])
        description = row[1]
        u_value = _number(row[u_value_index]) if len(row) > u_value_index else None
        shgc_match = re.search(r"\bSHGC\b\s*[:=]?\s*(0?\.\d+)", " ".join(row), re.IGNORECASE)
        shgc = _number(row[shgc_index]) if shgc_index is not None and len(row) > shgc_index else None
        if shgc is None and shgc_match:
            shgc = float(shgc_match.group(1))
        assembly = assemblies.setdefault(
            code,
            {"code": code, "u_value": u_value, "description": DEFAULT_DESCRIPTIONS.get(code, description)},
        )
        if assembly.get("u_value") is None and u_value is not None:
            assembly["u_value"] = u_value
        if code.startswith("G") and assembly.get("shgc") is None and shgc is not None:
            assembly["shgc"] = shgc

    glass_codes = [code for code in assemblies if code.startswith("G")]
    missing_glass_inputs = [
        code for code in glass_codes
        if assemblies[code].get("u_value") is None or assemblies[code].get("shgc") is None
    ]
    if missing_glass_inputs:
        codes = ", ".join(missing_glass_inputs)
        raise ValueError(
            f"Glass type schedule is missing U-value or SHGC for {codes}. "
            "Add both inputs to the Markdown component schedule before importing."
        )

    section_three = text.split("## SECTION 3", 1)[1]
    room_blocks = re.split(r"(?=^###\s+)", section_three, flags=re.MULTILINE)
    units: dict[str, dict[str, Any]] = {}
    zones: dict[tuple[str, str], dict[str, str]] = {}
    rooms: list[dict[str, Any]] = []
    line_items: list[dict[str, Any]] = []

    for block in room_blocks:
        room_match = re.match(r"^###\s+(.+?)\s*$", block, re.MULTILINE)
        metadata_match = re.search(
            r"\*\*Unit:\*\*\s*(.+?)\s*\|\s*\*\*Zone:\*\*\s*(.+?)\s*\|\s*\*\*Ceiling Height:\*\*\s*([\d.]+)\s*ft",
            block,
        )
        if not room_match or not metadata_match:
            continue
        room_name = room_match.group(1).strip()
        unit_name, zone_name = metadata_match.group(1).strip(), metadata_match.group(2).strip()
        ceiling_height = float(metadata_match.group(3))
        unit_id = f"unit-{_slug(unit_name)}"
        zone_id = f"zone-{_slug(unit_name)}-{_slug(zone_name)}"
        units.setdefault(unit_name, {"id": unit_id, "name": unit_name, **unit_sizing.get(unit_name, {})})
        zones.setdefault((unit_name, zone_name), {"id": zone_id, "name": zone_name, "unit_id": unit_id})

        room_components: list[dict[str, Any]] = []
        for row in _table_rows(block)[1:]:
            if len(row) < 3:
                continue
            raw_code, description, qty_text = row[0], row[1], row[2]
            qty = _number(qty_text)
            if qty is None:
                continue
            if raw_code in {"—", "-"}:
                if "People" in description:
                    component = {
                        "name": f"{room_name} people",
                        "kind": "internal_people",
                        "room_name": room_name,
                        "quantity": qty,
                    }
                elif "Appliances" in description:
                    component = {
                        "name": f"{room_name} appliances",
                        "kind": "internal_watts",
                        "room_name": room_name,
                        "watts": qty,
                    }
                else:
                    continue
            else:
                code = _normalized_code(raw_code)
                direction = _direction(description)
                component = {
                    "name": f"{room_name} {description}".replace("—", "-"),
                    "kind": "glass" if code.startswith("G") else "opaque",
                    "room_name": room_name,
                    "assembly": code,
                    "area": qty,
                }
                if direction:
                    component["direction"] = direction
            room_components.append(component)
            line_items.append(component)

        slab_area = sum(item.get("area", 0) for item in room_components if item.get("assembly") == "F2")
        ceiling_area = sum(item.get("area", 0) for item in room_components if str(item.get("assembly", "")).startswith("C"))
        if slab_area and ceiling_area and ceiling_area > slab_area:
            # Ceiling footprint is larger — likely open-to-above/stair room; use ceiling area
            lighting_basis = "Ceiling"
            floor_area = ceiling_area
        elif slab_area:
            lighting_basis = "Floor"
            floor_area = slab_area
        elif ceiling_area:
            lighting_basis = "Ceiling"
            floor_area = ceiling_area
        else:
            lighting_basis = "Floor"
            floor_area = max(
                [item.get("area", 0) for item in room_components if item.get("kind") == "opaque"] or [0]
            )
        rooms.append({
            "name": room_name,
            "floor_area": floor_area,
            "lighting_area": floor_area,
            "ceiling_height": ceiling_height,
            "volume": floor_area * ceiling_height,
            "lighting_basis": lighting_basis,
            "unit_id": unit_id,
            "zone_id": zone_id,
        })

    if not rooms:
        raise ValueError("No room input tables were found in the Markdown file.")

    floor_area = sum(room["floor_area"] for room in rooms)
    volume = sum(room["volume"] for room in rooms)
    selected_tons = sum(float(unit.get("selected_tons", 0)) for unit in units.values())
    selected_kw = sum(float(unit.get("selected_kw", 0)) for unit in units.values())
    # Prefer explicit bedroom count from PDF; fall back to guessing from room names
    bedrooms_match = re.search(r"^\*\*Bedrooms:\*\*\s*(\d+)", text, re.MULTILINE)
    bedrooms_explicit = int(bedrooms_match.group(1)) if bedrooms_match else None
    bedrooms = bedrooms_explicit if bedrooms_explicit is not None else sum(
        1 for room in rooms
        if re.search(r"\bbed(?:room)?\b|\bowner suite\b|\bmaster bed\b", room["name"], re.IGNORECASE)
    )
    hierarchy = _parse_hierarchy(salas_description, project_description, plan_name)
    source_pdf_filename = plan_name if re.search(r"\.pdf$", plan_name, flags=re.IGNORECASE) else ""
    parsed_plan_name = hierarchy.get("plan_name", "")
    display_plan_name = source_pdf_filename or parsed_plan_name or plan_name
    hierarchy_fields = {k: v for k, v in hierarchy.items() if v and k != "plan_name"}
    payload = {
        "project": {
            "name": display_plan_name,
            "location": location,
            "description": project_description,
            # Structured hierarchy fields parsed from Salas Description/Project/filename
            "plan_name": display_plan_name,
            **hierarchy_fields,
            "design_conditions": {
                "outdoor_cooling_db": 95,
                "outdoor_heating_db": 18,
                "indoor_cooling_db": 75,
                "indoor_heating_db": 72,
                "slab_delta_t": 27,
            },
            "infiltration": {"mode": "standard_ach"},
            "metadata": {
                "ach50": 5,
                "bedrooms": max(bedrooms, 1),
                "seer": 14,
                "front_door_faces": front_door_faces,
                "units": list(units.values()),
                "zones": list(zones.values()),
                **({"source_filename": source_pdf_filename} if source_pdf_filename else {}),
                **({"salas_plan_name": parsed_plan_name} if source_pdf_filename and parsed_plan_name else {}),
                **({"salas_obrien_comparison": comparison} if comparison else {}),
                **({"salas_reference_orientation": salas_reference_orientation} if salas_reference_orientation else {}),
            },
            "selected_system_tons": selected_tons,
            "selected_system_kw": selected_kw,
            "assemblies": assemblies,
            "levels": [{
                "name": "Whole House",
                "floor_area": floor_area,
                "volume": volume,
                "selected_tons": selected_tons,
                "selected_kw": selected_kw,
                "cooling_cfm_divisor": 18.1,
                "heating_cfm_divisor": 20.2,
                "auto_lighting_w_per_sf": 0.5,
                "auto_infiltration": True,
                "rooms": rooms,
                "line_items": line_items,
            }],
        }
    }
    warnings: list[str] = []
    if not facing_parsed:
        warnings.append(
            "Front door facing is not present in the Markdown export and was set to South. Review it before calculating."
        )
    if bedrooms_explicit is None:
        warnings.append("Bedroom count was estimated from room names. Review it before calculating.")
    return payload, warnings
