import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire("/Users/will/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/");
const {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  LevelFormat,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableOfContents,
  TableRow,
  TextRun,
  WidthType,
} = require("docx");

const outPath = path.resolve("takeoff-tool/docs/VRC_Takeoff_Tool_Roadmap.docx");

const border = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
const borders = { top: border, bottom: border, left: border, right: border };
const cellMargins = { top: 90, bottom: 90, left: 120, right: 120 };

function p(text, opts = {}) {
  return new Paragraph({
    spacing: { after: opts.after ?? 120, before: opts.before ?? 0 },
    alignment: opts.alignment,
    children: [
      new TextRun({
        text,
        bold: opts.bold,
        italics: opts.italics,
        size: opts.size,
        color: opts.color ?? "222222",
      }),
    ],
  });
}

function h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 240, after: 120 },
    children: [new TextRun(text)],
  });
}

function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 200, after: 100 },
    children: [new TextRun(text)],
  });
}

function bullet(text) {
  return new Paragraph({
    numbering: { reference: "bullets", level: 0 },
    spacing: { after: 70 },
    children: [new TextRun(text)],
  });
}

function numbered(text) {
  return new Paragraph({
    numbering: { reference: "numbers", level: 0 },
    spacing: { after: 70 },
    children: [new TextRun(text)],
  });
}

function codeBlock(lines) {
  return new Paragraph({
    spacing: { before: 80, after: 160 },
    border: { left: { style: BorderStyle.SINGLE, size: 6, color: "9AA6B2", space: 8 } },
    children: [
      new TextRun({
        text: lines.join("    "),
        font: "Courier New",
        size: 19,
        color: "333333",
      }),
    ],
  });
}

function phaseTable(rows) {
  const widths = [1560, 3200, 4600];
  const header = new TableRow({
    children: ["Phase", "Goal", "Acceptance Signal"].map((text, index) =>
      new TableCell({
        borders,
        width: { size: widths[index], type: WidthType.DXA },
        margins: cellMargins,
        shading: { fill: "D9EAF7", type: ShadingType.CLEAR },
        children: [new Paragraph({ children: [new TextRun({ text, bold: true })] })],
      }),
    ),
  });
  return new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: widths,
    rows: [
      header,
      ...rows.map(
        (row) =>
          new TableRow({
            children: row.map(
              (text, index) =>
                new TableCell({
                  borders,
                  width: { size: widths[index], type: WidthType.DXA },
                  margins: cellMargins,
                  children: [new Paragraph({ children: [new TextRun(String(text))] })],
                }),
            ),
          }),
      ),
    ],
  });
}

const children = [
  p("VRC Takeoff Tool Roadmap", {
    size: 36,
    bold: true,
    alignment: AlignmentType.CENTER,
    after: 80,
  }),
  p("Plan PDF tracing, room partitioning, envelope takeoff, and VRC payload generation", {
    size: 22,
    italics: true,
    alignment: AlignmentType.CENTER,
    after: 240,
    color: "555555",
  }),
  p("Prepared for the Web App Load Calculation project", {
    alignment: AlignmentType.CENTER,
    after: 260,
  }),
  new TableOfContents("Table of Contents", { hyperlink: true, headingStyleRange: "1-3" }),

  h1("1. Executive Summary"),
  p("The VRC Takeoff Tool is a planned web-based authoring workflow for creating room-by-room load calculation inputs from plan PDFs. The PDF is only a tracing background. The editable takeoff JSON is the geometry source of truth. The generated VRC payload and Markdown are the calculation/export products."),
  p("The recommended implementation is a nested module inside the existing Web App Load Calculation repository, not a separate repository yet. This keeps the takeoff tool close to the VRC engine, Markdown importer, assembly definitions, Supabase storage, and existing unit/zone data model."),

  h1("2. Product Goals"),
  bullet("Upload or reference PDF plan pages and calibrate scale."),
  bullet("Trace conditioned exterior perimeters for each floor."),
  bullet("Partition each conditioned footprint into non-overlapping rooms."),
  bullet("Place windows and doors on valid exterior conditioned segments."),
  bullet("Assign boundary conditions for garage, attic, crawlspace, slab, floors above/below, and knee walls."),
  bullet("Support multiple floors and cross-floor overlays."),
  bullet("Assign rooms across HVAC units, zones, and thermostats."),
  bullet("Save and reopen editable takeoff JSON."),
  bullet("Generate VRC-compatible calculation payloads and Markdown."),
  bullet("Provide a blank scaled grid/manual drafting fallback for skewed or unreliable plan references."),

  h1("3. Delivery Strategy"),
  p("Build the takeoff tool as a route, tab, or module inside the existing VRC web app first. Use GitHub branches and Vercel preview deployments as the preferred verification environment."),
  p("Localhost may be used for quick developer checks, but it should not be the main user validation path. The user prefers the extra time of pushing to GitHub and refreshing after a Vercel build over starting and stopping local servers."),
  bullet("Keep early takeoff work feature-gated or isolated behind a route/tab."),
  bullet("Run local build/tests when practical to catch obvious breakage."),
  bullet("Push to GitHub so Vercel creates a preview deployment."),
  bullet("Verify the workflow on the hosted Vercel preview URL."),
  bullet("Merge or promote only after the hosted preview is accurate and workable."),

  h1("4. Repository And Storage Recommendation"),
  p("Keep the tool inside the existing VRC repository first. Use this planning folder for agent instructions and roadmap context, then place production code in backend, frontend, and supabase folders as implementation begins."),
  codeBlock([
    "WEBAPP - Load Calculation Software/",
    "  takeoff-tool/              planning and agent instructions",
    "  backend/takeoff/           geometry, validation, export modules",
    "  backend/api/takeoff.py     API routes",
    "  frontend/src/takeoff/      React takeoff UI",
    "  supabase/                  takeoff migrations",
  ]),
  p("Store editable takeoff JSON separately from calculation payloads. Link takeoff records to calculations records in Supabase. Store plan PDFs and rendered page images in Supabase Storage, with references in takeoff JSON."),
  codeBlock([
    "takeoff_json -> editable geometry and visual state",
    "payload_json -> executable VRC calculation input",
    "Markdown -> import/export bridge compatible with existing importer",
    "PDF/page image -> visual tracing background only",
  ]),

  h1("5. Input Modes"),
  p("The tool should support three authoring modes that all generate the same takeoff JSON and VRC payload. The mode changes how geometry is created, not how loads are calculated."),
  bullet("PDF trace mode: preferred. Upload or select a clean floor-plan PDF page, calibrate scale, and trace over it."),
  bullet("Image trace mode: fallback for screenshots or raster plan images. Manual calibration and a second scale check are required."),
  bullet("Grid/manual mode: fallback for skewed, stretched, low-quality, or unavailable plan pages. Draw on a blank scaled grid, enter exact dimensions, snap to increments, and optionally place a translucent plan reference as a visual guide."),

  h1("6. Core Product Rules"),
  numbered("Rooms on the same floor must never overlap."),
  numbered("The conditioned perimeter is the exterior-wall reference."),
  numbered("Interior room boundaries are attribution lines, not load-bearing components."),
  numbered("Windows snap only to valid conditioned exterior wall segments."),
  numbered("Garage-adjacent conditioned walls receive garage load treatment."),
  numbered("Floor and ceiling exposure may be partial by room."),
  numbered("Multiple floors may belong in one takeoff when one load calculation spans them."),
  numbered("Units and zones are assigned across rooms, not assumed from floor levels."),
  numbered("Grid/manual mode must generate the same takeoff JSON and payload as PDF tracing."),

  h1("7. Web App Feasibility"),
  p("A browser app can support the full planned workflow. Canvas or SVG layers can handle PDF rendering, tracing, snapping, and non-overlapping room partitioning. Three.js can render the modest 3D room preview needed for ceiling height, vaulted ceiling, gable, and kneewall decisions."),
  p("The hard part is not browser performance. The hard part is keeping the geometry model, validation rules, and generated calculation payload clear and auditable."),

  h1("8. Phased Roadmap"),
  phaseTable([
    ["0", "Contract and prototype spike", "Fixture-generated payload calculates and Markdown imports successfully."],
    ["1", "Single-floor manual takeoff MVP", "No overlaps, no unassigned conditioned area, save/reopen works."],
    ["2", "Exterior walls, windows, and doors", "Directional walls, glass, and door components export correctly."],
    ["3", "Boundary overlays", "Garage, attic, crawlspace, slab, partial floor/ceiling exposure work."],
    ["4", "Ceiling height and 3D preview", "Height/vault/kneewall edits update area, volume, and line items."],
    ["5", "Multi-floor alignment", "Two-story plans can be aligned and vertically reconciled."],
    ["6", "Systems, zones, and thermostats", "Rooms across floors can be assigned to units and zones."],
    ["7", "Production polish", "Autosave, undo/redo, migrations, QA report, and regression fixtures are in place."],
  ]),

  h2("Phase 0 - Contract And Prototype Spike"),
  bullet("Define takeoff JSON schema version v1."),
  bullet("Define geometry-to-payload and Markdown export mapping."),
  bullet("Create a hand-written fixture and prove it can generate valid VRC payload and Markdown."),
  bullet("Add a feature-gated or isolated takeoff route/tab shell suitable for Vercel preview verification."),

  h2("Phase 1 - Single-Floor Manual Takeoff MVP"),
  bullet("Render one PDF/page, calibrate scale, set orientation, trace and lock conditioned perimeter."),
  bullet("Add blank grid/manual drafting mode with configurable scale and snap increments."),
  bullet("Create non-overlapping rooms with polygon and rectangle tools."),
  bullet("Highlight unassigned floor area and save/reopen takeoff JSON."),

  h2("Phase 2 - Exterior Walls, Windows, And Doors"),
  bullet("Detect exterior perimeter segments and assign them to rooms."),
  bullet("Add window and door schedule panels with custom entry support."),
  bullet("Generate W1, G1/G2/G3, D1, and D2 line items."),

  h2("Phase 3 - Boundary Overlays"),
  bullet("Add garage, porch/outdoor, attic-adjacent, slab, crawlspace, garage-below, conditioned-above, attic-above, open-to-below, and cantilever overlays."),
  bullet("Support partial-area ceiling and floor load cases."),

  h2("Phase 4 - Ceiling Height And 3D Room Preview"),
  bullet("Add global and per-room height controls."),
  bullet("Add flat, taller flat, vaulted, gable, and kneewall profile prompts."),
  bullet("Render footprint extrusion and ceiling surfaces in a lightweight Three.js preview."),

  h2("Phase 5 - Multi-Floor Alignment"),
  bullet("Support multiple floors and page backgrounds in one takeoff project."),
  bullet("Align floors by reference points and show ghost overlays."),
  bullet("Assign vertical relationships between rooms/floors."),

  h2("Phase 6 - Systems, Zones, And Thermostats"),
  bullet("Add unit/zone assignment mode across floors."),
  bullet("Place thermostat markers and export unit_id/zone_id values."),

  h2("Phase 7 - Production Polish"),
  bullet("Add undo/redo, autosave, schema migrations, import/export takeoff JSON, improved snapping, QA reports, and regression fixtures."),

  h1("9. MVP Boundary"),
  p("The first useful MVP is Phases 0 through 2 plus basic save/reopen. Defer automatic plan recognition, OCR, CAD import, and advanced vertical inference until the manual workflow proves the data model."),

  h1("10. Future Session Instructions"),
  p("Future coding sessions should start by reading takeoff-tool/AGENTS.md, takeoff-tool/README.md, takeoff-tool/ROADMAP.md, takeoff-tool/DEPLOYMENT.md, takeoff-tool/CHANGELOG.md, CLAUDE.md, CONTEXT.md, backend/api/markdown_import.py, backend/engine/calculator.py, backend/api/serialization.py, and supabase/schema.sql."),
  p("Implementation should preserve the boundary between editable takeoff geometry and executable VRC payloads. The load engine should not become a geometry editor."),

  h1("11. Initial Open Questions"),
  bullet("Should generated wall components be exported as segment rows or aggregate rows per room/orientation/boundary?"),
  bullet("What tolerance should define unassigned floor-area slivers?"),
  bullet("Should garage-adjacent doors default to D2 or prompt every time?"),
  bullet("How editable should the 3D ceiling preview be?"),
  bullet("Should takeoff projects appear in the same saved-project list or a separate takeoff tab?"),
  bullet("Should the takeoff preview route be hidden behind a URL hash, an admin-only toggle, or a database/user feature flag during early development?"),
  bullet("What default grid increments should be offered: 1 ft, 6 in, 3 in, and custom?"),
];

const doc = new Document({
  styles: {
    default: { document: { run: { font: "Arial", size: 22 } } },
    paragraphStyles: [
      {
        id: "Heading1",
        name: "Heading 1",
        basedOn: "Normal",
        next: "Normal",
        quickFormat: true,
        run: { size: 30, bold: true, font: "Arial", color: "1F2937" },
        paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 0 },
      },
      {
        id: "Heading2",
        name: "Heading 2",
        basedOn: "Normal",
        next: "Normal",
        quickFormat: true,
        run: { size: 26, bold: true, font: "Arial", color: "334155" },
        paragraph: { spacing: { before: 200, after: 100 }, outlineLevel: 1 },
      },
    ],
  },
  numbering: {
    config: [
      {
        reference: "bullets",
        levels: [
          {
            level: 0,
            format: LevelFormat.BULLET,
            text: "\u2022",
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720, hanging: 360 } } },
          },
        ],
      },
      {
        reference: "numbers",
        levels: [
          {
            level: 0,
            format: LevelFormat.DECIMAL,
            text: "%1.",
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720, hanging: 360 } } },
          },
        ],
      },
    ],
  },
  sections: [
    {
      properties: {
        page: {
          size: { width: 12240, height: 15840 },
          margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
        },
      },
      headers: {
        default: new Header({
          children: [
            new Paragraph({
              alignment: AlignmentType.RIGHT,
              children: [new TextRun({ text: "VRC Takeoff Tool", size: 18, color: "666666" })],
            }),
          ],
        }),
      },
      footers: {
        default: new Footer({
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [
                new TextRun({ text: "Page ", size: 18 }),
                new TextRun({ children: [PageNumber.CURRENT], size: 18 }),
              ],
            }),
          ],
        }),
      },
      children,
    },
  ],
});

const buffer = await Packer.toBuffer(doc);
fs.writeFileSync(outPath, buffer);
console.log(outPath);
