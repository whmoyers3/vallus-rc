"""Vercel serverless entrypoint for VRC (Vallus Residential Calculator).

Vercel's Python runtime detects the `app` ASGI object and serves it.
All /api/* routes are rewritten here by vercel.json.
"""
from backend.api.app import app  # noqa: F401  — re-exported as the ASGI handler

__all__ = ["app"]
