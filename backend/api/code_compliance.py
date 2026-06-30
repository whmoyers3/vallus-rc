"""Advisory energy-code warnings for calculator inputs."""

from __future__ import annotations

import re
from typing import Any


GEORGIA_CODE_MINIMUMS: dict[str, Any] = {
    "jurisdiction": "Georgia",
    "code_edition": "2015 IECC with Georgia State Supplements and Amendments",
    "effective_date": "2020-01-01 with 2022 and 2023 amendment packets applied",
    "checked_date": "2026-06-30",
    "status_source_url": "https://dca.georgia.gov/community-assistance/construction-codes/current-state-minimum-codes-construction",
    "prescriptive_basis": "DCA Georgia-amended 2015 IECC Tables R402.1.2/R402.1.4 plus R402.2.1, R402.1.2.1, and the 2023 cantilevered-floor footnote; advisory warnings only.",
    "default_climate_zone": "3A",
    "climate_zones": {
        "2A": {
            "fenestration_u_max": 0.35,
            "skylight_u_max": 0.65,
            "glazed_fenestration_shgc_max": 0.27,
            "ceiling_r_min": 38.0,
            "ceiling_u_max": 0.030,
            "ceiling_r30_full_eave_allowed": True,
            "indirect_conditioned_attic_r_min": 20.0,
            "indirect_conditioned_attic_u_max": 0.050,
            "wood_frame_wall_r_min": 13.0,
            "wood_frame_wall_u_max": 0.084,
            "attic_kneewall_r_min": 18.0,
            "mass_wall_r_min": 4.0,
            "mass_wall_alt_r_min": 6.0,
            "mass_wall_u_max": 0.165,
            "floor_r_min": 13.0,
            "floor_u_max": 0.064,
            "cantilever_floor_r_min": 30.0,
            "cantilever_floor_u_max": 0.035,
            "basement_wall_r_min": 0.0,
            "basement_wall_u_max": 0.360,
            "crawl_wall_r_min": 0.0,
            "crawl_wall_u_max": 0.477,
            "slab_perimeter_r_min": 0.0,
        },
        "3A": {
            "fenestration_u_max": 0.35,
            "skylight_u_max": 0.55,
            "glazed_fenestration_shgc_max": 0.27,
            "ceiling_r_min": 38.0,
            "ceiling_u_max": 0.030,
            "ceiling_r30_full_eave_allowed": True,
            "indirect_conditioned_attic_r_min": 20.0,
            "indirect_conditioned_attic_u_max": 0.050,
            "wood_frame_wall_r_min": 13.0,
            "wood_frame_wall_u_max": 0.084,
            "attic_kneewall_r_min": 18.0,
            "mass_wall_r_min": 8.0,
            "mass_wall_alt_r_min": 13.0,
            "mass_wall_u_max": 0.098,
            "floor_r_min": 19.0,
            "floor_u_max": 0.047,
            "cantilever_floor_r_min": 30.0,
            "cantilever_floor_u_max": 0.035,
            "basement_wall_r_min": 5.0,
            "basement_wall_u_max": 0.091,
            "crawl_wall_r_min": 5.0,
            "crawl_wall_u_max": 0.136,
            "slab_perimeter_r_min": 0.0,
        },
        "4A": {
            "fenestration_u_max": 0.35,
            "skylight_u_max": 0.55,
            "glazed_fenestration_shgc_max": 0.27,
            "ceiling_r_min": 38.0,
            "ceiling_u_max": 0.030,
            "ceiling_r30_full_eave_allowed": True,
            "indirect_conditioned_attic_r_min": 20.0,
            "indirect_conditioned_attic_u_max": 0.050,
            "wood_frame_wall_r_min": 13.0,
            "wood_frame_wall_u_max": 0.084,
            "attic_kneewall_r_min": 18.0,
            "mass_wall_r_min": 8.0,
            "mass_wall_alt_r_min": 13.0,
            "mass_wall_u_max": 0.098,
            "floor_r_min": 19.0,
            "floor_u_max": 0.047,
            "cantilever_floor_r_min": 30.0,
            "cantilever_floor_u_max": 0.035,
            "basement_wall_r_min": 10.0,
            "basement_wall_u_max": 0.059,
            "crawl_wall_r_min": 10.0,
            "crawl_wall_u_max": 0.065,
            "slab_perimeter_r_min": 0.0,
        },
    },
}

_GEORGIA_ZONE_4_COUNTIES = {
    "banks",
    "catoosa",
    "chattooga",
    "dade",
    "dawson",
    "fannin",
    "floyd",
    "gilmer",
    "gordon",
    "habersham",
    "lumpkin",
    "murray",
    "pickens",
    "rabun",
    "stephens",
    "towns",
    "union",
    "walker",
    "white",
    "whitfield",
}


def code_minimums_response() -> dict[str, Any]:
    return GEORGIA_CODE_MINIMUMS


def build_code_compliance_warnings(payload: dict[str, Any]) -> list[str]:
    project = payload.get("project") or {}
    location = str(project.get("location") or "")
    if not _is_georgia_location(location, project.get("metadata") or {}):
        return []

    zone = _infer_georgia_climate_zone(location, project.get("metadata") or {})
    thresholds = GEORGIA_CODE_MINIMUMS["climate_zones"][zone]
    warnings: list[str] = []

    for key, assembly in (project.get("assemblies") or {}).items():
        warning = _assembly_warning(str(key), assembly or {}, thresholds, zone)
        if warning:
            warnings.append(warning)

    if warnings:
        warnings.insert(
            0,
            (
                f"Advisory Georgia code-minimum screening uses {GEORGIA_CODE_MINIMUMS['code_edition']} "
                f"({zone}); this warning does not block calculation or override user inputs."
            ),
        )
    return warnings


def _is_georgia_location(location: str, metadata: dict[str, Any]) -> bool:
    state = str(metadata.get("state") or metadata.get("jurisdiction_state") or "").strip().upper()
    if state in {"GA", "GEORGIA"}:
        return True
    return bool(re.search(r"\b(GA|Georgia)\b", location, flags=re.IGNORECASE))


def _infer_georgia_climate_zone(location: str, metadata: dict[str, Any]) -> str:
    explicit = str(
        metadata.get("energy_code_climate_zone")
        or metadata.get("iecc_climate_zone")
        or metadata.get("climate_zone")
        or ""
    ).upper()
    if "4" in explicit:
        return "4A"
    if "3" in explicit:
        return "3A"
    if "2" in explicit:
        return "2A"

    location_lower = location.lower()
    for county in _GEORGIA_ZONE_4_COUNTIES:
        if re.search(rf"\b{re.escape(county)}\s+county\b", location_lower):
            return "4A"
    return GEORGIA_CODE_MINIMUMS["default_climate_zone"]


def _assembly_warning(code_key: str, assembly: dict[str, Any], thresholds: dict[str, Any], zone: str) -> str | None:
    code = str(assembly.get("code") or code_key or "").upper()
    label = str(assembly.get("description") or assembly.get("label") or code)
    u_value = _to_float(assembly.get("u_value"))
    shgc = _to_float(assembly.get("shgc"))
    r_value = _r_value_from_label(label)

    if code.startswith("G"):
        fen_u = thresholds["skylight_u_max"] if _is_skylight(label) else thresholds["fenestration_u_max"]
        fen_label = "skylight" if _is_skylight(label) else "fenestration"
        if u_value is not None and u_value > fen_u + 1e-9:
            return f"{code} {label} has U {u_value:g}, above GA {zone} {fen_label} maximum U {fen_u:g}."
        shgc_max = thresholds.get("glazed_fenestration_shgc_max")
        if shgc_max is not None and shgc is not None and shgc > shgc_max + 1e-9:
            return f"{code} {label} has SHGC {shgc:g}, above GA {zone} glazed fenestration maximum SHGC {shgc_max:g}."
        return None

    if _is_slab(label):
        return _opaque_warning(code, label, u_value, r_value, thresholds["slab_perimeter_r_min"], float("inf"), "slab perimeter", zone)

    if _is_basement_wall(label):
        return _opaque_warning(code, label, u_value, r_value, thresholds["basement_wall_r_min"], thresholds["basement_wall_u_max"], "basement wall", zone)

    if _is_crawl_wall(label):
        return _opaque_warning(code, label, u_value, r_value, thresholds["crawl_wall_r_min"], thresholds["crawl_wall_u_max"], "crawl wall", zone)

    if _is_attic_kneewall(label):
        if _is_roofline_insulated_context(label):
            return f"{code} {label} appears to be an attic kneewall inside a roofline-insulated attic; verify it is treated as interior per GA roofline-insulation guidance."
        return _opaque_warning(code, label, u_value, r_value, thresholds["attic_kneewall_r_min"], thresholds["wood_frame_wall_u_max"], "attic kneewall", zone)

    if code.startswith("W"):
        if _is_mass_wall(label):
            return _opaque_warning(code, label, u_value, r_value, thresholds["mass_wall_r_min"], thresholds["mass_wall_u_max"], "mass wall", zone, thresholds.get("mass_wall_alt_r_min"))
        return _opaque_warning(code, label, u_value, r_value, thresholds["wood_frame_wall_r_min"], thresholds["wood_frame_wall_u_max"], "wood-frame wall", zone)

    if code.startswith("R") or code.startswith("C"):
        return _ceiling_warning(code, label, u_value, r_value, thresholds, zone)

    if code.startswith("F") and "SLAB" not in label.upper():
        if _is_cantilevered_floor(label):
            return _opaque_warning(code, label, u_value, r_value, thresholds["cantilever_floor_r_min"], thresholds["cantilever_floor_u_max"], "cantilevered floor over outside air", zone)
        return _opaque_warning(code, label, u_value, r_value, thresholds["floor_r_min"], thresholds["floor_u_max"], "floor over unheated space", zone)

    return None


def _opaque_warning(
    code: str,
    label: str,
    u_value: float | None,
    r_value: float | None,
    r_min: float,
    u_max: float,
    component: str,
    zone: str,
    r_alt_min: float | None = None,
) -> str | None:
    r_target = f"R-{r_min:g}" if r_alt_min is None else f"R-{r_min:g} continuous or R-{r_alt_min:g} cavity"
    if r_value is not None:
        if r_value + 1e-9 < r_min:
            return f"{code} {label} appears to be R-{r_value:g}, below GA {zone} {component} minimum {r_target}."
        return None
    if u_value is not None and u_value > u_max + 1e-9:
        return f"{code} {label} has U {u_value:g}, above GA {zone} {component} maximum U {u_max:g}."
    return None


def _ceiling_warning(code: str, label: str, u_value: float | None, r_value: float | None, thresholds: dict[str, Any], zone: str) -> str | None:
    if _is_indirectly_conditioned_attic(label):
        r_min = thresholds["indirect_conditioned_attic_r_min"]
        u_max = thresholds["indirect_conditioned_attic_u_max"]
        if r_value is not None:
            if r_value + 1e-9 < r_min:
                return f"{code} {label} appears to be R-{r_value:g}, below GA {zone} indirectly conditioned attic allowance minimum R-{r_min:g}."
            return f"{code} {label} uses the GA indirectly conditioned attic allowance; verify <3 ACH50, non-negative-only whole-house ventilation, covered rafters where required, and HVAC/ductwork inside the envelope."
        if u_value is not None:
            if u_value > u_max + 1e-9:
                return f"{code} {label} has U {u_value:g}, above GA {zone} indirectly conditioned attic allowance maximum U {u_max:g}."
            return f"{code} {label} uses the GA indirectly conditioned attic allowance; verify <3 ACH50, non-negative-only whole-house ventilation, covered rafters where required, and HVAC/ductwork inside the envelope."

    if r_value is not None and 30.0 <= r_value < thresholds["ceiling_r_min"] and thresholds.get("ceiling_r30_full_eave_allowed"):
        if _has_full_eave_context(label):
            return None
        return f"{code} {label} appears to use the GA R-30 ceiling allowance; verify full-height uncompressed R-30 extends over the wall top plate at the eaves."

    return _opaque_warning(code, label, u_value, r_value, thresholds["ceiling_r_min"], thresholds["ceiling_u_max"], "ceiling", zone)


def _r_value_from_label(label: str) -> float | None:
    match = re.search(r"\bR[-\s]?(\d+(?:\.\d+)?)\b", label, flags=re.IGNORECASE)
    return float(match.group(1)) if match else None


def _is_skylight(label: str) -> bool:
    return bool(re.search(r"\bsky[\s-]*light\b", label, flags=re.IGNORECASE))


def _is_slab(label: str) -> bool:
    return bool(re.search(r"\bslab\b", label, flags=re.IGNORECASE))


def _is_basement_wall(label: str) -> bool:
    return bool(re.search(r"\bbasement\b", label, flags=re.IGNORECASE) and re.search(r"\bwall\b", label, flags=re.IGNORECASE))


def _is_crawl_wall(label: str) -> bool:
    return bool(re.search(r"\bcrawl(?:\s*space)?\b", label, flags=re.IGNORECASE) and re.search(r"\bwall\b", label, flags=re.IGNORECASE))


def _is_attic_kneewall(label: str) -> bool:
    return bool(re.search(r"\b(knee[\s-]*wall|kneewall)\b", label, flags=re.IGNORECASE))


def _is_mass_wall(label: str) -> bool:
    return bool(re.search(r"\b(mass|masonry|cmu|concrete|block|brick)\b", label, flags=re.IGNORECASE))


def _is_cantilevered_floor(label: str) -> bool:
    return bool(re.search(r"\b(cantilever|over outside air)\b", label, flags=re.IGNORECASE))


def _is_roofline_insulated_context(label: str) -> bool:
    return bool(re.search(r"\b(spray|sprayed|foam|air[\s-]*impermeable|roof[\s-]*line|roof[\s-]*deck|unvented|conditioned attic|indirectly conditioned)\b", label, flags=re.IGNORECASE))


def _is_indirectly_conditioned_attic(label: str) -> bool:
    return _is_roofline_insulated_context(label) and bool(re.search(r"\b(attic|roof|deck|rafter|spray|sprayed|foam)\b", label, flags=re.IGNORECASE))


def _has_full_eave_context(label: str) -> bool:
    return bool(re.search(r"\b(raised[\s-]*heel|energy[\s-]*heel|full[\s-]*height|uncompressed|top plate|eave|extended? over)\b", label, flags=re.IGNORECASE))


def _to_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
