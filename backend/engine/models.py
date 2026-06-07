"""Data structures for the load calculation engine."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any
from typing import Literal

LoadKind = Literal[
    "glass",
    "opaque",
    "internal_people",
    "internal_watts",
    "infiltration",
    "manual",
]

InfiltrationMode = Literal["standard_ach", "mechanical_ventilation"]


@dataclass(frozen=True)
class Assembly:
    code: str
    u_value: float | None = None
    shgc: float | None = None
    description: str = ""


@dataclass(frozen=True)
class DesignConditions:
    outdoor_cooling_db: float = 95.0
    outdoor_heating_db: float = 18.0
    indoor_cooling_db: float = 75.0
    indoor_heating_db: float = 72.0
    slab_delta_t: float = 27.0
    cooling_safety_factor: float = 1.10
    heating_safety_factor: float = 1.15

    @property
    def cooling_delta_t(self) -> float:
        return self.outdoor_cooling_db - self.indoor_cooling_db

    @property
    def heating_delta_t(self) -> float:
        return self.indoor_heating_db - self.outdoor_heating_db


@dataclass(frozen=True)
class Infiltration:
    mode: InfiltrationMode = "standard_ach"
    outside_air_cfm: float | None = None


@dataclass(frozen=True)
class LineItem:
    name: str
    kind: LoadKind
    room_name: str | None = None
    area: float = 0.0
    heating_area: float | None = None
    volume: float | None = None
    quantity: float = 0.0
    watts: float = 0.0
    assembly: Assembly | None = None
    direction: str | None = None
    cooling_load_factor: float | None = None
    cooling_cltd: float | None = None
    heating_delta_t: float | None = None
    cooling_btuh: float | None = None
    heating_btuh: float | None = None


@dataclass(frozen=True)
class Level:
    name: str
    floor_area: float
    volume: float
    selected_tons: float
    selected_kw: float
    line_items: list[LineItem] = field(default_factory=list)
    rooms: list["Room"] = field(default_factory=list)
    cooling_cfm_divisor: float | None = None
    heating_cfm_divisor: float | None = None
    auto_lighting_w_per_sf: float | None = None
    auto_infiltration: bool = False


@dataclass(frozen=True)
class Project:
    name: str
    location: str
    description: str
    design_conditions: DesignConditions
    infiltration: Infiltration
    levels: list[Level]
    selected_system_tons: float | None = None
    selected_system_kw: float | None = None
    building_type: str = "single_family"
    metadata: dict[str, Any] = field(default_factory=dict)
    assemblies: dict[str, "Assembly"] = field(default_factory=dict)


@dataclass(frozen=True)
class Room:
    name: str
    cooling_btuh: float = 0.0
    heating_btuh: float = 0.0
    floor_area: float = 0.0
    volume: float = 0.0
    lighting_area: float | None = None
    unit_id: str | None = None
    zone_id: str | None = None
