# Baseline Takeoff Tool

The Baseline Takeoff Tool is a planned web-based authoring workflow for creating room-by-room load calculation inputs from plan PDFs. It will sit beside the existing Baseline load calculation app and generate both editable takeoff JSON and Baseline-compatible calculation payloads/Markdown.

## Problem

Today, Baseline can import Markdown created from Salas O'Brien resload PDFs and can also calculate from manually entered room/component data. The missing piece is a guided plan takeoff workflow that lets a user build those same room/component inputs visually from a floor plan.

The goal is not full automatic plan recognition. The goal is a fast, accurate, auditable manual takeoff assistant.

## Product Goals

- Upload or reference PDF plan pages.
- Calibrate drawing scale.
- Trace the conditioned exterior perimeter for each floor.
- Partition that floor into non-overlapping rooms.
- Assign exterior wall orientation from a north/front reference.
- Place windows and doors from a schedule or custom entry.
- Assign floor, ceiling, garage, attic, crawlspace, slab, and kneewall boundary conditions.
- Support multiple floors and cross-floor overlays.
- Assign rooms across HVAC units and zones.
- Save and reopen editable takeoff JSON.
- Generate Baseline calculation payloads and Markdown compatible with the existing importer.
- Provide a blank scaled grid/manual drafting mode for skewed or unreliable plan references.

## Non-Goals For Early Versions

- Full CAD/DWG import.
- Fully automatic wall/window recognition.
- Heavy offline desktop workflows.
- General-purpose drafting tools.
- Photorealistic 3D modeling.

## Suggested Folder Shape When Implementation Starts

```text
backend/
  api/
    takeoff.py
  takeoff/
    geometry.py
    export_markdown.py
    export_payload.py
    validation.py

frontend/
  src/
    takeoff/
      TakeoffApp.tsx
      canvas/
      geometry/
      panels/
      three/
      types.ts

supabase/
  migration_takeoff_projects.sql
```

This `takeoff-tool/` folder is the planning and agent-instruction workspace. The production code should live in the normal backend/frontend/supabase areas once built.

## High-Level Workflow

```text
1. Create or open takeoff project.
2. Upload/select PDF plan page.
3. Calibrate scale.
4. Set north/front orientation.
5. Trace conditioned perimeter.
6. Partition floor into non-overlapping rooms.
7. Place exterior windows and doors.
8. Assign boundary overlays for garage, attic, crawlspace, slab, floors above/below.
9. Adjust ceiling heights and ceiling profiles.
10. Assign rooms to units/zones.
11. Run validation.
12. Generate Baseline payload and Markdown.
13. Save linked calculation and editable takeoff JSON.
```

## Input Modes

The tool should support three authoring modes that all generate the same takeoff JSON:

- **PDF trace mode:** preferred. User uploads or selects a clean floor-plan PDF page, calibrates scale, and traces over it.
- **Image trace mode:** fallback for screenshots or raster plan images. User must manually calibrate and preferably verify scale from more than one known dimension.
- **Grid/manual mode:** fallback for skewed, poor-quality, or unavailable plan pages. User draws on a blank scaled grid, enters dimensions, snaps to grid increments, and can optionally place a plan image/PDF as a translucent visual reference without relying on it for scale.

Grid/manual mode is especially useful when the source plan is visibly skewed, stretched, or captured from a screen. It should use the same room, wall, window, door, ceiling, and boundary workflows after the initial geometry is created.

## Web App Feasibility

This remains a good web-app fit. Browser canvas/SVG layers can handle PDF rendering, tracing, snapping, and room partitioning. Three.js can render the modest 3D room previews needed for ceiling/vault/kneewall understanding. The complexity is in data modeling and validation, not in browser capability.

## Current Decision

Build inside the existing Baseline project first. Keep the geometry model separate from the engine payload, and link takeoff projects to calculation records in Supabase.

## Deployment And Verification

The preferred workflow is to build takeoff features as a tab/route/module in the existing Baseline app, push changes to GitHub, and verify them on a Vercel preview deployment. Localhost can still be used for quick developer checks, but future sessions should not depend on localhost as the main validation workflow.

This approach costs a little more time per iteration, but it verifies the app in the same hosted environment the user actually works in.
