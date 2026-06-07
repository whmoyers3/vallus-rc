"""Constants confirmed from the Salas O'Brien reference resloads."""

from __future__ import annotations

DIRECTIONS = ("N", "NE", "E", "SE", "S", "SW", "W", "NW")

SCLEFF_BY_DIRECTION: dict[str, int] = {
    "N": 7,
    "NE": 14,
    "E": 38,
    "SE": 43,
    "S": 50,
    "SW": 97,
    "W": 111,
    "NW": 61,
    "SHADED": 7,
    "SKYLIGHT": 187,
}

# Combined glass cooling factors (Btu/hr-sf) for townhouses, applied DIRECTLY per
# orientation (not via the SHGF formula used for single-family). Verified against the
# Evergreen TH resload (9/10 exact). NE corrected 26 -> 21 to match Salas; based on a
# single townhouse sample — re-confirm when more townhome resloads are available.
TOWNHOUSE_GLASS_LOAD_FACTORS: dict[str, int] = {
    "N": 7,
    "NE": 21,
    "E": 32,
    "SE": 26,
    "S": 19,
    "SW": 29,
    "W": 37,
    "NW": 26,
    "SHADED": 7,
    "SKYLIGHT": 52,
}

WALL_CLTD_BY_DIRECTION: dict[str, int] = {
    "N": 13,
    "NE": 19,
    "E": 23,
    "SE": 21,
    "S": 16,
    "SW": 21,
    "W": 23,
    "NW": 19,
}

SPECIAL_CLTD: dict[str, int] = {
    "GARAGE_WALL": 30,
    "PARTITION": 10,
    "ATTIC_WALL": 55,
    "KNEEWALL": 55,
    "FLAT_CEILING": 55,
    "VAULTED_CEILING": 55,
    "SLAB": 0,
    "FRAMED_FLOOR": 11,
    "CRAWLSPACE": 11,
    "UNFINISHED_BASEMENT": 11,
    "CANTILEVER": 20,
    "FLOOR_OVER_GARAGE": 30,
    "EXTERIOR_DOOR": 21,
    "GARAGE_DOOR": 30,
    "GARAGE_DOOR_ALT": 55,
}

FULL_HEATING_DELTA_T = 54.0
HALF_HEATING_DELTA_T = 27.0
GLASS_CLTD = 14.0

PEOPLE_SENSIBLE_BTUH = 255.0
WATT_TO_BTUH = 3.413

STANDARD_INFILTRATION_COOLING_FACTOR = 0.09
STANDARD_INFILTRATION_HEATING_FACTOR = 0.24

COOLING_SAFETY_FACTOR = 1.10
HEATING_SAFETY_FACTOR = 1.15
SENSIBLE_BTUH_PER_NOMINAL_TON = 9000.0
BTUH_PER_KW = 3412.0
CFM_PER_TON = 400
STANDARD_TON_SIZES = (1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0)
