"""FastAPI application for Baseline (Vallus Residential Calculator)."""

from __future__ import annotations

import base64
import json
import os
import re
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.staticfiles import StaticFiles
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict

from backend.api.airflow_export import build_airflow_workbook, _orientation_table, _group_units, _plan_label
from backend.api.component_diagnostics import build_component_diagnostics, diagnostics_filename
from backend.api.database import Database, ProjectNotFound, TakeoffProjectNotFound, TakeoffAssetNotFound, BatteryError
from backend.api.detail_report import build_detail_report
from backend.api.glass_audit import build_glass_factor_audit
from backend.api.residual_audit import build_residual_audit
from backend.api.markdown_import import import_room_cooling_markdown
from backend.api.salas_pdf_import import import_salas_pdf_to_markdown
from backend.api.serialization import loads_response, project_from_payload
from backend.engine import calculate_project
from backend.reports import generate_resload_pdf


# ── Request / response models ─────────────────────────────────────────────────

class ProjectPayload(BaseModel):
    model_config = ConfigDict(extra="allow")
    project: dict[str, Any]


class TakeoffPayload(BaseModel):
    model_config = ConfigDict(extra="allow")


class BatchCalculatePayload(BaseModel):
    projects: list[dict[str, Any]]


class SnapshotExportPayload(BaseModel):
    label: str = ""
    battery: Optional[list[dict[str, Any]]] = None


class MarkdownImportPayload(BaseModel):
    filename: str = ""
    text: str


class PdfImportPayload(BaseModel):
    filename: str = ""
    data_base64: str


class AssemblyPayload(BaseModel):
    code: str
    u_value: Optional[float] = None
    shgc: Optional[float] = None
    label: str


TAKEOFF_REFERENCE_MAX_BYTES = 7 * 1024 * 1024
TAKEOFF_REFERENCE_MIME_TYPES = {
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/webp",
}


# ── Filename helpers ──────────────────────────────────────────────────────────

def _vrc_filename(description: str) -> str:
    """Build a Baseline PDF filename.

    Pattern: ``{description}-vrc.pdf``
    e.g. ``Hickory C Slab-vrc.pdf``, ``Ash B Slab CBonus ACH50-vrc.pdf``

    Characters illegal in filenames are stripped so the result is safe on
    all operating systems.
    """
    safe = re.sub(r'[\\/*?:"<>|]', "", description).strip()
    safe = re.sub(r"\s+", " ", safe)
    return f"{safe}-vrc.pdf" if safe else "vrc.pdf"


# ── Auth middleware ───────────────────────────────────────────────────────────

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
            headers={"WWW-Authenticate": 'Basic realm="Baseline"'},
        )

    return require_password


def _auth_mode(app_password: str, supabase_anon_key: str) -> str:
    requested = os.getenv("VRC_AUTH_MODE", "").strip().lower()
    if requested in {"none", "basic", "supabase"}:
        return requested
    if app_password:
        return "basic"
    return "none"


def _make_supabase_auth_middleware(database: Database):
    """Require a Supabase Auth access token for API routes.

    The React app itself is served publicly so users see the in-app login screen.
    All application data/API routes require a valid Supabase session token.
    """
    public_paths = {"/api/health", "/health", "/api/auth/config"}

    async def require_supabase_user(request: Request, call_next):
        if request.method == "OPTIONS":
            return await call_next(request)
        if request.url.path in public_paths:
            return await call_next(request)
        if not request.url.path.startswith("/api/"):
            return await call_next(request)

        auth = request.headers.get("Authorization", "")
        token = auth.removeprefix("Bearer ").strip() if auth.startswith("Bearer ") else ""
        if not token:
            token = request.cookies.get("vrc_access_token", "").strip()
        if not token:
            return Response(content="Unauthorized", status_code=401)

        try:
            user_response = database._client.auth.get_user(token)
            user = getattr(user_response, "user", None)
            user_id = getattr(user, "id", None)
            if not user_id:
                raise ValueError("Supabase token did not return a user.")
            request.state.user = {
                "id": user_id,
                "email": getattr(user, "email", None),
            }
        except Exception:
            return Response(content="Unauthorized", status_code=401)

        return await call_next(request)

    return require_supabase_user


# ── Application factory ───────────────────────────────────────────────────────

def create_app(_legacy_db_path: Optional[str] = None) -> FastAPI:
    database = Database()
    api = FastAPI(title="Baseline API")

    app_password = os.getenv("APP_PASSWORD", "")
    supabase_anon_key = os.getenv("SUPABASE_ANON_KEY") or os.getenv("VITE_SUPABASE_ANON_KEY", "")
    auth_mode = _auth_mode(app_password, supabase_anon_key)
    if auth_mode == "supabase":
        api.middleware("http")(_make_supabase_auth_middleware(database))
    elif auth_mode == "basic" and app_password:
        api.middleware("http")(_make_auth_middleware(app_password))

    # ── Health ────────────────────────────────────────────────────────────────

    @api.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @api.get("/api/auth/config")
    def auth_config() -> dict[str, str]:
        return {
            "mode": auth_mode,
            "supabase_url": os.getenv("SUPABASE_URL", ""),
            "supabase_anon_key": supabase_anon_key,
        }

    @api.get("/api/auth/me")
    def auth_me(request: Request) -> dict[str, Any]:
        user = getattr(request.state, "user", None) or {}
        return {"user": user}

    # ── Assemblies ────────────────────────────────────────────────────────────

    @api.get("/api/assemblies")
    def list_assemblies() -> list[dict[str, Any]]:
        return database.list_assemblies()

    @api.post("/api/assemblies", status_code=201)
    def create_assembly(payload: AssemblyPayload) -> dict[str, Any]:
        code = payload.code.upper().strip()
        if not code:
            raise HTTPException(status_code=422, detail="Assembly code is required.")
        if not payload.label.strip():
            raise HTTPException(status_code=422, detail="Assembly description is required.")
        return database.create_assembly({**payload.model_dump(), "code": code})

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

    # ── Takeoff Projects (editable JSON CRUD) ────────────────────────────────

    @api.get("/api/takeoffs")
    def list_takeoff_projects() -> list[dict[str, Any]]:
        return database.list_takeoff_projects()

    @api.post("/api/takeoffs", status_code=201)
    def create_takeoff_project(payload: TakeoffPayload) -> dict[str, int]:
        takeoff_id = database.create_takeoff_project(payload.model_dump())
        return {"id": takeoff_id}

    @api.get("/api/takeoffs/{takeoff_id}")
    def get_takeoff_project(takeoff_id: int) -> dict[str, Any]:
        try:
            return database.get_takeoff_project(takeoff_id)
        except TakeoffProjectNotFound as exc:
            raise HTTPException(status_code=404, detail="Takeoff project not found") from exc

    @api.put("/api/takeoffs/{takeoff_id}")
    def update_takeoff_project(takeoff_id: int, payload: TakeoffPayload) -> dict[str, int]:
        try:
            database.update_takeoff_project(takeoff_id, payload.model_dump())
        except TakeoffProjectNotFound as exc:
            raise HTTPException(status_code=404, detail="Takeoff project not found") from exc
        return {"id": takeoff_id}

    @api.delete("/api/takeoffs/{takeoff_id}", status_code=204)
    def delete_takeoff_project(takeoff_id: int) -> None:
        try:
            database.delete_takeoff_project(takeoff_id)
        except TakeoffProjectNotFound as exc:
            raise HTTPException(status_code=404, detail="Takeoff project not found") from exc

    # ── Takeoff Reference Assets ─────────────────────────────────────────────

    @api.post("/api/takeoff-assets", status_code=201)
    async def upload_takeoff_asset(
        file: UploadFile = File(...),
        floor_id: str = Form(""),
        page_number: int = Form(1),
    ) -> dict[str, Any]:
        content_type = file.content_type or ""
        if content_type not in TAKEOFF_REFERENCE_MIME_TYPES:
            raise HTTPException(status_code=415, detail="Upload a PDF, PNG, JPEG, or WebP plan reference.")

        data = await file.read()
        if len(data) > TAKEOFF_REFERENCE_MAX_BYTES:
            raise HTTPException(status_code=413, detail="Plan reference files are capped at 7 MB.")
        if not data:
            raise HTTPException(status_code=422, detail="Plan reference file is empty.")

        try:
            asset = database.create_takeoff_asset(
                data,
                file.filename or "plan-reference",
                content_type,
                floor_id=floor_id,
                page_number=page_number,
            )
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Could not store plan reference: {exc}") from exc
        return {
            "id": asset["id"],
            "filename": asset["filename"],
            "mime_type": asset["mime_type"],
            "size_bytes": asset["size_bytes"],
            "storage_path": asset["storage_path"],
            "download_url": asset["download_url"],
            "signed_url": asset.get("signed_url", ""),
            "page_number": asset.get("page_number", page_number),
        }

    @api.get("/api/takeoff-assets/{asset_id}/download")
    def download_takeoff_asset(asset_id: int) -> Response:
        try:
            data, asset = database.download_takeoff_asset(asset_id)
        except TakeoffAssetNotFound as exc:
            raise HTTPException(status_code=404, detail="Takeoff asset not found") from exc
        filename = re.sub(r'[\\/*?:"<>|]', "", asset.get("filename") or "plan-reference")
        return Response(
            content=data,
            media_type=asset.get("mime_type") or "application/octet-stream",
            headers={"Content-Disposition": f'inline; filename="{filename}"'},
        )

    # ── Calculation ───────────────────────────────────────────────────────────

    @api.post("/api/calculate")
    def calculate_payload(payload: ProjectPayload) -> dict[str, Any]:
        result = calculate_project(project_from_payload(payload.model_dump()))
        return loads_response(result)

    @api.post("/api/export/airflow")
    def export_airflow(payload: ProjectPayload) -> Response:
        xlsx_bytes, filename = build_airflow_workbook(payload.model_dump())
        return Response(
            content=xlsx_bytes,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    @api.post("/api/export/diagnostics")
    def export_diagnostics(payload: ProjectPayload) -> Response:
        raw = payload.model_dump()
        report = build_component_diagnostics(raw)
        filename = diagnostics_filename(raw, "diagnostic-report")
        content = json.dumps(report, indent=2, default=str)
        return Response(
            content=content,
            media_type="application/json",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    @api.post("/api/airflow/prepare")
    def prepare_airflow_wizard(payload: ProjectPayload) -> dict[str, Any]:
        raw = payload.model_dump()
        table = _orientation_table(raw)
        units = _group_units(raw)
        meta = raw["project"].get("metadata") or {}
        return {
            "orientation_table": table,
            "units": units,
            "plan_label": _plan_label(raw),
            "address": meta.get("address") or "",
            "default_orientation": meta.get("front_door_faces") or "S",
            "payload": raw,
        }

    @api.get("/api/projects/{project_id}/airflow")
    def get_project_airflow(project_id: int) -> Response:
        try:
            payload = database.get_project_payload(project_id)
        except ProjectNotFound as exc:
            raise HTTPException(status_code=404, detail="Project not found") from exc
        xlsx_bytes, filename = build_airflow_workbook(payload)
        return Response(
            content=xlsx_bytes,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

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

    # ── Batch calculate ───────────────────────────────────────────────────────

    @api.post("/api/calculate/batch")
    def calculate_batch(payload: BatchCalculatePayload) -> dict[str, Any]:
        results = []
        for project_dict in payload.projects:
            try:
                wrapped = {"project": project_dict} if "project" not in project_dict else project_dict
                result = calculate_project(project_from_payload(wrapped))
                results.append({"ok": True, "result": loads_response(result)})
            except Exception as exc:
                results.append({"ok": False, "error": str(exc)})
        return {"results": results}

    # ── Test Battery ──────────────────────────────────────────────────────────

    @api.get("/api/battery")
    def list_battery() -> list[dict[str, Any]]:
        return database.list_battery()

    @api.get("/api/battery/eligible")
    def battery_eligible(search: str = "") -> list[dict[str, Any]]:
        return database.list_battery_eligible(search)

    @api.post("/api/battery", status_code=201)
    def create_battery(body: dict[str, Any]) -> dict[str, int]:
        source_id = body.get("source_id")
        if not isinstance(source_id, int):
            raise HTTPException(status_code=422, detail="source_id (int) required")
        try:
            new_id = database.create_battery_copy(source_id)
        except BatteryError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except ProjectNotFound as exc:
            raise HTTPException(status_code=404, detail="Source project not found") from exc
        return {"id": new_id}

    @api.delete("/api/battery/{battery_id}", status_code=204)
    def delete_battery(battery_id: int) -> None:
        try:
            database.delete_battery(battery_id)
        except ProjectNotFound as exc:
            raise HTTPException(status_code=404, detail="Battery record not found") from exc

    @api.post("/api/battery/{battery_id}/refresh")
    def refresh_battery(battery_id: int) -> dict[str, str]:
        try:
            database.refresh_battery(battery_id)
        except (ProjectNotFound, BatteryError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return {"status": "refreshed"}

    @api.post("/api/import/salas-pdf/batch-single")
    def import_salas_pdf_batch_single(payload: PdfImportPayload) -> dict[str, Any]:
        """Full pipeline: PDF → markdown → payload → save as salas_import → battery copy."""
        try:
            markdown = import_salas_pdf_to_markdown(
                base64.b64decode(payload.data_base64), payload.filename
            )
            md_filename = re.sub(r"\.pdf$", ".md", payload.filename, flags=re.IGNORECASE)
            project, warnings = import_room_cooling_markdown(markdown, md_filename)
        except (ValueError, RuntimeError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

        try:
            result = database.import_and_add_to_battery(project)
        except BatteryError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

        return {**result, "warnings": warnings}

    @api.post("/api/battery/delete-all")
    def delete_all_battery(body: dict[str, Any]) -> dict[str, Any]:
        if not body.get("confirm"):
            raise HTTPException(status_code=422, detail="Must send {confirm: true} to delete all battery records.")
        result = database.delete_all_battery()
        return result

    @api.post("/api/battery/snapshots/bulk")
    def bulk_update_snapshots(body: dict[str, Any]) -> dict[str, int]:
        updates = body.get("updates", [])
        database.update_battery_snapshots(updates)
        return {"updated": len(updates)}

    @api.post("/api/battery/snapshot/export")
    def export_battery_snapshot(body: SnapshotExportPayload) -> Response:
        battery = body.battery if body.battery is not None else database.list_battery()
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M%S")
        label = re.sub(r"[^a-zA-Z0-9_-]", "-", body.label).strip("-") if body.label else ""
        filename = f"{now}_{label}.json" if label else f"{now}.json"
        export = {
            "exported_at": datetime.now(timezone.utc).isoformat(),
            "label": body.label,
            "battery": battery,
        }
        content = json.dumps(export, indent=2, default=str)

        # Try to write locally (works in dev, no-op on Vercel)
        try:
            snapshots_dir = Path(__file__).resolve().parents[2] / "snapshots"
            snapshots_dir.mkdir(exist_ok=True)
            (snapshots_dir / filename).write_text(content)
        except Exception:
            pass

        return Response(
            content=content,
            media_type="application/json",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    # ── Detail report ────────────────────────────────────────────────────────

    @api.get("/api/battery/detail-report")
    def battery_detail_report() -> Response:
        battery = database.list_battery()
        report = build_detail_report(battery)
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M%S")
        filename = f"detail-report-{now}.json"
        content = json.dumps(report, indent=2, default=str)
        return Response(
            content=content,
            media_type="application/json",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    @api.get("/api/battery/glass-factor-audit")
    def battery_glass_factor_audit() -> Response:
        battery = database.list_battery()
        audit = build_glass_factor_audit(battery)
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M%S")
        filename = f"glass-factor-audit-{now}.json"
        content = json.dumps(audit, indent=2, default=str)
        return Response(
            content=content,
            media_type="application/json",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    @api.get("/api/battery/residual-audit")
    def battery_residual_audit() -> Response:
        battery = database.list_battery()
        audit = build_residual_audit(battery)
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M%S")
        filename = f"residual-audit-{now}.json"
        content = json.dumps(audit, indent=2, default=str)
        return Response(
            content=content,
            media_type="application/json",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    # ── Fixture (dev/test only) ───────────────────────────────────────────────

    @api.get("/api/fixtures/screenshot-cooling-load")
    def get_screenshot_fixture() -> dict[str, Any]:
        fixture_path = (
            Path(__file__).resolve().parents[2]
            / "tests" / "reference_cases" / "screenshot_cooling_load.json"
        )
        return json.loads(fixture_path.read_text())

    # Serve the built React frontend for all non-API paths.
    # Falls back gracefully when dist/ doesn't exist (local dev without a build).
    static_dir = Path(__file__).resolve().parents[2] / "frontend" / "dist"
    if static_dir.exists():
        api.mount("/", StaticFiles(directory=static_dir, html=True), name="frontend")

    return api


app = create_app()
