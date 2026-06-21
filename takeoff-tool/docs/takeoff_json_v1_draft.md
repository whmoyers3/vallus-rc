# Takeoff JSON v1 Draft

This is a draft shape for the editable takeoff project. It is intentionally separate from the generated VRC payload.

```json
{
  "schema_version": "takeoff.v1",
  "project": {
    "name": "Example Plan",
    "calculation_id": null,
    "front_door_faces": "S",
    "building_type": "single_family",
    "authoring_mode": "pdf_trace"
  },
  "assets": [
    {
      "id": "asset-plan-pdf-1",
      "kind": "pdf",
      "storage_ref": "supabase://bucket/path/file.pdf",
      "filename": "plan.pdf"
    }
  ],
  "floors": [
    {
      "id": "floor-1",
      "name": "First Floor",
      "page_ref": {
        "asset_id": "asset-plan-pdf-1",
        "page_number": 1
      },
      "scale": {
        "pixels": 184.2,
        "feet": 10,
        "grid_snap_inches": 6
      },
      "orientation": {
        "north_degrees": 0
      },
      "conditioned_perimeter": {
        "id": "perimeter-1",
        "points": []
      },
      "rooms": [],
      "openings": [],
      "boundary_overlays": [],
      "vertical_overlays": []
    }
  ],
  "units": [
    {
      "id": "unit-whole-house",
      "name": "Whole House"
    }
  ],
  "zones": [],
  "validation": {
    "status": "draft",
    "issues": []
  }
}
```

## Geometry Notes

- Use stable IDs for all geometry objects.
- Store points in page coordinate space after calibration.
- Store transforms needed to render the PDF/page background.
- Do not store large PDF binaries in this JSON.
- Room polygons must not overlap within a floor.
- Generated payloads should be reproducible from this JSON without manual edits.
- `authoring_mode` may be `pdf_trace`, `image_trace`, or `grid_manual`.
- Grid/manual mode should store the same polygons and opening attachments as PDF trace mode. The difference is only how the user creates geometry.
