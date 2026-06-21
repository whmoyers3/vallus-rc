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

## 2026-06-21 - Import Scale Setup Added

Added a dedicated scale setup workflow after PDF/image upload.

Implemented:

- Upload now starts in an import calibration step before exterior tracing.
- Users can draw known horizontal, vertical, or free-angle dimension lines on the plan preview.
- Each scale line accepts a known real-world dimension in feet.
- The app computes an average scale correction and applies it to the design grid, fallback footprint, scale lines, rooms, and traced geometry.
- The PDF/image underlay and SVG grid/overlay continue to use the same zoom and view transforms.
- Exterior trace includes an expected floor-area sanity check and confirmation state.

Notes:

- Calibration lines are stored in takeoff JSON with the editable floor record.
- The current PDF preview is still browser-native; pdf.js page rendering remains the recommended hardening step.

## 2026-06-21 - Stable PDF Crop and Drag Room Start

Reworked the PDF underlay so it no longer uses the browser's embedded PDF viewer.

Implemented:

- Added pdf.js rendering for page 1 of uploaded PDFs.
- Rendered PDFs are displayed as a controlled image layer under the SVG grid.
- Upload now starts in a crop step so the user can drag around the plan area and remove title-block/border clutter.
- Cropped references stay anchored to the SVG overlay during zoom, Fit Grid, and Fit Plan.
- Added a first drag-to-create room mode for rectangular room placement.

Notes:

- The pdf.js worker increases the frontend bundle; route-level code splitting is a future optimization.
- Room drawing still needs point-by-point/polygon room geometry for non-rectangular spaces.

## 2026-06-21 - Polygon Rooms and Editable Points

Improved tracing and room authoring ergonomics.

Implemented:

- Raised maximum plan zoom from 300% to 800%.
- Rooms now render at 75% opacity so the plan remains visible underneath.
- Room labels can be clicked directly on the plan to rename the room.
- Added polygon room drawing with point-by-point clicks and edge snapping.
- Added Shift-drag movement for exterior points and polygon room points.
- Rectangular drag rooms clamp back to the exterior footprint bounds when dragged beyond the perimeter.
- Highlighted sampled unassigned slices inside the traced footprint.
- Added a first-pass control to attribute highlighted leftover cells to an adjacent room as an area adjustment.

Notes:

- Polygon room drawing is V1 geometry; full boolean slicing/merging remains a later hardening task.
- Unassigned slice detection currently samples by grid cells rather than producing exact CAD-grade polygon differences.

## 2026-06-21 - Crop Click and Precision Fixes

Improved import and drawing precision after field testing.

Implemented:

- Prevented crop drag release from becoming the first calibration scale-line point.
- Switched canvas click mapping to rendered SVG bounds for better high-zoom cursor precision.
- Removed forced grid rounding from raw cursor placement; geometry snapping is now handled separately.
- Dragged rectangle rooms now trim around existing room bounds and keep the largest available open rectangle.

Notes:

- Large rectangle trimming is still rectangle/bounds based; exact polygon clipping remains a later CAD-hardening task.

## 2026-06-21 - Polygon Boolean Room Merge/Subtract

Added first-pass polygon boolean operations for room authoring.

Implemented:

- Added `polygon-clipping` for union, intersection, and difference geometry.
- Large dragged room rectangles now clip to the exterior footprint and subtract existing room shapes, producing an available polygon room instead of only a rectangle.
- Added a subtraction drag mode that cuts a drawn shape out of a selected room.
- Highlighted unassigned slices now merge into the selected room polygon with a union operation instead of only adding an area adjustment.
- Polygon-aware room overlap checks now use intersection area rather than bounding boxes.

Notes:

- Current boolean workflow keeps the largest resulting polygon if an operation creates multiple disconnected pieces.
- More advanced merge/split review UI is still needed before production use.

## 2026-06-21 - Editable Takeoff Save/Reopen

Completed the Phase 1 editable takeoff persistence requirement.

Implemented:

- Added Supabase `takeoff_projects` storage for editable takeoff JSON separate from finalized `calculations` payloads.
- Added `/api/takeoffs` CRUD routes for list, create, reopen, update, and delete.
- Added a one-time Supabase migration file for existing databases.
- Added Takeoff V1 toolbar Save/Open controls with saved/unsaved state.
- Added an Open Takeoff modal listing saved takeoff drafts.
- Reopened takeoff JSON restores project name, floor setup, crop metadata, scale calibration, exterior polygon, room polygons, labels, and attributed slices.

Notes:

- Plan PDF/image file storage is not embedded in JSON; reopened drafts preserve reference metadata and can reattach the underlay later.
- Final Markdown payload export remains deferred until room characteristics, windows/doors, ceilings, and floor/ceiling boundary handling are complete.
