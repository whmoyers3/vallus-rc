# VRC Takeoff Tool Changelog

## 2026-06-20 - Planning Workspace Created

Initial planning workspace created for the VRC Takeoff Tool.

Decisions captured:

- Build the takeoff tool inside the existing VRC repository first.
- Store editable takeoff JSON separately from calculation payloads.
- Link takeoff records to `calculations` records in Supabase.
- Treat plan PDFs/images as tracing backgrounds, not calculation source of truth.
- Enforce rooms as a non-overlapping partition of the conditioned footprint.
- Use the existing VRC room/component payload model as the generated calculation target.
- Support Markdown output compatible with the current room-cooling Markdown importer.
- Use a browser-based app with canvas/SVG for plan tracing and Three.js for modest room-height/ceiling visualization.

Roadmap created:

- Phase 0: Contract and prototype spike.
- Phase 1: Single-floor manual takeoff MVP.
- Phase 2: Exterior walls, windows, and doors.
- Phase 3: Boundary overlays.
- Phase 4: Ceiling height and 3D room preview.
- Phase 5: Multi-floor alignment.
- Phase 6: Systems, zones, and thermostats.
- Phase 7: Production polish.

## 2026-06-20 - Deployment Preference Captured

Added deployment and verification guidance for future sessions.

Decision:

- Build the takeoff tool as a route/tab/module inside the existing VRC app first.
- Prefer GitHub branch pushes and Vercel preview deployments for user-facing verification.
- Use localhost only for quick developer checks when practical.
- Feature-gate or isolate unfinished takeoff work so production VRC workflows are not disrupted.

## 2026-06-20 - Grid Manual Fallback Added

Added blank grid/manual drafting mode to the product plan.

Decision:

- PDF trace mode remains the preferred authoring mode.
- Image trace mode is a fallback for screenshots/raster references and requires manual calibration.
- Grid/manual mode is a fallback for skewed, stretched, low-quality, or unavailable plan pages.
- Grid/manual mode must generate the same takeoff JSON and VRC payload as PDF trace mode.
- Users should be able to set scale, use snap increments, enter exact dimensions, and optionally place a translucent plan reference on top of or below the grid.

## 2026-06-21 - V1 Takeoff Route Scaffold

Initial V1 implementation scaffold added to the existing VRC frontend.

Implemented:

- New hash route: `/#/takeoff`.
- Toolbar and mobile-menu links from the current calculator.
- Separate React module under `frontend/src/takeoff/`.
- Takeoff v1 TypeScript types.
- Input mode selector for PDF trace, image trace, and grid/manual.
- Scaled grid preview.
- Conditioned footprint width/depth inputs.
- Rectangular room authoring scaffold with non-overlap and inside-footprint checks.
- Validation summary for unassigned area and geometry errors.
- Takeoff JSON preview.
- Initial VRC payload preview with room, slab, area, height, and volume mapping.

Verification:

- `npm run build` passed locally.

Not yet implemented:

- PDF rendering and page selection.
- True polygon tracing.
- Supabase takeoff persistence.
- Exterior wall segmentation.
- Window/door placement.
- Boundary overlays and ceiling profile workflows.

## 2026-06-21 - Design Grid and Exterior Trace Split

Expanded the V1 takeoff route to separate the drafting canvas from the conditioned footprint.

Implemented:

- Independent design grid width/depth controls for large working areas.
- Exterior polygon tracing over the grid with snap increments.
- Lock, unlock, clear, and rectangle-seed controls for the exterior trace.
- Conditioned footprint area calculation from the traced exterior polygon.
- Room validation against the traced polygon when present.
- Fit Grid and Fit Plan zoom actions.
- PDF/image reference underlay using browser-native object/image preview.

Notes:

- The PDF is currently a visual underlay only; the traced polygon remains the calculation source of truth.
- This does not yet include pdf.js page rendering, page selection, rotation, or calibration handles.
