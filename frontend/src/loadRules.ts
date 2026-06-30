export function ventilationCfmForBedrooms(bedrooms: number) {
  return 15 * (Math.max(0, Math.floor(bedrooms)) + 1);
}

type CodeMinimumDefinition = {
  code: string;
  category?: string;
  u_value?: number | null;
  shgc?: number | null;
  description?: string;
};

type ClimateZoneMinimums = {
  fenestration_u_max: number;
  skylight_u_max: number;
  glazed_fenestration_shgc_max: number | null;
  ceiling_r_min: number;
  ceiling_u_max: number;
  ceiling_r30_full_eave_allowed: boolean;
  indirect_conditioned_attic_r_min: number;
  indirect_conditioned_attic_u_max: number;
  wood_frame_wall_r_min: number;
  wood_frame_wall_u_max: number;
  attic_kneewall_r_min: number;
  mass_wall_r_min: number;
  mass_wall_alt_r_min: number;
  mass_wall_u_max: number;
  floor_r_min: number;
  floor_u_max: number;
  cantilever_floor_r_min: number;
  cantilever_floor_u_max: number;
  basement_wall_r_min: number;
  basement_wall_u_max: number;
  crawl_wall_r_min: number;
  crawl_wall_u_max: number;
  slab_perimeter_r_min: number;
};

type GeorgiaClimateZone = "2A" | "3A" | "4A";

export const georgiaCodeMinimumFallback = {
  jurisdiction: "Georgia",
  code_edition: "2015 IECC with Georgia State Supplements and Amendments",
  effective_date: "2020-01-01 with 2022 and 2023 amendment packets applied",
  checked_date: "2026-06-30",
  status_source_url: "https://dca.georgia.gov/community-assistance/construction-codes/current-state-minimum-codes-construction",
  prescriptive_basis: "DCA Georgia-amended 2015 IECC Tables R402.1.2/R402.1.4 plus R402.2.1, R402.1.2.1, and the 2023 cantilevered-floor footnote; advisory warnings only.",
  default_climate_zone: "3A",
  climate_zones: {
    "2A": {
      fenestration_u_max: 0.35,
      skylight_u_max: 0.65,
      glazed_fenestration_shgc_max: 0.27,
      ceiling_r_min: 38,
      ceiling_u_max: 0.030,
      ceiling_r30_full_eave_allowed: true,
      indirect_conditioned_attic_r_min: 20,
      indirect_conditioned_attic_u_max: 0.050,
      wood_frame_wall_r_min: 13,
      wood_frame_wall_u_max: 0.084,
      attic_kneewall_r_min: 18,
      mass_wall_r_min: 4,
      mass_wall_alt_r_min: 6,
      mass_wall_u_max: 0.165,
      floor_r_min: 13,
      floor_u_max: 0.064,
      cantilever_floor_r_min: 30,
      cantilever_floor_u_max: 0.035,
      basement_wall_r_min: 0,
      basement_wall_u_max: 0.360,
      crawl_wall_r_min: 0,
      crawl_wall_u_max: 0.477,
      slab_perimeter_r_min: 0,
    },
    "3A": {
      fenestration_u_max: 0.35,
      skylight_u_max: 0.55,
      glazed_fenestration_shgc_max: 0.27,
      ceiling_r_min: 38,
      ceiling_u_max: 0.030,
      ceiling_r30_full_eave_allowed: true,
      indirect_conditioned_attic_r_min: 20,
      indirect_conditioned_attic_u_max: 0.050,
      wood_frame_wall_r_min: 13,
      wood_frame_wall_u_max: 0.084,
      attic_kneewall_r_min: 18,
      mass_wall_r_min: 8,
      mass_wall_alt_r_min: 13,
      mass_wall_u_max: 0.098,
      floor_r_min: 19,
      floor_u_max: 0.047,
      cantilever_floor_r_min: 30,
      cantilever_floor_u_max: 0.035,
      basement_wall_r_min: 5,
      basement_wall_u_max: 0.091,
      crawl_wall_r_min: 5,
      crawl_wall_u_max: 0.136,
      slab_perimeter_r_min: 0,
    },
    "4A": {
      fenestration_u_max: 0.35,
      skylight_u_max: 0.55,
      glazed_fenestration_shgc_max: 0.27,
      ceiling_r_min: 38,
      ceiling_u_max: 0.030,
      ceiling_r30_full_eave_allowed: true,
      indirect_conditioned_attic_r_min: 20,
      indirect_conditioned_attic_u_max: 0.050,
      wood_frame_wall_r_min: 13,
      wood_frame_wall_u_max: 0.084,
      attic_kneewall_r_min: 18,
      mass_wall_r_min: 8,
      mass_wall_alt_r_min: 13,
      mass_wall_u_max: 0.098,
      floor_r_min: 19,
      floor_u_max: 0.047,
      cantilever_floor_r_min: 30,
      cantilever_floor_u_max: 0.035,
      basement_wall_r_min: 10,
      basement_wall_u_max: 0.059,
      crawl_wall_r_min: 10,
      crawl_wall_u_max: 0.065,
      slab_perimeter_r_min: 0,
    },
  } satisfies Record<GeorgiaClimateZone, ClimateZoneMinimums>,
};

const georgiaZone4Counties = [
  "banks",
  "catoosa",
  "chattooga",
  "dade",
  "dawson",
  "fannin",
  "floyd",
  "gilmer",
  "gordon",
  "habersham",
  "lumpkin",
  "murray",
  "pickens",
  "rabun",
  "stephens",
  "towns",
  "union",
  "walker",
  "white",
  "whitfield",
];

export function codeComplianceWarningsForTypeDefinitions(location: string, definitions: CodeMinimumDefinition[]) {
  if (!/\b(GA|Georgia)\b/i.test(location)) return [];
  const zone = inferGeorgiaClimateZone(location);
  const thresholds = georgiaCodeMinimumFallback.climate_zones[zone];
  const warnings = definitions
    .map((definition) => codeComplianceWarningForDefinition(definition, thresholds, zone))
    .filter((warning): warning is string => Boolean(warning));
  if (!warnings.length) return [];
  return [
    `Advisory Georgia code-minimum screening uses ${georgiaCodeMinimumFallback.code_edition} (${zone}); this warning does not block calculation or override user inputs.`,
    ...warnings,
  ];
}

function inferGeorgiaClimateZone(location: string): GeorgiaClimateZone {
  const lower = location.toLowerCase();
  if (/\b(2a|zone\s*2|climate\s*zone\s*2)\b/i.test(location)) return "2A";
  if (/\b(3a|zone\s*3|climate\s*zone\s*3)\b/i.test(location)) return "3A";
  if (/\b(4a|zone\s*4|climate\s*zone\s*4)\b/i.test(location)) return "4A";
  return georgiaZone4Counties.some((county) => new RegExp(`\\b${county}\\s+county\\b`).test(lower))
    ? "4A"
    : "3A";
}

function codeComplianceWarningForDefinition(
  definition: CodeMinimumDefinition,
  thresholds: ClimateZoneMinimums,
  zone: GeorgiaClimateZone,
) {
  const code = (definition.code || "").trim().toUpperCase();
  const label = definition.description?.trim() || code;
  const rValue = rValueFromLabel(label);
  const uValue = toNumber(definition.u_value);
  const shgc = toNumber(definition.shgc);

  if (code.startsWith("G") || definition.category === "Glass") {
    const fenestrationMax = isSkylight(label) ? thresholds.skylight_u_max : thresholds.fenestration_u_max;
    const fenestrationLabel = isSkylight(label) ? "skylight" : "fenestration";
    if (uValue != null && uValue > fenestrationMax) {
      return `${code} ${label} has U ${formatNumber(uValue)}, above GA ${zone} ${fenestrationLabel} maximum U ${fenestrationMax}.`;
    }
    const shgcMax = thresholds.glazed_fenestration_shgc_max;
    if (shgcMax != null && shgc != null && shgc > shgcMax) {
      return `${code} ${label} has SHGC ${formatNumber(shgc)}, above GA ${zone} glazed fenestration maximum SHGC ${shgcMax}.`;
    }
    return null;
  }

  if (isSlab(label)) {
    return opaqueCodeWarning(code, label, uValue, rValue, thresholds.slab_perimeter_r_min, Infinity, "slab perimeter", zone);
  }

  if (isBasementWall(label)) {
    return opaqueCodeWarning(code, label, uValue, rValue, thresholds.basement_wall_r_min, thresholds.basement_wall_u_max, "basement wall", zone);
  }

  if (isCrawlWall(label)) {
    return opaqueCodeWarning(code, label, uValue, rValue, thresholds.crawl_wall_r_min, thresholds.crawl_wall_u_max, "crawl wall", zone);
  }

  if (isAtticKneewall(label)) {
    if (isRooflineInsulatedContext(label)) {
      return `${code} ${label} appears to be an attic kneewall inside a roofline-insulated attic; verify it is treated as interior per GA roofline-insulation guidance.`;
    }
    return opaqueCodeWarning(code, label, uValue, rValue, thresholds.attic_kneewall_r_min, thresholds.wood_frame_wall_u_max, "attic kneewall", zone);
  }

  if (code.startsWith("W") || definition.category === "Wall") {
    if (isMassWall(label)) {
      return opaqueCodeWarning(code, label, uValue, rValue, thresholds.mass_wall_r_min, thresholds.mass_wall_u_max, "mass wall", zone, thresholds.mass_wall_alt_r_min);
    }
    return opaqueCodeWarning(code, label, uValue, rValue, thresholds.wood_frame_wall_r_min, thresholds.wood_frame_wall_u_max, "wood-frame wall", zone);
  }

  if (code.startsWith("R") || code.startsWith("C") || definition.category === "Ceiling") {
    return ceilingCodeWarning(code, label, uValue, rValue, thresholds, zone);
  }

  if ((code.startsWith("F") || definition.category === "Floor") && !label.toUpperCase().includes("SLAB")) {
    if (isCantileveredFloor(label)) {
      return opaqueCodeWarning(code, label, uValue, rValue, thresholds.cantilever_floor_r_min, thresholds.cantilever_floor_u_max, "cantilevered floor over outside air", zone);
    }
    return opaqueCodeWarning(code, label, uValue, rValue, thresholds.floor_r_min, thresholds.floor_u_max, "floor over unheated space", zone);
  }

  return null;
}

function opaqueCodeWarning(
  code: string,
  label: string,
  uValue: number | null,
  rValue: number | null,
  rMin: number,
  uMax: number,
  component: string,
  zone: GeorgiaClimateZone,
  rAltMin?: number,
) {
  const rTarget = rAltMin == null ? `R-${formatNumber(rMin)}` : `R-${formatNumber(rMin)} continuous or R-${formatNumber(rAltMin)} cavity`;
  if (rValue != null) {
    return rValue < rMin
      ? `${code} ${label} appears to be R-${formatNumber(rValue)}, below GA ${zone} ${component} minimum ${rTarget}.`
      : null;
  }
  if (uValue != null && uValue > uMax) {
    return `${code} ${label} has U ${formatNumber(uValue)}, above GA ${zone} ${component} maximum U ${formatNumber(uMax)}.`;
  }
  return null;
}

function ceilingCodeWarning(
  code: string,
  label: string,
  uValue: number | null,
  rValue: number | null,
  thresholds: ClimateZoneMinimums,
  zone: GeorgiaClimateZone,
) {
  if (isIndirectlyConditionedAttic(label)) {
    if (rValue != null) {
      if (rValue < thresholds.indirect_conditioned_attic_r_min) {
        return `${code} ${label} appears to be R-${formatNumber(rValue)}, below GA ${zone} indirectly conditioned attic allowance minimum R-${thresholds.indirect_conditioned_attic_r_min}.`;
      }
      return `${code} ${label} uses the GA indirectly conditioned attic allowance; verify <3 ACH50, non-negative-only whole-house ventilation, covered rafters where required, and HVAC/ductwork inside the envelope.`;
    }
    if (uValue != null) {
      if (uValue > thresholds.indirect_conditioned_attic_u_max) {
        return `${code} ${label} has U ${formatNumber(uValue)}, above GA ${zone} indirectly conditioned attic allowance maximum U ${formatNumber(thresholds.indirect_conditioned_attic_u_max)}.`;
      }
      return `${code} ${label} uses the GA indirectly conditioned attic allowance; verify <3 ACH50, non-negative-only whole-house ventilation, covered rafters where required, and HVAC/ductwork inside the envelope.`;
    }
  }

  if (
    rValue != null &&
    rValue >= 30 &&
    rValue < thresholds.ceiling_r_min &&
    thresholds.ceiling_r30_full_eave_allowed
  ) {
    if (hasFullEaveContext(label)) return null;
    return `${code} ${label} appears to use the GA R-30 ceiling allowance; verify full-height uncompressed R-30 extends over the wall top plate at the eaves.`;
  }

  return opaqueCodeWarning(code, label, uValue, rValue, thresholds.ceiling_r_min, thresholds.ceiling_u_max, "ceiling", zone);
}

function rValueFromLabel(label: string) {
  const match = label.match(/\bR[-\s]?(\d+(?:\.\d+)?)\b/i);
  return match ? Number(match[1]) : null;
}

function isSkylight(label: string) {
  return /\bsky[\s-]*light\b/i.test(label);
}

function isSlab(label: string) {
  return /\bslab\b/i.test(label);
}

function isBasementWall(label: string) {
  return /\bbasement\b/i.test(label) && /\bwall\b/i.test(label);
}

function isCrawlWall(label: string) {
  return /\bcrawl(?:\s*space)?\b/i.test(label) && /\bwall\b/i.test(label);
}

function isAtticKneewall(label: string) {
  return /\b(knee[\s-]*wall|kneewall)\b/i.test(label);
}

function isMassWall(label: string) {
  return /\b(mass|masonry|cmu|concrete|block|brick)\b/i.test(label);
}

function isCantileveredFloor(label: string) {
  return /\b(cantilever|over outside air)\b/i.test(label);
}

function isRooflineInsulatedContext(label: string) {
  return /\b(spray|sprayed|foam|air[\s-]*impermeable|roof[\s-]*line|roof[\s-]*deck|unvented|conditioned attic|indirectly conditioned)\b/i.test(label);
}

function isIndirectlyConditionedAttic(label: string) {
  return isRooflineInsulatedContext(label) && /\b(attic|roof|deck|rafter|spray|sprayed|foam)\b/i.test(label);
}

function hasFullEaveContext(label: string) {
  return /\b(raised[\s-]*heel|energy[\s-]*heel|full[\s-]*height|uncompressed|top plate|eave|extended? over)\b/i.test(label);
}

function toNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}
