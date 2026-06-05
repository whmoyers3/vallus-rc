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

import json
import os
from typing import Any

from supabase import create_client, Client

from .assemblies import STANDARD_ASSEMBLIES


class ProjectNotFound(KeyError):
    pass


def _get_client() -> Client:
    url = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    return create_client(url, key)


def _extract_hierarchy(payload: dict[str, Any]) -> dict[str, Any]:
    """Pull structured naming fields out of a project payload.

    New payloads include these fields explicitly.  Legacy payloads that
    pre-date the hierarchy schema will fall back to empty strings so that
    the row is still valid.
    """
    p = payload.get("project", {})
    builder = p.get("builder_name", "")
    project_name = p.get("project_name", "") or builder  # blank → mirrors builder
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


class Database:
    """Thin wrapper around the Supabase `calculations` table."""

    def __init__(self) -> None:
        self._client: Client = _get_client()

    # ── Create ────────────────────────────────────────────────────────────────

    def create_project(self, payload: dict[str, Any]) -> int:
        row = _extract_hierarchy(payload)
        row["payload_json"] = payload
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

    def list_projects(self) -> list[dict[str, Any]]:
        """Return summary rows for the project list panel.

        Returns the same shape the frontend expects (id, name, location,
        description, created_at, updated_at) plus the new hierarchy fields
        so the UI can display richer context when it is ready for them.
        """
        result = (
            self._client.table("calculations")
            .select(
                "id, name, location, description, "
                "builder_name, project_name, plan_name, "
                "elevation, foundation, orientation, variations, source, "
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
