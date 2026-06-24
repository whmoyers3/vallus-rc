# Implementation Sketch — Room-type internal-load catalog + takeoff emission

Implements ADR 0007. Principle: the **takeoff carries the room type**; the **engine owns the
numbers** and expands type → people/appliance loads in the same room loop that already
auto-generates lighting and infiltration. No watt/person values are baked into the takeoff.

For the Langford round trip this is the remaining input (with `location`): tag Kitchen,
the bedrooms, Family (entertainment), and Laundry, and the engine fills the internal gains.

---

## 1. `backend/engine/constants.py` — the catalog

```python
# Room-type internal-load catalog (ADR 0007).
# people = seed occupant count (per-room, overridable; drives sensible gain only)
# appliance_watts = default appliance load for the room type
ROOM_TYPE_INTERNAL_LOADS: dict[str, dict[str, float]] = {
    "kitchen":      {"people": 0, "appliance_watts": 680},
    "entertainment":{"people": 1, "appliance_watts": 250},
    "laundry":      {"people": 0, "appliance_watts": 200},
    "bedroom":      {"people": 1, "appliance_watts": 0},
    "plain":        {"people": 0, "appliance_watts": 0},
}
```

`PEOPLE_SENSIBLE_BTUH = 256.0` and `WATT_TO_BTUH = 3.413` already exist — reuse them, so the
per-person BTU lives only here.

---

## 2. `backend/engine/models.py` — room fields + level flag

```python
@dataclass(frozen=True)
class Room:
    name: str
    # ... existing fields ...
    room_type: str | None = None            # "kitchen" | "entertainment" | "laundry" | "bedroom" | "plain"
    people_override: float | None = None    # supersedes catalog seed when set
    appliance_watts_override: float | None = None
```

```python
@dataclass(frozen=True)
class Level:
    # ... existing fields ...
    auto_internal_gains: bool = False        # mirror of auto_lighting / auto_infiltration
```

Explicit `internal_people` / `internal_watts` line items (the Salas-import path) are
untouched and still take precedence — auto-generation only runs for rooms with a `room_type`
when `auto_internal_gains` is on, so the two paths never double-count.

---

## 3. `backend/engine/calculator.py` — generate in the existing room loop

Add to `calculate_level`, right after the `auto_infiltration` block (~line 296):

```python
        if level.auto_internal_gains and room.room_type:
            defaults = ROOM_TYPE_INTERNAL_LOADS.get(room.room_type, ROOM_TYPE_INTERNAL_LOADS["plain"])

            people = room.people_override if room.people_override is not None else defaults["people"]
            if people:
                line_results.append(LineResult(
                    name=f"People - {room.name}",
                    cooling_btuh=people * PEOPLE_SENSIBLE_BTUH,   # sensible only
                    heating_btuh=0.0,
                    room_name=room.name,
                ))

            watts = room.appliance_watts_override if room.appliance_watts_override is not None else defaults["appliance_watts"]
            if watts:
                line_results.append(LineResult(
                    name=f"Appliances - {room.name}",
                    cooling_btuh=watts * WATT_TO_BTUH,
                    heating_btuh=0.0,
                    room_name=room.name,
                ))
```

Import `ROOM_TYPE_INTERNAL_LOADS` and `PEOPLE_SENSIBLE_BTUH` at the top alongside the
existing constant imports.

---

## 4. `frontend/src/takeoff/types.ts` — the tag

```ts
export type TakeoffRoomType = "bedroom" | "kitchen" | "entertainment" | "laundry" | "plain";

export type TakeoffRectRoom = {
  // ... existing fields ...
  roomType?: TakeoffRoomType;          // default "plain"
  peopleOverride?: number;
  applianceWattsOverride?: number;
};
```

---

## 5. `frontend/src/takeoff/TakeoffApp.tsx` — emit type, not numbers

**Room Profile / floor-plan toggle** (segmented control, same pattern as the surface toggle):

```tsx
{(["plain","bedroom","kitchen","entertainment","laundry"] as TakeoffRoomType[]).map((t) => (
  <button
    key={t}
    className={room.roomType === t || (!room.roomType && t === "plain") ? "active" : ""}
    onClick={() => updateRoom(room.id, { roomType: t })}
  >{t}</button>
))}
```

**`buildVrcPayload`** — add the type to each room object and flip the level flag. No catalog
numbers here:

```ts
const rooms = floor.rooms.map((room) => ({
  name: room.name,
  floor_area: rectArea(room),
  lighting_area: rectArea(room),
  ceiling_height: room.ceilingHeight,
  volume: rectArea(room) * room.ceilingHeight,
  lighting_basis: "Floor",
  room_type: room.roomType ?? "plain",
  ...(room.peopleOverride != null ? { people_override: room.peopleOverride } : {}),
  ...(room.applianceWattsOverride != null ? { appliance_watts_override: room.applianceWattsOverride } : {}),
  unit_id: "unit-whole-house",
  zone_id: "zone-default",
}));
```

In the level object, set `auto_internal_gains: true` (next to `auto_lighting_w_per_sf` /
`auto_infiltration: true`).

---

## Notes / trade-offs

- **Single source of truth:** watts/people live only in `constants.py`. The takeoff sends a
  type; the engine expands it. Bedroom *count* falls out of the bedroom-tagged rooms (ADR
  0007) for the separate ventilation use (ADR 0008).
- **Payload preview vs engine output:** because expansion happens engine-side, the takeoff's
  client-side payload preview will show `room_type` on each room but not itemize the
  People/Appliance lines. The round trip asserts on engine output (room/system BTU), where
  they appear — so this is fine and keeps the catalog un-duplicated. If you want the preview
  to itemize them too, mirror the catalog in one shared module rather than copying values.
- **Override path:** `people_override` / `appliance_watts_override` handle the double-oven
  kitchen or a media room with extra guests without leaving the type system.
- **Validation:** surface "no kitchen tagged" / "no occupant load" as warnings (not blocks),
  consistent with the existing panel; only `location` hard-blocks save.
```
