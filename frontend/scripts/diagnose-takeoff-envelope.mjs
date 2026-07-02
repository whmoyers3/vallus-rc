import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);

const args = parseArgs(process.argv.slice(2));
const takeoffId = Number(args.id ?? 11);
const outDir = path.resolve(String(args.outDir ?? "/private/tmp"));
const outputBase = path.join(outDir, `takeoff-${takeoffId}-envelope-diagnostic`);

const { compileEnvelope } = loadCompiler();
const takeoff = await loadTakeoff({ takeoffId, args });
const sanitized = geometryOnlyTakeoff(takeoff);
const compilation = compileEnvelope(sanitized);
const summary = buildSummary(takeoff, sanitized, compilation);

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(`${outputBase}.json`, JSON.stringify({ summary, sanitized, compilation }, null, 2));
fs.writeFileSync(`${outputBase}.svg`, renderDiagnosticSvg(sanitized, compilation, summary));
fs.writeFileSync(`${outputBase}.html`, renderDiagnosticHtml(sanitized, compilation, summary));

console.log(JSON.stringify({
  takeoffId,
  name: takeoff.name,
  source: summary.source,
  checks: summary.checks,
  suggestions: summary.suggestions,
  outputs: {
    summaryJson: `${outputBase}.json`,
    svg: `${outputBase}.svg`,
    html: `${outputBase}.html`,
  },
}, null, 2));

if (summary.checks.some((check) => check.status === "fail")) process.exit(1);

function parseArgs(entries) {
  const parsed = {};
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry.startsWith("--")) continue;
    const key = entry.slice(2);
    const next = entries[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function loadCompiler() {
  const source = fs.readFileSync(new URL("../src/takeoff/envelope/compiler.ts", import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const moduleObject = { exports: {} };
  new Function("require", "exports", "module", output)(require, moduleObject.exports, moduleObject);
  return moduleObject.exports;
}

async function loadTakeoff({ takeoffId, args }) {
  if (args.input) {
    const loaded = JSON.parse(fs.readFileSync(path.resolve(String(args.input)), "utf8"));
    return loaded.takeoff_json ?? loaded.takeoffJson ?? loaded;
  }

  if (args.api) {
    const baseUrl = String(args.api).replace(/\/$/, "");
    const response = await fetch(`${baseUrl}/api/takeoffs/${takeoffId}`);
    if (!response.ok) throw new Error(`Local API returned ${response.status} for takeoff ${takeoffId}.`);
    return await response.json();
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, pass --api http://127.0.0.1:8009, or pass --input /path/to/takeoff.json.");
  }

  const url = new URL("/rest/v1/takeoff_projects", supabaseUrl);
  url.searchParams.set("id", `eq.${takeoffId}`);
  url.searchParams.set("select", "id,name,takeoff_json");
  const response = await fetch(url, {
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      accept: "application/json",
    },
  });
  if (!response.ok) throw new Error(`Supabase REST returned ${response.status} for takeoff ${takeoffId}: ${await response.text()}`);
  const rows = await response.json();
  if (!rows[0]?.takeoff_json) throw new Error(`Takeoff ${takeoffId} was not found in Supabase.`);
  return rows[0].takeoff_json;
}

function geometryOnlyTakeoff(takeoff) {
  return {
    schemaVersion: "takeoff.v1",
    name: `${takeoff.name || "Takeoff"} geometry-only diagnostic`,
    location: takeoff.location,
    frontDoorFaces: takeoff.frontDoorFaces ?? "S",
    floors: (takeoff.floors ?? []).map((floor) => ({
      id: floor.id,
      name: floor.name,
      authoringMode: floor.authoringMode ?? "grid_manual",
      coordinateSpace: floor.coordinateSpace ?? "world_feet",
      designGrid: floor.designGrid ?? { width: floor.conditionedPerimeter?.width ?? 0, depth: floor.conditionedPerimeter?.depth ?? 0 },
      scale: floor.scale ?? { feetPerGrid: 1, gridSnapInches: 6 },
      defaultCeilingHeight: floor.defaultCeilingHeight ?? 8,
      calibration: floor.calibration ?? { lines: [], confirmed: true, appliedFactor: 1, areaConfirmed: true },
      conditionedPerimeter: floor.conditionedPerimeter ?? { width: 0, depth: 0 },
      exteriorPolygon: clonePoints(floor.exteriorPolygon),
      perimeterLocked: floor.perimeterLocked ?? false,
      attributedSlices: floor.attributedSlices ?? [],
      rooms: (floor.rooms ?? []).map((room) => ({
        id: room.id,
        name: room.name,
        x: room.x,
        y: room.y,
        width: room.width,
        depth: room.depth,
        polygon: clonePoints(room.polygon),
        ceilingHeight: room.ceilingHeight ?? floor.defaultCeilingHeight ?? 8,
        ceilingType: room.ceilingType,
        ceilingLowHeight: room.ceilingLowHeight,
        ceilingPeakHeight: room.ceilingPeakHeight,
        ceilingRidgeDirection: room.ceilingRidgeDirection,
        ceilingRidgeOffset: room.ceilingRidgeOffset,
        ceilingFlatPeakWidth: room.ceilingFlatPeakWidth,
        ceilingGeometryApproved: room.ceilingGeometryApproved,
        components: [],
      })),
      adjacentSpaces: (floor.adjacentSpaces ?? []).map((space) => ({
        id: space.id,
        name: space.name,
        kind: space.kind,
        x: space.x,
        y: space.y,
        width: space.width,
        depth: space.depth,
        polygon: clonePoints(space.polygon),
        ceilingHeight: space.ceilingHeight,
        ceilingType: space.ceilingType,
        ceilingLowHeight: space.ceilingLowHeight,
        ceilingPeakHeight: space.ceilingPeakHeight,
        ceilingRidgeDirection: space.ceilingRidgeDirection,
        ceilingRidgeOffset: space.ceilingRidgeOffset,
        ceilingFlatPeakWidth: space.ceilingFlatPeakWidth,
        verticalProfile: space.verticalProfile,
        closedCeilingBelow: space.closedCeilingBelow,
        boundaryIntent: space.boundaryIntent,
      })),
    })),
  };
}

function clonePoints(points) {
  return Array.isArray(points) ? points.map((point) => ({ x: point.x, y: point.y })) : [];
}

function buildSummary(original, sanitized, compilation) {
  const panels = compilation.panels;
  const transitionPanels = panels.filter((panel) => panel.source === "transition-profile-difference");
  const tinyPanels = panels.filter((panel) => panel.area > 0 && panel.area < 2);
  const reviewPanels = panels.filter((panel) => panel.loadState === "review" || panel.loadState === "gap");
  const sourceCounts = countBy(panels, (panel) => panel.source);
  const adjacencyCounts = countBy(panels, (panel) => panel.adjacency);
  const strippedComponentCount = (original.floors ?? []).reduce((sum, floor) =>
    sum + (floor.rooms ?? []).reduce((roomSum, room) => roomSum + (room.components?.length ?? 0), 0), 0);
  const roomCount = sanitized.floors.reduce((sum, floor) => sum + floor.rooms.length, 0);
  const exteriorTracePointCount = sanitized.floors.reduce((sum, floor) => sum + floor.exteriorPolygon.length, 0);
  const checks = [
    {
      name: "Geometry-only input",
      status: strippedComponentCount > 0 && sanitized.floors.every((floor) => floor.rooms.every((room) => room.components.length === 0)) ? "pass" : "warn",
      detail: `Ignored ${strippedComponentCount} persisted room components and compiled from exterior trace, room slices, ceiling design, and adjacent-space profiles.`,
    },
    {
      name: "Exterior trace present",
      status: exteriorTracePointCount >= 3 ? "pass" : "fail",
      detail: `${exteriorTracePointCount} exterior trace points.`,
    },
    {
      name: "Room slices present",
      status: roomCount > 0 ? "pass" : "fail",
      detail: `${roomCount} room slices.`,
    },
    {
      name: "Transition panels generated",
      status: transitionPanels.length > 0 ? "pass" : "fail",
      detail: `${transitionPanels.length} transition/profile-difference panels.`,
    },
    {
      name: "Tiny generated slivers",
      status: tinyPanels.length === 0 ? "pass" : "warn",
      detail: `${tinyPanels.length} generated panels under 2 sf.`,
    },
  ];
  const suggestions = [];
  if (transitionPanels.length > 0) {
    suggestions.push("Review the gold transition panels first; these are profile-difference surfaces, not ordinary wall remainders.");
  }
  if (tinyPanels.length > 0) {
    suggestions.push("Add or tune sliver absorption before promoting tiny generated panels into load components.");
  }
  if (reviewPanels.length > transitionPanels.length) {
    suggestions.push("Classify non-transition review/gap panels separately so validation does not collapse distinct topology issues into one prompt.");
  }
  if ((sourceCounts["outside-remainder"] ?? 0) > (sourceCounts["adjacent-space"] ?? 0) + 6) {
    suggestions.push("Check whether exterior remainders are being over-split around the WIC/attic contacts.");
  }
  if (suggestions.length === 0) suggestions.push("No obvious compiler change suggested by the automatic checks; use the diagnostic view for human review.");

  return {
    source: "geometry-only",
    roomCount,
    exteriorTracePointCount,
    strippedComponentCount,
    panelCount: panels.length,
    issueCount: compilation.issues.length,
    sourceCounts,
    adjacencyCounts,
    transitionPanels: transitionPanels.map(panelSummary),
    tinyPanels: tinyPanels.map(panelSummary),
    checks,
    suggestions,
  };
}

function countBy(items, keyFor) {
  return items.reduce((counts, item) => {
    const key = String(keyFor(item) ?? "unknown");
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function panelSummary(panel) {
  return {
    id: panel.id,
    room: panel.roomName,
    source: panel.source,
    adjacency: panel.adjacency,
    direction: panel.direction,
    area: panel.area,
    span: [panel.spanStart, panel.spanEnd],
    z: [panel.zMin, panel.zMax],
  };
}

function renderDiagnosticHtml(project, compilation, summary) {
  const svg = renderDiagnosticSvg(project, compilation, summary);
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(project.name)} envelope diagnostic</title>
  <style>
    body { margin: 0; background: #eef4f8; color: #172033; font: 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .wrap { padding: 24px; }
    pre { background: #fff; border: 1px solid #cad7e3; border-radius: 8px; padding: 16px; overflow: auto; }
    svg { width: 100%; height: auto; display: block; background: #eef4f8; }
  </style>
</head>
<body>
  <div class="wrap">
    ${svg}
    <h2>Summary</h2>
    <pre>${escapeHtml(JSON.stringify(summary, null, 2))}</pre>
  </div>
</body>
</html>`;
}

function renderDiagnosticSvg(project, compilation, summary) {
  const width = 1800;
  const height = 1250;
  const isoBounds = projectedBounds(compilation.panels);
  const isoScale = Math.min(980 / Math.max(1, isoBounds.width), 640 / Math.max(1, isoBounds.height));
  const isoOffset = {
    x: 900 - (isoBounds.minX + isoBounds.width / 2) * isoScale,
    y: 390 - (isoBounds.minY + isoBounds.height / 2) * isoScale,
  };
  const sortedPanels = [...compilation.panels].sort((a, b) => averageDepth(a) - averageDepth(b));
  const panelShapes = sortedPanels.map((panel) => renderIsoPanel(panel, isoScale, isoOffset)).join("\n");
  const labelLines = sortedPanels.slice(0, 18).map((panel, index) => renderPanelCallout(panel, index)).join("\n");
  const flatCards = compilation.panels.slice(0, 18).map((panel, index) => renderFlatCard(panel, index)).join("\n");
  const checkRows = summary.checks.map((check, index) => `
    <text x="1180" y="${126 + index * 28}" fill="${check.status === "pass" ? "#17683a" : check.status === "warn" ? "#9a6500" : "#b42318"}" font-size="17" font-weight="700">${escapeXml(check.status.toUpperCase())}</text>
    <text x="1250" y="${126 + index * 28}" fill="#25364d" font-size="17">${escapeXml(check.name)}: ${escapeXml(check.detail)}</text>
  `).join("\n");
  const suggestionRows = summary.suggestions.slice(0, 5).map((suggestion, index) => `
    <text x="1180" y="${330 + index * 26}" fill="#25364d" font-size="16">${index + 1}. ${escapeXml(suggestion)}</text>
  `).join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Takeoff envelope diagnostic">
  <rect width="${width}" height="${height}" fill="#eef4f8"/>
  <text x="48" y="56" fill="#172033" font-size="34" font-weight="800">Takeoff #${escapeXml(String(args.id ?? 11))} - Geometry-Only Envelope Diagnostic</text>
  <text x="48" y="88" fill="#526174" font-size="18">${escapeXml(project.name)} - ${summary.panelCount} panels - ${summary.issueCount} topology flags - ignored ${summary.strippedComponentCount} persisted components</text>

  <g aria-label="3D diagnostic panels">
    ${panelShapes}
    ${labelLines}
  </g>

  <g aria-label="checks">
    <rect x="1150" y="92" width="600" height="330" rx="8" fill="#ffffff" stroke="#cad7e3"/>
    <text x="1180" y="72" fill="#172033" font-size="24" font-weight="800">Checks</text>
    ${checkRows}
    <text x="1180" y="295" fill="#172033" font-size="21" font-weight="800">Suggested next changes</text>
    ${suggestionRows}
  </g>

  <g aria-label="legend">
    ${legendItem(58, 710, "#4b91bd", "W1 exterior / outside remainder")}
    ${legendItem(400, 710, "#c95757", "W3 attic / knee-wall")}
    ${legendItem(690, 710, "#f3c541", "Transition profile-difference")}
    ${legendItem(1050, 710, "#8d949a", "Conditioned / unknown review")}
  </g>

  <line x1="48" y1="760" x2="1752" y2="760" stroke="#c0cfdd"/>
  <text x="48" y="808" fill="#172033" font-size="30" font-weight="800">Flattened Panel View</text>
  <text x="48" y="838" fill="#526174" font-size="17">Compiler wall-plane polygons from the geometry-only input. Gold cards should correspond to transition/profile-difference pieces.</text>
  ${flatCards}
</svg>`;
}

function renderIsoPanel(panel, scale, offset) {
  const points = panel.vertices3d.map((vertex) => {
    const projected = isoProject(vertex);
    return `${round(projected.x * scale + offset.x)},${round(projected.y * scale + offset.y)}`;
  }).join(" ");
  return `<polygon points="${points}" fill="${panelColor(panel)}" fill-opacity="${panel.source === "transition-profile-difference" ? "0.82" : "0.62"}" stroke="#172033" stroke-opacity="0.8" stroke-width="2"/>`;
}

function renderPanelCallout(panel, index) {
  const center = averageProjectedPoint(panel);
  const x = index % 2 === 0 ? 70 : 1450;
  const y = 130 + Math.floor(index / 2) * 48;
  return `
    <line x1="${round(center.x)}" y1="${round(center.y)}" x2="${x + (index % 2 === 0 ? 210 : 0)}" y2="${y - 10}" stroke="#536276" stroke-width="1.2"/>
    <rect x="${x}" y="${y - 34}" width="260" height="44" rx="6" fill="#ffffff" stroke="${panel.source === "transition-profile-difference" ? "#a65f00" : "#536276"}" stroke-width="1.5"/>
    <text x="${x + 14}" y="${y - 14}" fill="#172033" font-size="15" font-weight="800">${escapeXml(panel.direction ?? "Wall")} ${escapeXml(panel.source.replaceAll("-", " "))}</text>
    <text x="${x + 14}" y="${y + 4}" fill="#526174" font-size="13">${escapeXml(panel.roomName)} - ${Math.round(panel.area)} sf</text>
  `;
}

function renderFlatCard(panel, index) {
  const columns = 5;
  const cardWidth = 320;
  const cardHeight = 145;
  const gap = 24;
  const x = 48 + (index % columns) * (cardWidth + gap);
  const y = 875 + Math.floor(index / columns) * (cardHeight + 28);
  const bounds = bounds2d(panel.polygon2d);
  const scale = Math.min(220 / Math.max(1, bounds.width), 78 / Math.max(1, bounds.height));
  const ox = x + 50 - bounds.minX * scale + (220 - bounds.width * scale) / 2;
  const oy = y + 108 + bounds.minY * scale - (78 - bounds.height * scale) / 2;
  const points = panel.polygon2d.map((point) => `${round(point.x * scale + ox)},${round(oy - point.y * scale)}`).join(" ");
  return `
    <g>
      <rect x="${x}" y="${y}" width="${cardWidth}" height="${cardHeight}" rx="8" fill="#ffffff" stroke="#cad7e3"/>
      <text x="${x + 16}" y="${y + 28}" fill="#172033" font-size="16" font-weight="800">${escapeXml(panel.direction ?? "Wall")} ${escapeXml(panel.roomName)}</text>
      <text x="${x + 16}" y="${y + 50}" fill="#526174" font-size="13">${escapeXml(panel.source)} - ${panel.area.toFixed(1)} sf</text>
      <polygon points="${points}" fill="${panelColor(panel)}" fill-opacity="0.86" stroke="#172033" stroke-width="2"/>
    </g>
  `;
}

function legendItem(x, y, color, label) {
  return `<rect x="${x}" y="${y - 18}" width="34" height="20" rx="3" fill="${color}" stroke="#172033"/><text x="${x + 46}" y="${y - 2}" fill="#25364d" font-size="16">${escapeXml(label)}</text>`;
}

function panelColor(panel) {
  if (panel.source === "transition-profile-difference") return "#f3c541";
  if (panel.adjacency === "attic") return "#c95757";
  if (panel.adjacency === "conditioned") return "#8d949a";
  if (panel.adjacency === "unknown") return "#b7a17a";
  return "#4b91bd";
}

function isoProject(vertex) {
  return {
    x: (vertex.x - vertex.z) * 0.866,
    y: (vertex.x + vertex.z) * 0.43 - vertex.y * 1.35,
  };
}

function projectedBounds(panels) {
  const points = panels.flatMap((panel) => panel.vertices3d.map(isoProject));
  if (points.length === 0) return { minX: 0, minY: 0, width: 1, height: 1 };
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return { minX, minY, width: maxX - minX, height: maxY - minY };
}

function averageDepth(panel) {
  return panel.vertices3d.reduce((sum, vertex) => sum + vertex.x + vertex.z, 0) / Math.max(1, panel.vertices3d.length);
}

function averageProjectedPoint(panel) {
  const points = panel.vertices3d.map(isoProject);
  const bounds = projectedBounds([panel]);
  const allBounds = projectedBounds(compilation.panels);
  const scale = Math.min(980 / Math.max(1, allBounds.width), 640 / Math.max(1, allBounds.height));
  const offset = {
    x: 900 - (allBounds.minX + allBounds.width / 2) * scale,
    y: 390 - (allBounds.minY + allBounds.height / 2) * scale,
  };
  return {
    x: (bounds.minX + bounds.width / 2) * scale + offset.x,
    y: (bounds.minY + bounds.height / 2) * scale + offset.y,
  };
}

function bounds2d(points) {
  if (!points.length) return { minX: 0, minY: 0, width: 1, height: 1 };
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return { minX, minY, width: maxX - minX, height: maxY - minY };
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeXml(value) {
  return escapeHtml(value).replaceAll('"', "&quot;");
}

function round(value) {
  return Number(value.toFixed(2));
}
