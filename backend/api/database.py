"""Supabase persistence layer for VRC.

Replaces the local SQLite database.  Requires environment variables:
  SUPABASE_URL              — your project URL from the Supabase dashboard
  SUPABASE_SERVICE_ROLE_KEY — service-role key (never exposed to the browser)

Table: calculations
  - Keeps the same public interface as the old SQLite Database class so
    app.py needs no changes to the CRUD calls.
  - Extends the schema with structured hierarchy fields for file naming
    and cross-source comparison.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any

from supabase import create_client, Client

from .assemblies import STANDARD_ASSEMBLIES


class ProjectNotFound(KeyError):
    pass


class BatteryError(ValueError):
    pass


def _get_client() -> Client:
    url = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    return create_client(url, key)


def _extract_hierarchy(payload: dict[str, Any]) -> dict[str, Any]:
    """Pull structured naming fields out of a project payload."""
    p = payload.get("project", {})
    builder = p.get("builder_name", "")
    project_name = p.get("project_name", "") or builder
    return {
        "name":         p.get("name", ""),
        "location":     p.get("location", ""),
        "description":  p.get("description", ""),
        "builder_name": builder,
        "project_name": project_name,
        "plan_name":    p.get("plan_name", ""),
        "elevation":    p.get("elevation") or None,
        "foundation":   p.get("foundation") or None,
        "orientation":  p.get("orientation") or None,
        "variations":   p.get("variations") or None,
        "source":       p.get("source", "vrc"),
    }


def _compute_comparison_snapshot(payload: dict[str, Any]) -> dict[str, Any] | None:
    """Run the engine and diff results against salas_obrien_comparison."""
    from ..engine import calculate_project
    from .serialization import project_from_payload

    p = payload.get("project", {})
    meta = p.get("metadata", {})
    salas = meta.get("salas_obrien_comparison")
    if not salas:
        return None

    try:
        result = calculate_project(project_from_payload(payload))
    except Exception:
        return None

    salas_house = salas.get("house", {})
    system: dict[str, Any] = {
        "vrc_cooling_btuh": result.sensible_cooling,
        "salas_cooling_btuh": salas_house.get("cooling_btuh"),
        "vrc_heating_btuh": result.heating,
        "salas_heating_btuh": salas_house.get("heating_btuh"),
        "vrc_min_tons": round(result.tons_min, 2),
        "salas_min_tons": salas_house.get("min_tons"),
    }

    salas_rooms: dict[str, dict[str, Any]] = {}
    # Support both structures: levels[].rooms[] (legacy) and flat rooms dict
    for level_salas in salas.get("levels", []):
        for room in level_salas.get("rooms", []):
            salas_rooms[room["name"]] = room
    flat_rooms = salas.get("rooms")
    if isinstance(flat_rooms, dict):
        for name, data in flat_rooms.items():
            if name not in salas_rooms:
                salas_rooms[name] = data

    rooms = []
    for level_result in result.levels:
        for room_result in level_result.room_results:
            salas_room = salas_rooms.get(room_result.name, {})
            rooms.append({
                "name": room_result.name,
                "vrc_cooling": room_result.cooling_btuh,
                "salas_cooling": salas_room.get("cooling_btuh"),
                "vrc_heating": room_result.heating_btuh,
                "salas_heating": salas_room.get("heating_btuh"),
            })

    return {
        "computed_at": datetime.now(timezone.utc).isoformat(),
        "system": system,
        "rooms": rooms,
    }


def _compute_import_fidelity(payload: dict[str, Any]) -> tuple[bool | None, dict[str, Any] | None]:
    """Compare VRC inputs against Salas reference values from the PDF."""
    p = payload.get("project", {})
    meta = p.get("metadata", {})
    salas = meta.get("salas_obrien_comparison")
    if not salas:
        return None, None

    details: dict[str, Any] = {}

    # Orientation
    vrc_orientation = meta.get("front_door_faces") or meta.get("salas_reference_orientation")
    salas_orientation = (
        meta.get("salas_reference_orientation")
        or salas.get("house", {}).get("orientation")
    )
    if vrc_orientation and salas_orientation:
        orientation_match = vrc_orientation.upper() == salas_orientation.upper()
        details.update(
            orientation_match=orientation_match,
            salas_orientation=salas_orientation,
            vrc_orientation=vrc_orientation,
        )

    # Floor area: sum room floor_area across all levels
    vrc_floor_area = sum(
        room.get("floor_area", 0)
        for level in p.get("levels", [])
        for room in level.get("rooms", [])
    )
    salas_floor_area = salas.get("house", {}).get("floor_area")
    if salas_floor_area:
        floor_area_match = abs(vrc_floor_area - salas_floor_area) <= 2
        details.update(
            floor_area_match=floor_area_match,
            salas_floor_area=salas_floor_area,
            vrc_floor_area=vrc_floor_area,
        )

    # Volume
    vrc_volume = sum(
        room.get("volume", 0)
        for level in p.get("levels", [])
        for room in level.get("rooms", [])
    )
    salas_volume = salas.get("house", {}).get("volume")
    if salas_volume:
        volume_match = abs(vrc_volume - salas_volume) <= 10
        details.update(
            volume_match=volume_match,
            salas_volume=salas_volume,
            vrc_volume=vrc_volume,
        )

    # Room count
    vrc_room_count = sum(len(level.get("rooms", [])) for level in p.get("levels", []))
    # Support both structures: levels[].rooms[] and flat rooms dict
    salas_room_count = sum(
        len(level.get("rooms", []))
        for level in salas.get("levels", [])
    )
    if salas_room_count == 0 and isinstance(salas.get("rooms"), dict):
        salas_room_count = len(salas["rooms"])
    if salas_room_count:
        room_count_match = vrc_room_count == salas_room_count
        details.update(
            room_count_match=room_count_match,
            salas_room_count=salas_room_count,
            vrc_room_count=vrc_room_count,
        )

    if not details:
        return None, None

    passed = all(
        details.get(k, True)
        for k in ("orientation_match", "floor_area_match", "volume_match", "room_count_match")
        if k in details
    )
    return passed, details


class Database:
    """Thin wrapper around the Supabase `calculations` table."""

    def __init__(self) -> None:
        self._client: Client = _get_client()

    # ── Create ────────────────────────────────────────────────────────────────

    def create_project(self, payload: dict[str, Any]) -> int:
        row = _extract_hierarchy(payload)
        row["payload_json"] = payload

        # Auto-detect salas_import source from comparison data
        p = payload.get("project", {})
        if p.get("metadata", {}).get("salas_obrien_comparison"):
            row["source"] = "salas_import"

        snapshot = _compute_comparison_snapshot(payload)
        if snapshot:
            row["comparison_snapshot"] = snapshot
            p = payload.get("project", {})
            salas_orientation = p.get("metadata", {}).get("salas_reference_orientation")
            if salas_orientation:
                row["salas_reference_orientation"] = salas_orientation

        fidelity_passed, fidelity_details = _compute_import_fidelity(payload)
        if fidelity_passed is not None:
            row["import_fidelity_passed"] = fidelity_passed
            row["import_fidelity_details"] = fidelity_details

        result = self._client.table("calculations").insert(row).execute()
        return int(result.data[0]["id"])

    # ── Read ──────────────────────────────────────────────────────────────────

    def get_project_payload(self, project_id: int) -> dict[str, Any]:
        result = (
            self._client.table("calculations")
            .select("payload_json")
            .eq("id", project_id)
            .maybe_single()
            .execute()
        )
        if result.data is None:
            raise ProjectNotFound(project_id)
        return result.data["payload_json"]

    def get_project_row(self, project_id: int) -> dict[str, Any]:
        result = (
            self._client.table("calculations")
            .select("*")
            .eq("id", project_id)
            .maybe_single()
            .execute()
        )
        if result.data is None:
            raise ProjectNotFound(project_id)
        return result.data

    def list_projects(self) -> list[dict[str, Any]]:
        result = (
            self._client.table("calculations")
            .select(
                "id, name, location, description, "
                "builder_name, project_name, plan_name, "
                "elevation, foundation, orientation, variations, source, "
                "import_fidelity_passed, import_fidelity_details, "
                "created_at, updated_at"
            )
            .order("updated_at", desc=True)
            .execute()
        )
        return result.data or []

    # ── Update ────────────────────────────────────────────────────────────────

    def update_project(self, project_id: int, payload: dict[str, Any]) -> None:
        row = _extract_hierarchy(payload)
        row["payload_json"] = payload

        # Auto-detect salas_import source from comparison data
        p = payload.get("project", {})
        if p.get("metadata", {}).get("salas_obrien_comparison"):
            row["source"] = "salas_import"

        snapshot = _compute_comparison_snapshot(payload)
        if snapshot:
            row["comparison_snapshot"] = snapshot
            p = payload.get("project", {})
            salas_orientation = p.get("metadata", {}).get("salas_reference_orientation")
            if salas_orientation:
                row["salas_reference_orientation"] = salas_orientation

        fidelity_passed, fidelity_details = _compute_import_fidelity(payload)
        if fidelity_passed is not None:
            row["import_fidelity_passed"] = fidelity_passed
            row["import_fidelity_details"] = fidelity_details

        result = (
            self._client.table("calculations")
            .update(row)
            .eq("id", project_id)
            .execute()
        )
        if not result.data:
            raise ProjectNotFound(project_id)

    # ── Delete ────────────────────────────────────────────────────────────────

    def delete_project(self, project_id: int) -> None:
        result = (
            self._client.table("calculations")
            .delete()
            .eq("id", project_id)
            .execute()
        )
        if not result.data:
            raise ProjectNotFound(project_id)

    # ── Assemblies ────────────────────────────────────────────────────────────

    def list_assemblies(self) -> list[dict[str, Any]]:
        result = (
            self._client.table("assemblies")
            .select("code, u_value, shgc, label")
            .order("code")
            .order("u_value")
            .order("label")
            .execute()
        )
        return result.data or []

    # ── Test Battery ──────────────────────────────────────────────────────────

    def list_battery(self) -> list[dict[str, Any]]:
        result = (
            self._client.table("calculations")
            .select(
                "id, name, plan_name, builder_name, elevation, foundation, orientation, variations, "
                "salas_reference_orientation, comparison_snapshot, "
                "import_fidelity_passed, import_fidelity_details, "
                "parent_id, source, created_at, updated_at, payload_json"
            )
            .eq("source", "test_battery")
            .order("updated_at", desc=True)
            .execute()
        )
        return result.data or []

    def list_battery_eligible(self, search: str = "") -> list[dict[str, Any]]:
        """Projects eligible for battery: salas_import with comparison data and no orientation mismatch."""
        result = (
            self._client.table("calculations")
            .select(
                "id, name, plan_name, builder_name, elevation, foundation, orientation, variations, "
                "salas_reference_orientation, import_fidelity_passed, import_fidelity_details, "
                "comparison_snapshot, created_at, updated_at, payload_json"
            )
            .eq("source", "salas_import")
            .not_.is_("comparison_snapshot", "null")
            .order("updated_at", desc=True)
            .execute()
        )
        rows = result.data or []

        # Block only on confirmed orientation mismatch
        def _orientation_ok(row: dict[str, Any]) -> bool:
            details = row.get("import_fidelity_details") or {}
            return details.get("orientation_match", True) is not False

        rows = [r for r in rows if _orientation_ok(r)]

        # Exclude projects that already have a battery copy
        battery_result = (
            self._client.table("calculations")
            .select("parent_id")
            .eq("source", "test_battery")
            .not_.is_("parent_id", "null")
            .execute()
        )
        battery_parent_ids = {r["parent_id"] for r in (battery_result.data or [])}
        rows = [r for r in rows if r["id"] not in battery_parent_ids]

        if search:
            s = search.lower()
            rows = [
                r for r in rows
                if s in (r.get("plan_name") or "").lower()
                or s in (r.get("builder_name") or "").lower()
                or s in (r.get("name") or "").lower()
                or s in (r.get("foundation") or "").lower()
                or s in (r.get("orientation") or "").lower()
            ]

        return rows

    def create_battery_copy(self, source_id: int) -> int:
        source = self.get_project_row(source_id)
        if source.get("source") != "salas_import":
            raise BatteryError("Only salas_import projects can be added to the battery.")
        if source.get("comparison_snapshot") is None:
            raise BatteryError("Project has no Salas O'Brien comparison data.")
        # Block only on confirmed orientation mismatch — area/volume differences are flagged but allowed
        details = source.get("import_fidelity_details") or {}
        if details.get("orientation_match") is False:
            raise BatteryError(
                f"Orientation mismatch: VRC has {details.get('vrc_orientation')}, "
                f"Salas reference is {details.get('salas_orientation')}. "
                "Fix front_door_faces before adding to battery."
            )

        # Check not already in battery
        existing = (
            self._client.table("calculations")
            .select("id")
            .eq("source", "test_battery")
            .eq("parent_id", source_id)
            .execute()
        )
        if existing.data:
            raise BatteryError(f"Project {source_id} already has a battery copy.")

        payload = source["payload_json"]

        # Lock orientation to salas_reference_orientation
        salas_orientation = source.get("salas_reference_orientation")
        if salas_orientation and payload.get("project", {}).get("metadata"):
            payload["project"]["metadata"]["front_door_faces"] = salas_orientation

        row = _extract_hierarchy(payload)
        row["payload_json"] = payload
        row["source"] = "test_battery"
        row["parent_id"] = source_id
        row["salas_reference_orientation"] = salas_orientation
        row["comparison_snapshot"] = _compute_comparison_snapshot(payload)
        row["import_fidelity_passed"] = source.get("import_fidelity_passed")
        row["import_fidelity_details"] = source.get("import_fidelity_details")

        result = self._client.table("calculations").insert(row).execute()
        return int(result.data[0]["id"])

    def delete_battery(self, battery_id: int) -> None:
        result = (
            self._client.table("calculations")
            .delete()
            .eq("id", battery_id)
            .eq("source", "test_battery")
            .execute()
        )
        if not result.data:
            raise ProjectNotFound(battery_id)

    def refresh_battery(self, battery_id: int) -> None:
        battery = self.get_project_row(battery_id)
        if battery.get("source") != "test_battery":
            raise BatteryError("Record is not a battery copy.")
        parent_id = battery.get("parent_id")
        if not parent_id:
            raise BatteryError("Battery record has no parent project.")

        source = self.get_project_row(parent_id)
        if not source.get("import_fidelity_passed"):
            raise BatteryError("Parent project no longer passes import fidelity.")

        payload = source["payload_json"]
        salas_orientation = source.get("salas_reference_orientation")
        if salas_orientation and payload.get("project", {}).get("metadata"):
            payload["project"]["metadata"]["front_door_faces"] = salas_orientation

        row = _extract_hierarchy(payload)
        row["payload_json"] = payload
        row["salas_reference_orientation"] = salas_orientation
        row["comparison_snapshot"] = _compute_comparison_snapshot(payload)
        row["import_fidelity_passed"] = source.get("import_fidelity_passed")
        row["import_fidelity_details"] = source.get("import_fidelity_details")

        self._client.table("calculations").update(row).eq("id", battery_id).execute()

    def find_existing_import(
        self,
        plan_name: str,
        foundation: str | None,
        elevation: str | None,
        orientation: str | None,
        variations: str | None,
    ) -> dict[str, Any] | None:
        """Find an existing salas_import by the full structured plan identity."""
        query = (
            self._client.table("calculations")
            .select("id, parent_id, source")
            .eq("source", "salas_import")
            .eq("plan_name", plan_name)
        )
        if foundation:
            query = query.eq("foundation", foundation)
        else:
            query = query.is_("foundation", "null")
        if elevation:
            query = query.eq("elevation", elevation)
        else:
            query = query.is_("elevation", "null")
        if orientation:
            query = query.eq("orientation", orientation)
        else:
            query = query.is_("orientation", "null")
        if variations:
            query = query.eq("variations", variations)
        else:
            query = query.is_("variations", "null")
        result = query.limit(1).execute()
        rows = result.data or []
        return rows[0] if rows else None

    def import_and_add_to_battery(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Full pipeline: save as salas_import, create battery copy, replace if duplicate exists."""
        hierarchy = _extract_hierarchy(payload)
        plan_name = hierarchy.get("plan_name", "")
        foundation = hierarchy.get("foundation")
        elevation = hierarchy.get("elevation")
        orientation = hierarchy.get("orientation")
        variations = hierarchy.get("variations")

        # Replace existing duplicate if found
        existing = self.find_existing_import(plan_name, foundation, elevation, orientation, variations)
        if existing:
            old_id = existing["id"]
            # Delete any battery copies first
            self._client.table("calculations").delete().eq("source", "test_battery").eq("parent_id", old_id).execute()
            # Delete the old salas_import
            self._client.table("calculations").delete().eq("id", old_id).execute()

        # Save as salas_import
        source_id = self.create_project(payload)

        # Create battery copy
        battery_id = self.create_battery_copy(source_id)

        return {
            "source_id": source_id,
            "battery_id": battery_id,
            "plan_name": plan_name,
            "foundation": foundation,
            "elevation": elevation,
            "orientation": orientation,
            "variations": variations,
            "replaced": existing is not None,
        }

    def delete_all_battery(self) -> dict[str, int]:
        """Delete all test_battery records and their salas_import parents."""
        # Get all battery records to find parent IDs
        battery = (
            self._client.table("calculations")
            .select("id, parent_id")
            .eq("source", "test_battery")
            .execute()
        )
        battery_rows = battery.data or []
        parent_ids = {r["parent_id"] for r in battery_rows if r.get("parent_id")}
        battery_ids = [r["id"] for r in battery_rows]

        deleted_battery = 0
        deleted_parents = 0

        # Delete battery records
        for bid in battery_ids:
            self._client.table("calculations").delete().eq("id", bid).execute()
            deleted_battery += 1

        # Delete parent salas_import records
        for pid in parent_ids:
            try:
                self._client.table("calculations").delete().eq("id", pid).eq("source", "salas_import").execute()
                deleted_parents += 1
            except Exception:
                pass  # Parent may have been manually deleted already

        return {"deleted_battery": deleted_battery, "deleted_parents": deleted_parents}

    def update_battery_snapshots(self, updates: list[dict[str, Any]]) -> None:
        """Bulk-write recomputed comparison snapshots for battery records."""
        for item in updates:
            self._client.table("calculations").update(
                {"comparison_snapshot": item["snapshot"]}
            ).eq("id", item["id"]).execute()
