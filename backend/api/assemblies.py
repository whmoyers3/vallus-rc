"""Seed data for the construction assembly library."""

from __future__ import annotations

STANDARD_ASSEMBLIES: list[dict] = [
    {"code": "W1", "u_value": 0.077, "shgc": None, "label": "Above Grade - 2x4 R-13 batt"},
    {"code": "W1", "u_value": 0.060, "shgc": None, "label": "Above Grade - 2x4 R-15 batt"},
    {"code": "W1", "u_value": 0.048, "shgc": None, "label": "Above Grade - 2x6 R-19 batt"},
    {"code": "D1", "u_value": 0.130, "shgc": None, "label": "Exterior Door R-7.7"},
    {"code": "D1", "u_value": 0.200, "shgc": None, "label": "Exterior Door R-5"},
    {"code": "D2", "u_value": 0.083, "shgc": None, "label": "Garage Door R-12"},
    {"code": "D2", "u_value": 0.500, "shgc": None, "label": "Garage Door R-2"},
    {"code": "R1", "u_value": 0.026, "shgc": None, "label": "Flat Ceiling R-38 blown"},
    {"code": "R1", "u_value": 0.033, "shgc": None, "label": "Flat Ceiling R-30 blown"},
    {"code": "R1", "u_value": 0.031, "shgc": None, "label": "Flat Ceiling R-30 sprayed"},
    {"code": "F2", "u_value": 0.100, "shgc": None, "label": "Slab on grade"},
    {"code": "F1", "u_value": 0.053, "shgc": None, "label": "Framed floor R-19 batt"},
    {"code": "F1", "u_value": 0.026, "shgc": None, "label": "Framed floor R-38 batt"},
    {"code": "G1", "u_value": 0.350, "shgc": 0.22, "label": "Double insulated, SHGC 0.22"},
    {"code": "G1", "u_value": 0.320, "shgc": 0.22, "label": "Double insulated, SHGC 0.22"},
    {"code": "G1", "u_value": 0.330, "shgc": 0.19, "label": "Double insulated, SHGC 0.19"},
    {"code": "G1", "u_value": 0.340, "shgc": 0.27, "label": "Double insulated, SHGC 0.27"},
]
