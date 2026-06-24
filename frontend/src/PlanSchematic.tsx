import { useEffect, useRef } from "react";

// Payload-synthesized schematic (ADR 0009). A read-only, top-down "radial slice" diagram
// built purely from the calculator payload — no takeoff geometry required. Each exterior
// room is a trapezoidal slice placed at its exterior-wall bearing, with its wall on the
// outer arc (glass in blue); interior-only rooms fill the central core. It deliberately does
// NOT draw a true footprint: the payload omits ~18% of the perimeter (garage/party/interior
// walls) so the real outline cannot close, and same-orientation walls are merged. This is a
// sense-check, not the plan. Levels/zones render side by side (no false vertical stacking).

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
type Compass = (typeof COMPASS)[number];
const SQ = Math.SQRT1_2;
const BEARING: Record<Compass, [number, number]> = {
  N: [0, -1], NE: [SQ, -SQ], E: [1, 0], SE: [SQ, SQ],
  S: [0, 1], SW: [-SQ, SQ], W: [-1, 0], NW: [-SQ, -SQ],
};

type DirInfo = { wall: number; glass: number; door: number };
export type SchematicRoom = {
  name: string;
  level: number;
  levelName: string;
  floorArea: number;
  ceilingHeight: number;
  dirs: Record<Compass, DirInfo>;
};
type AnyPayload = Record<string, any>;

function classify(assembly: string | undefined, kind: string | undefined): "glass" | "door" | "wall" | null {
  const code = (assembly ?? "").toUpperCase();
  if (kind === "glass" || code.startsWith("G")) return "glass";
  if (code.startsWith("D")) return "door";
  if (code.startsWith("W")) return "wall";
  return null;
}

export function synthesizeRooms(payload: AnyPayload): SchematicRoom[] {
  const project = payload?.project ?? payload ?? {};
  const levels: AnyPayload[] = project.levels ?? [];
  const rooms: SchematicRoom[] = [];
  levels.forEach((level, levelIndex) => {
    const levelName = level.name ?? `Level ${levelIndex + 1}`;
    const byName = new Map<string, SchematicRoom>();
    for (const room of level.rooms ?? []) {
      const blank = () => ({ wall: 0, glass: 0, door: 0 });
      const dirs = Object.fromEntries(COMPASS.map((d) => [d, blank()])) as Record<Compass, DirInfo>;
      byName.set(room.name, {
        name: room.name,
        level: levelIndex,
        levelName,
        floorArea: Number(room.floor_area) || 0,
        ceilingHeight: Number(room.ceiling_height) || 9,
        dirs,
      });
    }
    for (const item of level.line_items ?? []) {
      const room = byName.get(item.room_name);
      const dir = item.direction as Compass | undefined;
      if (!room || !dir || !(dir in room.dirs)) continue;
      const klass = classify(item.assembly, item.kind);
      const area = Number(item.area) || 0;
      if (klass === "glass") room.dirs[dir].glass += area;
      else if (klass === "door") room.dirs[dir].door += area;
      else if (klass === "wall") room.dirs[dir].wall += area;
    }
    rooms.push(...byName.values());
  });
  return rooms;
}

type Derived = {
  room: SchematicRoom;
  bearing: number;
  mag: number;
  glassA: number;
  extArea: number;
};
function derive(room: SchematicRoom): Derived {
  let vx = 0;
  let vz = 0;
  let glassA = 0;
  let extArea = 0;
  for (const d of COMPASS) {
    const i = room.dirs[d];
    const len = i.wall + i.glass + i.door;
    if (len > 0) {
      vx += BEARING[d][0] * len;
      vz += BEARING[d][1] * len;
    }
    glassA += i.glass;
    extArea += len;
  }
  return { room, bearing: Math.atan2(vx, -vz), mag: Math.hypot(vx, vz), glassA, extArea };
}

type Palette = {
  floor: string; icore: string; wall: string; glass: string; text: string; sub: string; bd: string;
};
function palette(dark: boolean): Palette {
  return dark
    ? { floor: "rgba(95,200,170,.18)", icore: "rgba(150,160,170,.16)", wall: "#9fb4c9", glass: "#56b4e6", text: "#e9eef2", sub: "#9fb0bd", bd: "rgba(255,255,255,.22)" }
    : { floor: "rgba(47,125,111,.18)", icore: "rgba(90,100,110,.12)", wall: "#46535f", glass: "#2b9fd6", text: "#16222b", sub: "#5a6b78", bd: "rgba(0,0,0,.16)" };
}

const polar = (cx: number, cy: number, r: number, phi: number): [number, number] => [cx + r * Math.sin(phi), cy - r * Math.cos(phi)];
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function drawLevel(x: CanvasRenderingContext2D, rooms: SchematicRoom[], cx: number, cy: number, R: number, C: Palette) {
  const derived = rooms.map(derive);
  const ext = derived.filter((d) => d.mag > 0.01).sort((a, b) => a.bearing - b.bearing);
  const interior = derived.filter((d) => d.mag <= 0.01);
  const extA = ext.reduce((s, d) => s + d.room.floorArea, 0);
  const intA = interior.reduce((s, d) => s + d.room.floorArea, 0);
  const totA = extA + intA || 1;
  const Rmid = ext.length ? R * Math.sqrt(intA / totA) : 0;

  x.textAlign = "center";
  x.textBaseline = "middle";

  let a = ext.length ? ext[0].bearing - (2 * Math.PI * ext[0].room.floorArea / extA) / 2 : 0;
  for (const d of ext) {
    const wsec = (2 * Math.PI * d.room.floorArea) / extA;
    const a0 = a;
    const a1 = a + wsec;
    a = a1;
    const ns = Math.max(2, Math.round(wsec / 0.12));

    x.beginPath();
    for (let k = 0; k <= ns; k++) { const ph = a0 + (a1 - a0) * (k / ns); const p = polar(cx, cy, R, ph); k ? x.lineTo(p[0], p[1]) : x.moveTo(p[0], p[1]); }
    for (let k = ns; k >= 0; k--) { const ph = a0 + (a1 - a0) * (k / ns); const p = polar(cx, cy, Rmid, ph); x.lineTo(p[0], p[1]); }
    x.closePath();
    x.fillStyle = C.floor; x.fill();
    x.strokeStyle = C.bd; x.lineWidth = 1; x.stroke();

    x.strokeStyle = C.wall; x.lineWidth = 4; x.beginPath();
    for (let k = 0; k <= ns; k++) { const ph = a0 + (a1 - a0) * (k / ns); const p = polar(cx, cy, R, ph); k ? x.lineTo(p[0], p[1]) : x.moveTo(p[0], p[1]); }
    x.stroke();

    if (d.glassA > 0.5) {
      const gf = Math.min(0.85, d.glassA / (d.extArea || 1) + 0.1);
      const gm = (a0 + a1) / 2;
      const gw = (a1 - a0) * gf;
      x.strokeStyle = C.glass; x.lineWidth = 4.5; x.beginPath();
      for (let k = 0; k <= 8; k++) { const ph = gm - gw / 2 + gw * (k / 8); const p = polar(cx, cy, R, ph); k ? x.lineTo(p[0], p[1]) : x.moveTo(p[0], p[1]); }
      x.stroke();
    }

    const lp = polar(cx, cy, (R + Rmid) / 2, (a0 + a1) / 2);
    x.fillStyle = C.text; x.font = "12px sans-serif"; x.fillText(clip(d.room.name, 13), lp[0], lp[1] - 6);
    x.fillStyle = C.sub; x.font = "11px sans-serif"; x.fillText(`${Math.round(d.room.floorArea)} sf`, lp[0], lp[1] + 8);
  }

  let ia = -Math.PI / 2;
  for (const d of interior) {
    const wsec = (2 * Math.PI * d.room.floorArea) / (intA || 1);
    const a0 = ia;
    const a1 = ia + wsec;
    ia = a1;
    const ns = Math.max(2, Math.round(wsec / 0.2));
    x.beginPath();
    x.moveTo(cx, cy);
    for (let k = 0; k <= ns; k++) { const ph = a0 + (a1 - a0) * (k / ns); const p = polar(cx, cy, Rmid, ph); x.lineTo(p[0], p[1]); }
    x.closePath();
    x.fillStyle = C.icore; x.fill();
    x.strokeStyle = C.bd; x.lineWidth = 1; x.stroke();
    const lp = polar(cx, cy, Rmid * 0.6, (a0 + a1) / 2);
    x.fillStyle = C.text; x.font = "11px sans-serif"; x.fillText(clip(d.room.name, 12), lp[0], lp[1]);
  }

  x.fillStyle = C.sub; x.font = "11px sans-serif"; x.fillText("N", cx, cy - R - 12);
}

export default function PlanSchematic({ payload }: { payload: AnyPayload }) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;

    const draw = () => {
      const w = wrap.clientWidth || 800;
      const h = wrap.clientHeight || 480;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      const x = canvas.getContext("2d");
      if (!x) return;
      x.setTransform(dpr, 0, 0, dpr, 0, 0);
      x.clearRect(0, 0, w, h);

      const dark = !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
      const C = palette(dark);

      const rooms = synthesizeRooms(payload);
      const levelIndices = Array.from(new Set(rooms.map((r) => r.level))).sort((a, b) => a - b);
      const n = Math.max(1, levelIndices.length);
      const colW = w / n;
      const R = Math.max(40, Math.min(h / 2 - 34, colW / 2 - 24));

      levelIndices.forEach((li, i) => {
        const levelRooms = rooms.filter((r) => r.level === li);
        const cx = colW * (i + 0.5);
        const cy = h / 2;
        drawLevel(x, levelRooms, cx, cy, R, C);
        if (n > 1) {
          x.fillStyle = C.sub; x.font = "12px sans-serif"; x.textAlign = "center";
          x.fillText(clip(levelRooms[0]?.levelName ?? "", 22), cx, cy + R + 22);
        }
      });

      x.fillStyle = C.sub; x.font = "11px sans-serif"; x.textAlign = "left";
      x.fillText("outer arc = exterior wall · blue = glass · centre = interior rooms · schematic, not the true footprint", 12, 16);
    };

    draw();
    window.addEventListener("resize", draw);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(draw) : null;
    if (ro) ro.observe(wrap);
    return () => {
      window.removeEventListener("resize", draw);
      if (ro) ro.disconnect();
    };
  }, [payload]);

  return (
    <div ref={wrapRef} style={{ width: "100%", height: "100%", minHeight: 480 }}>
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />
    </div>
  );
}
