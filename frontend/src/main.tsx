import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { TakeoffApp } from "./takeoff/TakeoffApp";

type AssemblyRow = { code: string; u_value?: number | null; shgc?: number | null; label: string };
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
  cooling_safety_factor: number;
  heating_safety_factor: number;
  ach50: number;
  bedrooms: number;
  seer: number;
  building_type: "single_family" | "townhouse";
  mechanical_ventilation: boolean;
  ventilation_cfm: number;
  natural_ach: number | null;
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
  salas_reference_orientation?: CompassDirection;
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
type SavedProject = {
  id: number;
  name: string;
  location: string;
  description: string;
  builder_name: string;
  project_name: string;
  plan_name: string;
  elevation: string | null;
  foundation: string | null;
  source: string;
  import_fidelity_passed: boolean | null;
  import_fidelity_details: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};
type SaveConflict = {
  conflictProject: SavedProject;   // the existing project that shares this name+description
  payload: Record<string, unknown>; // fully built payload, ready to POST/PUT
  nextVersionDescription: string;  // pre-computed "Description v.2" (or v.3, etc.)
};

type AuthConfig = {
  mode: "none" | "basic" | "supabase";
  supabase_url?: string;
  supabase_anon_key?: string;
};

type AuthSession = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  user?: { id?: string; email?: string };
};

const authStorageKey = "vrc.supabase.session.v1";
const nativeFetch = window.fetch.bind(window);
let authFetchInstalled = false;

function readAuthSession(): AuthSession | null {
  try {
    const raw = window.localStorage.getItem(authStorageKey);
    return raw ? JSON.parse(raw) as AuthSession : null;
  } catch {
    return null;
  }
}

function writeAuthSession(session: AuthSession) {
  window.localStorage.setItem(authStorageKey, JSON.stringify(session));
  const maxAge = Math.max(0, Math.floor((session.expires_at - Date.now()) / 1000));
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `vrc_access_token=${encodeURIComponent(session.access_token)}; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure}`;
}

function clearAuthSession() {
  window.localStorage.removeItem(authStorageKey);
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `vrc_access_token=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
}

function apiPath(input: RequestInfo | URL): string | null {
  const rawUrl = input instanceof Request ? input.url : String(input);
  try {
    const url = new URL(rawUrl, window.location.origin);
    return url.origin === window.location.origin && url.pathname.startsWith("/api/") ? url.pathname : null;
  } catch {
    return rawUrl.startsWith("/api/") ? rawUrl.split("?", 1)[0] : null;
  }
}

function installAuthenticatedFetch() {
  if (authFetchInstalled) return;
  authFetchInstalled = true;
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = apiPath(input);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const session = readAuthSession();
    if (path && path !== "/api/auth/config" && session?.access_token && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${session.access_token}`);
    }
    const response = await nativeFetch(input, { ...init, headers });
    if (path && path !== "/api/auth/config" && response.status === 401) {
      window.dispatchEvent(new Event("vrc-auth-expired"));
    }
    return response;
  };
}

installAuthenticatedFetch();

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
const defaultLightingWPerSf = 0.502;
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
  cooling_safety_factor: 1.10,
  heating_safety_factor: 1.15,
  ach50: 5,
  bedrooms: 1,
  seer: 14,
  building_type: "single_family",
  mechanical_ventilation: false,
  ventilation_cfm: 0,
  natural_ach: null,
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
    auto_lighting_w_per_sf: defaultLightingWPerSf,
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

function number(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "-";
  return Math.round(value).toLocaleString();
}

function decimal(value: number | null | undefined, places = 1): string {
  if (value == null || !Number.isFinite(value)) return "-";
  return value.toFixed(places);
}

function formatInputNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "";
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

function assemblyRowKey(row: AssemblyRow): string {
  return `${row.code}-${row.u_value ?? "x"}-${row.shgc ?? "x"}-${row.label}`.replace(/\s+/g, "-");
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
      building_type: project.building_type,
      design_conditions: {
        outdoor_cooling_db: project.outdoor_cooling_db,
        outdoor_heating_db: project.outdoor_heating_db,
        indoor_cooling_db: project.indoor_cooling_db,
        indoor_heating_db: project.indoor_heating_db,
        slab_delta_t: 27,
        cooling_safety_factor: project.cooling_safety_factor,
        heating_safety_factor: project.heating_safety_factor,
      },
      infiltration: project.mechanical_ventilation
        ? { mode: "standard_ach", outside_air_cfm: project.ventilation_cfm }
        : { mode: "standard_ach", ...(project.natural_ach ? { natural_ach: project.natural_ach } : {}) },
      metadata: {
        ach50: project.ach50,
        bedrooms: project.bedrooms,
        seer: project.seer,
        front_door_faces: project.front_door_faces,
        units: project.units,
        zones: project.zones,
        ...(project.comparison ? { salas_obrien_comparison: project.comparison } : {}),
        ...(project.salas_reference_orientation ? { salas_reference_orientation: project.salas_reference_orientation } : {})
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
  const metadata = "metadata" in project ? project.metadata as { ach50?: number; bedrooms?: number; seer?: number; front_door_faces?: CompassDirection; units?: UnitDraft[]; zones?: ZoneDraft[]; salas_obrien_comparison?: Record<string, any>; salas_reference_orientation?: CompassDirection } : {};
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
    cooling_safety_factor: (project.design_conditions as any).cooling_safety_factor ?? 1.10,
    heating_safety_factor: (project.design_conditions as any).heating_safety_factor ?? 1.15,
    ach50: Number(metadata.ach50 ?? 5),
    bedrooms: Number(metadata.bedrooms ?? 3),
    seer: Number(metadata.seer ?? 14),
    building_type: ((project as any).building_type ?? (metadata as any).building_type ?? "single_family") as "single_family" | "townhouse",
    mechanical_ventilation: Boolean((project as any).infiltration?.outside_air_cfm),
    ventilation_cfm: Number((project as any).infiltration?.outside_air_cfm ?? 0),
    natural_ach: (project as any).infiltration?.natural_ach ?? null,
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
    comparison: metadata.salas_obrien_comparison,
    salas_reference_orientation: metadata.salas_reference_orientation,
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

function libraryCodeForCategory(category: TypeCategory): string {
  if (category === "Glass") return "G";
  if (category === "Ceiling") return "C";
  if (category === "Floor") return "F";
  if (category === "Door") return "D";
  return "W";
}

function nextSlotCode(category: TypeCategory, definitions: TypeDefinition[]): string {
  const prefix = libraryCodeForCategory(category);
  const used = new Set(definitions.map((definition) => definition.code.trim().toUpperCase()));
  let index = 1;
  while (used.has(`${prefix}${index}`)) index += 1;
  return `${prefix}${index}`;
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
  const [assemblySearch, setAssemblySearch] = useState("");
  const [assemblyLibraryLoading, setAssemblyLibraryLoading] = useState(false);
  const [assemblyLibraryError, setAssemblyLibraryError] = useState<string | null>(null);
  const [assemblyTargetIndex, setAssemblyTargetIndex] = useState(0);
  const [pendingAssemblyAssignment, setPendingAssemblyAssignment] = useState<AssemblyRow | null>(null);
  const [savingAssemblyKey, setSavingAssemblyKey] = useState<string | null>(null);
  const [validationMessage, setValidationMessage] = useState<string | null>(null);
  const [collapsedRooms, setCollapsedRooms] = useState<number[]>(() =>
    initialProject.rooms.length === 1 ? [] : initialProject.rooms.map((_, i) => i)
  );
  const [addComponentRoom, setAddComponentRoom] = useState<string | null>(null); // room name for open picker
  const [collapsedPanels, setCollapsedPanels] = useState<Set<string>>(new Set(["component-review", "advanced-settings"]));
  const [showFieldErrors, setShowFieldErrors] = useState(false);
  const [showOpenDialog, setShowOpenDialog] = useState(false);
  const [savedProjects, setSavedProjects] = useState<SavedProject[]>([]);
  const [openDialogLoading, setOpenDialogLoading] = useState(false);
  const [openDialogError, setOpenDialogError] = useState<string | null>(null);
  const [saveConflict, setSaveConflict] = useState<SaveConflict | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [calculateLoading, setCalculateLoading] = useState(false);
  const [exportLoading, setExportLoading] = useState(false);
  const [saveLoading, setSaveLoading] = useState(false);
  const [importFidelity, setImportFidelity] = useState<{ passed: boolean | null; details: Record<string, unknown> | null } | null>(null);
  const [batteryStatus, setBatteryStatus] = useState<"none" | "eligible" | "added" | "loading">("none");
  const [showOpenMenu, setShowOpenMenu] = useState(false);
  const [showSaveMenu, setShowSaveMenu] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [showImportMenu, setShowImportMenu] = useState(false);
  const [showMobileMenu, setShowMobileMenu] = useState(false);
  const [confirmModal, setConfirmModal] = useState<{ message: string; onConfirm: () => void } | null>(null);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [saveAsName, setSaveAsName] = useState("");
  const [saveAsLoading, setSaveAsLoading] = useState(false);
  const [saveAsConflict, setSaveAsConflict] = useState<SavedProject | null>(null);
  const [navPinned, setNavPinned] = useState(false);
  const [activeSection, setActiveSection] = useState("project-settings");
  const [navDrawerOpen, setNavDrawerOpen] = useState(false);
  const [bulkPdfModal, setBulkPdfModal] = useState(false);
  const [bulkPdfImporting, setBulkPdfImporting] = useState(false);
  const [bulkPdfProgress, setBulkPdfProgress] = useState<{ done: number; total: number; results: Array<{ filename: string; ok: boolean; plan_name?: string; error?: string; warnings?: string[] }> }>({ done: 0, total: 0, results: [] });
  const markdownFileInput = useRef<HTMLInputElement>(null);
  const pdfFileInput = useRef<HTMLInputElement>(null);
  const activeLevel = loads?.levels[0];

  const [appHash, setAppHash] = useState(window.location.hash);
  useEffect(() => {
    const handler = () => setAppHash(window.location.hash);
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

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
  const filteredAssemblies = useMemo(() => {
    const query = assemblySearch.trim().toLowerCase();
    return assemblies.filter((assembly) => {
      const matchesQuery = !query || `${assembly.code} ${assembly.label} ${assembly.u_value ?? ""} ${assembly.shgc ?? ""}`.toLowerCase().includes(query);
      return matchesQuery;
    });
  }, [assemblies, assemblySearch]);
  const pendingAssemblyCategory = pendingAssemblyAssignment ? codeCategory(pendingAssemblyAssignment.code) : null;
  const pendingAssemblySlots = pendingAssemblyCategory
    ? project.type_definitions
        .map((definition, index) => ({ definition, index }))
        .filter(({ definition }) => definition.category === pendingAssemblyCategory)
    : [];

  useEffect(() => {
    loadAssemblyLibrary();
  }, []);

  useEffect(() => {
    const sectionEls = document.querySelectorAll<HTMLElement>("[data-section]");
    if (!sectionEls.length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        // Pick the entry closest to the top of the viewport among those intersecting
        const visible = entries.filter((e) => e.isIntersecting);
        if (!visible.length) return;
        visible.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        setActiveSection(visible[0].target.getAttribute("data-section") ?? "");
      },
      { rootMargin: "-10% 0px -75% 0px", threshold: 0 }
    );
    sectionEls.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [project.comparison]); // re-run when comparison panel mounts/unmounts

  function scrollToSection(id: string) {
    document.getElementById(`section-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function scrollToRoomCard(index: number) {
    document.getElementById(`room-card-${index}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    // Also expand the room if it's collapsed
    if (collapsedRooms.includes(index)) toggleRoomCollapsed(index);
  }

  function updateProject<K extends keyof ProjectDraft>(key: K, value: ProjectDraft[K]) {
    setProject((current) => ({ ...current, [key]: value }));
    setLoads(null);
    setWorstCase(null);
    setIsDirty(true);
    setValidationMessage(null);
  }

  function updateLevel(key: keyof ProjectDraft["level"], value: number | string | boolean) {
    setProject((current) => ({ ...current, level: { ...current.level, [key]: value } }));
    setLoads(null);
    setWorstCase(null);
    setIsDirty(true);
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
    setIsDirty(true);
    setValidationMessage(null);
  }

  function updateRoomField(index: number, patch: Partial<RoomDraft>) {
    setProject((current) => ({
      ...current,
      rooms: current.rooms.map((room, roomIndex) => (roomIndex === index ? { ...room, ...patch } : room))
    }));
    setLoads(null);
    setWorstCase(null);
    setIsDirty(true);
    setValidationMessage(null);
  }

  function addRoom() {
    setProject((current) => {
      const shouldRequireUnitChoice = current.units.length > 1;
      const newIndex = current.rooms.length;
      // Collapse all existing rooms, expand the new one only if it's the only room
      setCollapsedRooms(newIndex === 0 ? [] : current.rooms.map((_, i) => i));
      return {
        ...current,
        rooms: [
          ...current.rooms,
          {
            name: `Room ${newIndex + 1}`,
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
    setIsDirty(true);
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
    setIsDirty(true);
    setValidationMessage(null);
  }

  function addTypeDefinition() {
    setProject((current) => ({
      ...current,
      type_definitions: [...current.type_definitions, { code: "", category: "Wall", u_value: undefined, shgc: null, description: "" }]
    }));
    setAssemblyTargetIndex(project.type_definitions.length);
    setLoads(null);
    setWorstCase(null);
    setIsDirty(true);
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
    setIsDirty(true);
    setValidationMessage(null);
  }

  function removeTypeDefinition(index: number) {
    setProject((current) => ({
      ...current,
      type_definitions: current.type_definitions.filter((_definition, definitionIndex) => definitionIndex !== index)
    }));
    setAssemblyTargetIndex((currentIndex) => Math.max(0, Math.min(currentIndex > index ? currentIndex - 1 : currentIndex, project.type_definitions.length - 2)));
    setLoads(null);
    setWorstCase(null);
    setIsDirty(true);
    setValidationMessage(null);
  }

  function applyLibraryAssembly(row: AssemblyRow, target: number | "new") {
    setProject((current) => {
      const category = codeCategory(row.code);
      if (target === "new") {
        return {
          ...current,
          type_definitions: [
            ...current.type_definitions,
            {
              code: nextSlotCode(category, current.type_definitions),
              category,
              u_value: row.u_value ?? undefined,
              shgc: category === "Glass" ? row.shgc ?? null : null,
              description: row.label,
            }
          ]
        };
      }
      return {
        ...current,
        type_definitions: current.type_definitions.map((currentDefinition, definitionIndex) =>
          definitionIndex === target
            ? {
                ...currentDefinition,
                u_value: row.u_value ?? undefined,
                shgc: currentDefinition.category === "Glass" ? row.shgc ?? null : null,
                description: row.label,
              }
            : currentDefinition
        )
      };
    });
    setPendingAssemblyAssignment(null);
    setLoads(null);
    setWorstCase(null);
    setIsDirty(true);
    setValidationMessage(null);
  }

  async function loadAssemblyLibrary() {
    setAssemblyLibraryLoading(true);
    setAssemblyLibraryError(null);
    try {
      const response = await fetch("/api/assemblies");
      if (!response.ok) throw new Error("Could not load component library.");
      const rows: AssemblyRow[] = await response.json();
      setAssemblies(rows);
    } catch (error) {
      setAssemblies([]);
      setAssemblyLibraryError(error instanceof Error ? error.message : "Could not load component library.");
    } finally {
      setAssemblyLibraryLoading(false);
    }
  }

  async function saveTypeDefinitionToLibrary(definition: TypeDefinition, index: number) {
    const label = compactTypeDescription(definition.description);
    if (!label) {
      setAssemblyLibraryError("Description is required before saving to the shared library.");
      return;
    }
    const slotCode = definition.code.trim().toUpperCase();
    const libraryCode = libraryCodeForCategory(definition.category);
    const saveKey = `${index}-${slotCode}`;
    setSavingAssemblyKey(saveKey);
    setAssemblyLibraryError(null);
    try {
      const response = await fetch("/api/assemblies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: libraryCode,
          u_value: definition.u_value,
          shgc: definition.category === "Glass" ? definition.shgc ?? null : null,
          label,
        }),
      });
      if (!response.ok) throw new Error("Could not save this component to the shared library.");
      await loadAssemblyLibrary();
    } catch (error) {
      setAssemblyLibraryError(error instanceof Error ? error.message : "Could not save this component to the shared library.");
    } finally {
      setSavingAssemblyKey(null);
    }
  }

  function addUnit() {
    setProject((current) => ({
      ...current,
      units: [...current.units, { id: newId("unit"), name: `Unit ${current.units.length + 1}`, selected_tons: 1, selected_kw: 5 }]
    }));
    setLoads(null);
    setWorstCase(null);
    setIsDirty(true);
    setValidationMessage(hasRoomData ? "Review room assignments after adding a unit." : null);
  }

  function updateUnit(index: number, name: string) {
    setProject((current) => ({
      ...current,
      units: current.units.map((unit, unitIndex) => (unitIndex === index ? { ...unit, name } : unit))
    }));
    setLoads(null);
    setWorstCase(null);
    setIsDirty(true);
    setValidationMessage(null);
  }

  function updateUnitSizing(index: number, patch: Pick<UnitDraft, "selected_tons" | "selected_kw">) {
    setProject((current) => ({
      ...current,
      units: current.units.map((unit, unitIndex) => (unitIndex === index ? { ...unit, ...patch } : unit))
    }));
    setLoads(null);
    setWorstCase(null);
    setIsDirty(true);
    setValidationMessage(null);
  }

  function removeUnit(index: number) {
    if (index === 0) return;
    const unit = project.units[index];
    if (!unit) return;
    const assignedRoomCount = project.rooms.filter((room) => room.unit_id === unit.id).length;
    const assignmentWarning = assignedRoomCount
      ? ` ${assignedRoomCount} assigned room${assignedRoomCount === 1 ? "" : "s"} will be moved to ${project.units[0].name}.`
      : "";
    setConfirmModal({
      message: `Delete ${unit.name} and its zones?${assignmentWarning}`,
      onConfirm: () => {
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
        setIsDirty(true);
        setValidationMessage(assignedRoomCount ? `Review room assignments after deleting ${unit.name}.` : null);
      }
    });
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
    setIsDirty(true);
    setValidationMessage(hasRoomData ? "Review room assignments after adding zones." : null);
  }

  function updateZone(index: number, patch: Partial<ZoneDraft>) {
    setProject((current) => ({
      ...current,
      zones: current.zones.map((zone, zoneIndex) => (zoneIndex === index ? { ...zone, ...patch } : zone))
    }));
    setLoads(null);
    setIsDirty(true);
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
    setConfirmModal({
      message: `Delete ${zone.name}?${assignmentWarning}`,
      onConfirm: () => {
        setProject((current) => ({
          ...current,
          zones: current.zones.filter((candidate) => candidate.id !== zoneId),
          rooms: current.rooms.map((room) =>
            room.zone_id === zoneId ? { ...room, zone_id: undefined } : room
          )
        }));
        setLoads(null);
        setWorstCase(null);
        setIsDirty(true);
        setValidationMessage(assignedRoomCount ? `Review room assignments after deleting ${zone.name}.` : null);
      }
    });
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
    setIsDirty(true);
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
    setIsDirty(true);
    setValidationMessage(null);
  }

  function removeComponent(index: number) {
    setProject((current) => ({
      ...current,
      components: current.components.filter((_component, componentIndex) => componentIndex !== index)
    }));
    setLoads(null);
    setWorstCase(null);
    setIsDirty(true);
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
    setIsDirty(false);
    setCollapsedRooms(initialProject.rooms.length === 1 ? [] : initialProject.rooms.map((_, i) => i));
    setValidationMessage(null);
    setImportFidelity(null);
    setBatteryStatus("none");
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
      setIsDirty(false);
      setCollapsedRooms(imported.payload.project?.levels?.[0]?.rooms?.length === 1 ? [] : (imported.payload.project?.levels?.[0]?.rooms ?? []).map((_: unknown, i: number) => i));
      setValidationMessage(imported.warnings.length ? imported.warnings.join(" ") : null);
    } catch (error) {
      setValidationMessage(error instanceof Error ? error.message : "Could not import that Markdown file.");
    }
  }

  async function importSalasPdfFile(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) return;

    if (files.length > 1) {
      bulkImportPdfs(files);
      return;
    }

    const file = files[0];
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
      setIsDirty(false);
      setCollapsedRooms([]);
      setValidationMessage(imported.warnings.length ? imported.warnings.join(" ") : "Imported Salas O'Brien PDF.");
    } catch (error) {
      setValidationMessage(error instanceof Error ? error.message : "Could not import that PDF.");
    }
  }

  async function bulkImportPdfs(files: File[]) {
    setBulkPdfProgress({ done: 0, total: files.length, results: [] });
    setBulkPdfImporting(true);
    setBulkPdfModal(true);
    const results: typeof bulkPdfProgress.results = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        const importRes = await fetch("/api/import/salas-pdf", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: file.name, data_base64: await fileToBase64(file) }),
        });
        const importData = await importRes.json();
        if (!importRes.ok) {
          results.push({ filename: file.name, ok: false, error: importData.detail ?? "Import failed" });
          setBulkPdfProgress({ done: i + 1, total: files.length, results: [...results] });
          continue;
        }
        const payload = importData.payload;
        const warnings: string[] = importData.warnings ?? [];
        const planName: string = payload?.project?.plan_name ?? file.name;
        const saveRes = await fetch("/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const saveData = await saveRes.json();
        if (!saveRes.ok) {
          results.push({ filename: file.name, ok: false, error: saveData.detail ?? "Save failed" });
        } else {
          results.push({ filename: file.name, ok: true, plan_name: planName, warnings });
        }
      } catch (e) {
        results.push({ filename: file.name, ok: false, error: e instanceof Error ? e.message : "Network error" });
      }
      setBulkPdfProgress({ done: i + 1, total: files.length, results: [...results] });
    }
    setBulkPdfImporting(false);
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

  async function loadSavedProject(id: number, row?: SavedProject) {
    try {
      const payload: FixturePayload = await fetch(`/api/projects/${id}`).then((r) => r.json());
      const loadedDraft = draftFromPayload(payload);
      setProject(loadedDraft);
      setProjectId(id);
      setIsDirty(false);
      setLoads(null);
      setWorstCase(null);
      setCollapsedRooms(loadedDraft.rooms.length === 1 ? [] : loadedDraft.rooms.map((_, i) => i));
      setValidationMessage(null);
      setShowOpenDialog(false);
      setImportFidelity(null);
      setBatteryStatus("none");
      const resolvedRow = row ?? savedProjects.find((p) => p.id === id);
      if (resolvedRow?.import_fidelity_passed != null) {
        setImportFidelity({ passed: resolvedRow.import_fidelity_passed, details: resolvedRow.import_fidelity_details ?? null });
      }
      checkBatteryStatus(id, resolvedRow);
      window.location.hash = "";
    } catch {
      setOpenDialogError("Could not load that project.");
    }
  }

  function deleteSavedProject(id: number) {
    setConfirmModal({
      message: "Delete this project? This cannot be undone.",
      onConfirm: async () => {
        await fetch(`/api/projects/${id}`, { method: "DELETE" });
        setSavedProjects((current) => current.filter((p) => p.id !== id));
        if (projectId === id) {
          setProjectId(null);
          setBatteryStatus("none");
          setImportFidelity(null);
        }
      }
    });
  }

  async function checkBatteryStatus(id: number, savedRow?: SavedProject) {
    setBatteryStatus("loading");
    try {
      // Check if already has a battery copy
      const battery: Array<{ parent_id: number | null }> = await fetch("/api/battery").then((r) => r.json());
      const hasCopy = battery.some((b) => b.parent_id === id);
      if (hasCopy) { setBatteryStatus("added"); return; }
      // Check eligibility — any salas_import with comparison data is eligible
      // (fidelity is informational, not a hard gate)
      const source = savedRow?.source;
      if (source === "salas_import") {
        setBatteryStatus("eligible");
      } else {
        setBatteryStatus("none");
      }
    } catch {
      setBatteryStatus("none");
    }
  }

  async function addToTestBattery() {
    if (!projectId) return;
    setBatteryStatus("loading");
    try {
      const res = await fetch("/api/battery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source_id: projectId }),
      });
      if (!res.ok) {
        const data = await res.json();
        setValidationMessage(data.detail ?? "Could not add to battery.");
        setBatteryStatus("eligible");
        return;
      }
      setBatteryStatus("added");
    } catch {
      setBatteryStatus("eligible");
    }
  }

  async function refreshBatteryCopy() {
    if (!projectId) return;
    setBatteryStatus("loading");
    try {
      const battery: Array<{ id: number; parent_id: number | null }> = await fetch("/api/battery").then((r) => r.json());
      const copy = battery.find((b) => b.parent_id === projectId);
      if (!copy) { setBatteryStatus("eligible"); return; }
      await fetch(`/api/battery/${copy.id}/refresh`, { method: "POST" });
      setBatteryStatus("added");
    } catch {
      setBatteryStatus("added");
    }
  }

  async function calculatePayload(payloadProject: ProjectDraft): Promise<Loads> {
    const response = await fetch("/api/calculate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildPayload(payloadProject, assemblies))
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail ?? "Calculation failed.");
    return data;
  }

  async function exportAirflowSheet() {
    setExportLoading(true);
    try {
      const response = await fetch("/api/export/airflow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload(project, assemblies))
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.detail ?? "Airflow export failed.");
      }
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const match = disposition.match(/filename="?([^"]+)"?/);
      const filename = match ? match[1] : "Airflow.xlsx";
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
      setValidationMessage("Exported airflow balancing sheet. Not saved.");
    } catch (error) {
      setValidationMessage(error instanceof Error ? error.message : "Could not export airflow sheet.");
    } finally {
      setExportLoading(false);
    }
  }

  async function startAirflowWizard() {
    setExportLoading(true);
    try {
      const response = await fetch("/api/airflow/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload(project, assemblies))
      });
      if (!response.ok) throw new Error("Wizard preparation failed.");
      const data = await response.json();
      const key = `vrc-wizard-${Date.now()}`;
      localStorage.setItem(key, JSON.stringify(data));
      window.open(`/#/airflow-wizard?session=${key}`, "_blank");
    } catch (error) {
      setValidationMessage(error instanceof Error ? error.message : "Could not start wizard.");
    } finally {
      setExportLoading(false);
    }
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

  function requiredFieldErrors(projectDraft: ProjectDraft): string | null {
    const missing: string[] = [];
    if (!projectDraft.name?.trim()) missing.push("Name");
    if (!projectDraft.location?.trim()) missing.push("Location");
    if (!projectDraft.building_type) missing.push("Building Type");
    if (!projectDraft.front_door_faces) missing.push("Front Door Faces");
    if (!projectDraft.bedrooms) missing.push("Bedrooms");
    if (!projectDraft.ach50) missing.push("ACH50");
    if (!projectDraft.seer) missing.push("SEER");
    return missing.length ? `Required before calculating: ${missing.join(", ")}.` : null;
  }

  function validationErrorFor(projectDraft: ProjectDraft): string | null {
    const assignmentChoices = projectDraft.units.length > 1 || projectDraft.zones.length > 0;
    if (assignmentChoices) {
      const missingRoom = projectDraft.rooms.find((room) => {
        if (!room.unit_id) return true;
        const zonesForUnit = projectDraft.zones.filter((zone) => zone.unit_id === room.unit_id);
        return zonesForUnit.length > 0 && !room.zone_id;
      });
      if (missingRoom) {
        const zonesForRoomUnit = projectDraft.zones.filter((zone) => zone.unit_id === missingRoom.unit_id);
        return zonesForRoomUnit.length > 0
          ? `${missingRoom.name} needs a zone before calculating.`
          : `${missingRoom.name} needs a unit before calculating.`;
      }
    }

    const invalidWindow = projectDraft.components.find((component) => {
      if (component.kind !== "glass") return false;
      const resolvedDirection = resolveComponentDirection(component.direction, projectDraft.front_door_faces);
      if (!isCompassDirection(resolvedDirection)) return false;
      return !projectDraft.components.some((candidate) =>
        candidate.room_name === component.room_name
        && candidate.category === "Wall"
        && candidate.kind === "opaque"
        && resolveComponentDirection(candidate.direction, projectDraft.front_door_faces) === resolvedDirection
      );
    });
    if (invalidWindow) {
      return `${invalidWindow.name} needs a matching wall facing in ${invalidWindow.room_name ?? "the same room"}.`;
    }

    return null;
  }

  async function calculateCurrentProject() {
    const reqError = requiredFieldErrors(project);
    if (reqError) {
      setValidationMessage(reqError);
      setShowFieldErrors(true);
      // Expand advanced settings if a required field there is missing (none currently, but future-proof)
      return;
    }
    setShowFieldErrors(false);
    const error = validationErrorFor(project);
    if (error) {
      setValidationMessage(error);
      return;
    }

    setCalculateLoading(true);
    try {
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
      const freshLoads = raisedUnitCount ? await calculatePayload(calculationProject) : previewLoads;
      if (raisedUnitCount) {
        setProject(calculationProject);
      }
      setLoads(freshLoads);
      setWorstCase(await calculateWorstCase(calculationProject));
      setValidationMessage(
        raisedUnitCount
          ? `Calculated current draft and increased selected tons to standard unit sizes for ${raisedUnitCount} unit${raisedUnitCount === 1 ? "" : "s"}. Not saved.`
          : "Calculated current draft. Not saved."
      );
    } catch (error) {
      setValidationMessage(error instanceof Error ? error.message : "Could not calculate current draft.");
    } finally {
      setCalculateLoading(false);
    }
  }

  // ── Core save (called after conflict is resolved) ─────────────────────────
  async function commitSave(
    payload: Record<string, unknown>,
    targetId: number | null,       // null → POST (create new)
    overrideDescription?: string,  // set when saving as a new version
  ) {
    // If saving as new version, patch the description inside the payload
    const finalPayload: Record<string, unknown> = overrideDescription
      ? { ...payload, project: { ...(payload.project as object), description: overrideDescription } }
      : payload;

    let savedId: number;
    if (targetId !== null) {
      const response = await fetch(`/api/projects/${targetId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(finalPayload),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.detail ?? "Could not update project.");
      }
      savedId = targetId;
    } else {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(finalPayload),
      });
      const created = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(created.detail ?? "Could not save project.");
      savedId = created.id;
    }

    setProjectId(savedId);
    setIsDirty(false);
    if (overrideDescription) {
      setProject((cur) => ({ ...cur, description: overrideDescription }));
    }
    setValidationMessage(`Saved project #${savedId}.`);

    // Refresh fidelity + battery status after save
    try {
      const allRows: SavedProject[] = await fetch("/api/projects").then((r) => r.json());
      const savedRow = allRows.find((p) => p.id === savedId);
      if (savedRow?.import_fidelity_passed != null) {
        setImportFidelity({ passed: savedRow.import_fidelity_passed, details: savedRow.import_fidelity_details ?? null });
      } else {
        setImportFidelity(null);
      }
      checkBatteryStatus(savedId, savedRow);
    } catch {
      // non-fatal
    }
  }

  // ── Conflict resolution handlers ──────────────────────────────────────────
  async function resolveConflictOverwrite() {
    if (!saveConflict) return;
    const { conflictProject, payload } = saveConflict;
    setSaveConflict(null);
    setSaveLoading(true);
    try {
      await commitSave(payload, conflictProject.id);
    } catch (error) {
      setValidationMessage(error instanceof Error ? error.message : "Could not save project.");
    } finally {
      setSaveLoading(false);
    }
  }

  async function resolveConflictNewVersion() {
    if (!saveConflict) return;
    const { payload, nextVersionDescription } = saveConflict;
    setSaveConflict(null);
    setSaveLoading(true);
    try {
      await commitSave(payload, null, nextVersionDescription);
    } catch (error) {
      setValidationMessage(error instanceof Error ? error.message : "Could not save project.");
    } finally {
      setSaveLoading(false);
    }
  }

  function resolveConflictCancel() {
    setSaveConflict(null);
  }

  // ── Main save entry point ─────────────────────────────────────────────────
  async function saveProject() {
    const error = validationErrorFor(project);
    if (error) {
      setValidationMessage(error.replace("calculating", "saving"));
      return;
    }

    setSaveLoading(true);
    const payload = buildPayload(project, assemblies) as Record<string, unknown>;

    try {
      // Check for a name+description collision with any OTHER saved project
      const allProjects: SavedProject[] = await fetch("/api/projects").then((r) => r.json());
      const conflict = allProjects.find(
        (p) => p.name === project.name && p.description === project.description && p.id !== projectId
      );
      if (conflict) {
        setSaveConflict({
          conflictProject: conflict,
          payload,
          nextVersionDescription: computeNextVersion(project.description, allProjects),
        });
        return; // wait for user to choose
      }

      // No conflict — save directly (update if already saved, create if new)
      await commitSave(payload, projectId);
    } catch (error) {
      setValidationMessage(error instanceof Error ? error.message : "Could not save project.");
    } finally {
      setSaveLoading(false);
    }
  }

  async function handleSaveDraft() {
    setSaveLoading(true);
    const payload = buildPayload(project, assemblies) as Record<string, unknown>;
    try {
      const allProjects: SavedProject[] = await fetch("/api/projects").then((r) => r.json());
      const conflict = allProjects.find(
        (p) => p.name === project.name && p.description === project.description && p.id !== projectId
      );
      if (conflict) {
        setSaveConflict({
          conflictProject: conflict,
          payload,
          nextVersionDescription: computeNextVersion(project.description, allProjects),
        });
        return;
      }
      await commitSave(payload, projectId);
    } catch (error) {
      setValidationMessage(error instanceof Error ? error.message : "Could not save draft.");
    } finally {
      setSaveLoading(false);
    }
  }

  function openSaveAs() {
    setSaveAsName(project.name);
    setSaveAsConflict(null);
    setSaveAsOpen(true);
  }

  async function commitSaveAs(name: string, overwriteId: number | null) {
    setSaveAsLoading(true);
    try {
      const payload = buildPayload({ ...project, name }, assemblies) as Record<string, unknown>;
      if (overwriteId !== null) {
        await commitSave(payload, overwriteId);
      } else {
        await commitSave(payload, null);
      }
      setProject((cur) => ({ ...cur, name }));
      setSaveAsOpen(false);
      setSaveAsConflict(null);
    } catch (error) {
      setValidationMessage(error instanceof Error ? error.message : "Could not save project.");
    } finally {
      setSaveAsLoading(false);
    }
  }

  async function handleSaveAsConfirm() {
    const name = saveAsName.trim();
    if (!name) return;
    setSaveAsLoading(true);
    try {
      const allProjects: SavedProject[] = await fetch("/api/projects").then((r) => r.json());
      const conflict = allProjects.find((p) => p.name === name && p.id !== projectId);
      if (conflict) {
        setSaveAsConflict(conflict);
        setSaveAsLoading(false);
        return;
      }
      await commitSaveAs(name, null);
    } catch (error) {
      setValidationMessage(error instanceof Error ? error.message : "Could not save project.");
      setSaveAsLoading(false);
    }
  }

  const hasRequiredFieldError = !!requiredFieldErrors(project);
  const hasRoomAssignmentError = project.rooms.some((room) => {
    if (!room.unit_id && (project.units.length > 1 || project.zones.length > 0)) return true;
    const zonesForUnit = project.zones.filter((z) => z.unit_id === room.unit_id);
    return zonesForUnit.length > 0 && !room.zone_id;
  });

  const navItems = [
    { id: "project-settings",    label: "Project Settings",    icon: "⚙", status: hasRequiredFieldError ? "error" : null },
    { id: "envelope-assemblies", label: "Envelope Assemblies", icon: "▦", status: null },
    { id: "units-zones",         label: "Units & Zones",       icon: "◫", status: null },
    { id: "rooms",               label: "Rooms",               icon: "⌂", status: hasRoomAssignmentError ? "error" : null },
    { id: "load-summary",        label: "Load Summary",        icon: "≡", status: loads ? "ok" : null },
    ...(project.comparison ? [{ id: "salas-comparison", label: "Salas Comparison", icon: "↔", status: null }] : []),
  ] as Array<{ id: string; label: string; icon: string; status: "error" | "ok" | null }>;

  return (
    <main className={`app-shell${navPinned ? " app-shell--nav-pinned" : ""}`}>
      {/* ── Left nav icon rail ─────────────────────────────────────── */}
      <aside className="left-nav" onMouseEnter={() => {}} onMouseLeave={() => {}}>
        <div className="left-nav-header">
          <img src="/logo.png" className="left-nav-logo-img" alt="Baseline" />
          <span className="left-nav-logo">VRC</span>
          <button
            className="left-nav-pin-btn"
            onClick={() => setNavPinned((v) => !v)}
            title={navPinned ? "Unpin sidebar" : "Pin sidebar open"}
          >
            {navPinned ? "◀" : "▶"}
          </button>
        </div>
        <nav className="left-nav-sections">
          {navItems.map((item) => (
            <div key={item.id} className={`nav-item${activeSection === item.id ? " nav-item--active" : ""}`}>
              <button
                className="nav-item-btn"
                onClick={() => { scrollToSection(item.id); setNavDrawerOpen(false); }}
                title={item.label}
              >
                <span className="nav-icon">{item.icon}</span>
                <span className="nav-label">{item.label}</span>
                {item.status === "error" && <span className="nav-dot nav-dot--error" />}
                {item.status === "ok"    && <span className="nav-dot nav-dot--ok" />}
              </button>
              {/* Room sub-items — desktop only, when in Rooms section */}
              {item.id === "rooms" && activeSection === "rooms" && project.rooms.length > 0 && (
                <div className="nav-sub-items">
                  {project.rooms.map((room, index) => (
                    <button
                      key={index}
                      className="nav-sub-item"
                      onClick={() => scrollToRoomCard(index)}
                    >
                      {room.name || `Room ${index + 1}`}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </nav>
      </aside>

      {/* ── Mobile nav drawer ──────────────────────────────────────── */}
      <button className="mobile-nav-fab" onClick={() => setNavDrawerOpen((v) => !v)} aria-label="Navigation">
        ☰
      </button>
      {navDrawerOpen && (
        <div className="mobile-nav-backdrop" onClick={() => setNavDrawerOpen(false)}>
          <div className="mobile-nav-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="mobile-nav-drawer-head">
              <span>Navigate</span>
              <button onClick={() => setNavDrawerOpen(false)}>✕</button>
            </div>
            {navItems.map((item) => (
              <button
                key={item.id}
                className={`mobile-nav-item${activeSection === item.id ? " mobile-nav-item--active" : ""}`}
                onClick={() => { scrollToSection(item.id); setNavDrawerOpen(false); }}
              >
                <span className="nav-icon">{item.icon}</span>
                <span>{item.label}</span>
                {item.status === "error" && <span className="nav-dot nav-dot--error" />}
                {item.status === "ok"    && <span className="nav-dot nav-dot--ok" />}
              </button>
            ))}
          </div>
        </div>
      )}

      {appHash === "#/projects" && (
        <div style={{ position: "fixed", inset: 0, zIndex: 200, overflowY: "auto", background: "#f7f8fa" }}>
          <ProjectLibrary onOpen={(id, row) => loadSavedProject(id, row)} />
        </div>
      )}

      <section className="workspace">
        <header className="toolbar">
          <div className="toolbar-title">
            <h2>{project.name}{isDirty ? " *" : ""}</h2>
            <p>{project.location} · {project.outdoor_cooling_db}/{project.indoor_cooling_db} cooling · ACH50 {project.ach50}</p>
          </div>
          <div className="button-row">
            {/* Open ▾ */}
            <div className="toolbar-menu">
              <button onClick={() => { setShowOpenMenu((v) => !v); setShowSaveMenu(false); setShowExportMenu(false); }}>Open ▾</button>
              {showOpenMenu && (
                <div className="toolbar-menu-popover" onMouseLeave={() => setShowOpenMenu(false)}>
                  <button onClick={() => { setShowOpenMenu(false); resetToNew(); }}>New</button>
                  <button onClick={() => { setShowOpenMenu(false); window.location.hash = "#/projects"; }}>Open Saved…</button>
                  <div className="toolbar-menu-divider" />
                  <button onClick={() => { setShowOpenMenu(false); setShowImportMenu(false); pdfFileInput.current?.click(); }}>Import Salas PDF</button>
                </div>
              )}
            </div>

            <button
              className="toolbar-primary"
              onClick={calculateCurrentProject}
              disabled={calculateLoading || saveLoading}
            >
              {calculateLoading ? "Calculating…" : "Calculate"}
            </button>

            {/* Save Draft — always visible */}
            <button onClick={handleSaveDraft} disabled={saveLoading || calculateLoading}>
              {saveLoading ? "Saving…" : "Save Draft"}
            </button>

            {/* Save ▾ — only after calculate */}
            {loads && (
              <div className="toolbar-menu">
                <button onClick={() => { setShowSaveMenu((v) => !v); setShowOpenMenu(false); setShowExportMenu(false); }} disabled={saveLoading}>
                  Save ▾
                </button>
                {showSaveMenu && (
                  <div className="toolbar-menu-popover" onMouseLeave={() => setShowSaveMenu(false)}>
                    <button onClick={() => { setShowSaveMenu(false); saveProject(); }}>Save</button>
                    <button onClick={() => { setShowSaveMenu(false); openSaveAs(); }}>Save As…</button>
                  </div>
                )}
              </div>
            )}

            {/* Export ▾ — only after calculate */}
            {loads && (
              <div className="toolbar-menu">
                <button onClick={() => { setShowExportMenu((v) => !v); setShowOpenMenu(false); setShowSaveMenu(false); }} disabled={exportLoading}>
                  Export ▾
                </button>
                {showExportMenu && (
                  <div className="toolbar-menu-popover" onMouseLeave={() => setShowExportMenu(false)}>
                    <button onClick={() => { setShowExportMenu(false); startAirflowWizard(); }} disabled={exportLoading}>
                      {exportLoading ? "Preparing…" : "Airflow Wizard…"}
                    </button>
                    {projectId ? (
                      <a className="button" href={`/api/projects/${projectId}/airflow`} onClick={() => setShowExportMenu(false)}>Airflow Sheet (direct)</a>
                    ) : (
                      <button onClick={() => { setShowExportMenu(false); exportAirflowSheet(); }}>
                        {exportLoading ? "Exporting…" : "Airflow Sheet (direct)"}
                      </button>
                    )}
                    {projectId && (
                      <a className="button" href={`/api/projects/${projectId}/report`} onClick={() => setShowExportMenu(false)}>PDF Report</a>
                    )}
                  </div>
                )}
              </div>
            )}

            <input ref={markdownFileInput} className="file-input" type="file" accept=".md,text/markdown,text/plain" onChange={importMarkdownFile} />
            <input ref={pdfFileInput} className="file-input" type="file" accept=".pdf,application/pdf" multiple onChange={importSalasPdfFile} />
          </div>
          <div className="toolbar-status">
            {projectId && !isDirty
              ? <span className="saved-badge">Saved #{projectId}</span>
              : projectId && isDirty
              ? <span className="unsaved-badge">Unsaved changes</span>
              : <span className="unsaved-badge">Unsaved</span>}
            {importFidelity != null && (
              <span
                className={importFidelity.passed ? "fidelity-badge fidelity-pass" : "fidelity-badge fidelity-warn"}
                title={
                  importFidelity.passed
                    ? "Import fidelity passed — areas, volume, orientation, and room count match Salas reference."
                    : (() => {
                        const d = importFidelity.details ?? {};
                        const issues: string[] = [];
                        if (d.orientation_match === false) issues.push(`Orientation: VRC=${d.vrc_orientation} Salas=${d.salas_orientation}`);
                        if (d.floor_area_match === false) issues.push(`Floor area: VRC=${d.vrc_floor_area} Salas=${d.salas_floor_area}`);
                        if (d.volume_match === false) issues.push(`Volume: VRC=${d.vrc_volume} Salas=${d.salas_volume}`);
                        if (d.room_count_match === false) issues.push(`Rooms: VRC=${d.vrc_room_count} Salas=${d.salas_room_count}`);
                        return issues.length ? issues.join(" | ") : "Import fidelity check failed.";
                      })()
                }
              >
                {importFidelity.passed ? "✓ Inputs" : "⚠ Inputs"}
              </span>
            )}
            {batteryStatus === "eligible" && (
              <button className="button battery-btn" onClick={addToTestBattery}>+ Battery</button>
            )}
            {batteryStatus === "loading" && (
              <span className="battery-status-label">Battery…</span>
            )}
            {batteryStatus === "added" && (
              <button className="button battery-btn battery-btn-added" onClick={refreshBatteryCopy} title="Refresh the test battery copy from this project">↻ Battery</button>
            )}
            <a className="button" href="/#/takeoff">Takeoff</a>
            <a className="button" href="/#/admin">Admin</a>
          </div>
        </header>

        {/* ── Mobile bottom toolbar ─────────────────────────────────── */}
        <div className="mobile-toolbar">
          <button
            className="mobile-toolbar-icon-btn"
            onClick={() => setNavDrawerOpen((v) => !v)}
            aria-label="Navigation"
          >☰</button>
          <button
            className="mobile-toolbar-icon-btn"
            onClick={() => setShowMobileMenu((v) => !v)}
            aria-label="More actions"
          >⋯</button>
          <button
            className="mobile-calculate-pill"
            onClick={calculateCurrentProject}
            disabled={calculateLoading}
          >
            {calculateLoading ? "Calculating…" : "Calculate"}
          </button>
        </div>

        {showMobileMenu && (
          <div className="mobile-action-backdrop" onClick={() => setShowMobileMenu(false)}>
            <div className="mobile-action-sheet" onClick={(e) => e.stopPropagation()}>
              <div className="mobile-action-sheet-handle" />
              <button className="mobile-action-item" onClick={() => { setShowMobileMenu(false); resetToNew(); }}>New</button>
              <button className="mobile-action-item" onClick={() => { setShowMobileMenu(false); window.location.hash = "#/projects"; }}>Open Saved…</button>
              <a className="mobile-action-item" href="/#/takeoff" onClick={() => setShowMobileMenu(false)}>Takeoff</a>
              <button className="mobile-action-item" onClick={() => { setShowMobileMenu(false); pdfFileInput.current?.click(); }}>Import Salas PDF</button>
              <div className="mobile-action-divider" />
              <button className="mobile-action-item" onClick={() => { setShowMobileMenu(false); handleSaveDraft(); }} disabled={saveLoading}>
                Save Draft
              </button>
              {loads && <>
                <button className="mobile-action-item" onClick={() => { setShowMobileMenu(false); saveProject(); }} disabled={saveLoading}>Save</button>
                <button className="mobile-action-item" onClick={() => { setShowMobileMenu(false); openSaveAs(); }}>Save As…</button>
                <div className="mobile-action-divider" />
                <button className="mobile-action-item" onClick={() => { setShowMobileMenu(false); startAirflowWizard(); }} disabled={exportLoading}>Airflow Wizard…</button>
                {projectId
                  ? <a className="mobile-action-item" href={`/api/projects/${projectId}/airflow`} onClick={() => setShowMobileMenu(false)}>Airflow Sheet</a>
                  : <button className="mobile-action-item" onClick={() => { setShowMobileMenu(false); exportAirflowSheet(); }}>Airflow Sheet</button>
                }
                {projectId && <a className="mobile-action-item" href={`/api/projects/${projectId}/report`} onClick={() => setShowMobileMenu(false)}>PDF Report</a>}
              </>}
            </div>
          </div>
        )}

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
            <small>{worstCase ? `${number(worstCase.loads.whole_house_sensible_cooling)} cool · ${number(worstCase.loads.whole_house_heating)} heat` : "Run Calculate"}</small>
          </article>
        </section>
        {validationMessage && <div className="validation-message">{validationMessage}</div>}

        <section id="section-project-settings" data-section="project-settings" className="panel form-panel">
          <div className="panel-head">
            <h3>Project Settings</h3>
          </div>
          {/* Required fields — always visible */}
          <div className="form-grid">
            <label className={showFieldErrors && !project.name?.trim() ? "field-error" : ""}>
              Name <span className="required-star">*</span>
              <input value={project.name} onChange={(event) => updateProject("name", event.target.value)} />
            </label>
            <label className={showFieldErrors && !project.location?.trim() ? "field-error" : ""}>
              Location <span className="required-star">*</span>
              <input value={project.location} onChange={(event) => updateProject("location", event.target.value)} />
            </label>
            <label className={showFieldErrors && !project.building_type ? "field-error" : ""}>
              Building type <span className="required-star">*</span>
              <select value={project.building_type} onChange={(event) => updateProject("building_type", event.target.value as "single_family" | "townhouse")}>
                <option value="single_family">Single-family detached</option>
                <option value="townhouse">Townhome</option>
              </select>
            </label>
            <label className={showFieldErrors && !project.front_door_faces ? "field-error" : ""}>
              Front door faces <span className="required-star">*</span>
              <select value={project.front_door_faces} onChange={(event) => updateProject("front_door_faces", event.target.value as CompassDirection)}>
                {compassDirections.map((direction) => <option key={direction} value={direction}>{compassArrows[direction]} {direction}</option>)}
              </select>
            </label>
            <label className={showFieldErrors && !project.bedrooms ? "field-error" : ""}>
              Bedrooms <span className="required-star">*</span>
              <input type="number" step="1" value={project.bedrooms} onChange={(event) => updateProject("bedrooms", Number(event.target.value))} />
            </label>
            <label className={showFieldErrors && !project.ach50 ? "field-error" : ""}>
              ACH50 <span className="required-star">*</span>
              <input type="number" step="0.1" value={project.ach50} onChange={(event) => updateProject("ach50", Number(event.target.value))} />
            </label>
            <label className={showFieldErrors && !project.seer ? "field-error" : ""}>
              SEER <span className="required-star">*</span>
              <input type="number" step="0.1" value={project.seer} onChange={(event) => updateProject("seer", Number(event.target.value))} />
            </label>
          </div>

          {/* Advanced settings toggle */}
          <div className="advanced-settings-toggle">
            <button className="link-button" onClick={() => togglePanel("advanced-settings")}>
              {collapsedPanels.has("advanced-settings") ? "▶ Advanced settings" : "▼ Advanced settings"}
            </button>
          </div>

          {!collapsedPanels.has("advanced-settings") && (
            <div className="form-grid advanced-settings-grid">
              <label>Description<input value={project.description} onChange={(event) => updateProject("description", event.target.value)} /></label>
              <label>Cooling outdoor DB<input type="number" step="0.1" value={project.outdoor_cooling_db} onChange={(event) => updateProject("outdoor_cooling_db", Number(event.target.value))} /></label>
              <label>Cooling indoor DB<input type="number" step="0.1" value={project.indoor_cooling_db} onChange={(event) => updateProject("indoor_cooling_db", Number(event.target.value))} /></label>
              <label>Heating outdoor DB<input type="number" step="0.1" value={project.outdoor_heating_db} onChange={(event) => updateProject("outdoor_heating_db", Number(event.target.value))} /></label>
              <label>Heating indoor DB<input type="number" step="0.1" value={project.indoor_heating_db} onChange={(event) => updateProject("indoor_heating_db", Number(event.target.value))} /></label>
              <label>Cooling safety factor %<input type="number" step="1" value={Math.round((project.cooling_safety_factor - 1) * 100)} onChange={(event) => updateProject("cooling_safety_factor", 1 + Number(event.target.value) / 100)} /></label>
              <label>Heating safety factor %<input type="number" step="1" value={Math.round((project.heating_safety_factor - 1) * 100)} onChange={(event) => updateProject("heating_safety_factor", 1 + Number(event.target.value) / 100)} /></label>
              <label className="check-field">Mechanical ventilation
                <input type="checkbox" checked={project.mechanical_ventilation} onChange={(event) => {
                  const on = event.target.checked;
                  setProject((current) => ({
                    ...current,
                    mechanical_ventilation: on,
                    ventilation_cfm: on && !current.ventilation_cfm ? 15 * ((current.bedrooms || 0) + 1) : current.ventilation_cfm,
                  }));
                  setLoads(null);
                  setWorstCase(null);
                  setIsDirty(true);
                }} />
              </label>
              {project.mechanical_ventilation && (
                <label>Ventilation CFM<input type="number" step="1" value={project.ventilation_cfm} onChange={(event) => updateProject("ventilation_cfm", Number(event.target.value))} /></label>
              )}
              <label>Floor area<input type="number" step="0.1" value={project.level.floor_area} onChange={(event) => updateLevel("floor_area", Number(event.target.value))} /></label>
              <label>Calculated volume<input type="number" value={Math.round(calculatedLevelVolume || project.level.volume)} readOnly /></label>
              <label>Total selected tons<input type="number" value={selectedSystemTons} readOnly /></label>
              <label>Total selected kW<input type="number" value={selectedSystemKw} readOnly /></label>
              <label className="check-field">Auto infiltration<input type="checkbox" checked={project.level.auto_infiltration} onChange={(event) => updateLevel("auto_infiltration", event.target.checked)} /></label>
            </div>
          )}
        </section>

        <section id="section-envelope-assemblies" data-section="envelope-assemblies" className="panel">
          <div className="panel-head">
            <h3>Envelope Assemblies</h3>
            <div className="button-row">
              {!collapsedPanels.has("type-inputs") && <button onClick={addTypeDefinition}>Add Type</button>}
              {!collapsedPanels.has("type-inputs") && <button onClick={loadAssemblyLibrary} disabled={assemblyLibraryLoading}>{assemblyLibraryLoading ? "Loading..." : "Refresh Library"}</button>}
              <button className="panel-toggle" onClick={() => togglePanel("type-inputs")}>{collapsedPanels.has("type-inputs") ? "Show ▾" : "Hide ▴"}</button>
            </div>
          </div>
          {!collapsedPanels.has("type-inputs") && <>
            <div className="assembly-library-panel">
              <div className="assembly-library-head">
                <label>Shared library search
                  <input
                    value={assemblySearch}
                    placeholder="Search description, U-value, SHGC"
                    onChange={(event) => setAssemblySearch(event.target.value)}
                  />
                </label>
                <span>{assemblies.length} saved</span>
              </div>
              <p className="assembly-library-hint">
                Click Use to choose a project slot like W1, W2, or G1, or create the next available slot.
              </p>
              {assemblyLibraryError && <p className="modal-error">{assemblyLibraryError}</p>}
              <div className="assembly-library-list">
                {filteredAssemblies.slice(0, 8).map((assembly) => (
                  <div className="assembly-library-row" key={assemblyRowKey(assembly)}>
                    <strong>{codeCategory(assembly.code)}</strong>
                    <span>{assembly.label}</span>
                    <em>U {assembly.u_value ?? "-"}{assembly.shgc != null ? ` / SHGC ${assembly.shgc}` : ""}</em>
                    <button onClick={() => setPendingAssemblyAssignment(assembly)}>Use</button>
                  </div>
                ))}
                {!filteredAssemblies.length && <p className="modal-empty">{assemblyLibraryLoading ? "Loading library..." : "No shared components found."}</p>}
              </div>
            </div>
            <div className="component-table-wrap">
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
                  {project.type_definitions.map((definition, index) => {
                    const saveKey = `${index}-${definition.code.trim().toUpperCase()}`;
                    return (
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
                        <td>
                          <div className="assembly-row-actions">
                            <button onClick={() => setAssemblyTargetIndex(index)}>Select Slot</button>
                            <button onClick={() => saveTypeDefinitionToLibrary(definition, index)} disabled={savingAssemblyKey === saveKey}>
                              {savingAssemblyKey === saveKey ? "Saving..." : "Save to Library"}
                            </button>
                            <button onClick={() => removeTypeDefinition(index)}>Remove</button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>}
        </section>

        <section id="section-units-zones" data-section="units-zones" className="panel">
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

        <section id="section-rooms" data-section="rooms" className="panel rooms-panel">
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
              <div id={`room-card-${index}`} className="room-card" key={index}>
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
                  <button className="danger-button" onClick={() => setConfirmModal({ message: `Remove ${room.name} and all its components?`, onConfirm: () => removeRoom(index) })}>Remove Room</button>
                </div>
                  <div className="room-card-body">
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
                      )) : <p className="room-no-components">No components yet.</p>}
                    </div>
                    {/* + Add Component picker */}
                    <div className="add-component-row">
                      {addComponentRoom === room.name ? (
                        <div className="add-component-picker">
                          <span className="add-component-label">Add:</span>
                          {(["Wall","Glass","Ceiling","Floor","Door"] as TypeCategory[]).map((cat) => (
                            <button key={cat} className="add-component-chip" onClick={() => { addRoomComponent(room.name, cat); setAddComponentRoom(null); }}>{cat}</button>
                          ))}
                          <button className="add-component-chip" onClick={() => { addRoomComponent(room.name, "Person"); setAddComponentRoom(null); }}>People</button>
                          <button className="add-component-chip" onClick={() => { addRoomComponent(room.name, "Appliance"); setAddComponentRoom(null); }}>Appliance</button>
                          <button className="add-component-cancel" onClick={() => setAddComponentRoom(null)}>✕</button>
                        </div>
                      ) : (
                        <button className="add-component-btn" onClick={() => setAddComponentRoom(room.name)}>+ Add Component</button>
                      )}
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
          <section id="section-salas-comparison" data-section="salas-comparison" className="panel comparison-panel">
            <div className="panel-head">
              <h3>Salas O'Brien Comparison</h3>
              <p>{loads ? "Imported reference values compared with the current calculation" : "Imported reference values loaded. Run Calculate to compare current results."}</p>
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

        <section id="section-load-summary" data-section="load-summary" className="panel">
          <div className="panel-head">
            <h3>Load Summary</h3>
            <p>{activeLevel ? "Unit loads and selected system capacities" : "Run Calculate"}</p>
          </div>

          {/* Mobile-only summary: tons + CFM per unit */}
          {loads && (
            <div className="mobile-load-summary">
              {unitLoadSummaries.map((summary) => (
                <div className="mobile-unit-card" key={summary.unit.id}>
                  <div className="mobile-unit-name">{summary.unit.name}</div>
                  <div className="mobile-unit-stats">
                    <div className="mobile-unit-stat">
                      <span className="mobile-stat-label">Selected</span>
                      <strong className="mobile-stat-value">{decimal(Number(summary.unit.selected_tons ?? 0), 1)} tons</strong>
                    </div>
                    <div className="mobile-unit-stat">
                      <span className="mobile-stat-label">Min required</span>
                      <strong className="mobile-stat-value">{decimal(summary.tonsMin, 2)} tons</strong>
                    </div>
                    <div className="mobile-unit-stat">
                      <span className="mobile-stat-label">Airflow</span>
                      <strong className="mobile-stat-value">{number(summary.cfm)} CFM</strong>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Desktop full table */}
          <div className="load-summary-wrap desktop-only">
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
            <p>{activeLevel ? `${number(activeLevel.cooling_subtotal)} cooling subtotal · ${number(activeLevel.heating_subtotal)} heating subtotal` : "Run Calculate"}</p>
          </div>

          {/* Mobile airflow view */}
          {activeLevel && (
            <div className="mobile-room-results">
              {unitLoadSummaries.map((summary, unitIndex) => (
                <div key={summary.unit.id} className="mobile-room-results-unit">
                  <div className="mobile-room-results-unit-head">Unit {unitIndex + 1} — {summary.unit.name}</div>
                  {summary.rooms.map(({ result }) => (
                    <div key={result.name} className="mobile-room-result-row">
                      <span className="mobile-room-result-name">{result.name}</span>
                      <div className="mobile-room-result-cfm">
                        <span><label>Cool</label>{result.cfm_cool || "—"}</span>
                        <span><label>Heat</label>{result.cfm_heat || "—"}</span>
                        <span><label>Avg</label>{result.cfm_avg || "—"}</span>
                      </div>
                    </div>
                  ))}
                  <div className="mobile-room-result-row mobile-room-result-total">
                    <span className="mobile-room-result-name">Total</span>
                    <div className="mobile-room-result-cfm">
                      <span><label>Cool</label>{number(summary.rooms.reduce((s, r) => s + r.result.cfm_cool, 0))}</span>
                      <span><label>Heat</label>{number(summary.rooms.reduce((s, r) => s + r.result.cfm_heat, 0))}</span>
                      <span><label>Avg</label>{number(summary.rooms.reduce((s, r) => s + r.result.cfm_avg, 0))}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          <table className="desktop-only">
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
        <div className="modal-backdrop open-dialog-backdrop" onClick={() => setShowOpenDialog(false)}>
          <div className="modal open-dialog-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Open Project</h2>
              <button className="modal-close" onClick={() => setShowOpenDialog(false)}>✕</button>
            </div>
            {openDialogLoading && <p className="modal-empty">Loading…</p>}
            {openDialogError && <p className="modal-error">{openDialogError}</p>}
            {!openDialogLoading && !openDialogError && savedProjects.length === 0 && (
              <p className="modal-empty">No saved projects yet. Use Save to save your first project.</p>
            )}
            {!openDialogLoading && savedProjects.length > 0 && (<>
              {/* Desktop table */}
              <table className="project-list-table desktop-only">
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
              {/* Mobile card list */}
              <div className="project-card-list">
                {savedProjects.map((p) => (
                  <div key={p.id} className={`project-card${p.id === projectId ? " project-card-active" : ""}`}>
                    <button className="project-card-name" onClick={() => loadSavedProject(p.id)}>
                      {p.name}{p.description ? ` – ${p.description}` : ""}
                    </button>
                    <div className="project-card-meta">
                      <span>{p.location}</span>
                      <span>{p.updated_at.slice(0, 10)}</span>
                    </div>
                    <button className="project-card-delete danger-button" onClick={() => deleteSavedProject(p.id)}>Delete</button>
                  </div>
                ))}
              </div>
            </>)}
          </div>
        </div>
      )}

      {pendingAssemblyAssignment && (
        <div className="modal-backdrop" onClick={() => setPendingAssemblyAssignment(null)}>
          <div className="modal assembly-assign-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h2>Assign Component</h2>
              <button className="modal-close" onClick={() => setPendingAssemblyAssignment(null)}>x</button>
            </div>
            <p className="assembly-library-hint">
              {codeCategory(pendingAssemblyAssignment.code)} · U {pendingAssemblyAssignment.u_value ?? "-"}
              {pendingAssemblyAssignment.shgc != null ? ` / SHGC ${pendingAssemblyAssignment.shgc}` : ""} · {pendingAssemblyAssignment.label}
            </p>
            <div className="assembly-assign-list">
              {pendingAssemblySlots.map(({ definition, index }) => (
                <button key={`${definition.code}-${index}`} onClick={() => applyLibraryAssembly(pendingAssemblyAssignment, index)}>
                  Use {definition.code || `Type ${index + 1}`} - {compactTypeDescription(definition.description) || definition.category}
                </button>
              ))}
              <button className="toolbar-primary" onClick={() => applyLibraryAssembly(pendingAssemblyAssignment, "new")}>
                Create {pendingAssemblyCategory ? nextSlotCode(pendingAssemblyCategory, project.type_definitions) : "New Slot"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Confirm modal ───────────────────────────────────────────────────── */}
      {confirmModal && (
        <div className="modal-backdrop" onClick={() => setConfirmModal(null)}>
          <div className="modal confirm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Confirm</h2>
              <button className="modal-close" onClick={() => setConfirmModal(null)}>✕</button>
            </div>
            <p className="confirm-body">{confirmModal.message}</p>
            <div className="confirm-actions">
              <button className="danger-button" onClick={() => { const fn = confirmModal.onConfirm; setConfirmModal(null); fn(); }}>Confirm</button>
              <button onClick={() => setConfirmModal(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Save As modal ───────────────────────────────────────────────────── */}
      {saveAsOpen && (
        <div className="modal-backdrop" onClick={() => { setSaveAsOpen(false); setSaveAsConflict(null); }}>
          <div className="modal save-as-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Save As</h2>
              <button className="modal-close" onClick={() => { setSaveAsOpen(false); setSaveAsConflict(null); }}>✕</button>
            </div>
            {saveAsConflict ? (
              <>
                <p className="conflict-body">
                  A project named <strong>{saveAsConflict.name}</strong> already exists (last saved {saveAsConflict.updated_at.slice(0, 16).replace("T", " ")}).
                </p>
                <div className="conflict-actions">
                  <div className="conflict-action-card" onClick={() => commitSaveAs(saveAsName.trim(), saveAsConflict.id)}>
                    <strong>Overwrite</strong>
                    <span>Replace the existing project with this one.</span>
                  </div>
                  <div className="conflict-action-card" onClick={() => { setSaveAsConflict(null); }}>
                    <strong>Rename</strong>
                    <span>Go back and choose a different name.</span>
                  </div>
                  <div className="conflict-action-card conflict-action-cancel" onClick={() => { setSaveAsOpen(false); setSaveAsConflict(null); }}>
                    <strong>Cancel</strong>
                    <span>Return to the project without saving.</span>
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="save-as-field">
                  <label>Project name
                    <input
                      autoFocus
                      value={saveAsName}
                      onChange={(e) => setSaveAsName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") handleSaveAsConfirm(); }}
                    />
                  </label>
                </div>
                <div className="confirm-actions">
                  <button onClick={handleSaveAsConfirm} disabled={saveAsLoading || !saveAsName.trim()}>
                    {saveAsLoading ? "Saving…" : "Save"}
                  </button>
                  <button onClick={() => { setSaveAsOpen(false); setSaveAsConflict(null); }}>Cancel</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Bulk PDF import modal ──────────────────────────────────────────── */}
      {bulkPdfModal && (
        <div className="modal-backdrop" onClick={() => { if (!bulkPdfImporting) setBulkPdfModal(false); }}>
          <div className="modal" style={{ maxWidth: 540, width: "100%" }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Bulk Import</h2>
              {!bulkPdfImporting && (
                <button className="modal-close" onClick={() => setBulkPdfModal(false)}>✕</button>
              )}
            </div>
            {bulkPdfImporting && (
              <div style={{ padding: "16px 0" }}>
                <div style={{ marginBottom: 8, fontSize: 14, color: "#555" }}>
                  Importing {bulkPdfProgress.done} of {bulkPdfProgress.total}…
                </div>
                <div style={{ height: 6, background: "#e5e7eb", borderRadius: 3, overflow: "hidden" }}>
                  <div style={{ height: "100%", background: "#2563eb", borderRadius: 3, width: `${(bulkPdfProgress.done / bulkPdfProgress.total) * 100}%`, transition: "width 0.2s" }} />
                </div>
              </div>
            )}
            {!bulkPdfImporting && bulkPdfProgress.results.length > 0 && (
              <div style={{ marginTop: 8, maxHeight: 360, overflowY: "auto" }}>
                {bulkPdfProgress.results.map((r, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "6px 0", borderBottom: "1px solid #f0f0f0", fontSize: 13 }}>
                    <span style={{ fontSize: 15, flexShrink: 0 }}>{r.ok ? "✓" : "✗"}</span>
                    <div>
                      <div style={{ fontWeight: 600, color: r.ok ? "#16a34a" : "#dc2626" }}>
                        {r.plan_name ?? r.filename}
                      </div>
                      {r.error && <div style={{ color: "#dc2626" }}>{r.error}</div>}
                      {r.warnings?.map((w, j) => <div key={j} style={{ color: "#b45309" }}>{w}</div>)}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {!bulkPdfImporting && (
              <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button onClick={() => setBulkPdfModal(false)}>Close</button>
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}

// ── Project Library ───────────────────────────────────────────────────────────

const PAGE_SIZE = 50;

function ProjectLibrary({ onOpen }: { onOpen: (id: number, row: SavedProject) => void }) {
  const [rows, setRows] = useState<SavedProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filterBuilder, setFilterBuilder] = useState("");
  const [filterFoundation, setFilterFoundation] = useState("");
  const [filterSource, setFilterSource] = useState("");
  const [page, setPage] = useState(1);
  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetch("/api/projects")
      .then((r) => r.json())
      .then((data: SavedProject[]) => { setRows(data); setLoading(false); })
      .catch(() => { setError("Could not load projects."); setLoading(false); });
  }, []);

  const builders = useMemo(() => {
    const s = new Set(rows.map((r) => r.builder_name).filter(Boolean));
    return Array.from(s).sort();
  }, [rows]);

  const foundations = useMemo(() => {
    const s = new Set(rows.map((r) => r.foundation ?? "").filter(Boolean));
    return Array.from(s).sort();
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (filterBuilder && r.builder_name !== filterBuilder) return false;
      if (filterFoundation && (r.foundation ?? "") !== filterFoundation) return false;
      if (filterSource && r.source !== filterSource) return false;
      if (q) {
        const hay = `${r.builder_name} ${r.plan_name} ${r.project_name} ${r.name}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, search, filterBuilder, filterFoundation, filterSource]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  useEffect(() => { setPage(1); }, [search, filterBuilder, filterFoundation, filterSource]);

  function clearFilters() {
    setSearch("");
    setFilterBuilder("");
    setFilterFoundation("");
    setFilterSource("");
  }

  async function handleDelete(id: number) {
    setDeleting(true);
    try {
      await fetch(`/api/projects/${id}`, { method: "DELETE" });
      setRows((current) => current.filter((r) => r.id !== id));
    } finally {
      setDeleting(false);
      setDeleteConfirm(null);
    }
  }

  function sourceLabel(source: string) {
    if (source === "salas_import") return "Salas Import";
    if (source === "test_battery") return "Test Battery";
    return "VRC";
  }

  function planLabel(row: SavedProject) {
    const parts = [row.plan_name || row.name, row.elevation, row.foundation].filter(Boolean);
    return parts.join(" · ");
  }

  const hasFilters = search || filterBuilder || filterFoundation || filterSource;

  return (
    <main className="admin-root">
      <div className="admin-topbar">
        <div className="admin-topbar-row">
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <a href="#" className="admin-btn admin-btn-outline" style={{ textDecoration: "none" }}>← Back</a>
            <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Projects</h1>
          </div>
        </div>
        <div className="admin-topbar-row" style={{ flexWrap: "wrap", gap: 8 }}>
          <input
            className="admin-setting-input"
            type="search"
            placeholder="Search builder, plan, project…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: 260, flexShrink: 0 }}
          />
          <select
            className="admin-setting-input"
            value={filterBuilder}
            onChange={(e) => setFilterBuilder(e.target.value)}
            style={{ width: 180, flexShrink: 0 }}
          >
            <option value="">All builders</option>
            {builders.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
          <select
            className="admin-setting-input"
            value={filterFoundation}
            onChange={(e) => setFilterFoundation(e.target.value)}
            style={{ width: 150, flexShrink: 0 }}
          >
            <option value="">All foundations</option>
            {foundations.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
          <select
            className="admin-setting-input"
            value={filterSource}
            onChange={(e) => setFilterSource(e.target.value)}
            style={{ width: 160, flexShrink: 0 }}
          >
            <option value="">All sources</option>
            <option value="vrc">VRC</option>
            <option value="salas_import">Salas Import</option>
            <option value="test_battery">Test Battery</option>
          </select>
          {hasFilters && (
            <button className="admin-btn admin-btn-outline" onClick={clearFilters}>Clear</button>
          )}
        </div>
      </div>

      {loading && <p style={{ padding: "32px 24px", color: "#888" }}>Loading…</p>}
      {error && <p style={{ padding: "32px 24px", color: "#c0392b" }}>{error}</p>}

      {!loading && !error && (
        <>
          <div style={{ padding: "8px 24px", fontSize: 13, color: "#888" }}>
            {filtered.length === rows.length
              ? `${rows.length} project${rows.length !== 1 ? "s" : ""}`
              : `${filtered.length} of ${rows.length} projects`}
          </div>

          <div style={{ overflowX: "auto", padding: "0 24px 24px" }}>
            {filtered.length === 0 ? (
              <p style={{ color: "#888", marginTop: 32 }}>
                {hasFilters ? "No projects match the current filters." : "No saved projects yet."}
              </p>
            ) : (
              <table className="battery-table" style={{ width: "100%" }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left" }}>Plan</th>
                    <th style={{ textAlign: "left" }}>Builder</th>
                    <th style={{ textAlign: "left" }}>Foundation</th>
                    <th style={{ textAlign: "left" }}>Source</th>
                    <th style={{ textAlign: "left" }}>Last Saved</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((row) => (
                    <tr key={row.id} style={{ cursor: "pointer" }}>
                      <td>
                        <button
                          className="link-button"
                          style={{ fontWeight: 600, textAlign: "left" }}
                          onClick={() => onOpen(row.id, row)}
                        >
                          {planLabel(row) || `Project #${row.id}`}
                        </button>
                      </td>
                      <td style={{ color: "#555" }}>{row.builder_name || "—"}</td>
                      <td style={{ color: "#555" }}>{row.foundation || "—"}</td>
                      <td>
                        <span style={{
                          display: "inline-block",
                          padding: "2px 8px",
                          borderRadius: 4,
                          fontSize: 11,
                          fontWeight: 600,
                          background: row.source === "salas_import" ? "#e8f4fd" : row.source === "test_battery" ? "#fdf3e8" : "#f0f0f0",
                          color: row.source === "salas_import" ? "#2980b9" : row.source === "test_battery" ? "#d68910" : "#555",
                        }}>
                          {sourceLabel(row.source)}
                        </span>
                      </td>
                      <td style={{ color: "#888", fontSize: 13 }}>
                        {row.updated_at.slice(0, 10)}
                      </td>
                      <td>
                        {deleteConfirm === row.id ? (
                          <span style={{ display: "flex", gap: 6 }}>
                            <button
                              className="admin-btn admin-btn-danger"
                              onClick={() => handleDelete(row.id)}
                              disabled={deleting}
                            >
                              {deleting ? "Deleting…" : "Confirm"}
                            </button>
                            <button
                              className="admin-btn admin-btn-outline"
                              onClick={() => setDeleteConfirm(null)}
                              disabled={deleting}
                            >
                              Cancel
                            </button>
                          </span>
                        ) : (
                          <button
                            className="admin-btn admin-btn-danger"
                            onClick={() => setDeleteConfirm(row.id)}
                          >
                            Delete
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {totalPages > 1 && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 24px 32px", fontSize: 13 }}>
              <button
                className="admin-btn admin-btn-outline"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={safePage === 1}
              >
                ←
              </button>
              <span style={{ color: "#555" }}>Page {safePage} of {totalPages}</span>
              <button
                className="admin-btn admin-btn-outline"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={safePage === totalPages}
              >
                →
              </button>
            </div>
          )}
        </>
      )}
    </main>
  );
}

// ── Admin panel types ─────────────────────────────────────────────────────────

interface BatteryRow {
  id: number;
  name: string;
  plan_name: string;
  builder_name: string;
  elevation: string | null;
  foundation: string | null;
  orientation: string | null;
  variations: string | null;
  salas_reference_orientation: string | null;
  import_fidelity_passed: boolean | null;
  import_fidelity_details: Record<string, unknown> | null;
  comparison_snapshot: ComparisonSnapshot | null;
  parent_id: number | null;
  source: string;
  updated_at: string;
  payload_json: Record<string, unknown>;
}

interface ComparisonSnapshot {
  computed_at: string;
  system: {
    vrc_cooling_btuh: number;
    salas_cooling_btuh: number | null;
    vrc_heating_btuh: number;
    salas_heating_btuh: number | null;
    vrc_min_tons: number;
    salas_min_tons: number | null;
  };
  rooms: Array<{
    name: string;
    vrc_cooling: number;
    salas_cooling: number | null;
    vrc_heating: number;
    salas_heating: number | null;
  }>;
}

interface AdminSettings {
  tolerancePct: number;
  toleranceBtuh: number;
  accuracyThreshold: number;
}

interface RecomputeResult {
  id: number;
  snapshot: ComparisonSnapshot | null;
}

interface EligibleRow {
  id: number;
  name: string;
  plan_name: string;
  builder_name: string;
  elevation: string | null;
  foundation: string | null;
  orientation: string | null;
  variations: string | null;
  comparison_snapshot: ComparisonSnapshot | null;
  import_fidelity_details: Record<string, unknown> | null;
  payload_json?: Record<string, unknown>;
}

// ── Admin panel helpers ───────────────────────────────────────────────────────

function fmtBtuh(n: number): string {
  return n >= 0 ? `+${n.toLocaleString()}` : n.toLocaleString();
}
function fmtPct(n: number): string {
  return (n >= 0 ? "+" : "") + n.toFixed(1) + "%";
}
function fmtTons(n: number): string {
  return (n >= 0 ? "+" : "") + n.toFixed(2);
}

function coolingDelta(snap: ComparisonSnapshot): number | null {
  if (snap.system.salas_cooling_btuh == null) return null;
  return snap.system.vrc_cooling_btuh - snap.system.salas_cooling_btuh;
}
function heatingDelta(snap: ComparisonSnapshot): number | null {
  if (snap.system.salas_heating_btuh == null) return null;
  return snap.system.vrc_heating_btuh - snap.system.salas_heating_btuh;
}
function tonsDelta(snap: ComparisonSnapshot): number | null {
  if (snap.system.salas_min_tons == null) return null;
  return snap.system.vrc_min_tons - snap.system.salas_min_tons;
}

function isAccurate(snap: ComparisonSnapshot, threshold: number): boolean {
  const cd = coolingDelta(snap);
  const hd = heatingDelta(snap);
  if (cd == null || hd == null) return false;
  return Math.abs(cd) <= threshold && Math.abs(hd) <= threshold;
}

function roomOutliers(snap: ComparisonSnapshot, tolPct: number, tolBtuh: number): number {
  return snap.rooms.filter((r) => {
    const cd = r.salas_cooling != null ? Math.abs(r.vrc_cooling - r.salas_cooling) : 0;
    const hd = r.salas_heating != null ? Math.abs(r.vrc_heating - r.salas_heating) : 0;
    const cOver = r.salas_cooling != null && (cd > tolBtuh && cd / r.salas_cooling * 100 > tolPct);
    const hOver = r.salas_heating != null && (hd > tolBtuh && hd / r.salas_heating * 100 > tolPct);
    return cOver || hOver;
  }).length;
}

function adminPlanLabel(row: {
  name?: string | null;
  plan_name?: string | null;
  elevation?: string | null;
  foundation?: string | null;
  orientation?: string | null;
  variations?: string | null;
  payload_json?: Record<string, unknown>;
}): string {
  const sourceFilename = (row.payload_json as any)?.project?.metadata?.source_filename;
  if (typeof sourceFilename === "string" && sourceFilename.trim()) return sourceFilename.trim();

  const base = row.plan_name?.trim() || row.name?.trim() || "";
  const details = [row.elevation, row.foundation, row.orientation, row.variations]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  const missingDetails = details.filter((part) => !base.toLowerCase().includes(part.toLowerCase()));
  return [base, ...missingDetails].filter(Boolean).join(" ").trim();
}

type ChangeDir = "improved" | "regressed" | "unchanged" | null;

function changeDir(
  oldSnap: ComparisonSnapshot | null,
  newSnap: ComparisonSnapshot | null,
  metric: "cooling" | "heating" | "tons"
): ChangeDir {
  if (!oldSnap || !newSnap) return null;
  const oldD =
    metric === "cooling" ? coolingDelta(oldSnap)
    : metric === "heating" ? heatingDelta(oldSnap)
    : tonsDelta(oldSnap);
  const newD =
    metric === "cooling" ? coolingDelta(newSnap)
    : metric === "heating" ? heatingDelta(newSnap)
    : tonsDelta(newSnap);
  if (oldD == null || newD == null) return null;
  const diff = Math.abs(newD) - Math.abs(oldD);
  if (Math.abs(diff) < 0.001 * Math.abs(oldD || 1)) return "unchanged";
  return diff < 0 ? "improved" : "regressed";
}

function ChangePill({ dir }: { dir: ChangeDir }) {
  if (!dir) return null;
  const cls = dir === "improved" ? "change-improved" : dir === "regressed" ? "change-regressed" : "change-unchanged";
  const label = dir === "improved" ? "↑ Better" : dir === "regressed" ? "↓ Worse" : "— Same";
  return <span className={`change-indicator ${cls}`}>{label}</span>;
}

function DeltaCell({
  delta,
  salas,
  unit,
}: {
  delta: number | null;
  salas: number | null;
  unit: "pct" | "btuh";
}) {
  if (delta == null || salas == null) return <td className="delta-cell">—</td>;
  const pct = salas !== 0 ? delta / salas * 100 : 0;
  const color =
    Math.abs(delta) <= 50 ? "var(--green)"
    : Math.abs(pct) <= 5 ? "var(--text)"
    : "var(--amber)";
  return (
    <td className="delta-cell" style={{ color }}>
      {unit === "pct" ? fmtPct(pct) : fmtBtuh(delta)}
    </td>
  );
}

/** Returns badges for area/volume/room-count mismatches. Orientation mismatch is a hard block so never shown here. */
function FidelityBadges({ details }: { details: Record<string, unknown> | null | undefined }) {
  if (!details) return null;
  const badges: React.ReactNode[] = [];
  if (details.floor_area_match === false) {
    badges.push(
      <span key="area" className="badge badge-amber" style={{ fontSize: 10 }}
        title={`Area: VRC ${details.vrc_floor_area} sf vs Salas ${details.salas_floor_area} sf`}>
        Area Δ
      </span>
    );
  }
  if (details.volume_match === false) {
    badges.push(
      <span key="vol" className="badge badge-amber" style={{ fontSize: 10 }}
        title={`Volume: VRC ${details.vrc_volume} cf vs Salas ${details.salas_volume} cf`}>
        Vol Δ
      </span>
    );
  }
  if (details.room_count_match === false) {
    badges.push(
      <span key="rooms" className="badge badge-amber" style={{ fontSize: 10 }}
        title={`Rooms: VRC ${details.vrc_room_count} vs Salas ${details.salas_room_count}`}>
        Rooms Δ
      </span>
    );
  }
  return <>{badges}</>;
}

// ── Admin panel component ─────────────────────────────────────────────────────

function AdminPanel() {
  const [battery, setBattery] = useState<BatteryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [view, setView] = useState<"table" | "columns">("table");
  const [unit, setUnit] = useState<"pct" | "btuh">("pct");
  const [filter, setFilter] = useState<"battery" | "all" | "salas">("battery");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<AdminSettings>({
    tolerancePct: 5,
    toleranceBtuh: 200,
    accuracyThreshold: 50,
  });

  const [sortCol, setSortCol] = useState<string>("plan_name");
  const [sortAsc, setSortAsc] = useState(true);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const [recomputed, setRecomputed] = useState<Map<number, ComparisonSnapshot | null>>(new Map());
  const [recomputeTime, setRecomputeTime] = useState<string | null>(null);
  const [recomputeLoading, setRecomputeLoading] = useState(false);

  const [showAddModal, setShowAddModal] = useState(false);
  const [eligible, setEligible] = useState<EligibleRow[]>([]);
  const [eligibleSearch, setEligibleSearch] = useState("");
  const [eligibleSelected, setEligibleSelected] = useState<Set<number>>(new Set());
  const [addingBattery, setAddingBattery] = useState(false);

  const [removeConfirm, setRemoveConfirm] = useState<number | null>(null);

  const [saveLoading, setSaveLoading] = useState(false);
  const [exportLoading, setExportLoading] = useState(false);
  const [exportLabel, setExportLabel] = useState("");
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  // Bulk import state
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [bulkFiles, setBulkFiles] = useState<File[]>([]);
  const [bulkImporting, setBulkImporting] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number; results: Array<{ filename: string; ok: boolean; plan_name?: string; replaced?: boolean; error?: string; warnings?: string[] }> }>({ done: 0, total: 0, results: [] });
  const bulkFileInput = useRef<HTMLInputElement>(null);

  // Delete all state
  const [showDeleteAllConfirm, setShowDeleteAllConfirm] = useState(false);
  const [deleteAllLoading, setDeleteAllLoading] = useState(false);

  async function loadBattery() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/battery");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setBattery(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load battery");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadBattery(); }, []);

  async function recomputeAll() {
    setRecomputeLoading(true);
    try {
      const projects = battery.map((r) => r.payload_json);
      const res = await fetch("/api/calculate/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projects }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const fresh = new Map<number, ComparisonSnapshot | null>();
      battery.forEach((row, i) => {
        const r = data.results[i];
        if (r?.ok) {
          // Build a mini snapshot from the fresh calc result and stored salas data
          const salas = (row.payload_json as any)?.project?.metadata?.salas_obrien_comparison;
          const house = salas?.house ?? {};
          const salasRooms: Record<string, { cooling_btuh?: number; heating_btuh?: number }> = {};
          for (const level of salas?.levels ?? []) {
            for (const rm of level.rooms ?? []) salasRooms[rm.name] = rm;
          }
          // Also support flat rooms dict (keyed by room name)
          if (salas?.rooms && typeof salas.rooms === "object" && !Array.isArray(salas.rooms)) {
            for (const [name, data] of Object.entries(salas.rooms as Record<string, any>)) {
              if (!(name in salasRooms)) salasRooms[name] = data;
            }
          }
          const res_data = r.result;
          const snap: ComparisonSnapshot = {
            computed_at: new Date().toISOString(),
            system: {
              vrc_cooling_btuh: res_data.whole_house_sensible_cooling ?? res_data.sensible_cooling ?? res_data.whole_house?.sensible_cooling ?? 0,
              salas_cooling_btuh: house.cooling_btuh ?? null,
              vrc_heating_btuh: res_data.whole_house_heating ?? res_data.heating ?? res_data.whole_house?.heating ?? 0,
              salas_heating_btuh: house.heating_btuh ?? null,
              vrc_min_tons: res_data.tons_min ?? res_data.whole_house?.tons_min ?? 0,
              salas_min_tons: house.min_tons ?? null,
            },
            rooms: (res_data.rooms ?? res_data.levels?.flatMap((l: any) => l.rooms ?? []) ?? []).map((rm: any) => ({
              name: rm.name,
              vrc_cooling: rm.cooling_btuh ?? 0,
              salas_cooling: salasRooms[rm.name]?.cooling_btuh ?? null,
              vrc_heating: rm.heating_btuh ?? 0,
              salas_heating: salasRooms[rm.name]?.heating_btuh ?? null,
            })),
          };
          fresh.set(row.id, snap);
        } else {
          fresh.set(row.id, null);
        }
      });
      setRecomputed(fresh);
      setRecomputeTime(new Date().toLocaleTimeString());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Recompute failed");
    } finally {
      setRecomputeLoading(false);
    }
  }

  async function saveSnapshots() {
    setSaveLoading(true);
    const updates = Array.from(recomputed.entries())
      .filter(([, v]) => v != null)
      .map(([id, snapshot]) => ({ id, snapshot }));
    try {
      const res = await fetch("/api/battery/snapshots/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatusMsg("Snapshots saved.");
      setRecomputed(new Map());
      setRecomputeTime(null);
      loadBattery();
    } catch (e) {
      setStatusMsg(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaveLoading(false);
    }
  }

  async function exportSnapshot() {
    setExportLoading(true);
    try {
      const exportBattery = battery.map((row) => (
        recomputed.has(row.id)
          ? { ...row, comparison_snapshot: recomputed.get(row.id) ?? row.comparison_snapshot }
          : row
      ));
      const res = await fetch("/api/battery/snapshot/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: exportLabel, battery: exportBattery }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const filenameMatch = disposition.match(/filename="(.+?)"/);
      const filename = filenameMatch ? filenameMatch[1] : "snapshot.json";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      setStatusMsg(`Exported: ${filename}`);
    } catch (e) {
      setStatusMsg(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExportLoading(false);
    }
  }

  const [detailReportLoading, setDetailReportLoading] = useState(false);
  const [glassAuditLoading, setGlassAuditLoading] = useState(false);
  const [residualAuditLoading, setResidualAuditLoading] = useState(false);
  async function exportDetailReport() {
    setDetailReportLoading(true);
    try {
      const res = await fetch("/api/battery/detail-report");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const filenameMatch = disposition.match(/filename="(.+?)"/);
      const filename = filenameMatch ? filenameMatch[1] : `detail-report-${new Date().toISOString().slice(0, 10)}.json`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      setStatusMsg(`Exported: ${filename}`);
    } catch (e) {
      setStatusMsg(e instanceof Error ? e.message : "Detail report export failed");
    } finally {
      setDetailReportLoading(false);
    }
  }

  async function exportGlassFactorAudit() {
    setGlassAuditLoading(true);
    try {
      const res = await fetch("/api/battery/glass-factor-audit");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const filenameMatch = disposition.match(/filename="(.+?)"/);
      const filename = filenameMatch ? filenameMatch[1] : `glass-factor-audit-${new Date().toISOString().slice(0, 10)}.json`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      setStatusMsg(`Exported: ${filename}`);
    } catch (e) {
      setStatusMsg(e instanceof Error ? e.message : "Glass audit export failed");
    } finally {
      setGlassAuditLoading(false);
    }
  }

  async function exportResidualAudit() {
    setResidualAuditLoading(true);
    try {
      const res = await fetch("/api/battery/residual-audit");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const filenameMatch = disposition.match(/filename="(.+?)"/);
      const filename = filenameMatch ? filenameMatch[1] : `residual-audit-${new Date().toISOString().slice(0, 10)}.json`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      setStatusMsg(`Exported: ${filename}`);
    } catch (e) {
      setStatusMsg(e instanceof Error ? e.message : "Residual audit export failed");
    } finally {
      setResidualAuditLoading(false);
    }
  }

  async function openAddModal() {
    setShowAddModal(true);
    setEligibleSelected(new Set());
    setEligibleSearch("");
    try {
      const res = await fetch("/api/battery/eligible");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setEligible(await res.json());
    } catch {
      setEligible([]);
    }
  }

  async function addSelected() {
    setAddingBattery(true);
    for (const id of eligibleSelected) {
      try {
        await fetch("/api/battery", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source_id: id }),
        });
      } catch {
        // continue on error
      }
    }
    setAddingBattery(false);
    setShowAddModal(false);
    loadBattery();
  }

  async function removeFromBattery(id: number) {
    try {
      await fetch(`/api/battery/${id}`, { method: "DELETE" });
    } catch {
      // ignore
    }
    setRemoveConfirm(null);
    loadBattery();
  }

  async function bulkImport() {
    if (bulkFiles.length === 0) return;
    setBulkImporting(true);
    const results: typeof bulkProgress.results = [];
    setBulkProgress({ done: 0, total: bulkFiles.length, results: [] });
    for (let i = 0; i < bulkFiles.length; i++) {
      const file = bulkFiles[i];
      try {
        // Step 1: Extract PDF to payload (existing endpoint)
        const b64 = await fileToBase64(file);
        const importRes = await fetch("/api/import/salas-pdf", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: file.name, data_base64: b64 }),
        });
        const importData = await importRes.json();
        if (!importRes.ok) {
          results.push({ filename: file.name, ok: false, error: importData.detail ?? "Import failed" });
          setBulkProgress({ done: i + 1, total: bulkFiles.length, results: [...results] });
          continue;
        }
        const payload = importData.payload;
        const warnings = importData.warnings ?? [];
        const planName = payload?.project?.plan_name ?? file.name;

        // Step 2: Check for existing duplicate and delete it
        let replaced = false;
        try {
          const existingRes = await fetch("/api/battery/eligible?search=" + encodeURIComponent(planName));
          const existingList: Array<{ id: number }> = await existingRes.json();
          // Also check non-eligible salas imports
          const allRes = await fetch("/api/projects");
          const allProjects: Array<{
            id: number;
            plan_name: string;
            foundation: string | null;
            elevation: string | null;
            orientation: string | null;
            variations: string | null;
            source: string;
          }> = await allRes.json();
          const pf = payload?.project?.foundation ?? null;
          const pe = payload?.project?.elevation ?? null;
          const po = payload?.project?.orientation ?? null;
          const pv = payload?.project?.variations ?? null;
          const dupes = allProjects.filter((p) =>
            p.source === "salas_import" && p.plan_name === planName &&
            (p.foundation ?? null) === pf && (p.elevation ?? null) === pe &&
            (p.orientation ?? null) === po && (p.variations ?? null) === pv
          );
          for (const dupe of dupes) {
            // Delete any battery copies first
            const batteryRes = await fetch("/api/battery");
            const batteryList: Array<{ id: number; parent_id: number | null }> = await batteryRes.json();
            const copies = batteryList.filter((b) => b.parent_id === dupe.id);
            for (const copy of copies) {
              await fetch(`/api/battery/${copy.id}`, { method: "DELETE" });
            }
            await fetch(`/api/projects/${dupe.id}`, { method: "DELETE" });
            replaced = true;
          }
        } catch {
          // Duplicate check failed, continue with import anyway
        }

        // Step 3: Save as project (auto-detects salas_import)
        const saveRes = await fetch("/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const saveData = await saveRes.json();
        if (!saveRes.ok) {
          results.push({ filename: file.name, ok: false, error: saveData.detail ?? "Save failed" });
          setBulkProgress({ done: i + 1, total: bulkFiles.length, results: [...results] });
          continue;
        }
        const sourceId = saveData.id;

        // Step 4: Add to battery
        const batteryRes = await fetch("/api/battery", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source_id: sourceId }),
        });
        const batteryData = await batteryRes.json();
        if (!batteryRes.ok) {
          // Saved but couldn't add to battery — still report as partial success
          results.push({ filename: file.name, ok: true, plan_name: planName, replaced, warnings: [...warnings, batteryData.detail ?? "Could not add to battery"] });
        } else {
          results.push({ filename: file.name, ok: true, plan_name: planName, replaced, warnings });
        }
      } catch (e) {
        results.push({ filename: file.name, ok: false, error: e instanceof Error ? e.message : "Network error" });
      }
      setBulkProgress({ done: i + 1, total: bulkFiles.length, results: [...results] });
    }
    setBulkImporting(false);
    loadBattery();
  }

  async function deleteAllBattery() {
    setDeleteAllLoading(true);
    try {
      const res = await fetch("/api/battery/delete-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      const data = await res.json();
      setStatusMsg(`Deleted ${data.deleted_battery} battery records and ${data.deleted_parents} source imports.`);
    } catch (e) {
      setStatusMsg(e instanceof Error ? e.message : "Delete failed");
    }
    setDeleteAllLoading(false);
    setShowDeleteAllConfirm(false);
    loadBattery();
  }

  function sortedBattery(): BatteryRow[] {
    const rows = [...battery];
    rows.sort((a, b) => {
      let av: string | number = "";
      let bv: string | number = "";
      const aSnap = recomputed.has(a.id) ? recomputed.get(a.id) ?? null : a.comparison_snapshot;
      const bSnap = recomputed.has(b.id) ? recomputed.get(b.id) ?? null : b.comparison_snapshot;
      if (sortCol === "plan_name") { av = adminPlanLabel(a); bv = adminPlanLabel(b); }
      else if (sortCol === "foundation") { av = a.foundation ?? ""; bv = b.foundation ?? ""; }
      else if (sortCol === "cooling_delta") {
        av = aSnap ? (coolingDelta(aSnap) ?? 0) : 0;
        bv = bSnap ? (coolingDelta(bSnap) ?? 0) : 0;
      } else if (sortCol === "heating_delta") {
        av = aSnap ? (heatingDelta(aSnap) ?? 0) : 0;
        bv = bSnap ? (heatingDelta(bSnap) ?? 0) : 0;
      } else if (sortCol === "tons_delta") {
        av = aSnap ? (tonsDelta(aSnap) ?? 0) : 0;
        bv = bSnap ? (tonsDelta(bSnap) ?? 0) : 0;
      } else if (sortCol === "status") {
        av = aSnap ? (isAccurate(aSnap, settings.accuracyThreshold) ? 0 : 1) : 2;
        bv = bSnap ? (isAccurate(bSnap, settings.accuracyThreshold) ? 0 : 1) : 2;
      }
      if (av < bv) return sortAsc ? -1 : 1;
      if (av > bv) return sortAsc ? 1 : -1;
      return 0;
    });
    return rows;
  }

  function toggleSort(col: string) {
    if (sortCol === col) setSortAsc(!sortAsc);
    else { setSortCol(col); setSortAsc(true); }
  }

  function SortTh({ col, children }: { col: string; children: React.ReactNode }) {
    const active = sortCol === col;
    return (
      <th
        style={{ cursor: "pointer", userSelect: "none" }}
        onClick={() => toggleSort(col)}
      >
        {children}{active ? (sortAsc ? " ▲" : " ▼") : ""}
      </th>
    );
  }

  function recomputeSummary(): string {
    if (!recomputeTime) return "";
    let improved = 0, regressed = 0, unchanged = 0;
    for (const row of battery) {
      const fresh = recomputed.get(row.id);
      const old = row.comparison_snapshot;
      const dir = changeDir(old, fresh ?? null, "cooling");
      if (dir === "improved") improved++;
      else if (dir === "regressed") regressed++;
      else unchanged++;
    }
    return `${improved} improved, ${regressed} regressed, ${unchanged} unchanged`;
  }

  const filteredEligible = eligible.filter((e) => {
    if (!eligibleSearch) return true;
    const q = eligibleSearch.toLowerCase();
    return (
      adminPlanLabel(e).toLowerCase().includes(q) ||
      e.plan_name.toLowerCase().includes(q) ||
      e.builder_name.toLowerCase().includes(q) ||
      (e.foundation ?? "").toLowerCase().includes(q)
    );
  });

  if (loading) return (
    <main style={{ padding: 32, fontFamily: "system-ui, sans-serif" }}>
      <p style={{ color: "#666" }}>Loading battery…</p>
    </main>
  );

  const rows = sortedBattery();

  return (
    <main style={{ fontFamily: "system-ui, -apple-system, sans-serif", background: "#f5f5f5", minHeight: "100vh", padding: "24px" }}>
      {/* Top bar */}
      <div className="admin-topbar">
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
          <a href="/" style={{ fontSize: 13, color: "#666", textDecoration: "none" }}>← Back to editor</a>
          <span style={{ color: "#ccc" }}>|</span>
          <span style={{ fontWeight: 700, fontSize: 16 }}>Admin — Model Diagnostics</span>
        </div>
        <div className="admin-topbar-row">
          {/* Filter group */}
          <div className="filter-group">
            {(["battery", "all", "salas"] as const).map((f) => (
              <button
                key={f}
                className={`filter-btn${filter === f ? " active" : ""}`}
                onClick={() => setFilter(f)}
              >
                {f === "battery" ? "Test Battery" : f === "all" ? "All Projects" : "Salas Imports"}
              </button>
            ))}
          </div>
          <button className={`admin-btn admin-btn-outline${settingsOpen ? " active" : ""}`} onClick={() => setSettingsOpen(!settingsOpen)}>
            Settings
          </button>
          <div style={{ flex: 1 }} />
          {/* View toggle */}
          <div className="filter-group">
            <button className={`filter-btn${view === "table" ? " active" : ""}`} onClick={() => setView("table")}>Table</button>
            <button className={`filter-btn${view === "columns" ? " active" : ""}`} onClick={() => setView("columns")}>Columns</button>
          </div>
          {/* Unit toggle */}
          <div className="filter-group">
            <button className={`filter-btn${unit === "pct" ? " active" : ""}`} onClick={() => setUnit("pct")}>%</button>
            <button className={`filter-btn${unit === "btuh" ? " active" : ""}`} onClick={() => setUnit("btuh")}>BTU/hr</button>
          </div>
          <button className="admin-btn admin-btn-outline" onClick={openAddModal}>+ Add to Battery</button>
          <button className="admin-btn admin-btn-outline" onClick={() => { setBulkFiles([]); setBulkProgress({ done: 0, total: 0, results: [] }); setShowBulkModal(true); }}>Bulk Import</button>
          <button className="admin-btn admin-btn-primary" onClick={recomputeAll} disabled={recomputeLoading}>
            {recomputeLoading ? "Recomputing…" : "Recompute All"}
          </button>
          <button className="admin-btn admin-btn-danger" onClick={() => setShowDeleteAllConfirm(true)} disabled={battery.length === 0}>Delete All</button>
        </div>
      </div>

      {/* Settings drawer */}
      {settingsOpen && (
        <div className="admin-settings-drawer">
          {(
            [
              { key: "tolerancePct", label: "Tolerance %", min: 1, max: 20, step: 1 },
              { key: "toleranceBtuh", label: "Tolerance BTU/hr", min: 50, max: 1000, step: 50 },
              { key: "accuracyThreshold", label: "Accuracy Threshold BTU/hr", min: 10, max: 500, step: 10 },
            ] as const
          ).map(({ key, label, min, max, step }) => (
            <div key={key} className="admin-setting">
              <label className="admin-setting-label">{label}</label>
              <input
                type="number"
                value={settings[key]}
                min={min}
                max={max}
                step={step}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, [key]: Number(e.target.value) }))
                }
                className="admin-setting-input"
              />
            </div>
          ))}
        </div>
      )}

      {/* Error */}
      {error && <div className="admin-error">{error}</div>}

      {/* Recompute banner */}
      {recomputeTime && (
        <div className="admin-recompute-banner">
          <span>⟳ Recomputed at {recomputeTime} — {recomputeSummary()}</span>
          <div style={{ flex: 1 }} />
          <input
            type="text"
            placeholder="Export label (optional)"
            value={exportLabel}
            onChange={(e) => setExportLabel(e.target.value)}
            className="admin-export-label"
          />
          <button className="admin-btn admin-btn-green" onClick={saveSnapshots} disabled={saveLoading}>
            {saveLoading ? "Saving…" : "Save Snapshots"}
          </button>
          <button className="admin-btn admin-btn-outline" onClick={exportSnapshot} disabled={exportLoading}>
            {exportLoading ? "Exporting…" : "Export Snapshot"}
          </button>
          <button className="admin-btn admin-btn-outline" onClick={exportDetailReport} disabled={detailReportLoading}>
            {detailReportLoading ? "Building…" : "Export Detail Report"}
          </button>
          <button className="admin-btn admin-btn-outline" onClick={exportGlassFactorAudit} disabled={glassAuditLoading}>
            {glassAuditLoading ? "Building…" : "Export Glass Audit"}
          </button>
          <button className="admin-btn admin-btn-outline" onClick={exportResidualAudit} disabled={residualAuditLoading}>
            {residualAuditLoading ? "Building…" : "Export Residual Audit"}
          </button>
        </div>
      )}

      {statusMsg && (
        <div className="admin-status-msg" onClick={() => setStatusMsg(null)}>{statusMsg} ✕</div>
      )}

      {/* TABLE VIEW */}
      {view === "table" && (
        <div style={{ overflowX: "auto" }}>
          <table className="vb-table" style={{ background: "#fff", borderRadius: 12, border: "1px solid #e0e0e0", borderCollapse: "separate", borderSpacing: 0, width: "100%" }}>
            <thead>
              <tr>
                <SortTh col="status">Status</SortTh>
                <SortTh col="plan_name">Plan</SortTh>
                <SortTh col="foundation">Foundation</SortTh>
                <th>SF</th>
                <SortTh col="cooling_delta">Cooling Δ</SortTh>
                <SortTh col="heating_delta">Heating Δ</SortTh>
                <SortTh col="tons_delta">Tons Δ</SortTh>
                <th>Rooms</th>
                <th>Inputs</th>
                {recomputeTime && <th>Change</th>}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const snap = recomputed.has(row.id) ? recomputed.get(row.id) ?? null : row.comparison_snapshot;
                const oldSnap = row.comparison_snapshot;
                const accurate = snap ? isAccurate(snap, settings.accuracyThreshold) : false;
                const outliers = snap ? roomOutliers(snap, settings.tolerancePct, settings.toleranceBtuh) : 0;
                const sf = (row.payload_json as any)?.project?.metadata?.floor_area
                  ?? (row.payload_json as any)?.project?.levels?.reduce((s: number, l: any) => s + (l.floor_area ?? 0), 0)
                  ?? null;
                const isExpanded = expandedId === row.id;

                return (
                  <React.Fragment key={row.id}>
                    <tr
                      onClick={() => setExpandedId(isExpanded ? null : row.id)}
                      style={{ cursor: "pointer" }}
                    >
                      <td>
                        <span
                          className="dot"
                          style={{
                            background: !snap ? "#9ca3af" : accurate ? "#16a34a" : "#ca8a04",
                            width: 8, height: 8, borderRadius: "50%", display: "inline-block",
                          }}
                        />
                      </td>
                      <td className="plan-cell">{adminPlanLabel(row) || row.id}</td>
                      <td>{row.foundation ?? "—"}</td>
                      <td>{sf ? sf.toLocaleString() : "—"}</td>
                      {snap
                        ? <>
                            <DeltaCell delta={coolingDelta(snap)} salas={snap.system.salas_cooling_btuh} unit={unit} />
                            <DeltaCell delta={heatingDelta(snap)} salas={snap.system.salas_heating_btuh} unit={unit} />
                            <td className="delta-cell">{tonsDelta(snap) != null ? fmtTons(tonsDelta(snap)!) : "—"}</td>
                          </>
                        : <><td>—</td><td>—</td><td>—</td></>
                      }
                      <td>
                        {outliers === 0
                          ? <span className="badge badge-green" style={{ fontSize: 11 }}>OK</span>
                          : <span className="badge badge-amber" style={{ fontSize: 11 }}>{outliers}</span>
                        }
                      </td>
                      <td style={{ display: "flex", gap: 3, alignItems: "center", flexWrap: "wrap" }}>
                        <FidelityBadges details={row.import_fidelity_details} />
                        {!row.import_fidelity_details && (
                          <span style={{ color: "#999", fontSize: 12 }}>—</span>
                        )}
                      </td>
                      {recomputeTime && (
                        <td>
                          <ChangePill dir={changeDir(oldSnap, recomputed.get(row.id) ?? null, "cooling")} />
                        </td>
                      )}
                      <td onClick={(e) => e.stopPropagation()}>
                        {removeConfirm === row.id ? (
                          <>
                            <button
                              className="admin-btn admin-btn-danger"
                              style={{ fontSize: 11, padding: "2px 8px" }}
                              onClick={() => removeFromBattery(row.id)}
                            >
                              Confirm
                            </button>
                            <button
                              className="admin-btn admin-btn-outline"
                              style={{ fontSize: 11, padding: "2px 8px", marginLeft: 4 }}
                              onClick={() => setRemoveConfirm(null)}
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            className="admin-btn admin-btn-outline"
                            style={{ fontSize: 11, padding: "2px 6px", color: "#dc2626", borderColor: "#fca5a5" }}
                            onClick={() => setRemoveConfirm(row.id)}
                            title="Remove from battery"
                          >
                            ✕
                          </button>
                        )}
                      </td>
                    </tr>
                    {isExpanded && snap && (
                      <tr>
                        <td colSpan={recomputeTime ? 11 : 10} style={{ padding: 0 }}>
                          <div style={{ padding: "12px 16px", borderTop: "1px solid #f0f0f0", background: "#fafafa" }}>
                            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                              <thead>
                                <tr style={{ color: "#666", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                                  <th style={{ textAlign: "left", padding: "4px 8px", borderBottom: "1px solid #e0e0e0" }}>Room</th>
                                  <th style={{ textAlign: "right", padding: "4px 8px", borderBottom: "1px solid #e0e0e0" }}>VRC Cool</th>
                                  <th style={{ textAlign: "right", padding: "4px 8px", borderBottom: "1px solid #e0e0e0" }}>Salas Cool</th>
                                  <th style={{ textAlign: "right", padding: "4px 8px", borderBottom: "1px solid #e0e0e0" }}>Δ Cool</th>
                                  <th style={{ textAlign: "right", padding: "4px 8px", borderBottom: "1px solid #e0e0e0" }}>VRC Heat</th>
                                  <th style={{ textAlign: "right", padding: "4px 8px", borderBottom: "1px solid #e0e0e0" }}>Salas Heat</th>
                                  <th style={{ textAlign: "right", padding: "4px 8px", borderBottom: "1px solid #e0e0e0" }}>Δ Heat</th>
                                  <th style={{ padding: "4px 8px", borderBottom: "1px solid #e0e0e0" }}></th>
                                </tr>
                              </thead>
                              <tbody>
                                {snap.rooms.map((rm) => {
                                  const cd = rm.salas_cooling != null ? rm.vrc_cooling - rm.salas_cooling : null;
                                  const hd = rm.salas_heating != null ? rm.vrc_heating - rm.salas_heating : null;
                                  const outlier = rm.salas_cooling != null && cd != null && (Math.abs(cd) > settings.toleranceBtuh && Math.abs(cd) / rm.salas_cooling * 100 > settings.tolerancePct);
                                  return (
                                    <tr key={rm.name} style={{ background: outlier ? "#fee2e2" : undefined }}>
                                      <td style={{ padding: "4px 8px" }}>{rm.name}</td>
                                      <td style={{ textAlign: "right", padding: "4px 8px" }}>{rm.vrc_cooling.toLocaleString()}</td>
                                      <td style={{ textAlign: "right", padding: "4px 8px" }}>{rm.salas_cooling?.toLocaleString() ?? "—"}</td>
                                      <td style={{ textAlign: "right", padding: "4px 8px", color: outlier ? "#dc2626" : "#666" }}>
                                        {cd != null && rm.salas_cooling != null
                                          ? unit === "pct" ? fmtPct(cd / rm.salas_cooling * 100) : fmtBtuh(cd)
                                          : "—"}
                                      </td>
                                      <td style={{ textAlign: "right", padding: "4px 8px" }}>{rm.vrc_heating.toLocaleString()}</td>
                                      <td style={{ textAlign: "right", padding: "4px 8px" }}>{rm.salas_heating?.toLocaleString() ?? "—"}</td>
                                      <td style={{ textAlign: "right", padding: "4px 8px", color: "#666" }}>
                                        {hd != null && rm.salas_heating != null
                                          ? unit === "pct" ? fmtPct(hd / rm.salas_heating * 100) : fmtBtuh(hd)
                                          : "—"}
                                      </td>
                                      <td style={{ padding: "4px 8px" }}>
                                        <span
                                          style={{
                                            width: 7, height: 7, borderRadius: "50%", display: "inline-block",
                                            background: outlier ? "#dc2626" : "#16a34a",
                                          }}
                                        />
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={10} style={{ textAlign: "center", padding: 32, color: "#666" }}>
                    No battery records. Add projects using "+ Add to Battery".
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* COLUMNS VIEW */}
      {view === "columns" && (
        <div className="vc-columns" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 20 }}>
          {(["accurate", "review", "regressed"] as const).map((col) => {
            const colRows = rows.filter((row) => {
              const snap = recomputed.has(row.id) ? recomputed.get(row.id) ?? null : row.comparison_snapshot;
              if (!snap) return col === "review";
              if (recomputeTime) {
                const dir = changeDir(row.comparison_snapshot, recomputed.get(row.id) ?? null, "cooling");
                if (dir === "regressed" && col === "regressed") return true;
                if (dir === "regressed") return false;
              } else if (col === "regressed") return false;
              const acc = isAccurate(snap, settings.accuracyThreshold);
              return col === "accurate" ? acc : col === "review" ? !acc : false;
            });
            const colColor = col === "accurate" ? "#16a34a" : col === "review" ? "#ca8a04" : "#dc2626";
            const colLabel = col === "accurate" ? "Accurate" : col === "review" ? "Needs Review" : "Regressed";
            return (
              <div key={col}>
                <div style={{ fontWeight: 700, fontSize: 13, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ width: 10, height: 10, borderRadius: "50%", background: colColor, display: "inline-block" }} />
                  {colLabel}
                  <span style={{ fontSize: 12, fontWeight: 600, background: "#f3f4f6", color: "#666", padding: "2px 8px", borderRadius: 99 }}>{colRows.length}</span>
                </div>
                {colRows.map((row) => {
                  const snap = recomputed.has(row.id) ? recomputed.get(row.id) ?? null : row.comparison_snapshot;
                  const oldSnap = row.comparison_snapshot;
                  const outliers = snap ? roomOutliers(snap, settings.tolerancePct, settings.toleranceBtuh) : 0;
                  const sf = (row.payload_json as any)?.project?.levels?.reduce((s: number, l: any) => s + (l.floor_area ?? 0), 0) ?? null;
                  return (
                    <div
                      key={row.id}
                      style={{
                        background: "#fff",
                        border: "1px solid #e0e0e0",
                        borderLeft: `3px solid ${colColor}`,
                        borderRadius: 10,
                        padding: "14px",
                        marginBottom: 10,
                        cursor: "pointer",
                      }}
                      onClick={() => setExpandedId(expandedId === row.id ? null : row.id)}
                    >
                      <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>{adminPlanLabel(row) || row.id}</div>
                      <div style={{ fontSize: 12, color: "#666", marginBottom: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
                        {row.foundation && <span>{row.foundation}</span>}
                        {sf && <span>{sf.toLocaleString()} SF</span>}
                        {outliers > 0 && <span className="badge badge-amber" style={{ fontSize: 10 }}>{outliers} Outlier{outliers > 1 ? "s" : ""}</span>}
                        {outliers === 0 && snap && <span className="badge badge-green" style={{ fontSize: 10 }}>Rooms OK</span>}
                        <FidelityBadges details={row.import_fidelity_details} />
                      </div>
                      {snap && (
                        <div style={{ display: "flex", gap: 16, fontSize: 12 }}>
                          {(["cooling", "heating", "tons"] as const).map((m) => {
                            const delta = m === "cooling" ? coolingDelta(snap) : m === "heating" ? heatingDelta(snap) : tonsDelta(snap);
                            const salas = m === "cooling" ? snap.system.salas_cooling_btuh : m === "heating" ? snap.system.salas_heating_btuh : snap.system.salas_min_tons;
                            const pct = delta != null && salas != null && salas !== 0 ? delta / salas * 100 : null;
                            const display = m === "tons"
                              ? delta != null ? fmtTons(delta) : "—"
                              : unit === "pct" ? (pct != null ? fmtPct(pct) : "—") : (delta != null ? fmtBtuh(delta) : "—");
                            return (
                              <div key={m}>
                                <span style={{ color: "#666" }}>{m.charAt(0).toUpperCase() + m.slice(1)} </span>
                                <span style={{ fontWeight: 700 }}>{display}</span>
                                {recomputeTime && <> <ChangePill dir={changeDir(oldSnap, recomputed.get(row.id) ?? null, m)} /></>}
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {/* Expanded room detail */}
                      {expandedId === row.id && snap && (
                        <div style={{ marginTop: 12, borderTop: "1px solid #e0e0e0", paddingTop: 10 }} onClick={(e) => e.stopPropagation()}>
                          <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
                            <thead>
                              <tr style={{ color: "#999", fontSize: 10, textTransform: "uppercase" }}>
                                <th style={{ textAlign: "left", padding: "3px 6px" }}>Room</th>
                                <th style={{ textAlign: "right", padding: "3px 6px" }}>VRC Cool</th>
                                <th style={{ textAlign: "right", padding: "3px 6px" }}>Salas Cool</th>
                                <th style={{ textAlign: "right", padding: "3px 6px" }}>Δ</th>
                                <th style={{ textAlign: "right", padding: "3px 6px" }}>VRC Heat</th>
                                <th style={{ textAlign: "right", padding: "3px 6px" }}>Salas Heat</th>
                                <th style={{ textAlign: "right", padding: "3px 6px" }}>Δ</th>
                              </tr>
                            </thead>
                            <tbody>
                              {snap.rooms.map((rm) => {
                                const cd = rm.salas_cooling != null ? rm.vrc_cooling - rm.salas_cooling : null;
                                const hd = rm.salas_heating != null ? rm.vrc_heating - rm.salas_heating : null;
                                const outlier = rm.salas_cooling != null && cd != null && (Math.abs(cd) > settings.toleranceBtuh && Math.abs(cd) / rm.salas_cooling * 100 > settings.tolerancePct);
                                return (
                                  <tr key={rm.name} style={{ background: outlier ? "#fee2e2" : undefined }}>
                                    <td style={{ padding: "3px 6px" }}>{rm.name}</td>
                                    <td style={{ textAlign: "right", padding: "3px 6px" }}>{rm.vrc_cooling.toLocaleString()}</td>
                                    <td style={{ textAlign: "right", padding: "3px 6px" }}>{rm.salas_cooling?.toLocaleString() ?? "—"}</td>
                                    <td style={{ textAlign: "right", padding: "3px 6px", color: outlier ? "#dc2626" : "#666" }}>
                                      {cd != null && rm.salas_cooling != null ? fmtBtuh(cd) : "—"}
                                    </td>
                                    <td style={{ textAlign: "right", padding: "3px 6px" }}>{rm.vrc_heating.toLocaleString()}</td>
                                    <td style={{ textAlign: "right", padding: "3px 6px" }}>{rm.salas_heating?.toLocaleString() ?? "—"}</td>
                                    <td style={{ textAlign: "right", padding: "3px 6px", color: "#666" }}>
                                      {hd != null && rm.salas_heating != null ? fmtBtuh(hd) : "—"}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  );
                })}
                {colRows.length === 0 && (
                  <div style={{ color: "#999", fontSize: 13, padding: "16px 0" }}>None</div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Bulk Import modal */}
      {showBulkModal && (
        <div
          className="modal-backdrop"
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 200, display: "flex", justifyContent: "center", alignItems: "center" }}
          onClick={() => { if (!bulkImporting) setShowBulkModal(false); }}
        >
          <div
            className="modal"
            style={{ width: 600, maxHeight: "80vh", overflow: "auto", background: "#fff", borderRadius: 16, padding: 24, boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ fontSize: 18, marginBottom: 4 }}>Bulk Import Salas PDFs</h3>
            <p style={{ fontSize: 13, color: "#666", marginBottom: 16 }}>
              Upload Salas O'Brien PDFs to import, save, and add to the test battery. Existing records with the same full plan identity will be replaced.
            </p>

            {!bulkImporting && bulkProgress.results.length === 0 && (
              <>
                <div
                  style={{
                    border: "2px dashed #d0d0d0", borderRadius: 12, padding: "32px 16px",
                    textAlign: "center", cursor: "pointer", marginBottom: 16,
                    background: bulkFiles.length > 0 ? "#f0fdf4" : "#fafafa",
                  }}
                  onClick={() => bulkFileInput.current?.click()}
                  onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
                  onDrop={(e) => {
                    e.preventDefault(); e.stopPropagation();
                    const files = Array.from(e.dataTransfer.files).filter((f) => f.name.toLowerCase().endsWith(".pdf"));
                    if (files.length > 0) setBulkFiles(files);
                  }}
                >
                  {bulkFiles.length === 0 ? (
                    <span style={{ color: "#888", fontSize: 14 }}>Drop PDF files here or click to select</span>
                  ) : (
                    <span style={{ color: "#16a34a", fontSize: 14, fontWeight: 600 }}>{bulkFiles.length} PDF{bulkFiles.length > 1 ? "s" : ""} selected</span>
                  )}
                </div>
                <input
                  ref={bulkFileInput}
                  type="file"
                  accept=".pdf"
                  multiple
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    if (files.length > 0) setBulkFiles(files);
                    e.target.value = "";
                  }}
                />
                {bulkFiles.length > 0 && (
                  <ul style={{ listStyle: "none", padding: 0, margin: "0 0 16px", maxHeight: 200, overflow: "auto" }}>
                    {bulkFiles.map((f, i) => (
                      <li key={i} style={{ fontSize: 13, padding: "4px 0", color: "#333" }}>{f.name}</li>
                    ))}
                  </ul>
                )}
              </>
            )}

            {/* Progress during import */}
            {bulkImporting && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
                  Importing {bulkProgress.done} of {bulkProgress.total}…
                </div>
                <div style={{ height: 6, background: "#e5e7eb", borderRadius: 3, overflow: "hidden" }}>
                  <div style={{ height: "100%", background: "#2563eb", borderRadius: 3, width: `${(bulkProgress.done / bulkProgress.total) * 100}%`, transition: "width 0.3s" }} />
                </div>
              </div>
            )}

            {/* Results summary */}
            {!bulkImporting && bulkProgress.results.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
                  {bulkProgress.results.filter((r) => r.ok).length} imported
                  {bulkProgress.results.some((r) => r.replaced) && `, ${bulkProgress.results.filter((r) => r.replaced).length} replaced`}
                  {bulkProgress.results.some((r) => !r.ok) && `, ${bulkProgress.results.filter((r) => !r.ok).length} failed`}
                </div>
                <ul style={{ listStyle: "none", padding: 0, margin: 0, maxHeight: 300, overflow: "auto" }}>
                  {bulkProgress.results.map((r, i) => (
                    <li key={i} style={{ fontSize: 13, padding: "6px 0", borderBottom: "1px solid #f0f0f0", display: "flex", gap: 8, alignItems: "flex-start" }}>
                      <span style={{ color: r.ok ? "#16a34a" : "#dc2626", fontWeight: 700, flexShrink: 0 }}>{r.ok ? "OK" : "FAIL"}</span>
                      <div style={{ flex: 1 }}>
                        <div>{r.plan_name ?? r.filename}{r.replaced ? " (replaced)" : ""}</div>
                        {r.error && <div style={{ color: "#dc2626", fontSize: 12 }}>{r.error}</div>}
                        {r.warnings && r.warnings.length > 0 && (
                          <div style={{ color: "#d97706", fontSize: 12 }}>{r.warnings.join(" ")}</div>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 16, borderTop: "1px solid #e0e0e0" }}>
              <button className="admin-btn admin-btn-outline" onClick={() => setShowBulkModal(false)} disabled={bulkImporting}>
                {bulkProgress.results.length > 0 ? "Close" : "Cancel"}
              </button>
              {bulkProgress.results.length === 0 && (
                <button className="admin-btn admin-btn-primary" onClick={bulkImport} disabled={bulkFiles.length === 0 || bulkImporting}>
                  {bulkImporting ? "Importing…" : `Import ${bulkFiles.length} PDF${bulkFiles.length !== 1 ? "s" : ""}`}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Delete All confirmation */}
      {showDeleteAllConfirm && (
        <div
          className="modal-backdrop"
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 200, display: "flex", justifyContent: "center", alignItems: "center" }}
          onClick={() => { if (!deleteAllLoading) setShowDeleteAllConfirm(false); }}
        >
          <div
            className="modal"
            style={{ width: 420, background: "#fff", borderRadius: 16, padding: 24, boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ fontSize: 18, marginBottom: 8 }}>Delete All Battery Records</h3>
            <p style={{ fontSize: 14, color: "#666", marginBottom: 20 }}>
              This will permanently delete all <strong>{battery.length}</strong> battery record{battery.length !== 1 ? "s" : ""} and their source Salas imports. This cannot be undone.
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button className="admin-btn admin-btn-outline" onClick={() => setShowDeleteAllConfirm(false)} disabled={deleteAllLoading}>Cancel</button>
              <button className="admin-btn admin-btn-danger" onClick={deleteAllBattery} disabled={deleteAllLoading}>
                {deleteAllLoading ? "Deleting…" : "Delete All"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add to Battery modal */}
      {showAddModal && (
        <div
          className="modal-backdrop"
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 200, display: "flex", justifyContent: "center", alignItems: "center" }}
          onClick={() => setShowAddModal(false)}
        >
          <div
            className="modal"
            style={{ width: 560, maxHeight: "80vh", overflow: "auto", background: "#fff", borderRadius: 16, padding: 24, boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ fontSize: 18, marginBottom: 4 }}>Add to Test Battery</h3>
            <p style={{ fontSize: 13, color: "#666", marginBottom: 16 }}>
              Projects with Salas comparison data and matching orientation. Area/volume differences are flagged but allowed.
            </p>
            <input
              type="text"
              placeholder="Search by plan name, builder, foundation…"
              value={eligibleSearch}
              onChange={(e) => setEligibleSearch(e.target.value)}
              style={{ width: "100%", padding: "10px 14px", border: "1px solid #e0e0e0", borderRadius: 8, fontSize: 14, marginBottom: 12 }}
            />
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {filteredEligible.length === 0 && (
                <li style={{ color: "#999", padding: 12, fontSize: 13 }}>No eligible projects found.</li>
              )}
              {filteredEligible.map((e) => (
                <li
                  key={e.id}
                  style={{
                    display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
                    borderRadius: 8, cursor: "pointer", fontSize: 13,
                    background: eligibleSelected.has(e.id) ? "#dbeafe" : undefined,
                  }}
                  onClick={() => {
                    const s = new Set(eligibleSelected);
                    if (s.has(e.id)) s.delete(e.id); else s.add(e.id);
                    setEligibleSelected(s);
                  }}
                >
                  <input type="checkbox" readOnly checked={eligibleSelected.has(e.id)} style={{ width: 16, height: 16 }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600 }}>{adminPlanLabel(e) || e.plan_name}</div>
                    <div style={{ color: "#666", fontSize: 12, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                      <span>{e.builder_name}{e.foundation ? ` · ${e.foundation}` : ""}</span>
                      <FidelityBadges details={e.import_fidelity_details} />
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16, paddingTop: 16, borderTop: "1px solid #e0e0e0" }}>
              <button className="admin-btn admin-btn-outline" onClick={() => setShowAddModal(false)}>Cancel</button>
              <button
                className="admin-btn admin-btn-primary"
                onClick={addSelected}
                disabled={eligibleSelected.size === 0 || addingBattery}
              >
                {addingBattery ? "Adding…" : `Add Selected (${eligibleSelected.size})`}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

// ── Airflow Wizard ──────────────────────────────────────────────────────────

type WizardPhase = "supply" | "return" | "static" | "checklist" | "review";
const WIZARD_PHASES: WizardPhase[] = ["supply", "return", "static", "checklist", "review"];
const WIZARD_ORIENTATIONS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const WIZARD_BASES = ["Avg", "Cool", "Heat"] as const;
const CHECKLIST_ITEMS = [
  { key: "size_match", label: "Size Match" },
  { key: "total_airflow", label: "Total Airflow" },
  { key: "room_room", label: "Room-Room" },
  { key: "strip_check", label: "Strip Check" },
  { key: "cool_check", label: "Cool Check" },
  { key: "zone_check", label: "Zone Check" },
] as const;

function WizardReturnQuickAdd({ unitId, defaultName, returns, onAdd, onUpdate, onRemove }: {
  unitId: string;
  defaultName: string;
  returns: { name: string; readings: (number|string)[] }[];
  onAdd: (name: string) => void;
  onUpdate: (idx: number, field: "name" | number, val: string) => void;
  onRemove: (idx: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const returnTotal = returns.reduce((s, e) => s + e.readings.reduce((a: number, v) => a + (typeof v === "number" ? v : 0), 0), 0);
  return (
    <div style={{ marginTop: 12, borderTop: "1px solid #e0e0e0", paddingTop: 8 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <button
          onClick={() => setExpanded(v => !v)}
          style={{ background: "none", border: "none", color: "#2563eb", fontSize: 13, cursor: "pointer", padding: 0, fontWeight: 600 }}
        >
          {expanded ? "▾" : "▸"} Returns ({returns.length}){returnTotal > 0 && ` · ${returnTotal} CFM`}
        </button>
        <button
          onClick={() => { onAdd(defaultName); setExpanded(true); }}
          style={{ background: "#2563eb", color: "#fff", border: "none", borderRadius: 6, padding: "6px 12px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
        >
          + Return
        </button>
      </div>
      {expanded && returns.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {returns.map((entry, i) => {
            const t = entry.readings.reduce((a: number, v) => a + (typeof v === "number" ? v : 0), 0);
            return (
              <div key={i} style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
                <input
                  style={{ fontSize: 14, padding: "6px 8px", border: "1px solid #ccc", borderRadius: 6, flex: "1 1 100px", minWidth: 0 }}
                  value={entry.name}
                  onChange={e => onUpdate(i, "name", e.target.value)}
                  placeholder="Name"
                  autoComplete="off"
                />
                <input
                  style={{ fontSize: 14, padding: "6px 8px", border: "1px solid #ccc", borderRadius: 6, width: 60 }}
                  type="text" inputMode="decimal" autoComplete="off" placeholder="R1"
                  value={entry.readings[0]}
                  onChange={e => onUpdate(i, 0, e.target.value)}
                />
                <input
                  style={{ fontSize: 14, padding: "6px 8px", border: "1px solid #ccc", borderRadius: 6, width: 60 }}
                  type="text" inputMode="decimal" autoComplete="off" placeholder="R2"
                  value={entry.readings[1]}
                  onChange={e => onUpdate(i, 1, e.target.value)}
                />
                <span style={{ fontSize: 12, fontWeight: 600, minWidth: 36, textAlign: "right" }}>{t || ""}</span>
                <button
                  onClick={() => onRemove(i)}
                  style={{ background: "none", border: "none", color: "#999", fontSize: 16, cursor: "pointer", padding: "0 4px" }}
                  title="Remove"
                >×</button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AirflowWizard() {
  const params = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  const key = params.get("session");
  const [session] = useState(() => {
    try { return key ? JSON.parse(localStorage.getItem(key) ?? "null") : null; }
    catch { return null; }
  });

  const [orientation, setOrientation] = useState(session?.default_orientation ?? "S");
  const [basis, setBasis] = useState<"Avg"|"Cool"|"Heat">("Avg");
  const [phase, setPhase] = useState<WizardPhase>("supply");
  const [currentUnit, setCurrentUnit] = useState(0);
  const [currentRoom, setCurrentRoom] = useState(0);
  const [supplyReadings, setSupplyReadings] = useState<Record<string, Record<string, (number|string)[]>>>({});
  const [returnEntries, setReturnEntries] = useState<Record<string, { name: string; readings: (number|string)[] }[]>>({});
  const [staticPressure, setStaticPressure] = useState<Record<string, { supply_esp: number|string; return_esp: number|string; before_filter: number|string; filter_type: string }>>({});
  const [checklist, setChecklist] = useState<Record<string, Record<string, "y"|"n"|"">>>({});
  const [downloading, setDownloading] = useState(false);
  const [showTopBar, setShowTopBar] = useState(false);
  // Room merging: roomName -> targetRoomName (load transfers to target, merged room gets 0 target)
  const [merges, setMerges] = useState<Record<string, Record<string, string>>>({});
  // Per-unit thermostat rooms: roomName -> true
  const [tstatRooms, setTstatRooms] = useState<Record<string, Record<string, boolean>>>({});
  // Per-unit system size (tons) — defaults from project data
  const [unitTons, setUnitTons] = useState<Record<string, number>>(() => {
    const m: Record<string, number> = {};
    for (const u of session?.units ?? []) m[u.id] = u.selected_tons || 0;
    return m;
  });

  if (!session) {
    return (
      <div style={{ padding: 40, textAlign: "center", fontFamily: "system-ui" }}>
        <h2>Session expired</h2>
        <p>Close this tab and re-open the wizard from the Export menu.</p>
      </div>
    );
  }

  const units: any[] = session.units;
  const orientTable: Record<string, Record<string, Record<string, number>>> = session.orientation_table;
  const unit = units[currentUnit];
  const rooms: { name: string }[] = unit?.rooms ?? [];
  const unitId = unit?.id;

  function getTarget(roomName: string) {
    return orientTable[roomName]?.[orientation]?.[basis] ?? 0;
  }

  function getUnitMerges(uid: string): Record<string, string> {
    return merges[uid] ?? {};
  }

  function setMerge(uid: string, roomName: string, targetRoom: string | "") {
    setMerges(prev => {
      const um = { ...(prev[uid] ?? {}) };
      if (targetRoom === "") { delete um[roomName]; } else { um[roomName] = targetRoom; }
      // Auto-advance if the current room was just merged
      if (targetRoom !== "" && rooms[currentRoom]?.name === roomName) {
        const newActive = rooms
          .map((r, i) => ({ name: r.name, index: i }))
          .filter(r => r.name !== roomName && !um[r.name]);
        // Go to next active room after current index, or first active room
        const next = newActive.find(r => r.index > currentRoom) ?? newActive[0];
        if (next) setTimeout(() => setCurrentRoom(next.index), 0);
      }
      return { ...prev, [uid]: um };
    });
  }

  /** Effective load per room after merges: merged rooms → 0, targets absorb merged load */
  function getEffectiveLoads(uid: string, roomList: { name: string }[]): Record<string, number> {
    const um = getUnitMerges(uid);
    const loads: Record<string, number> = {};
    for (const r of roomList) loads[r.name] = getTarget(r.name);
    // Transfer merged room loads to their targets
    for (const [from, to] of Object.entries(um)) {
      if (loads[to] !== undefined && loads[from] !== undefined) {
        loads[to] += loads[from];
        loads[from] = 0;
      }
    }
    return loads;
  }

  function isMerged(uid: string, roomName: string): boolean {
    return !!(getUnitMerges(uid)[roomName]);
  }

  /** Rooms that are not merged away (active rooms the tech enters readings for) */
  function activeRooms(uid: string, roomList: { name: string }[]): { name: string; index: number }[] {
    const um = getUnitMerges(uid);
    return roomList.map((r, i) => ({ name: r.name, index: i })).filter(r => !um[r.name]);
  }

  function getSupply(uid: string, roomName: string): (number|string)[] {
    return supplyReadings[uid]?.[roomName] ?? ["", "", "", ""];
  }

  function setSupply(uid: string, roomName: string, idx: number, val: string) {
    setSupplyReadings(prev => {
      const u = { ...prev[uid] };
      const arr = [...(u[roomName] ?? ["", "", "", ""])];
      arr[idx] = val === "" ? "" : Number(val);
      u[roomName] = arr;
      return { ...prev, [uid]: u };
    });
  }

  function supplyTotal(uid: string, roomName: string): number {
    return getSupply(uid, roomName).reduce((s: number, v) => s + (typeof v === "number" ? v : 0), 0);
  }

  function getReturn(uid: string): { name: string; readings: (number|string)[] }[] {
    return returnEntries[uid] ?? [];
  }

  function addReturnEntry(uid: string, name: string) {
    setReturnEntries(prev => ({
      ...prev,
      [uid]: [...(prev[uid] ?? []), { name, readings: ["", ""] }],
    }));
  }

  function removeReturnEntry(uid: string, idx: number) {
    setReturnEntries(prev => {
      const entries = [...(prev[uid] ?? [])];
      entries.splice(idx, 1);
      return { ...prev, [uid]: entries };
    });
  }

  function setReturnEntry(uid: string, idx: number, field: "name" | number, val: string) {
    setReturnEntries(prev => {
      const entries = [...(prev[uid] ?? [])];
      if (idx >= entries.length) return prev;
      if (field === "name") {
        entries[idx] = { ...entries[idx], name: val };
      } else {
        const readings = [...entries[idx].readings];
        readings[field] = val === "" ? "" : Number(val);
        entries[idx] = { ...entries[idx], readings };
      }
      return { ...prev, [uid]: entries };
    });
  }

  function getStatic(uid: string) {
    return staticPressure[uid] ?? { supply_esp: "", return_esp: "", before_filter: "", filter_type: "" };
  }

  function setStaticField(uid: string, field: string, val: string) {
    setStaticPressure(prev => ({
      ...prev,
      [uid]: { ...getStatic(uid), [field]: field === "filter_type" ? val : val }
    }));
  }

  function getChecklist(uid: string): Record<string, "y"|"n"|""> {
    return checklist[uid] ?? {};
  }

  function setChecklistItem(uid: string, key: string, val: "y"|"n") {
    setChecklist(prev => ({
      ...prev,
      [uid]: { ...(prev[uid] ?? {}), [key]: (prev[uid]?.[key] === val ? "" : val) as "y"|"n"|"" }
    }));
  }

  function isTstat(uid: string, roomName: string): boolean {
    return !!(tstatRooms[uid]?.[roomName]);
  }

  function toggleTstat(uid: string, roomName: string) {
    setTstatRooms(prev => {
      const ur = { ...(prev[uid] ?? {}) };
      if (ur[roomName]) { delete ur[roomName]; } else { ur[roomName] = true; }
      return { ...prev, [uid]: ur };
    });
  }

  /** Count tstats in the same zone as this room */
  function zoneTstatCount(uid: string, roomName: string, roomList: { name: string; zone_id?: string }[]): number {
    const room = roomList.find(r => r.name === roomName);
    if (!room?.zone_id) return 0;
    return roomList.filter(r => r.zone_id === room.zone_id && tstatRooms[uid]?.[r.name]).length;
  }

  /** True when every room has a reading or is merged into one that does */
  function allRoomsCovered(uid: string, roomList: { name: string }[]): boolean {
    const um = getUnitMerges(uid);
    return roomList.every(r => um[r.name] || supplyTotal(uid, r.name) > 0);
  }

  /** 3-tier color: green ≤10%, yellow 11-20%, red >20% */
  function deltaColor(pct: number): string {
    const abs = Math.abs(pct);
    if (abs <= 10) return "#16a34a";
    if (abs <= 20) return "#ca8a04";
    return "#dc2626";
  }

  function goNext() {
    if (phase === "supply") {
      const active = activeRooms(unitId, rooms);
      const curActiveIdx = active.findIndex(r => r.index === currentRoom);
      if (curActiveIdx < active.length - 1) {
        setCurrentRoom(active[curActiveIdx + 1].index);
        return;
      }
    }
    const pi = WIZARD_PHASES.indexOf(phase);
    if (pi < WIZARD_PHASES.length - 1) {
      setPhase(WIZARD_PHASES[pi + 1]);
      if (WIZARD_PHASES[pi + 1] === "supply") {
        const active = activeRooms(unitId, rooms);
        setCurrentRoom(active.length ? active[0].index : 0);
      } else {
        setCurrentRoom(0);
      }
    } else if (currentUnit < units.length - 1) {
      setCurrentUnit(currentUnit + 1);
      setPhase("supply");
      setCurrentRoom(0);
    }
  }

  function goBack() {
    if (phase === "supply") {
      const active = activeRooms(unitId, rooms);
      const curActiveIdx = active.findIndex(r => r.index === currentRoom);
      if (curActiveIdx > 0) {
        setCurrentRoom(active[curActiveIdx - 1].index);
        return;
      }
    }
    const pi = WIZARD_PHASES.indexOf(phase);
    if (pi > 0) {
      setPhase(WIZARD_PHASES[pi - 1]);
      if (WIZARD_PHASES[pi - 1] === "supply") {
        const active = activeRooms(unitId, rooms);
        setCurrentRoom(active.length ? active[active.length - 1].index : rooms.length - 1);
      }
    } else if (currentUnit > 0) {
      setCurrentUnit(currentUnit - 1);
      setPhase("review");
    }
  }

  function buildReadingsPayload() {
    const supply: Record<string, Record<string, number[]>> = {};
    for (const [uid, rooms] of Object.entries(supplyReadings)) {
      supply[uid] = {};
      for (const [rn, vals] of Object.entries(rooms)) {
        supply[uid][rn] = vals.map(v => typeof v === "number" ? v : 0);
      }
    }
    const ret: Record<string, { name: string; readings: number[] }[]> = {};
    for (const [uid, entries] of Object.entries(returnEntries)) {
      ret[uid] = entries.map(e => ({
        name: e.name,
        readings: e.readings.map(v => typeof v === "number" ? v : 0),
      }));
    }
    const sp: Record<string, any> = {};
    const pn = (v: string | number): number => { const n = parseFloat(String(v)); return isNaN(n) ? 0 : n; };
    for (const [uid, s] of Object.entries(staticPressure)) {
      sp[uid] = {
        supply_esp: Math.abs(pn(s.supply_esp)),
        return_esp: -Math.abs(pn(s.return_esp)),
        before_filter: -Math.abs(pn(s.before_filter)),
        filter_type: s.filter_type,
      };
    }
    return { supply, return: ret, static_pressure: sp, checklist };
  }

  async function downloadFile(endpoint: string, mimeType: string, ext: string) {
    setDownloading(true);
    try {
      const payload = { ...session.payload, readings: buildReadingsPayload() };
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error("Download failed.");
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const match = disposition.match(/filename="?([^"]+)"?/);
      const filename = match ? match[1] : `Airflow.${ext}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Download failed.");
    } finally {
      setDownloading(false);
    }
  }



  return (
    <>
      <style>{`
        .wiz { font-family: system-ui, -apple-system, sans-serif; max-width: 640px; margin: 0 auto; padding: 0 16px 100px; color: #1a1a1a; }
        .wiz-phase-nav { position: sticky; top: 0; z-index: 10; background: #fff; padding: 10px 0 6px; }
        .wiz-phase-buttons { display: flex; gap: 4px; }
        .wiz-phase-btn { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 1px; padding: 6px 2px; border: 2px solid #e0e0e0; border-radius: 8px; background: #fff; cursor: pointer; min-width: 0; }
        .wiz-phase-btn.active { border-color: #2563eb; background: #eff6ff; }
        .wiz-phase-label { font-size: 10px; font-weight: 600; color: #666; text-transform: uppercase; letter-spacing: 0.5px; }
        .wiz-phase-btn.active .wiz-phase-label { color: #2563eb; }
        .wiz-phase-value { font-size: 13px; font-weight: 700; color: #1a1a1a; white-space: nowrap; }
        .wiz-topbar { background: #f8f9fa; border: 1px solid #e0e0e0; border-radius: 8px; padding: 12px; margin-bottom: 16px; }
        .wiz-topbar-toggle { font-size: 13px; color: #2563eb; cursor: pointer; background: none; border: none; padding: 0; margin-bottom: 8px; }
        .wiz-topbar-row { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
        .wiz-topbar-row label { font-size: 13px; font-weight: 600; }
        .wiz-topbar-row select { font-size: 16px; padding: 4px 8px; border-radius: 4px; border: 1px solid #ccc; }
        .wiz-card { background: #fff; border: 1px solid #e0e0e0; border-radius: 12px; padding: 20px; margin-bottom: 16px; }
        .wiz-card h3 { margin: 0 0 4px; font-size: 18px; }
        .wiz-card .target { font-size: 14px; color: #666; margin-bottom: 16px; }
        .wiz-readings { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px; }
        .wiz-readings label { font-size: 13px; color: #555; display: flex; flex-direction: column; gap: 4px; }
        .wiz-readings input, .wiz-input { font-size: 16px; padding: 10px 12px; border: 1px solid #ccc; border-radius: 8px; width: 100%; box-sizing: border-box; }
        .wiz-readings input:focus, .wiz-input:focus { outline: none; border-color: #2563eb; box-shadow: 0 0 0 2px rgba(37,99,235,0.15); }
        .wiz-total { display: flex; justify-content: space-between; align-items: center; padding: 12px; background: #f8f9fa; border-radius: 8px; }
        .wiz-total .delta { font-weight: 600; }
        .wiz-overview { margin-top: 16px; }
        .wiz-overview table { width: 100%; border-collapse: collapse; font-size: 13px; }
        .wiz-overview th { text-align: left; padding: 6px 8px; border-bottom: 2px solid #e0e0e0; font-size: 12px; color: #666; }
        .wiz-overview td { padding: 6px 8px; border-bottom: 1px solid #f0f0f0; cursor: pointer; }
        .wiz-overview tr:hover td { background: #f0f7ff; }
        .wiz-overview tr.active td { background: #dbeafe; font-weight: 600; }
        .wiz-nav { position: fixed; bottom: 0; left: 0; right: 0; background: #fff; border-top: 1px solid #e0e0e0; padding: 12px 16px; padding-bottom: max(12px, env(safe-area-inset-bottom, 12px)); display: flex; gap: 12px; justify-content: center; z-index: 20; }
        .wiz-nav button { flex: 1; max-width: 200px; padding: 12px; font-size: 16px; border-radius: 8px; border: 1px solid #ccc; background: #fff; cursor: pointer; font-weight: 600; }
        .wiz-nav button.primary { background: #2563eb; color: #fff; border-color: #2563eb; }
        .wiz-nav button:disabled { opacity: 0.5; cursor: default; }
        .wiz-return-row { display: grid; grid-template-columns: 1fr; gap: 8px; padding: 12px 0; border-bottom: 1px solid #f0f0f0; }
        .wiz-return-readings { display: grid; grid-template-columns: 1fr 1fr 1fr auto; gap: 8px; align-items: center; }
        .wiz-static-row { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
        .wiz-static-row label { flex: 0 0 120px; font-size: 14px; font-weight: 600; }
        .wiz-static-row .unit { font-size: 13px; color: #666; white-space: nowrap; }
        .wiz-checklist-item { display: flex; align-items: center; justify-content: space-between; padding: 14px 0; border-bottom: 1px solid #f0f0f0; }
        .wiz-checklist-item span { font-size: 16px; font-weight: 500; }
        .wiz-yn { display: flex; gap: 8px; }
        .wiz-yn button { width: 48px; height: 48px; border-radius: 8px; border: 2px solid #ccc; background: #fff; font-size: 16px; font-weight: 700; cursor: pointer; }
        .wiz-yn button.sel-y { background: #dcfce7; border-color: #16a34a; color: #16a34a; }
        .wiz-yn button.sel-n { background: #fef2f2; border-color: #dc2626; color: #dc2626; }
        .wiz-download { display: flex; gap: 12px; margin-top: 20px; }
        .wiz-download button { flex: 1; padding: 14px; font-size: 16px; font-weight: 600; border-radius: 8px; border: none; cursor: pointer; }
        .wiz-download button.xlsx { background: #16a34a; color: #fff; }
        .wiz-download button.pdf { background: #2563eb; color: #fff; }
        .wiz-download button:disabled { opacity: 0.5; }
        .wiz-review-section { margin-bottom: 20px; }
        .wiz-review-section h4 { margin: 0 0 8px; font-size: 15px; color: #333; }
      `}</style>
      <div className="wiz">
        {/* Phase nav buttons — live dashboard */}
        {(() => {
          const tons = unitTons[unitId] || 0;
          const nominal = Math.round(tons * 400);
          const um = getUnitMerges(unitId);
          const supTotal = rooms.filter(r => !um[r.name]).reduce((s, r) => s + supplyTotal(unitId, r.name), 0);
          const retTotal = getReturn(unitId).reduce((s, e) => s + e.readings.reduce((a: number, v) => a + (typeof v === "number" ? v : 0), 0), 0);
          const sp = getStatic(unitId);
          const hasStatics = !!(sp.supply_esp || sp.return_esp);
          const cl = getChecklist(unitId);
          const clDone = CHECKLIST_ITEMS.filter(c => cl[c.key] === "y" || cl[c.key] === "n").length;
          const supPct = nominal && supTotal ? Math.round(Math.abs(supTotal - nominal) / nominal * 100) : null;
          const supColor = supPct !== null ? deltaColor(supPct) : undefined;
          const retPct = nominal && retTotal ? Math.round(Math.abs(retTotal - nominal) / nominal * 100) : null;
          const retColor = retPct !== null ? deltaColor(retPct) : undefined;
          return (
            <div className="wiz-phase-nav">
              {units.length > 1 && <div style={{ fontSize: 12, color: "#666", marginBottom: 4, textAlign: "center" }}>{unit.name}</div>}
              <div className="wiz-phase-buttons">
                <button className={`wiz-phase-btn ${phase === "supply" ? "active" : ""}`} onClick={() => setPhase("supply")}>
                  <span className="wiz-phase-label">Supply</span>
                  <span className="wiz-phase-value" style={{ color: supColor }}>{supTotal || "—"}{nominal ? `/${nominal}` : ""}</span>
                </button>
                <button className={`wiz-phase-btn ${phase === "return" ? "active" : ""}`} onClick={() => setPhase("return")}>
                  <span className="wiz-phase-label">Return</span>
                  <span className="wiz-phase-value" style={{ color: retColor }}>{retTotal || "—"}{nominal ? `/${nominal}` : ""}</span>
                </button>
                <button className={`wiz-phase-btn ${phase === "static" ? "active" : ""}`} onClick={() => setPhase("static")}>
                  <span className="wiz-phase-label">Statics</span>
                  <span className="wiz-phase-value">{hasStatics ? "✓" : "—"}</span>
                </button>
                <button className={`wiz-phase-btn ${phase === "checklist" ? "active" : ""}`} onClick={() => setPhase("checklist")}>
                  <span className="wiz-phase-label">Checklist</span>
                  <span className="wiz-phase-value">{clDone ? `${clDone}/6` : "—"}</span>
                </button>
                <button className={`wiz-phase-btn ${phase === "review" ? "active" : ""}`} onClick={() => setPhase("review")}>
                  <span className="wiz-phase-label">Report</span>
                  <span className="wiz-phase-value">↓</span>
                </button>
              </div>
            </div>
          );
        })()}

        {/* Collapsible settings: orientation, basis, system size */}
        <div className="wiz-topbar">
          <button className="wiz-topbar-toggle" onClick={() => setShowTopBar(v => !v)}>
            {showTopBar ? "▾ Settings" : "▸ Settings"} — {orientation} · {basis} · {unitTons[unitId] || "?"} ton
          </button>
          {showTopBar && (
            <div className="wiz-topbar-row">
              <label>Orientation
                <select value={orientation} onChange={e => setOrientation(e.target.value)} style={{ fontSize: 16 }}>
                  {WIZARD_ORIENTATIONS.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              </label>
              <label>CFM Basis
                <select value={basis} onChange={e => setBasis(e.target.value as any)} style={{ fontSize: 16 }}>
                  {WIZARD_BASES.map(b => <option key={b} value={b}>{b}</option>)}
                </select>
              </label>
              <label>System Size
                <select value={unitTons[unitId] || ""} onChange={e => setUnitTons(prev => ({ ...prev, [unitId]: parseFloat(e.target.value) || 0 }))} style={{ fontSize: 16 }}>
                  <option value="">—</option>
                  {[1.5, 2, 2.5, 3, 3.5, 4, 5].map(t => <option key={t} value={t}>{t} ton ({t * 400} CFM)</option>)}
                </select>
              </label>
            </div>
          )}
        </div>

        {/* Phase: Supply */}
        {phase === "supply" && rooms[currentRoom] && (() => {
          const room = rooms[currentRoom];
          const effLoads = getEffectiveLoads(unitId, rooms);
          const effLoad = effLoads[room.name] ?? 0;
          const vals = getSupply(unitId, room.name);
          const total = supplyTotal(unitId, room.name);
          const loadTotal = Object.values(effLoads).reduce((a, b) => a + b, 0);
          const um = getUnitMerges(unitId);
          const systemTotal = rooms.filter(r => !um[r.name]).reduce((s, r) => s + supplyTotal(unitId, r.name), 0);
          const covered = allRoomsCovered(unitId, rooms);
          const loadPct = loadTotal ? effLoad / loadTotal : 0;
          const adjTarget = covered && systemTotal ? Math.round(systemTotal * loadPct) : 0;
          const delta = total - adjTarget;
          const pct = adjTarget ? Math.round((delta / adjTarget) * 100) : 0;
          const mergedInto = um[room.name];
          const roomsMergedHere = Object.entries(um).filter(([, to]) => to === room.name).map(([from]) => from);
          return (
            <>
              <div className="wiz-card">
                <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {room.name}
                  <button
                    onClick={() => toggleTstat(unitId, room.name)}
                    style={{
                      fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 10,
                      border: isTstat(unitId, room.name) ? "2px solid #2563eb" : "2px solid #ccc",
                      background: isTstat(unitId, room.name) ? "#dbeafe" : "#fff",
                      color: isTstat(unitId, room.name) ? "#2563eb" : "#999",
                      cursor: "pointer", whiteSpace: "nowrap",
                    }}
                  >TSTAT</button>
                  {isTstat(unitId, room.name) && zoneTstatCount(unitId, room.name, rooms as any) > 1 && (
                    <span style={{ fontSize: 11, color: "#ca8a04", fontWeight: 600 }}>⚠ Multiple tstats in zone</span>
                  )}
                </h3>
                {mergedInto ? (
                  <div className="target" style={{ color: "#999" }}>Merged into {mergedInto} — skipped</div>
                ) : (
                  <div className="target">
                    Load: {effLoad} CFM ({loadTotal ? Math.round(loadPct * 100) : 0}%)
                    {roomsMergedHere.length > 0 && <span style={{ color: "#2563eb", fontSize: 12 }}> (incl. {roomsMergedHere.join(", ")})</span>}
                    {covered && adjTarget > 0 && <> · Adj Target: {adjTarget} CFM</>}
                    {!covered && systemTotal > 0 && <span style={{ color: "#999", fontSize: 12 }}> · enter all rooms for adj targets</span>}
                  </div>
                )}
                {/* Merge control */}
                <div style={{ margin: "8px 0 12px", fontSize: 13 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ color: "#666", whiteSpace: "nowrap" }}>Merge into:</span>
                    <select
                      style={{ fontSize: 16, padding: "4px 8px", borderRadius: 4, border: "1px solid #ccc" }}
                      value={um[room.name] ?? ""}
                      onChange={e => setMerge(unitId, room.name, e.target.value)}
                    >
                      <option value="">— None (has its own duct)</option>
                      {rooms.filter(r => r.name !== room.name && !um[r.name]).map(r => (
                        <option key={r.name} value={r.name}>{r.name}</option>
                      ))}
                    </select>
                  </label>
                </div>
                {!mergedInto && (
                  <>
                    <div className="wiz-readings">
                      {[0, 1, 2, 3].map(i => (
                        <label key={i}>Reading {i + 1}
                          <input type="text" inputMode="decimal" autoComplete="off" value={vals[i]} onChange={e => setSupply(unitId, room.name, i, e.target.value)} />
                        </label>
                      ))}
                    </div>
                    <div className="wiz-total">
                      <span>Total: <strong>{total || "—"}</strong> CFM</span>
                      {total > 0 && adjTarget > 0 && <span className="delta" style={{ color: deltaColor(pct) }}>Δ {delta > 0 ? "+" : ""}{delta} CFM ({pct > 0 ? "+" : ""}{pct}%)</span>}
                    </div>
                    {/* Inline return quick-add */}
                    <WizardReturnQuickAdd
                      unitId={unitId}
                      defaultName={room.name}
                      returns={getReturn(unitId)}
                      onAdd={(name) => addReturnEntry(unitId, name)}
                      onUpdate={(idx, field, val) => setReturnEntry(unitId, idx, field, val)}
                      onRemove={(idx) => removeReturnEntry(unitId, idx)}
                    />
                  </>
                )}
              </div>
              <div className="wiz-overview">
                {(() => {
                  const retEntries = getReturn(unitId);
                  const retGrand = retEntries.reduce((s, e) => s + e.readings.reduce((a: number, v) => a + (typeof v === "number" ? v : 0), 0), 0);
                  const tons = unitTons[unitId] || 0;
                  const nominal = Math.round(tons * 400);
                  const supPct = nominal && systemTotal ? Math.round(Math.abs(systemTotal - nominal) / nominal * 100) : null;
                  const retPct = nominal && retGrand ? Math.round(Math.abs(retGrand - nominal) / nominal * 100) : null;
                  return (
                    <table>
                      <thead><tr><th>Room</th><th>Total</th><th>Adj Target</th><th>CFM +/−</th><th>% +/−</th></tr></thead>
                      <tbody>
                        {rooms.map((r, i) => {
                          const merged = !!um[r.name];
                          const eff = effLoads[r.name] ?? 0;
                          const s = merged ? 0 : supplyTotal(unitId, r.name);
                          const lp = loadTotal ? eff / loadTotal : 0;
                          const at = covered && systemTotal ? Math.round(systemTotal * lp) : 0;
                          const d = s - at;
                          const p = at ? Math.round((d / at) * 100) : 0;
                          return (
                            <tr key={`s-${i}`} className={i === currentRoom ? "active" : ""} onClick={() => setCurrentRoom(i)} style={merged ? { opacity: 0.5, cursor: "pointer" } : undefined}>
                              <td>{r.name}{isTstat(unitId, r.name) && <b> (T)</b>} {merged ? `→ ${um[r.name]}` : s > 0 ? "✓" : ""}</td>
                              <td>{merged ? "—" : s || "—"}</td>
                              <td>{merged ? "—" : at > 0 ? at : eff}</td>
                              <td style={{ color: (!merged && at && s > 0) ? deltaColor(p) : undefined }}>{!merged && s > 0 && at > 0 ? d : "—"}</td>
                              <td>{!merged && s > 0 && at > 0 ? `${p}%` : "—"}</td>
                            </tr>
                          );
                        })}
                        {/* Supply total */}
                        <tr style={{ borderTop: "2px solid #333", fontWeight: 700 }}>
                          <td>Supply Total</td>
                          <td style={{ color: supPct !== null ? deltaColor(supPct) : undefined }}>{systemTotal || "—"}</td>
                          <td>{nominal || "—"}</td>
                          <td colSpan={2} style={{ color: supPct !== null ? deltaColor(supPct) : undefined, fontSize: 12 }}>
                            {nominal && systemTotal ? `${systemTotal > nominal ? "+" : ""}${systemTotal - nominal} CFM (${supPct! > 0 ? (systemTotal > nominal ? "+" : "-") : ""}${supPct}%)` : ""}
                          </td>
                        </tr>
                        {/* Return section */}
                        {retEntries.length > 0 && (
                          <>
                            <tr style={{ borderTop: "2px solid #e0e0e0" }}>
                              <th colSpan={5} style={{ textAlign: "left", padding: "8px 8px 4px", fontSize: 12, color: "#666", fontWeight: 600 }}>RETURNS</th>
                            </tr>
                            {retEntries.map((e, i) => {
                              const rt = e.readings.reduce((a: number, v) => a + (typeof v === "number" ? v : 0), 0);
                              return (
                                <tr key={`r-${i}`} style={{ color: "#555" }} onClick={() => setPhase("return")}>
                                  <td>{e.name || `Return ${i + 1}`}</td>
                                  <td>{rt || "—"}</td>
                                  <td colSpan={3}></td>
                                </tr>
                              );
                            })}
                            <tr style={{ borderTop: "2px solid #333", fontWeight: 700 }}>
                              <td>Return Total</td>
                              <td style={{ color: retPct !== null ? deltaColor(retPct) : undefined }}>{retGrand || "—"}</td>
                              <td>{nominal || "—"}</td>
                              <td colSpan={2} style={{ color: retPct !== null ? deltaColor(retPct) : undefined, fontSize: 12 }}>
                                {nominal && retGrand ? `${retGrand > nominal ? "+" : ""}${retGrand - nominal} CFM (${retPct! > 0 ? (retGrand > nominal ? "+" : "-") : ""}${retPct}%)` : ""}
                              </td>
                            </tr>
                          </>
                        )}
                      </tbody>
                    </table>
                  );
                })()}
              </div>
            </>
          );
        })()}

        {/* Phase: Return */}
        {phase === "return" && (() => {
          const entries = getReturn(unitId);
          const grandTotal = entries.reduce((s, e) => s + e.readings.reduce((a: number, v) => a + (typeof v === "number" ? v : 0), 0), 0);
          return (
            <div className="wiz-card">
              <h3>Return Air — {unit.name}</h3>
              {entries.length === 0 && <p style={{ color: "#999", fontSize: 14 }}>No returns added yet. Use the button below to add return readings.</p>}
              {entries.map((entry, i) => {
                const total = entry.readings.reduce((s: number, v) => s + (typeof v === "number" ? v : 0), 0);
                return (
                  <div className="wiz-return-row" key={i}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <input className="wiz-input" placeholder="Room / location" autoComplete="off" value={entry.name} onChange={e => setReturnEntry(unitId, i, "name", e.target.value)} style={{ flex: 1 }} />
                      <button onClick={() => removeReturnEntry(unitId, i)} style={{ background: "none", border: "none", color: "#999", fontSize: 18, cursor: "pointer", padding: "0 4px" }} title="Remove">×</button>
                    </div>
                    <div className="wiz-return-readings">
                      {[0, 1].map(j => (
                        <input key={j} className="wiz-input" type="text" inputMode="decimal" autoComplete="off" placeholder={`R${j + 1}`} value={entry.readings[j]} onChange={e => setReturnEntry(unitId, i, j, e.target.value)} />
                      ))}
                      <span style={{ fontSize: 14, fontWeight: 600, minWidth: 50, textAlign: "right" }}>{total || "—"}</span>
                    </div>
                  </div>
                );
              })}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, paddingTop: 12, borderTop: "1px solid #e0e0e0" }}>
                <button
                  onClick={() => addReturnEntry(unitId, "")}
                  style={{ background: "#2563eb", color: "#fff", border: "none", borderRadius: 6, padding: "8px 16px", fontSize: 14, fontWeight: 600, cursor: "pointer" }}
                >
                  + Add Return
                </button>
                <span style={{ fontSize: 15, fontWeight: 600 }}>Total Return: {grandTotal || "—"} CFM</span>
              </div>
            </div>
          );
        })()}

        {/* Phase: Static Pressure */}
        {phase === "static" && (() => {
          const sp = getStatic(unitId);
          const parseNum = (v: string | number): number => { const n = parseFloat(String(v)); return isNaN(n) ? 0 : n; };
          const fmtSp = (v: number): string => v ? (v < 0 ? "-" : "") + Math.abs(v).toFixed(2).replace(/^0\./, ".") : "—";
          const supplyVal = Math.abs(parseNum(sp.supply_esp));
          // Auto-negate: return and before-filter are always negative
          const returnVal = -Math.abs(parseNum(sp.return_esp));
          const beforeVal = -Math.abs(parseNum(sp.before_filter));
          const totalEsp = supplyVal || returnVal ? Math.abs(returnVal) + supplyVal : 0;
          const filterCoilDrop = beforeVal && returnVal ? Math.abs(returnVal) - Math.abs(beforeVal) : 0;
          return (
            <div className="wiz-card">
              <h3>Static Pressure — {unit.name}</h3>
              <p style={{ fontSize: 13, color: "#666", margin: "0 0 16px" }}>Enter positive values — return and before-filter are auto-negated.</p>
              <div className="wiz-static-row">
                <label>Supply</label>
                <input className="wiz-input" type="text" inputMode="decimal" autoComplete="off" value={sp.supply_esp} onChange={e => setStaticField(unitId, "supply_esp", e.target.value)} style={{ maxWidth: 120 }} />
                <span className="unit">in. w.c.</span>
                {supplyVal > 0 && <span style={{ fontSize: 13, color: "#16a34a", fontWeight: 600 }}>+{fmtSp(supplyVal)}</span>}
              </div>
              <div className="wiz-static-row">
                <label>Return</label>
                <input className="wiz-input" type="text" inputMode="decimal" autoComplete="off" value={sp.return_esp} onChange={e => setStaticField(unitId, "return_esp", e.target.value)} style={{ maxWidth: 120 }} />
                <span className="unit">in. w.c.</span>
                {returnVal < 0 && <span style={{ fontSize: 13, color: "#dc2626", fontWeight: 600 }}>{fmtSp(returnVal)}</span>}
              </div>
              <div className="wiz-static-row">
                <label>Before Filter</label>
                <input className="wiz-input" type="text" inputMode="decimal" autoComplete="off" value={sp.before_filter} onChange={e => setStaticField(unitId, "before_filter", e.target.value)} style={{ maxWidth: 120 }} />
                <span className="unit">in. w.c.</span>
                {beforeVal < 0 && <span style={{ fontSize: 13, color: "#dc2626", fontWeight: 600 }}>{fmtSp(beforeVal)}</span>}
              </div>
              <hr style={{ margin: "16px 0", border: "none", borderTop: "1px solid #e0e0e0" }} />
              <div className="wiz-static-row">
                <label>Total ESP</label>
                <span style={{ fontWeight: 600 }}>{totalEsp ? fmtSp(totalEsp) : "—"}</span>
              </div>
              <div className="wiz-static-row">
                <label>Filter & Coil Drop</label>
                <span style={{ fontWeight: 600 }}>{filterCoilDrop ? fmtSp(filterCoilDrop) : "—"}</span>
              </div>
              <hr style={{ margin: "16px 0", border: "none", borderTop: "1px solid #e0e0e0" }} />
              <div className="wiz-static-row">
                <label>Filter Type</label>
                <input className="wiz-input" type="text" autoComplete="off" value={sp.filter_type} onChange={e => setStaticField(unitId, "filter_type", e.target.value)} />
              </div>
            </div>
          );
        })()}

        {/* Phase: Checklist */}
        {phase === "checklist" && (
          <div className="wiz-card">
            <h3>Go/No-Go Checklist — {unit.name}</h3>
            {CHECKLIST_ITEMS.map(({ key, label }) => {
              const val = getChecklist(unitId)[key] ?? "";
              return (
                <div className="wiz-checklist-item" key={key}>
                  <span>{label}</span>
                  <div className="wiz-yn">
                    <button className={val === "y" ? "sel-y" : ""} onClick={() => setChecklistItem(unitId, key, "y")}>Y</button>
                    <button className={val === "n" ? "sel-n" : ""} onClick={() => setChecklistItem(unitId, key, "n")}>N</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Phase: Review */}
        {phase === "review" && (
          <>
            <div className="wiz-card">
              <h3>Review — {unit.name}</h3>
              <div className="wiz-review-section">
                <h4>Supply Readings</h4>
                {(() => {
                  const effLoads = getEffectiveLoads(unitId, rooms);
                  const loadTotal = Object.values(effLoads).reduce((a, b) => a + b, 0);
                  const um = getUnitMerges(unitId);
                  const systemTotal = rooms.filter(r => !um[r.name]).reduce((s, r) => s + supplyTotal(unitId, r.name), 0);
                  const covered = allRoomsCovered(unitId, rooms);
                  return (
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                      <thead><tr><th style={{ textAlign: "left", padding: "4px 6px" }}>Room</th><th>Total</th><th>Adj Target</th><th>CFM +/−</th></tr></thead>
                      <tbody>
                        {rooms.map((r, i) => {
                          const merged = !!um[r.name];
                          const eff = effLoads[r.name] ?? 0;
                          const s = merged ? 0 : supplyTotal(unitId, r.name);
                          const lp = loadTotal ? eff / loadTotal : 0;
                          const at = covered && systemTotal ? Math.round(systemTotal * lp) : 0;
                          const d = s - at;
                          const p = at ? Math.round((d / at) * 100) : 0;
                          return (
                            <tr key={i} style={merged ? { opacity: 0.4 } : undefined}>
                              <td style={{ padding: "4px 6px" }}>{r.name}{isTstat(unitId, r.name) && <b> (T)</b>}{merged ? ` → ${um[r.name]}` : ""}</td>
                              <td style={{ textAlign: "center" }}>{merged ? "—" : s || "—"}</td>
                              <td style={{ textAlign: "center" }}>{merged ? "—" : at > 0 ? at : eff}</td>
                              <td style={{ textAlign: "center", color: (!merged && at && s > 0) ? deltaColor(p) : undefined }}>{!merged && s > 0 && at > 0 ? d : "—"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  );
                })()}
              </div>
              <div className="wiz-review-section">
                <h4>Static Pressure</h4>
                {(() => {
                  const sp = getStatic(unitId);
                  const pn = (v: string | number): number => { const n = parseFloat(String(v)); return isNaN(n) ? 0 : n; };
                  const fmt = (v: number): string => v ? (v < 0 ? "-" : "+") + Math.abs(v).toFixed(2).replace(/^0\./, ".") : "—";
                  const sv = Math.abs(pn(sp.supply_esp));
                  const rv = -Math.abs(pn(sp.return_esp));
                  const bv = -Math.abs(pn(sp.before_filter));
                  return (
                    <div style={{ fontSize: 14 }}>
                      <div>Supply: {fmt(sv)} | Return: {fmt(rv)} | Before Filter: {fmt(bv)}</div>
                      {(sv || rv) && <div>Total ESP: {(Math.abs(rv) + sv).toFixed(2).replace(/^0\./, ".")} | Filter & Coil Drop: {bv && rv ? (Math.abs(rv) - Math.abs(bv)).toFixed(2).replace(/^0\./, ".") : "—"}</div>}
                      {sp.filter_type && <div>Filter: {sp.filter_type}</div>}
                    </div>
                  );
                })()}
              </div>
              <div className="wiz-review-section">
                <h4>Checklist</h4>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 14 }}>
                  {CHECKLIST_ITEMS.map(({ key, label }) => {
                    const val = getChecklist(unitId)[key];
                    return <span key={key} style={{ color: val === "y" ? "#16a34a" : val === "n" ? "#dc2626" : "#999" }}>{label}: {val ? val.toUpperCase() : "—"}</span>;
                  })}
                </div>
              </div>
            </div>
            <div className="wiz-download">
              <button className="xlsx" onClick={() => downloadFile("/api/export/airflow", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx")} disabled={downloading}>
                {downloading ? "Downloading…" : "Download .xlsx"}
              </button>
            </div>
          </>
        )}

        {/* Bottom nav */}
        <div className="wiz-nav">
          <button onClick={goBack} disabled={currentUnit === 0 && phase === "supply" && currentRoom === 0}>
            ← Back
          </button>
          {phase !== "review" ? (
            <button className="primary" onClick={goNext}>
              {phase === "supply" && currentRoom < rooms.length - 1 ? "Next Room →" : "Next →"}
            </button>
          ) : currentUnit < units.length - 1 ? (
            <button className="primary" onClick={goNext}>Next Unit →</button>
          ) : null}
        </div>
      </div>
    </>
  );
}

// ── Root: hash-based routing ──────────────────────────────────────────────────

function sessionFromAuthResponse(data: Record<string, any>): AuthSession {
  const expiresIn = Number(data.expires_in ?? 3600);
  return {
    access_token: String(data.access_token ?? ""),
    refresh_token: String(data.refresh_token ?? ""),
    expires_at: Date.now() + expiresIn * 1000,
    user: {
      id: data.user?.id,
      email: data.user?.email,
    },
  };
}

async function refreshSupabaseSession(config: AuthConfig, session: AuthSession): Promise<AuthSession> {
  const response = await nativeFetch(`${config.supabase_url}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": config.supabase_anon_key ?? "",
    },
    body: JSON.stringify({ refresh_token: session.refresh_token }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error_description ?? data.msg ?? data.error ?? "Session refresh failed.");
  }
  const refreshed = sessionFromAuthResponse(data);
  writeAuthSession(refreshed);
  return refreshed;
}

async function verifySession(session: AuthSession): Promise<void> {
  const response = await nativeFetch("/api/auth/me", {
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  if (!response.ok) {
    throw new Error("Session could not be verified.");
  }
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    async function initAuth() {
      try {
        const response = await nativeFetch("/api/auth/config");
        const nextConfig = await response.json() as AuthConfig;
        if (!mounted) return;
        setConfig(nextConfig);
        if (nextConfig.mode !== "supabase") {
          setLoading(false);
          return;
        }

        const stored = readAuthSession();
        if (!stored?.access_token) {
          setLoading(false);
          return;
        }

        let active = stored;
        if (stored.expires_at - Date.now() < 60_000 && stored.refresh_token) {
          active = await refreshSupabaseSession(nextConfig, stored);
        } else {
          writeAuthSession(stored);
        }
        await verifySession(active);
        if (!mounted) return;
        setSession(active);
      } catch {
        clearAuthSession();
      } finally {
        if (mounted) setLoading(false);
      }
    }
    initAuth();
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    const handler = () => {
      clearAuthSession();
      setSession(null);
      setError("Your session expired. Sign in again.");
    };
    window.addEventListener("vrc-auth-expired", handler);
    return () => window.removeEventListener("vrc-auth-expired", handler);
  }, []);

  useEffect(() => {
    if (config?.mode !== "supabase" || !session?.refresh_token) return;
    const refreshIfNeeded = async () => {
      const current = readAuthSession();
      if (!current?.refresh_token) return;
      if (current.expires_at - Date.now() > 5 * 60_000) return;
      try {
        const refreshed = await refreshSupabaseSession(config, current);
        setSession(refreshed);
      } catch {
        clearAuthSession();
        setSession(null);
        setError("Your session expired. Sign in again.");
      }
    };
    const interval = window.setInterval(refreshIfNeeded, 60_000);
    return () => window.clearInterval(interval);
  }, [config, session]);

  async function signIn(event: React.FormEvent) {
    event.preventDefault();
    if (!config?.supabase_url || !config.supabase_anon_key) {
      setError("Supabase Auth is not configured for this deployment.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const response = await nativeFetch(`${config.supabase_url}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": config.supabase_anon_key,
        },
        body: JSON.stringify({ email, password }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error_description ?? data.msg ?? data.error ?? "Sign in failed.");
      }
      const nextSession = sessionFromAuthResponse(data);
      if (!nextSession.access_token || !nextSession.refresh_token) {
        throw new Error("Supabase did not return a complete session.");
      }
      writeAuthSession(nextSession);
      await verifySession(nextSession);
      setSession(nextSession);
    } catch (err) {
      clearAuthSession();
      setError(err instanceof Error ? err.message : "Sign in failed.");
    } finally {
      setSubmitting(false);
    }
  }

  function signOut() {
    clearAuthSession();
    setSession(null);
    setPassword("");
  }

  if (loading) {
    return <main className="auth-root"><div className="auth-card"><h1>VRC</h1><p>Loading session...</p></div></main>;
  }

  if (!config || config.mode === "none" || config.mode === "basic") {
    return <>{children}</>;
  }

  if (!session) {
    return (
      <main className="auth-root">
        <form className="auth-card" onSubmit={signIn}>
          <div className="auth-brand">
            <img src="/logo.png" alt="Baseline" />
            <div>
              <h1>VRC</h1>
              <p>Sign in with your staff account.</p>
            </div>
          </div>
          <label>
            Email
            <input
              autoComplete="email"
              inputMode="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>
          <label>
            Password
            <input
              autoComplete="current-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          {error && <div className="auth-error">{error}</div>}
          <button className="toolbar-primary" type="submit" disabled={submitting}>
            {submitting ? "Signing in..." : "Sign In"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <>
      <div className="auth-session-pill">
        <span>{session.user?.email ?? "Signed in"}</span>
        <button onClick={signOut}>Sign out</button>
      </div>
      {children}
    </>
  );
}

function Root() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const handler = () => setHash(window.location.hash);
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);
  let routed = <App />;
  if (hash === "#/admin") routed = <AdminPanel />;
  if (hash === "#/takeoff") routed = <TakeoffApp />;
  if (hash.startsWith("#/airflow-wizard")) routed = <AirflowWizard />;
  return <AuthGate>{routed}</AuthGate>;
}

createRoot(document.getElementById("root")!).render(<Root />);
