# 0007 — Room-type internal-load tagging; occupant count per-room and decoupled from bedroom count

**Status:** Accepted (2026-06-23)

## Context

A takeoff-authored project must supply internal gains the engine does not auto-derive.
Lighting and infiltration are auto-generated (`auto_lighting_w_per_sf`, `auto_infiltration`),
but **people and appliances are explicit per-room line items** (`internal_people` ×
`PEOPLE_SENSIBLE_BTUH = 256`; `internal_watts` for appliances). The takeoff currently emits
none, so every room is missing its occupant and appliance gain.

Investigation of the engine clarified two things often conflated:

- **Bedroom count is used nowhere in the engine** — it is inert metadata. Its real-world
  role is ASHRAE 62.2 ventilation sizing (`0.03·area + 7.5·(bedrooms+1)`), but the engine
  does not compute that; it receives a finished `outside_air_cfm` and applies
  `1.1 · cfm · ΔT`, distributing by level volume.
- **Occupant count affects only the internal sensible gain**, room by room.

A bedrooms+1 occupancy governance was considered and rejected: that convention governs
*ventilation sizing*, not internal-gain occupancy. Forcing it would wrongly cap realistic
per-room occupancy (e.g. guests in two media rooms).

## Decision

**1. Room-type tag in the takeoff; values in the calculator catalog.** A room carries a
semantic type (bedroom / kitchen / entertainment / laundry / plain) set in the floor-plan
view. The default appliance watts and seed occupant count for each type live in a
room-type internal-load catalog in `constants.py` (e.g. kitchen 680 W, entertainment 250 W
+ 1 person, laundry 200 W, bedroom 1 person), resolved from the type. The takeoff does not
hardcode the numbers. Mirrors the structured-boundary pattern (ADR 0005): tag the type,
resolve the value from a catalog, allow override.

**2. Per-room override.** The type sets defaults; per-room appliance-watt and occupant
overrides are always available (double-oven kitchen, large AV wall, guests).

**3. Occupant count is per-room and unconstrained.** It drives only `internal_people`
sensible gain. No house-level total is enforced. The per-person 256 BTU/hr stays in the
engine; the takeoff emits a count, never a BTU value.

**4. Bedroom count is project-level and ventilation-only.** Derived from the count of
bedroom-tagged rooms (no separate field). Its sole load role is future ASHRAE 62.2
mechanical-ventilation sizing — a calc to be **added** so from-scratch tight/ACH50 homes can
produce `outside_air_cfm` without a Salas PDF to read it from. Inert for standard-ACH homes
(e.g. the Langford round-trip plan), where occupants are the only internal-occupancy input.

**5. Validation, not hard block.** Missing room types / unassigned occupant load surface as
warnings in the existing validation panel (only `location` hard-blocks save).

## Consequences

- Takeoff gains a room-type toggle and emits `internal_people` / `internal_watts` line items.
- Bedroom count is free from tagging and feeds only the (future) 62.2 ventilation calc.
- Langford round trip needs correct per-room occupants/appliances; bedroom count and
  ventilation are not in play for it.
- A room-type internal-load catalog is added to engine constants, maintained in one place.

## Alternatives considered

- **Enter people/appliances in the calculator with callouts.** Rejected: room typing is
  spatial authoring and belongs where rooms are seen; splitting it forces re-entry.
- **Hardcode watts in the takeoff.** Rejected: duplicates catalog values, which then drift.
- **Govern occupants as bedrooms+1.** Rejected: conflates ventilation sizing with
  internal-gain occupancy and caps realistic per-room guests.
