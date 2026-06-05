"""FastAPI application for VRC (Vallus Residential Calculator)."""

from __future__ import annotations

import base64
import json
import os
import re
import secrets
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict

from backend.api.database import Database, ProjectNotFound
from backend.api.markdown_import import import_room_cooling_markdown
from backend.api.salas_pdf_import import import_salas_pdf_to_markdown
from backend.api.serialization import loads_response, project_from_payload
from backend.engine import calculate_project
from backend.reports import generate_resload_pdf


# ── Request / response models ─────────────────────────────────────────────────

class ProjectPayload(BaseModel):
    model_config = ConfigDict(extra="allow")
    project: dict[str, Any]


class MarkdownImportPayload(BaseModel):
    filename: str = ""
    text: str


class PdfImportPayload(BaseModel):
    filename: str = ""
    data_base64: str


# ── Filename helpers ──────────────────────────────────────────────────────────

def _vrc_filename(description: str) -> str:
    """Build a VRC PDF filename.

    Pattern: ``{description}-vrc.pdf``
    e.g. ``Hickory C Slab-vrc.pdf``, ``Ash B Slab CBonus ACH50-vrc.pdf``

    Characters illegal in filenames are stripped so the result is safe on
    all operating systems.
    """
    safe = re.sub(r'[\\/*?:"<>|]', "", description).strip()
    safe = re.sub(r"\s+", " ", safe)
    return f"{safe}-vrc.pdf" if safe else "vrc.pdf"


# ── Password middleware ───────────────────────────────────────────────────────

def _make_auth_middleware(app_password: str):
    """Return an HTTP Basic Auth middleware function.

    If APP_PASSWORD is not set the middleware is a no-op (useful for
    local development without a .env file).
    """
    async def require_password(request: Request, call_next):
        # Health check is always public
        if request.url.path in ("/api/health", "/health"):
            return await call_next(request)

        auth = request.headers.get("Authorization", "")
        if auth.startswith("Basic "):
            try:
                decoded = base64.b64decode(auth[6:]).decode("utf-8", errors="replace")
                _, _, password = decoded.partition(":")
                if secrets.compare_digest(password, app_password):
                    return await call_next(request)
            except Exception:
                pass

        return Response(
            content="Unauthorized",
            status_code=401,
            headers={"WWW-Authenticate": 'Basic realm="VRC"'},
        )

    return require_password


# ── Application factory ───────────────────────────────────────────────────────

def create_app() -> FastAPI:
    database = Database()
    api = FastAPI(title="VRC API")

    app_password = os.getenv("APP_PASSWORD", "")
    if app_password:
        api.middleware("http")(_make_auth_middleware(app_password))

    # ── Health ────────────────────────────────────────────────────────────────

    @api.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    # ── Assemblies ────────────────────────────────────────────────────────────

    @api.get("/api/assemblies")
    def list_assemblies() -> list[dict[str, Any]]:
        return database.list_assemblies()

    # ── Import ────────────────────────────────────────────────────────────────

    @api.post("/api/import/room-cooling-markdown")
    def import_markdown(payload: MarkdownImportPayload) -> dict[str, Any]:
        try:
            project, warnings = import_room_cooling_markdown(payload.text, payload.filename)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return {"payload": project, "warnings": warnings}

    @api.post("/api/import/salas-pdf")
    def import_salas_pdf(payload: PdfImportPayload) -> dict[str, Any]:
        try:
            markdown = import_salas_pdf_to_markdown(
                base64.b64decode(payload.data_base64), payload.filename
            )
            md_filename = re.sub(r"\.pdf$", ".md", payload.filename, flags=re.IGNORECASE)
            project, warnings = import_room_cooling_markdown(markdown, md_filename)
        except (ValueError, RuntimeError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return {"payload": project, "warnings": warnings, "markdown": markdown}

    # ── Projects (CRUD) ───────────────────────────────────────────────────────

    @api.get("/api/projects")
    def list_projects() -> list[dict[str, Any]]:
        return database.list_projects()

    @api.post("/api/projects", status_code=201)
    def create_project(payload: ProjectPayload) -> dict[str, int]:
        project_id = database.create_project(payload.model_dump())
        return {"id": project_id}

    @api.get("/api/projects/{project_id}")
    def get_project(project_id: int) -> dict[str, Any]:
        try:
            return database.get_project_payload(project_id)
        except ProjectNotFound as exc:
            raise HTTPException(status_code=404, detail="Project not found") from exc

    @api.put("/api/projects/{project_id}")
    def update_project(project_id: int, payload: ProjectPayload) -> dict[str, int]:
        try:
            database.update_project(project_id, payload.model_dump())
        except ProjectNotFound as exc:
            raise HTTPException(status_code=404, detail="Project not found") from exc
        return {"id": project_id}

    @api.delete("/api/projects/{project_id}", status_code=204)
    def delete_project(project_id: int) -> None:
        try:
            database.delete_project(project_id)
        except ProjectNotFound as exc:
            raise HTTPException(status_code=404, detail="Project not found") from exc

    # ── Calculation ───────────────────────────────────────────────────────────

    @api.post("/api/calculate")
    def calculate_payload(payload: ProjectPayload) -> dict[str, Any]:
        result = calculate_project(project_from_payload(payload.model_dump()))
        return loads_response(result)

    @api.get("/api/projects/{project_id}/loads")
    def get_project_loads(project_id: int) -> dict[str, Any]:
        try:
            payload = database.get_project_payload(project_id)
        except ProjectNotFound as exc:
            raise HTTPException(status_code=404, detail="Project not found") from exc
        result = calculate_project(project_from_payload(payload))
        return loads_response(result)

    # ── PDF report ────────────────────────────────────────────────────────────

    @api.get("/api/projects/{project_id}/report")
    def get_project_report(project_id: int) -> Response:
        try:
            payload = database.get_project_payload(project_id)
        except ProjectNotFound as exc:
            raise HTTPException(status_code=404, detail="Project not found") from exc
        project = project_from_payload(payload)
        result = calculate_project(project)
        pdf_bytes = generate_resload_pdf(project, result)
        pdf_name = _vrc_filename(project.description)
        return Response(
            content=pdf_bytes,
            media_type="application/pdf",
            headers={"Content-Disposition": f'attachment; filename="{pdf_name}"'},
        )

    # ── Fixture (dev/test only) ───────────────────────────────────────────────

    @api.get("/api/fixtures/screenshot-cooling-load")
    def get_screenshot_fixture() -> dict[str, Any]:
        from pathlib import Path
        fixture_path = (
            Path(__file__).resolve().parents[2]
            / "tests" / "reference_cases" / "screenshot_cooling_load.json"
        )
        return json.loads(fixture_path.read_text())

    return api


app = create_app()
