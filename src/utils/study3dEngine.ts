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

const _targetVec = new THREE.Vector3();
const _camGoalVec = new THREE.Vector3();

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
    primaryColor = "#06B6D4";
    secondaryAccent = "#EC4899";
  } else if (/(heart|blood|circulat|artery|vein|organ|anatomy|human body|lung|brain|digest)/i.test(hay)) {
    archetype = "heart";
    environment = "lab";
    primaryColor = "#DC2626";
    secondaryAccent = "#3B82F6";
  } else if (/(photosynthesis|plant|leaf|tree|flower|forest|botany|chlorophyll|ecosystem|root|nature)/i.test(hay)) {
    archetype = "plant";
    environment = "outdoor";
    primaryColor = "#10B981";
    secondaryAccent = "#FBBF24";
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
    environment = "space";
    primaryColor = "#E2E8F0";
    secondaryAccent = "#F97316";
  } else if (/(circuit|electric|ohm|voltage|chip|cpu|computer|robot|ai|machine|code|microchip|battery|electronics)/i.test(hay)) {
    archetype = "circuit";
    environment = "lab";
    primaryColor = "#10B981";
    secondaryAccent = "#38BDF8";
  } else if (/(atom|electron|proton|neutron|molecule|chemistry|periodic|nuclear|quantum|bond|h2o)/i.test(hay)) {
    archetype = "atom";
    environment = "lab";
    primaryColor = "#6366F1";
    secondaryAccent = "#22D3EE";
  } else if (/(earth|globe|world|continent|geography|map|history|civilization|india|latitude|longitude)/i.test(hay)) {
    archetype = "earth";
    environment = "space";
    primaryColor = "#2563EB";
    secondaryAccent = "#10B981";
  } else if (/(wave|sound|light|prism|optics|spectrum|rainbow|frequency|music|electromagnetic|math|sine|geometry)/i.test(hay)) {
    archetype = "wave";
    environment = "studio";
    primaryColor = "#8B5CF6";
    secondaryAccent = "#06B6D4";
  }

  return {
    archetype,
    environment,
    primaryColor,
    accentColor: secondaryAccent,
    title: title || "3D Real Visual",
    subtitle: subject || "Interactive 3D PBR Studio",
  };
}

// ============================================================================
// Procedural PBR Textures (100% zero external URLs / zero 404s)
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
  if (isColor) {
    tex.colorSpace = THREE.SRGBColorSpace;
  }
  tex.anisotropy = Math.min(8, Math.max(1, maxAnisotropy));
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

function createEarthTexture(aniso: number): THREE.CanvasTexture {
  return makeCanvasTexture(
    1024,
    512,
    (ctx, w, h) => {
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, "#0A3A7A");
      grad.addColorStop(0.5, "#0B5EA8");
      grad.addColorStop(1, "#08306B");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      // Subtle ocean depth variations
      for (let i = 0; i < 65; i++) {
        const x = (i * 173) % w;
        const y = (i * 97) % h;
        const r = 24 + (i % 55);
        const rg = ctx.createRadialGradient(x, y, 2, x, y, r);
        rg.addColorStop(0, "rgba(56, 189, 248, 0.16)");
        rg.addColorStop(1, "rgba(14, 116, 144, 0)");
        ctx.fillStyle = rg;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }

      // Stylized realistic landmasses
      const continents: Array<Array<[number, number]>> = [
        // Americas
        [[0.16, 0.22], [0.26, 0.19], [0.3, 0.34], [0.24, 0.48], [0.32, 0.56], [0.35, 0.72], [0.28, 0.84], [0.23, 0.65], [0.18, 0.45], [0.12, 0.32]],
        // Europe + Africa
        [[0.46, 0.2], [0.56, 0.18], [0.59, 0.32], [0.54, 0.4], [0.61, 0.52], [0.57, 0.76], [0.5, 0.78], [0.45, 0.56], [0.43, 0.36]],
        // Asia + India
        [[0.58, 0.17], [0.78, 0.19], [0.85, 0.34], [0.78, 0.48], [0.71, 0.56], [0.66, 0.47], [0.6, 0.38]],
        // Australia
        [[0.77, 0.63], [0.87, 0.62], [0.89, 0.74], [0.8, 0.77], [0.75, 0.7]],
      ];

      for (const poly of continents) {
        ctx.beginPath();
        poly.forEach(([px, py], idx) => {
          if (idx === 0) ctx.moveTo(px * w, py * h);
          else ctx.lineTo(px * w, py * h);
        });
        ctx.closePath();
        const landGrad = ctx.createLinearGradient(0, h * 0.15, 0, h * 0.85);
        landGrad.addColorStop(0, "#3F7D4C");
        landGrad.addColorStop(0.45, "#2E8B57");
        landGrad.addColorStop(0.65, "#C2A15F");
        landGrad.addColorStop(1, "#4E8D5B");
        ctx.fillStyle = landGrad;
        ctx.fill();
        ctx.strokeStyle = "rgba(187, 247, 208, 0.35)";
        ctx.lineWidth = 3;
        ctx.stroke();
      }

      // Polar ice caps
      ctx.fillStyle = "rgba(241, 245, 249, 0.92)";
      ctx.fillRect(0, 0, w, 26);
      ctx.fillRect(0, h - 24, w, 24);
    },
    aniso
  );
}

function createCloudsTexture(aniso: number): THREE.CanvasTexture {
  return makeCanvasTexture(
    512,
    256,
    (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      for (let i = 0; i < 85; i++) {
        const x = (i * 137) % w;
        const y = 26 + ((i * 71) % (h - 52));
        const rx = 18 + (i % 42);
        const ry = 7 + (i % 14);
        const grad = ctx.createRadialGradient(x, y, 1, x, y, rx);
        grad.addColorStop(0, "rgba(255,255,255,0.68)");
        grad.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.ellipse(x, y, rx, ry, (i % 5) * 0.12, 0, Math.PI * 2);
        ctx.fill();
      }
    },
    aniso
  );
}

function createBandedPlanetTexture(
  baseHex: string,
  bandHex: string,
  highlightHex: string,
  aniso: number
): THREE.CanvasTexture {
  return makeCanvasTexture(
    512,
    256,
    (ctx, w, h) => {
      ctx.fillStyle = baseHex;
      ctx.fillRect(0, 0, w, h);
      for (let y = 0; y < h; y += 6) {
        const wave = Math.sin(y * 0.14) * 0.5 + 0.5;
        ctx.fillStyle = wave > 0.55 ? bandHex : highlightHex;
        ctx.globalAlpha = 0.25 + wave * 0.35;
        ctx.fillRect(0, y, w, 4 + (y % 5));
      }
      ctx.globalAlpha = 1;
    },
    aniso
  );
}

function createSunPlasmaTexture(aniso: number): THREE.CanvasTexture {
  return makeCanvasTexture(
    512,
    256,
    (ctx, w, h) => {
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, "#FDE047");
      grad.addColorStop(0.5, "#F97316");
      grad.addColorStop(1, "#EA580C");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 120; i++) {
        const x = (i * 151) % w;
        const y = (i * 89) % h;
        const r = 8 + (i % 26);
        const rg = ctx.createRadialGradient(x, y, 1, x, y, r);
        rg.addColorStop(0, i % 2 === 0 ? "rgba(255,251,235,0.85)" : "rgba(220,38,38,0.55)");
        rg.addColorStop(1, "rgba(249,115,22,0)");
        ctx.fillStyle = rg;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    },
    aniso
  );
}

function createCircuitPcbTexture(aniso: number): THREE.CanvasTexture {
  return makeCanvasTexture(
    512,
    512,
    (ctx, w, h) => {
      ctx.fillStyle = "#064E3B";
      ctx.fillRect(0, 0, w, h);

      // Fine copper grid
      ctx.strokeStyle = "rgba(16, 185, 129, 0.18)";
      ctx.lineWidth = 1;
      for (let i = 0; i < w; i += 16) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i, h);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, i);
        ctx.lineTo(w, i);
        ctx.stroke();
      }

      // Gold bus traces
      ctx.strokeStyle = "#F59E0B";
      ctx.lineWidth = 3;
      for (let i = 0; i < 18; i++) {
        const y = 32 + i * 26;
        ctx.beginPath();
        ctx.moveTo(20, y);
        ctx.lineTo(140 + (i % 4) * 28, y);
        ctx.lineTo(180 + (i % 4) * 28, y + (i % 2 === 0 ? 18 : -18));
        ctx.lineTo(w - 20, y + (i % 2 === 0 ? 18 : -18));
        ctx.stroke();

        // Solder vias
        ctx.fillStyle = "#FDE68A";
        ctx.beginPath();
        ctx.arc(140 + (i % 4) * 28, y, 4.5, 0, Math.PI * 2);
        ctx.fill();
      }
    },
    aniso
  );
}

function createLeafTexture(aniso: number): THREE.CanvasTexture {
  return makeCanvasTexture(
    256,
    512,
    (ctx, w, h) => {
      const grad = ctx.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, "#15803D");
      grad.addColorStop(0.5, "#16A34A");
      grad.addColorStop(1, "#22C55E");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      ctx.strokeStyle = "rgba(187, 247, 208, 0.55)";
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(w / 2, 0);
      ctx.lineTo(w / 2, h);
      ctx.stroke();

      ctx.lineWidth = 2.5;
      for (let y = 32; y < h; y += 36) {
        ctx.beginPath();
        ctx.moveTo(w / 2, y);
        ctx.lineTo(16, y - 28);
        ctx.moveTo(w / 2, y);
        ctx.lineTo(w - 16, y - 28);
        ctx.stroke();
      }
    },
    aniso
  );
}

function createBrushedMetalTexture(aniso: number): THREE.CanvasTexture {
  return makeCanvasTexture(
    256,
    256,
    (ctx, w, h) => {
      ctx.fillStyle = "#CBD5E1";
      ctx.fillRect(0, 0, w, h);
      for (let y = 0; y < h; y += 2) {
        const v = 185 + ((y * 37) % 48);
        ctx.fillStyle = `rgb(${v},${v + 4},${v + 10})`;
        ctx.fillRect(0, y, w, 1.5);
      }
      ctx.strokeStyle = "rgba(51, 65, 85, 0.35)";
      ctx.lineWidth = 2;
      ctx.strokeRect(4, 4, w - 8, h - 8);
    },
    aniso
  );
}

function createContactShadowTexture(): THREE.CanvasTexture {
  return makeCanvasTexture(
    256,
    256,
    (ctx, w, h) => {
      const grad = ctx.createRadialGradient(
        w / 2,
        h / 2,
        6,
        w / 2,
        h / 2,
        w / 2
      );
      grad.addColorStop(0, "rgba(2, 6, 23, 0.55)");
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
// Composite 3-12 Part PBR 3D Model Builders
// ============================================================================

interface Built3DModel {
  root: THREE.Group;
  update: (timeSec: number) => void;
  textures: THREE.Texture[];
}

function buildSolarSystem3D(aniso: number): Built3DModel {
  const root = new THREE.Group();
  const textures: THREE.Texture[] = [];

  const sunTex = createSunPlasmaTexture(aniso);
  const earthTex = createEarthTexture(aniso);
  const marsTex = createBandedPlanetTexture("#B45309", "#DC2626", "#F59E0B", aniso);
  const jupTex = createBandedPlanetTexture("#D97706", "#92400E", "#FEF3C7", aniso);
  const satTex = createBandedPlanetTexture("#EAB308", "#CA8A04", "#FEF9C3", aniso);
  textures.push(sunTex, earthTex, marsTex, jupTex, satTex);

  // Glowing Sun + translucent solar corona
  const sun = new THREE.Mesh(
    new THREE.SphereGeometry(0.95, 40, 40),
    new THREE.MeshStandardMaterial({
      map: sunTex,
      emissive: new THREE.Color("#F97316"),
      emissiveIntensity: 1.4,
      roughness: 0.35,
      metalness: 0.05,
    })
  );
  sun.position.y = 1.6;
  root.add(sun);

  const corona = new THREE.Mesh(
    new THREE.SphereGeometry(1.16, 32, 32),
    new THREE.MeshBasicMaterial({
      color: "#FBBF24",
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
    })
  );
  corona.position.y = 1.6;
  root.add(corona);

  const sunLight = new THREE.PointLight("#FDE68A", 14, 18, 1.5);
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
    { r: 1.65, size: 0.16, speed: 1.45, color: "#94A3B8", tex: null, ring: false, moon: false },
    { r: 2.35, size: 0.29, speed: 0.92, color: "#3B82F6", tex: earthTex, ring: false, moon: true },
    { r: 3.05, size: 0.22, speed: 0.72, color: "#EA580C", tex: marsTex, ring: false, moon: false },
    { r: 3.9, size: 0.44, speed: 0.48, color: "#D97706", tex: jupTex, ring: false, moon: false },
    { r: 4.85, size: 0.36, speed: 0.35, color: "#EAB308", tex: satTex, ring: true, moon: false },
  ];

  planetSpecs.forEach((p, idx) => {
    const track = new THREE.Mesh(
      new THREE.TorusGeometry(p.r, 0.012, 12, 96),
      new THREE.MeshStandardMaterial({
        color: "#64748B",
        emissive: "#38BDF8",
        emissiveIntensity: 0.3,
        roughness: 0.6,
        metalness: 0.4,
      })
    );
    track.rotation.x = Math.PI / 2;
    track.position.y = 1.6;
    root.add(track);

    const pivot = new THREE.Group();
    pivot.position.y = 1.6;
    pivot.rotation.y = idx * 1.3;
    root.add(pivot);

    const planetGroup = new THREE.Group();
    planetGroup.position.x = p.r;
    pivot.add(planetGroup);

    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(p.size, 32, 32),
      new THREE.MeshStandardMaterial({
        color: p.tex ? "#FFFFFF" : p.color,
        map: p.tex || undefined,
        roughness: p.tex === earthTex ? 0.42 : 0.68,
        metalness: 0.12,
      })
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    planetGroup.add(mesh);

    if (p.ring) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(p.size * 1.35, p.size * 2.25, 48),
        new THREE.MeshStandardMaterial({
          color: "#FDE68A",
          roughness: 0.45,
          metalness: 0.2,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.85,
        })
      );
      ring.rotation.x = Math.PI * 0.38;
      planetGroup.add(ring);
    }

    if (p.moon) {
      const moon = new THREE.Mesh(
        new THREE.SphereGeometry(0.08, 16, 16),
        new THREE.MeshStandardMaterial({ color: "#CBD5E1", roughness: 0.85, metalness: 0.05 })
      );
      moon.position.set(0.5, 0.1, 0);
      planetGroup.add(moon);
    }

    orbits.push({ pivot, mesh: planetGroup, speed: p.speed, spin: 0.9 + idx * 0.18 });
  });

  // Instanced starfield
  const starCount = 220;
  const starGeo = new THREE.SphereGeometry(0.032, 6, 6);
  const starMat = new THREE.MeshBasicMaterial({ color: "#F8FAFC" });
  const stars = new THREE.InstancedMesh(starGeo, starMat, starCount);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < starCount; i++) {
    const theta = (i * 2.39996) % (Math.PI * 2);
    const phi = Math.acos(1 - (2 * (i + 0.5)) / starCount);
    const dist = 8.5 + (i % 7) * 0.7;
    dummy.position.set(
      dist * Math.sin(phi) * Math.cos(theta),
      1.5 + dist * Math.cos(phi) * 0.65,
      dist * Math.sin(phi) * Math.sin(theta)
    );
    const s = 0.6 + (i % 5) * 0.28;
    dummy.scale.setScalar(s);
    dummy.updateMatrix();
    stars.setMatrixAt(i, dummy.matrix);
  }
  stars.computeBoundingSphere();
  root.add(stars);

  return {
    root,
    textures,
    update: (t) => {
      sun.rotation.y = t * 0.28;
      corona.scale.setScalar(1 + Math.sin(t * 2.2) * 0.04);
      for (const o of orbits) {
        o.pivot.rotation.y = t * o.speed * 0.55;
        o.mesh.rotation.y = t * o.spin;
      }
    },
  };
}

function buildAtom3D(primaryColor: string, accentColor: string): Built3DModel {
  const root = new THREE.Group();

  // Brushed lab pedestal base
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(1.45, 1.7, 0.24, 48),
    new THREE.MeshStandardMaterial({ color: "#1E293B", roughness: 0.35, metalness: 0.85 })
  );
  base.position.y = 0.12;
  base.receiveShadow = true;
  root.add(base);

  const baseRing = new THREE.Mesh(
    new THREE.TorusGeometry(1.48, 0.035, 16, 64),
    new THREE.MeshStandardMaterial({
      color: accentColor,
      emissive: accentColor,
      emissiveIntensity: 0.75,
      roughness: 0.2,
      metalness: 0.6,
    })
  );
  baseRing.rotation.x = Math.PI / 2;
  baseRing.position.y = 0.25;
  root.add(baseRing);

  const nucleus = new THREE.Group();
  nucleus.position.y = 1.95;
  root.add(nucleus);

  const protonMat = new THREE.MeshPhysicalMaterial({
    color: "#EF4444",
    emissive: "#991B1B",
    emissiveIntensity: 0.35,
    roughness: 0.22,
    metalness: 0.25,
    clearcoat: 0.8,
  });
  const neutronMat = new THREE.MeshPhysicalMaterial({
    color: primaryColor,
    roughness: 0.48,
    metalness: 0.55,
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
      new THREE.SphereGeometry(0.26, 24, 24),
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
    shell.position.y = 1.95;
    shell.rotation.set(rot[0], rot[1], rot[2]);
    root.add(shell);

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(1.75 + idx * 0.2, 0.025, 16, 96),
      new THREE.MeshStandardMaterial({
        color: accentColor,
        emissive: accentColor,
        emissiveIntensity: 0.45,
        roughness: 0.2,
        metalness: 0.85,
      })
    );
    shell.add(ring);

    const ePivot = new THREE.Group();
    shell.add(ePivot);
    for (let j = 0; j < 2; j++) {
      const electron = new THREE.Mesh(
        new THREE.SphereGeometry(0.13, 20, 20),
        new THREE.MeshStandardMaterial({
          color: "#E0F2FE",
          emissive: "#38BDF8",
          emissiveIntensity: 1.5,
          roughness: 0.1,
          metalness: 0.2,
        })
      );
      const angle = j * Math.PI;
      const rad = 1.75 + idx * 0.2;
      electron.position.set(Math.cos(angle) * rad, Math.sin(angle) * rad, 0);
      ePivot.add(electron);
    }
    electronPivots.push({ pivot: ePivot, speed: 1.4 + idx * 0.45 });
  });

  return {
    root,
    textures: [],
    update: (t) => {
      nucleus.rotation.y = t * 0.65;
      nucleus.rotation.x = Math.sin(t * 0.7) * 0.25;
      for (const ep of electronPivots) {
        ep.pivot.rotation.z = t * ep.speed;
      }
    },
  };
}

function buildDna3D(primaryColor: string, accentColor: string): Built3DModel {
  const root = new THREE.Group();
  const helixGroup = new THREE.Group();
  helixGroup.position.y = 0.25;
  root.add(helixGroup);

  const turns = 2.2;
  const height = 3.6;
  const radius = 0.82;
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
    roughness: 0.25,
    metalness: 0.4,
    clearcoat: 0.8,
  });
  const strandMatB = new THREE.MeshPhysicalMaterial({
    color: accentColor,
    roughness: 0.25,
    metalness: 0.4,
    clearcoat: 0.8,
  });

  const tubeA = new THREE.Mesh(
    new THREE.TubeGeometry(new THREE.CatmullRomCurve3(ptsA), 72, 0.085, 16, false),
    strandMatA
  );
  tubeA.castShadow = true;
  const tubeB = new THREE.Mesh(
    new THREE.TubeGeometry(new THREE.CatmullRomCurve3(ptsB), 72, 0.085, 16, false),
    strandMatB
  );
  tubeB.castShadow = true;
  helixGroup.add(tubeA, tubeB);

  const pairColors: Array<[string, string]> = [
    ["#F59E0B", "#3B82F6"],
    ["#10B981", "#EC4899"],
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

    const halfL = new THREE.Mesh(
      new THREE.CylinderGeometry(0.055, 0.055, radius * 0.92, 12),
      new THREE.MeshStandardMaterial({ color: c1, roughness: 0.35, metalness: 0.2 })
    );
    halfL.rotation.z = Math.PI / 2;
    halfL.position.x = -radius * 0.46;

    const halfR = new THREE.Mesh(
      new THREE.CylinderGeometry(0.055, 0.055, radius * 0.92, 12),
      new THREE.MeshStandardMaterial({ color: c2, roughness: 0.35, metalness: 0.2 })
    );
    halfR.rotation.z = Math.PI / 2;
    halfR.position.x = radius * 0.46;

    const bondRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.085, 0.022, 10, 20),
      new THREE.MeshStandardMaterial({ color: "#F8FAFC", metalness: 0.9, roughness: 0.15 })
    );
    bondRing.rotation.y = Math.PI / 2;

    rungGroup.add(halfL, halfR, bondRing);
  }

  // Pedestal
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(1.25, 1.45, 0.22, 48),
    new THREE.MeshStandardMaterial({ color: "#0F172A", roughness: 0.4, metalness: 0.75 })
  );
  base.position.y = 0.11;
  base.receiveShadow = true;
  root.add(base);

  return {
    root,
    textures: [],
    update: (t) => {
      helixGroup.rotation.y = t * 0.55;
      helixGroup.position.y = 0.25 + Math.sin(t * 1.4) * 0.06;
    },
  };
}

function buildHeart3D(): Built3DModel {
  const root = new THREE.Group();
  const heart = new THREE.Group();
  heart.position.y = 1.9;
  root.add(heart);

  const muscleMat = new THREE.MeshPhysicalMaterial({
    color: "#DC2626",
    roughness: 0.32,
    metalness: 0.05,
    clearcoat: 0.65,
    clearcoatRoughness: 0.25,
  });
  const veinMat = new THREE.MeshPhysicalMaterial({
    color: "#2563EB",
    roughness: 0.35,
    metalness: 0.1,
    clearcoat: 0.5,
  });
  const arteryMat = new THREE.MeshPhysicalMaterial({
    color: "#B91C1C",
    roughness: 0.28,
    metalness: 0.08,
    clearcoat: 0.7,
  });

  // Left & Right ventricles (sculpted lower chambers)
  const leftVentricle = new THREE.Mesh(new THREE.SphereGeometry(0.95, 32, 32), muscleMat);
  leftVentricle.scale.set(0.88, 1.25, 0.85);
  leftVentricle.position.set(0.32, -0.25, 0.05);
  leftVentricle.rotation.z = 0.25;
  leftVentricle.castShadow = true;

  const rightVentricle = new THREE.Mesh(new THREE.SphereGeometry(0.86, 32, 32), muscleMat);
  rightVentricle.scale.set(0.86, 1.15, 0.82);
  rightVentricle.position.set(-0.35, -0.18, 0.12);
  rightVentricle.rotation.z = -0.24;
  rightVentricle.castShadow = true;

  // Atria
  const rightAtrium = new THREE.Mesh(new THREE.SphereGeometry(0.56, 24, 24), veinMat);
  rightAtrium.position.set(-0.56, 0.55, 0.02);
  rightAtrium.castShadow = true;

  const leftAtrium = new THREE.Mesh(new THREE.SphereGeometry(0.54, 24, 24), arteryMat);
  leftAtrium.position.set(0.52, 0.52, -0.08);
  leftAtrium.castShadow = true;

  // Aortic Arch (TubeGeometry)
  const aortaCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.18, 0.45, 0.05),
    new THREE.Vector3(0.12, 1.28, 0.04),
    new THREE.Vector3(-0.28, 1.42, -0.12),
    new THREE.Vector3(-0.46, 0.95, -0.32),
  ]);
  const aorta = new THREE.Mesh(new THREE.TubeGeometry(aortaCurve, 36, 0.21, 18, false), arteryMat);
  aorta.castShadow = true;

  // Superior Vena Cava
  const venaCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.68, 0.45, -0.05),
    new THREE.Vector3(-0.78, 1.32, -0.08),
  ]);
  const venaCava = new THREE.Mesh(new THREE.TubeGeometry(venaCurve, 20, 0.16, 16, false), veinMat);
  venaCava.castShadow = true;

  // Pulmonary artery
  const pulmCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.2, 0.35, 0.32),
    new THREE.Vector3(0.08, 0.98, 0.28),
    new THREE.Vector3(0.75, 0.92, 0.12),
  ]);
  const pulmonary = new THREE.Mesh(new THREE.TubeGeometry(pulmCurve, 24, 0.14, 14, false), veinMat);

  heart.add(leftVentricle, rightVentricle, rightAtrium, leftAtrium, aorta, venaCava, pulmonary);

  // Orbiting oxygenated/deoxygenated blood cells
  const cells: THREE.Mesh[] = [];
  for (let i = 0; i < 10; i++) {
    const cell = new THREE.Mesh(
      new THREE.TorusGeometry(0.08, 0.038, 10, 18),
      new THREE.MeshStandardMaterial({
        color: i % 2 === 0 ? "#EF4444" : "#3B82F6",
        emissive: i % 2 === 0 ? "#7F1D1D" : "#1E3A8A",
        emissiveIntensity: 0.4,
        roughness: 0.3,
      })
    );
    root.add(cell);
    cells.push(cell);
  }

  return {
    root,
    textures: [],
    update: (t) => {
      // Realistic lub-dub cardiac pulse
      const beatPhase = (t * 1.25) % 1;
      const pulse =
        1 +
        Math.exp(-Math.pow((beatPhase - 0.15) * 14, 2)) * 0.08 +
        Math.exp(-Math.pow((beatPhase - 0.35) * 16, 2)) * 0.05;
      heart.scale.setScalar(pulse);
      heart.rotation.y = Math.sin(t * 0.45) * 0.35;

      cells.forEach((c, idx) => {
        const a = t * 0.9 + (idx * Math.PI * 2) / cells.length;
        const r = 1.65 + (idx % 2) * 0.25;
        c.position.set(Math.cos(a) * r, 1.8 + Math.sin(a * 2) * 0.55, Math.sin(a) * r);
        c.rotation.x = t * 1.5 + idx;
        c.rotation.y = t * 1.1;
      });
    },
  };
}

function buildPlant3D(aniso: number): Built3DModel {
  const root = new THREE.Group();
  const leafTex = createLeafTexture(aniso);

  // Layered soil + grass cross-section base
  const soil = new THREE.Mesh(
    new THREE.CylinderGeometry(1.75, 1.55, 0.55, 40),
    new THREE.MeshStandardMaterial({ color: "#78350F", roughness: 0.92, metalness: 0.02 })
  );
  soil.position.y = 0.275;
  soil.receiveShadow = true;
  root.add(soil);

  const grass = new THREE.Mesh(
    new THREE.CylinderGeometry(1.78, 1.76, 0.14, 40),
    new THREE.MeshStandardMaterial({ color: "#15803D", roughness: 0.82, metalness: 0.02 })
  );
  grass.position.y = 0.58;
  grass.receiveShadow = true;
  root.add(grass);

  // Sculpted stem
  const stemCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0.6, 0),
    new THREE.Vector3(0.08, 1.4, 0.05),
    new THREE.Vector3(-0.05, 2.25, -0.04),
    new THREE.Vector3(0.02, 2.95, 0),
  ]);
  const stem = new THREE.Mesh(
    new THREE.TubeGeometry(stemCurve, 28, 0.11, 14, false),
    new THREE.MeshStandardMaterial({ color: "#166534", roughness: 0.65, metalness: 0.04 })
  );
  stem.castShadow = true;
  root.add(stem);

  // 8 sculpted 3D botanical leaves
  const leafMat = new THREE.MeshPhysicalMaterial({
    map: leafTex,
    roughness: 0.36,
    metalness: 0.04,
    clearcoat: 0.35,
    side: THREE.DoubleSide,
  });

  const leavesGroup = new THREE.Group();
  root.add(leavesGroup);
  for (let i = 0; i < 8; i++) {
    const leafShape = new THREE.Shape();
    leafShape.moveTo(0, 0);
    leafShape.quadraticCurveTo(0.42, 0.35, 0, 1.05);
    leafShape.quadraticCurveTo(-0.42, 0.35, 0, 0);

    const leafGeo = new THREE.ExtrudeGeometry(leafShape, {
      depth: 0.025,
      bevelEnabled: true,
      bevelThickness: 0.012,
      bevelSize: 0.012,
      bevelSegments: 2,
    });
    const leaf = new THREE.Mesh(leafGeo, leafMat);
    const y = 1.15 + i * 0.24;
    const angle = i * 2.25;
    leaf.position.set(0, y, 0);
    leaf.rotation.set(0.75 + (i % 3) * 0.14, angle, 0.2);
    leaf.scale.setScalar(0.85 - i * 0.04);
    leaf.castShadow = true;
    leavesGroup.add(leaf);
  }

  // Radiant golden Sun + translucent light rays
  const sun = new THREE.Mesh(
    new THREE.SphereGeometry(0.52, 28, 28),
    new THREE.MeshStandardMaterial({
      color: "#FDE047",
      emissive: "#F59E0B",
      emissiveIntensity: 1.6,
      roughness: 0.2,
    })
  );
  sun.position.set(2.1, 3.2, -0.9);
  root.add(sun);

  const rayCone = new THREE.Mesh(
    new THREE.ConeGeometry(1.1, 3.2, 24, 1, true),
    new THREE.MeshBasicMaterial({
      color: "#FEF08A",
      transparent: true,
      opacity: 0.12,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  );
  rayCone.position.set(1.05, 2.35, -0.45);
  rayCone.rotation.z = 0.72;
  rayCone.rotation.x = 0.25;
  root.add(rayCone);

  // Rising Oxygen (O2) bubbles
  const bubbles: THREE.Mesh[] = [];
  for (let i = 0; i < 12; i++) {
    const b = new THREE.Mesh(
      new THREE.SphereGeometry(0.08, 16, 16),
      new THREE.MeshPhysicalMaterial({
        color: "#38BDF8",
        emissive: "#0284C7",
        emissiveIntensity: 0.5,
        roughness: 0.1,
        metalness: 0.1,
        clearcoat: 1,
      })
    );
    root.add(b);
    bubbles.push(b);
  }

  return {
    root,
    textures: [leafTex],
    update: (t) => {
      leavesGroup.rotation.y = Math.sin(t * 0.8) * 0.08;
      sun.scale.setScalar(1 + Math.sin(t * 2.4) * 0.04);
      bubbles.forEach((b, idx) => {
        const cyc = (t * 0.45 + idx * 0.21) % 1;
        const a = idx * 1.4;
        b.position.set(
          Math.cos(a) * (0.45 + cyc * 0.7),
          1.1 + cyc * 2.4,
          Math.sin(a) * (0.45 + cyc * 0.7)
        );
        b.scale.setScalar(0.5 + Math.sin(cyc * Math.PI) * 0.8);
      });
    },
  };
}

function buildWaterCycle3D(): Built3DModel {
  const root = new THREE.Group();

  // Ocean basin + terrain island
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(2.4, 2.25, 0.36, 48),
    new THREE.MeshStandardMaterial({ color: "#1E293B", roughness: 0.6, metalness: 0.25 })
  );
  base.position.y = 0.18;
  base.receiveShadow = true;
  root.add(base);

  const ocean = new THREE.Mesh(
    new THREE.CylinderGeometry(2.26, 2.26, 0.12, 48),
    new THREE.MeshPhysicalMaterial({
      color: "#0284C7",
      roughness: 0.14,
      metalness: 0.15,
      clearcoat: 1.0,
    })
  );
  ocean.position.y = 0.38;
  ocean.receiveShadow = true;
  root.add(ocean);

  // Sculpted Mountain + snow peak
  const mtn1 = new THREE.Mesh(
    new THREE.ConeGeometry(1.15, 1.95, 7),
    new THREE.MeshStandardMaterial({ color: "#475569", roughness: 0.88, metalness: 0.05 })
  );
  mtn1.position.set(-0.85, 1.32, -0.35);
  mtn1.castShadow = true;
  mtn1.receiveShadow = true;
  root.add(mtn1);

  const snowCap = new THREE.Mesh(
    new THREE.ConeGeometry(0.45, 0.74, 7),
    new THREE.MeshStandardMaterial({ color: "#F8FAFC", roughness: 0.45, metalness: 0.05 })
  );
  snowCap.position.set(-0.85, 1.95, -0.35);
  root.add(snowCap);

  const mtn2 = new THREE.Mesh(
    new THREE.ConeGeometry(0.85, 1.35, 6),
    new THREE.MeshStandardMaterial({ color: "#334155", roughness: 0.9, metalness: 0.04 })
  );
  mtn2.position.set(-0.05, 1.02, -0.9);
  mtn2.castShadow = true;
  root.add(mtn2);

  // Golden Sun
  const sun = new THREE.Mesh(
    new THREE.SphereGeometry(0.48, 28, 28),
    new THREE.MeshStandardMaterial({
      color: "#FDE047",
      emissive: "#F59E0B",
      emissiveIntensity: 1.5,
      roughness: 0.25,
    })
  );
  sun.position.set(1.65, 3.1, -0.6);
  root.add(sun);

  // Multi-puff 3D Rain Cloud
  const cloud = new THREE.Group();
  cloud.position.set(-0.6, 3.15, -0.15);
  const cloudMat = new THREE.MeshStandardMaterial({
    color: "#E2E8F0",
    roughness: 0.78,
    metalness: 0.02,
  });
  const puffCoords: Array<[number, number, number, number]> = [
    [0, 0, 0, 0.52],
    [-0.48, -0.08, 0.08, 0.4],
    [0.5, -0.06, -0.05, 0.42],
    [0.18, 0.24, 0.08, 0.36],
    [-0.22, 0.2, -0.08, 0.34],
  ];
  puffCoords.forEach(([x, y, z, r]) => {
    const p = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 20), cloudMat);
    p.position.set(x, y, z);
    p.castShadow = true;
    cloud.add(p);
  });
  root.add(cloud);

  // Evaporation vapor spheres + falling rain streaks
  const vapors: THREE.Mesh[] = [];
  const rains: THREE.Mesh[] = [];
  const vaporMat = new THREE.MeshBasicMaterial({
    color: "#BAE6FD",
    transparent: true,
    opacity: 0.55,
  });
  const rainMat = new THREE.MeshStandardMaterial({
    color: "#38BDF8",
    emissive: "#0284C7",
    emissiveIntensity: 0.6,
    roughness: 0.15,
  });

  for (let i = 0; i < 10; i++) {
    const v = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 12), vaporMat);
    root.add(v);
    vapors.push(v);

    const r = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.24, 8), rainMat);
    root.add(r);
    rains.push(r);
  }

  return {
    root,
    textures: [],
    update: (t) => {
      cloud.position.x = -0.6 + Math.sin(t * 0.65) * 0.22;
      vapors.forEach((v, idx) => {
        const cyc = (t * 0.45 + idx * 0.19) % 1;
        v.position.set(
          0.65 + Math.sin(t * 2 + idx) * 0.28 + (idx % 3) * 0.28,
          0.5 + cyc * 2.3,
          0.35 + ((idx % 4) - 1.5) * 0.3
        );
        v.scale.setScalar(0.5 + Math.sin(cyc * Math.PI) * 0.8);
      });
      rains.forEach((r, idx) => {
        const cyc = (t * 1.15 + idx * 0.17) % 1;
        r.position.set(
          cloud.position.x + ((idx % 5) - 2) * 0.24,
          2.85 - cyc * 2.1,
          cloud.position.z + (idx % 2 === 0 ? 0.15 : -0.15)
        );
      });
    },
  };
}

function buildRocket3D(aniso: number, accentColor: string): Built3DModel {
  const root = new THREE.Group();
  const metalTex = createBrushedMetalTexture(aniso);

  // Steel launch pad
  const pad = new THREE.Mesh(
    new THREE.CylinderGeometry(1.65, 1.85, 0.24, 36),
    new THREE.MeshStandardMaterial({ color: "#334155", roughness: 0.45, metalness: 0.8 })
  );
  pad.position.y = 0.12;
  pad.receiveShadow = true;
  root.add(pad);

  const rocket = new THREE.Group();
  rocket.position.y = 1.05;
  root.add(rocket);

  const bodyMat = new THREE.MeshPhysicalMaterial({
    map: metalTex,
    color: "#F8FAFC",
    roughness: 0.26,
    metalness: 0.68,
    clearcoat: 0.5,
  });
  const accentMat = new THREE.MeshStandardMaterial({
    color: accentColor,
    roughness: 0.35,
    metalness: 0.45,
  });
  const darkMetal = new THREE.MeshStandardMaterial({
    color: "#1E293B",
    roughness: 0.38,
    metalness: 0.85,
  });

  // Main fuselage
  const fuselage = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.52, 2.25, 36), bodyMat);
  fuselage.position.y = 1.2;
  fuselage.castShadow = true;
  rocket.add(fuselage);

  // Stage separator ring
  const stageBand = new THREE.Mesh(new THREE.CylinderGeometry(0.485, 0.495, 0.22, 36), darkMetal);
  stageBand.position.y = 0.85;
  rocket.add(stageBand);

  // Aerodynamic nose cone
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.46, 1.05, 36), accentMat);
  nose.position.y = 2.84;
  nose.castShadow = true;
  rocket.add(nose);

  // Cockpit viewport
  const windowFrame = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.035, 12, 24), darkMetal);
  windowFrame.position.set(0, 1.72, 0.45);
  const glass = new THREE.Mesh(
    new THREE.SphereGeometry(0.15, 20, 20),
    new THREE.MeshPhysicalMaterial({
      color: "#38BDF8",
      emissive: "#0284C7",
      emissiveIntensity: 0.45,
      roughness: 0.08,
      metalness: 0.1,
      clearcoat: 1,
    })
  );
  glass.scale.z = 0.45;
  glass.position.set(0, 1.72, 0.43);
  rocket.add(windowFrame, glass);

  // 4 swept aerodynamic fins
  for (let i = 0; i < 4; i++) {
    const finShape = new THREE.Shape();
    finShape.moveTo(0, 0);
    finShape.lineTo(0.55, -0.3);
    finShape.lineTo(0.55, -0.82);
    finShape.lineTo(0, -0.68);
    finShape.closePath();
    const fin = new THREE.Mesh(
      new THREE.ExtrudeGeometry(finShape, { depth: 0.06, bevelEnabled: true, bevelThickness: 0.015, bevelSize: 0.015 }),
      accentMat
    );
    const a = (i * Math.PI) / 2;
    fin.position.set(Math.cos(a) * 0.48, 0.72, Math.sin(a) * 0.48);
    fin.rotation.y = -a;
    fin.castShadow = true;
    rocket.add(fin);
  }

  // Engine bell + glowing exhaust plume
  const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.36, 0.35, 24), darkMetal);
  nozzle.position.y = -0.08;
  rocket.add(nozzle);

  const flame = new THREE.Mesh(
    new THREE.ConeGeometry(0.32, 1.15, 20),
    new THREE.MeshStandardMaterial({
      color: "#FEF08A",
      emissive: "#F97316",
      emissiveIntensity: 2.2,
      transparent: true,
      opacity: 0.88,
      roughness: 0.2,
    })
  );
  flame.rotation.x = Math.PI;
  flame.position.y = -0.78;
  rocket.add(flame);

  return {
    root,
    textures: [metalTex],
    update: (t) => {
      rocket.position.y = 1.08 + Math.sin(t * 2.2) * 0.14;
      rocket.rotation.y = t * 0.42;
      flame.scale.set(
        0.92 + Math.sin(t * 24) * 0.08,
        0.88 + Math.cos(t * 28) * 0.16,
        0.92 + Math.sin(t * 24) * 0.08
      );
    },
  };
}

function buildCircuit3D(aniso: number, accentColor: string): Built3DModel {
  const root = new THREE.Group();
  const pcbTex = createCircuitPcbTexture(aniso);

  // PCB board elevated on 4 brass standoffs
  const board = new THREE.Mesh(
    new THREE.BoxGeometry(3.4, 0.16, 2.5),
    new THREE.MeshStandardMaterial({ map: pcbTex, roughness: 0.42, metalness: 0.25 })
  );
  board.position.y = 0.42;
  board.castShadow = true;
  board.receiveShadow = true;
  root.add(board);

  const standoffMat = new THREE.MeshStandardMaterial({ color: "#D97706", roughness: 0.22, metalness: 0.92 });
  [[-1.5, -1.05], [1.5, -1.05], [-1.5, 1.05], [1.5, 1.05]].forEach(([x, z]) => {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.34, 16), standoffMat);
    post.position.set(x, 0.17, z);
    root.add(post);
  });

  // Central ceramic CPU chip + metallic heat spreader
  const cpuPkg = new THREE.Mesh(
    new THREE.BoxGeometry(1.15, 0.22, 1.15),
    new THREE.MeshStandardMaterial({ color: "#0F172A", roughness: 0.55, metalness: 0.2 })
  );
  cpuPkg.position.y = 0.61;
  cpuPkg.castShadow = true;
  root.add(cpuPkg);

  const ihs = new THREE.Mesh(
    new THREE.BoxGeometry(0.84, 0.09, 0.84),
    new THREE.MeshPhysicalMaterial({ color: "#CBD5E1", roughness: 0.18, metalness: 0.95, clearcoat: 0.3 })
  );
  ihs.position.y = 0.76;
  root.add(ihs);

  // Gold CPU pins along all 4 sides
  for (let i = -3; i <= 3; i++) {
    const offset = i * 0.14;
    const pinA = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.08, 0.14), standoffMat);
    pinA.position.set(offset, 0.55, 0.62);
    const pinB = pinA.clone();
    pinB.position.set(offset, 0.55, -0.62);
    root.add(pinA, pinB);
  }

  // Aluminum capacitors + copper coils
  const capMat = new THREE.MeshStandardMaterial({ color: "#2563EB", roughness: 0.28, metalness: 0.75 });
  [[-1.15, -0.65], [-1.15, 0], [-1.15, 0.65]].forEach(([x, z]) => {
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.56, 20), capMat);
    cap.position.set(x, 0.78, z);
    cap.castShadow = true;
    root.add(cap);
  });

  const coilMat = new THREE.MeshStandardMaterial({ color: "#EA580C", roughness: 0.25, metalness: 0.88 });
  [[1.15, -0.55], [1.15, 0.55]].forEach(([x, z]) => {
    const coil = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.07, 14, 28), coilMat);
    coil.position.set(x, 0.72, z);
    coil.castShadow = true;
    root.add(coil);
  });

  // Glowing data pulses traveling over traces
  const pulses: THREE.Mesh[] = [];
  for (let i = 0; i < 8; i++) {
    const pulse = new THREE.Mesh(
      new THREE.SphereGeometry(0.075, 14, 14),
      new THREE.MeshStandardMaterial({
        color: "#E0F2FE",
        emissive: accentColor,
        emissiveIntensity: 2.0,
        roughness: 0.1,
      })
    );
    root.add(pulse);
    pulses.push(pulse);
  }

  return {
    root,
    textures: [pcbTex],
    update: (t) => {
      pulses.forEach((p, idx) => {
        const cyc = (t * 0.9 + idx * 0.25) % 1;
        const lane = (idx % 4) - 1.5;
        p.position.set(-1.55 + cyc * 3.1, 0.56 + Math.sin(cyc * Math.PI) * 0.12, lane * 0.52);
      });
    },
  };
}

function buildEarthGlobe3D(aniso: number): Built3DModel {
  const root = new THREE.Group();
  const earthTex = createEarthTexture(aniso);
  const cloudsTex = createCloudsTexture(aniso);

  // Brass pedestal + meridian cradle
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.95, 1.15, 0.22, 40),
    new THREE.MeshStandardMaterial({ color: "#1E293B", roughness: 0.4, metalness: 0.7 })
  );
  base.position.y = 0.11;
  base.receiveShadow = true;
  root.add(base);

  const brassMat = new THREE.MeshStandardMaterial({ color: "#D97706", roughness: 0.2, metalness: 0.92 });
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.14, 0.5, 20), brassMat);
  stem.position.y = 0.45;
  root.add(stem);

  const arc = new THREE.Mesh(new THREE.TorusGeometry(1.56, 0.048, 16, 64, Math.PI * 1.15), brassMat);
  arc.position.y = 2.05;
  arc.rotation.z = -Math.PI * 0.58;
  root.add(arc);

  const globeGroup = new THREE.Group();
  globeGroup.position.y = 2.05;
  globeGroup.rotation.z = 0.41; // 23.5 deg Earth axial tilt
  root.add(globeGroup);

  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(1.38, 48, 48),
    new THREE.MeshPhysicalMaterial({
      map: earthTex,
      roughness: 0.45,
      metalness: 0.08,
      clearcoat: 0.35,
      clearcoatRoughness: 0.25,
    })
  );
  earth.castShadow = true;
  globeGroup.add(earth);

  const clouds = new THREE.Mesh(
    new THREE.SphereGeometry(1.42, 40, 40),
    new THREE.MeshStandardMaterial({
      map: cloudsTex,
      transparent: true,
      opacity: 0.72,
      roughness: 0.9,
      depthWrite: false,
    })
  );
  globeGroup.add(clouds);

  // Orbiting Satellite
  const satPivot = new THREE.Group();
  satPivot.position.y = 2.05;
  satPivot.rotation.z = 0.3;
  root.add(satPivot);

  const sat = new THREE.Group();
  sat.position.set(2.15, 0, 0);
  const satBody = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.22, 0.26), brassMat);
  const panelMat = new THREE.MeshStandardMaterial({
    color: "#1D4ED8",
    emissive: "#1E40AF",
    emissiveIntensity: 0.3,
    roughness: 0.2,
    metalness: 0.8,
  });
  const wingL = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.02, 0.18), panelMat);
  wingL.position.x = -0.38;
  const wingR = wingL.clone();
  wingR.position.x = 0.38;
  sat.add(satBody, wingL, wingR);
  satPivot.add(sat);

  return {
    root,
    textures: [earthTex, cloudsTex],
    update: (t) => {
      earth.rotation.y = t * 0.35;
      clouds.rotation.y = t * 0.44;
      satPivot.rotation.y = t * 0.78;
    },
  };
}

function buildVolcano3D(): Built3DModel {
  const root = new THREE.Group();

  const crust = new THREE.Mesh(
    new THREE.CylinderGeometry(2.35, 2.2, 0.42, 40),
    new THREE.MeshStandardMaterial({ color: "#44403C", roughness: 0.92, metalness: 0.04 })
  );
  crust.position.y = 0.21;
  crust.receiveShadow = true;
  root.add(crust);

  const cone = new THREE.Mesh(
    new THREE.CylinderGeometry(0.52, 2.05, 2.25, 28),
    new THREE.MeshStandardMaterial({ color: "#57534E", roughness: 0.9, metalness: 0.05 })
  );
  cone.position.y = 1.5;
  cone.castShadow = true;
  cone.receiveShadow = true;
  root.add(cone);

  // Glowing magma chamber cutaway & central crater lava
  const lavaMat = new THREE.MeshStandardMaterial({
    color: "#FACC15",
    emissive: "#EA580C",
    emissiveIntensity: 2.0,
    roughness: 0.2,
  });
  const magmaPool = new THREE.Mesh(new THREE.SphereGeometry(0.62, 24, 24), lavaMat);
  magmaPool.scale.set(1.2, 0.55, 0.9);
  magmaPool.position.set(0, 0.48, 1.35);
  root.add(magmaPool);

  const craterLava = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.35, 0.14, 24), lavaMat);
  craterLava.position.y = 2.6;
  root.add(craterLava);

  // Lava streams down slopes
  for (let i = 0; i < 3; i++) {
    const a = i * 2.1 + 0.4;
    const stream = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.14, 2.2, 10), lavaMat);
    stream.position.set(Math.cos(a) * 0.98, 1.55, Math.sin(a) * 0.98);
    stream.rotation.z = -Math.cos(a) * 0.52;
    stream.rotation.x = Math.sin(a) * 0.52;
    root.add(stream);
  }

  // Animated rising smoke & glowing embers
  const puffs: THREE.Mesh[] = [];
  const smokeMat = new THREE.MeshStandardMaterial({
    color: "#64748B",
    roughness: 0.95,
    transparent: true,
    opacity: 0.72,
  });
  for (let i = 0; i < 10; i++) {
    const puff = new THREE.Mesh(new THREE.DodecahedronGeometry(0.24, 1), i % 3 === 0 ? lavaMat : smokeMat);
    root.add(puff);
    puffs.push(puff);
  }

  return {
    root,
    textures: [],
    update: (t) => {
      puffs.forEach((p, idx) => {
        const cyc = (t * 0.55 + idx * 0.18) % 1;
        const a = idx * 1.7 + t * 0.6;
        p.position.set(
          Math.cos(a) * cyc * 0.75,
          2.68 + cyc * 1.7,
          Math.sin(a) * cyc * 0.75
        );
        p.scale.setScalar(0.45 + cyc * 1.15);
      });
    },
  };
}

function buildWaveOptics3D(primaryColor: string): Built3DModel {
  const root = new THREE.Group();

  // Animated 3D wave surface grid
  const waveGeo = new THREE.PlaneGeometry(4.4, 2.8, 40, 26);
  waveGeo.rotateX(-Math.PI / 2);
  const waveMat = new THREE.MeshPhysicalMaterial({
    color: primaryColor,
    roughness: 0.25,
    metalness: 0.35,
    clearcoat: 0.8,
    side: THREE.DoubleSide,
  });
  const waveMesh = new THREE.Mesh(waveGeo, waveMat);
  waveMesh.position.y = 0.75;
  waveMesh.receiveShadow = true;
  root.add(waveMesh);

  // Crystal triangular prism floating cleanly above
  const prism = new THREE.Mesh(
    new THREE.CylinderGeometry(0.75, 0.75, 1.2, 3),
    new THREE.MeshPhysicalMaterial({
      color: "#E0F2FE",
      roughness: 0.06,
      metalness: 0.1,
      clearcoat: 1.0,
      transparent: true,
      opacity: 0.78,
    })
  );
  prism.position.set(0, 2.25, 0);
  prism.castShadow = true;
  root.add(prism);

  // Incident white ray + 6 rainbow refracted spectrum rays
  const whiteRay = new THREE.Mesh(
    new THREE.CylinderGeometry(0.055, 0.055, 2.2, 12),
    new THREE.MeshStandardMaterial({ color: "#FFFFFF", emissive: "#FFFFFF", emissiveIntensity: 1.8 })
  );
  whiteRay.rotation.z = Math.PI / 2 - 0.18;
  whiteRay.position.set(-1.35, 2.1, 0);
  root.add(whiteRay);

  const rainbow = ["#EF4444", "#F97316", "#FACC15", "#22C55E", "#3B82F6", "#8B5CF6"];
  rainbow.forEach((hex, idx) => {
    const spread = (idx - 2.5) * 0.12;
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.038, 0.055, 2.3, 12),
      new THREE.MeshStandardMaterial({ color: hex, emissive: hex, emissiveIntensity: 1.5 })
    );
    beam.rotation.z = Math.PI / 2 + spread;
    beam.position.set(1.45, 2.25 - spread * 1.15, (idx - 2.5) * 0.05);
    root.add(beam);
  });

  const posAttr = waveGeo.attributes.position as THREE.BufferAttribute;

  return {
    root,
    textures: [],
    update: (t) => {
      prism.rotation.y = Math.sin(t * 0.6) * 0.25;
      for (let i = 0; i < posAttr.count; i++) {
        const x = posAttr.getX(i);
        const z = posAttr.getZ(i);
        const y = Math.sin(x * 2.1 + t * 2.8) * 0.24 + Math.cos(z * 1.8 - t * 2.0) * 0.12;
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
  const metalTex = createBrushedMetalTexture(aniso);

  // Studio architectural plinth
  const plinth = new THREE.Mesh(
    new THREE.CylinderGeometry(1.9, 2.1, 0.24, 48),
    new THREE.MeshStandardMaterial({ color: "#1E293B", roughness: 0.35, metalness: 0.72 })
  );
  plinth.position.y = 0.12;
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
    assembly.position.y = 0.26;
    root.add(assembly);

    blueprint.customParts.slice(0, 12).forEach((part, idx) => {
      const geo = createGeometryForPart(part.shape);
      const opacity = typeof part.opacity === "number" ? THREE.MathUtils.clamp(part.opacity, 0.15, 1) : 1;
      const mat = new THREE.MeshPhysicalMaterial({
        color: safeHex(part.color, blueprint.primaryColor),
        roughness: typeof part.roughness === "number" ? THREE.MathUtils.clamp(part.roughness, 0.05, 1) : 0.38,
        metalness: typeof part.metalness === "number" ? THREE.MathUtils.clamp(part.metalness, 0, 1) : 0.35,
        emissive: part.emissive ? new THREE.Color(safeHex(part.emissive, "#000000")) : new THREE.Color("#000000"),
        emissiveIntensity: part.emissive ? 0.55 : 0,
        transparent: opacity < 0.99,
        opacity,
        clearcoat: 0.4,
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
      textures: [metalTex],
      update: (t) => {
        assembly.rotation.y = Math.sin(t * 0.35) * 0.22;
        for (const item of animatedNodes) {
          if (item.mode === "spin") {
            item.mesh.rotation.y = t * 1.1 + item.idx;
          } else if (item.mode === "float") {
            item.mesh.position.y = item.basePos.y + Math.sin(t * 2 + item.idx) * 0.14;
          } else if (item.mode === "pulse") {
            const s = 1 + Math.sin(t * 2.6 + item.idx) * 0.08;
            item.mesh.scale.setScalar(s);
          } else if (item.mode === "orbit") {
            const r = Math.max(0.8, Math.hypot(item.basePos.x, item.basePos.z));
            const a = t * 0.9 + item.idx * 1.2;
            item.mesh.position.x = Math.cos(a) * r;
            item.mesh.position.z = Math.sin(a) * r;
          }
        }
      },
    };
  }

  // High-craft architectural geometric knowledge observatory (composite 10-part PBR sculpture)
  const coreGroup = new THREE.Group();
  coreGroup.position.y = 1.9;
  root.add(coreGroup);

  const corePoly = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.82, 0),
    new THREE.MeshPhysicalMaterial({
      color: safeHex(blueprint.primaryColor, "#2563EB"),
      roughness: 0.18,
      metalness: 0.55,
      clearcoat: 1.0,
    })
  );
  corePoly.castShadow = true;
  coreGroup.add(corePoly);

  const innerGlow = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.52, 0),
    new THREE.MeshStandardMaterial({
      color: "#F8FAFC",
      emissive: safeHex(blueprint.accentColor, "#38BDF8"),
      emissiveIntensity: 1.4,
      roughness: 0.15,
    })
  );
  coreGroup.add(innerGlow);

  const gyroA = new THREE.Mesh(
    new THREE.TorusGeometry(1.32, 0.05, 16, 72),
    new THREE.MeshStandardMaterial({ map: metalTex, color: "#E2E8F0", roughness: 0.2, metalness: 0.92 })
  );
  const gyroB = new THREE.Mesh(
    new THREE.TorusGeometry(1.58, 0.04, 16, 72),
    new THREE.MeshStandardMaterial({
      color: safeHex(blueprint.accentColor, "#38BDF8"),
      emissive: safeHex(blueprint.accentColor, "#38BDF8"),
      emissiveIntensity: 0.45,
      roughness: 0.25,
      metalness: 0.85,
    })
  );
  gyroB.rotation.x = Math.PI / 2;
  coreGroup.add(gyroA, gyroB);

  // 4 floating data satellites around the observatory
  const nodes: THREE.Mesh[] = [];
  for (let i = 0; i < 4; i++) {
    const n = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 20, 20),
      new THREE.MeshPhysicalMaterial({
        color: i % 2 === 0 ? safeHex(blueprint.accentColor, "#38BDF8") : "#F59E0B",
        roughness: 0.2,
        metalness: 0.7,
        clearcoat: 0.8,
      })
    );
    n.castShadow = true;
    root.add(n);
    nodes.push(n);
  }

  return {
    root,
    textures: [metalTex],
    update: (t) => {
      corePoly.rotation.y = t * 0.55;
      corePoly.rotation.x = t * 0.25;
      gyroA.rotation.x = t * 0.6;
      gyroA.rotation.y = t * 0.35;
      gyroB.rotation.z = -t * 0.48;
      nodes.forEach((n, idx) => {
        const a = t * 0.75 + (idx * Math.PI) / 2;
        n.position.set(Math.cos(a) * 1.9, 1.9 + Math.sin(t * 1.6 + idx) * 0.35, Math.sin(a) * 1.9);
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
      return buildAtom3D(blueprint.primaryColor, blueprint.accentColor);
    case "dna":
      return buildDna3D(blueprint.primaryColor, blueprint.accentColor);
    case "heart":
      return buildHeart3D();
    case "plant":
      return buildPlant3D(aniso);
    case "watercycle":
      return buildWaterCycle3D();
    case "rocket":
      return buildRocket3D(aniso, blueprint.accentColor);
    case "circuit":
      return buildCircuit3D(aniso, blueprint.accentColor);
    case "earth":
      return buildEarthGlobe3D(aniso);
    case "volcano":
      return buildVolcano3D();
    case "wave":
      return buildWaveOptics3D(blueprint.primaryColor);
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
// Unified Real-Time 3D Studio Engine (Interactive Image + Cinema Video Export)
// ============================================================================

export class Study3DViewportEngine {
  public readonly renderer: THREE.WebGLRenderer;
  public readonly scene: THREE.Scene;
  public readonly camera: THREE.PerspectiveCamera;
  public readonly controls: OrbitControls | null;
  public readonly isSoftwareGl: boolean;

  private envTexture: THREE.Texture | null = null;
  private contactShadowTex: THREE.Texture;
  private keyLight: THREE.DirectionalLight;
  private hemiLight: THREE.HemisphereLight;
  private rimLight: THREE.DirectionalLight;
  private activeModel: Built3DModel | null = null;
  private activeBlueprint: Study3DSceneBlueprint | null = null;
  private cameraTargetPos: THREE.Vector3 | null = null;
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
    this.renderer.toneMappingExposure = 1.14;
    this.renderer.setPixelRatio(
      this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2)
    );
    this.renderer.setSize(options.width, options.height, false);
    this.renderer.shadowMap.enabled = !this.isSoftwareGl;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color("#0B1120");
    this.scene.fog = new THREE.FogExp2("#0B1120", 0.045);

    // Mandatory Studio PBR Environment Map (RoomEnvironment)
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = this.envTexture;
    pmrem.dispose();

    this.camera = new THREE.PerspectiveCamera(
      40,
      options.width / Math.max(1, options.height),
      0.1,
      80
    );
    this.camera.position.set(4.8, 3.3, 5.4);
    this.camera.lookAt(0, 1.55, 0);

    // Warm Key + Cool Hemisphere Fill + Crisp Rim Backlight
    this.hemiLight = new THREE.HemisphereLight("#BAE6FD", "#1E293B", 0.9);
    this.scene.add(this.hemiLight);

    this.keyLight = new THREE.DirectionalLight("#FFF7ED", 2.2);
    this.keyLight.position.set(5.5, 8.5, 5.5);
    this.keyLight.castShadow = !this.isSoftwareGl;
    this.keyLight.shadow.mapSize.set(1024, 1024);
    this.keyLight.shadow.camera.near = 1;
    this.keyLight.shadow.camera.far = 26;
    const d = 5.5;
    this.keyLight.shadow.camera.left = -d;
    this.keyLight.shadow.camera.right = d;
    this.keyLight.shadow.camera.top = d;
    this.keyLight.shadow.camera.bottom = -d;
    this.keyLight.shadow.bias = -0.0005;
    this.keyLight.shadow.normalBias = 0.02;
    this.scene.add(this.keyLight);

    this.rimLight = new THREE.DirectionalLight("#38BDF8", 1.15);
    this.rimLight.position.set(-5.5, 4.5, -5.5);
    this.scene.add(this.rimLight);

    // Soft grounded studio floor + radial contact shadow
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(14, 64),
      new THREE.MeshStandardMaterial({
        color: "#0F172A",
        roughness: 0.72,
        metalness: 0.18,
      })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.02;
    floor.receiveShadow = true;
    this.scene.add(floor);

    this.contactShadowTex = createContactShadowTexture();
    const shadowPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(5.6, 5.6),
      new THREE.MeshBasicMaterial({
        map: this.contactShadowTex,
        transparent: true,
        opacity: 0.62,
        depthWrite: false,
      })
    );
    shadowPlane.rotation.x = -Math.PI / 2;
    shadowPlane.position.y = 0.0;
    this.scene.add(shadowPlane);

    if (options.interactive) {
      const controls = new OrbitControls(this.camera, this.renderer.domElement);
      controls.target.set(0, 1.55, 0);
      controls.enableDamping = !this.isSoftwareGl;
      controls.dampingFactor = 0.06;
      controls.minDistance = 2.6;
      controls.maxDistance = 13.5;
      controls.maxPolarAngle = Math.PI * 0.49;
      controls.autoRotate = !this.isSoftwareGl;
      controls.autoRotateSpeed = 1.25;
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
      this.scene.background = new THREE.Color("#DCEEFF");
      this.scene.fog = new THREE.FogExp2("#DCEEFF", 0.032);
      this.keyLight.color.set("#FFFBEB");
      this.keyLight.intensity = 2.5;
      this.hemiLight.color.set("#FFFFFF");
      this.hemiLight.groundColor.set("#64748B");
      this.hemiLight.intensity = 1.1;
      this.rimLight.color.set("#38BDF8");
      this.rimLight.intensity = 0.85;
    } else if (preset === "dramatic") {
      this.scene.background = new THREE.Color("#030712");
      this.scene.fog = new THREE.FogExp2("#030712", 0.05);
      this.keyLight.color.set("#FDE68A");
      this.keyLight.intensity = 2.8;
      this.hemiLight.color.set("#38BDF8");
      this.hemiLight.groundColor.set("#0F172A");
      this.hemiLight.intensity = 0.55;
      this.rimLight.color.set("#A855F7");
      this.rimLight.intensity = 1.65;
    } else {
      this.applyEnvironmentBackground(this.activeBlueprint?.environment || "studio");
    }
  }

  private applyEnvironmentBackground(env: Study3DEnvironment): void {
    switch (env) {
      case "space":
        this.scene.background = new THREE.Color("#050816");
        this.scene.fog = new THREE.FogExp2("#050816", 0.028);
        this.keyLight.color.set("#FFF7ED");
        this.keyLight.intensity = 2.25;
        this.hemiLight.color.set("#93C5FD");
        this.hemiLight.groundColor.set("#0F172A");
        this.hemiLight.intensity = 0.72;
        this.rimLight.color.set("#38BDF8");
        this.rimLight.intensity = 1.3;
        break;
      case "outdoor":
        this.scene.background = new THREE.Color("#1E3A5F");
        this.scene.fog = new THREE.FogExp2("#1E3A5F", 0.034);
        this.keyLight.color.set("#FEF3C7");
        this.keyLight.intensity = 2.45;
        this.hemiLight.color.set("#BAE6FD");
        this.hemiLight.groundColor.set("#14532D");
        this.hemiLight.intensity = 0.95;
        this.rimLight.color.set("#FDE047");
        this.rimLight.intensity = 0.95;
        break;
      case "sunset":
        this.scene.background = new THREE.Color("#1C1018");
        this.scene.fog = new THREE.FogExp2("#1C1018", 0.042);
        this.keyLight.color.set("#FDBA74");
        this.keyLight.intensity = 2.4;
        this.hemiLight.color.set("#FDA4AF");
        this.hemiLight.groundColor.set("#1C1917");
        this.hemiLight.intensity = 0.75;
        this.rimLight.color.set("#F97316");
        this.rimLight.intensity = 1.45;
        break;
      case "lab":
        this.scene.background = new THREE.Color("#0B1628");
        this.scene.fog = new THREE.FogExp2("#0B1628", 0.04);
        this.keyLight.color.set("#F8FAFC");
        this.keyLight.intensity = 2.3;
        this.hemiLight.color.set("#7DD3FC");
        this.hemiLight.groundColor.set("#1E293B");
        this.hemiLight.intensity = 0.88;
        this.rimLight.color.set("#22D3EE");
        this.rimLight.intensity = 1.35;
        break;
      case "studio":
      default:
        this.scene.background = new THREE.Color("#0F172A");
        this.scene.fog = new THREE.FogExp2("#0F172A", 0.04);
        this.keyLight.color.set("#FFF7ED");
        this.keyLight.intensity = 2.25;
        this.hemiLight.color.set("#BAE6FD");
        this.hemiLight.groundColor.set("#1E293B");
        this.hemiLight.intensity = 0.92;
        this.rimLight.color.set("#38BDF8");
        this.rimLight.intensity = 1.2;
        break;
    }
  }

  public setCameraPreset(preset: CameraPreset): void {
    switch (preset) {
      case "closeup":
        this.cameraTargetPos = new THREE.Vector3(2.9, 2.2, 3.4);
        break;
      case "top":
        this.cameraTargetPos = new THREE.Vector3(0.4, 7.6, 2.4);
        break;
      case "side":
        this.cameraTargetPos = new THREE.Vector3(6.6, 1.9, 0.3);
        break;
      case "hero":
      default:
        this.cameraTargetPos = new THREE.Vector3(4.8, 3.3, 5.4);
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
    this.applyEnvironmentBackground(blueprint.environment);

    const aniso = this.renderer.capabilities.getMaxAnisotropy();
    this.activeModel = buildModelForBlueprint(blueprint, aniso);
    this.scene.add(this.activeModel.root);

    // Adjust hero framing for wide solar system scenes
    if (blueprint.archetype === "solar") {
      this.camera.position.set(6.2, 4.4, 6.8);
    } else {
      this.camera.position.set(4.8, 3.3, 5.4);
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
   * Deterministic cinematic camera fly-through frame renderer for 3D Video playback & .webm export.
   */
  public renderCinematicFrame(
    timeSec: number,
    sceneIndex: number,
    sceneProgress: number
  ): void {
    if (this.disposed) return;
    this.activeModel?.update(timeSec);

    const baseDist = this.activeBlueprint?.archetype === "solar" ? 7.8 : 5.6;
    const sweepMode = sceneIndex % 5;
    let angle = timeSec * 0.35 + sceneIndex * 1.15;
    let height = 2.85;
    let radius = baseDist;

    if (sweepMode === 0) {
      // Hero sweeping orbit
      radius = baseDist - sceneProgress * 0.85;
      height = 3.1 - sceneProgress * 0.4;
    } else if (sweepMode === 1) {
      // Dramatic low-angle dolly-in
      angle = 0.55 + sceneProgress * 1.25;
      radius = baseDist * 0.88 - sceneProgress * 0.9;
      height = 1.9 + sceneProgress * 0.65;
    } else if (sweepMode === 2) {
      // Elevated aerial glide
      angle = 2.1 + sceneProgress * 1.1;
      radius = baseDist * 0.95;
      height = 4.9 - sceneProgress * 1.1;
    } else if (sweepMode === 3) {
      // Close inspection orbit
      angle = -0.8 + sceneProgress * 1.6;
      radius = baseDist * 0.78;
      height = 2.4 + Math.sin(sceneProgress * Math.PI) * 0.8;
    } else {
      // Finale wide pull-back
      angle = timeSec * 0.42;
      radius = baseDist * 0.82 + sceneProgress * 1.2;
      height = 2.6 + sceneProgress * 0.9;
    }

    // Offset camera target slightly left so 3D hero frames cleanly on the right of the video layout
    _camGoalVec.set(
      Math.cos(angle) * radius,
      height,
      Math.sin(angle) * radius
    );
    this.camera.position.copy(_camGoalVec);
    _targetVec.set(-0.75, 1.5, 0);
    this.camera.lookAt(_targetVec);
    this.renderer.render(this.scene, this.camera);
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
          6,
          dt
        );
        this.camera.position.y = THREE.MathUtils.damp(
          this.camera.position.y,
          this.cameraTargetPos.y,
          6,
          dt
        );
        this.camera.position.z = THREE.MathUtils.damp(
          this.camera.position.z,
          this.cameraTargetPos.z,
          6,
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
        const a = Math.atan2(this.camera.position.z, this.camera.position.x) + dt * 0.32;
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
    // Force immediate fresh WebGL render before readback
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
      grad.addColorStop(1, "rgba(2, 6, 23, 0.85)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, out.height - 120, out.width, 120);

      ctx.fillStyle = "#FFFFFF";
      ctx.font = "700 32px system-ui, -apple-system, sans-serif";
      ctx.fillText(titleOverlay.slice(0, 68), 36, out.height - 46);
      ctx.fillStyle = "#94A3B8";
      ctx.font = "500 18px system-ui, -apple-system, sans-serif";
      ctx.fillText("Jogi Jarvis · 3D PBR Real Render", 36, out.height - 18);
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
    disposeObject3D(this.scene);
    this.renderer.dispose();
  }
}
