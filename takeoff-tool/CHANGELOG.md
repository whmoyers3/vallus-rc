# Baseline Takeoff Tool Changelog

## 2026-06-20 - Planning Workspace Created

Initial planning workspace created for the Baseline Takeoff Tool.

Decisions captured:

- Build the takeoff tool inside the existing Baseline repository first.
- Store editable takeoff JSON separately from calculation payloads.
- Link takeoff records to `calculations` records in Supabase.
- Treat plan PDFs/images as tracing backgrounds, not calculation source of truth.
- Enforce rooms as a non-overlapping partition of the conditioned footprint.
- Use the existing Baseline room/component payload model as the generated calculation target.
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

- Build the takeoff tool as a route/tab/module inside the existing Baseline app first.
- Prefer GitHub branch pushes and Vercel preview deployments for user-facing verification.
- Use localhost only for quick developer checks when practical.
- Feature-gate or isolate unfinished takeoff work so production Baseline workflows are not disrupted.

## 2026-06-20 - Grid Manual Fallback Added

Added blank grid/manual drafting mode to the product plan.

Decision:

- PDF trace mode remains the preferred authoring mode.
- Image trace mode is a fallback for screenshots/raster references and requires manual calibration.
- Grid/manual mode is a fallback for skewed, stretched, low-quality, or unavailable plan pages.
- Grid/manual mode must generate the same takeoff JSON and Baseline payload as PDF trace mode.
- Users should be able to set scale, use snap increments, enter exact dimensions, and optionally place a translucent plan reference on top of or below the grid.

## 2026-06-21 - V1 Takeoff Route Scaffold

Initial V1 implementation scaffold added to the existing Baseline frontend.

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
- Initial Baseline payload preview with room, slab, area, height, and volume mapping.

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

## 2026-06-21 - Takeoff Reference File Storage

Added stored plan-page references to complete the save/reopen workflow.

Implemented:

- Added private Supabase Storage bucket setup for `takeoff-references`.
- Set the plan reference file cap to 7 MB for PDF, PNG, JPEG, and WebP files.
- Added `takeoff_assets` metadata storage linked to editable takeoff projects.
- Added backend upload and download endpoints for takeoff reference files.
- Takeoff PDF/image uploads now store the original file and save an `assetId` in the editable JSON.
- Reopened takeoffs now restore the plan underlay from the stored reference file.
- Permanent takeoff JSON strips transient signed/download URLs while keeping durable asset metadata.

Notes:

- This keeps PDF/image files disposable later without deleting the editable geometry JSON.
- A future cleanup tool should remove old stored reference files while preserving takeoff drafts.

## 2026-06-21 - Polygon Close Controls

Improved the draw-polygon room tool so closing a room is explicit.

Implemented:

- Added a Finish Polygon button once a draft has at least 3 points.
- Added Enter to finish and Escape to clear a polygon draft.
- Added a visible Close marker on the first polygon point.
- Added a closing-edge preview and light fill once the polygon can be finished.
- Successful polygon finish now exits polygon drawing mode so later clicks do not keep adding points.
- Polygon finish now clips to the available conditioned footprint and subtracts existing rooms instead of silently blocking on overlaps.

## 2026-06-21 - Phase 1.5 Room Profiles

Started the Phase 1.5 bridge from geometry drafting to load surfaces.

Implemented:

- Added room selection from the plan and room list.
- Added a Room Profile editor for drawn rooms.
- Room names and ceiling heights can now be edited after room creation.
- Added per-room ceiling treatment: flat, vaulted, or no ceiling load.
- Added per-room floor treatment: slab, framed/exposed floor, or no floor load.
- Added ceiling and floor load-area overrides for simple partial exposure cases.
- Generated payload preview now emits `C1`, `C2`, `F1`, and `F2` line items from room profile settings.
- Added room-profile validation for missing height or zero load areas.
- Reworked room load surfaces into multiple floor/ceiling component rows with assembly, area, and label.
- Added component checksums against measured room area so split slab/crawl or split ceiling cases can be verified.
- Added `C3`, `W1`, `W2`, `W3`, `G1`, `G2`, and `G3` default assembly definitions to the takeoff payload preview.

Notes:

- This is not the full boundary-overlay or 3D ceiling workflow; it is the editable room profile layer needed before Phase 2 windows/doors and later boundary phases.

## 2026-06-21 - Phase 1.6 Component Schedule

Added the first component schedule and library workflow.

Implemented:

- Added a top-level Component Schedule button on the takeoff toolbar.
- Added a project schedule modal with current scheduled components.
- Added searchable library components from the existing `assemblies` table.
- Added one-off component entry for project-only definitions.
- Added save-to-library support through `/api/assemblies`.
- Persisted the project component schedule in takeoff JSON.
- Room component rows now select floor/ceiling assemblies from the project schedule.
- Payload preview now uses scheduled U-values, SHGC values, and descriptions instead of fixed takeoff defaults.

## 2026-06-22 - Phase 2 Manual Envelope Rows

Started the Phase 2 wall/window/door workflow with the manual data foundation.

Implemented:

- Room profiles can now add wall, window, and door component rows.
- Wall/window/door rows capture assembly, direction, label, and area.
- Window rows export as glass line items in the payload preview.
- Wall and door rows export as opaque directional line items.
- Window and door direction choices are limited to the room's detected exterior/load-bearing directions.
- Room profiles suggest gross wall areas from detected exterior linear footage times ceiling height.
- Suggested wall areas can be approved into editable wall component rows by assembly type.
- Payload export subtracts same-direction window and door opening area from gross wall area.
- Validation flags openings assigned to non-exterior directions or openings that exceed same-direction wall area.
- Added plan-grid opening placement mode.
- Clicking an exterior room edge now identifies the room and wall facing, then opens a confirmation dialog for glass/door type, component, size, and label.
- Confirmed openings are stored on the room profile with a drawing marker and reopenable placement point.
- Component assignment views now show the selected component description, U-value, U-factor, and SHGC where applicable.
- Placed opening markers can now be clicked to edit type, component, size, or label, or remove the opening from the wall.
- Placed opening markers can be dragged along their assigned exterior wall segment without moving to a different room.
- Added a room-level Wall / Opening Reconciliation card showing gross wall area, glass area, door area, and net wall area by direction.
- Improved Room Profile side-panel scaling so reconciliation rows and component remove buttons fit inside the panel.
- Added adjacent-space tagging for garage, attic, crawl space, and exterior areas on the plan grid.
- Garage-adjacent walls are shown in room reconciliation and glass placement/editing is blocked or flagged on garage-adjacent walls.
- Added floor and ceiling area reconciliation cards with quick actions to set full room area or intentionally mark no load.
- Validation now respects intentional no-load floor and ceiling selections.
- Validation warnings/errors can now be clicked to select the affected room or focus highlighted unassigned area.
- Added first-pass room ceiling shape controls for flat/taller flat, vaulted, and no ceiling load.
- Conditioned-footprint containment validation now uses area overlap tolerance to avoid false room-boundary warnings after clipping/snapping.
- Unassigned conditioned areas are now grouped into contiguous regions; validation targets each region separately and attribution merges only the selected region into an adjacent room.
- Restored unassigned-area detection by deriving open cells from current room geometry instead of stale attributed slice history.
- Prevented dragged room shapes from filling polygon holes over existing rooms, avoiding overlap regressions.
- Swapped the takeoff workspace layout so drawing tools, adjacent spaces, openings, and validation live in the right rail, while room summary tiles and the expanded Room Profile editor sit directly beneath the plan grid.
- Added a room-summary metric toggle for floor area, ceiling area, net wall area, or glass area.
- Improved dragged-room clipping so oversized rectangles can start over existing rooms and create only the currently uncovered conditioned-area section or sections.
- Synced the selected unassigned-region state after room deletion/reshaping so validation and highlighted open-area totals refresh against current geometry.
- Re-merged connected clipped room pieces after blocker subtraction so hallway-like open areas become one room instead of several slices.
- Reworked unassigned-space detection to clip actual open geometry from the footprint minus rooms, so deleting or reshaping a room restores an actionable validation warning with highlighted assignable area.
- Dragged room creation now also uses the same clipped unassigned-space geometry as validation, preventing adjacent open hallway bands from being missed when direct room clipping drops a section.
- Hid Takeoff JSON and Payload Preview output panels by default behind explicit Show/Hide controls.
- Grouped the plan grid zoom controls so minus, zoom percent, and plus sit together beside Fit Grid/Fit Plan.
- Added floor default ceiling height, vaulted ridge direction, and room-level ceiling geometry approval fields to editable takeoff JSON.
- Added ceiling geometry validation for large height changes, including an estimated raised wall/knee-wall exposure warning.
- Added a first-pass Ceiling Geometry QA sketch in Room Profile to visualize flat/taller and vaulted ceiling height/ridge direction before export.
- Added draggable vaulted-ceiling ridge offset in the QA sketch; approval refreshes vaulted ceiling component area from the estimated sloped surface.
- Adjusted the Ceiling Geometry QA sketch viewBox/headroom so vaulted ridges and top wall lines remain visible instead of clipping at the top.
- Added plan-grid review modes for Plan, Floor, Ceiling, Walls, and 3D QA so QA can review floor/ceiling/wall information across the full plan instead of only within Room Profile.
- Ceiling review mode shows vaulted ridge direction and low/peak heights across rooms; Wall review mode emphasizes exterior/load-bearing wall segments.
- Added a Three.js-powered 3D QA model preview with translucent room floors, walls, ceilings, opening markers, and vaulted ridge lines so component QA can happen in a spatial view instead of a labeled 2D overlay.
- Added 3D QA navigation: right-click drag orbit, wheel zoom, drag pan, and Iso/Front/Rear/Left/Right camera presets.
- Improved 3D opening visibility by anchoring placed windows and doors to the nearest actual room wall edge with a visible frame instead of relying only on compass-facing placement.
- Added 3D QA layer checkboxes for windows, doors, ceilings, floors, and walls so reviewers can isolate or hide component types while verifying takeoff changes.
- Added the uploaded/rendered plan reference as a translucent floor texture in 3D QA, with a Plan PDF checkbox so it can be shown for context or hidden during component verification.
- Split the 3D wall layer into default-on load/perimeter walls and default-off faint interior walls so the QA view focuses on load components while still allowing interior partitions for orientation.
- Expanded 3D ceiling QA rendering so taller flat ceilings show raised/knee-wall panels and vaulted ceilings show sloped ceiling planes, gable/knee-wall panels, and ridge geometry aligned with the current vaulted ceiling area calculation.

Still pending:

- More detailed adjacent-space export treatment for attic/crawl/garage wall assemblies.
- Richer multi-view elevation/stick-frame navigation and full knee-wall/gable-end export behavior.
