import polygonClipping, { type MultiPolygon, type Polygon, type Ring } from "polygon-clipping";
import type {
  TakeoffAdjacentSpace,
  TakeoffAdjacentSpaceKind,
  TakeoffBoundaryType,
  TakeoffFloor,
  TakeoffPoint,
  TakeoffProject,
  TakeoffRectRoom,
  TakeoffRoomComponent,
  TakeoffVerticalProfile,
  TakeoffWallAdjacency,
} from "../types";

const { difference, intersection, union } = polygonClipping;

export type EnvelopeDirection = NonNullable<TakeoffRoomComponent["direction"]>;
export type EnvelopeSurface = "wall" | "ceiling" | "floor" | "roof";
export type EnvelopePanelLoadState = "load" | "no-load" | "review" | "gap";

export type EnvelopeVec3 = {
  x: number;
  y: number;
  z: number;
};

export type EnvelopePanel = {
  id: string;
  floorId: string;
  floorName: string;
  roomId: string;
  roomName: string;
  surface: EnvelopeSurface;
  direction?: EnvelopeDirection;
  polygon2d: TakeoffPoint[];
  vertices3d: EnvelopeVec3[];
  area: number;
  spanStart?: number;
  spanEnd?: number;
  zMin?: number;
  zMax?: number;
  placement?: TakeoffPoint;
  adjacency: TakeoffWallAdjacency;
  boundary: TakeoffBoundaryType;
  assembly?: string;
  loadState: EnvelopePanelLoadState;
  source: "host-wall" | "adjacent-space" | "outside-remainder" | "unknown-gap";
  reason: string;
};

export type EnvelopeComponentDraft = {
  id: string;
  floorId: string;
  roomId: string;
  surface: "wall";
  direction: EnvelopeDirection;
  assembly: string;
  adjacency: TakeoffWallAdjacency;
  boundary: TakeoffBoundaryType;
  area: number;
  label: string;
  geometryLabel: string;
  loadExempt?: boolean;
  spanStart?: number;
  spanEnd?: number;
  zMin?: number;
  zMax?: number;
  placement?: TakeoffPoint;
  wallProfilePolygons: TakeoffPoint[][];
  panelIds: string[];
};

export type EnvelopeIssue = {
  id: string;
  floorId: string;
  roomId?: string;
  severity: "error" | "warning";
  message: string;
  panelIds: string[];
  kind: "missing-component" | "gap" | "overlap";
};

export type EnvelopePanelEdgeStatus = "matched" | "legal-boundary" | "open";

export type EnvelopePanelEdge = {
  id: string;
  panelId: string;
  floorId: string;
  roomId: string;
  edgeIndex: number;
  start: EnvelopeVec3;
  end: EnvelopeVec3;
  length: number;
  status: EnvelopePanelEdgeStatus;
  reason: string;
  matePanelIds: string[];
};

export type EnvelopeCompilation = {
  panels: EnvelopePanel[];
  edges: EnvelopePanelEdge[];
  issues: EnvelopeIssue[];
  componentDrafts: EnvelopeComponentDraft[];
};

type Segment = {
  a: TakeoffPoint;
  b: TakeoffPoint;
  direction: EnvelopeDirection;
  length: number;
};

type PanelSeed = {
  id: string;
  polygon2d: TakeoffPoint[];
  adjacency: TakeoffWallAdjacency;
  boundary: TakeoffBoundaryType;
  assembly?: string;
  loadState: EnvelopePanelLoadState;
  source: EnvelopePanel["source"];
  reason: string;
};

const directionOptions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
const compilerGeneratedWallSources = new Set<TakeoffRoomComponent["source"]>([
  "exterior-perimeter",
  "wall-gap-fill",
  "conditioned-wall-profile",
]);

export function isEnvelopeCompilerGeneratedWall(component: TakeoffRoomComponent) {
  return component.surface === "wall" && compilerGeneratedWallSources.has(component.source);
}

export function compileEnvelope(project: TakeoffProject): EnvelopeCompilation {
  const panels: EnvelopePanel[] = [];
  for (const floor of project.floors) {
    for (const room of floor.rooms) {
      panels.push(...compileRoomWallPanels(floor, room));
    }
  }
  const edges = buildPanelEdges(panels);
  const componentDrafts = groupPanelsIntoDraftComponents(panels);
  const issues = buildEnvelopeIssues(project, panels, componentDrafts);
  return { panels, edges, issues, componentDrafts };
}

export function envelopePanelsForRoom(compilation: EnvelopeCompilation, floorId: string, roomId: string) {
  return compilation.panels.filter((panel) => panel.floorId === floorId && panel.roomId === roomId);
}

export function envelopeDraftsForRoom(compilation: EnvelopeCompilation, floorId: string, roomId: string) {
  return compilation.componentDrafts.filter((draft) => draft.floorId === floorId && draft.roomId === roomId);
}

function compileRoomWallPanels(floor: TakeoffFloor, room: TakeoffRectRoom): EnvelopePanel[] {
  const panels: EnvelopePanel[] = [];
  for (const segment of roomExteriorSegments(floor, room)) {
    const hostProfile = hostWallProfileForSegment(floor, room, segment);
    if (hostProfile.length < 3 || polygonArea(hostProfile) <= 0.5) continue;
    const seeds = adjacentSpacePanelSeeds(floor, room, segment, hostProfile);
    const occupied = seeds
      .filter((seed) => seed.polygon2d.length >= 3 && polygonArea(seed.polygon2d) > 0.5)
      .map((seed) => pointsToClipPolygon(seed.polygon2d));
    const outsideSeeds = complementPanelSeeds(hostProfile, occupied, segment, room);
    for (const seed of [...seeds, ...outsideSeeds]) {
      const polygon2d = cleanPolygon(seed.polygon2d);
      const area = Number(polygonArea(polygon2d).toFixed(3));
      if (area <= 0.5) continue;
      const { minX, maxX, minY, maxY } = polygonBounds2d(polygon2d);
      const id = stableEnvelopeId([
        "panel",
        floor.id,
        room.id,
        segment.direction,
        seed.adjacency,
        seed.boundary,
        round(minX),
        round(maxX),
        round(minY),
        round(maxY),
      ]);
      panels.push({
        id,
        floorId: floor.id,
        floorName: floor.name,
        roomId: room.id,
        roomName: room.name || "Room",
        surface: "wall",
        direction: segment.direction,
        polygon2d,
        vertices3d: polygon2d.map((point) => wallPlanePointToWorld(segment, point)),
        area,
        spanStart: round(minX),
        spanEnd: round(maxX),
        zMin: round(minY),
        zMax: round(maxY),
        placement: pointAtSegmentDistance(segment, (minX + maxX) / 2),
        adjacency: seed.adjacency,
        boundary: seed.boundary,
        assembly: seed.assembly,
        loadState: seed.loadState,
        source: seed.source,
        reason: seed.reason,
      });
    }
  }
  return panels;
}

function adjacentSpacePanelSeeds(
  floor: TakeoffFloor,
  room: TakeoffRectRoom,
  segment: Segment,
  hostProfile: TakeoffPoint[],
): PanelSeed[] {
  const tolerance = toleranceForFloor(floor);
  const seeds: PanelSeed[] = [];
  for (const space of floor.adjacentSpaces ?? []) {
    const span = adjacentSpaceContactSpan(space, segment, tolerance);
    if (!span || span.length < meaningfulContactLength(segment, tolerance)) continue;
    const adjacency = adjacencyForAdjacentSpace(space);
    if (adjacency === "outside") continue;
    const hostTop = Math.max(...hostProfile.map((point) => point.y));
    const profile = adjacentSpaceWallProfile(space, room, segment, span, hostTop, floor.defaultCeilingHeight ?? 9);
    if (!profile) continue;
    const clipped = clipPanelToHost(profile, hostProfile);
    for (const polygon2d of clipped) {
      seeds.push({
        id: stableEnvelopeId(["seed", floor.id, room.id, space.id, segment.direction, round(span.start), round(span.end)]),
        polygon2d,
        adjacency,
        boundary: boundaryForAdjacency(adjacency),
        assembly: adjacency === "conditioned" ? "NO_LOAD" : defaultWallAssemblyForAdjacency(adjacency),
        loadState: adjacency === "conditioned" ? "no-load" : "load",
        source: "adjacent-space",
        reason: `${space.name || adjacentSpaceLabel(space.kind)} touches this wall span.`,
      });
    }
  }
  return seeds;
}

function complementPanelSeeds(
  hostProfile: TakeoffPoint[],
  occupied: Polygon[],
  segment: Segment,
  room: TakeoffRectRoom,
): PanelSeed[] {
  const remainder = occupied.length > 0
    ? simplePolygonsFromMultiPolygon(difference([pointsToClipPolygon(hostProfile)], ...occupied.map((polygon) => [polygon] as MultiPolygon)))
    : simplePolygonsFromMultiPolygon([pointsToClipPolygon(hostProfile)] as MultiPolygon);
  return remainder.map(({ polygon }) => {
    const polygon2d = clipPolygonToPoints(polygon);
    return {
      id: stableEnvelopeId(["outside", room.id, segment.direction, round(polygonArea(polygon2d))]),
      polygon2d,
      adjacency: "outside" as const,
      boundary: "exterior" as const,
      assembly: defaultWallAssemblyForAdjacency("outside"),
      loadState: "load" as const,
      source: "outside-remainder" as const,
      reason: "Exterior remainder after adjacent-space slices.",
    };
  });
}

function clipPanelToHost(panel: TakeoffPoint[], hostProfile: TakeoffPoint[]) {
  return simplePolygonsFromMultiPolygon(intersection([pointsToClipPolygon(panel)], [pointsToClipPolygon(hostProfile)]))
    .map(({ polygon }) => clipPolygonToPoints(polygon))
    .filter((polygon) => polygon.length >= 3 && polygonArea(polygon) > 0.5);
}

function adjacentSpaceWallProfile(
  space: TakeoffAdjacentSpace,
  room: TakeoffRectRoom,
  segment: Segment,
  span: { start: number; end: number; length: number },
  hostTop: number,
  defaultCeilingHeight: number,
): TakeoffPoint[] | null {
  const adjacency = adjacencyForAdjacentSpace(space);
  if (adjacency === "conditioned") {
    return [
      { x: round(span.start), y: 0 },
      { x: round(span.end), y: 0 },
      { x: round(span.end), y: round(hostTop) },
      { x: round(span.start), y: round(hostTop) },
    ];
  }

  const profile = verticalProfileForAdjacentSpace(space, defaultCeilingHeight);
  const profileRange = verticalProfileRange(profile);
  if (profileRange && space.closedCeilingBelow && ["covered_porch", "garage", "attic"].includes(space.kind)) {
    const zMin = Math.max(0, profileRange.zMin);
    const spanSegment = {
      a: pointAtSegmentDistance(segment, span.start),
      b: pointAtSegmentDistance(segment, span.end),
      direction: segment.direction,
      length: span.length,
    };
    const topPoints = profileTopPointsForSpan(space, room, segment, spanSegment, span, profile, hostTop, defaultCeilingHeight);
    const zMax = Math.max(...topPoints.map((point) => point.y), zMin);
    if (zMax <= zMin + 0.25) return null;
    return cleanPolygon([
      { x: round(span.start), y: round(zMin) },
      { x: round(span.end), y: round(zMin) },
      ...topPoints.slice().reverse(),
    ]);
  }

  return [
    { x: round(span.start), y: 0 },
    { x: round(span.end), y: 0 },
    { x: round(span.end), y: round(hostTop) },
    { x: round(span.start), y: round(hostTop) },
  ];
}

function profileTopPointsForSpan(
  space: TakeoffAdjacentSpace,
  room: TakeoffRectRoom,
  hostSegment: Segment,
  spanSegment: Pick<Segment, "a" | "b">,
  span: { start: number; end: number },
  profile: TakeoffVerticalProfile,
  hostTop: number,
  defaultCeilingHeight: number,
) {
  const adjacentRoom = adjacentSpaceAsRoom(space, defaultCeilingHeight);
  const adjacentBounds = polygonBounds(roomCorners(adjacentRoom));
  const adjacentCeilingInfo = ceilingGeometryInfo(adjacentRoom, defaultCeilingHeight);
  const splitPoints = isVaultCeilingType(adjacentCeilingInfo.ceilingType)
    ? splitEdgeAtVaultRidge(spanSegment, adjacentBounds, adjacentCeilingInfo)
    : [spanSegment.a, spanSegment.b];
  const range = verticalProfileRange(profile);
  const fallbackTop = range?.zMax ?? hostTop;
  return splitPoints.map((point) => {
    const rawTop = isVaultCeilingType(adjacentCeilingInfo.ceilingType)
      ? vaultedRoofHeightAtPoint(point, adjacentBounds, adjacentCeilingInfo)
      : fallbackTop;
    return {
      x: round(distanceAlongSegment(hostSegment, point)),
      y: round(clamp(rawTop, 0, Math.max(hostTop, room.ceilingHeight))),
    };
  }).filter((point) => point.x >= span.start - 0.05 && point.x <= span.end + 0.05);
}

function hostWallProfileForSegment(floor: TakeoffFloor, room: TakeoffRectRoom, segment: Segment) {
  const topPoints = roomWallTopPointsForSegment(room, segment, floor.defaultCeilingHeight ?? 9);
  return cleanPolygon([
    { x: 0, y: 0 },
    { x: round(segment.length), y: 0 },
    ...topPoints.slice().reverse(),
  ]);
}

function roomWallTopPointsForSegment(room: TakeoffRectRoom, segment: Segment, defaultCeilingHeight: number) {
  const ceilingInfo = ceilingGeometryInfo(room, defaultCeilingHeight);
  if (!isVaultCeilingType(ceilingInfo.ceilingType)) {
    return [
      { x: 0, y: round(Math.max(0, room.ceilingHeight || defaultCeilingHeight)) },
      { x: round(segment.length), y: round(Math.max(0, room.ceilingHeight || defaultCeilingHeight)) },
    ];
  }
  const bounds = polygonBounds(roomCorners(room));
  return splitEdgeAtVaultRidge(segment, bounds, ceilingInfo).map((point) => ({
    x: round(distanceAlongSegment(segment, point)),
    y: round(vaultedRoofHeightAtPoint(point, bounds, ceilingInfo)),
  }));
}

function buildPanelEdges(panels: EnvelopePanel[]): EnvelopePanelEdge[] {
  const edgeEntries = panels.flatMap((panel) =>
    panel.vertices3d.map((start, edgeIndex) => {
      const end = panel.vertices3d[(edgeIndex + 1) % panel.vertices3d.length];
      return {
        panel,
        edgeIndex,
        start,
        end,
        profileStart: panel.polygon2d[edgeIndex],
        profileEnd: panel.polygon2d[(edgeIndex + 1) % panel.polygon2d.length],
        key: undirectedEdgeKey(start, end),
      };
    })
  );
  const byKey = new Map<string, typeof edgeEntries>();
  for (const entry of edgeEntries) {
    byKey.set(entry.key, [...(byKey.get(entry.key) ?? []), entry]);
  }

  return edgeEntries.map((entry) => {
    const mates = (byKey.get(entry.key) ?? [])
      .filter((candidate) => candidate.panel.id !== entry.panel.id)
      .map((candidate) => candidate.panel.id);
    const legalBoundary = legalPanelEdgeBoundary(entry.profileStart, entry.profileEnd);
    const status: EnvelopePanelEdgeStatus = mates.length > 0
      ? "matched"
      : legalBoundary
        ? "legal-boundary"
        : "open";
    const reason = mates.length > 0
      ? "Mates to another generated panel edge."
      : legalBoundary || "Open edge awaiting edge-continuity classification.";
    return {
      id: stableEnvelopeId(["edge", entry.panel.id, entry.edgeIndex]),
      panelId: entry.panel.id,
      floorId: entry.panel.floorId,
      roomId: entry.panel.roomId,
      edgeIndex: entry.edgeIndex,
      start: entry.start,
      end: entry.end,
      length: round(distance3d(entry.start, entry.end)),
      status,
      reason,
      matePanelIds: Array.from(new Set(mates)),
    };
  });
}

function legalPanelEdgeBoundary(start: TakeoffPoint | undefined, end: TakeoffPoint | undefined) {
  if (!start || !end) return null;
  const nearBottom = Math.abs(start.y) <= 0.05 && Math.abs(end.y) <= 0.05;
  if (nearBottom) return "Terminates at the floor plate.";
  const profileTopEdge = Math.abs(start.y - end.y) > 0.05 || (start.y > 0.05 && end.y > 0.05);
  if (profileTopEdge) return "Terminates at the room ceiling or roof profile.";
  return null;
}

function undirectedEdgeKey(start: EnvelopeVec3, end: EnvelopeVec3) {
  const first = vecKey(start);
  const second = vecKey(end);
  return first < second ? `${first}|${second}` : `${second}|${first}`;
}

function vecKey(point: EnvelopeVec3) {
  return `${round(point.x)}:${round(point.y)}:${round(point.z)}`;
}

function distance3d(a: EnvelopeVec3, b: EnvelopeVec3) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function groupPanelsIntoDraftComponents(panels: EnvelopePanel[]) {
  const groups = new Map<string, EnvelopeComponentDraft>();
  for (const panel of panels) {
    if (panel.surface !== "wall" || !panel.direction) continue;
    if (panel.loadState === "review" || panel.loadState === "gap") continue;
    const assembly = panel.loadState === "no-load" ? "NO_LOAD" : panel.assembly ?? defaultWallAssemblyForAdjacency(panel.adjacency);
    const key = [
      panel.floorId,
      panel.roomId,
      panel.direction,
      panel.adjacency,
      panel.boundary,
      assembly,
      panel.loadState,
    ].join(":");
    const current = groups.get(key);
    const geometryLabel = `${panel.direction} ${wallAdjacencyLabel(panel.adjacency).toLowerCase()} envelope compiler`;
    if (current) {
      current.area = round(current.area + panel.area);
      current.wallProfilePolygons.push(panel.polygon2d);
      current.panelIds.push(panel.id);
      current.spanStart = Math.min(current.spanStart ?? panel.spanStart ?? 0, panel.spanStart ?? 0);
      current.spanEnd = Math.max(current.spanEnd ?? panel.spanEnd ?? 0, panel.spanEnd ?? 0);
      current.zMin = Math.min(current.zMin ?? panel.zMin ?? 0, panel.zMin ?? 0);
      current.zMax = Math.max(current.zMax ?? panel.zMax ?? 0, panel.zMax ?? 0);
    } else {
      groups.set(key, {
        id: stableEnvelopeId(["draft", key]),
        floorId: panel.floorId,
        roomId: panel.roomId,
        surface: "wall",
        direction: panel.direction,
        assembly,
        adjacency: panel.adjacency,
        boundary: panel.boundary,
        area: panel.area,
        label: `${panel.direction} ${wallAdjacencyLabel(panel.adjacency).toLowerCase()}`,
        geometryLabel,
        loadExempt: panel.loadState === "no-load",
        spanStart: panel.spanStart,
        spanEnd: panel.spanEnd,
        zMin: panel.zMin,
        zMax: panel.zMax,
        placement: panel.placement,
        wallProfilePolygons: [panel.polygon2d],
        panelIds: [panel.id],
      });
    }
  }
  return Array.from(groups.values())
    .map((draft) => ({ ...draft, area: Math.round(draft.area) }))
    .filter((draft) => draft.area > 0);
}

function buildEnvelopeIssues(project: TakeoffProject, panels: EnvelopePanel[], drafts: EnvelopeComponentDraft[]) {
  const issues: EnvelopeIssue[] = [];
  for (const draft of drafts) {
    if (draft.loadExempt) continue;
    const floor = project.floors.find((entry) => entry.id === draft.floorId);
    const room = floor?.rooms.find((entry) => entry.id === draft.roomId);
    if (!floor || !room) continue;
    if (draftComponentCoveredByRoomComponents(room, draft)) continue;
    issues.push({
      id: stableEnvelopeId(["issue", draft.id]),
      floorId: draft.floorId,
      roomId: draft.roomId,
      severity: "warning",
      kind: "missing-component",
      panelIds: draft.panelIds,
      message: `${room.name || "Room"} is missing about ${Math.round(draft.area)} sf of ${wallAdjacencyLabel(draft.adjacency).toLowerCase()} generated by the envelope compiler.`,
    });
  }

  for (const panel of panels.filter((entry) => entry.loadState === "gap")) {
    issues.push({
      id: stableEnvelopeId(["issue", panel.id]),
      floorId: panel.floorId,
      roomId: panel.roomId,
      severity: "warning",
      kind: "gap",
      panelIds: [panel.id],
      message: `${panel.roomName} has an unclassified ${Math.round(panel.area)} sf envelope gap on the ${panel.direction ?? "unknown"} wall.`,
    });
  }
  issues.push(...buildPersistedWallProfileOverlapIssues(project));
  return issues;
}

function buildPersistedWallProfileOverlapIssues(project: TakeoffProject): EnvelopeIssue[] {
  const issues: EnvelopeIssue[] = [];
  const overlapTolerance = 0.1;
  for (const floor of project.floors) {
    for (const room of floor.rooms) {
      const groups = new Map<string, TakeoffRoomComponent[]>();
      for (const component of roomComponents(room)) {
        if (component.surface !== "wall" || !component.direction) continue;
        if (!component.wallProfilePolygons?.some((polygon) => polygon.length >= 3 && polygonArea(polygon) > overlapTolerance)) continue;
        const adjacency = component.adjacency ?? "outside";
        const boundary = component.boundary ?? boundaryForAdjacency(adjacency);
        const key = [component.direction, adjacency, boundary].join(":");
        groups.set(key, [...(groups.get(key) ?? []), component]);
      }
      for (const [key, components] of groups) {
        if (components.length < 2) continue;
        let overlapArea = 0;
        for (let firstIndex = 0; firstIndex < components.length; firstIndex += 1) {
          for (let secondIndex = firstIndex + 1; secondIndex < components.length; secondIndex += 1) {
            overlapArea += wallProfileOverlapArea(components[firstIndex], components[secondIndex]);
          }
        }
        if (overlapArea <= overlapTolerance) continue;
        const [direction, adjacency] = key.split(":");
        issues.push({
          id: stableEnvelopeId(["issue", "persisted-overlap", floor.id, room.id, key, round(overlapArea)]),
          floorId: floor.id,
          roomId: room.id,
          severity: "warning",
          kind: "overlap",
          panelIds: [],
          message: `${room.name || "Room"} has about ${Math.round(overlapArea)} sf of overlapping ${direction} ${wallAdjacencyLabel(adjacency as TakeoffWallAdjacency).toLowerCase()} wall-profile panels. Rebuild generated walls before assigning components.`,
        });
      }
    }
  }
  return issues;
}

function wallProfileOverlapArea(first: TakeoffRoomComponent, second: TakeoffRoomComponent) {
  let overlapArea = 0;
  for (const firstPolygon of first.wallProfilePolygons ?? []) {
    if (firstPolygon.length < 3) continue;
    for (const secondPolygon of second.wallProfilePolygons ?? []) {
      if (secondPolygon.length < 3) continue;
      const clipped = intersection([pointsToClipPolygon(firstPolygon)], [pointsToClipPolygon(secondPolygon)]);
      for (const { area } of simplePolygonsFromMultiPolygon(clipped)) {
        overlapArea += area;
      }
    }
  }
  return overlapArea;
}

function draftComponentCoveredByRoomComponents(room: TakeoffRectRoom, draft: EnvelopeComponentDraft) {
  const matchingArea = roomComponents(room)
    .filter((component) => component.surface === "wall")
    .filter((component) => component.direction === draft.direction)
    .filter((component) => (component.adjacency ?? "outside") === draft.adjacency)
    .filter((component) => (component.boundary ?? boundaryForAdjacency(component.adjacency ?? "outside")) === draft.boundary)
    .reduce((sum, component) => sum + Math.max(0, component.area || 0), 0);
  return matchingArea >= draft.area - Math.max(1, draft.area * 0.08);
}

function roomExteriorSegments(floor: TakeoffFloor, room: TakeoffRectRoom) {
  const exteriorPoints = exteriorRingPoints(floor);
  if (exteriorPoints.length < 3) return [] as Segment[];
  const center = centroid(exteriorPoints);
  const exteriorEdges = pointsToEdges(exteriorPoints);
  const tolerance = toleranceForFloor(floor);
  const segments: Segment[] = [];
  for (const roomEdge of pointsToEdges(roomCorners(room))) {
    for (const exteriorEdge of exteriorEdges) {
      const exposed = sharedSegment(roomEdge, exteriorEdge, tolerance);
      if (!exposed || exposed.length <= 0.25) continue;
      segments.push({
        a: roundPoint(exposed.a),
        b: roundPoint(exposed.b),
        direction: exteriorEdgeDirection(exteriorEdge, exteriorPoints, center, Math.max(0.75, tolerance * 2)),
        length: round(exposed.length),
      });
    }
  }
  return segments;
}

function exteriorRingPoints(floor: TakeoffFloor) {
  if (floor.exteriorPolygon.length >= 3) return floor.exteriorPolygon;
  return rectToPoints({ x: 0, y: 0, width: floor.conditionedPerimeter.width, depth: floor.conditionedPerimeter.depth });
}

function adjacentSpaceContactSpan(space: TakeoffAdjacentSpace, segment: Pick<Segment, "a" | "b">, tolerance: number) {
  return polygonContactSpan(adjacentSpaceCorners(space), segment, tolerance);
}

function polygonContactSpan(points: TakeoffPoint[], segment: Pick<Segment, "a" | "b">, tolerance: number) {
  const ranges: Array<{ start: number; end: number; length: number }> = [];
  for (const edge of pointsToEdges(points)) {
    const shared = sharedSegment(segment, edge, tolerance);
    if (!shared || shared.length <= 0.05) continue;
    const range = projectedSpanRangeOnSegment([shared.a, shared.b], segment);
    if (range) ranges.push(range);
  }
  const corridor = segmentCorridorPolygon(segment, tolerance);
  if (corridor) {
    const overlaps = intersection([corridor], [pointsToClipPolygon(points)]);
    for (const polygon of overlaps) {
      const range = projectedSpanRangeOnSegment(clipRingToPoints(polygon[0] ?? []), segment);
      if (range) ranges.push(range);
    }
  }
  return ranges.sort((a, b) => b.length - a.length)[0] ?? null;
}

function segmentCorridorPolygon(segment: Pick<Segment, "a" | "b">, tolerance: number): Polygon | null {
  const dx = segment.b.x - segment.a.x;
  const dy = segment.b.y - segment.a.y;
  const length = Math.hypot(dx, dy);
  if (length <= 0.001) return null;
  const halfWidth = Math.max(0.15, tolerance);
  const px = -dy / length * halfWidth;
  const py = dx / length * halfWidth;
  return pointsToClipPolygon([
    { x: segment.a.x + px, y: segment.a.y + py },
    { x: segment.b.x + px, y: segment.b.y + py },
    { x: segment.b.x - px, y: segment.b.y - py },
    { x: segment.a.x - px, y: segment.a.y - py },
  ]);
}

function projectedSpanRangeOnSegment(points: TakeoffPoint[], segment: Pick<Segment, "a" | "b">) {
  const dx = segment.b.x - segment.a.x;
  const dy = segment.b.y - segment.a.y;
  const length = Math.hypot(dx, dy);
  if (length <= 0.001 || points.length === 0) return null;
  const ux = dx / length;
  const uy = dy / length;
  const projections = points.map((point) => (point.x - segment.a.x) * ux + (point.y - segment.a.y) * uy);
  const start = Math.max(0, Math.min(...projections));
  const end = Math.min(length, Math.max(...projections));
  if (end - start <= 0.001) return null;
  return { start, end, length: end - start };
}

function meaningfulContactLength(segment: Pick<Segment, "a" | "b">, tolerance: number) {
  const length = distance(segment.a, segment.b);
  return Math.min(Math.max(1.25, tolerance * 2), Math.max(0.35, length * 0.35));
}

function sharedSegment(
  first: Pick<Segment, "a" | "b">,
  second: Pick<Segment, "a" | "b">,
  tolerance: number,
) {
  const dx1 = first.b.x - first.a.x;
  const dy1 = first.b.y - first.a.y;
  const len1 = Math.hypot(dx1, dy1);
  const dx2 = second.b.x - second.a.x;
  const dy2 = second.b.y - second.a.y;
  const len2 = Math.hypot(dx2, dy2);
  if (len1 <= 0.001 || len2 <= 0.001) return null;
  const cross = Math.abs(dx1 * dy2 - dy1 * dx2);
  if (cross > tolerance * Math.max(len1, len2)) return null;
  const distanceToLine = Math.abs((second.a.x - first.a.x) * dy1 - (second.a.y - first.a.y) * dx1) / len1;
  if (distanceToLine > tolerance) return null;
  const ux = dx1 / len1;
  const uy = dy1 / len1;
  const project = (point: TakeoffPoint) => (point.x - first.a.x) * ux + (point.y - first.a.y) * uy;
  const secondA = project(second.a);
  const secondB = project(second.b);
  const overlapStart = Math.max(0, Math.min(secondA, secondB));
  const overlapEnd = Math.min(len1, Math.max(secondA, secondB));
  const length = overlapEnd - overlapStart;
  if (length <= 0) return null;
  return {
    a: { x: first.a.x + ux * overlapStart, y: first.a.y + uy * overlapStart },
    b: { x: first.a.x + ux * overlapEnd, y: first.a.y + uy * overlapEnd },
    length,
  };
}

function exteriorEdgeDirection(
  edge: Pick<Segment, "a" | "b">,
  exteriorPoints: TakeoffPoint[],
  fallbackCenter: TakeoffPoint,
  sampleDistance: number,
): EnvelopeDirection {
  const dx = edge.b.x - edge.a.x;
  const dy = edge.b.y - edge.a.y;
  const length = Math.hypot(dx, dy);
  if (length <= 0.001) return compassFromVector(edge.a.x - fallbackCenter.x, edge.a.y - fallbackCenter.y);
  const midpoint = { x: (edge.a.x + edge.b.x) / 2, y: (edge.a.y + edge.b.y) / 2 };
  const normals = [
    { x: -dy / length, y: dx / length },
    { x: dy / length, y: -dx / length },
  ];
  const outward = normals.find((normal) => !pointInPolygon({
    x: midpoint.x + normal.x * sampleDistance,
    y: midpoint.y + normal.y * sampleDistance,
  }, exteriorPoints));
  if (outward) return compassFromVector(outward.x, outward.y);
  return compassFromVector(midpoint.x - fallbackCenter.x, midpoint.y - fallbackCenter.y);
}

function wallPlanePointToWorld(segment: Pick<Segment, "a" | "b">, point: TakeoffPoint): EnvelopeVec3 {
  const world = pointAtSegmentDistance(segment, point.x);
  return { x: round(world.x), y: round(point.y), z: round(world.y) };
}

function pointAtSegmentDistance(segment: Pick<Segment, "a" | "b">, offset: number): TakeoffPoint {
  const length = Math.max(0.001, distance(segment.a, segment.b));
  const ratio = clamp(offset / length, 0, 1);
  return {
    x: round(segment.a.x + (segment.b.x - segment.a.x) * ratio),
    y: round(segment.a.y + (segment.b.y - segment.a.y) * ratio),
  };
}

function distanceAlongSegment(segment: Pick<Segment, "a" | "b">, point: TakeoffPoint) {
  const dx = segment.b.x - segment.a.x;
  const dy = segment.b.y - segment.a.y;
  const length = Math.max(0.001, Math.hypot(dx, dy));
  return clamp(((point.x - segment.a.x) * dx + (point.y - segment.a.y) * dy) / length, 0, length);
}

function ceilingGeometryInfo(room: TakeoffRectRoom, defaultCeilingHeight: number) {
  const ceilingType = room.ceilingType ?? "flat";
  const lowHeight = isVaultCeilingType(ceilingType)
    ? Math.max(0, room.ceilingLowHeight ?? room.ceilingHeight ?? defaultCeilingHeight)
    : Math.max(0, room.ceilingHeight ?? defaultCeilingHeight);
  const peakHeight = isVaultCeilingType(ceilingType)
    ? Math.max(lowHeight, room.ceilingPeakHeight ?? lowHeight)
    : lowHeight;
  const ridgeDirection = room.ceilingRidgeDirection ?? "E-W";
  const bounds = polygonBounds(roomCorners(room));
  const crossSpan = ridgeDirection === "E-W" ? bounds.depth : bounds.width;
  const ridgeOffset = clamp(room.ceilingRidgeOffset ?? 0, -1, 1);
  const ridgeRatio = (ridgeOffset + 1) / 2;
  const requestedFlatPeakWidth = ceilingType === "vault_flat_peak" ? Math.max(0, room.ceilingFlatPeakWidth ?? 4) : 0;
  const ridgePosition = crossSpan * ridgeRatio;
  const flatStart = clamp(ridgePosition - requestedFlatPeakWidth / 2, 0, crossSpan);
  const flatEnd = clamp(ridgePosition + requestedFlatPeakWidth / 2, 0, crossSpan);
  return {
    ceilingType,
    lowHeight,
    peakHeight,
    ridgeDirection,
    ridgeRatio,
    firstRun: flatStart,
    secondRun: crossSpan - flatEnd,
    flatPeakWidth: Math.max(0, flatEnd - flatStart),
  };
}

function isVaultCeilingType(value: TakeoffRectRoom["ceilingType"] | undefined) {
  return value === "vaulted" || value === "vault_flat_peak";
}

function vaultedRoofHeightAtPoint(
  point: TakeoffPoint,
  bounds: ReturnType<typeof polygonBounds>,
  ceilingInfo: ReturnType<typeof ceilingGeometryInfo>,
) {
  const peakDelta = Math.max(0, ceilingInfo.peakHeight - ceilingInfo.lowHeight);
  if (peakDelta <= 0) return ceilingInfo.lowHeight;
  const minCoord = ceilingInfo.ridgeDirection === "E-W" ? bounds.y : bounds.x;
  const maxCoord = ceilingInfo.ridgeDirection === "E-W" ? bounds.y + bounds.depth : bounds.x + bounds.width;
  const coord = ceilingInfo.ridgeDirection === "E-W" ? point.y : point.x;
  const flatStartCoord = minCoord + ceilingInfo.firstRun;
  const flatEndCoord = maxCoord - ceilingInfo.secondRun;
  if (ceilingInfo.flatPeakWidth > 0.01 && coord >= flatStartCoord && coord <= flatEndCoord) return ceilingInfo.peakHeight;
  const run = coord <= flatStartCoord ? ceilingInfo.firstRun : ceilingInfo.secondRun;
  if (run <= 0.01) return ceilingInfo.peakHeight;
  const ratio = coord <= flatStartCoord
    ? (coord - minCoord) / run
    : (maxCoord - coord) / run;
  return ceilingInfo.lowHeight + peakDelta * clamp(ratio, 0, 1);
}

function splitEdgeAtVaultRidge(
  edge: Pick<Segment, "a" | "b">,
  bounds: ReturnType<typeof polygonBounds>,
  ceilingInfo: ReturnType<typeof ceilingGeometryInfo>,
) {
  const aCoord = ceilingInfo.ridgeDirection === "E-W" ? edge.a.y : edge.a.x;
  const bCoord = ceilingInfo.ridgeDirection === "E-W" ? edge.b.y : edge.b.x;
  if (Math.abs(aCoord - bCoord) <= 0.001) return [edge.a, edge.b];
  const crossMin = ceilingInfo.ridgeDirection === "E-W" ? bounds.y : bounds.x;
  const crossMax = ceilingInfo.ridgeDirection === "E-W" ? bounds.y + bounds.depth : bounds.x + bounds.width;
  const breakCoords = ceilingInfo.flatPeakWidth > 0.01
    ? [crossMin + ceilingInfo.firstRun, crossMax - ceilingInfo.secondRun]
    : [crossMin + (crossMax - crossMin) * ceilingInfo.ridgeRatio];
  return [
    edge.a,
    ...breakCoords
      .filter((coord) => (coord - aCoord) * (coord - bCoord) < 0)
      .map((coord) => {
        const ratio = (coord - aCoord) / (bCoord - aCoord);
        return {
          x: edge.a.x + (edge.b.x - edge.a.x) * ratio,
          y: edge.a.y + (edge.b.y - edge.a.y) * ratio,
        };
      }),
    edge.b,
  ];
}

function adjacentSpaceAsRoom(space: TakeoffAdjacentSpace, defaultCeilingHeight: number): TakeoffRectRoom {
  const profileRange = verticalProfileRange(space.verticalProfile);
  const ceilingHeight = space.ceilingHeight ?? profileRange?.zMin ?? defaultCeilingHeight;
  const peakHeight = Math.max(ceilingHeight, space.ceilingPeakHeight ?? profileRange?.zMax ?? ceilingHeight);
  return {
    id: space.id,
    name: space.name,
    x: space.x,
    y: space.y,
    width: space.width,
    depth: space.depth,
    polygon: space.polygon,
    ceilingHeight,
    ceilingType: space.ceilingType ?? (space.verticalProfile?.kind === "gable" ? "vaulted" : "flat"),
    ceilingLowHeight: ceilingHeight,
    ceilingPeakHeight: peakHeight,
    ceilingRidgeDirection: space.ceilingRidgeDirection ?? (space.verticalProfile?.kind === "gable" ? space.verticalProfile.ridgeDirection : "E-W"),
    ceilingRidgeOffset: space.ceilingRidgeOffset ?? (space.verticalProfile?.kind === "gable" ? space.verticalProfile.ridgeOffset ?? 0 : 0),
    ceilingFlatPeakWidth: space.ceilingFlatPeakWidth,
    components: [],
  };
}

function verticalProfileForAdjacentSpace(space: TakeoffAdjacentSpace, defaultCeilingHeight: number): TakeoffVerticalProfile {
  if (space.verticalProfile) return space.verticalProfile;
  const ceilingType = space.ceilingType ?? "flat";
  const ceilingHeight = space.ceilingHeight ?? defaultCeilingHeight;
  if (isVaultCeilingType(ceilingType)) {
    const peakHeight = Math.max(ceilingHeight, space.ceilingPeakHeight ?? ceilingHeight + 1);
    return {
      kind: "gable",
      zMin: ceilingHeight,
      lowHeight: ceilingHeight,
      peakHeight,
      ridgeDirection: space.ceilingRidgeDirection ?? "E-W",
      ridgeOffset: space.ceilingRidgeOffset ?? 0,
    };
  }
  return { kind: "flat", zMin: ceilingHeight, zMax: ceilingHeight };
}

function verticalProfileRange(profile: TakeoffVerticalProfile | undefined) {
  if (!profile || profile.kind === "none" || profile.kind === "unknown") return null;
  if (profile.kind === "flat") return { zMin: profile.zMin, zMax: profile.zMax };
  if (profile.kind === "shed") return { zMin: profile.zMin, zMax: Math.max(profile.lowHeight, profile.highHeight) };
  if (profile.kind === "gable") return { zMin: profile.zMin, zMax: profile.peakHeight };
  return null;
}

function adjacencyForAdjacentSpace(space: TakeoffAdjacentSpace): TakeoffWallAdjacency {
  if (space.boundaryIntent) return space.boundaryIntent;
  if (space.kind === "garage") return "garage";
  if (space.kind === "attic" || space.kind === "covered_porch") return "attic";
  if (space.kind === "crawl") return "crawlspace";
  if (space.kind === "conditioned_addition") return "conditioned";
  return "outside";
}

function defaultWallAssemblyForAdjacency(adjacency: TakeoffWallAdjacency) {
  if (adjacency === "attic") return "W3";
  if (adjacency === "crawlspace" || adjacency === "conditioned") return "W2";
  return "W1";
}

function boundaryForAdjacency(adjacency: TakeoffWallAdjacency): TakeoffBoundaryType {
  if (adjacency === "attic") return "attic_knee_wall";
  if (adjacency === "garage") return "garage_wall";
  if (adjacency === "crawlspace") return "crawlspace_wall";
  if (adjacency === "conditioned") return "partition";
  if (adjacency === "outside") return "exterior";
  return "unknown";
}

function wallAdjacencyLabel(adjacency: TakeoffWallAdjacency) {
  const labels: Record<TakeoffWallAdjacency, string> = {
    outside: "Exterior wall",
    attic: "Attic wall",
    garage: "Garage wall",
    crawlspace: "Crawlspace wall",
    conditioned: "Conditioned partition",
    unknown: "Unknown adjacent wall",
  };
  return labels[adjacency];
}

function adjacentSpaceLabel(kind: TakeoffAdjacentSpaceKind) {
  const labels: Record<TakeoffAdjacentSpaceKind, string> = {
    garage: "Garage",
    attic: "Attic",
    crawl: "Crawlspace",
    covered_porch: "Covered porch",
    conditioned_addition: "Conditioned space",
    exterior: "Exterior",
  };
  return labels[kind];
}

function roomComponents(room: TakeoffRectRoom) {
  return room.components ?? [];
}

function roomCorners(room: TakeoffRectRoom): TakeoffPoint[] {
  if (room.polygon && room.polygon.length >= 3) return room.polygon;
  return rectToPoints({ x: room.x, y: room.y, width: room.width, depth: room.depth });
}

function adjacentSpaceCorners(space: TakeoffAdjacentSpace): TakeoffPoint[] {
  if (space.polygon && space.polygon.length >= 3) return space.polygon;
  return rectToPoints({ x: space.x, y: space.y, width: space.width, depth: space.depth });
}

function rectToPoints(rect: { x: number; y: number; width: number; depth: number }): TakeoffPoint[] {
  return [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.depth },
    { x: rect.x, y: rect.y + rect.depth },
  ];
}

function pointsToEdges(points: TakeoffPoint[]) {
  return points
    .map((point, index) => ({ a: point, b: points[(index + 1) % points.length] }))
    .filter(({ a, b }) => distance(a, b) > 0.001);
}

function pointsToClipPolygon(points: TakeoffPoint[]): Polygon {
  return [closeRing(points)];
}

function closeRing(points: TakeoffPoint[]): Ring {
  const ring = points.map((point) => [point.x, point.y] as [number, number]);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) ring.push(first);
  return ring;
}

function clipPolygonToPoints(polygon: Polygon) {
  const ring = polygon[0] ?? [];
  return clipRingToPoints(ring);
}

function clipRingToPoints(ring: Ring) {
  return ring.slice(0, -1).map(([x, y]) => ({ x: round(x), y: round(y) }));
}

function clipPolygonArea(polygon: Polygon) {
  const [outer, ...holes] = polygon;
  const outerArea = outer ? polygonArea(clipRingToPoints(outer)) : 0;
  const holeArea = holes.reduce((sum, ring) => sum + polygonArea(clipRingToPoints(ring)), 0);
  return Math.max(0, outerArea - holeArea);
}

function simplePolygonsFromMultiPolygon(multiPolygon: MultiPolygon) {
  const pieces = multiPolygon
    .flatMap(simplePolygonsFromClipPolygon)
    .map((polygon) => ({ polygon, area: clipPolygonArea(polygon) }))
    .filter((entry) => entry.area > 0.5 && entry.polygon.length >= 1)
    .sort((a, b) => b.area - a.area);
  return mergeConnectedSimplePolygons(pieces);
}

function simplePolygonsFromClipPolygon(polygon: Polygon) {
  if (polygon.length <= 1) return clipPolygonArea(polygon) > 0.5 ? [polygon] : [];
  const [outer, ...holes] = polygon;
  if (!outer) return [];
  const outerPoints = clipRingToPoints(outer);
  const holePoints = holes.map(clipRingToPoints);
  const outerBounds = polygonBounds(outerPoints);
  const xCuts = new Set([outerBounds.x, outerBounds.x + outerBounds.width]);
  const yCuts = new Set([outerBounds.y, outerBounds.y + outerBounds.depth]);

  for (const hole of holes) {
    const bounds = polygonBounds(clipRingToPoints(hole));
    xCuts.add(bounds.x);
    xCuts.add(bounds.x + bounds.width);
    yCuts.add(bounds.y);
    yCuts.add(bounds.y + bounds.depth);
  }

  const xs = Array.from(xCuts).sort((a, b) => a - b);
  const ys = Array.from(yCuts).sort((a, b) => a - b);
  const pieces: Polygon[] = [];

  for (let xIndex = 0; xIndex < xs.length - 1; xIndex += 1) {
    for (let yIndex = 0; yIndex < ys.length - 1; yIndex += 1) {
      const rect = {
        x: xs[xIndex],
        y: ys[yIndex],
        width: xs[xIndex + 1] - xs[xIndex],
        depth: ys[yIndex + 1] - ys[yIndex],
      };
      if (rect.width < 0.25 || rect.depth < 0.25) continue;
      const center = { x: rect.x + rect.width / 2, y: rect.y + rect.depth / 2 };
      if (!pointInPolygon(center, outerPoints)) continue;
      if (holePoints.some((hole) => pointInPolygon(center, hole))) continue;
      const candidate = pointsToClipPolygon(rectToPoints(rect));
      const clipped = intersection([candidate], [polygon]);
      for (const clippedPolygon of clipped) {
        if (clippedPolygon.length === 1 && clipPolygonArea(clippedPolygon) > 0.5) pieces.push(clippedPolygon);
      }
    }
  }

  return pieces;
}

function polygonsShareBoundary(first: Polygon, second: Polygon) {
  const firstEdges = pointsToEdges(clipPolygonToPoints(first));
  const secondEdges = pointsToEdges(clipPolygonToPoints(second));
  return firstEdges.some((firstEdge) =>
    secondEdges.some((secondEdge) => (sharedSegment(firstEdge, secondEdge, 0.18)?.length ?? 0) > 0.05)
  );
}

function mergeConnectedSimplePolygons(entries: Array<{ polygon: Polygon; area: number }>) {
  const remaining = new Set(entries.map((_, index) => index));
  const mergedEntries: Array<{ polygon: Polygon; area: number }> = [];

  while (remaining.size > 0) {
    const firstIndex = remaining.values().next().value as number;
    const queue = [firstIndex];
    const group: Array<{ polygon: Polygon; area: number }> = [];
    remaining.delete(firstIndex);

    while (queue.length > 0) {
      const currentIndex = queue.shift()!;
      const current = entries[currentIndex];
      group.push(current);
      for (const candidateIndex of Array.from(remaining)) {
        if (!group.some((groupEntry) => polygonsShareBoundary(groupEntry.polygon, entries[candidateIndex].polygon))) continue;
        remaining.delete(candidateIndex);
        queue.push(candidateIndex);
      }
    }

    const [firstPolygon, ...remainingPolygons] = group.map((entry) => entry.polygon);
    const merged = union(firstPolygon, ...remainingPolygons);
    const simpleMerged = merged
      .filter((polygon) => polygon.length === 1)
      .map((polygon) => ({ polygon, area: clipPolygonArea(polygon) }))
      .filter((entry) => entry.area > 0.5);

    if (simpleMerged.length > 0 && simpleMerged.reduce((sum, entry) => sum + entry.area, 0) >= group.reduce((sum, entry) => sum + entry.area, 0) - 0.5) {
      mergedEntries.push(...simpleMerged);
    } else {
      mergedEntries.push(...group);
    }
  }

  return mergedEntries.sort((a, b) => b.area - a.area);
}

function cleanPolygon(points: TakeoffPoint[]) {
  const cleaned = points
    .map(roundPoint)
    .filter((point, index, all) => {
      if (index === 0) return true;
      const previous = all[index - 1];
      return distance(point, previous) > 0.01;
    });
  if (cleaned.length > 2 && distance(cleaned[0], cleaned[cleaned.length - 1]) <= 0.01) cleaned.pop();
  return cleaned;
}

function polygonArea(points: TakeoffPoint[]) {
  if (points.length < 3) return 0;
  const sum = points.reduce((total, point, index) => {
    const next = points[(index + 1) % points.length];
    return total + point.x * next.y - next.x * point.y;
  }, 0);
  return Math.abs(sum) / 2;
}

function polygonBounds(points: TakeoffPoint[]) {
  if (points.length === 0) return { x: 0, y: 0, width: 0, depth: 0 };
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return { x: minX, y: minY, width: maxX - minX, depth: maxY - minY };
}

function polygonBounds2d(points: TakeoffPoint[]) {
  const bounds = polygonBounds(points);
  return {
    minX: bounds.x,
    maxX: bounds.x + bounds.width,
    minY: bounds.y,
    maxY: bounds.y + bounds.depth,
  };
}

function pointInPolygon(point: TakeoffPoint, polygon: TakeoffPoint[]) {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const pi = polygon[i];
    const pj = polygon[j];
    const intersects = pi.y > point.y !== pj.y > point.y && point.x < ((pj.x - pi.x) * (point.y - pi.y)) / (pj.y - pi.y) + pi.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function centroid(points: TakeoffPoint[]) {
  if (points.length === 0) return { x: 0, y: 0 };
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
}

function compassFromVector(dx: number, dy: number): EnvelopeDirection {
  const angle = Math.atan2(dy, dx) * 180 / Math.PI;
  const normalized = (angle + 360) % 360;
  if (normalized >= 337.5 || normalized < 22.5) return "E";
  if (normalized < 67.5) return "SE";
  if (normalized < 112.5) return "S";
  if (normalized < 157.5) return "SW";
  if (normalized < 202.5) return "W";
  if (normalized < 247.5) return "NW";
  if (normalized < 292.5) return "N";
  return "NE";
}

function distance(a: TakeoffPoint, b: TakeoffPoint) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function toleranceForFloor(floor: TakeoffFloor) {
  return Math.max(0.35, floor.scale.feetPerGrid * 0.35);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function round(value: number) {
  return Number(value.toFixed(3));
}

function roundPoint(point: TakeoffPoint) {
  return { x: round(point.x), y: round(point.y) };
}

function stableEnvelopeId(parts: unknown[]) {
  return parts
    .map((part) => String(part ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, "-"))
    .filter(Boolean)
    .join(":");
}
