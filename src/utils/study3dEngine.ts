import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import type {
  Study3DArchetype,
  Study3DEnvironment,
  Study3DPartSpec,
  Study3DSceneBlueprint,
  StudyVideoScene,
} from "../types";

export type LightingPreset = "studio" | "dramatic" | "daylight";
export type CameraPreset = "hero" | "closeup" | "top" | "side";

export interface Study3DAnchor {
  label: string;
  position: [number, number, number];
  /** Optional scene indices (0-based) where this physical part should be highlighted. */
  focusScenes?: number[];
}

export interface Study3DProjectedLabel {
  label: string;
  x: number;
  y: number;
  visible: boolean;
  highlight: boolean;
}

const _targetVec = new THREE.Vector3();
const _camGoalVec = new THREE.Vector3();
const _projVec = new THREE.Vector3();

let cachedIsSoftwareGl: boolean | null = null;

export function detectSoftwareWebGl(): boolean {
  if (cachedIsSoftwareGl !== null) return cachedIsSoftwareGl;
  if (typeof document === "undefined") {
    cachedIsSoftwareGl = true;
    return true;
  }
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
    if (!gl) {
      cachedIsSoftwareGl = true;
      return true;
    }
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param) || "");
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    cachedIsSoftwareGl =
      /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
    return cachedIsSoftwareGl;
  } catch {
    cachedIsSoftwareGl = true;
    return true;
  }
}

function safeHex(hex?: string, fallback = "#2563EB"): string {
  if (hex && /^#[0-9a-fA-F]{6}$/.test(hex.trim())) return hex.trim();
  return fallback;
}

export function visualAccentToArchetype(
  accent?: StudyVideoScene["visualAccent"]
): Study3DArchetype {
  switch (accent) {
    case "sun":
      return "solar";
    case "atom":
      return "atom";
    case "globe":
      return "earth";
    case "wave":
      return "wave";
    case "leaf":
      return "plant";
    case "rocket":
      return "rocket";
    case "circuit":
      return "circuit";
    case "heart":
      return "heart";
    case "chart":
    case "book":
    default:
      return "architecture";
  }
}

export function infer3DSceneBlueprint(
  title: string,
  subject?: string,
  accentColor?: string,
  fallbackArchetype?: Study3DArchetype
): Study3DSceneBlueprint {
  const hay = `${title || ""} ${subject || ""}`.toLowerCase();
  let archetype: Study3DArchetype = fallbackArchetype || "architecture";
  let environment: Study3DEnvironment = "studio";
  let primaryColor = safeHex(accentColor, "#2563EB");
  let secondaryAccent = "#38BDF8";

  if (/(solar|planet|sun|moon|orbit|galaxy|star|saturn|jupiter|mars|astronomy|universe|eclipse)/i.test(hay)) {
    archetype = "solar";
    environment = "space";
    primaryColor = "#F59E0B";
    secondaryAccent = "#38BDF8";
  } else if (/(dna|gene|helix|chromosome|rna|genetics|heredity|cell|mitochondria|biology)/i.test(hay)) {
    archetype = "dna";
    environment = "lab";
    primaryColor = "#0891B2";
    secondaryAccent = "#E11D48";
  } else if (/(heart|blood|circulat|artery|vein|organ|anatomy|human body|lung|brain|digest)/i.test(hay)) {
    archetype = "heart";
    environment = "lab";
    primaryColor = "#B91C1C";
    secondaryAccent = "#2563EB";
  } else if (/(photosynthesis|plant|leaf|tree|flower|forest|botany|chlorophyll|ecosystem|root|nature)/i.test(hay)) {
    archetype = "plant";
    environment = "outdoor";
    primaryColor = "#15803D";
    secondaryAccent = "#F59E0B";
  } else if (/(water cycle|rain|cloud|evaporat|condens|river|ocean|mountain|weather|climate|hydro)/i.test(hay)) {
    archetype = "watercycle";
    environment = "outdoor";
    primaryColor = "#0284C7";
    secondaryAccent = "#F59E0B";
  } else if (/(volcano|magma|lava|earthquake|tectonic|crust|mantle|geology|rock)/i.test(hay)) {
    archetype = "volcano";
    environment = "sunset";
    primaryColor = "#EA580C";
    secondaryAccent = "#FACC15";
  } else if (/(rocket|spacecraft|launch|satellite|newton|gravity|thrust|airplane|flight|aerospace|engine)/i.test(hay)) {
    archetype = "rocket";
    environment = "studio";
    primaryColor = "#E2E8F0";
    secondaryAccent = "#EA580C";
  } else if (/(circuit|electric|ohm|voltage|chip|cpu|computer|robot|ai|machine|code|microchip|battery|electronics)/i.test(hay)) {
    archetype = "circuit";
    environment = "lab";
    primaryColor = "#047857";
    secondaryAccent = "#F59E0B";
  } else if (/(atom|electron|proton|neutron|molecule|chemistry|periodic|nuclear|quantum|bond|h2o)/i.test(hay)) {
    archetype = "atom";
    environment = "lab";
    primaryColor = "#4F46E5";
    secondaryAccent = "#0284C7";
  } else if (/(earth|globe|world|continent|geography|map|history|civilization|india|latitude|longitude)/i.test(hay)) {
    archetype = "earth";
    environment = "studio";
    primaryColor = "#1D4ED8";
    secondaryAccent = "#15803D";
  } else if (/(wave|sound|light|prism|optics|spectrum|rainbow|frequency|music|electromagnetic|math|sine|geometry)/i.test(hay)) {
    archetype = "wave";
    environment = "lab";
    primaryColor = "#0284C7";
    secondaryAccent = "#7C3AED";
  }

  return {
    archetype,
    environment,
    primaryColor,
    accentColor: secondaryAccent,
    title: title || "3D Real Visual",
    subtitle: subject || "Physical 3D Study Model",
  };
}

// ============================================================================
// Deterministic 2D Value Noise + fBm for Realistic Procedural PBR Textures
// ============================================================================

function hash2D(x: number, y: number, seed: number): number {
  let n = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041);
  n = (n ^ (n >>> 13)) * 1274126177;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

function valueNoise2D(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);

  const a = hash2D(xi, yi, seed);
  const b = hash2D(xi + 1, yi, seed);
  const c = hash2D(xi, yi + 1, seed);
  const d = hash2D(xi + 1, yi + 1, seed);

  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm2D(x: number, y: number, seed: number, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise2D(x * freq, y * freq, seed + i * 31);
    norm += amp;
    amp *= 0.5;
    freq *= 2.02;
  }
  return sum / norm;
}

// ============================================================================
// Procedural PBR Texture Synthesizers (Albedo + Bump + Roughness, Zero 404s)
// ============================================================================

function makeCanvasTexture(
  width: number,
  height: number,
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
  maxAnisotropy = 4,
  isColor = true
): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (ctx) draw(ctx, width, height);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = Math.min(8, Math.max(1, maxAnisotropy));
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

interface PbrTexturePair {
  map: THREE.CanvasTexture;
  bumpMap: THREE.CanvasTexture;
  roughnessMap?: THREE.CanvasTexture;
}

/** Realistic warm physical museum oak tabletop PBR (albedo + bump + roughness) */
function createOakTablePbr(aniso: number): PbrTexturePair {
  const size = 256;
  const mapCanvas = document.createElement("canvas");
  const bumpCanvas = document.createElement("canvas");
  const roughCanvas = document.createElement("canvas");
  mapCanvas.width = bumpCanvas.width = roughCanvas.width = size;
  mapCanvas.height = bumpCanvas.height = roughCanvas.height = size;

  const mCtx = mapCanvas.getContext("2d")!;
  const bCtx = bumpCanvas.getContext("2d")!;
  const rCtx = roughCanvas.getContext("2d")!;

  const mImg = mCtx.createImageData(size, size);
  const bImg = bCtx.createImageData(size, size);
  const rImg = rCtx.createImageData(size, size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const nx = x / size;
      const ny = y / size;
      const warp = fbm2D(nx * 3.5, ny * 18, 17, 3) * 0.42;
      const ring = Math.sin((ny * 14 + warp * 8) * Math.PI) * 0.5 + 0.5;
      const fine = fbm2D(nx * 44, ny * 6, 41, 3);
      const grain = ring * 0.65 + fine * 0.35;

      // Subtle wood plank seam every 64px
      const plankEdge = (y % 64) < 2 ? 0.72 : 1.0;

      const r = Math.round((138 + grain * 52) * plankEdge);
      const g = Math.round((102 + grain * 42) * plankEdge);
      const b = Math.round((70 + grain * 30) * plankEdge);
      mImg.data[idx] = r;
      mImg.data[idx + 1] = g;
      mImg.data[idx + 2] = b;
      mImg.data[idx + 3] = 255;

      const bv = Math.round((95 + grain * 125) * plankEdge);
      bImg.data[idx] = bImg.data[idx + 1] = bImg.data[idx + 2] = bv;
      bImg.data[idx + 3] = 255;

      const rv = Math.round(135 + (1 - grain) * 70);
      rImg.data[idx] = rImg.data[idx + 1] = rImg.data[idx + 2] = rv;
      rImg.data[idx + 3] = 255;
    }
  }
  mCtx.putImageData(mImg, 0, 0);
  bCtx.putImageData(bImg, 0, 0);
  rCtx.putImageData(rImg, 0, 0);

  const prep = (c: HTMLCanvasElement, isColor: boolean) => {
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(4, 4);
    t.anisotropy = Math.min(8, Math.max(1, aniso));
    t.needsUpdate = true;
    return t;
  };
  return {
    map: prep(mapCanvas, true),
    bumpMap: prep(bumpCanvas, false),
    roughnessMap: prep(roughCanvas, false),
  };
}

/** Honed slate lab workbench PBR */
function createSlateLabPbr(aniso: number): PbrTexturePair {
  const size = 256;
  const mapCanvas = document.createElement("canvas");
  const bumpCanvas = document.createElement("canvas");
  mapCanvas.width = bumpCanvas.width = size;
  mapCanvas.height = bumpCanvas.height = size;
  const mCtx = mapCanvas.getContext("2d")!;
  const bCtx = bumpCanvas.getContext("2d")!;
  const mImg = mCtx.createImageData(size, size);
  const bImg = bCtx.createImageData(size, size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const n = fbm2D((x / size) * 8, (y / size) * 8, 93, 4);
      const speck = hash2D(x, y, 101) > 0.96 ? 18 : 0;
      mImg.data[idx] = Math.round(44 + n * 24 + speck);
      mImg.data[idx + 1] = Math.round(52 + n * 26 + speck);
      mImg.data[idx + 2] = Math.round(64 + n * 28 + speck);
      mImg.data[idx + 3] = 255;

      const bv = Math.round(105 + n * 110);
      bImg.data[idx] = bImg.data[idx + 1] = bImg.data[idx + 2] = bv;
      bImg.data[idx + 3] = 255;
    }
  }
  mCtx.putImageData(mImg, 0, 0);
  bCtx.putImageData(bImg, 0, 0);

  const prep = (c: HTMLCanvasElement, isColor: boolean) => {
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(3, 3);
    t.anisotropy = Math.min(8, Math.max(1, aniso));
    t.needsUpdate = true;
    return t;
  };
  return { map: prep(mapCanvas, true), bumpMap: prep(bumpCanvas, false) };
}

/** Realistic dark weathered basalt & stratified alpine rock PBR */
function createRockPbr(aniso: number, seed = 211, baseTint: [number, number, number] = [92, 86, 80]): PbrTexturePair {
  const size = 256;
  const mapCanvas = document.createElement("canvas");
  const bumpCanvas = document.createElement("canvas");
  mapCanvas.width = bumpCanvas.width = size;
  mapCanvas.height = bumpCanvas.height = size;
  const mCtx = mapCanvas.getContext("2d")!;
  const bCtx = bumpCanvas.getContext("2d")!;
  const mImg = mCtx.createImageData(size, size);
  const bImg = bCtx.createImageData(size, size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const nx = x / size;
      const ny = y / size;
      const strata = Math.sin((ny * 10 + fbm2D(nx * 5, ny * 5, seed, 3) * 1.8) * Math.PI) * 0.5 + 0.5;
      const crag = fbm2D(nx * 14, ny * 14, seed + 19, 4);
      const v = 0.58 + crag * 0.55 + strata * 0.22;

      mImg.data[idx] = Math.min(255, Math.round(baseTint[0] * v));
      mImg.data[idx + 1] = Math.min(255, Math.round(baseTint[1] * v));
      mImg.data[idx + 2] = Math.min(255, Math.round(baseTint[2] * v));
      mImg.data[idx + 3] = 255;

      const bv = Math.min(255, Math.round((crag * 0.72 + strata * 0.28) * 255));
      bImg.data[idx] = bImg.data[idx + 1] = bImg.data[idx + 2] = bv;
      bImg.data[idx + 3] = 255;
    }
  }
  mCtx.putImageData(mImg, 0, 0);
  bCtx.putImageData(bImg, 0, 0);

  const prep = (c: HTMLCanvasElement, isColor: boolean) => {
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(2, 2);
    t.anisotropy = Math.min(8, Math.max(1, aniso));
    t.needsUpdate = true;
    return t;
  };
  return { map: prep(mapCanvas, true), bumpMap: prep(bumpCanvas, false) };
}

/** Organic layered loam soil cross-section PBR */
function createLoamSoilPbr(aniso: number): PbrTexturePair {
  const size = 256;
  const mapCanvas = document.createElement("canvas");
  const bumpCanvas = document.createElement("canvas");
  mapCanvas.width = bumpCanvas.width = size;
  mapCanvas.height = bumpCanvas.height = size;
  const mCtx = mapCanvas.getContext("2d")!;
  const bCtx = bumpCanvas.getContext("2d")!;
  const mImg = mCtx.createImageData(size, size);
  const bImg = bCtx.createImageData(size, size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const nx = x / size;
      const ny = y / size;
      const clod = fbm2D(nx * 18, ny * 18, 307, 4);
      const pebble = hash2D(Math.floor(x / 3), Math.floor(y / 3), 313) > 0.94 ? 38 : 0;
      // Topsoil darker near top, warm clay subsoil lower
      const depthMix = ny;
      const baseR = 72 + depthMix * 44;
      const baseG = 48 + depthMix * 26;
      const baseB = 30 + depthMix * 14;

      mImg.data[idx] = Math.min(255, Math.round(baseR * (0.7 + clod * 0.65) + pebble));
      mImg.data[idx + 1] = Math.min(255, Math.round(baseG * (0.7 + clod * 0.65) + pebble * 0.9));
      mImg.data[idx + 2] = Math.min(255, Math.round(baseB * (0.7 + clod * 0.65) + pebble * 0.8));
      mImg.data[idx + 3] = 255;

      const bv = Math.min(255, Math.round(clod * 210 + pebble * 1.2));
      bImg.data[idx] = bImg.data[idx + 1] = bImg.data[idx + 2] = bv;
      bImg.data[idx + 3] = 255;
    }
  }
  mCtx.putImageData(mImg, 0, 0);
  bCtx.putImageData(bImg, 0, 0);

  const prep = (c: HTMLCanvasElement, isColor: boolean) => {
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = Math.min(8, Math.max(1, aniso));
    t.needsUpdate = true;
    return t;
  };
  return { map: prep(mapCanvas, true), bumpMap: prep(bumpCanvas, false) };
}

/** Realistic anatomical striated cardiac muscle tissue PBR */
function createCardiacTissuePbr(aniso: number): PbrTexturePair {
  const size = 256;
  const mapCanvas = document.createElement("canvas");
  const bumpCanvas = document.createElement("canvas");
  mapCanvas.width = bumpCanvas.width = size;
  mapCanvas.height = bumpCanvas.height = size;
  const mCtx = mapCanvas.getContext("2d")!;
  const bCtx = bumpCanvas.getContext("2d")!;
  const mImg = mCtx.createImageData(size, size);
  const bImg = bCtx.createImageData(size, size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const nx = x / size;
      const ny = y / size;
      // Helical striated muscle fibers
      const fiberWave = Math.sin((nx * 18 + ny * 10 + fbm2D(nx * 6, ny * 6, 401, 3) * 2.2) * Math.PI) * 0.5 + 0.5;
      const tissue = fbm2D(nx * 12, ny * 12, 419, 3);
      const fatStreak = tissue > 0.76 ? (tissue - 0.76) * 2.4 : 0;

      const r = Math.min(255, Math.round(145 + fiberWave * 44 + fatStreak * 70));
      const g = Math.min(255, Math.round(34 + fiberWave * 18 + fatStreak * 110));
      const b = Math.min(255, Math.round(38 + fiberWave * 16 + fatStreak * 65));

      mImg.data[idx] = r;
      mImg.data[idx + 1] = g;
      mImg.data[idx + 2] = b;
      mImg.data[idx + 3] = 255;

      const bv = Math.round(90 + fiberWave * 115 + tissue * 45);
      bImg.data[idx] = bImg.data[idx + 1] = bImg.data[idx + 2] = Math.min(255, bv);
      bImg.data[idx + 3] = 255;
    }
  }
  mCtx.putImageData(mImg, 0, 0);
  bCtx.putImageData(bImg, 0, 0);

  const prep = (c: HTMLCanvasElement, isColor: boolean) => {
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(2, 2);
    t.anisotropy = Math.min(8, Math.max(1, aniso));
    t.needsUpdate = true;
    return t;
  };
  return { map: prep(mapCanvas, true), bumpMap: prep(bumpCanvas, false) };
}

/** Realistic animated water surface normal/bump ripples */
function createWaterRippleBump(aniso: number): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const nx = x / size;
      const ny = y / size;
      const w1 = Math.sin((nx * 10 + fbm2D(nx * 6, ny * 6, 503, 3) * 1.4) * Math.PI * 2) * 0.5 + 0.5;
      const w2 = Math.cos((ny * 12 - nx * 4 + fbm2D(nx * 9, ny * 9, 521, 3)) * Math.PI * 2) * 0.5 + 0.5;
      const v = Math.round((w1 * 0.55 + w2 * 0.45) * 255);
      img.data[idx] = img.data[idx + 1] = img.data[idx + 2] = v;
      img.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 3);
  tex.anisotropy = Math.min(8, Math.max(1, aniso));
  tex.needsUpdate = true;
  return tex;
}

/** Realistic Earth PBR set: albedo + elevation bump + ocean/land roughness contrast */
function createEarthPbrSet(aniso: number): PbrTexturePair {
  const w = 512;
  const h = 256;
  const mapCanvas = document.createElement("canvas");
  const bumpCanvas = document.createElement("canvas");
  const roughCanvas = document.createElement("canvas");
  mapCanvas.width = bumpCanvas.width = roughCanvas.width = w;
  mapCanvas.height = bumpCanvas.height = roughCanvas.height = h;

  const mCtx = mapCanvas.getContext("2d")!;
  const bCtx = bumpCanvas.getContext("2d")!;
  const rCtx = roughCanvas.getContext("2d")!;

  // 1. Ocean bathymetry gradient
  const oceanGrad = mCtx.createLinearGradient(0, 0, 0, h);
  oceanGrad.addColorStop(0, "#0A3066");
  oceanGrad.addColorStop(0.5, "#0B4F8C");
  oceanGrad.addColorStop(1, "#082959");
  mCtx.fillStyle = oceanGrad;
  mCtx.fillRect(0, 0, w, h);

  // Glossy ocean roughness (dark value ~ 52 -> roughness 0.20) & flat sea bump (40)
  bCtx.fillStyle = "#282828";
  bCtx.fillRect(0, 0, w, h);
  rCtx.fillStyle = "#383838";
  rCtx.fillRect(0, 0, w, h);

  // Subtle shallow continental shelves
  const continents: Array<Array<[number, number]>> = [
    // North America
    [[0.12, 0.17], [0.27, 0.16], [0.30, 0.28], [0.24, 0.41], [0.21, 0.45], [0.16, 0.36], [0.11, 0.26]],
    // South America
    [[0.23, 0.48], [0.31, 0.54], [0.34, 0.65], [0.29, 0.83], [0.25, 0.78], [0.22, 0.61]],
    // Europe
    [[0.46, 0.17], [0.57, 0.16], [0.59, 0.28], [0.51, 0.34], [0.45, 0.31]],
    // Africa
    [[0.45, 0.36], [0.56, 0.36], [0.61, 0.50], [0.56, 0.75], [0.50, 0.77], [0.46, 0.56], [0.43, 0.44]],
    // Asia + India
    [[0.58, 0.15], [0.80, 0.17], [0.87, 0.30], [0.80, 0.46], [0.73, 0.44], [0.69, 0.55], [0.64, 0.46], [0.59, 0.36]],
    // Australia
    [[0.77, 0.62], [0.87, 0.61], [0.89, 0.73], [0.80, 0.76], [0.75, 0.69]],
  ];

  // Draw coastlines, land biomes, elevated bump & matte land roughness
  for (const poly of continents) {
    const drawPoly = (ctx: CanvasRenderingContext2D) => {
      ctx.beginPath();
      poly.forEach(([px, py], idx) => {
        if (idx === 0) ctx.moveTo(px * w, py * h);
        else ctx.lineTo(px * w, py * h);
      });
      ctx.closePath();
    };

    // Shallow turquoise coast halo on albedo
    mCtx.save();
    drawPoly(mCtx);
    mCtx.strokeStyle = "rgba(34, 211, 238, 0.32)";
    mCtx.lineWidth = 8;
    mCtx.stroke();
    mCtx.restore();

    // Land biomes
    drawPoly(mCtx);
    const landGrad = mCtx.createLinearGradient(0, h * 0.15, 0, h * 0.85);
    landGrad.addColorStop(0, "#4B7A4B");
    landGrad.addColorStop(0.32, "#356F3F");
    landGrad.addColorStop(0.50, "#B89B62"); // desert belts
    landGrad.addColorStop(0.68, "#2E7444");
    landGrad.addColorStop(1, "#4E7F52");
    mCtx.fillStyle = landGrad;
    mCtx.fill();

    // Elevated bump for continents
    drawPoly(bCtx);
    bCtx.fillStyle = "#B8B8B8";
    bCtx.fill();
    bCtx.strokeStyle = "#808080";
    bCtx.lineWidth = 3;
    bCtx.stroke();

    // Matte roughness for land (value ~ 218 -> roughness ~0.85)
    drawPoly(rCtx);
    rCtx.fillStyle = "#DCDCDC";
    rCtx.fill();
  }

  // Add organic fBm terrain relief & mountain chains onto land pixels
  const mImg = mCtx.getImageData(0, 0, w, h);
  const bImg = bCtx.getImageData(0, 0, w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      const isLand = bImg.data[idx] > 90;
      const n = fbm2D((x / w) * 18, (y / h) * 9, 617, 4);
      if (isLand) {
        const ridge = Math.max(0, n - 0.52) * 2.1;
        mImg.data[idx] = Math.min(255, Math.round(mImg.data[idx] * (0.82 + n * 0.38) + ridge * 48));
        mImg.data[idx + 1] = Math.min(255, Math.round(mImg.data[idx + 1] * (0.82 + n * 0.38) + ridge * 44));
        mImg.data[idx + 2] = Math.min(255, Math.round(mImg.data[idx + 2] * (0.82 + n * 0.38) + ridge * 38));
        bImg.data[idx] = bImg.data[idx + 1] = bImg.data[idx + 2] = Math.min(
          255,
          Math.round(135 + n * 115)
        );
      } else {
        // Gentle ocean depth mottling
        mImg.data[idx + 1] = Math.min(255, Math.round(mImg.data[idx + 1] * (0.9 + n * 0.22)));
        mImg.data[idx + 2] = Math.min(255, Math.round(mImg.data[idx + 2] * (0.9 + n * 0.22)));
      }
    }
  }
  mCtx.putImageData(mImg, 0, 0);
  bCtx.putImageData(bImg, 0, 0);

  // Polar ice caps
  mCtx.fillStyle = "rgba(241, 245, 249, 0.94)";
  mCtx.fillRect(0, 0, w, 14);
  mCtx.fillRect(0, h - 13, w, 13);
  rCtx.fillStyle = "#B0B0B0";
  rCtx.fillRect(0, 0, w, 14);
  rCtx.fillRect(0, h - 13, w, 13);

  const prep = (c: HTMLCanvasElement, isColor: boolean) => {
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = Math.min(8, Math.max(1, aniso));
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.needsUpdate = true;
    return t;
  };
  return {
    map: prep(mapCanvas, true),
    bumpMap: prep(bumpCanvas, false),
    roughnessMap: prep(roughCanvas, false),
  };
}

function createCloudsTexture(aniso: number): THREE.CanvasTexture {
  return makeCanvasTexture(
    512,
    256,
    (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      for (let i = 0; i < 95; i++) {
        const x = (i * 137) % w;
        const y = 20 + ((i * 71) % (h - 40));
        const rx = 20 + (i % 46);
        const ry = 6 + (i % 14);
        const grad = ctx.createRadialGradient(x, y, 1, x, y, rx);
        grad.addColorStop(0, "rgba(255,255,255,0.62)");
        grad.addColorStop(0.6, "rgba(248,250,252,0.28)");
        grad.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.ellipse(x, y, rx, ry, (i % 5) * 0.14, 0, Math.PI * 2);
        ctx.fill();
      }
    },
    aniso,
    true
  );
}

function createBandedPlanetTexture(
  baseHex: string,
  bandHex: string,
  highlightHex: string,
  aniso: number,
  withStormSpot = false
): THREE.CanvasTexture {
  return makeCanvasTexture(
    512,
    256,
    (ctx, w, h) => {
      ctx.fillStyle = baseHex;
      ctx.fillRect(0, 0, w, h);
      for (let y = 0; y < h; y += 3) {
        const wave = Math.sin(y * 0.11) * 0.5 + 0.5;
        const swirl = Math.cos(y * 0.27) * 0.5 + 0.5;
        ctx.fillStyle = wave > 0.52 ? bandHex : highlightHex;
        ctx.globalAlpha = 0.22 + swirl * 0.32;
        ctx.fillRect(0, y, w, 3 + (y % 4));
      }
      ctx.globalAlpha = 1;
      if (withStormSpot) {
        const g = ctx.createRadialGradient(w * 0.62, h * 0.62, 3, w * 0.62, h * 0.62, 26);
        g.addColorStop(0, "rgba(185, 28, 28, 0.85)");
        g.addColorStop(0.6, "rgba(234, 88, 12, 0.55)");
        g.addColorStop(1, "rgba(234, 88, 12, 0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(w * 0.62, h * 0.62, 26, 15, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    },
    aniso,
    true
  );
}

function createSaturnRingTexture(aniso: number): THREE.CanvasTexture {
  return makeCanvasTexture(
    256,
    32,
    (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      for (let x = 0; x < w; x++) {
        const f = x / w;
        // Cassini division gap around 0.62..0.68
        const inCassini = f > 0.61 && f < 0.68;
        const alpha = inCassini
          ? 0.08
          : Math.max(0, Math.sin(f * Math.PI) * (0.55 + Math.sin(f * 62) * 0.25));
        const warm = 205 + Math.round(Math.sin(f * 36) * 28);
        ctx.fillStyle = `rgba(${warm}, ${warm - 18}, ${warm - 52}, ${alpha.toFixed(2)})`;
        ctx.fillRect(x, 0, 1, h);
      }
    },
    aniso,
    true
  );
}

function createSunPlasmaTexture(aniso: number): THREE.CanvasTexture {
  return makeCanvasTexture(
    512,
    256,
    (ctx, w, h) => {
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, "#FEF08A");
      grad.addColorStop(0.5, "#F97316");
      grad.addColorStop(1, "#EA580C");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 140; i++) {
        const x = (i * 151) % w;
        const y = (i * 89) % h;
        const r = 7 + (i % 24);
        const rg = ctx.createRadialGradient(x, y, 1, x, y, r);
        rg.addColorStop(0, i % 2 === 0 ? "rgba(255,251,235,0.88)" : "rgba(185,28,28,0.52)");
        rg.addColorStop(1, "rgba(249,115,22,0)");
        ctx.fillStyle = rg;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    },
    aniso,
    true
  );
}

function createCircuitPcbTexture(aniso: number): THREE.CanvasTexture {
  return makeCanvasTexture(
    512,
    512,
    (ctx, w, h) => {
      ctx.fillStyle = "#064E3B";
      ctx.fillRect(0, 0, w, h);

      // Subtle fiberglass weave
      ctx.strokeStyle = "rgba(16, 185, 129, 0.14)";
      ctx.lineWidth = 1;
      for (let i = 0; i < w; i += 14) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i, h);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, i);
        ctx.lineTo(w, i);
        ctx.stroke();
      }

      // Copper & gold bus traces
      ctx.strokeStyle = "#D97706";
      ctx.lineWidth = 3;
      for (let i = 0; i < 18; i++) {
        const y = 28 + i * 26;
        ctx.beginPath();
        ctx.moveTo(18, y);
        ctx.lineTo(138 + (i % 4) * 28, y);
        ctx.lineTo(178 + (i % 4) * 28, y + (i % 2 === 0 ? 18 : -18));
        ctx.lineTo(w - 18, y + (i % 2 === 0 ? 18 : -18));
        ctx.stroke();

        // Solder vias
        ctx.fillStyle = "#FDE68A";
        ctx.beginPath();
        ctx.arc(138 + (i % 4) * 28, y, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#064E3B";
        ctx.beginPath();
        ctx.arc(138 + (i % 4) * 28, y, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
    },
    aniso,
    true
  );
}

function createLeafPbr(aniso: number): PbrTexturePair {
  const map = makeCanvasTexture(
    256,
    512,
    (ctx, w, h) => {
      const grad = ctx.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, "#14532D");
      grad.addColorStop(0.5, "#15803D");
      grad.addColorStop(1, "#22C55E");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      // Subtle chlorophyll mottling
      for (let i = 0; i < 40; i++) {
        const x = (i * 59) % w;
        const y = (i * 113) % h;
        ctx.fillStyle = "rgba(134, 239, 172, 0.08)";
        ctx.beginPath();
        ctx.arc(x, y, 16 + (i % 20), 0, Math.PI * 2);
        ctx.fill();
      }

      // Midrib & secondary veins
      ctx.strokeStyle = "rgba(187, 247, 208, 0.65)";
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(w / 2, 0);
      ctx.lineTo(w / 2, h);
      ctx.stroke();

      ctx.lineWidth = 2.4;
      for (let y = 32; y < h; y += 34) {
        ctx.beginPath();
        ctx.moveTo(w / 2, y);
        ctx.quadraticCurveTo(w * 0.25, y - 10, 14, y - 30);
        ctx.moveTo(w / 2, y);
        ctx.quadraticCurveTo(w * 0.75, y - 10, w - 14, y - 30);
        ctx.stroke();
      }
    },
    aniso,
    true
  );

  const bumpMap = makeCanvasTexture(
    256,
    512,
    (ctx, w, h) => {
      ctx.fillStyle = "#707070";
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = "#F0F0F0";
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(w / 2, 0);
      ctx.lineTo(w / 2, h);
      ctx.stroke();
      ctx.lineWidth = 2.5;
      for (let y = 32; y < h; y += 34) {
        ctx.beginPath();
        ctx.moveTo(w / 2, y);
        ctx.quadraticCurveTo(w * 0.25, y - 10, 14, y - 30);
        ctx.moveTo(w / 2, y);
        ctx.quadraticCurveTo(w * 0.75, y - 10, w - 14, y - 30);
        ctx.stroke();
      }
    },
    aniso,
    false
  );

  return { map, bumpMap };
}

function createBrushedMetalPbr(aniso: number): PbrTexturePair {
  const map = makeCanvasTexture(
    256,
    256,
    (ctx, w, h) => {
      ctx.fillStyle = "#CBD5E1";
      ctx.fillRect(0, 0, w, h);
      for (let y = 0; y < h; y += 2) {
        const v = 188 + ((y * 37) % 44);
        ctx.fillStyle = `rgb(${v},${v + 4},${v + 9})`;
        ctx.fillRect(0, y, w, 1.5);
      }
      // Aerospace hull panel seams & rivets
      ctx.strokeStyle = "rgba(51, 65, 85, 0.36)";
      ctx.lineWidth = 2;
      ctx.strokeRect(4, 4, w - 8, h - 8);
      ctx.beginPath();
      ctx.moveTo(0, h / 2);
      ctx.lineTo(w, h / 2);
      ctx.stroke();
    },
    aniso,
    true
  );

  const bumpMap = makeCanvasTexture(
    256,
    256,
    (ctx, w, h) => {
      ctx.fillStyle = "#B0B0B0";
      ctx.fillRect(0, 0, w, h);
      for (let y = 0; y < h; y += 2) {
        const v = 155 + ((y * 29) % 45);
        ctx.fillStyle = `rgb(${v},${v},${v})`;
        ctx.fillRect(0, y, w, 1.5);
      }
      ctx.strokeStyle = "#303030";
      ctx.lineWidth = 2;
      ctx.strokeRect(4, 4, w - 8, h - 8);
    },
    aniso,
    false
  );
  return { map, bumpMap };
}

function createContactShadowTexture(): THREE.CanvasTexture {
  return makeCanvasTexture(
    256,
    256,
    (ctx, w, h) => {
      const grad = ctx.createRadialGradient(
        w / 2,
        h / 2,
        8,
        w / 2,
        h / 2,
        w / 2
      );
      grad.addColorStop(0, "rgba(2, 6, 23, 0.56)");
      grad.addColorStop(0.55, "rgba(2, 6, 23, 0.22)");
      grad.addColorStop(1, "rgba(2, 6, 23, 0)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
    },
    1,
    true
  );
}

// ============================================================================
// Composite Physical 3D Model Builders (Realistic PBR + Calm Speed + Anchors)
// ============================================================================

interface Built3DModel {
  root: THREE.Group;
  update: (timeSec: number) => void;
  textures: THREE.Texture[];
  anchors: Study3DAnchor[];
}

function buildSolarSystem3D(aniso: number): Built3DModel {
  const root = new THREE.Group();
  const textures: THREE.Texture[] = [];

  const sunTex = createSunPlasmaTexture(aniso);
  const earthPbr = createEarthPbrSet(aniso);
  const marsTex = createBandedPlanetTexture("#9A3412", "#C2410C", "#EA580C", aniso);
  const jupTex = createBandedPlanetTexture("#D97706", "#92400E", "#FEF3C7", aniso, true);
  const satTex = createBandedPlanetTexture("#D4A359", "#A67C37", "#FEF3C7", aniso);
  const satRingTex = createSaturnRingTexture(aniso);
  const rockPbr = createRockPbr(aniso, 89, [145, 148, 155]);
  textures.push(
    sunTex,
    earthPbr.map,
    earthPbr.bumpMap,
    earthPbr.roughnessMap!,
    marsTex,
    jupTex,
    satTex,
    satRingTex,
    rockPbr.map,
    rockPbr.bumpMap
  );

  // Glowing Sun + soft corona
  const sun = new THREE.Mesh(
    new THREE.SphereGeometry(0.95, 44, 44),
    new THREE.MeshStandardMaterial({
      map: sunTex,
      emissive: new THREE.Color("#F97316"),
      emissiveIntensity: 1.35,
      roughness: 0.35,
      metalness: 0.05,
    })
  );
  sun.position.y = 1.6;
  root.add(sun);

  const corona = new THREE.Mesh(
    new THREE.SphereGeometry(1.14, 32, 32),
    new THREE.MeshBasicMaterial({
      color: "#FDE047",
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
    })
  );
  corona.position.y = 1.6;
  root.add(corona);

  const sunLight = new THREE.PointLight("#FEF3C7", 15, 22, 1.4);
  sunLight.position.set(0, 1.6, 0);
  root.add(sunLight);

  interface OrbitEntry {
    pivot: THREE.Group;
    mesh: THREE.Object3D;
    speed: number;
    spin: number;
  }
  const orbits: OrbitEntry[] = [];

  const planetSpecs = [
    { name: "Mercury", r: 1.65, size: 0.16, speed: 0.45, color: "#94A3B8", map: rockPbr.map, bump: rockPbr.bumpMap, roughMap: undefined, ring: false, moon: false },
    { name: "Earth", r: 2.38, size: 0.30, speed: 0.30, color: "#FFFFFF", map: earthPbr.map, bump: earthPbr.bumpMap, roughMap: earthPbr.roughnessMap, ring: false, moon: true },
    { name: "Mars", r: 3.10, size: 0.23, speed: 0.23, color: "#FFFFFF", map: marsTex, bump: rockPbr.bumpMap, roughMap: undefined, ring: false, moon: false },
    { name: "Jupiter", r: 3.95, size: 0.46, speed: 0.16, color: "#FFFFFF", map: jupTex, bump: undefined, roughMap: undefined, ring: false, moon: false },
    { name: "Saturn", r: 4.90, size: 0.37, speed: 0.11, color: "#FFFFFF", map: satTex, bump: undefined, roughMap: undefined, ring: true, moon: false },
  ];

  const earthGroupRef = { obj: null as THREE.Object3D | null };
  const saturnGroupRef = { obj: null as THREE.Object3D | null };

  planetSpecs.forEach((p, idx) => {
    const track = new THREE.Mesh(
      new THREE.TorusGeometry(p.r, 0.01, 10, 96),
      new THREE.MeshStandardMaterial({
        color: "#475569",
        emissive: "#38BDF8",
        emissiveIntensity: 0.22,
        roughness: 0.65,
        metalness: 0.4,
      })
    );
    track.rotation.x = Math.PI / 2;
    track.position.y = 1.6;
    root.add(track);

    const pivot = new THREE.Group();
    pivot.position.y = 1.6;
    pivot.rotation.y = idx * 1.15 + 0.3;
    root.add(pivot);

    const planetGroup = new THREE.Group();
    planetGroup.position.x = p.r;
    pivot.add(planetGroup);

    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(p.size, 36, 36),
      new THREE.MeshStandardMaterial({
        color: p.color,
        map: p.map,
        bumpMap: p.bump,
        bumpScale: p.bump ? 0.025 : 0,
        roughnessMap: p.roughMap,
        roughness: p.roughMap ? 0.95 : 0.72,
        metalness: 0.06,
      })
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    planetGroup.add(mesh);

    if (p.name === "Earth") earthGroupRef.obj = planetGroup;
    if (p.name === "Saturn") saturnGroupRef.obj = planetGroup;

    if (p.ring) {
      const ringGeo = new THREE.RingGeometry(p.size * 1.38, p.size * 2.45, 64);
      // Remap UVs radially so Saturn's Cassini division band texture wraps cleanly around ring
      const pos = ringGeo.attributes.position as THREE.BufferAttribute;
      const uv = ringGeo.attributes.uv as THREE.BufferAttribute;
      const innerR = p.size * 1.38;
      const outerR = p.size * 2.45;
      for (let i = 0; i < pos.count; i++) {
        const vx = pos.getX(i);
        const vy = pos.getY(i);
        const radius = Math.hypot(vx, vy);
        uv.setXY(i, (radius - innerR) / (outerR - innerR), 0.5);
      }
      const ring = new THREE.Mesh(
        ringGeo,
        new THREE.MeshStandardMaterial({
          map: satRingTex,
          roughness: 0.55,
          metalness: 0.12,
          side: THREE.DoubleSide,
          transparent: true,
        })
      );
      ring.rotation.x = Math.PI * 0.39;
      planetGroup.add(ring);
    }

    if (p.moon) {
      const moon = new THREE.Mesh(
        new THREE.SphereGeometry(0.08, 18, 18),
        new THREE.MeshStandardMaterial({
          map: rockPbr.map,
          bumpMap: rockPbr.bumpMap,
          bumpScale: 0.02,
          roughness: 0.9,
          metalness: 0.02,
        })
      );
      moon.position.set(0.52, 0.1, 0);
      planetGroup.add(moon);
    }

    orbits.push({ pivot, mesh: planetGroup, speed: p.speed, spin: 0.32 + idx * 0.05 });
  });

  // Crisp realistic starfield
  const starCount = 240;
  const starGeo = new THREE.SphereGeometry(0.028, 6, 6);
  const starMat = new THREE.MeshBasicMaterial({ color: "#F8FAFC" });
  const stars = new THREE.InstancedMesh(starGeo, starMat, starCount);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < starCount; i++) {
    const theta = (i * 2.39996) % (Math.PI * 2);
    const phi = Math.acos(1 - (2 * (i + 0.5)) / starCount);
    const dist = 9.0 + (i % 7) * 0.75;
    dummy.position.set(
      dist * Math.sin(phi) * Math.cos(theta),
      1.6 + dist * Math.cos(phi) * 0.65,
      dist * Math.sin(phi) * Math.sin(theta)
    );
    dummy.scale.setScalar(0.55 + (i % 5) * 0.26);
    dummy.updateMatrix();
    stars.setMatrixAt(i, dummy.matrix);
  }
  stars.computeBoundingSphere();
  root.add(stars);

  const anchors: Study3DAnchor[] = [
    { label: "The Sun (Star)", position: [0, 2.75, 0], focusScenes: [0, 1] },
    { label: "Earth & Moon", position: [2.2, 2.1, 0.8], focusScenes: [1, 2, 3] },
    { label: "Saturn's Rings", position: [-3.4, 2.2, -3.2], focusScenes: [2, 4] },
  ];

  return {
    root,
    textures,
    anchors,
    update: (t) => {
      sun.rotation.y = t * 0.10;
      corona.scale.setScalar(1 + Math.sin(t * 1.1) * 0.025);
      for (const o of orbits) {
        o.pivot.rotation.y = t * o.speed * 0.36;
        o.mesh.rotation.y = t * o.spin;
      }
      // Keep Earth and Saturn anchor positions tracked accurately in world space
      if (earthGroupRef.obj) {
        earthGroupRef.obj.getWorldPosition(_projVec);
        anchors[1].position = [_projVec.x, _projVec.y + 0.42, _projVec.z];
      }
      if (saturnGroupRef.obj) {
        saturnGroupRef.obj.getWorldPosition(_projVec);
        anchors[2].position = [_projVec.x, _projVec.y + 0.52, _projVec.z];
      }
    },
  };
}

function buildAtom3D(primaryColor: string, accentColor: string, aniso: number): Built3DModel {
  const root = new THREE.Group();
  const metalPbr = createBrushedMetalPbr(aniso);

  // Precision museum brass & anodized lab apparatus stand
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(1.38, 1.58, 0.22, 48),
    new THREE.MeshStandardMaterial({
      color: "#1E293B",
      bumpMap: metalPbr.bumpMap,
      bumpScale: 0.01,
      roughness: 0.38,
      metalness: 0.78,
    })
  );
  base.position.y = 0.11;
  base.receiveShadow = true;
  root.add(base);

  const brassCollar = new THREE.Mesh(
    new THREE.TorusGeometry(1.4, 0.032, 16, 64),
    new THREE.MeshStandardMaterial({
      color: "#D97706",
      roughness: 0.24,
      metalness: 0.92,
    })
  );
  brassCollar.rotation.x = Math.PI / 2;
  brassCollar.position.y = 0.22;
  root.add(brassCollar);

  const supportRod = new THREE.Mesh(
    new THREE.CylinderGeometry(0.055, 0.075, 1.5, 20),
    new THREE.MeshStandardMaterial({ color: "#CBD5E1", roughness: 0.22, metalness: 0.92 })
  );
  supportRod.position.y = 0.96;
  supportRod.castShadow = true;
  root.add(supportRod);

  const nucleus = new THREE.Group();
  nucleus.position.y = 2.0;
  root.add(nucleus);

  const protonMat = new THREE.MeshPhysicalMaterial({
    color: "#DC2626",
    bumpMap: metalPbr.bumpMap,
    bumpScale: 0.012,
    roughness: 0.28,
    metalness: 0.18,
    clearcoat: 0.65,
  });
  const neutronMat = new THREE.MeshPhysicalMaterial({
    color: primaryColor,
    bumpMap: metalPbr.bumpMap,
    bumpScale: 0.012,
    roughness: 0.38,
    metalness: 0.42,
    clearcoat: 0.4,
  });

  const offsets: Array<[number, number, number]> = [
    [0, 0, 0],
    [0.32, 0.18, 0.15],
    [-0.3, 0.2, -0.14],
    [0.14, -0.28, 0.22],
    [-0.22, -0.22, 0.24],
    [0.24, -0.12, -0.28],
    [-0.18, 0.26, 0.25],
    [0.04, 0.34, -0.18],
    [-0.28, -0.08, -0.22],
    [0.28, 0.14, -0.18],
  ];
  offsets.forEach((pos, idx) => {
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(0.26, 26, 26),
      idx % 2 === 0 ? protonMat : neutronMat
    );
    sphere.position.set(pos[0], pos[1], pos[2]);
    sphere.castShadow = true;
    nucleus.add(sphere);
  });

  const electronPivots: Array<{ pivot: THREE.Group; speed: number }> = [];
  const tilts: Array<[number, number, number]> = [
    [Math.PI / 3, 0.2, 0],
    [-Math.PI / 3, 0.4, Math.PI / 3],
    [Math.PI / 2.2, -0.5, -Math.PI / 3],
  ];

  tilts.forEach((rot, idx) => {
    const shell = new THREE.Group();
    shell.position.y = 2.0;
    shell.rotation.set(rot[0], rot[1], rot[2]);
    root.add(shell);

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(1.72 + idx * 0.2, 0.022, 16, 96),
      new THREE.MeshStandardMaterial({
        color: "#94A3B8",
        metalness: 0.88,
        roughness: 0.22,
      })
    );
    shell.add(ring);

    const ePivot = new THREE.Group();
    shell.add(ePivot);
    for (let j = 0; j < 2; j++) {
      const electron = new THREE.Mesh(
        new THREE.SphereGeometry(0.135, 22, 22),
        new THREE.MeshPhysicalMaterial({
          color: "#E0F2FE",
          emissive: accentColor,
          emissiveIntensity: 0.9,
          roughness: 0.14,
          metalness: 0.2,
          clearcoat: 0.9,
        })
      );
      const angle = j * Math.PI;
      const rad = 1.72 + idx * 0.2;
      electron.position.set(Math.cos(angle) * rad, Math.sin(angle) * rad, 0);
      ePivot.add(electron);
    }
    electronPivots.push({ pivot: ePivot, speed: 0.48 + idx * 0.14 });
  });

  return {
    root,
    textures: [metalPbr.map, metalPbr.bumpMap],
    anchors: [
      { label: "Nucleus (Protons & Neutrons)", position: [0, 2.45, 0], focusScenes: [0, 1] },
      { label: "Electron Orbit Shell", position: [1.55, 2.55, 0.3], focusScenes: [1, 2, 3] },
      { label: "Orbiting Electrons (-)", position: [-1.45, 1.65, 0.9], focusScenes: [2, 4] },
    ],
    update: (t) => {
      nucleus.rotation.y = t * 0.22;
      nucleus.rotation.x = Math.sin(t * 0.32) * 0.16;
      for (const ep of electronPivots) {
        ep.pivot.rotation.z = t * ep.speed;
      }
    },
  };
}

function buildDna3D(primaryColor: string, accentColor: string, aniso: number): Built3DModel {
  const root = new THREE.Group();
  const metalPbr = createBrushedMetalPbr(aniso);

  // Weighted brushed museum base
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(1.22, 1.42, 0.22, 48),
    new THREE.MeshStandardMaterial({
      color: "#1E293B",
      bumpMap: metalPbr.bumpMap,
      bumpScale: 0.01,
      roughness: 0.38,
      metalness: 0.72,
    })
  );
  base.position.y = 0.11;
  base.receiveShadow = true;
  root.add(base);

  const helixGroup = new THREE.Group();
  helixGroup.position.y = 0.26;
  root.add(helixGroup);

  const turns = 2.0;
  const height = 3.55;
  const radius = 0.84;
  const ptsA: THREE.Vector3[] = [];
  const ptsB: THREE.Vector3[] = [];

  for (let i = 0; i <= 64; i++) {
    const f = i / 64;
    const angle = f * Math.PI * 2 * turns;
    const y = f * height;
    ptsA.push(new THREE.Vector3(Math.cos(angle) * radius, y, Math.sin(angle) * radius));
    ptsB.push(new THREE.Vector3(Math.cos(angle + Math.PI) * radius, y, Math.sin(angle + Math.PI) * radius));
  }

  const strandMatA = new THREE.MeshPhysicalMaterial({
    color: primaryColor,
    roughness: 0.28,
    metalness: 0.22,
    clearcoat: 0.75,
  });
  const strandMatB = new THREE.MeshPhysicalMaterial({
    color: accentColor,
    roughness: 0.28,
    metalness: 0.22,
    clearcoat: 0.75,
  });

  const tubeA = new THREE.Mesh(
    new THREE.TubeGeometry(new THREE.CatmullRomCurve3(ptsA), 72, 0.08, 16, false),
    strandMatA
  );
  tubeA.castShadow = true;
  const tubeB = new THREE.Mesh(
    new THREE.TubeGeometry(new THREE.CatmullRomCurve3(ptsB), 72, 0.08, 16, false),
    strandMatB
  );
  tubeB.castShadow = true;
  helixGroup.add(tubeA, tubeB);

  const phosphateMat = new THREE.MeshPhysicalMaterial({
    color: "#E2E8F0",
    roughness: 0.25,
    metalness: 0.5,
    clearcoat: 0.6,
  });

  const pairColors: Array<[string, string]> = [
    ["#F59E0B", "#2563EB"], // A - T
    ["#10B981", "#E11D48"], // C - G
  ];

  for (let i = 1; i < 14; i++) {
    const f = i / 14;
    const angle = f * Math.PI * 2 * turns;
    const y = f * height;
    const [c1, c2] = pairColors[i % 2];

    const rungGroup = new THREE.Group();
    rungGroup.position.y = y;
    rungGroup.rotation.y = -angle;
    helixGroup.add(rungGroup);

    // Molecular phosphate-sugar nodes on each side
    const nodeL = new THREE.Mesh(new THREE.SphereGeometry(0.115, 16, 16), phosphateMat);
    nodeL.position.x = -radius;
    const nodeR = new THREE.Mesh(new THREE.SphereGeometry(0.115, 16, 16), phosphateMat);
    nodeR.position.x = radius;

    const halfL = new THREE.Mesh(
      new THREE.CylinderGeometry(0.052, 0.052, radius * 0.88, 14),
      new THREE.MeshPhysicalMaterial({ color: c1, roughness: 0.34, metalness: 0.1, clearcoat: 0.45 })
    );
    halfL.rotation.z = Math.PI / 2;
    halfL.position.x = -radius * 0.45;
    halfL.castShadow = true;

    const halfR = new THREE.Mesh(
      new THREE.CylinderGeometry(0.052, 0.052, radius * 0.88, 14),
      new THREE.MeshPhysicalMaterial({ color: c2, roughness: 0.34, metalness: 0.1, clearcoat: 0.45 })
    );
    halfR.rotation.z = Math.PI / 2;
    halfR.position.x = radius * 0.45;
    halfR.castShadow = true;

    const bondRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.075, 0.02, 10, 20),
      new THREE.MeshStandardMaterial({ color: "#F8FAFC", metalness: 0.88, roughness: 0.18 })
    );
    bondRing.rotation.y = Math.PI / 2;

    rungGroup.add(nodeL, nodeR, halfL, halfR, bondRing);
  }

  return {
    root,
    textures: [metalPbr.map, metalPbr.bumpMap],
    anchors: [
      { label: "Sugar-Phosphate Backbone", position: [0.95, 2.85, 0.2], focusScenes: [0, 1] },
      { label: "Base Pairs (A-T / C-G)", position: [0, 2.05, 0.15], focusScenes: [1, 2, 3] },
      { label: "Hydrogen Bond Center", position: [0, 1.25, 0], focusScenes: [2, 4] },
    ],
    update: (t) => {
      helixGroup.rotation.y = t * 0.18;
      helixGroup.position.y = 0.26 + Math.sin(t * 0.65) * 0.03;
    },
  };
}

function buildHeart3D(aniso: number): Built3DModel {
  const root = new THREE.Group();
  const tissuePbr = createCardiacTissuePbr(aniso);
  const metalPbr = createBrushedMetalPbr(aniso);

  // Museum anatomical stand (dark walnut base + chrome rod)
  const standBase = new THREE.Mesh(
    new THREE.CylinderGeometry(1.1, 1.28, 0.18, 40),
    new THREE.MeshStandardMaterial({ color: "#292524", roughness: 0.45, metalness: 0.18 })
  );
  standBase.position.y = 0.09;
  standBase.receiveShadow = true;
  root.add(standBase);

  const standRod = new THREE.Mesh(
    new THREE.CylinderGeometry(0.045, 0.055, 0.95, 16),
    new THREE.MeshStandardMaterial({ color: "#CBD5E1", roughness: 0.22, metalness: 0.92 })
  );
  standRod.position.y = 0.56;
  standRod.castShadow = true;
  root.add(standRod);

  const heart = new THREE.Group();
  heart.position.y = 1.98;
  root.add(heart);

  const muscleMat = new THREE.MeshPhysicalMaterial({
    map: tissuePbr.map,
    bumpMap: tissuePbr.bumpMap,
    bumpScale: 0.038,
    roughness: 0.36,
    metalness: 0.02,
    clearcoat: 0.58,
    clearcoatRoughness: 0.26,
  });
  const veinMat = new THREE.MeshPhysicalMaterial({
    color: "#2563EB",
    bumpMap: tissuePbr.bumpMap,
    bumpScale: 0.018,
    roughness: 0.36,
    metalness: 0.06,
    clearcoat: 0.52,
  });
  const arteryMat = new THREE.MeshPhysicalMaterial({
    color: "#B91C1C",
    bumpMap: tissuePbr.bumpMap,
    bumpScale: 0.02,
    roughness: 0.30,
    metalness: 0.04,
    clearcoat: 0.65,
  });
  const coronaryMat = new THREE.MeshPhysicalMaterial({
    color: "#991B1B",
    roughness: 0.28,
    metalness: 0.04,
    clearcoat: 0.72,
  });

  // Organic tapered ventricles
  const leftVentricle = new THREE.Mesh(new THREE.SphereGeometry(0.95, 36, 36), muscleMat);
  leftVentricle.scale.set(0.86, 1.24, 0.84);
  leftVentricle.position.set(0.28, -0.25, 0.04);
  leftVentricle.rotation.z = 0.26;
  leftVentricle.castShadow = true;
  leftVentricle.receiveShadow = true;

  const rightVentricle = new THREE.Mesh(new THREE.SphereGeometry(0.85, 36, 36), muscleMat);
  rightVentricle.scale.set(0.84, 1.12, 0.80);
  rightVentricle.position.set(-0.34, -0.18, 0.12);
  rightVentricle.rotation.z = -0.22;
  rightVentricle.castShadow = true;
  rightVentricle.receiveShadow = true;

  // Atria
  const rightAtrium = new THREE.Mesh(new THREE.SphereGeometry(0.55, 28, 28), veinMat);
  rightAtrium.position.set(-0.56, 0.54, 0.02);
  rightAtrium.castShadow = true;

  const leftAtrium = new THREE.Mesh(new THREE.SphereGeometry(0.52, 28, 28), arteryMat);
  leftAtrium.position.set(0.52, 0.50, -0.08);
  leftAtrium.castShadow = true;

  // Aortic Arch with 3 branching carotid/subclavian arteries
  const aortaCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.16, 0.42, 0.05),
    new THREE.Vector3(0.10, 1.25, 0.04),
    new THREE.Vector3(-0.28, 1.40, -0.12),
    new THREE.Vector3(-0.46, 0.90, -0.32),
  ]);
  const aorta = new THREE.Mesh(new THREE.TubeGeometry(aortaCurve, 40, 0.20, 20, false), arteryMat);
  aorta.castShadow = true;

  const branchOffsets: Array<[number, number, number]> = [
    [0.08, 1.46, 0.02],
    [-0.08, 1.54, -0.04],
    [-0.24, 1.50, -0.10],
  ];
  branchOffsets.forEach(([bx, by, bz]) => {
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.068, 0.34, 14), arteryMat);
    b.position.set(bx, by, bz);
    b.castShadow = true;
    heart.add(b);
  });

  // Superior & Inferior Vena Cava
  const venaCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.68, 0.42, -0.05),
    new THREE.Vector3(-0.76, 1.32, -0.08),
  ]);
  const venaCava = new THREE.Mesh(new THREE.TubeGeometry(venaCurve, 20, 0.155, 16, false), veinMat);
  venaCava.castShadow = true;

  // Pulmonary artery trunk
  const pulmCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.20, 0.34, 0.32),
    new THREE.Vector3(0.06, 0.96, 0.26),
    new THREE.Vector3(0.76, 0.88, 0.10),
  ]);
  const pulmonary = new THREE.Mesh(new THREE.TubeGeometry(pulmCurve, 26, 0.135, 16, false), veinMat);
  pulmonary.castShadow = true;

  // Surface Coronary Arteries running down interventricular sulcus (huge physical realism boost!)
  const corCurve1 = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.05, 0.42, 0.62),
    new THREE.Vector3(-0.04, 0.04, 0.82),
    new THREE.Vector3(-0.08, -0.45, 0.78),
    new THREE.Vector3(0.06, -0.92, 0.56),
  ]);
  const cor1 = new THREE.Mesh(new THREE.TubeGeometry(corCurve1, 24, 0.032, 10, false), coronaryMat);

  const corCurve2 = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.03, 0.02, 0.82),
    new THREE.Vector3(0.36, -0.22, 0.78),
    new THREE.Vector3(0.62, -0.58, 0.54),
  ]);
  const cor2 = new THREE.Mesh(new THREE.TubeGeometry(corCurve2, 18, 0.024, 10, false), coronaryMat);

  heart.add(
    leftVentricle,
    rightVentricle,
    rightAtrium,
    leftAtrium,
    aorta,
    venaCava,
    pulmonary,
    cor1,
    cor2
  );

  // Calm, gently drifting blood cells (biconcave discs) around the model
  const cells: THREE.Mesh[] = [];
  for (let i = 0; i < 8; i++) {
    const cell = new THREE.Mesh(
      new THREE.TorusGeometry(0.075, 0.034, 10, 18),
      new THREE.MeshStandardMaterial({
        color: i % 2 === 0 ? "#DC2626" : "#2563EB",
        roughness: 0.32,
        metalness: 0.05,
      })
    );
    root.add(cell);
    cells.push(cell);
  }

  return {
    root,
    textures: [tissuePbr.map, tissuePbr.bumpMap, metalPbr.map, metalPbr.bumpMap],
    anchors: [
      { label: "Aorta (Oxygenated Blood Out)", position: [0.05, 3.42, 0.0], focusScenes: [0, 2, 3] },
      { label: "Right Atrium (Vena Cava)", position: [-0.82, 2.55, 0.0], focusScenes: [1, 2] },
      { label: "Left Ventricle & Coronary", position: [0.55, 1.55, 0.65], focusScenes: [1, 2, 4] },
    ],
    update: (t) => {
      // Realistic calm 64 BPM resting lub-dub cardiac pulse
      const beatPhase = (t * 0.85) % 1;
      const pulse =
        1 +
        Math.exp(-Math.pow((beatPhase - 0.16) * 13, 2)) * 0.055 +
        Math.exp(-Math.pow((beatPhase - 0.36) * 15, 2)) * 0.032;
      heart.scale.setScalar(pulse);
      heart.rotation.y = Math.sin(t * 0.18) * 0.22;

      cells.forEach((c, idx) => {
        const a = t * 0.30 + (idx * Math.PI * 2) / cells.length;
        const r = 1.65 + (idx % 2) * 0.22;
        c.position.set(Math.cos(a) * r, 1.85 + Math.sin(a * 2) * 0.42, Math.sin(a) * r);
        c.rotation.x = t * 0.55 + idx;
        c.rotation.y = t * 0.4;
      });
    },
  };
}

function buildPlant3D(aniso: number): Built3DModel {
  const root = new THREE.Group();
  const leafPbr = createLeafPbr(aniso);
  const soilPbr = createLoamSoilPbr(aniso);
  const rockPbr = createRockPbr(aniso, 149, [130, 122, 110]);

  // Physical cutaway botanical terrarium soil block (realistic layered loam + pebbles + terracotta tray)
  const tray = new THREE.Mesh(
    new THREE.CylinderGeometry(1.92, 1.78, 0.16, 48),
    new THREE.MeshStandardMaterial({ color: "#9A3412", roughness: 0.78, metalness: 0.04 })
  );
  tray.position.y = 0.08;
  tray.receiveShadow = true;
  root.add(tray);

  const soilGeo = new THREE.CylinderGeometry(1.74, 1.64, 0.62, 44, 6);
  const soilPos = soilGeo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < soilPos.count; i++) {
    const x = soilPos.getX(i);
    const y = soilPos.getY(i);
    const z = soilPos.getZ(i);
    if (y > 0.28) {
      // Gentle natural soil mounding on top
      const mound = fbm2D(x * 1.4 + 3, z * 1.4 + 3, 701, 3) * 0.12;
      soilPos.setY(i, y + mound);
    }
  }
  soilGeo.computeVertexNormals();
  const soil = new THREE.Mesh(
    soilGeo,
    new THREE.MeshStandardMaterial({
      map: soilPbr.map,
      bumpMap: soilPbr.bumpMap,
      bumpScale: 0.06,
      roughness: 0.94,
      metalness: 0.01,
    })
  );
  soil.position.y = 0.44;
  soil.receiveShadow = true;
  soil.castShadow = true;
  root.add(soil);

  // Mossy turf patches & natural soil pebbles
  const mossMat = new THREE.MeshStandardMaterial({
    color: "#3F6212",
    bumpMap: soilPbr.bumpMap,
    bumpScale: 0.04,
    roughness: 0.92,
  });
  for (let i = 0; i < 6; i++) {
    const a = i * 1.05 + 0.3;
    const r = 0.55 + (i % 3) * 0.36;
    const moss = new THREE.Mesh(new THREE.SphereGeometry(0.32 + (i % 2) * 0.14, 16, 12), mossMat);
    moss.scale.set(1.2, 0.25, 1.1);
    moss.position.set(Math.cos(a) * r, 0.78, Math.sin(a) * r);
    moss.receiveShadow = true;
    root.add(moss);
  }

  // Visible fibrous root network emerging around cutaway edge
  const rootMat = new THREE.MeshStandardMaterial({ color: "#D6C5A7", roughness: 0.85, metalness: 0.02 });
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.25;
    const rCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0.76, 0),
      new THREE.Vector3(Math.cos(a) * 0.65, 0.56, Math.sin(a) * 0.65),
      new THREE.Vector3(Math.cos(a + 0.2) * 1.42, 0.34, Math.sin(a + 0.2) * 1.42),
      new THREE.Vector3(Math.cos(a + 0.35) * 1.72, 0.22, Math.sin(a + 0.35) * 1.72),
    ]);
    const rMesh = new THREE.Mesh(new THREE.TubeGeometry(rCurve, 18, 0.036, 8, false), rootMat);
    root.add(rMesh);
  }

  // Natural pebbles on top of soil
  const pebbleMat = new THREE.MeshStandardMaterial({
    map: rockPbr.map,
    bumpMap: rockPbr.bumpMap,
    bumpScale: 0.02,
    roughness: 0.88,
  });
  for (let i = 0; i < 8; i++) {
    const a = i * 0.82 + 0.5;
    const r = 0.45 + (i % 4) * 0.32;
    const peb = new THREE.Mesh(new THREE.DodecahedronGeometry(0.08 + (i % 3) * 0.025, 1), pebbleMat);
    peb.scale.set(1.2, 0.65, 1.0);
    peb.position.set(Math.cos(a) * r, 0.80, Math.sin(a) * r);
    peb.castShadow = true;
    root.add(peb);
  }

  // Sculpted organic botanical stem
  const stemCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0.74, 0),
    new THREE.Vector3(0.07, 1.48, 0.04),
    new THREE.Vector3(-0.05, 2.28, -0.04),
    new THREE.Vector3(0.02, 2.98, 0),
  ]);
  const stem = new THREE.Mesh(
    new THREE.TubeGeometry(stemCurve, 32, 0.10, 16, false),
    new THREE.MeshStandardMaterial({
      color: "#166534",
      bumpMap: leafPbr.bumpMap,
      bumpScale: 0.018,
      roughness: 0.68,
      metalness: 0.02,
    })
  );
  stem.castShadow = true;
  root.add(stem);

  // 8 realistically veined sculpted 3D botanical leaves
  const leafMat = new THREE.MeshPhysicalMaterial({
    map: leafPbr.map,
    bumpMap: leafPbr.bumpMap,
    bumpScale: 0.035,
    roughness: 0.38,
    metalness: 0.02,
    clearcoat: 0.28,
    clearcoatRoughness: 0.35,
    side: THREE.DoubleSide,
  });

  const leavesGroup = new THREE.Group();
  root.add(leavesGroup);
  for (let i = 0; i < 8; i++) {
    const leafShape = new THREE.Shape();
    leafShape.moveTo(0, 0);
    leafShape.quadraticCurveTo(0.42, 0.34, 0, 1.06);
    leafShape.quadraticCurveTo(-0.42, 0.34, 0, 0);

    const leafGeo = new THREE.ExtrudeGeometry(leafShape, {
      depth: 0.018,
      bevelEnabled: true,
      bevelThickness: 0.008,
      bevelSize: 0.008,
      bevelSegments: 2,
    });
    const leaf = new THREE.Mesh(leafGeo, leafMat);
    const y = 1.24 + i * 0.23;
    const angle = i * 2.38;
    leaf.position.set(0, y, 0);
    leaf.rotation.set(0.76 + (i % 3) * 0.14, angle, 0.18);
    leaf.scale.setScalar(0.88 - i * 0.04);
    leaf.castShadow = true;
    leaf.receiveShadow = true;
    leavesGroup.add(leaf);
  }

  // Warm physical Sun + gentle sunbeam cone
  const sun = new THREE.Mesh(
    new THREE.SphereGeometry(0.46, 28, 28),
    new THREE.MeshStandardMaterial({
      color: "#FEF08A",
      emissive: "#F59E0B",
      emissiveIntensity: 1.45,
      roughness: 0.25,
    })
  );
  sun.position.set(2.05, 3.25, -0.85);
  root.add(sun);

  const rayCone = new THREE.Mesh(
    new THREE.ConeGeometry(1.0, 3.1, 24, 1, true),
    new THREE.MeshBasicMaterial({
      color: "#FEF9C3",
      transparent: true,
      opacity: 0.09,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  );
  rayCone.position.set(1.02, 2.4, -0.42);
  rayCone.rotation.z = 0.72;
  rayCone.rotation.x = 0.25;
  root.add(rayCone);

  // Slowly rising translucent Oxygen (O2) droplets
  const bubbles: THREE.Mesh[] = [];
  for (let i = 0; i < 8; i++) {
    const b = new THREE.Mesh(
      new THREE.SphereGeometry(0.068, 16, 16),
      new THREE.MeshPhysicalMaterial({
        color: "#7DD3FC",
        roughness: 0.1,
        metalness: 0.05,
        clearcoat: 1,
        transparent: true,
        opacity: 0.78,
      })
    );
    root.add(b);
    bubbles.push(b);
  }

  return {
    root,
    textures: [leafPbr.map, leafPbr.bumpMap, soilPbr.map, soilPbr.bumpMap, rockPbr.map, rockPbr.bumpMap],
    anchors: [
      { label: "Sunlight Energy", position: [2.05, 3.3, -0.85], focusScenes: [0, 2] },
      { label: "Green Leaves (Chlorophyll)", position: [0.55, 2.25, 0.35], focusScenes: [1, 2] },
      { label: "Roots & Loam Soil (Water)", position: [-0.95, 0.55, 1.15], focusScenes: [1, 3] },
      { label: "Oxygen (O₂) Released", position: [-0.65, 2.85, 0.55], focusScenes: [2, 4] },
    ],
    update: (t) => {
      // Gentle natural breeze sway
      leavesGroup.rotation.y = Math.sin(t * 0.35) * 0.045;
      leavesGroup.rotation.z = Math.sin(t * 0.45) * 0.02;
      sun.scale.setScalar(1 + Math.sin(t * 1.1) * 0.025);
      bubbles.forEach((b, idx) => {
        const cyc = (t * 0.16 + idx * 0.125) % 1;
        const a = idx * 1.4;
        b.position.set(
          Math.cos(a) * (0.42 + cyc * 0.58),
          1.25 + cyc * 2.15,
          Math.sin(a) * (0.42 + cyc * 0.58)
        );
        b.scale.setScalar(0.5 + Math.sin(cyc * Math.PI) * 0.65);
      });
    },
  };
}

function buildWaterCycle3D(aniso: number): Built3DModel {
  const root = new THREE.Group();
  const rockPbr = createRockPbr(aniso, 211, [104, 102, 98]);
  const waterBump = createWaterRippleBump(aniso);
  const soilPbr = createLoamSoilPbr(aniso);

  // Physical museum diorama base (wood rim + Earth strata side)
  const woodRim = new THREE.Mesh(
    new THREE.CylinderGeometry(2.58, 2.66, 0.18, 56),
    new THREE.MeshStandardMaterial({ color: "#573B26", roughness: 0.62, metalness: 0.05 })
  );
  woodRim.position.y = 0.09;
  woodRim.receiveShadow = true;
  root.add(woodRim);

  const bedrock = new THREE.Mesh(
    new THREE.CylinderGeometry(2.45, 2.45, 0.32, 56),
    new THREE.MeshStandardMaterial({
      map: soilPbr.map,
      bumpMap: soilPbr.bumpMap,
      bumpScale: 0.04,
      roughness: 0.92,
    })
  );
  bedrock.position.y = 0.32;
  bedrock.receiveShadow = true;
  root.add(bedrock);

  // Realistic animated water basin with specular clearcoat & scrolling ripple bump map
  const ocean = new THREE.Mesh(
    new THREE.CylinderGeometry(2.42, 2.42, 0.08, 56),
    new THREE.MeshPhysicalMaterial({
      color: "#0369A1",
      bumpMap: waterBump,
      bumpScale: 0.04,
      roughness: 0.14,
      metalness: 0.1,
      clearcoat: 1.0,
      clearcoatRoughness: 0.12,
    })
  );
  ocean.position.y = 0.49;
  ocean.receiveShadow = true;
  root.add(ocean);

  // Sculpted vertex-displaced alpine mountain ridge (NO blocky 7-sided cones!)
  const terrainGeo = new THREE.PlaneGeometry(3.4, 3.1, 44, 44);
  terrainGeo.rotateX(-Math.PI / 2);
  const tPos = terrainGeo.attributes.position as THREE.BufferAttribute;
  const tColors = new Float32Array(tPos.count * 3);
  const cGrass = new THREE.Color("#3F7A3E");
  const cRock = new THREE.Color("#6B6E70");
  const cSnow = new THREE.Color("#F1F5F9");
  const cShore = new THREE.Color("#B89F72");
  const tmpColor = new THREE.Color();

  for (let i = 0; i < tPos.count; i++) {
    const x = tPos.getX(i);
    const z = tPos.getZ(i);
    // Circular diorama mask so mountain fits organically inside left-back half of basin
    const worldX = x - 0.55;
    const worldZ = z - 0.32;
    const distFromCenter = Math.hypot(worldX, worldZ);
    const edgeFalloff = THREE.MathUtils.clamp(1 - Math.max(0, distFromCenter - 1.65) / 0.72, 0, 1);

    // Two organic peaks + carved river valley
    const peakA = Math.exp(-((x + 0.55) ** 2 * 1.15 + (z + 0.15) ** 2 * 1.25)) * 1.92;
    const peakB = Math.exp(-((x - 0.35) ** 2 * 1.55 + (z + 0.58) ** 2 * 1.5)) * 1.32;
    const ridgeNoise = (fbm2D(x * 1.9 + 5, z * 1.9 + 5, 811, 4) - 0.35) * 0.58;
    // Gently fade down toward the ocean on the +X / +Z side
    const coastMask = THREE.MathUtils.clamp((0.85 - (x * 0.55 + z * 0.45)) * 0.9, 0, 1);
    const h = Math.max(-0.08, (peakA + peakB + ridgeNoise * coastMask) * edgeFalloff);
    tPos.setY(i, h);

    // Vertex biome coloring by elevation (sand shore -> lush valley -> granite crag -> snow cap)
    if (h < 0.08) {
      tmpColor.copy(cShore);
    } else if (h < 0.58) {
      tmpColor.copy(cGrass).lerp(cRock, (h - 0.08) / 0.5 * 0.45);
    } else if (h < 1.32) {
      tmpColor.copy(cRock).lerp(cSnow, Math.max(0, (h - 1.05) / 0.27) * 0.4);
    } else {
      tmpColor.copy(cRock).lerp(cSnow, THREE.MathUtils.clamp((h - 1.25) / 0.35, 0, 1));
    }
    tColors[i * 3] = tmpColor.r;
    tColors[i * 3 + 1] = tmpColor.g;
    tColors[i * 3 + 2] = tmpColor.b;
  }
  terrainGeo.setAttribute("color", new THREE.BufferAttribute(tColors, 3));
  terrainGeo.computeVertexNormals();

  const terrain = new THREE.Mesh(
    terrainGeo,
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      bumpMap: rockPbr.bumpMap,
      bumpScale: 0.045,
      roughness: 0.88,
      metalness: 0.02,
    })
  );
  terrain.position.set(-0.55, 0.50, -0.32);
  terrain.castShadow = true;
  terrain.receiveShadow = true;
  root.add(terrain);

  // Winding mountain river flowing back into ocean
  const riverCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.78, 1.32, -0.22),
    new THREE.Vector3(-0.42, 0.92, 0.14),
    new THREE.Vector3(0.05, 0.65, 0.35),
    new THREE.Vector3(0.52, 0.52, 0.68),
  ]);
  const river = new THREE.Mesh(
    new THREE.TubeGeometry(riverCurve, 28, 0.075, 10, false),
    new THREE.MeshPhysicalMaterial({
      color: "#0EA5E9",
      roughness: 0.12,
      metalness: 0.08,
      clearcoat: 1.0,
    })
  );
  river.scale.y = 0.38;
  river.position.y = 0.32;
  root.add(river);

  // Tiny pine trees on lower valley slopes for physical scale
  const pineMat = new THREE.MeshStandardMaterial({ color: "#166534", roughness: 0.88 });
  const trunkMat = new THREE.MeshStandardMaterial({ color: "#573B26", roughness: 0.9 });
  const treeCoords: Array<[number, number, number]> = [
    [-0.2, 0.72, 0.45],
    [-0.42, 0.80, 0.58],
    [0.25, 0.66, 0.12],
    [-1.25, 0.74, 0.35],
    [-0.08, 0.78, -0.18],
  ];
  treeCoords.forEach(([tx, ty, tz]) => {
    const tGroup = new THREE.Group();
    tGroup.position.set(tx, ty, tz);
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.024, 0.12, 8), trunkMat);
    trunk.position.y = 0.06;
    const crown = new THREE.Mesh(new THREE.ConeGeometry(0.095, 0.28, 10), pineMat);
    crown.position.y = 0.22;
    crown.castShadow = true;
    tGroup.add(trunk, crown);
    root.add(tGroup);
  });

  // Warm Golden Sun
  const sun = new THREE.Mesh(
    new THREE.SphereGeometry(0.44, 28, 28),
    new THREE.MeshStandardMaterial({
      color: "#FEF08A",
      emissive: "#F59E0B",
      emissiveIntensity: 1.35,
      roughness: 0.25,
    })
  );
  sun.position.set(1.75, 3.15, -0.55);
  root.add(sun);

  // Soft cumulus rain cloud
  const cloud = new THREE.Group();
  cloud.position.set(-0.72, 3.18, -0.18);
  const cloudMat = new THREE.MeshStandardMaterial({
    color: "#E2E8F0",
    roughness: 0.88,
    metalness: 0.01,
  });
  const puffCoords: Array<[number, number, number, number]> = [
    [0, 0, 0, 0.50],
    [-0.46, -0.07, 0.08, 0.38],
    [0.48, -0.05, -0.05, 0.40],
    [0.16, 0.22, 0.08, 0.34],
    [-0.22, 0.19, -0.08, 0.33],
    [0.24, -0.1, 0.24, 0.30],
  ];
  puffCoords.forEach(([x, y, z, r]) => {
    const p = new THREE.Mesh(new THREE.SphereGeometry(r, 22, 22), cloudMat);
    p.position.set(x, y, z);
    p.castShadow = true;
    cloud.add(p);
  });
  root.add(cloud);

  // Calm rising evaporation mist + gentle rain droplets
  const vapors: THREE.Mesh[] = [];
  const rains: THREE.Mesh[] = [];
  const vaporMat = new THREE.MeshBasicMaterial({
    color: "#E0F2FE",
    transparent: true,
    opacity: 0.48,
  });
  const rainMat = new THREE.MeshPhysicalMaterial({
    color: "#38BDF8",
    roughness: 0.1,
    metalness: 0.05,
    clearcoat: 1,
    transparent: true,
    opacity: 0.82,
  });

  for (let i = 0; i < 8; i++) {
    const v = new THREE.Mesh(new THREE.SphereGeometry(0.072, 12, 12), vaporMat);
    root.add(v);
    vapors.push(v);

    const r = new THREE.Mesh(new THREE.CapsuleGeometry(0.018, 0.14, 6, 8), rainMat);
    root.add(r);
    rains.push(r);
  }

  return {
    root,
    textures: [rockPbr.map, rockPbr.bumpMap, waterBump, soilPbr.map, soilPbr.bumpMap],
    anchors: [
      { label: "1. Evaporation (Sun heats ocean)", position: [1.15, 1.35, 0.65], focusScenes: [0, 2] },
      { label: "2. Condensation (Rain Cloud)", position: [-0.72, 3.55, -0.18], focusScenes: [1, 2] },
      { label: "3. Precipitation (Rain)", position: [-0.85, 2.35, 0.15], focusScenes: [2, 3] },
      { label: "4. Runoff River → Ocean", position: [0.22, 0.72, 0.55], focusScenes: [3, 4] },
    ],
    update: (t) => {
      // Slow natural ocean surface shimmer
      waterBump.offset.x = t * 0.035;
      waterBump.offset.y = t * 0.02;

      cloud.position.x = -0.72 + Math.sin(t * 0.26) * 0.16;

      vapors.forEach((v, idx) => {
        const cyc = (t * 0.16 + idx * 0.125) % 1;
        v.position.set(
          0.72 + Math.sin(t * 0.8 + idx) * 0.22 + (idx % 3) * 0.26,
          0.62 + cyc * 2.25,
          0.42 + ((idx % 4) - 1.5) * 0.28
        );
        v.scale.setScalar(0.45 + Math.sin(cyc * Math.PI) * 0.75);
      });

      rains.forEach((r, idx) => {
        const cyc = (t * 0.42 + idx * 0.125) % 1;
        r.position.set(
          cloud.position.x + ((idx % 4) - 1.5) * 0.24,
          2.85 - cyc * 1.95,
          cloud.position.z + (idx % 2 === 0 ? 0.16 : -0.14)
        );
      });
    },
  };
}

function buildRocket3D(aniso: number, accentColor: string): Built3DModel {
  const root = new THREE.Group();
  const metalPbr = createBrushedMetalPbr(aniso);
  const rockPbr = createRockPbr(aniso, 311, [110, 114, 120]);

  // Concrete & steel launch pad
  const pad = new THREE.Mesh(
    new THREE.CylinderGeometry(1.68, 1.88, 0.24, 40),
    new THREE.MeshStandardMaterial({
      map: rockPbr.map,
      bumpMap: rockPbr.bumpMap,
      bumpScale: 0.025,
      roughness: 0.78,
      metalness: 0.2,
    })
  );
  pad.position.y = 0.12;
  pad.receiveShadow = true;
  root.add(pad);

  // Steel launch tower gantry beside rocket
  const gantryMat = new THREE.MeshStandardMaterial({ color: "#9A3412", roughness: 0.5, metalness: 0.72 });
  const towerPost = new THREE.Mesh(new THREE.BoxGeometry(0.14, 3.1, 0.14), gantryMat);
  towerPost.position.set(-1.18, 1.72, -0.35);
  towerPost.castShadow = true;
  const serviceArm = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.08, 0.1), gantryMat);
  serviceArm.position.set(-0.82, 2.75, -0.2);
  root.add(towerPost, serviceArm);

  const rocket = new THREE.Group();
  rocket.position.y = 1.02;
  root.add(rocket);

  const bodyMat = new THREE.MeshPhysicalMaterial({
    map: metalPbr.map,
    bumpMap: metalPbr.bumpMap,
    bumpScale: 0.015,
    color: "#F1F5F9",
    roughness: 0.30,
    metalness: 0.65,
    clearcoat: 0.45,
  });
  const accentMat = new THREE.MeshStandardMaterial({
    color: accentColor,
    roughness: 0.36,
    metalness: 0.35,
  });
  const darkMetal = new THREE.MeshStandardMaterial({
    color: "#1E293B",
    roughness: 0.40,
    metalness: 0.82,
  });

  // Main fuselage
  const fuselage = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.51, 2.25, 36), bodyMat);
  fuselage.position.y = 1.2;
  fuselage.castShadow = true;
  rocket.add(fuselage);

  // Interstage thermal ring
  const stageBand = new THREE.Mesh(new THREE.CylinderGeometry(0.478, 0.49, 0.24, 36), darkMetal);
  stageBand.position.y = 0.85;
  rocket.add(stageBand);

  // Aerodynamic payload fairing nose cone
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.45, 1.05, 36), accentMat);
  nose.position.y = 2.84;
  nose.castShadow = true;
  rocket.add(nose);

  // Crew capsule viewport
  const windowFrame = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.032, 12, 24), darkMetal);
  windowFrame.position.set(0, 1.72, 0.44);
  const glass = new THREE.Mesh(
    new THREE.SphereGeometry(0.145, 20, 20),
    new THREE.MeshPhysicalMaterial({
      color: "#0EA5E9",
      roughness: 0.08,
      metalness: 0.15,
      clearcoat: 1,
    })
  );
  glass.scale.z = 0.45;
  glass.position.set(0, 1.72, 0.42);
  rocket.add(windowFrame, glass);

  // 4 swept fins
  for (let i = 0; i < 4; i++) {
    const finShape = new THREE.Shape();
    finShape.moveTo(0, 0);
    finShape.lineTo(0.54, -0.3);
    finShape.lineTo(0.54, -0.80);
    finShape.lineTo(0, -0.66);
    finShape.closePath();
    const fin = new THREE.Mesh(
      new THREE.ExtrudeGeometry(finShape, { depth: 0.055, bevelEnabled: true, bevelThickness: 0.014, bevelSize: 0.014 }),
      accentMat
    );
    const a = (i * Math.PI) / 2;
    fin.position.set(Math.cos(a) * 0.47, 0.72, Math.sin(a) * 0.47);
    fin.rotation.y = -a;
    fin.castShadow = true;
    rocket.add(fin);
  }

  // Bell engine nozzle + soft exhaust plume
  const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.36, 0.36, 24), darkMetal);
  nozzle.position.y = -0.08;
  rocket.add(nozzle);

  const flame = new THREE.Mesh(
    new THREE.ConeGeometry(0.30, 1.05, 20),
    new THREE.MeshStandardMaterial({
      color: "#FEF08A",
      emissive: "#F97316",
      emissiveIntensity: 1.9,
      transparent: true,
      opacity: 0.85,
      roughness: 0.25,
    })
  );
  flame.rotation.x = Math.PI;
  flame.position.y = -0.74;
  rocket.add(flame);

  return {
    root,
    textures: [metalPbr.map, metalPbr.bumpMap, rockPbr.map, rockPbr.bumpMap],
    anchors: [
      { label: "Payload Nose Cone", position: [0, 4.1, 0], focusScenes: [0, 1] },
      { label: "Fuel Tank & Hull", position: [0.55, 2.25, 0.2], focusScenes: [1, 2] },
      { label: "Engine Nozzle (Thrust)", position: [0.35, 0.92, 0.15], focusScenes: [2, 3, 4] },
    ],
    update: (t) => {
      rocket.position.y = 1.05 + Math.sin(t * 0.9) * 0.08;
      rocket.rotation.y = t * 0.14;
      flame.scale.set(
        0.94 + Math.sin(t * 9) * 0.05,
        0.92 + Math.cos(t * 11) * 0.09,
        0.94 + Math.sin(t * 9) * 0.05
      );
    },
  };
}

function buildCircuit3D(aniso: number, accentColor: string): Built3DModel {
  const root = new THREE.Group();
  const pcbTex = createCircuitPcbTexture(aniso);
  const metalPbr = createBrushedMetalPbr(aniso);

  // Matte fiberglass PCB elevated on 4 machined brass standoffs
  const board = new THREE.Mesh(
    new THREE.BoxGeometry(3.4, 0.14, 2.45),
    new THREE.MeshStandardMaterial({ map: pcbTex, roughness: 0.46, metalness: 0.18 })
  );
  board.position.y = 0.42;
  board.castShadow = true;
  board.receiveShadow = true;
  root.add(board);

  const brassMat = new THREE.MeshStandardMaterial({ color: "#D97706", roughness: 0.24, metalness: 0.92 });
  [[-1.5, -1.02], [1.5, -1.02], [-1.5, 1.02], [1.5, 1.02]].forEach(([x, z]) => {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.36, 16), brassMat);
    post.position.set(x, 0.18, z);
    root.add(post);
  });

  // Ceramic IC processor package + brushed nickel heat spreader
  const cpuPkg = new THREE.Mesh(
    new THREE.BoxGeometry(1.15, 0.20, 1.15),
    new THREE.MeshStandardMaterial({ color: "#1E293B", roughness: 0.62, metalness: 0.12 })
  );
  cpuPkg.position.y = 0.59;
  cpuPkg.castShadow = true;
  root.add(cpuPkg);

  const ihs = new THREE.Mesh(
    new THREE.BoxGeometry(0.84, 0.08, 0.84),
    new THREE.MeshPhysicalMaterial({
      map: metalPbr.map,
      bumpMap: metalPbr.bumpMap,
      bumpScale: 0.01,
      color: "#CBD5E1",
      roughness: 0.22,
      metalness: 0.92,
      clearcoat: 0.25,
    })
  );
  ihs.position.y = 0.73;
  root.add(ihs);

  // Soldered gold pins on all 4 sides
  for (let i = -3; i <= 3; i++) {
    const offset = i * 0.14;
    const pinA = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.07, 0.14), brassMat);
    pinA.position.set(offset, 0.54, 0.62);
    const pinB = pinA.clone();
    pinB.position.set(offset, 0.54, -0.62);
    const pinC = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.07, 0.038), brassMat);
    pinC.position.set(0.62, 0.54, offset);
    const pinD = pinC.clone();
    pinD.position.set(-0.62, 0.54, offset);
    root.add(pinA, pinB, pinC, pinD);
  }

  // Electrolytic capacitors with brushed aluminum top discs
  const capMat = new THREE.MeshStandardMaterial({ color: "#1D4ED8", roughness: 0.30, metalness: 0.62 });
  const capTopMat = new THREE.MeshStandardMaterial({ color: "#E2E8F0", roughness: 0.2, metalness: 0.92 });
  [[-1.16, -0.64], [-1.16, 0], [-1.16, 0.64]].forEach(([x, z]) => {
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.54, 22), capMat);
    cap.position.set(x, 0.76, z);
    cap.castShadow = true;
    const top = new THREE.Mesh(new THREE.CylinderGeometry(0.155, 0.155, 0.02, 20), capTopMat);
    top.position.set(x, 1.04, z);
    root.add(cap, top);
  });

  // Copper inductor coils
  const coilMat = new THREE.MeshStandardMaterial({ color: "#C2410C", roughness: 0.28, metalness: 0.88 });
  [[1.16, -0.55], [1.16, 0.55]].forEach(([x, z]) => {
    const coil = new THREE.Mesh(new THREE.TorusGeometry(0.21, 0.068, 14, 28), coilMat);
    coil.position.set(x, 0.70, z);
    coil.castShadow = true;
    root.add(coil);
  });

  // Calm electric current pulses moving clearly along copper traces
  const pulses: THREE.Mesh[] = [];
  for (let i = 0; i < 6; i++) {
    const pulse = new THREE.Mesh(
      new THREE.SphereGeometry(0.065, 14, 14),
      new THREE.MeshStandardMaterial({
        color: "#FEF08A",
        emissive: accentColor,
        emissiveIntensity: 1.5,
        roughness: 0.15,
      })
    );
    root.add(pulse);
    pulses.push(pulse);
  }

  return {
    root,
    textures: [pcbTex, metalPbr.map, metalPbr.bumpMap],
    anchors: [
      { label: "Central Processor (IC Chip)", position: [0, 0.92, 0], focusScenes: [0, 1] },
      { label: "Capacitors (Store Charge)", position: [-1.16, 1.15, 0], focusScenes: [1, 2] },
      { label: "Copper Inductor Coils", position: [1.16, 0.98, 0.55], focusScenes: [2, 3, 4] },
    ],
    update: (t) => {
      pulses.forEach((p, idx) => {
        const cyc = (t * 0.30 + idx * 0.166) % 1;
        const lane = (idx % 3) - 1;
        p.position.set(-1.52 + cyc * 3.04, 0.55 + Math.sin(cyc * Math.PI) * 0.06, lane * 0.65);
      });
    },
  };
}

function buildEarthGlobe3D(aniso: number): Built3DModel {
  const root = new THREE.Group();
  const earthPbr = createEarthPbrSet(aniso);
  const cloudsTex = createCloudsTexture(aniso);

  // Weighted walnut & machined brass museum meridian globe stand
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.96, 1.16, 0.20, 44),
    new THREE.MeshStandardMaterial({ color: "#3E2723", roughness: 0.48, metalness: 0.12 })
  );
  base.position.y = 0.10;
  base.receiveShadow = true;
  root.add(base);

  const brassMat = new THREE.MeshStandardMaterial({ color: "#CA8A04", roughness: 0.24, metalness: 0.92 });
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.13, 0.48, 22), brassMat);
  stem.position.y = 0.44;
  stem.castShadow = true;
  root.add(stem);

  const arc = new THREE.Mesh(new THREE.TorusGeometry(1.56, 0.045, 16, 64, Math.PI * 1.15), brassMat);
  arc.position.y = 2.05;
  arc.rotation.z = -Math.PI * 0.58;
  arc.castShadow = true;
  root.add(arc);

  const globeGroup = new THREE.Group();
  globeGroup.position.y = 2.05;
  globeGroup.rotation.z = 0.41; // 23.5 deg Earth axial tilt
  root.add(globeGroup);

  // Realistic Earth: specular ocean water vs matte elevated continents!
  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(1.38, 52, 52),
    new THREE.MeshStandardMaterial({
      map: earthPbr.map,
      bumpMap: earthPbr.bumpMap,
      bumpScale: 0.045,
      roughnessMap: earthPbr.roughnessMap,
      roughness: 0.92,
      metalness: 0.06,
    })
  );
  earth.castShadow = true;
  earth.receiveShadow = true;
  globeGroup.add(earth);

  const clouds = new THREE.Mesh(
    new THREE.SphereGeometry(1.415, 44, 44),
    new THREE.MeshStandardMaterial({
      map: cloudsTex,
      transparent: true,
      opacity: 0.65,
      roughness: 0.92,
      depthWrite: false,
    })
  );
  globeGroup.add(clouds);

  // Subtle translucent blue atmosphere halo shell
  const atmo = new THREE.Mesh(
    new THREE.SphereGeometry(1.465, 36, 36),
    new THREE.MeshBasicMaterial({
      color: "#60A5FA",
      transparent: true,
      opacity: 0.11,
      side: THREE.BackSide,
      depthWrite: false,
    })
  );
  globeGroup.add(atmo);

  // Calmly orbiting Earth observation satellite
  const satPivot = new THREE.Group();
  satPivot.position.y = 2.05;
  satPivot.rotation.z = 0.28;
  root.add(satPivot);

  const sat = new THREE.Group();
  sat.position.set(2.12, 0, 0);
  const satBody = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.20, 0.24), brassMat);
  const panelMat = new THREE.MeshStandardMaterial({
    color: "#1E40AF",
    roughness: 0.22,
    metalness: 0.82,
  });
  const wingL = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.02, 0.16), panelMat);
  wingL.position.x = -0.35;
  const wingR = wingL.clone();
  wingR.position.x = 0.35;
  sat.add(satBody, wingL, wingR);
  satPivot.add(sat);

  return {
    root,
    textures: [earthPbr.map, earthPbr.bumpMap, earthPbr.roughnessMap!, cloudsTex],
    anchors: [
      { label: "Atmosphere & Clouds", position: [0.85, 3.2, 0.55], focusScenes: [0, 1] },
      { label: "23.5° Tilted Axis", position: [-0.65, 3.35, 0], focusScenes: [1, 2] },
      { label: "Oceans & Continents", position: [0.4, 2.05, 1.38], focusScenes: [2, 3, 4] },
    ],
    update: (t) => {
      earth.rotation.y = t * 0.12;
      clouds.rotation.y = t * 0.15;
      satPivot.rotation.y = t * 0.26;
    },
  };
}

function buildVolcano3D(aniso: number): Built3DModel {
  const root = new THREE.Group();
  const basaltPbr = createRockPbr(aniso, 433, [68, 62, 58]);
  const crustPbr = createLoamSoilPbr(aniso);

  // Stratified geological crust cutaway base
  const crust = new THREE.Mesh(
    new THREE.CylinderGeometry(2.38, 2.26, 0.44, 48),
    new THREE.MeshStandardMaterial({
      map: crustPbr.map,
      bumpMap: crustPbr.bumpMap,
      bumpScale: 0.05,
      roughness: 0.92,
      metalness: 0.02,
    })
  );
  crust.position.y = 0.22;
  crust.receiveShadow = true;
  root.add(crust);

  // Sculpted rugged vertex-displaced volcanic basalt mountain (NOT a smooth cylinder!)
  const coneGeo = new THREE.CylinderGeometry(0.56, 2.15, 2.25, 44, 18, false);
  const cPos = coneGeo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < cPos.count; i++) {
    const x = cPos.getX(i);
    const y = cPos.getY(i);
    const z = cPos.getZ(i);
    const r = Math.hypot(x, z);
    if (r > 0.12) {
      const ang = Math.atan2(z, x);
      const heightFrac = (y + 1.125) / 2.25; // 0 bottom .. 1 crater top
      // Natural radial volcanic gullies + jagged rocky ridges
      const gully = Math.sin(ang * 7 + heightFrac * 1.4) * 0.08 * (1 - heightFrac * 0.4);
      const crag = (fbm2D(x * 1.8 + 4, z * 1.8 + y * 1.4, 919, 4) - 0.5) * 0.34;
      const scale = 1 + (gully + crag) / Math.max(0.5, r);
      cPos.setX(i, x * scale);
      cPos.setZ(i, z * scale);
      // Slightly uneven rocky crater rim
      if (heightFrac > 0.94) {
        cPos.setY(i, y + Math.sin(ang * 5) * 0.07);
      }
    }
  }
  coneGeo.computeVertexNormals();

  const cone = new THREE.Mesh(
    coneGeo,
    new THREE.MeshStandardMaterial({
      map: basaltPbr.map,
      bumpMap: basaltPbr.bumpMap,
      bumpScale: 0.07,
      roughness: 0.92,
      metalness: 0.04,
    })
  );
  cone.position.y = 1.54;
  cone.castShadow = true;
  cone.receiveShadow = true;
  root.add(cone);

  // Glowing molten magma chamber cutaway + central conduit + crater pool
  const lavaMat = new THREE.MeshStandardMaterial({
    color: "#FDE047",
    emissive: "#EA580C",
    emissiveIntensity: 1.85,
    roughness: 0.28,
  });

  const magmaPool = new THREE.Mesh(new THREE.SphereGeometry(0.64, 24, 24), lavaMat);
  magmaPool.scale.set(1.25, 0.55, 0.85);
  magmaPool.position.set(0, 0.50, 1.42);
  root.add(magmaPool);

  const craterLava = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.36, 0.14, 24), lavaMat);
  craterLava.position.y = 2.62;
  root.add(craterLava);

  // Organic winding lava channels down basalt slopes
  const lavaFlowAngles = [0.45, 2.35, 4.35];
  lavaFlowAngles.forEach((a) => {
    const lCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(Math.cos(a) * 0.44, 2.60, Math.sin(a) * 0.44),
      new THREE.Vector3(Math.cos(a + 0.08) * 0.95, 1.92, Math.sin(a + 0.08) * 0.95),
      new THREE.Vector3(Math.cos(a - 0.06) * 1.45, 1.15, Math.sin(a - 0.06) * 1.45),
      new THREE.Vector3(Math.cos(a + 0.04) * 1.98, 0.52, Math.sin(a + 0.04) * 1.98),
    ]);
    const stream = new THREE.Mesh(new THREE.TubeGeometry(lCurve, 22, 0.075, 10, false), lavaMat);
    root.add(stream);
  });

  // Warm orange glow inside crater
  const craterLight = new THREE.PointLight("#F97316", 6, 8, 1.8);
  craterLight.position.set(0, 2.9, 0);
  root.add(craterLight);

  // Slowly billowing volcanic ash cloud + subtle glowing embers
  const puffs: THREE.Mesh[] = [];
  const smokeMat = new THREE.MeshStandardMaterial({
    color: "#64748B",
    roughness: 0.96,
    transparent: true,
    opacity: 0.68,
  });
  for (let i = 0; i < 9; i++) {
    const isEmber = i % 3 === 0;
    const puff = new THREE.Mesh(
      new THREE.DodecahedronGeometry(isEmber ? 0.11 : 0.26, 1),
      isEmber ? lavaMat : smokeMat
    );
    root.add(puff);
    puffs.push(puff);
  }

  return {
    root,
    textures: [basaltPbr.map, basaltPbr.bumpMap, crustPbr.map, crustPbr.bumpMap],
    anchors: [
      { label: "Crater & Ash Plume", position: [0, 3.25, 0], focusScenes: [0, 2] },
      { label: "Molten Lava Flow", position: [1.15, 1.55, 0.65], focusScenes: [1, 2, 3] },
      { label: "Magma Chamber (Underground)", position: [0, 0.65, 1.65], focusScenes: [1, 2, 4] },
    ],
    update: (t) => {
      craterLight.intensity = 5.2 + Math.sin(t * 2.2) * 1.2;
      puffs.forEach((p, idx) => {
        const cyc = (t * 0.20 + idx * 0.11) % 1;
        const a = idx * 1.7 + t * 0.22;
        p.position.set(
          Math.cos(a) * cyc * 0.68,
          2.70 + cyc * 1.55,
          Math.sin(a) * cyc * 0.68
        );
        p.scale.setScalar(0.5 + cyc * 1.05);
      });
    },
  };
}

function buildWaveOptics3D(primaryColor: string, aniso: number): Built3DModel {
  const root = new THREE.Group();
  const metalPbr = createBrushedMetalPbr(aniso);

  // Physical optical lab bench rail + tank frame
  const rail = new THREE.Mesh(
    new THREE.BoxGeometry(4.55, 0.16, 2.95),
    new THREE.MeshStandardMaterial({
      map: metalPbr.map,
      bumpMap: metalPbr.bumpMap,
      bumpScale: 0.01,
      color: "#334155",
      roughness: 0.42,
      metalness: 0.72,
    })
  );
  rail.position.y = 0.08;
  rail.receiveShadow = true;
  root.add(rail);

  // Calm undulating 3D wave surface inside optical tank
  const waveGeo = new THREE.PlaneGeometry(4.2, 2.6, 40, 24);
  waveGeo.rotateX(-Math.PI / 2);
  const waveMat = new THREE.MeshPhysicalMaterial({
    color: primaryColor,
    roughness: 0.18,
    metalness: 0.2,
    clearcoat: 0.9,
    side: THREE.DoubleSide,
  });
  const waveMesh = new THREE.Mesh(waveGeo, waveMat);
  waveMesh.position.y = 0.68;
  waveMesh.receiveShadow = true;
  root.add(waveMesh);

  // Brass prism pedestal + crystal triangular glass prism
  const prismStand = new THREE.Mesh(
    new THREE.CylinderGeometry(0.32, 0.42, 0.92, 24),
    new THREE.MeshStandardMaterial({ color: "#D97706", roughness: 0.25, metalness: 0.9 })
  );
  prismStand.position.set(0, 1.18, 0);
  root.add(prismStand);

  const prism = new THREE.Mesh(
    new THREE.CylinderGeometry(0.72, 0.72, 1.15, 3),
    new THREE.MeshPhysicalMaterial({
      color: "#E0F2FE",
      roughness: 0.06,
      metalness: 0.08,
      clearcoat: 1.0,
      transparent: true,
      opacity: 0.72,
    })
  );
  prism.position.set(0, 2.22, 0);
  prism.castShadow = true;
  root.add(prism);

  // Incident white light ray + 6 clean refracted rainbow spectrum beams
  const whiteRay = new THREE.Mesh(
    new THREE.CylinderGeometry(0.048, 0.048, 2.15, 12),
    new THREE.MeshStandardMaterial({ color: "#FFFFFF", emissive: "#FFFFFF", emissiveIntensity: 1.5 })
  );
  whiteRay.rotation.z = Math.PI / 2 - 0.18;
  whiteRay.position.set(-1.35, 2.08, 0);
  root.add(whiteRay);

  const rainbow = ["#EF4444", "#F97316", "#FACC15", "#22C55E", "#3B82F6", "#8B5CF6"];
  rainbow.forEach((hex, idx) => {
    const spread = (idx - 2.5) * 0.12;
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.034, 0.048, 2.25, 12),
      new THREE.MeshStandardMaterial({ color: hex, emissive: hex, emissiveIntensity: 1.35 })
    );
    beam.rotation.z = Math.PI / 2 + spread;
    beam.position.set(1.42, 2.22 - spread * 1.12, (idx - 2.5) * 0.05);
    root.add(beam);
  });

  const posAttr = waveGeo.attributes.position as THREE.BufferAttribute;

  return {
    root,
    textures: [metalPbr.map, metalPbr.bumpMap],
    anchors: [
      { label: "White Light Ray", position: [-1.45, 2.28, 0], focusScenes: [0, 1] },
      { label: "Glass Prism (Refraction)", position: [0, 2.95, 0], focusScenes: [1, 2] },
      { label: "Rainbow Spectrum", position: [1.65, 2.35, 0], focusScenes: [2, 3] },
      { label: "Wave Crest & Wavelength", position: [0.45, 0.98, 1.05], focusScenes: [3, 4] },
    ],
    update: (t) => {
      prism.rotation.y = Math.sin(t * 0.25) * 0.15;
      for (let i = 0; i < posAttr.count; i++) {
        const x = posAttr.getX(i);
        const z = posAttr.getZ(i);
        const y = Math.sin(x * 1.9 + t * 1.05) * 0.19 + Math.cos(z * 1.6 - t * 0.75) * 0.09;
        posAttr.setY(i, y);
      }
      posAttr.needsUpdate = true;
      waveGeo.computeVertexNormals();
    },
  };
}

function createGeometryForPart(shape: Study3DPartSpec["shape"]): THREE.BufferGeometry {
  switch (shape) {
    case "sphere":
      return new THREE.SphereGeometry(0.5, 28, 28);
    case "cylinder":
      return new THREE.CylinderGeometry(0.45, 0.45, 1, 28);
    case "cone":
      return new THREE.ConeGeometry(0.5, 1, 28);
    case "torus":
      return new THREE.TorusGeometry(0.45, 0.14, 16, 40);
    case "capsule":
      return new THREE.CapsuleGeometry(0.32, 0.55, 10, 20);
    case "icosahedron":
      return new THREE.IcosahedronGeometry(0.55, 0);
    case "ring":
      return new THREE.TorusGeometry(0.65, 0.05, 12, 48);
    case "box":
    default:
      return new THREE.BoxGeometry(1, 1, 1);
  }
}

function buildCustomOrArchitecture3D(
  blueprint: Study3DSceneBlueprint,
  aniso: number
): Built3DModel {
  const root = new THREE.Group();
  const metalPbr = createBrushedMetalPbr(aniso);

  // Museum exhibition plinth
  const plinth = new THREE.Mesh(
    new THREE.CylinderGeometry(1.85, 2.05, 0.22, 48),
    new THREE.MeshStandardMaterial({
      color: "#334155",
      bumpMap: metalPbr.bumpMap,
      bumpScale: 0.01,
      roughness: 0.42,
      metalness: 0.55,
    })
  );
  plinth.position.y = 0.11;
  plinth.receiveShadow = true;
  root.add(plinth);

  const animatedNodes: Array<{
    mesh: THREE.Object3D;
    mode: NonNullable<Study3DPartSpec["animate"]>;
    basePos: THREE.Vector3;
    idx: number;
  }> = [];

  if (Array.isArray(blueprint.customParts) && blueprint.customParts.length >= 3) {
    const assembly = new THREE.Group();
    assembly.position.y = 0.24;
    root.add(assembly);

    const anchors: Study3DAnchor[] = [];

    blueprint.customParts.slice(0, 12).forEach((part, idx) => {
      const geo = createGeometryForPart(part.shape);
      const opacity = typeof part.opacity === "number" ? THREE.MathUtils.clamp(part.opacity, 0.15, 1) : 1;
      const mat = new THREE.MeshPhysicalMaterial({
        color: safeHex(part.color, blueprint.primaryColor),
        bumpMap: metalPbr.bumpMap,
        bumpScale: 0.012,
        roughness: typeof part.roughness === "number" ? THREE.MathUtils.clamp(part.roughness, 0.1, 1) : 0.42,
        metalness: typeof part.metalness === "number" ? THREE.MathUtils.clamp(part.metalness, 0, 1) : 0.28,
        emissive: part.emissive ? new THREE.Color(safeHex(part.emissive, "#000000")) : new THREE.Color("#000000"),
        emissiveIntensity: part.emissive ? 0.45 : 0,
        transparent: opacity < 0.99,
        opacity,
        clearcoat: 0.35,
      });
      const mesh = new THREE.Mesh(geo, mat);
      const px = THREE.MathUtils.clamp(part.position?.[0] ?? 0, -3.5, 3.5);
      const py = THREE.MathUtils.clamp(part.position?.[1] ?? 1, 0.1, 4.2);
      const pz = THREE.MathUtils.clamp(part.position?.[2] ?? 0, -3.5, 3.5);
      mesh.position.set(px, py, pz);
      if (part.rotation) {
        mesh.rotation.set(part.rotation[0] || 0, part.rotation[1] || 0, part.rotation[2] || 0);
      }
      mesh.scale.set(
        THREE.MathUtils.clamp(part.scale?.[0] ?? 1, 0.12, 3.5),
        THREE.MathUtils.clamp(part.scale?.[1] ?? 1, 0.12, 3.5),
        THREE.MathUtils.clamp(part.scale?.[2] ?? 1, 0.12, 3.5)
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      assembly.add(mesh);

      if (part.name && anchors.length < 4) {
        anchors.push({
          label: part.name.slice(0, 28),
          position: [px, py + 0.55, pz],
          focusScenes: [idx % 5],
        });
      }

      if (part.animate && part.animate !== "none") {
        animatedNodes.push({
          mesh,
          mode: part.animate,
          basePos: mesh.position.clone(),
          idx,
        });
      }
    });

    return {
      root,
      textures: [metalPbr.map, metalPbr.bumpMap],
      anchors,
      update: (t) => {
        assembly.rotation.y = Math.sin(t * 0.16) * 0.16;
        for (const item of animatedNodes) {
          if (item.mode === "spin") {
            item.mesh.rotation.y = t * 0.35 + item.idx;
          } else if (item.mode === "float") {
            item.mesh.position.y = item.basePos.y + Math.sin(t * 0.8 + item.idx) * 0.08;
          } else if (item.mode === "pulse") {
            const s = 1 + Math.sin(t * 1.1 + item.idx) * 0.05;
            item.mesh.scale.setScalar(s);
          } else if (item.mode === "orbit") {
            const r = Math.max(0.8, Math.hypot(item.basePos.x, item.basePos.z));
            const a = t * 0.32 + item.idx * 1.2;
            item.mesh.position.x = Math.cos(a) * r;
            item.mesh.position.z = Math.sin(a) * r;
          }
        }
      },
    };
  }

  // Physical brass-and-ceramic armillary demonstration sculpture
  const coreGroup = new THREE.Group();
  coreGroup.position.y = 1.9;
  root.add(coreGroup);

  const support = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 0.12, 1.0, 20),
    new THREE.MeshStandardMaterial({ color: "#CA8A04", roughness: 0.25, metalness: 0.9 })
  );
  support.position.y = 0.7;
  root.add(support);

  const corePoly = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.78, 0),
    new THREE.MeshPhysicalMaterial({
      color: safeHex(blueprint.primaryColor, "#2563EB"),
      bumpMap: metalPbr.bumpMap,
      bumpScale: 0.015,
      roughness: 0.24,
      metalness: 0.42,
      clearcoat: 0.85,
    })
  );
  corePoly.castShadow = true;
  coreGroup.add(corePoly);

  const gyroA = new THREE.Mesh(
    new THREE.TorusGeometry(1.30, 0.048, 16, 72),
    new THREE.MeshStandardMaterial({
      map: metalPbr.map,
      color: "#E2E8F0",
      roughness: 0.22,
      metalness: 0.92,
    })
  );
  const gyroB = new THREE.Mesh(
    new THREE.TorusGeometry(1.56, 0.04, 16, 72),
    new THREE.MeshStandardMaterial({
      color: "#CA8A04",
      roughness: 0.24,
      metalness: 0.9,
    })
  );
  gyroB.rotation.x = Math.PI / 2;
  coreGroup.add(gyroA, gyroB);

  const nodes: THREE.Mesh[] = [];
  for (let i = 0; i < 4; i++) {
    const n = new THREE.Mesh(
      new THREE.SphereGeometry(0.15, 22, 22),
      new THREE.MeshPhysicalMaterial({
        color: i % 2 === 0 ? safeHex(blueprint.accentColor, "#38BDF8") : "#D97706",
        roughness: 0.25,
        metalness: 0.6,
        clearcoat: 0.7,
      })
    );
    n.castShadow = true;
    root.add(n);
    nodes.push(n);
  }

  return {
    root,
    textures: [metalPbr.map, metalPbr.bumpMap],
    anchors: [
      { label: "Core Concept Model", position: [0, 2.75, 0], focusScenes: [0, 1] },
      { label: "Connected System Rings", position: [1.45, 2.1, 0], focusScenes: [1, 2, 3] },
    ],
    update: (t) => {
      corePoly.rotation.y = t * 0.20;
      corePoly.rotation.x = t * 0.10;
      gyroA.rotation.x = t * 0.22;
      gyroA.rotation.y = t * 0.14;
      gyroB.rotation.z = -t * 0.16;
      nodes.forEach((n, idx) => {
        const a = t * 0.26 + (idx * Math.PI) / 2;
        n.position.set(Math.cos(a) * 1.88, 1.9 + Math.sin(t * 0.65 + idx) * 0.24, Math.sin(a) * 1.88);
      });
    },
  };
}

function buildModelForBlueprint(
  blueprint: Study3DSceneBlueprint,
  aniso: number
): Built3DModel {
  switch (blueprint.archetype) {
    case "solar":
      return buildSolarSystem3D(aniso);
    case "atom":
      return buildAtom3D(blueprint.primaryColor, blueprint.accentColor, aniso);
    case "dna":
      return buildDna3D(blueprint.primaryColor, blueprint.accentColor, aniso);
    case "heart":
      return buildHeart3D(aniso);
    case "plant":
      return buildPlant3D(aniso);
    case "watercycle":
      return buildWaterCycle3D(aniso);
    case "rocket":
      return buildRocket3D(aniso, blueprint.accentColor);
    case "circuit":
      return buildCircuit3D(aniso, blueprint.accentColor);
    case "earth":
      return buildEarthGlobe3D(aniso);
    case "volcano":
      return buildVolcano3D(aniso);
    case "wave":
      return buildWaveOptics3D(blueprint.primaryColor, aniso);
    case "custom":
    case "architecture":
    default:
      return buildCustomOrArchitecture3D(blueprint, aniso);
  }
}

function disposeObject3D(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) {
      mesh.geometry.dispose();
    }
    if (mesh.material) {
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach((m) => m.dispose());
      } else {
        mesh.material.dispose();
      }
    }
  });
}

// ============================================================================
// Unified Real-Time 3D Studio Engine (Physical PBR + Calm Documentary Camera)
// ============================================================================

export class Study3DViewportEngine {
  public readonly renderer: THREE.WebGLRenderer;
  public readonly scene: THREE.Scene;
  public readonly camera: THREE.PerspectiveCamera;
  public readonly controls: OrbitControls | null;
  public readonly isSoftwareGl: boolean;

  private envTexture: THREE.Texture | null = null;
  private contactShadowTex: THREE.Texture;
  private oakTablePbr: PbrTexturePair;
  private slateLabPbr: PbrTexturePair;
  private floorMesh: THREE.Mesh;
  private floorMat: THREE.MeshStandardMaterial;
  private shadowPlane: THREE.Mesh;
  private keyLight: THREE.DirectionalLight;
  private hemiLight: THREE.HemisphereLight;
  private rimLight: THREE.DirectionalLight;
  private activeModel: Built3DModel | null = null;
  private activeBlueprint: Study3DSceneBlueprint | null = null;
  private cameraTargetPos: THREE.Vector3 | null = null;
  private cinematicCamInit = false;
  private frameId = 0;
  private disposed = false;
  private elapsed = 0;
  private lastTs = 0;
  private autoRotate = true;

  constructor(options: {
    canvas?: HTMLCanvasElement;
    width: number;
    height: number;
    interactive?: boolean;
  }) {
    this.isSoftwareGl = detectSoftwareWebGl();
    this.renderer = new THREE.WebGLRenderer({
      canvas: options.canvas,
      antialias: !this.isSoftwareGl,
      powerPreference: "high-performance",
      preserveDrawingBuffer: true,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.setPixelRatio(
      this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2)
    );
    this.renderer.setSize(options.width, options.height, false);
    this.renderer.shadowMap.enabled = !this.isSoftwareGl;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color("#DCE7F2");
    this.scene.fog = new THREE.FogExp2("#DCE7F2", 0.025);

    // Mandatory Studio PBR Environment Map (RoomEnvironment)
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = this.envTexture;
    pmrem.dispose();

    this.camera = new THREE.PerspectiveCamera(
      38,
      options.width / Math.max(1, options.height),
      0.1,
      80
    );
    this.camera.position.set(4.8, 3.2, 5.4);
    this.camera.lookAt(0, 1.55, 0);

    // Warm Natural Sun/Studio Key + Hemisphere Fill + Crisp Rim Backlight
    this.hemiLight = new THREE.HemisphereLight("#E0F2FE", "#475569", 1.05);
    this.scene.add(this.hemiLight);

    this.keyLight = new THREE.DirectionalLight("#FFF8EB", 2.45);
    this.keyLight.position.set(5.5, 8.8, 5.5);
    this.keyLight.castShadow = !this.isSoftwareGl;
    this.keyLight.shadow.mapSize.set(1024, 1024);
    this.keyLight.shadow.camera.near = 1;
    this.keyLight.shadow.camera.far = 26;
    const d = 5.6;
    this.keyLight.shadow.camera.left = -d;
    this.keyLight.shadow.camera.right = d;
    this.keyLight.shadow.camera.top = d;
    this.keyLight.shadow.camera.bottom = -d;
    this.keyLight.shadow.bias = -0.0004;
    this.keyLight.shadow.normalBias = 0.02;
    this.scene.add(this.keyLight);

    this.rimLight = new THREE.DirectionalLight("#93C5FD", 1.0);
    this.rimLight.position.set(-5.5, 4.5, -5.5);
    this.scene.add(this.rimLight);

    // Realistic physical tabletop surfaces (Oak museum table & Honed slate lab bench)
    const aniso = this.renderer.capabilities.getMaxAnisotropy();
    this.oakTablePbr = createOakTablePbr(aniso);
    this.slateLabPbr = createSlateLabPbr(aniso);

    this.floorMat = new THREE.MeshStandardMaterial({
      map: this.oakTablePbr.map,
      bumpMap: this.oakTablePbr.bumpMap,
      bumpScale: 0.018,
      roughnessMap: this.oakTablePbr.roughnessMap,
      roughness: 0.85,
      metalness: 0.04,
    });
    this.floorMesh = new THREE.Mesh(
      new THREE.CircleGeometry(14, 64),
      this.floorMat
    );
    this.floorMesh.rotation.x = -Math.PI / 2;
    this.floorMesh.position.y = -0.015;
    this.floorMesh.receiveShadow = true;
    this.scene.add(this.floorMesh);

    this.contactShadowTex = createContactShadowTexture();
    this.shadowPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(5.8, 5.8),
      new THREE.MeshBasicMaterial({
        map: this.contactShadowTex,
        transparent: true,
        opacity: 0.52,
        depthWrite: false,
      })
    );
    this.shadowPlane.rotation.x = -Math.PI / 2;
    this.shadowPlane.position.y = 0.002;
    this.scene.add(this.shadowPlane);

    if (options.interactive) {
      const controls = new OrbitControls(this.camera, this.renderer.domElement);
      controls.target.set(0, 1.55, 0);
      controls.enableDamping = !this.isSoftwareGl;
      controls.dampingFactor = 0.06;
      controls.minDistance = 2.6;
      controls.maxDistance = 13.5;
      controls.maxPolarAngle = Math.PI * 0.49;
      controls.autoRotate = !this.isSoftwareGl;
      controls.autoRotateSpeed = 0.55; // Calm natural museum turntable speed
      controls.addEventListener("start", () => {
        this.cameraTargetPos = null;
      });
      controls.update();
      this.controls = controls;
    } else {
      this.controls = null;
    }
  }

  public get domElement(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  public resize(width: number, height: number): void {
    if (this.disposed || width < 10 || height < 10) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  public setLightingPreset(preset: LightingPreset): void {
    if (preset === "daylight") {
      this.scene.background = new THREE.Color("#D8ECFA");
      this.scene.fog = new THREE.FogExp2("#D8ECFA", 0.022);
      this.keyLight.color.set("#FFFBEB");
      this.keyLight.intensity = 2.6;
      this.hemiLight.color.set("#FFFFFF");
      this.hemiLight.groundColor.set("#94A3B8");
      this.hemiLight.intensity = 1.15;
      this.rimLight.color.set("#7DD3FC");
      this.rimLight.intensity = 0.85;
    } else if (preset === "dramatic") {
      this.scene.background = new THREE.Color("#0B1120");
      this.scene.fog = new THREE.FogExp2("#0B1120", 0.042);
      this.keyLight.color.set("#FDE68A");
      this.keyLight.intensity = 2.8;
      this.hemiLight.color.set("#7DD3FC");
      this.hemiLight.groundColor.set("#1E293B");
      this.hemiLight.intensity = 0.65;
      this.rimLight.color.set("#60A5FA");
      this.rimLight.intensity = 1.45;
    } else {
      this.applyEnvironmentBackground(this.activeBlueprint?.environment || "studio");
    }
  }

  private applyEnvironmentBackground(env: Study3DEnvironment): void {
    switch (env) {
      case "space":
        this.scene.background = new THREE.Color("#060B18");
        this.scene.fog = new THREE.FogExp2("#060B18", 0.018);
        this.keyLight.color.set("#FFF7ED");
        this.keyLight.intensity = 2.35;
        this.hemiLight.color.set("#93C5FD");
        this.hemiLight.groundColor.set("#0F172A");
        this.hemiLight.intensity = 0.72;
        this.rimLight.color.set("#60A5FA");
        this.rimLight.intensity = 1.25;
        this.floorMesh.visible = false;
        this.shadowPlane.visible = false;
        break;
      case "outdoor":
        // Bright natural daylight physical sky + warm oak diorama tabletop
        this.scene.background = new THREE.Color("#CFE6F8");
        this.scene.fog = new THREE.FogExp2("#CFE6F8", 0.022);
        this.keyLight.color.set("#FFFBEB");
        this.keyLight.intensity = 2.55;
        this.hemiLight.color.set("#F0F9FF");
        this.hemiLight.groundColor.set("#78716C");
        this.hemiLight.intensity = 1.15;
        this.rimLight.color.set("#FEF08A");
        this.rimLight.intensity = 0.75;
        this.floorMesh.visible = true;
        this.shadowPlane.visible = true;
        this.floorMat.map = this.oakTablePbr.map;
        this.floorMat.bumpMap = this.oakTablePbr.bumpMap;
        this.floorMat.roughnessMap = this.oakTablePbr.roughnessMap || null;
        this.floorMat.color.set("#FFFFFF");
        this.floorMat.needsUpdate = true;
        break;
      case "sunset":
        // Warm geological documentary twilight + honed slate bench
        this.scene.background = new THREE.Color("#2A1D24");
        this.scene.fog = new THREE.FogExp2("#2A1D24", 0.03);
        this.keyLight.color.set("#FDBA74");
        this.keyLight.intensity = 2.45;
        this.hemiLight.color.set("#FED7AA");
        this.hemiLight.groundColor.set("#292524");
        this.hemiLight.intensity = 0.9;
        this.rimLight.color.set("#FB923C");
        this.rimLight.intensity = 1.3;
        this.floorMesh.visible = true;
        this.shadowPlane.visible = true;
        this.floorMat.map = this.slateLabPbr.map;
        this.floorMat.bumpMap = this.slateLabPbr.bumpMap;
        this.floorMat.roughnessMap = null;
        this.floorMat.color.set("#D6D3D1");
        this.floorMat.needsUpdate = true;
        break;
      case "lab":
        // Clean natural science lab daylight backdrop + honed slate workbench
        this.scene.background = new THREE.Color("#1E293B");
        this.scene.fog = new THREE.FogExp2("#1E293B", 0.028);
        this.keyLight.color.set("#FFFDF7");
        this.keyLight.intensity = 2.5;
        this.hemiLight.color.set("#E0F2FE");
        this.hemiLight.groundColor.set("#334155");
        this.hemiLight.intensity = 1.05;
        this.rimLight.color.set("#7DD3FC");
        this.rimLight.intensity = 1.1;
        this.floorMesh.visible = true;
        this.shadowPlane.visible = true;
        this.floorMat.map = this.slateLabPbr.map;
        this.floorMat.bumpMap = this.slateLabPbr.bumpMap;
        this.floorMat.roughnessMap = null;
        this.floorMat.color.set("#E2E8F0");
        this.floorMat.needsUpdate = true;
        break;
      case "studio":
      default:
        // Bright physical museum studio + warm oak workbench
        this.scene.background = new THREE.Color("#D8E3EE");
        this.scene.fog = new THREE.FogExp2("#D8E3EE", 0.024);
        this.keyLight.color.set("#FFFBEB");
        this.keyLight.intensity = 2.5;
        this.hemiLight.color.set("#FFFFFF");
        this.hemiLight.groundColor.set("#78716C");
        this.hemiLight.intensity = 1.1;
        this.rimLight.color.set("#BAE6FD");
        this.rimLight.intensity = 0.85;
        this.floorMesh.visible = true;
        this.shadowPlane.visible = true;
        this.floorMat.map = this.oakTablePbr.map;
        this.floorMat.bumpMap = this.oakTablePbr.bumpMap;
        this.floorMat.roughnessMap = this.oakTablePbr.roughnessMap || null;
        this.floorMat.color.set("#FFFFFF");
        this.floorMat.needsUpdate = true;
        break;
    }
  }

  public setCameraPreset(preset: CameraPreset): void {
    switch (preset) {
      case "closeup":
        this.cameraTargetPos = new THREE.Vector3(3.0, 2.2, 3.5);
        break;
      case "top":
        this.cameraTargetPos = new THREE.Vector3(0.4, 7.6, 2.5);
        break;
      case "side":
        this.cameraTargetPos = new THREE.Vector3(6.6, 1.95, 0.3);
        break;
      case "hero":
      default:
        this.cameraTargetPos = new THREE.Vector3(4.8, 3.2, 5.4);
        break;
    }
  }

  public setAutoRotate(enabled: boolean): void {
    this.autoRotate = enabled;
    if (this.controls) {
      this.controls.autoRotate = enabled && !this.isSoftwareGl;
    }
  }

  public loadBlueprint(blueprint: Study3DSceneBlueprint): void {
    if (this.disposed) return;
    if (this.activeModel) {
      this.scene.remove(this.activeModel.root);
      disposeObject3D(this.activeModel.root);
      this.activeModel.textures.forEach((t) => t.dispose());
      this.activeModel = null;
    }

    this.activeBlueprint = blueprint;
    this.cinematicCamInit = false;
    this.applyEnvironmentBackground(blueprint.environment);

    const aniso = this.renderer.capabilities.getMaxAnisotropy();
    this.activeModel = buildModelForBlueprint(blueprint, aniso);
    this.scene.add(this.activeModel.root);

    if (blueprint.archetype === "solar") {
      this.camera.position.set(6.4, 4.4, 7.0);
    } else {
      this.camera.position.set(4.8, 3.2, 5.4);
    }
    if (this.controls) {
      this.controls.target.set(0, 1.55, 0);
      this.controls.update();
    } else {
      this.camera.lookAt(0, 1.55, 0);
    }
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Calm, smoothly damped documentary camera renderer for 3D Study Videos & .webm export.
   * No fast spins or jarring jump cuts between teaching steps.
   */
  public renderCinematicFrame(
    timeSec: number,
    sceneIndex: number,
    sceneProgress: number,
    dt = 0.033
  ): void {
    if (this.disposed) return;
    this.activeModel?.update(timeSec);

    const baseDist = this.activeBlueprint?.archetype === "solar" ? 8.2 : 5.75;
    const step = sceneIndex % 5;

    // Gentle documentary camera angles — slow smooth drift (~0.075 rad/s), steady framing
    let goalAngle = 0.55 + timeSec * 0.075;
    let goalRadius = baseDist;
    let goalHeight = 2.75;

    if (step === 0) {
      // Step 1: Calm establishing wide view ("What Is It?")
      goalAngle = 0.45 + timeSec * 0.07;
      goalRadius = baseDist * 1.02 - sceneProgress * 0.35;
      goalHeight = 2.85;
    } else if (step === 1) {
      // Step 2: Steady three-quarter inspection ("Look at the Main Parts")
      goalAngle = 1.05 + timeSec * 0.07;
      goalRadius = baseDist * 0.86;
      goalHeight = 2.45;
    } else if (step === 2) {
      // Step 3: Slightly elevated clear overview ("How It Works Step by Step")
      goalAngle = 1.65 + timeSec * 0.07;
      goalRadius = baseDist * 0.92;
      goalHeight = 3.55;
    } else if (step === 3) {
      // Step 4: Gentle closer detail angle ("Real-Life Example")
      goalAngle = 2.25 + timeSec * 0.07;
      goalRadius = baseDist * 0.84;
      goalHeight = 2.25;
    } else {
      // Step 5: Calm full-model recap view ("Easy Way to Remember")
      goalAngle = 0.65 + timeSec * 0.065;
      goalRadius = baseDist * 0.98;
      goalHeight = 2.95;
    }

    _camGoalVec.set(
      Math.cos(goalAngle) * goalRadius,
      goalHeight,
      Math.sin(goalAngle) * goalRadius
    );

    if (!this.cinematicCamInit) {
      this.camera.position.copy(_camGoalVec);
      this.cinematicCamInit = true;
    } else {
      const safeDt = Math.min(0.1, Math.max(0.008, dt));
      this.camera.position.x = THREE.MathUtils.damp(this.camera.position.x, _camGoalVec.x, 2.6, safeDt);
      this.camera.position.y = THREE.MathUtils.damp(this.camera.position.y, _camGoalVec.y, 2.6, safeDt);
      this.camera.position.z = THREE.MathUtils.damp(this.camera.position.z, _camGoalVec.z, 2.6, safeDt);
    }

    // Offset look-at slightly left so the physical 3D subject sits prominently on the bright right ~64% of the video
    _targetVec.set(-1.12, 1.52, 0);
    this.camera.lookAt(_targetVec);
    this.camera.updateMatrixWorld();
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Projects real 3D physical part anchor coordinates into 2D canvas coordinates
   * so the video overlay can point clearly to actual physical parts of the 3D model.
   */
  public getProjectedLabels(
    canvasWidth: number,
    canvasHeight: number,
    sceneIndex: number
  ): Study3DProjectedLabel[] {
    if (this.disposed || !this.activeModel || !this.activeModel.anchors.length) {
      return [];
    }
    const results: Study3DProjectedLabel[] = [];
    for (const anchor of this.activeModel.anchors) {
      _projVec.set(anchor.position[0], anchor.position[1], anchor.position[2]);
      _projVec.project(this.camera);
      const visible = _projVec.z >= -1 && _projVec.z <= 1;
      const x = (_projVec.x * 0.5 + 0.5) * canvasWidth;
      const y = (-_projVec.y * 0.5 + 0.5) * canvasHeight;
      const highlight =
        !anchor.focusScenes ||
        anchor.focusScenes.length === 0 ||
        anchor.focusScenes.includes(sceneIndex);
      results.push({
        label: anchor.label,
        x,
        y,
        visible,
        highlight,
      });
    }
    return results;
  }

  public startLoop(): void {
    if (this.disposed || this.frameId) return;
    this.lastTs = performance.now();

    const afterDraw = (cb: () => void) => {
      if (this.disposed) return;
      const gl = this.renderer.getContext() as WebGL2RenderingContext;
      if (typeof gl.fenceSync === "function") {
        const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        gl.flush();
        const poll = () => {
          if (this.disposed) return;
          const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
          if (state === gl.UNSIGNALED) {
            this.frameId = window.setTimeout(poll, 8);
          } else {
            if (sync) gl.deleteSync(sync);
            this.frameId = window.setTimeout(cb, 80);
          }
        };
        this.frameId = window.setTimeout(poll, 8);
      } else {
        this.frameId = window.setTimeout(cb, 90);
      }
    };

    const tick = () => {
      if (this.disposed) return;
      const now = performance.now();
      const dt = Math.min(0.08, (now - this.lastTs) / 1000);
      this.lastTs = now;
      this.elapsed += dt;

      this.activeModel?.update(this.elapsed);

      if (this.cameraTargetPos) {
        this.camera.position.x = THREE.MathUtils.damp(
          this.camera.position.x,
          this.cameraTargetPos.x,
          5,
          dt
        );
        this.camera.position.y = THREE.MathUtils.damp(
          this.camera.position.y,
          this.cameraTargetPos.y,
          5,
          dt
        );
        this.camera.position.z = THREE.MathUtils.damp(
          this.camera.position.z,
          this.cameraTargetPos.z,
          5,
          dt
        );
        if (this.camera.position.distanceTo(this.cameraTargetPos) < 0.04) {
          this.cameraTargetPos = null;
        }
      }

      if (this.controls) {
        this.controls.update();
      } else if (this.autoRotate) {
        const r = Math.hypot(this.camera.position.x, this.camera.position.z);
        const a = Math.atan2(this.camera.position.z, this.camera.position.x) + dt * 0.14;
        this.camera.position.x = Math.cos(a) * r;
        this.camera.position.z = Math.sin(a) * r;
        this.camera.lookAt(0, 1.55, 0);
      }

      this.renderer.render(this.scene, this.camera);

      if (this.isSoftwareGl) {
        afterDraw(tick);
      } else {
        this.frameId = window.requestAnimationFrame(tick);
      }
    };

    if (this.isSoftwareGl) {
      tick();
    } else {
      this.frameId = window.requestAnimationFrame(tick);
    }
  }

  public stopLoop(): void {
    if (this.frameId) {
      window.cancelAnimationFrame(this.frameId);
      window.clearTimeout(this.frameId);
      this.frameId = 0;
    }
  }

  public capturePngDataUrl(titleOverlay?: string): string {
    if (this.disposed) return "";
    this.renderer.render(this.scene, this.camera);
    const glCanvas = this.renderer.domElement;

    const out = document.createElement("canvas");
    out.width = 1600;
    out.height = 1000;
    const ctx = out.getContext("2d");
    if (!ctx) return glCanvas.toDataURL("image/png");

    ctx.drawImage(glCanvas, 0, 0, out.width, out.height);

    if (titleOverlay) {
      const grad = ctx.createLinearGradient(0, out.height - 120, 0, out.height);
      grad.addColorStop(0, "rgba(2, 6, 23, 0)");
      grad.addColorStop(1, "rgba(2, 6, 23, 0.82)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, out.height - 120, out.width, 120);

      ctx.fillStyle = "#FFFFFF";
      ctx.font = "700 32px system-ui, -apple-system, sans-serif";
      ctx.fillText(titleOverlay.slice(0, 68), 36, out.height - 46);
      ctx.fillStyle = "#CBD5E1";
      ctx.font = "500 18px system-ui, -apple-system, sans-serif";
      ctx.fillText("Jogi Jarvis · Physical 3D Study Model", 36, out.height - 18);
    }

    return out.toDataURL("image/png");
  }

  public dispose(): void {
    this.disposed = true;
    this.stopLoop();
    if (this.controls) {
      this.controls.dispose();
    }
    if (this.activeModel) {
      this.scene.remove(this.activeModel.root);
      disposeObject3D(this.activeModel.root);
      this.activeModel.textures.forEach((t) => t.dispose());
      this.activeModel = null;
    }
    this.envTexture?.dispose();
    this.contactShadowTex.dispose();
    this.oakTablePbr.map.dispose();
    this.oakTablePbr.bumpMap.dispose();
    this.oakTablePbr.roughnessMap?.dispose();
    this.slateLabPbr.map.dispose();
    this.slateLabPbr.bumpMap.dispose();
    disposeObject3D(this.scene);
    this.renderer.dispose();
  }
}
