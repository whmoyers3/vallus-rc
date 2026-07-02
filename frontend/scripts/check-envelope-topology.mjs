import fs from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);
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
const { compileEnvelope } = moduleObject.exports;

const floor = {
  id: "floor-1",
  name: "Fixture Floor",
  authoringMode: "grid_manual",
  coordinateSpace: "world_feet",
  designGrid: { width: 28, depth: 16 },
  scale: { feetPerGrid: 1, gridSnapInches: 3 },
  defaultCeilingHeight: 8,
  calibration: { lines: [], confirmed: true, appliedFactor: 1, areaConfirmed: true },
  conditionedPerimeter: { width: 28, depth: 16 },
  exteriorPolygon: [{ x: 0, y: 0 }, { x: 28, y: 0 }, { x: 28, y: 16 }, { x: 0, y: 16 }],
  perimeterLocked: true,
  rooms: [
    { id: "laundry", name: "Laundry", x: 0, y: 0, width: 8, depth: 16, ceilingHeight: 8, ceilingType: "flat", components: [] },
    {
      id: "wic",
      name: "WIC (B2)",
      x: 8,
      y: 0,
      width: 8,
      depth: 16,
      ceilingHeight: 5,
      ceilingType: "vault_flat_peak",
      ceilingLowHeight: 5,
      ceilingPeakHeight: 8,
      ceilingRidgeDirection: "E-W",
      ceilingRidgeOffset: 0,
      ceilingFlatPeakWidth: 3,
      components: [],
    },
    { id: "bed", name: "Bedroom 2", x: 16, y: 0, width: 12, depth: 16, ceilingHeight: 8, ceilingType: "flat", components: [] },
  ],
  adjacentSpaces: [
    {
      id: "attic-west",
      name: "Attic 2",
      kind: "attic",
      x: 0,
      y: 16,
      width: 16,
      depth: 5,
      closedCeilingBelow: true,
      boundaryIntent: "attic",
      verticalProfile: { kind: "gable", zMin: 0, lowHeight: 0, peakHeight: 5, ridgeDirection: "N-S", ridgeOffset: -1 },
    },
    {
      id: "attic-east",
      name: "Attic 1",
      kind: "attic",
      x: 8,
      y: -5,
      width: 20,
      depth: 5,
      closedCeilingBelow: true,
      boundaryIntent: "attic",
      verticalProfile: { kind: "gable", zMin: 0, lowHeight: 0, peakHeight: 5, ridgeDirection: "N-S", ridgeOffset: 1 },
    },
  ],
};

const project = {
  schemaVersion: "takeoff.v1",
  name: "Compiler transition topology fixture",
  frontDoorFaces: "S",
  floors: [floor],
};

const result = compileEnvelope(project);
const transitionPanels = result.panels.filter((panel) => panel.source === "transition-profile-difference");
const transitionIssues = result.issues.filter((issue) => issue.kind === "missing-transition-panel");
const tinyOutsideRemainders = result.panels.filter((panel) => panel.source === "outside-remainder" && panel.area < 2);

console.log(JSON.stringify({
  panelCount: result.panels.length,
  transitionPanelCount: transitionPanels.length,
  transitionIssueCount: transitionIssues.length,
  transitionPanels: transitionPanels.map((panel) => ({
    room: panel.roomName,
    direction: panel.direction,
    area: panel.area,
    span: [panel.spanStart, panel.spanEnd],
    z: [panel.zMin, panel.zMax],
  })),
  tinyOutsideRemainders: tinyOutsideRemainders.map((panel) => ({
    room: panel.roomName,
    direction: panel.direction,
    area: panel.area,
  })),
}, null, 2));

if (transitionPanels.length < 2) {
  console.error("Expected at least two shared-profile transition panels for the WIC fixture.");
  process.exit(1);
}

if (transitionIssues.length !== transitionPanels.length) {
  console.error("Expected each transition panel to create a matching topology issue.");
  process.exit(1);
}

const reversedGableProject = {
  schemaVersion: "takeoff.v1",
  name: "Reversed flat-top gable fixture",
  frontDoorFaces: "S",
  floors: [{
    id: "floor-reversed",
    name: "Reversed Gable Floor",
    authoringMode: "grid_manual",
    coordinateSpace: "world_feet",
    designGrid: { width: 8, depth: 10 },
    scale: { feetPerGrid: 1, gridSnapInches: 3 },
    defaultCeilingHeight: 8,
    calibration: { lines: [], confirmed: true, appliedFactor: 1, areaConfirmed: true },
    conditionedPerimeter: { width: 8, depth: 10 },
    exteriorPolygon: [{ x: 8, y: 10 }, { x: 0, y: 10 }, { x: 0, y: 0 }, { x: 8, y: 0 }],
    perimeterLocked: true,
    rooms: [{
      id: "reversed-wic",
      name: "Reversed WIC",
      x: 0,
      y: 0,
      width: 8,
      depth: 10,
      polygon: [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 10 }, { x: 0, y: 10 }],
      ceilingHeight: 8,
      ceilingType: "vault_flat_peak",
      ceilingLowHeight: 5,
      ceilingPeakHeight: 8,
      ceilingRidgeDirection: "N-S",
      ceilingRidgeOffset: 0,
      ceilingFlatPeakWidth: 4,
      components: [],
    }],
    adjacentSpaces: [],
  }],
};

const reversedResult = compileEnvelope(reversedGableProject);
const reversedEndPanel = reversedResult.panels.find((panel) =>
  panel.roomId === "reversed-wic" &&
  panel.source === "outside-remainder" &&
  Math.abs(panel.area - 58) <= 0.01 &&
  panel.polygon2d.some((point) => point.x === 2 && point.y === 8) &&
  panel.polygon2d.some((point) => point.x === 6 && point.y === 8)
);

if (!reversedEndPanel) {
  console.error("Expected reversed flat-top gable end to preserve 5 ft sidewalls, 8 ft peak, and 4 ft flat top.");
  console.error(JSON.stringify(reversedResult.panels.map((panel) => ({
    direction: panel.direction,
    source: panel.source,
    area: panel.area,
    polygon2d: panel.polygon2d,
  })), null, 2));
  process.exit(1);
}
