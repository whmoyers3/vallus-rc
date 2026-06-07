"""Formula primitives for the Salas O'Brien/ASHRAE load method."""

from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP

from .constants import (
    GLASS_CLTD,
    SCLEFF_BY_DIRECTION,
    STANDARD_INFILTRATION_COOLING_FACTOR,
    STANDARD_INFILTRATION_HEATING_FACTOR,
)


def round_half_up(value: float) -> int:
    """Round like spreadsheet/accounting output, avoiding Python banker's rounding."""

    return int(Decimal(str(value)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def round_half_up_decimal(value: float, places: int) -> float:
    """Round decimal load factors the way the reference spreadsheets display them."""

    quantizer = Decimal("1").scaleb(-places)
    return float(Decimal(str(value)).quantize(quantizer, rounding=ROUND_HALF_UP))


def normalize_direction(direction: str) -> str:
    return direction.strip().upper().replace(" ", "_")


def glass_load_factor(
    direction: str,
    *,
    u_value: float,
    shgc: float,
    scleff_by_direction: dict[str, int] | None = None,
) -> int:
    """Return combined glass cooling factor in BTU/hr-sf.

    Confirmed formula:
        GLF = round(SCLeff_direction * SHGC + U_glass * 14)
    """

    factors = scleff_by_direction or SCLEFF_BY_DIRECTION
    key = normalize_direction(direction)
    if key not in factors:
        raise KeyError(f"Unknown glass direction {direction!r}")
    return round_half_up(factors[key] * shgc + u_value * GLASS_CLTD)


def cooling_component_load(area: float, u_value: float, cltd: float) -> float:
    return area * round_half_up_decimal(u_value * cltd, 2)


def heating_component_load(area: float, u_value: float, delta_t: float) -> float:
    return area * u_value * delta_t


def standard_infiltration_load(volume: float, *, mode: str, scale: float = 1.0) -> float:
    """Infiltration load = volume × standard factor × scale.

    ``scale`` defaults to 1.0 (current model). Legacy imports pass
    natural_ach / 0.25 to reproduce Salas's pre-code-change ACH-scaled method,
    since the standard factors (0.09 cooling / 0.24 heating) correspond to 0.25 ACH.
    """

    if mode == "cooling":
        return volume * STANDARD_INFILTRATION_COOLING_FACTOR * scale
    if mode == "heating":
        return volume * STANDARD_INFILTRATION_HEATING_FACTOR * scale
    raise ValueError("mode must be 'cooling' or 'heating'")


def ventilation_load(outside_air_cfm: float, delta_t: float) -> float:
    return 1.1 * outside_air_cfm * delta_t
