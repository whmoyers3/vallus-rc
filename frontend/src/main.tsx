import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type AssemblyRow = { code: string; u_value: number; shgc: number | null; label: string };
type TypeCategory = "Wall" | "Glass" | "Ceiling" | "Floor" | "Door";
type CompassDirection = "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";
type RelativeFacing = "FRONT" | "FRONT_LEFT" | "FRONT_RIGHT" | "LEFT" | "RIGHT" | "REAR" | "REAR_RIGHT" | "REAR_LEFT";
type UnitDraft = { id: string; name: string; selected_tons?: number; selected_kw?: number };
type ZoneDraft = { id: string; name: string; unit_id: string };
type TypeDefinition = { code: string; category: TypeCategory; u_value?: number; shgc?: number | null; description?: string };
type LightingBasis = "Floor" | "Ceiling";
type RoomDraft = { name: string; floor_area?: number; ceiling_height?: number; volume?: number; lighting_basis?: LightingBasis; lighting_area?: number; unit_id?: string; zone_id?: string };
type ComponentKind = "opaque" | "glass" | "internal_people" | "internal_watts";

type ComponentDraft = {
  id: string;
  name: string;
  kind: ComponentKind;
  category?: TypeCategory | "Person" | "Appliance";
  room_name?: string;
  assembly?: string;
  direction?: string;
  area?: number;
  volume?: number;
  cooling_cltd?: number;
  heating_delta_t?: number;
  quantity?: number;
  watts?: number;
};

type ProjectDraft = {
  name: string;
  location: string;
  description: string;
  outdoor_cooling_db: number;
  outdoor_heating_db: number;
  indoor_cooling_db: number;
  indoor_heating_db: number;
  ach50: number;
  bedrooms: number;
  seer: number;
  front_door_faces: CompassDirection;
  selected_system_tons: number;
  selected_system_kw: number;
  units: UnitDraft[];
  zones: ZoneDraft[];
  type_definitions: TypeDefinition[];
  level: {
    name: string;
    floor_area: number;
    volume: number;
    selected_tons: number;
    selected_kw: number;
    cooling_cfm_divisor: number;
    heating_cfm_divisor: number;
    auto_lighting_w_per_sf: number;
    auto_infiltration: boolean;
  };
  rooms: RoomDraft[];
  components: ComponentDraft[];
  assemblies?: Record<string, { code: string; u_value?: number; shgc?: number | null; description?: string }>;
  comparison?: Record<string, any>;
};

type RoomLoadResult = {
  name: string;
  cooling_btuh: number;
  heating_btuh: number;
  cfm_cool: number;
  cfm_heat: number;
  cfm_avg: number;
};

type Loads = {
  whole_house_sensible_cooling: number;
  whole_house_heating: number;
  system_tons: number;
  system_kw: number;
  system_cfm: number;
  units: Array<{
    id: string;
    name: string;
    cooling_subtotal: number;
    heating_subtotal: number;
    sensible_cooling: number;
    heating: number;
    tons_min: number;
    recommended_tons: number;
    kw_min: number;
  }>;
  levels: Array<{
    name: string;
    cooling_subtotal: number;
    heating_subtotal: number;
    cooling_load: number;
    heat_loss: number;
    rooms: RoomLoadResult[];
  }>;
};

type UnitLoadSummary = {
  unit: UnitDraft;
  rooms: Array<{ draft: RoomDraft; result: RoomLoadResult }>;
  floorArea: number;
  coolingSubtotal: number;
  heatingSubtotal: number;
  sensibleCooling: number;
  heatLoss: number;
  tonsMin: number;
  kwMin: number;
  cfm: number;
  coolingLat?: number;
  heatingLat?: number;
};

type FixturePayload = { project: Record<string, any> };
type MarkdownImportResponse = { payload: FixturePayload; warnings: string[] };
type WorstCaseResult = { front_door_faces: CompassDirection; loads: Loads };
type SavedProject = { id: number; name: string; location: string; description: string; created_at: string; updated_at: string };
type SaveConflict = {
  conflictProject: SavedProject;   // the existing project that shares this name+description
  payload: Record<string, unknown>; // fully built payload, ready to POST/PUT
  project: ProjectDraft;           // draft used to calculate the payload
  nextVersionDescription: string;  // pre-computed "Description v.2" (or v.3, etc.)
};

const compassDirections: CompassDirection[] = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const standardTons = [1.5, 2, 2.5, 3, 3.5, 4, 5];
const relativeFacingOffsets: Record<RelativeFacing, number> = {
  FRONT: 0,
  FRONT_LEFT: 1,
  FRONT_RIGHT: -1,
  LEFT: 2,
  RIGHT: -2,
  REAR: 4,
  REAR_RIGHT: -3,
  REAR_LEFT: 3,
};
const relativeFacingLabels: Record<RelativeFacing, string> = {
  FRONT: "Front",
  FRONT_LEFT: "Front Left",
  FRONT_RIGHT: "Front Right",
  LEFT: "Left",
  RIGHT: "Right",
  REAR: "Rear",
  REAR_RIGHT: "Rear Right",
  REAR_LEFT: "Rear Left",
};
const relativeFacings = Object.keys(relativeFacingOffsets) as RelativeFacing[];
const compassArrows: Record<CompassDirection, string> = {
  N: "↑",
  NE: "↗",
  E: "→",
  SE: "↘",
  S: "↓",
  SW: "↙",
  W: "←",
  NW: "↖",
};
const typeCategories: TypeCategory[] = ["Wall", "Door", "Ceiling", "Floor", "Glass"];
const defaultUnitId = "unit-whole-house";
const defaultTypeDefinitions: TypeDefinition[] = [
  { code: "W1", category: "Wall", u_value: 0.077, shgc: null, description: "Above Grade    2x4    R-13 batt" },
  { code: "W2", category: "Wall", u_value: 0.067, shgc: null, description: "Basement    Concrete + 2x4    R-13 batt" },
  { code: "W3", category: "Wall", u_value: 0.053, shgc: null, description: "Attic    2x6    R-19 batt" },
  { code: "D1", category: "Door", u_value: 0.5, shgc: null, description: "Exterior Door    R-2" },
  { code: "D2", category: "Door", u_value: 0.37, shgc: null, description: "Garage Door    R-2.7" },
  { code: "C1", category: "Ceiling", u_value: 0.033, shgc: null, description: "Flat Ceiling    R-30 blown" },
  { code: "C2", category: "Ceiling", u_value: 0.033, shgc: null, description: "Vaulted    R-30 batt" },
  { code: "F1", category: "Floor", u_value: 0.053, shgc: null, description: "Framed    R-19 batt" },
  { code: "F2", category: "Floor", u_value: 0.1, shgc: null, description: "Slab    None" },
  { code: "G1", category: "Glass", u_value: 0.32, shgc: 0.22, description: "Double Insulated    All types    Blinds/Draperies" },
  { code: "G2", category: "Glass", u_value: undefined, shgc: undefined, description: "" },
  { code: "G3", category: "Glass", u_value: undefined, shgc: undefined, description: "" },
];

const initialProject: ProjectDraft = {
  name: "Manual One Room Test",
  location: "Braselton, GA",
  description: "Editable component input smoke test",
  outdoor_cooling_db: 95,
  outdoor_heating_db: 18,
  indoor_cooling_db: 75,
  indoor_heating_db: 72,
  ach50: 5,
  bedrooms: 1,
  seer: 14,
  front_door_faces: "S",
  selected_system_tons: 1,
  selected_system_kw: 5,
  units: [{ id: defaultUnitId, name: "Whole House", selected_tons: 1, selected_kw: 5 }],
  zones: [],
  type_definitions: defaultTypeDefinitions,
  level: {
    name: "First Floor",
    floor_area: 120,
    volume: 1000,
    selected_tons: 1,
    selected_kw: 5,
    cooling_cfm_divisor: 18.1,
    heating_cfm_divisor: 20.2,
    auto_lighting_w_per_sf: 0.5,
    auto_infiltration: true
  },
  rooms: [{ name: "Test Room", floor_area: 120, ceiling_height: 8.33, volume: 1000, lighting_basis: "Floor", unit_id: defaultUnitId }],
  components: [
    {
      id: "wall-1",
      name: "South wall",
      kind: "opaque",
      category: "Wall",
      room_name: "Test Room",
      assembly: "W1",
      direction: "RIGHT",
      area: 100
    },
    {
      id: "glass-1",
      name: "West window",
      kind: "glass",
      category: "Glass",
      room_name: "Test Room",
      assembly: "G1",
      direction: "RIGHT",
      area: 20
    },
  ]
};

function number(value: number): string {
  return Math.round(value).toLocaleString();
}

function decimal(value: number, places = 1): string {
  return value.toFixed(places);
}

function formatInputNumber(value: number | undefined): string {
  if (value === undefined) return "";
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}

function inputNumber(value: number | undefined): string {
  return formatInputNumber(value);
}

function toNumber(value: string): number | undefined {
  if (value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function compactTypeDescription(description: string | undefined): string {
  return (description ?? "").replace(/\s+/g, " ").trim();
}

function typeOptionLabel(definition: TypeDefinition): string {
  const description = compactTypeDescription(definition.description);
  if (!description) return definition.code;
  const truncated = description.length > 34 ? `${description.slice(0, 31)}...` : description;
  return `${definition.code} - ${truncated}`;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(/,/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function comparisonNumber(value: unknown): string {
  const parsed = finiteNumber(value);
  return parsed === undefined ? "-" : number(parsed);
}

function comparisonDecimal(value: unknown, places = 1): string {
  const parsed = finiteNumber(value);
  return parsed === undefined ? "-" : decimal(parsed, places);
}

function comparisonDelta(model: number | undefined, reference: unknown): string {
  const parsedReference = finiteNumber(reference);
  if (model === undefined || parsedReference === undefined) return "-";
  const delta = Math.round(model - parsedReference);
  return `${delta > 0 ? "+" : ""}${delta.toLocaleString()}`;
}

function roomVolume(room: RoomDraft): number {
  if (room.floor_area !== undefined && room.ceiling_height !== undefined) {
    return room.floor_area * room.ceiling_height;
  }
  return room.volume ?? 0;
}

function roomBasisArea(room: RoomDraft, components: ComponentDraft[]): number | undefined {
  const basis = room.lighting_basis ?? "Floor";
  const matchingArea = components
    .filter((component) => component.room_name === room.name && component.category === basis)
    .reduce((sum, component) => sum + (component.area ?? 0), 0);
  return matchingArea || room.floor_area;
}

function isRelativeFacing(value: string | undefined): value is RelativeFacing {
  return !!value && relativeFacings.includes(value as RelativeFacing);
}

function resolveComponentDirection(direction: string | undefined, front: CompassDirection): string | undefined {
  if (!direction) return undefined;
  if (isRelativeFacing(direction)) return offsetDirection(front, relativeFacingOffsets[direction]);
  return direction;
}

function relativeFacingFromCompass(direction: string | undefined, front: CompassDirection): string | undefined {
  if (!isCompassDirection(direction)) return direction;
  const frontIndex = compassDirections.indexOf(front);
  const directionIndex = compassDirections.indexOf(direction);
  const clockwiseOffset = (directionIndex - frontIndex + compassDirections.length) % compassDirections.length;
  const signedOffset = clockwiseOffset > 4 ? clockwiseOffset - compassDirections.length : clockwiseOffset;
  const match = relativeFacings.find((facing) => relativeFacingOffsets[facing] === signedOffset);
  return match ?? direction;
}

function translatedComponents(project: ProjectDraft): ComponentDraft[] {
  return project.components.map((component) => ({
    ...component,
    direction: resolveComponentDirection(component.direction, project.front_door_faces),
  }));
}

function buildPayload(project: ProjectDraft, assemblies: AssemblyRow[]) {
  const components = translatedComponents(project);
  const rooms = project.rooms.map((room) => ({
    ...room,
    floor_area: roomBasisArea(room, project.components) ?? 0,
    lighting_area: roomBasisArea(room, project.components) ?? 0,
    volume: roomVolume({ ...room, floor_area: roomBasisArea(room, project.components) }),
  }));
  const levelVolume = rooms.reduce((sum, room) => sum + room.volume, 0);
  const selectedSystemTons = project.units.reduce((sum, unit) => sum + Number(unit.selected_tons ?? 0), 0);
  const selectedSystemKw = project.units.reduce((sum, unit) => sum + Number(unit.selected_kw ?? 0), 0);
  const fallbackAssemblyMap = Object.fromEntries(
    assemblies.map((assembly) => [
      assembly.code,
      {
        code: assembly.code,
        u_value: assembly.u_value,
        shgc: assembly.shgc,
        description: assembly.label
      }
    ])
  );
  const assemblyMap = Object.fromEntries(
    project.type_definitions
      .filter((definition) => definition.code.trim())
      .map((definition) => [
        definition.code.trim(),
        {
          code: definition.code.trim(),
          u_value: definition.u_value,
          shgc: definition.category === "Glass" ? definition.shgc ?? null : null,
          description: definition.description ?? definition.category
        }
      ])
  );
  return {
    project: {
      name: project.name,
      location: project.location,
      description: project.description,
      design_conditions: {
        outdoor_cooling_db: project.outdoor_cooling_db,
        outdoor_heating_db: project.outdoor_heating_db,
        indoor_cooling_db: project.indoor_cooling_db,
        indoor_heating_db: project.indoor_heating_db,
        slab_delta_t: 27
      },
      infiltration: { mode: "standard_ach" },
      metadata: {
        ach50: project.ach50,
        bedrooms: project.bedrooms,
        seer: project.seer,
        front_door_faces: project.front_door_faces,
        units: project.units,
        zones: project.zones,
        ...(project.comparison ? { salas_obrien_comparison: project.comparison } : {})
      },
      selected_system_tons: selectedSystemTons,
      selected_system_kw: selectedSystemKw,
      assemblies: Object.keys(assemblyMap).length ? assemblyMap : (project.assemblies ?? fallbackAssemblyMap),
      levels: [
        {
          ...project.level,
          selected_tons: selectedSystemTons,
          selected_kw: selectedSystemKw,
          volume: levelVolume || project.level.volume,
          rooms,
          line_items: components.map(({ id: _id, ...component }) => component)
        }
      ]
    }
  };
}

function draftFromPayload(payload: FixturePayload): ProjectDraft {
  const project = payload.project;
  const level = project.levels[0];
  const metadata = "metadata" in project ? project.metadata as { ach50?: number; bedrooms?: number; seer?: number; front_door_faces?: CompassDirection; units?: UnitDraft[]; zones?: ZoneDraft[]; salas_obrien_comparison?: Record<string, any> } : {};
  const rawUnits = metadata.units?.length ? metadata.units : [{ id: defaultUnitId, name: "Whole House" }];
  const units = rawUnits.map((unit, index) => ({
    ...unit,
    selected_tons: unit.selected_tons ?? (index === 0 ? project.selected_system_tons : 0),
    selected_kw: unit.selected_kw ?? (index === 0 ? project.selected_system_kw : 0),
  }));
  const zones = (metadata.zones ?? []).filter((zone) => zone.id !== "zone-whole-house");
  const typeDefinitions = Object.values(project.assemblies ?? {}).map((rawAssembly) => {
    const assembly = rawAssembly as { code: string; u_value?: number; shgc?: number | null; description?: string };
    return {
      code: assembly.code,
      category: assembly.shgc ? "Glass" as TypeCategory : codeCategory(assembly.code),
      u_value: assembly.u_value,
      shgc: assembly.shgc,
      description: assembly.description
    };
  });
  return {
    name: project.name,
    location: project.location,
    description: project.description,
    outdoor_cooling_db: project.design_conditions.outdoor_cooling_db,
    outdoor_heating_db: project.design_conditions.outdoor_heating_db,
    indoor_cooling_db: project.design_conditions.indoor_cooling_db,
    indoor_heating_db: project.design_conditions.indoor_heating_db,
    ach50: Number(metadata.ach50 ?? 5),
    bedrooms: Number(metadata.bedrooms ?? 3),
    seer: Number(metadata.seer ?? 14),
    front_door_faces: metadata.front_door_faces ?? "S",
    selected_system_tons: project.selected_system_tons,
    selected_system_kw: project.selected_system_kw,
    units,
    zones,
    type_definitions: typeDefinitions.length ? typeDefinitions : defaultTypeDefinitions,
    assemblies: project.assemblies,
    level: {
      name: level.name,
      floor_area: level.floor_area,
      volume: level.volume,
      selected_tons: level.selected_tons,
      selected_kw: level.selected_kw,
      cooling_cfm_divisor: level.cooling_cfm_divisor,
      heating_cfm_divisor: level.heating_cfm_divisor,
      auto_lighting_w_per_sf: level.auto_lighting_w_per_sf ?? 0.5,
      auto_infiltration: level.auto_infiltration ?? true
    },
    rooms: level.rooms.map((rawRoom: RoomDraft) => {
      const room = rawRoom as RoomDraft;
      const ceilingHeight = room.ceiling_height ?? (
        room.floor_area && room.volume ? Number((room.volume / room.floor_area).toFixed(2)) : undefined
      );
      return {
        ...room,
        ceiling_height: ceilingHeight,
        lighting_basis: room.lighting_basis ?? "Floor",
        unit_id: room.unit_id ?? units[0].id,
        zone_id: room.zone_id === "zone-whole-house" ? undefined : room.zone_id
      };
    }),
    components: level.line_items.map((rawItem: Omit<ComponentDraft, "id" | "category">, index: number) => {
      const item = rawItem as Omit<ComponentDraft, "id" | "category">;
      return {
        id: `screenshot-${index}`,
        category: componentCategory(item),
        ...item,
        direction: relativeFacingFromCompass(item.direction, metadata.front_door_faces ?? "S")
      } as ComponentDraft;
    }),
    comparison: metadata.salas_obrien_comparison
  };
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.split(",", 2)[1] ?? "");
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function codeCategory(code: string): TypeCategory {
  const prefix = code.trim().charAt(0).toUpperCase();
  if (prefix === "G") return "Glass";
  if (prefix === "C" || prefix === "R") return "Ceiling";
  if (prefix === "F") return "Floor";
  if (prefix === "D") return "Door";
  return "Wall";
}

function componentCategory(item: { kind: ComponentKind; assembly?: string }): ComponentDraft["category"] {
  if (item.kind === "glass") return "Glass";
  if (item.kind === "internal_people") return "Person";
  if (item.kind === "internal_watts") return "Appliance";
  return item.assembly ? codeCategory(item.assembly) : "Wall";
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.round(Math.random() * 1000)}`;
}

function computeNextVersion(description: string, allProjects: SavedProject[]): string {
  // Strip any existing " v.N" suffix so we always work from the base name
  const base = description.replace(/ v\.\d+$/, "").trimEnd();
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escaped} v\\.(\\d+)$`);
  const taken = allProjects
    .map((p) => pattern.exec(p.description))
    .filter(Boolean)
    .map((m) => parseInt(m![1], 10));
  const next = taken.length > 0 ? Math.max(...taken) + 1 : 2;
  return `${base} v.${next}`;
}

function componentKindForCategory(category: TypeCategory | "Person" | "Appliance"): ComponentKind {
  if (category === "Glass") return "glass";
  if (category === "Person") return "internal_people";
  if (category === "Appliance") return "internal_watts";
  return "opaque";
}

function offsetDirection(front: CompassDirection, offset: number): CompassDirection {
  const frontIndex = compassDirections.indexOf(front);
  return compassDirections[(frontIndex + offset + compassDirections.length) % compassDirections.length];
}

function facingDirectionOptions(front: CompassDirection) {
  return relativeFacings.map((facing) => {
    const compass = offsetDirection(front, relativeFacingOffsets[facing]);
    return {
      value: facing,
      compass,
      facing: relativeFacingLabels[facing],
      label: `${compassArrows[compass]} ${relativeFacingLabels[facing]} (${compass})`,
    };
  });
}

function isCompassDirection(value: string | undefined): value is CompassDirection {
  return !!value && compassDirections.includes(value as CompassDirection);
}

function App() {
  const [project, setProject] = useState<ProjectDraft>(initialProject);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [loads, setLoads] = useState<Loads | null>(null);
  const [worstCase, setWorstCase] = useState<WorstCaseResult | null>(null);
  const [assemblies, setAssemblies] = useState<AssemblyRow[]>([]);
  const [validationMessage, setValidationMessage] = useState<string | null>(null);
  const [collapsedRooms, setCollapsedRooms] = useState<number[]>([]);
  const [collapsedPanels, setCollapsedPanels] = useState<Set<string>>(new Set(["component-review"]));
  const [showOpenDialog, setShowOpenDialog] = useState(false);
  const [savedProjects, setSavedProjects] = useState<SavedProject[]>([]);
  const [openDialogLoading, setOpenDialogLoading] = useState(false);
  const [openDialogError, setOpenDialogError] = useState<string | null>(null);
  const [saveConflict, setSaveConflict] = useState<SaveConflict | null>(null);
  const [showImportMenu, setShowImportMenu] = useState(false);
  const markdownFileInput = useRef<HTMLInputElement>(null);
  const pdfFileInput = useRef<HTMLInputElement>(null);
  const activeLevel = loads?.levels[0];

  const directionOptions = useMemo(() => facingDirectionOptions(project.front_door_faces), [project.front_door_faces]);
  const calculatedLevelVolume = useMemo(() => project.rooms.reduce((sum, room) => sum + roomVolume(room), 0), [project.rooms]);
  const selectedSystemTons = useMemo(() => project.units.reduce((sum, unit) => sum + Number(unit.selected_tons ?? 0), 0), [project.units]);
  const selectedSystemKw = useMemo(() => project.units.reduce((sum, unit) => sum + Number(unit.selected_kw ?? 0), 0), [project.units]);
  const roomResults = useMemo<RoomLoadResult[]>(
    () => activeLevel?.rooms ?? project.rooms.map((room) => ({ name: room.name, cooling_btuh: 0, heating_btuh: 0, cfm_cool: 0, cfm_heat: 0, cfm_avg: 0 })),
    [activeLevel, project.rooms]
  );
  const unitLoadSummaries = useMemo<UnitLoadSummary[]>(() => {
    const resultByName = new Map(roomResults.map((room) => [room.name, room]));
    const engineUnitById = new Map((loads?.units ?? []).map((unit) => [unit.id, unit]));
    return project.units.map((unit, unitIndex) => {
      const unitRooms = project.rooms
        .filter((room) => room.unit_id === unit.id || (!room.unit_id && unitIndex === 0))
        .map((draft) => ({
          draft,
          result: resultByName.get(draft.name) ?? { name: draft.name, cooling_btuh: 0, heating_btuh: 0, cfm_cool: 0, cfm_heat: 0, cfm_avg: 0 }
        }));
      const floorArea = unitRooms.reduce((sum, room) => sum + (roomBasisArea(room.draft, project.components) ?? 0), 0);
      const coolingSubtotal = unitRooms.reduce((sum, room) => sum + room.result.cooling_btuh, 0);
      const heatingSubtotal = unitRooms.reduce((sum, room) => sum + room.result.heating_btuh, 0);
      const engineUnit = engineUnitById.get(unit.id);
      const sensibleCooling = engineUnit?.sensible_cooling ?? Math.round(coolingSubtotal * 1.1);
      const heatLoss = engineUnit?.heating ?? Math.round(heatingSubtotal * 1.15);
      const tonsMin = sensibleCooling / 9000;
      const kwMin = heatLoss / 3412;
      const selectedTons = Number(unit.selected_tons ?? 0);
      const selectedKw = Number(unit.selected_kw ?? 0);
      const cfm = selectedTons * 400;
      return {
        unit,
        rooms: unitRooms,
        floorArea,
        coolingSubtotal,
        heatingSubtotal,
        sensibleCooling,
        heatLoss,
        tonsMin,
        kwMin,
        cfm,
        coolingLat: cfm ? project.indoor_cooling_db - sensibleCooling / (1.1 * cfm) : undefined,
        heatingLat: cfm ? project.indoor_heating_db + selectedKw * 3412 / (1.1 * cfm) : undefined,
      };
    });
  }, [project.units, project.rooms, project.components, project.indoor_cooling_db, project.indoor_heating_db, roomResults, loads?.units]);
  const comparisonHouse = project.comparison?.house as Record<string, unknown> | undefined;
  const comparisonUnits = Array.isArray(project.comparison?.units)
    ? project.comparison.units as Array<Record<string, unknown>>
    : [];
  const comparisonRoomRows = useMemo(() => {
    const rooms = project.comparison?.rooms;
    if (!rooms || typeof rooms !== "object") return [];
    const resultByName = new Map(roomResults.map((room) => [room.name, room]));
    return Object.entries(rooms as Record<string, Record<string, unknown>>).map(([roomName, reference]) => {
      const model = resultByName.get(roomName);
      return { roomName, reference, model };
    });
  }, [project.comparison, roomResults]);
  const hasAssignmentChoices = project.units.length > 1 || project.zones.length > 0;
  const hasRoomData = project.rooms.some((room) => room.name || room.floor_area || room.ceiling_height)
    || project.components.length > 0;

  useEffect(() => {
    fetch("/api/assemblies")
      .then((response) => response.json())
      .then((rows: AssemblyRow[]) => {
        setAssemblies(rows);
      })
      .catch(() => setAssemblies([]));
  }, []);

  function updateProject<K extends keyof ProjectDraft>(key: K, value: ProjectDraft[K]) {
    setProject((current) => ({ ...current, [key]: value }));
    setLoads(null);
    setWorstCase(null);
    setProjectId(null);
    setValidationMessage(null);
  }

  function updateLevel(key: keyof ProjectDraft["level"], value: number | string | boolean) {
    setProject((current) => ({ ...current, level: { ...current.level, [key]: value } }));
    setLoads(null);
    setWorstCase(null);
    setProjectId(null);
    setValidationMessage(null);
  }

  function updateRoom(index: number, name: string) {
    setProject((current) => {
      const oldName = current.rooms[index].name;
      const rooms = current.rooms.map((room, roomIndex) => (roomIndex === index ? { ...room, name } : room));
      const components = current.components.map((component) =>
        component.room_name === oldName ? { ...component, room_name: name } : component
      );
      return { ...current, rooms, components };
    });
    setLoads(null);
    setWorstCase(null);
    setProjectId(null);
    setValidationMessage(null);
  }

  function updateRoomField(index: number, patch: Partial<RoomDraft>) {
    setProject((current) => ({
      ...current,
      rooms: current.rooms.map((room, roomIndex) => (roomIndex === index ? { ...room, ...patch } : room))
    }));
    setLoads(null);
    setWorstCase(null);
    setProjectId(null);
    setValidationMessage(null);
  }

  function addRoom() {
    setProject((current) => {
      const shouldRequireUnitChoice = current.units.length > 1;
      return {
        ...current,
        rooms: [
          ...current.rooms,
          {
            name: `Room ${current.rooms.length + 1}`,
            floor_area: 0,
            ceiling_height: 9,
            lighting_basis: "Floor",
            unit_id: shouldRequireUnitChoice ? "" : current.units[0]?.id,
            zone_id: undefined
          }
        ]
      };
    });
    setLoads(null);
    setWorstCase(null);
    setProjectId(null);
    setValidationMessage(null);
  }

  function removeRoom(index: number) {
    setProject((current) => {
      const roomName = current.rooms[index].name;
      return {
        ...current,
        rooms: current.rooms.filter((_room, roomIndex) => roomIndex !== index),
        components: current.components.filter((component) => component.room_name !== roomName),
      };
    });
    setCollapsedRooms((current) => current.filter((i) => i !== index).map((i) => i > index ? i - 1 : i));
    setLoads(null);
    setWorstCase(null);
    setProjectId(null);
    setValidationMessage(null);
  }

  function addTypeDefinition() {
    setProject((current) => ({
      ...current,
      type_definitions: [...current.type_definitions, { code: "", category: "Wall", u_value: undefined, shgc: null, description: "" }]
    }));
    setLoads(null);
    setWorstCase(null);
    setProjectId(null);
    setValidationMessage(null);
  }

  function updateTypeDefinition(index: number, patch: Partial<TypeDefinition>) {
    setProject((current) => ({
      ...current,
      type_definitions: current.type_definitions.map((definition, definitionIndex) =>
        definitionIndex === index ? { ...definition, ...patch } : definition
      )
    }));
    setLoads(null);
    setWorstCase(null);
    setProjectId(null);
    setValidationMessage(null);
  }

  function removeTypeDefinition(index: number) {
    setProject((current) => ({
      ...current,
      type_definitions: current.type_definitions.filter((_definition, definitionIndex) => definitionIndex !== index)
    }));
    setLoads(null);
    setWorstCase(null);
    setProjectId(null);
    setValidationMessage(null);
  }

  function addUnit() {
    setProject((current) => ({
      ...current,
      units: [...current.units, { id: newId("unit"), name: `Unit ${current.units.length + 1}`, selected_tons: 1, selected_kw: 5 }]
    }));
    setLoads(null);
    setWorstCase(null);
    setProjectId(null);
    setValidationMessage(hasRoomData ? "Review room assignments after adding a unit." : null);
  }

  function updateUnit(index: number, name: string) {
    setProject((current) => ({
      ...current,
      units: current.units.map((unit, unitIndex) => (unitIndex === index ? { ...unit, name } : unit))
    }));
    setLoads(null);
    setWorstCase(null);
    setProjectId(null);
    setValidationMessage(null);
  }

  function updateUnitSizing(index: number, patch: Pick<UnitDraft, "selected_tons" | "selected_kw">) {
    setProject((current) => ({
      ...current,
      units: current.units.map((unit, unitIndex) => (unitIndex === index ? { ...unit, ...patch } : unit))
    }));
    setLoads(null);
    setWorstCase(null);
    setProjectId(null);
    setValidationMessage(null);
  }

  function removeUnit(index: number) {
    if (index === 0) return;
    const unit = project.units[index];
    if (!unit) return;
    const assignedRoomCount = project.rooms.filter((room) => room.unit_id === unit.id).length;
    const assignmentWarning = assignedRoomCount
      ? ` ${assignedRoomCount} assigned room${assignedRoomCount === 1 ? "" : "s"} will be moved to ${project.units[0].name} and will need assignment review.`
      : "";
    if (!confirm(`Delete ${unit.name} and its zones?${assignmentWarning}`)) return;

    setProject((current) => {
      const primaryUnit = current.units[0];
      return {
        ...current,
        units: current.units.filter((_candidate, unitIndex) => unitIndex !== index),
        zones: current.zones.filter((zone) => zone.unit_id !== unit.id),
        rooms: current.rooms.map((room) =>
          room.unit_id === unit.id
            ? { ...room, unit_id: primaryUnit.id, zone_id: undefined }
            : room
        )
      };
    });
    setLoads(null);
    setWorstCase(null);
    setProjectId(null);
    setValidationMessage(assignedRoomCount ? `Review room assignments after deleting ${unit.name}.` : null);
  }

  function addZone(unitId: string) {
    setProject((current) => {
      const existingZones = current.zones.filter((zone) => zone.unit_id === unitId);
      const unit = current.units.find((candidate) => candidate.id === unitId);
      const unitName = unit?.name ?? "Unit";
      const nextZones = existingZones.length === 0
        ? [
            { id: newId("zone"), name: `${unitName} Zone 1`, unit_id: unitId },
            { id: newId("zone"), name: `${unitName} Zone 2`, unit_id: unitId },
          ]
        : [{ id: newId("zone"), name: `${unitName} Zone ${existingZones.length + 1}`, unit_id: unitId }];
      return {
        ...current,
        zones: [...current.zones, ...nextZones]
      };
    });
    setLoads(null);
    setWorstCase(null);
    setProjectId(null);
    setValidationMessage(hasRoomData ? "Review room assignments after adding zones." : null);
  }

  function updateZone(index: number, patch: Partial<ZoneDraft>) {
    setProject((current) => ({
      ...current,
      zones: current.zones.map((zone, zoneIndex) => (zoneIndex === index ? { ...zone, ...patch } : zone))
    }));
    setLoads(null);
    setProjectId(null);
    setValidationMessage(null);
  }

  function removeZone(zoneId: string) {
    const zone = project.zones.find((candidate) => candidate.id === zoneId);
    if (!zone) return;
    const zonesForUnit = project.zones.filter((candidate) => candidate.unit_id === zone.unit_id);
    if (zonesForUnit.length <= 1) {
      setValidationMessage("A unit with explicit zones must keep at least one zone.");
      return;
    }
    const assignedRoomCount = project.rooms.filter((room) => room.zone_id === zone.id).length;
    const assignmentWarning = assignedRoomCount
      ? ` ${assignedRoomCount} assigned room${assignedRoomCount === 1 ? "" : "s"} will need a new zone selection.`
      : "";
    if (!confirm(`Delete ${zone.name}?${assignmentWarning}`)) return;

    setProject((current) => ({
      ...current,
      zones: current.zones.filter((candidate) => candidate.id !== zoneId),
      rooms: current.rooms.map((room) =>
        room.zone_id === zoneId ? { ...room, zone_id: undefined } : room
      )
    }));
    setLoads(null);
    setWorstCase(null);
    setProjectId(null);
    setValidationMessage(assignedRoomCount ? `Review room assignments after deleting ${zone.name}.` : null);
  }

  function typeCodesForCategory(category: TypeCategory) {
    return project.type_definitions.filter((definition) => definition.category === category && definition.code.trim());
  }

  function addRoomComponent(roomName: string, category: TypeCategory | "Person" | "Appliance") {
    const matchingType = category === "Person" || category === "Appliance" ? undefined : typeCodesForCategory(category)[0]?.code;
    const kind = componentKindForCategory(category);
    setProject((current) => {
      if (category === "Person") {
        const existingPersonIndex = current.components.findIndex((component) =>
          component.room_name === roomName && component.kind === "internal_people"
        );
        if (existingPersonIndex >= 0) {
          return {
            ...current,
            components: current.components.map((component, componentIndex) =>
              componentIndex === existingPersonIndex
                ? { ...component, quantity: (component.quantity ?? 0) + 1 }
                : component
            )
          };
        }
      }
      return {
        ...current,
        components: [
          ...current.components,
          {
            id: newId(kind),
            name: category === "Person"
              ? "People"
              : `${category} ${current.components.filter((component) => component.room_name === roomName && component.category === category).length + 1}`,
            kind,
            category,
            room_name: roomName,
            assembly: matchingType,
            direction: kind === "glass" || category === "Wall" ? "FRONT" : undefined,
            area: kind === "glass" || kind === "opaque" ? 0 : undefined,
            quantity: category === "Person" ? 1 : undefined,
            watts: category === "Appliance" ? 0 : undefined
          }
        ]
      };
    });
    setLoads(null);
    setWorstCase(null);
    setProjectId(null);
    setValidationMessage(null);
  }

  function updateComponent(index: number, patch: Partial<ComponentDraft>) {
    setProject((current) => ({
      ...current,
      components: current.components.map((component, componentIndex) =>
        componentIndex === index ? { ...component, ...patch } : component
      )
    }));
    setLoads(null);
    setWorstCase(null);
    setProjectId(null);
    setValidationMessage(null);
  }

  function removeComponent(index: number) {
    setProject((current) => ({
      ...current,
      components: current.components.filter((_component, componentIndex) => componentIndex !== index)
    }));
    setLoads(null);
    setWorstCase(null);
    setProjectId(null);
    setValidationMessage(null);
  }

  function togglePanel(id: string) {
    setCollapsedPanels((cur) => {
      const next = new Set(cur);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleRoomCollapsed(index: number) {
    setCollapsedRooms((current) =>
      current.includes(index) ? current.filter((roomIndex) => roomIndex !== index) : [...current, index]
    );
  }

  function collapseAllRooms() {
    setCollapsedRooms(project.rooms.map((_room, index) => index));
  }

  function expandAllRooms() {
    setCollapsedRooms([]);
  }

  function resetToNew() {
    setProject(initialProject);
    setLoads(null);
    setWorstCase(null);
    setProjectId(null);
    setCollapsedRooms([]);
    setValidationMessage(null);
  }

  async function importMarkdownFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const response = await fetch("/api/import/room-cooling-markdown", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, text: await file.text() })
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.detail ?? "Could not import that Markdown file.");
      }
      const imported = result as MarkdownImportResponse;
      setProject(draftFromPayload(imported.payload));
      setLoads(null);
      setWorstCase(null);
      setProjectId(null);
      setCollapsedRooms([]);
      setValidationMessage(imported.warnings.length ? imported.warnings.join(" ") : null);
    } catch (error) {
      setValidationMessage(error instanceof Error ? error.message : "Could not import that Markdown file.");
    }
  }

  async function importSalasPdfFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      setValidationMessage("Importing Salas O'Brien PDF...");
      const response = await fetch("/api/import/salas-pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, data_base64: await fileToBase64(file) })
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.detail ?? "Could not import that PDF.");
      }
      const imported = result as MarkdownImportResponse;
      setProject(draftFromPayload(imported.payload));
      setLoads(null);
      setWorstCase(null);
      setProjectId(null);
      setCollapsedRooms([]);
      setValidationMessage(imported.warnings.length ? imported.warnings.join(" ") : "Imported Salas O'Brien PDF.");
    } catch (error) {
      setValidationMessage(error instanceof Error ? error.message : "Could not import that PDF.");
    }
  }

  async function openProjectDialog() {
    setOpenDialogError(null);
    setSavedProjects([]);
    setOpenDialogLoading(true);
    setShowOpenDialog(true);
    try {
      const rows: SavedProject[] = await fetch("/api/projects").then((r) => r.json());
      setSavedProjects(rows);
    } catch {
      setOpenDialogError("Could not load saved projects.");
    } finally {
      setOpenDialogLoading(false);
    }
  }

  async function loadSavedProject(id: number) {
    try {
      const payload: FixturePayload = await fetch(`/api/projects/${id}`).then((r) => r.json());
      setProject(draftFromPayload(payload));
      setProjectId(id);
      setLoads(null);
      setWorstCase(null);
      setCollapsedRooms([]);
      setValidationMessage(null);
      setShowOpenDialog(false);
    } catch {
      setOpenDialogError("Could not load that project.");
    }
  }

  async function deleteSavedProject(id: number) {
    if (!confirm("Delete this project? This cannot be undone.")) return;
    await fetch(`/api/projects/${id}`, { method: "DELETE" });
    setSavedProjects((current) => current.filter((p) => p.id !== id));
    if (projectId === id) {
      setProjectId(null);
    }
  }

  async function calculatePayload(payloadProject: ProjectDraft): Promise<Loads> {
    return fetch("/api/calculate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildPayload(payloadProject, assemblies))
    }).then((response) => response.json());
  }

  async function calculateWorstCase(projectDraft: ProjectDraft = project) {
    const results = await Promise.all(
      compassDirections.map(async (front) => ({
        front_door_faces: front,
        loads: await calculatePayload({ ...projectDraft, front_door_faces: front }),
      }))
    );
    return results.reduce((highest, candidate) => {
      const highestScore = highest.loads.whole_house_sensible_cooling + highest.loads.whole_house_heating;
      const candidateScore = candidate.loads.whole_house_sensible_cooling + candidate.loads.whole_house_heating;
      if (candidateScore > highestScore) return candidate;
      return highest;
    });
  }

  // ── Core save + calculate (called after conflict is resolved) ────────────────
  async function commitSaveAndCalculate(
    payload: Record<string, unknown>,
    targetId: number | null,       // null → POST (create new)
    overrideDescription?: string,  // set when saving as a new version
    calculationProject: ProjectDraft = project,
  ) {
    // If saving as new version, patch the description inside the payload
    const finalPayload: Record<string, unknown> = overrideDescription
      ? { ...payload, project: { ...(payload.project as object), description: overrideDescription } }
      : payload;

    let savedId: number;
    if (targetId !== null) {
      await fetch(`/api/projects/${targetId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(finalPayload),
      });
      savedId = targetId;
    } else {
      const created = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(finalPayload),
      }).then((r) => r.json());
      savedId = created.id;
    }

    setProjectId(savedId);
    if (overrideDescription) {
      setProject((cur) => ({ ...cur, description: overrideDescription }));
    }
    setLoads(await fetch(`/api/projects/${savedId}/loads`).then((r) => r.json()));
    setWorstCase(await calculateWorstCase(calculationProject));
  }

  // ── Conflict resolution handlers ──────────────────────────────────────────
  async function resolveConflictOverwrite() {
    if (!saveConflict) return;
    const { conflictProject, payload, project: conflictDraft } = saveConflict;
    setSaveConflict(null);
    await commitSaveAndCalculate(payload, conflictProject.id, undefined, conflictDraft);
  }

  async function resolveConflictNewVersion() {
    if (!saveConflict) return;
    const { payload, project: conflictDraft, nextVersionDescription } = saveConflict;
    setSaveConflict(null);
    await commitSaveAndCalculate(payload, null, nextVersionDescription, conflictDraft);
  }

  function resolveConflictCancel() {
    setSaveConflict(null);
  }

  // ── Main save entry point ─────────────────────────────────────────────────
  async function saveAndCalculate() {
    if (hasAssignmentChoices) {
      const missingRoom = project.rooms.find((room) => {
        if (!room.unit_id) return true;
        const zonesForUnit = project.zones.filter((zone) => zone.unit_id === room.unit_id);
        return zonesForUnit.length > 0 && !room.zone_id;
      });
      if (missingRoom) {
        const zonesForRoomUnit = project.zones.filter((zone) => zone.unit_id === missingRoom.unit_id);
        setValidationMessage(zonesForRoomUnit.length > 0
          ? `${missingRoom.name} needs a zone before calculating.`
          : `${missingRoom.name} needs a unit before calculating.`
        );
        return;
      }
    }
    const invalidWindow = project.components.find((component) => {
      if (component.kind !== "glass") return false;
      const resolvedDirection = resolveComponentDirection(component.direction, project.front_door_faces);
      if (!isCompassDirection(resolvedDirection)) return false;
      return !project.components.some((candidate) =>
        candidate.room_name === component.room_name
        && candidate.category === "Wall"
        && candidate.kind === "opaque"
        && resolveComponentDirection(candidate.direction, project.front_door_faces) === resolvedDirection
      );
    });
    if (invalidWindow) {
      setValidationMessage(`${invalidWindow.name} needs a matching wall facing in ${invalidWindow.room_name ?? "the same room"}.`);
      return;
    }

    const previewLoads = await calculatePayload(project);
    let raisedUnitCount = 0;
    const sizedUnits = project.units.map((unit) => {
      const engineUnit = previewLoads.units.find((candidate) => candidate.id === unit.id);
      const recommendedTons = engineUnit?.recommended_tons ?? standardTons[0];
      if (Number(unit.selected_tons ?? 0) >= recommendedTons) return unit;
      raisedUnitCount += 1;
      return { ...unit, selected_tons: recommendedTons };
    });
    const calculationProject = raisedUnitCount ? { ...project, units: sizedUnits } : project;
    if (raisedUnitCount) {
      setProject(calculationProject);
      setValidationMessage(`Selected tons increased to standard unit sizes for ${raisedUnitCount} unit${raisedUnitCount === 1 ? "" : "s"}.`);
    }
    const payload = buildPayload(calculationProject, assemblies) as Record<string, unknown>;

    // Check for a name+description collision with any OTHER saved project
    const allProjects: SavedProject[] = await fetch("/api/projects").then((r) => r.json());
    const conflict = allProjects.find(
      (p) => p.name === project.name && p.description === project.description && p.id !== projectId
    );
    if (conflict) {
      setSaveConflict({
        conflictProject: conflict,
        payload,
        project: calculationProject,
        nextVersionDescription: computeNextVersion(project.description, allProjects),
      });
      return; // wait for user to choose
    }

    // No conflict — save directly (update if already saved, create if new)
    await commitSaveAndCalculate(payload, projectId, undefined, calculationProject);
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <h1>ResLoad</h1>
        <p>{project.description}</p>
        <nav>
          <button className="active">{project.level.name}</button>
              {project.rooms.map((room, index) => (
            <button key={index}>{room.name}</button>
          ))}
        </nav>
        <section>
          <h2>Types</h2>
          <ul>
            {project.type_definitions.slice(0, 10).map((definition, index) => (
              <li key={`${definition.code}-${definition.category}-${index}`}>
                {definition.code || "New"} · {definition.category} · U {definition.u_value ?? "-"}
                {definition.shgc ? ` · SHGC ${definition.shgc}` : ""}
              </li>
            ))}
          </ul>
        </section>
      </aside>

      <section className="workspace">
        <header className="toolbar">
          <div>
            <h2>{project.name}</h2>
            <p>{project.location} · {project.outdoor_cooling_db}/{project.indoor_cooling_db} cooling · ACH50 {project.ach50}</p>
          </div>
          <div className="button-row">
            <button onClick={saveAndCalculate}>Save / Calculate</button>
            <button onClick={openProjectDialog}>Open…</button>
            <button onClick={resetToNew}>New</button>
            <div className="import-menu">
              <button onClick={() => setShowImportMenu((current) => !current)}>Import ▾</button>
              {showImportMenu && (
                <div className="import-menu-popover">
                  <button onClick={() => { setShowImportMenu(false); markdownFileInput.current?.click(); }}>Import Markdown</button>
                  <button onClick={() => { setShowImportMenu(false); pdfFileInput.current?.click(); }}>Import Salas PDF</button>
                </div>
              )}
            </div>
            <input
              ref={markdownFileInput}
              className="file-input"
              type="file"
              accept=".md,text/markdown,text/plain"
              onChange={importMarkdownFile}
            />
            <input
              ref={pdfFileInput}
              className="file-input"
              type="file"
              accept=".pdf,application/pdf"
              onChange={importSalasPdfFile}
            />
          </div>
          <div className="toolbar-status">
            {projectId ? <span className="saved-badge">Saved #{projectId}</span> : <span className="unsaved-badge">Unsaved</span>}
            {projectId && <a className="button" href={`/api/projects/${projectId}/report`}>PDF</a>}
          </div>
        </header>

        <section className="summary-grid">
          <article>
            <span>Cooling</span>
            <strong>{loads ? number(loads.whole_house_sensible_cooling) : "-"}</strong>
            <small>BTU/hr</small>
          </article>
          <article>
            <span>Heating</span>
            <strong>{loads ? number(loads.whole_house_heating) : "-"}</strong>
            <small>BTU/hr</small>
          </article>
          <article>
            <span>System</span>
            <strong>{loads ? `${loads.system_tons} tons` : `${selectedSystemTons} tons`}</strong>
            <small>{loads ? `${loads.system_kw} kW · ${loads.system_cfm} CFM` : `${selectedSystemKw} kW`}</small>
          </article>
          <article>
            <span>Worst Orientation</span>
            <strong>{worstCase ? compassArrows[worstCase.front_door_faces] + " " + worstCase.front_door_faces : "-"}</strong>
            <small>{worstCase ? `${number(worstCase.loads.whole_house_sensible_cooling)} cool · ${number(worstCase.loads.whole_house_heating)} heat` : "Run Save / Calculate"}</small>
          </article>
        </section>
        {validationMessage && <div className="validation-message">{validationMessage}</div>}

        <section className="panel form-panel">
          <div className="panel-head">
            <h3>First Page / Project Inputs</h3>
            <p>Conditions, system selection, and house-wide values.</p>
          </div>
          <div className="form-grid">
            <label>Project<input value={project.name} onChange={(event) => updateProject("name", event.target.value)} /></label>
            <label>Location<input value={project.location} onChange={(event) => updateProject("location", event.target.value)} /></label>
            <label>Description<input value={project.description} onChange={(event) => updateProject("description", event.target.value)} /></label>
            <label>Cooling outdoor<input type="number" step="0.001" value={project.outdoor_cooling_db} onChange={(event) => updateProject("outdoor_cooling_db", Number(event.target.value))} /></label>
            <label>Cooling indoor<input type="number" step="0.001" value={project.indoor_cooling_db} onChange={(event) => updateProject("indoor_cooling_db", Number(event.target.value))} /></label>
            <label>Heating outdoor<input type="number" step="0.001" value={project.outdoor_heating_db} onChange={(event) => updateProject("outdoor_heating_db", Number(event.target.value))} /></label>
            <label>Heating indoor<input type="number" step="0.001" value={project.indoor_heating_db} onChange={(event) => updateProject("indoor_heating_db", Number(event.target.value))} /></label>
            <label>ACH50<input type="number" step="0.001" value={project.ach50} onChange={(event) => updateProject("ach50", Number(event.target.value))} /></label>
            <label>Bedrooms<input type="number" step="0.001" value={project.bedrooms} onChange={(event) => updateProject("bedrooms", Number(event.target.value))} /></label>
            <label>SEER<input type="number" step="0.001" value={project.seer} onChange={(event) => updateProject("seer", Number(event.target.value))} /></label>
            <label>Front door faces
              <select value={project.front_door_faces} onChange={(event) => updateProject("front_door_faces", event.target.value as CompassDirection)}>
                {compassDirections.map((direction) => <option key={direction} value={direction}>{compassArrows[direction]} {direction}</option>)}
              </select>
            </label>
            <label>Total system tons<input type="number" step="0.001" value={selectedSystemTons} readOnly /></label>
            <label>Total system kW<input type="number" step="0.001" value={selectedSystemKw} readOnly /></label>
            <label>Floor area<input type="number" step="0.001" value={project.level.floor_area} onChange={(event) => updateLevel("floor_area", Number(event.target.value))} /></label>
            <label>Calculated volume<input type="number" step="0.001" value={Math.round(calculatedLevelVolume || project.level.volume)} readOnly /></label>
            <label>Total selected tons<input type="number" step="0.001" value={selectedSystemTons} readOnly /></label>
            <label>Total selected kW<input type="number" step="0.001" value={selectedSystemKw} readOnly /></label>
            <label className="check-field">Auto infiltration<input type="checkbox" checked={project.level.auto_infiltration} onChange={(event) => updateLevel("auto_infiltration", event.target.checked)} /></label>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3>Type Inputs</h3>
            <div className="button-row">
              {!collapsedPanels.has("type-inputs") && <button onClick={addTypeDefinition}>Add Type</button>}
              <button className="panel-toggle" onClick={() => togglePanel("type-inputs")}>{collapsedPanels.has("type-inputs") ? "Show ▾" : "Hide ▴"}</button>
            </div>
          </div>
          {!collapsedPanels.has("type-inputs") && <div className="component-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Category</th>
                  <th>U-value</th>
                  <th>SHGC</th>
                  <th>Description</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {project.type_definitions.map((definition, index) => (
                  <tr key={index}>
                    <td><input value={definition.code} onChange={(event) => updateTypeDefinition(index, { code: event.target.value.toUpperCase() })} /></td>
                    <td>
                      <select value={definition.category} onChange={(event) => updateTypeDefinition(index, { category: event.target.value as TypeCategory })}>
                        {typeCategories.map((category) => <option key={category} value={category}>{category}</option>)}
                      </select>
                    </td>
                    <td><input type="number" step="0.001" value={inputNumber(definition.u_value)} onChange={(event) => updateTypeDefinition(index, { u_value: toNumber(event.target.value) })} /></td>
                    <td><input type="number" step="0.001" value={inputNumber(definition.shgc ?? undefined)} onChange={(event) => updateTypeDefinition(index, { shgc: toNumber(event.target.value) })} readOnly={definition.category !== "Glass"} /></td>
                    <td><input value={definition.description ?? ""} onChange={(event) => updateTypeDefinition(index, { description: event.target.value })} /></td>
                    <td><button onClick={() => removeTypeDefinition(index)}>Remove</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3>Units & Zones</h3>
            <button onClick={addUnit}>Add Unit</button>
          </div>
          <div className="unit-zone-list">
            {project.units.map((unit, index) => {
              const zonesForUnit = project.zones
                .map((zone, zoneIndex) => ({ zone, zoneIndex }))
                .filter(({ zone }) => zone.unit_id === unit.id);
              return (
                <div className="unit-card" key={unit.id}>
                  <div className="unit-card-head">
                    <label>Unit {index + 1}<input value={unit.name} onChange={(event) => updateUnit(index, event.target.value)} /></label>
                    <div className="button-row">
                      <button onClick={() => addZone(unit.id)}>Add Zone</button>
                      {index > 0 && <button className="danger-button" onClick={() => removeUnit(index)}>Delete Unit</button>}
                    </div>
                  </div>
                  <div className="unit-sizing">
                    <label>Selected tons
                      <select value={inputNumber(unit.selected_tons)} onChange={(event) => updateUnitSizing(index, { selected_tons: Number(event.target.value) })}>
                        {standardTons.map((tons) => <option key={tons} value={tons}>{tons.toFixed(1)} Tons</option>)}
                      </select>
                    </label>
                    <label>Heat kW<input type="number" step="0.001" value={inputNumber(unit.selected_kw)} onChange={(event) => updateUnitSizing(index, { selected_kw: toNumber(event.target.value) })} /></label>
                  </div>
                  <div className="zone-list">
                    {zonesForUnit.length ? zonesForUnit.map(({ zone, zoneIndex }) => (
                      <div className="zone-row" key={zone.id}>
                        <label>Zone<input value={zone.name} onChange={(event) => updateZone(zoneIndex, { name: event.target.value })} /></label>
                        <button
                          className="danger-button"
                          disabled={zonesForUnit.length === 1}
                          title={zonesForUnit.length === 1 ? "A unit with explicit zones must keep at least one zone." : undefined}
                          onClick={() => removeZone(zone.id)}
                        >
                          Delete Zone
                        </button>
                      </div>
                    )) : <p>Unit default zone</p>}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="panel rooms-panel">
          <div className="panel-head">
            <h3>Rooms</h3>
            <div className="button-row">
              <button onClick={collapseAllRooms}>Collapse All</button>
              {collapsedRooms.length > 0 && <button onClick={expandAllRooms}>Expand All</button>}
              <button onClick={addRoom}>Add Room</button>
            </div>
          </div>
          {collapsedRooms.length > 0 && (
            <div className="collapsed-room-overview">
              {project.units.map((unit) => {
                const zonesForUnit = project.zones.filter((zone) => zone.unit_id === unit.id);
                const assignmentGroups = zonesForUnit.length
                  ? zonesForUnit.map((zone) => ({ id: zone.id, label: zone.name, rooms: project.rooms.map((room, roomIndex) => ({ room, roomIndex })).filter(({ room, roomIndex }) => collapsedRooms.includes(roomIndex) && room.unit_id === unit.id && room.zone_id === zone.id) }))
                  : [{ id: `${unit.id}-default`, label: "Unit default zone", rooms: project.rooms.map((room, roomIndex) => ({ room, roomIndex })).filter(({ room, roomIndex }) => collapsedRooms.includes(roomIndex) && (room.unit_id === unit.id || (!room.unit_id && unit.id === project.units[0]?.id))) }];
                const hasCollapsed = assignmentGroups.some((group) => group.rooms.length > 0);
                if (!hasCollapsed) return null;
                return (
                  <div className="collapsed-unit-group" key={unit.id}>
                    <h4>{unit.name}</h4>
                    {assignmentGroups.map((group) => group.rooms.length ? (
                      <div className="collapsed-zone-group" key={group.id}>
                        <div className="collapsed-zone-label">{group.label}</div>
                        <div className="collapsed-room-list">
                          {group.rooms.map(({ room, roomIndex }) => (
                            <button key={roomIndex} className="collapsed-room-chip" onClick={() => toggleRoomCollapsed(roomIndex)}>
                              <span>{room.name}</span>
                              <small>{formatInputNumber(roomBasisArea(room, project.components) ?? 0)} SF</small>
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : null)}
                  </div>
                );
              })}
            </div>
          )}
          <div className="room-list">
            {project.rooms.map((room, index) => {
              if (collapsedRooms.includes(index)) return null;
              const roomComponents = project.components
                .map((component, componentIndex) => ({ component, componentIndex }))
                .filter(({ component }) => component.room_name === room.name);
              const derivedRoomArea = roomBasisArea(room, project.components) ?? 0;
              const unitName = project.units.find((unit) => unit.id === room.unit_id)?.name ?? "Whole House";
              const availableZones = project.zones.filter((zone) => zone.unit_id === room.unit_id || !room.unit_id);
              const zoneName = room.zone_id
                ? project.zones.find((zone) => zone.id === room.zone_id)?.name ?? "Zone"
                : "Unit default zone";
              return (
              <div className="room-card" key={index}>
                <div className="room-card-head">
                  <label className="room-name-field">Room {index + 1}<input value={room.name} onChange={(event) => updateRoom(index, event.target.value)} /></label>
                  {hasAssignmentChoices ? (
                    <div className="room-assignment">
                      <label>Unit
                        <select className="compact-select" required value={room.unit_id ?? ""} onChange={(event) => updateRoomField(index, { unit_id: event.target.value, zone_id: "" })}>
                          <option value="">Select</option>
                          {project.units.map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}
                        </select>
                      </label>
                      {availableZones.length > 0 && (
                        <label>Zone
                          <select className="compact-select" required value={room.zone_id ?? ""} onChange={(event) => updateRoomField(index, { zone_id: event.target.value })}>
                            <option value="">Select</option>
                            {availableZones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}
                          </select>
                        </label>
                      )}
                    </div>
                  ) : (
                    <div className="zone-pill">{unitName}</div>
                  )}
                  <button className="collapse-button" onClick={() => toggleRoomCollapsed(index)}>Collapse</button>
                  <button className="danger-button" onClick={() => { if (confirm(`Remove ${room.name} and all its components?`)) removeRoom(index); }}>Remove Room</button>
                </div>
                  <div className="room-card-body">
                    <div className="room-actions structural-actions">
                      <button onClick={() => addRoomComponent(room.name, "Wall")}>Wall</button>
                      <button onClick={() => addRoomComponent(room.name, "Glass")}>Glass</button>
                      <button onClick={() => addRoomComponent(room.name, "Ceiling")}>Ceiling</button>
                      <button onClick={() => addRoomComponent(room.name, "Floor")}>Floor</button>
                      <button onClick={() => addRoomComponent(room.name, "Door")}>Door</button>
                    </div>
                    <div className="room-metrics">
                      <label>Area basis
                        <select value={room.lighting_basis ?? "Floor"} onChange={(event) => updateRoomField(index, { lighting_basis: event.target.value as LightingBasis })}>
                          <option value="Floor">Floor</option>
                          <option value="Ceiling">Ceiling</option>
                        </select>
                      </label>
                      <label>Area<input type="number" step="0.001" value={formatInputNumber(derivedRoomArea)} readOnly /></label>
                      <label>Ceiling height<input type="number" step="0.001" value={inputNumber(room.ceiling_height)} onChange={(event) => updateRoomField(index, { ceiling_height: toNumber(event.target.value) })} /></label>
                    </div>
                    <div className="room-component-list">
                      {roomComponents.length ? roomComponents.map(({ component, componentIndex }) => (
                        <div className="room-component-row" key={component.id}>
                          <input value={component.name} onChange={(event) => updateComponent(componentIndex, { name: event.target.value })} />
                          {component.kind === "internal_people" ? (
                            <>
                              <span>People</span>
                              <input type="number" step="0.001" value={inputNumber(component.quantity)} onChange={(event) => updateComponent(componentIndex, { quantity: toNumber(event.target.value) })} />
                            </>
                          ) : component.kind === "internal_watts" ? (
                            <>
                              <span>Appliance</span>
                              <input type="number" step="0.001" value={inputNumber(component.watts)} onChange={(event) => updateComponent(componentIndex, { watts: toNumber(event.target.value) })} />
                            </>
                          ) : (
                            <>
                              <select className="compact-select" value={component.direction ?? ""} onChange={(event) => updateComponent(componentIndex, { direction: event.target.value || undefined })}>
                                <option value="">Facing</option>
                                {directionOptions.map((direction) => <option key={direction.value} value={direction.value}>{direction.label}</option>)}
                                {component.kind === "glass" && <option value="Shaded">Shaded</option>}
                                {component.kind === "glass" && <option value="Skylight">Skylight</option>}
                              </select>
                              <select className="compact-select" value={component.assembly ?? ""} onChange={(event) => updateComponent(componentIndex, { assembly: event.target.value || undefined })}>
                                <option value="">Type</option>
                                {typeCodesForCategory(component.category as TypeCategory).map((definition) => <option key={definition.code} value={definition.code}>{typeOptionLabel(definition)}</option>)}
                              </select>
                              <input type="number" step="0.001" value={inputNumber(component.area)} onChange={(event) => updateComponent(componentIndex, { area: toNumber(event.target.value) })} />
                            </>
                          )}
                          <button onClick={() => removeComponent(componentIndex)}>Remove</button>
                        </div>
                      )) : <p>No room components yet.</p>}
                    </div>
                    <div className="room-actions internal-actions">
                      <button onClick={() => addRoomComponent(room.name, "Person")}>Person</button>
                      <button onClick={() => addRoomComponent(room.name, "Appliance")}>Appliance</button>
                    </div>
                  </div>
              </div>
              );
            })}
          </div>
          <div className="panel-foot">
            <button onClick={addRoom}>Add Room</button>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3>Component Review</h3>
            <div className="button-row">
              <p className="panel-head-note">Inputs are edited inside each room block.</p>
              <button className="panel-toggle" onClick={() => togglePanel("component-review")}>{collapsedPanels.has("component-review") ? "Show ▾" : "Hide ▴"}</button>
            </div>
          </div>
          {!collapsedPanels.has("component-review") && <div className="component-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Type Code</th>
                  <th>Area</th>
                  <th>Count</th>
                </tr>
              </thead>
              <tbody>
                {project.components.map((component) => (
                  <tr key={component.id}>
                    <td>{component.name}</td>
                    <td>{component.category ?? componentCategory(component)}</td>
                    <td>{component.assembly ?? "-"}</td>
                    <td>{component.area ?? "-"}</td>
                    <td>{component.quantity ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>}
        </section>

        {project.comparison && (
          <section className="panel comparison-panel">
            <div className="panel-head">
              <h3>Salas O'Brien Comparison</h3>
              <p>{loads ? "Imported reference values compared with the current calculation" : "Imported reference values loaded. Run Save / Calculate to compare current results."}</p>
            </div>
            <div className="comparison-grid">
              <div className="comparison-card">
                <h4>Overall</h4>
                <table>
                  <thead>
                    <tr>
                      <th>Metric</th>
                      <th>Calculator</th>
                      <th>Salas</th>
                      <th>Delta</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <th>Cooling BTU/hr</th>
                      <td>{loads ? number(loads.whole_house_sensible_cooling) : "-"}</td>
                      <td>{comparisonNumber(comparisonHouse?.cooling_btuh)}</td>
                      <td>{comparisonDelta(loads?.whole_house_sensible_cooling, comparisonHouse?.cooling_btuh)}</td>
                    </tr>
                    <tr>
                      <th>Heating BTU/hr</th>
                      <td>{loads ? number(loads.whole_house_heating) : "-"}</td>
                      <td>{comparisonNumber(comparisonHouse?.heating_btuh)}</td>
                      <td>{comparisonDelta(loads?.whole_house_heating, comparisonHouse?.heating_btuh)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              {comparisonUnits.length > 0 && (
                <div className="comparison-card">
                  <h4>Units</h4>
                  <table>
                    <thead>
                      <tr>
                        <th>Unit</th>
                        <th>Calc Cool</th>
                        <th>Salas Cool</th>
                        <th>Calc Heat</th>
                        <th>Salas Heat</th>
                        <th>Salas Tons</th>
                      </tr>
                    </thead>
                    <tbody>
                      {comparisonUnits.map((referenceUnit, index) => {
                        const summary = unitLoadSummaries[index];
                        return (
                          <tr key={`${referenceUnit.name ?? "unit"}-${index}`}>
                            <th>{String(referenceUnit.name ?? summary?.unit.name ?? `Unit ${index + 1}`)}</th>
                            <td>{summary ? number(summary.sensibleCooling) : "-"}</td>
                            <td>{comparisonNumber(referenceUnit.cooling_btuh)}</td>
                            <td>{summary ? number(summary.heatLoss) : "-"}</td>
                            <td>{comparisonNumber(referenceUnit.heating_btuh)}</td>
                            <td>{comparisonDecimal(referenceUnit.selected_tons, 1)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            {comparisonRoomRows.length > 0 && (
              <div className="comparison-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Room</th>
                      <th>Calc Cool</th>
                      <th>Salas Cool</th>
                      <th>Δ Cool</th>
                      <th>Calc Heat</th>
                      <th>Salas Heat</th>
                      <th>Δ Heat</th>
                      <th>Calc CFM Avg</th>
                      <th>Salas CFM Avg</th>
                      <th>Δ CFM</th>
                    </tr>
                  </thead>
                  <tbody>
                    {comparisonRoomRows.map(({ roomName, reference, model }) => (
                      <tr key={roomName}>
                        <th>{roomName}</th>
                        <td>{model ? number(model.cooling_btuh) : "-"}</td>
                        <td>{comparisonNumber(reference.cooling_btuh)}</td>
                        <td>{comparisonDelta(model?.cooling_btuh, reference.cooling_btuh)}</td>
                        <td>{model ? number(model.heating_btuh) : "-"}</td>
                        <td>{comparisonNumber(reference.heating_btuh)}</td>
                        <td>{comparisonDelta(model?.heating_btuh, reference.heating_btuh)}</td>
                        <td>{model ? number(model.cfm_avg) : "-"}</td>
                        <td>{comparisonNumber(reference.cfm_avg)}</td>
                        <td>{comparisonDelta(model?.cfm_avg, reference.cfm_avg)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        <section className="panel">
          <div className="panel-head">
            <h3>Load Summary</h3>
            <p>{activeLevel ? "Unit loads and selected system capacities" : "Run Save / Calculate"}</p>
          </div>
          <div className="load-summary-wrap">
            <table className="load-summary-table">
              <thead>
                <tr>
                  <th rowSpan={2}>Load Summary</th>
                  {unitLoadSummaries.map((summary, index) => (
                    <th className="unit-summary-head" colSpan={2} key={summary.unit.id}>Unit {index + 1} - {summary.unit.name}</th>
                  ))}
                </tr>
                <tr>
                  {unitLoadSummaries.map((summary) => (
                    <React.Fragment key={summary.unit.id}>
                      <th>Cooling</th>
                      <th>Heating</th>
                    </React.Fragment>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th>Sensible Load</th>
                  {unitLoadSummaries.map((summary) => (
                    <React.Fragment key={summary.unit.id}>
                      <td>{number(summary.sensibleCooling)} Btu/hr</td>
                      <td>{number(summary.heatLoss)} Btu/hr</td>
                    </React.Fragment>
                  ))}
                </tr>
                <tr>
                  <th>Minimum Nominal Capacity</th>
                  {unitLoadSummaries.map((summary) => (
                    <React.Fragment key={summary.unit.id}>
                      <td>{decimal(summary.tonsMin, 2)} Tons</td>
                      <td>{decimal(summary.kwMin, 2)} kW</td>
                    </React.Fragment>
                  ))}
                </tr>
                <tr>
                  <th>Load Density</th>
                  {unitLoadSummaries.map((summary) => (
                    <React.Fragment key={summary.unit.id}>
                      <td>{summary.tonsMin ? number(summary.floorArea / summary.tonsMin) : "-"} SF/Ton</td>
                      <td>{summary.floorArea ? decimal(summary.kwMin * 1000 / summary.floorArea, 1) : "-"} W/SF</td>
                    </React.Fragment>
                  ))}
                </tr>
                <tr>
                  <th>Floor Area Served</th>
                  {unitLoadSummaries.map((summary) => (
                    <React.Fragment key={summary.unit.id}>
                      <td>{decimal(summary.floorArea, 1)} SF</td>
                      <td>{decimal(summary.floorArea, 1)} SF</td>
                    </React.Fragment>
                  ))}
                </tr>
                <tr>
                  <th>Mechanical Ventilation</th>
                  {unitLoadSummaries.map((summary) => (
                    <React.Fragment key={summary.unit.id}>
                      <td>N/A CFM</td>
                      <td>N/A CFM</td>
                    </React.Fragment>
                  ))}
                </tr>
                <tr>
                  <th>System Size</th>
                  {unitLoadSummaries.map((summary) => (
                    <React.Fragment key={summary.unit.id}>
                      <td>{decimal(Number(summary.unit.selected_tons ?? 0), 1)} Tons</td>
                      <td>{decimal(Number(summary.unit.selected_kw ?? 0), 1)} kW</td>
                    </React.Fragment>
                  ))}
                </tr>
                <tr>
                  <th>Leaving Air Temperature</th>
                  {unitLoadSummaries.map((summary) => (
                    <React.Fragment key={summary.unit.id}>
                      <td>{summary.coolingLat === undefined ? "-" : decimal(summary.coolingLat, 1)} deg F</td>
                      <td>{summary.heatingLat === undefined ? "-" : decimal(summary.heatingLat, 1)} deg F</td>
                    </React.Fragment>
                  ))}
                </tr>
                <tr>
                  <th>Installed Capacity</th>
                  {unitLoadSummaries.map((summary) => (
                    <React.Fragment key={summary.unit.id}>
                      <td>{Number(summary.unit.selected_tons ?? 0) ? number(summary.floorArea / Number(summary.unit.selected_tons)) : "-"} SF/Ton</td>
                      <td>{summary.floorArea ? decimal(Number(summary.unit.selected_kw ?? 0) * 1000 / summary.floorArea, 1) : "-"} W/SF</td>
                    </React.Fragment>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3>Calculated Room Results</h3>
            <p>{activeLevel ? `${number(activeLevel.cooling_subtotal)} cooling subtotal · ${number(activeLevel.heating_subtotal)} heating subtotal` : "Run Save / Calculate"}</p>
          </div>
          <table>
            <thead>
              <tr>
                <th>Room</th>
                <th>Area</th>
                <th>Volume</th>
                <th>Cooling</th>
                <th>Heating</th>
                <th>CFM Cool</th>
                <th>CFM Heat</th>
                <th>CFM Avg</th>
              </tr>
            </thead>
            <tbody>
              {unitLoadSummaries.map((summary, unitIndex) => (
                <React.Fragment key={summary.unit.id}>
                  <tr className="unit-result-head">
                    <th colSpan={8}>Unit {unitIndex + 1} - {summary.unit.name}</th>
                  </tr>
                  {summary.rooms.map(({ draft, result }) => (
                    <tr key={result.name}>
                      <td>{result.name}</td>
                      <td>{number(roomBasisArea(draft, project.components) ?? 0)}</td>
                      <td>{number(roomVolume({ ...draft, floor_area: roomBasisArea(draft, project.components) }))}</td>
                      <td>{number(result.cooling_btuh)}</td>
                      <td>{number(result.heating_btuh)}</td>
                      <td>{result.cfm_cool || "-"}</td>
                      <td>{result.cfm_heat || "-"}</td>
                      <td>{result.cfm_avg || "-"}</td>
                    </tr>
                  ))}
                  <tr className="unit-result-total">
                    <th>{summary.unit.name} Total</th>
                    <td>{number(summary.floorArea)}</td>
                    <td>{number(summary.rooms.reduce((sum, room) => sum + roomVolume({ ...room.draft, floor_area: roomBasisArea(room.draft, project.components) }), 0))}</td>
                    <td>{number(summary.coolingSubtotal)}</td>
                    <td>{number(summary.heatingSubtotal)}</td>
                    <td>{number(summary.rooms.reduce((sum, room) => sum + room.result.cfm_cool, 0))}</td>
                    <td>{number(summary.rooms.reduce((sum, room) => sum + room.result.cfm_heat, 0))}</td>
                    <td>{number(summary.rooms.reduce((sum, room) => sum + room.result.cfm_avg, 0))}</td>
                  </tr>
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </section>
      </section>

      {saveConflict && (
        <div className="modal-backdrop" onClick={resolveConflictCancel}>
          <div className="modal conflict-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Project already exists</h2>
              <button className="modal-close" onClick={resolveConflictCancel}>✕</button>
            </div>
            <p className="conflict-body">
              A saved project named <strong>{saveConflict.conflictProject.name} – {saveConflict.conflictProject.description}</strong> already
              exists (last saved {saveConflict.conflictProject.updated_at.slice(0, 16).replace("T", " ")}).
              What would you like to do?
            </p>
            <div className="conflict-actions">
              <div className="conflict-action-card" onClick={resolveConflictOverwrite}>
                <strong>Overwrite</strong>
                <span>Replace the existing saved project with your current changes.</span>
              </div>
              <div className="conflict-action-card" onClick={resolveConflictNewVersion}>
                <strong>Save as &ldquo;{saveConflict.nextVersionDescription}&rdquo;</strong>
                <span>Keep the existing project and save this as a new version.</span>
              </div>
              <div className="conflict-action-card conflict-action-cancel" onClick={resolveConflictCancel}>
                <strong>Cancel</strong>
                <span>Go back and change the project name or description before saving.</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {showOpenDialog && (
        <div className="modal-backdrop" onClick={() => setShowOpenDialog(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Open Project</h2>
              <button className="modal-close" onClick={() => setShowOpenDialog(false)}>✕</button>
            </div>
            {openDialogLoading && <p className="modal-empty">Loading…</p>}
            {openDialogError && <p className="modal-error">{openDialogError}</p>}
            {!openDialogLoading && !openDialogError && savedProjects.length === 0 && (
              <p className="modal-empty">No saved projects yet. Use Save / Calculate to save your first project.</p>
            )}
            {!openDialogLoading && savedProjects.length > 0 && (
              <table className="project-list-table">
                <thead>
                  <tr>
                    <th>Project</th>
                    <th>Location</th>
                    <th>Last saved</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {savedProjects.map((p) => (
                    <tr key={p.id} className={p.id === projectId ? "project-row-active" : ""}>
                      <td>
                        <button className="link-button" onClick={() => loadSavedProject(p.id)}>
                          {p.name}{p.description ? ` – ${p.description}` : ""}
                        </button>
                      </td>
                      <td>{p.location}</td>
                      <td>{p.updated_at.slice(0, 16).replace("T", " ")}</td>
                      <td><button className="danger-button" onClick={() => deleteSavedProject(p.id)}>Delete</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
