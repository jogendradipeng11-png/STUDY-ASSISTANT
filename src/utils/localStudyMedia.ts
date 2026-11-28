import type {
  FamilyProfile,
  StudyDiagramMedia,
  StudyNote,
  StudyPhotoResult,
  StudyVideoLink,
  StudyVideoScene,
  StudyVideoStoryboard,
} from "../types";
import {
  checkWebGpuSupport,
  generateLocalLlmPrompt,
  getLoadedLocalModelKey,
  getReadyLocalModelKey,
  getRecordedDownloadedModels,
  LOCAL_LLM_MODELS,
  type LocalLlmProgress,
} from "./localLlm";
import { loadNotes } from "./storage";
import { infer3DSceneBlueprint } from "./study3dEngine";

type DiagramLayout = "cycle" | "flow" | "anatomy" | "comparison" | "concept";

interface DiagramNodeSpec {
  label: string;
  detail: string;
}

interface StructuredDiagramPlan {
  title: string;
  caption: string;
  layout: DiagramLayout;
  accentColor: string;
  centerLabel?: string;
  nodes: DiagramNodeSpec[];
  summary: string;
}

export interface LocalPictureResult {
  reply: string;
  diagram: StudyDiagramMedia;
  photos: StudyPhotoResult[];
  usedLocalLlm: boolean;
}

export interface LocalVideoResult {
  reply: string;
  storyboard: StudyVideoStoryboard;
  videoLinks: StudyVideoLink[];
  usedLocalLlm: boolean;
}

export interface LocalSearchResult {
  reply: string;
  sources: Array<{ uri: string; title: string }>;
  photos: StudyPhotoResult[];
  videoLinks: StudyVideoLink[];
  diagram?: StudyDiagramMedia;
  usedLocalLlm: boolean;
}

function escapeXml(raw: string): string {
  return String(raw || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function safeColor(hex?: string, fallback = "#1D4ED8"): string {
  if (hex && /^#[0-9a-fA-F]{6}$/.test(hex.trim())) return hex.trim();
  return fallback;
}

function wrapSvgLines(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    const next = current ? `${current} ${w}` : w;
    if (next.length <= maxChars) {
      current = next;
    } else {
      if (current) lines.push(current);
      current = w.slice(0, maxChars);
      if (lines.length >= maxLines - 1) break;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  return lines.slice(0, maxLines);
}

function cleanTopicTitle(raw: string): string {
  const cleaned = raw
    .replace(
      /^(please\s+)?(draw|generate|create|make|show|explain|search|find|teach|tell\s+me\s+about|what\s+is|how\s+does|how\s+do|why\s+does)\s+(me\s+)?(a\s+|an\s+|the\s+)?(labeled\s+|labelled\s+)?(study\s+|educational\s+|short\s+|animated\s+)?(diagram|picture|image|illustration|chart|video|explainer|clip|animation)\s*(of|about|for|on)?\s*/i,
      ""
    )
    .replace(/[?!.]+$/g, "")
    .trim();
  const base = cleaned || raw.trim() || "Study Concept";
  return base.charAt(0).toUpperCase() + base.slice(1, 72);
}

function parseLooseJson<T>(raw: string): T | null {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function pickPalette(topic: string): { accent: string; soft: string; border: string } {
  const t = topic.toLowerCase();
  if (/(plant|leaf|photosynthesis|biology|cell|ecosystem|food chain|forest|nature|tree)/i.test(t)) {
    return { accent: "#059669", soft: "#ECFDF5", border: "#A7F3D0" };
  }
  if (/(heart|blood|human|body|digest|brain|lung|organ|skeleton|anatomy|volcano|heat|fire)/i.test(t)) {
    return { accent: "#DC2626", soft: "#FEF2F2", border: "#FECACA" };
  }
  if (/(water|ocean|rain|weather|cloud|climate|river|ice|hydro)/i.test(t)) {
    return { accent: "#0284C7", soft: "#F0F9FF", border: "#BAE6FD" };
  }
  if (/(space|solar|planet|sun|moon|star|gravity|atom|physics|electric|circuit|magnet|newton|force|energy)/i.test(t)) {
    return { accent: "#4F46E5", soft: "#EEF2FF", border: "#C7D2FE" };
  }
  if (/(math|algebra|geometry|fraction|triangle|equation|number|formula|history|geography)/i.test(t)) {
    return { accent: "#D97706", soft: "#FFFBEB", border: "#FDE68A" };
  }
  return { accent: "#1D4ED8", soft: "#EFF6FF", border: "#BFDBFE" };
}

function inferDiagramLayout(topic: string): DiagramLayout {
  const t = topic.toLowerCase();
  if (/(cycle|water cycle|carbon|nitrogen|rock cycle|life cycle|season|orbit|photosynthesis)/i.test(t)) {
    return "cycle";
  }
  if (/(vs\b|versus|difference|compare|comparison|contrast|types of)/i.test(t)) {
    return "comparison";
  }
  if (/(heart|cell|atom|solar system|flower|eye|ear|brain|leaf|volcano|skeleton|layer|structure|parts of|diagram of)/i.test(t)) {
    return "anatomy";
  }
  if (/(how |process|steps|digest|circuit|algorithm|method|timeline|solve|law)/i.test(t)) {
    return "flow";
  }
  return "concept";
}

interface OfflineKnowledgeEntry {
  match: RegExp;
  title: string;
  layout: DiagramLayout;
  accentColor: string;
  caption: string;
  summary: string;
  nodes: DiagramNodeSpec[];
  formulaOrFact: string;
  realLifeExample: string;
}

const OFFLINE_KNOWLEDGE_BASE: OfflineKnowledgeEntry[] = [
  {
    match: /photosynthesis/i,
    title: "Photosynthesis in Green Plants",
    layout: "cycle",
    accentColor: "#059669",
    caption: "How green leaves turn sunlight, water, and carbon dioxide into glucose and oxygen",
    summary:
      "Photosynthesis is the process by which green plants use sunlight, water, and carbon dioxide inside chloroplasts to make glucose (food) and release oxygen.",
    nodes: [
      { label: "1. Sunlight Energy", detail: "Chlorophyll in leaves absorbs light energy from the sun." },
      { label: "2. Water & Minerals", detail: "Roots absorb water from soil and carry it up via xylem." },
      { label: "3. Carbon Dioxide", detail: "Leaves take in CO2 from the air through tiny stomata." },
      { label: "4. Glucose & Oxygen", detail: "Chloroplasts make sugar for energy and release O2." },
    ],
    formulaOrFact: "6CO2 + 6H2O + Sunlight -> C6H12O6 (Glucose) + 6O2",
    realLifeExample: "A potted plant placed near a sunny window grows healthier and releases fresh oxygen.",
  },
  {
    match: /water\s*cycle|hydrologic/i,
    title: "The Water Cycle",
    layout: "cycle",
    accentColor: "#0284C7",
    caption: "Continuous movement of water through evaporation, condensation, precipitation, and collection",
    summary:
      "The water cycle describes how the Sun heats Earth's water so it evaporates into vapor, cools into clouds, falls as rain or snow, and returns to oceans and rivers.",
    nodes: [
      { label: "1. Evaporation", detail: "Sun heats oceans, lakes, and rivers into rising water vapor." },
      { label: "2. Condensation", detail: "Cool high-altitude air turns vapor into cloud droplets." },
      { label: "3. Precipitation", detail: "Heavy droplets fall back down as rain, snow, or hail." },
      { label: "4. Collection", detail: "Water gathers in rivers, groundwater, and oceans again." },
    ],
    formulaOrFact: "Liquid -> Vapor (Evaporation) -> Cloud (Condensation) -> Rain (Precipitation)",
    realLifeExample: "Steam rising from a warm puddle after rain and morning dew on cool grass.",
  },
  {
    match: /human\s*heart|heart\s*diagram|circulatory/i,
    title: "Human Heart & Blood Circulation",
    layout: "anatomy",
    accentColor: "#DC2626",
    caption: "Four-chambered muscular pump circulating oxygen-poor and oxygen-rich blood",
    summary:
      "The human heart has four chambers—two upper atria and two lower ventricles—that pump deoxygenated blood to the lungs and oxygenated blood to the entire body.",
    nodes: [
      { label: "Right Atrium", detail: "Receives oxygen-poor blood returning from the body." },
      { label: "Right Ventricle", detail: "Pumps oxygen-poor blood to the lungs via pulmonary artery." },
      { label: "Left Atrium", detail: "Receives fresh oxygen-rich blood from the lungs." },
      { label: "Left Ventricle", detail: "Pumps oxygen-rich blood through the aorta to the body." },
      { label: "Heart Valves", detail: "One-way flaps that keep blood flowing forward." },
      { label: "Septum Wall", detail: "Separates oxygen-rich and oxygen-poor blood sides." },
    ],
    formulaOrFact: "Average resting heart rate: 60 to 100 beats per minute (~100,000 beats/day).",
    realLifeExample: "When you run or climb stairs, your heart beats faster to deliver more oxygen to muscles.",
  },
  {
    match: /plant\s*cell|animal\s*cell|cell\s*structure/i,
    title: "Structure of a Cell",
    layout: "anatomy",
    accentColor: "#059669",
    caption: "Major organelles working together inside a living cell",
    summary:
      "Cells are the basic building blocks of life. Each organelle has a specialized job, from the nucleus controlling activities to mitochondria generating energy.",
    nodes: [
      { label: "Nucleus", detail: "Control center holding DNA instructions for the cell." },
      { label: "Mitochondria", detail: "Powerhouse that converts nutrients into usable energy (ATP)." },
      { label: "Cell Membrane", detail: "Protective outer layer controlling what enters and exits." },
      { label: "Cytoplasm", detail: "Jelly-like fluid holding all cell organelles in place." },
      { label: "Chloroplast / Vacuole", detail: "Makes food from light and stores water (in plant cells)." },
      { label: "Cell Wall", detail: "Rigid outer shield giving plant cells strength and shape." },
    ],
    formulaOrFact: "Plant cells have a cell wall, chloroplasts, and a large central vacuole.",
    realLifeExample: "Crisp green leaves stay upright because plant cell vacuoles are full of water.",
  },
  {
    match: /solar\s*system|planets/i,
    title: "Our Solar System",
    layout: "flow",
    accentColor: "#4F46E5",
    caption: "The Sun and eight planets orbiting in order from inner rocky worlds to outer giants",
    summary:
      "Our Solar System consists of the Sun at the center and eight planets held in orbit by gravity: four inner rocky planets and four outer gas and ice giants.",
    nodes: [
      { label: "The Sun", detail: "Central star containing 99.8% of the Solar System's mass." },
      { label: "Inner Rocky Planets", detail: "Mercury, Venus, Earth, and Mars — small & solid." },
      { label: "Gas Giants", detail: "Jupiter (largest) and Saturn (famous icy rings)." },
      { label: "Ice Giants", detail: "Uranus (tilted sideways) and Neptune (windy blue)." },
    ],
    formulaOrFact: "Mnemonic: My Very Educated Mother Just Served Us Noodles",
    realLifeExample: "Earth takes 365.25 days to orbit the Sun, which is why we add a leap day every 4 years.",
  },
  {
    match: /newton|laws?\s*of\s*motion/i,
    title: "Newton's Three Laws of Motion",
    layout: "flow",
    accentColor: "#4F46E5",
    caption: "How inertia, force, mass, acceleration, and action-reaction govern all motion",
    summary:
      "Isaac Newton's three laws explain why objects stay still or keep moving, how force accelerates mass (F = m × a), and why every action has an equal and opposite reaction.",
    nodes: [
      { label: "1st Law · Inertia", detail: "Objects keep their motion unless an outside force acts." },
      { label: "2nd Law · F = m × a", detail: "Greater force causes more acceleration; more mass resists it." },
      { label: "3rd Law · Action-Reaction", detail: "Every push produces an equal push in the opposite direction." },
      { label: "Everyday Physics", detail: "Explains rockets, seatbelts, sports balls, and walking." },
    ],
    formulaOrFact: "Force (N) = Mass (kg) × Acceleration (m/s²)",
    realLifeExample: "A rocket launches upward because hot gases push forcefully downward (3rd Law).",
  },
  {
    match: /electric\s*circuit|electricity|ohm/i,
    title: "Electric Circuit & Current Flow",
    layout: "cycle",
    accentColor: "#D97706",
    caption: "Closed loop allowing electric current to flow from power source to load",
    summary:
      "An electric circuit is a complete closed path containing a power source (battery), conducting wires, a switch, and a load (like a bulb) governed by Ohm's Law.",
    nodes: [
      { label: "1. Power Source", detail: "Battery provides voltage (push) to move electric charge." },
      { label: "2. Conductors", detail: "Copper wires carry flowing electrons around the loop." },
      { label: "3. Switch Control", detail: "Closes the loop to turn ON or opens it to turn OFF." },
      { label: "4. Load (Bulb/Motor)", detail: "Converts electrical energy into light, heat, or motion." },
    ],
    formulaOrFact: "Ohm's Law: V = I × R (Voltage = Current × Resistance)",
    realLifeExample: "Flipping a room light switch completes the circuit so current lights the LED bulb.",
  },
  {
    match: /digestive\s*system|digestion/i,
    title: "Human Digestive System",
    layout: "flow",
    accentColor: "#DC2626",
    caption: "Journey of food from mouth to nutrient absorption",
    summary:
      "Digestion breaks food down mechanically and chemically into tiny nutrients your bloodstream absorbs for growth and energy.",
    nodes: [
      { label: "1. Mouth & Esophagus", detail: "Teeth chew food; saliva starts breaking down starch." },
      { label: "2. Stomach", detail: "Acid and enzymes churn food into a thick liquid." },
      { label: "3. Small Intestine", detail: "Absorbs most vitamins, sugars, and proteins into blood." },
      { label: "4. Large Intestine", detail: "Reabsorbs water and prepares remaining waste for removal." },
    ],
    formulaOrFact: "Key helper organs: Liver (produces bile) and Pancreas (digestive enzymes).",
    realLifeExample: "Chewing bread longer tastes slightly sweet as saliva converts starch into simple sugar.",
  },
];

function findOfflineKnowledge(topic: string): OfflineKnowledgeEntry | null {
  for (const entry of OFFLINE_KNOWLEDGE_BASE) {
    if (entry.match.test(topic)) return entry;
  }
  return null;
}

/**
 * Safe, zero-eval arithmetic solver for instant offline math answers.
 */
export function tryOfflineMathEval(prompt: string): string | null {
  const cleaned = prompt
    .toLowerCase()
    .replace(/what\s+is|calculate|compute|solve|evaluate|find|=|\?/g, " ")
    .replace(/×/g, "*")
    .replace(/÷/g, "/")
    .replace(/\bplus\b/g, "+")
    .replace(/\bminus\b/g, "-")
    .replace(/\b(times|multiplied\s+by)\b/g, "*")
    .replace(/\bdivided\s+by\b/g, "/")
    .trim();

  // Percentage: "15% of 240"
  const pctMatch = cleaned.match(/^(\d+(?:\.\d+)?)\s*%\s*of\s*(\d+(?:\.\d+)?)$/);
  if (pctMatch) {
    const p = Number(pctMatch[1]);
    const base = Number(pctMatch[2]);
    const ans = (p / 100) * base;
    return `**${p}% of ${base} = ${Number(ans.toFixed(6))}**\n\n- Step 1: Convert ${p}% to decimal: ${p} ÷ 100 = ${p / 100}\n- Step 2: Multiply ${p / 100} × ${base} = **${Number(ans.toFixed(6))}**`;
  }

  // Square root: "sqrt 144" or "square root of 144"
  const sqrtMatch = cleaned.match(/^(?:sqrt|square\s+root\s+of)\s*\(?\s*(\d+(?:\.\d+)?)\s*\)?$/);
  if (sqrtMatch) {
    const n = Number(sqrtMatch[1]);
    const ans = Math.sqrt(n);
    return `**√${n} = ${Number(ans.toFixed(6))}**`;
  }

  // Pure arithmetic expression (digits, + - * / ( ) . ^)
  if (!/^[\d\s+\-*/().^]+$/.test(cleaned) || !/\d/.test(cleaned) || !/[+\-*/^]/.test(cleaned)) {
    return null;
  }

  try {
    const tokens = cleaned.match(/\d+(?:\.\d+)?|[+\-*/()^]/g);
    if (!tokens || tokens.length > 40) return null;
    let pos = 0;

    const parseExpr = (): number => {
      let left = parseTerm();
      while (tokens[pos] === "+" || tokens[pos] === "-") {
        const op = tokens[pos++];
        const right = parseTerm();
        left = op === "+" ? left + right : left - right;
      }
      return left;
    };

    const parseTerm = (): number => {
      let left = parsePower();
      while (tokens[pos] === "*" || tokens[pos] === "/") {
        const op = tokens[pos++];
        const right = parsePower();
        if (op === "/" && right === 0) throw new Error("Division by zero");
        left = op === "*" ? left * right : left / right;
      }
      return left;
    };

    const parsePower = (): number => {
      let left = parseFactor();
      if (tokens[pos] === "^") {
        pos++;
        const right = parsePower();
        left = Math.pow(left, right);
      }
      return left;
    };

    const parseFactor = (): number => {
      if (tokens[pos] === "-") {
        pos++;
        return -parseFactor();
      }
      if (tokens[pos] === "(") {
        pos++;
        const val = parseExpr();
        if (tokens[pos] === ")") pos++;
        return val;
      }
      const num = Number(tokens[pos++]);
      if (Number.isNaN(num)) throw new Error("Invalid number");
      return num;
    };

    const result = parseExpr();
    if (pos !== tokens.length || !Number.isFinite(result)) return null;
    const formatted = Number.isInteger(result) ? String(result) : String(Number(result.toFixed(6)));
    return `**Result: ${cleaned} = ${formatted}**`;
  } catch {
    return null;
  }
}

export function searchSavedStudyNotes(query: string): StudyNote[] {
  const notes = loadNotes();
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9\u0900-\u097f\u0b00-\u0b7f]+/i)
    .filter((t) => t.length >= 3);
  if (terms.length === 0) return [];

  const scored = notes
    .map((n) => {
      const hay = [
        n.title,
        n.subject,
        n.summary,
        ...n.keyPoints,
        ...n.definitions.map((d) => `${d.term} ${d.meaning}`),
      ]
        .join(" ")
        .toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (n.title.toLowerCase().includes(t)) score += 4;
        else if (hay.includes(t)) score += 1;
      }
      return { note: n, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, 3).map((x) => x.note);
}

/**
 * Builds a clean, textbook-grade 800x520 SVG vector diagram 100% locally.
 * Safe XML-escaped SVG rendered via <img src="data:image/svg+xml..." />.
 */
export function renderProceduralStudySvg(plan: StructuredDiagramPlan): string {
  const palette = pickPalette(plan.title);
  const accent = safeColor(plan.accentColor, palette.accent);
  const nodes = plan.nodes.slice(0, 6);
  const titleLines = wrapSvgLines(plan.title, 44, 1);
  const captionLines = wrapSvgLines(plan.caption, 78, 1);

  const nodeColors = ["#1D4ED8", "#059669", "#4F46E5", "#D97706", "#DC2626", "#0284C7"];

  let bodySvg = "";

  if (plan.layout === "cycle") {
    const cx = 400;
    const cy = 285;
    const rx = 225;
    const ry = 128;
    const count = Math.max(3, Math.min(nodes.length, 6));
    const displayNodes = nodes.slice(0, count);

    bodySvg += `
      <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke="${accent}" stroke-width="2.5" stroke-dasharray="8 6" opacity="0.45" />
      <circle cx="${cx}" cy="${cy}" r="58" fill="${palette.soft}" stroke="${accent}" stroke-width="3" />
    `;
    const centerLines = wrapSvgLines(plan.centerLabel || plan.title, 14, 3);
    centerLines.forEach((line, idx) => {
      const y = cy - (centerLines.length - 1) * 9 + idx * 18 + 5;
      bodySvg += `<text x="${cx}" y="${y}" text-anchor="middle" font-size="13" font-weight="700" fill="#0F172A">${escapeXml(line)}</text>`;
    });

    displayNodes.forEach((node, i) => {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / count;
      const nx = cx + Math.cos(angle) * rx;
      const ny = cy + Math.sin(angle) * ry;
      const cardW = 196;
      const cardH = 74;
      const x = Math.max(24, Math.min(800 - cardW - 24, nx - cardW / 2));
      const y = Math.max(96, Math.min(488 - cardH, ny - cardH / 2));
      const c = nodeColors[i % nodeColors.length];
      const lbl = wrapSvgLines(node.label, 22, 1)[0] || `Step ${i + 1}`;
      const detLines = wrapSvgLines(node.detail, 27, 2);

      // Arrow dot along ring midpoint
      const midAngle = angle + Math.PI / count;
      const ax = cx + Math.cos(midAngle) * (rx * 0.72);
      const ay = cy + Math.sin(midAngle) * (ry * 0.72);
      bodySvg += `<circle cx="${ax.toFixed(1)}" cy="${ay.toFixed(1)}" r="4" fill="${accent}" opacity="0.65" />`;

      bodySvg += `
        <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${cardW}" height="${cardH}" rx="12" fill="#FFFFFF" stroke="${c}" stroke-width="2" />
        <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${cardW}" height="24" rx="10" fill="${c}" />
        <rect x="${x.toFixed(1)}" y="${(y + 14).toFixed(1)}" width="${cardW}" height="10" fill="${c}" />
        <text x="${(x + 12).toFixed(1)}" y="${(y + 16).toFixed(1)}" font-size="12" font-weight="700" fill="#FFFFFF">${escapeXml(lbl)}</text>
      `;
      detLines.forEach((dl, li) => {
        bodySvg += `<text x="${(x + 12).toFixed(1)}" y="${(y + 42 + li * 16).toFixed(1)}" font-size="11" fill="#334155">${escapeXml(dl)}</text>`;
      });
    });
  } else if (plan.layout === "comparison") {
    const half = Math.ceil(nodes.length / 2);
    const leftNodes = nodes.slice(0, half);
    const rightNodes = nodes.slice(half);
    bodySvg += `
      <line x1="400" y1="106" x2="400" y2="478" stroke="#CBD5E1" stroke-width="2" stroke-dasharray="6 6" />
      <rect x="44" y="104" width="330" height="32" rx="8" fill="${accent}" />
      <text x="209" y="125" text-anchor="middle" font-size="13" font-weight="700" fill="#FFFFFF">Key Side A · Core Features</text>
      <rect x="426" y="104" width="330" height="32" rx="8" fill="#0F172A" />
      <text x="591" y="125" text-anchor="middle" font-size="13" font-weight="700" fill="#FFFFFF">Key Side B · Comparison</text>
    `;
    const renderCol = (items: DiagramNodeSpec[], startX: number, strokeCol: string) => {
      items.slice(0, 3).forEach((n, idx) => {
        const y = 152 + idx * 108;
        const lbl = wrapSvgLines(n.label, 34, 1)[0] || `Point ${idx + 1}`;
        const det = wrapSvgLines(n.detail, 42, 3);
        bodySvg += `
          <rect x="${startX}" y="${y}" width="330" height="94" rx="12" fill="#FFFFFF" stroke="${strokeCol}" stroke-width="1.8" />
          <text x="${startX + 16}" y="${y + 24}" font-size="13" font-weight="700" fill="#0F172A">${escapeXml(lbl)}</text>
        `;
        det.forEach((line, li) => {
          bodySvg += `<text x="${startX + 16}" y="${y + 46 + li * 16}" font-size="11.5" fill="#475569">${escapeXml(line)}</text>`;
        });
      });
    };
    renderCol(leftNodes, 44, accent);
    renderCol(rightNodes.length > 0 ? rightNodes : leftNodes, 426, "#475569");
  } else if (plan.layout === "flow") {
    const count = Math.max(3, Math.min(nodes.length, 4));
    const displayNodes = nodes.slice(0, count);
    const gap = 22;
    const marginX = 36;
    const cardW = Math.floor((800 - marginX * 2 - gap * (count - 1)) / count);
    const cardH = 260;
    const topY = 148;

    displayNodes.forEach((n, i) => {
      const x = marginX + i * (cardW + gap);
      const c = nodeColors[i % nodeColors.length];
      const lblLines = wrapSvgLines(n.label, 18, 2);
      const detLines = wrapSvgLines(n.detail, 21, 5);

      bodySvg += `
        <rect x="${x}" y="${topY}" width="${cardW}" height="${cardH}" rx="14" fill="#FFFFFF" stroke="${c}" stroke-width="2" />
        <circle cx="${x + cardW / 2}" cy="${topY}" r="18" fill="${c}" />
        <text x="${x + cardW / 2}" y="${topY + 5}" text-anchor="middle" font-size="13" font-weight="700" fill="#FFFFFF">${i + 1}</text>
      `;
      lblLines.forEach((ll, li) => {
        bodySvg += `<text x="${x + cardW / 2}" y="${topY + 46 + li * 18}" text-anchor="middle" font-size="13" font-weight="700" fill="#0F172A">${escapeXml(ll)}</text>`;
      });
      bodySvg += `<line x1="${x + 18}" y1="${topY + 84}" x2="${x + cardW - 18}" y2="${topY + 84}" stroke="#E2E8F0" stroke-width="1.5" />`;
      detLines.forEach((dl, li) => {
        bodySvg += `<text x="${x + 14}" y="${topY + 110 + li * 20}" font-size="12" fill="#334155">${escapeXml(dl)}</text>`;
      });

      if (i < count - 1) {
        const ax1 = x + cardW + 3;
        const ax2 = x + cardW + gap - 4;
        const ay = topY + cardH / 2;
        bodySvg += `
          <line x1="${ax1}" y1="${ay}" x2="${ax2 - 6}" y2="${ay}" stroke="${accent}" stroke-width="3" />
          <polygon points="${ax2},${ay} ${ax2 - 9},${ay - 6} ${ax2 - 9},${ay + 6}" fill="${accent}" />
        `;
      }
    });
  } else {
    // "anatomy" or "concept" — rich central visual badge + radial callout cards on left & right
    const cx = 400;
    const cy = 286;
    const displayNodes = nodes.slice(0, 6);
    const leftCount = Math.ceil(displayNodes.length / 2);
    const leftItems = displayNodes.slice(0, leftCount);
    const rightItems = displayNodes.slice(leftCount);

    // Decorative outer halo & central focal hub
    bodySvg += `
      <circle cx="${cx}" cy="${cy}" r="102" fill="${palette.soft}" stroke="${palette.border}" stroke-width="2" />
      <circle cx="${cx}" cy="${cy}" r="76" fill="#FFFFFF" stroke="${accent}" stroke-width="3.5" />
    `;
    const hubLines = wrapSvgLines(plan.centerLabel || plan.title, 15, 3);
    hubLines.forEach((hl, idx) => {
      const y = cy - (hubLines.length - 1) * 10 + idx * 20 + 5;
      bodySvg += `<text x="${cx}" y="${y}" text-anchor="middle" font-size="14" font-weight="700" fill="#0F172A">${escapeXml(hl)}</text>`;
    });

    const renderSide = (items: DiagramNodeSpec[], side: "left" | "right") => {
      const cardW = 228;
      const cardH = 92;
      const spacing = items.length <= 2 ? 140 : 114;
      const startY = cy - ((items.length - 1) * spacing) / 2 - cardH / 2;
      const x = side === "left" ? 28 : 800 - 28 - cardW;

      items.forEach((n, idx) => {
        const y = Math.max(102, Math.min(486 - cardH, startY + idx * spacing));
        const c = nodeColors[(side === "left" ? idx : idx + 3) % nodeColors.length];
        const anchorX = side === "left" ? x + cardW : x;
        const anchorY = y + cardH / 2;
        const hubEdgeX = side === "left" ? cx - 76 : cx + 76;
        const hubEdgeY = cy + (idx - (items.length - 1) / 2) * 26;

        bodySvg += `
          <line x1="${hubEdgeX}" y1="${hubEdgeY.toFixed(1)}" x2="${anchorX}" y2="${anchorY.toFixed(1)}" stroke="${c}" stroke-width="2.2" opacity="0.7" />
          <circle cx="${hubEdgeX}" cy="${hubEdgeY.toFixed(1)}" r="4.5" fill="${c}" />
          <rect x="${x}" y="${y.toFixed(1)}" width="${cardW}" height="${cardH}" rx="12" fill="#FFFFFF" stroke="${c}" stroke-width="2" />
          <rect x="${x}" y="${y.toFixed(1)}" width="6" height="${cardH}" rx="3" fill="${c}" />
        `;
        const lbl = wrapSvgLines(n.label, 24, 1)[0] || `Part ${idx + 1}`;
        const det = wrapSvgLines(n.detail, 29, 3);
        bodySvg += `<text x="${x + 16}" y="${(y + 24).toFixed(1)}" font-size="12.5" font-weight="700" fill="#0F172A">${escapeXml(lbl)}</text>`;
        det.forEach((line, li) => {
          bodySvg += `<text x="${x + 16}" y="${(y + 44 + li * 15).toFixed(1)}" font-size="11" fill="#475569">${escapeXml(line)}</text>`;
        });
      });
    };

    renderSide(leftItems, "left");
    renderSide(rightItems, "right");
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 520" width="800" height="520" font-family="system-ui, -apple-system, Segoe UI, sans-serif">
  <rect width="800" height="520" fill="#F8FAFC" />
  <rect x="0" y="0" width="800" height="82" fill="#FFFFFF" />
  <line x1="0" y1="82" x2="800" y2="82" stroke="#E2E8F0" stroke-width="1.5" />
  <rect x="24" y="20" width="6" height="42" rx="3" fill="${accent}" />
  <text x="42" y="42" font-size="21" font-weight="700" fill="#0F172A">${escapeXml(titleLines[0] || plan.title)}</text>
  <text x="42" y="64" font-size="12.5" fill="#64748B">${escapeXml(captionLines[0] || plan.caption)}</text>
  ${bodySvg}
  <text x="776" y="506" text-anchor="end" font-size="10.5" font-weight="600" fill="#94A3B8">Jogi Jarvis · On-Device Visual Study Diagram</text>
</svg>`;
}

function buildFallbackDiagramPlan(topic: string, rawText?: string): StructuredDiagramPlan {
  const title = cleanTopicTitle(topic);
  const known = findOfflineKnowledge(topic);
  if (known && !rawText) {
    return {
      title: known.title,
      caption: known.caption,
      layout: known.layout,
      accentColor: known.accentColor,
      centerLabel: known.title,
      nodes: known.nodes,
      summary: known.summary,
    };
  }

  const palette = pickPalette(title);
  const layout = known?.layout || inferDiagramLayout(title);

  // Extract bullet points or sentences from Local LLM text if available
  const extractedNodes: DiagramNodeSpec[] = [];
  if (rawText?.trim()) {
    const lines = rawText
      .split(/\n+/)
      .map((l) => l.replace(/^[-*•\d.)\s]+/, "").replace(/\*\*/g, "").trim())
      .filter((l) => l.length >= 12);
    for (const line of lines) {
      if (extractedNodes.length >= 6) break;
      const colonIdx = line.indexOf(":");
      if (colonIdx > 2 && colonIdx < 36) {
        extractedNodes.push({
          label: line.slice(0, colonIdx).trim(),
          detail: line.slice(colonIdx + 1).trim().slice(0, 95),
        });
      } else {
        const words = line.split(" ");
        extractedNodes.push({
          label: words.slice(0, 3).join(" ").slice(0, 26),
          detail: line.slice(0, 95),
        });
      }
    }
  }

  const nodes: DiagramNodeSpec[] =
    extractedNodes.length >= 3
      ? extractedNodes
      : known
        ? known.nodes
        : [
            {
              label: "1. Core Definition",
              detail: `Fundamental idea and meaning of ${title}.`,
            },
            {
              label: "2. Key Parts",
              detail: `Main components and elements that make up ${title}.`,
            },
            {
              label: "3. How It Works",
              detail: `Step-by-step process showing cause and effect in ${title}.`,
            },
            {
              label: "4. Real-World Use",
              detail: `Everyday examples and practical importance of ${title}.`,
            },
          ];

  return {
    title,
    caption: `Labeled visual study diagram of ${title}`,
    layout,
    accentColor: known?.accentColor || palette.accent,
    centerLabel: title,
    nodes,
    summary:
      rawText?.trim() ||
      known?.summary ||
      `Here is a clear labeled visual diagram breaking down **${title}** into its main concepts, steps, and real-world applications.`,
  };
}

async function fetchWikimediaPhotosIfOnline(query: string): Promise<StudyPhotoResult[]> {
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    return [];
  }
  try {
    const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(
      query
    )}&gsrnamespace=6&gsrlimit=6&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=640&format=json&origin=*`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4500) });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      query?: {
        pages?: Record<
          string,
          {
            title?: string;
            imageinfo?: Array<{
              thumburl?: string;
              url?: string;
              descriptionurl?: string;
              extmetadata?: { ImageDescription?: { value?: string } };
            }>;
          }
        >;
      };
    };
    const pages = Object.values(data.query?.pages || {});
    const photos: StudyPhotoResult[] = [];
    for (const p of pages) {
      const info = p.imageinfo?.[0];
      const imgUrl = info?.thumburl || info?.url;
      if (!imgUrl || /\.(svg|pdf|ogg|ogv|webm|djvu|tif|tiff)$/i.test(imgUrl)) continue;
      const cleanTitle = (p.title || "Study Reference")
        .replace(/^File:/i, "")
        .replace(/\.[^.]+$/, "")
        .replace(/[_-]+/g, " ")
        .trim();
      photos.push({
        title: cleanTitle.slice(0, 68),
        imageUrl: imgUrl,
        pageUrl: info?.descriptionurl || imgUrl,
        credit: "Wikimedia Commons",
      });
      if (photos.length >= 4) break;
    }
    return photos;
  } catch {
    return [];
  }
}

async function canRunLocalLlmNow(preferredKey?: string): Promise<string | null> {
  const key = getReadyLocalModelKey(preferredKey);
  if (!key) return null;
  // If already loaded in memory, ready immediately
  if (getLoadedLocalModelKey() === key) return key;
  // If offline, only run if the model is already cached in browser storage
  const isOnline = typeof navigator === "undefined" ? true : navigator.onLine;
  if (!isOnline && !getRecordedDownloadedModels().includes(key)) {
    return null;
  }
  const gpu = await checkWebGpuSupport();
  if (!gpu.supported) return null;
  return key;
}

/**
 * Generates a labeled visual Study Picture / Diagram 100% locally using the On-Device Local LLM
 * (or instant offline procedural engine if offline with no downloaded model yet).
 */
export async function generateLocalStudyPicture(options: {
  prompt: string;
  profile: FamilyProfile;
  subject?: string;
  language?: string;
  modelKey?: string;
  onProgress?: (info: LocalLlmProgress) => void;
}): Promise<LocalPictureResult> {
  const cleanTopic = cleanTopicTitle(options.prompt);
  const langRule =
    options.language && options.language !== "Auto-Detect"
      ? `Write labels, caption, and summary in ${options.language}.`
      : "Write in the same language as the user request.";

  let plan: StructuredDiagramPlan | null = null;
  let usedLocalLlm = false;

  const runnableModelKey = await canRunLocalLlmNow(options.modelKey);
  if (runnableModelKey) {
    try {
      const raw = await generateLocalLlmPrompt({
        modelKey: runnableModelKey,
        systemPrompt: [
          "You create structured educational visual diagram blueprints.",
          langRule,
          'Return ONLY valid JSON: {"title":"...","caption":"...","layout":"cycle|flow|anatomy|comparison|concept","nodes":[{"label":"short 2-4 words","detail":"short 1 sentence max 14 words"}],"summary":"2-3 clear sentences explaining the diagram"}. Provide 4 to 6 accurate nodes.',
        ].join(" "),
        userPrompt: `Create a study diagram for: ${options.prompt}${options.subject ? ` (Subject: ${options.subject})` : ""}`,
        maxTokens: 650,
        temperature: 0.3,
        onProgress: options.onProgress,
      });

      const parsed = parseLooseJson<{
        title?: string;
        caption?: string;
        layout?: string;
        accentColor?: string;
        nodes?: Array<{ label?: string; detail?: string }>;
        summary?: string;
      }>(raw);

      if (parsed && Array.isArray(parsed.nodes) && parsed.nodes.length >= 2) {
        const validNodes = parsed.nodes
          .map((n, i) => ({
            label: String(n?.label || `Part ${i + 1}`).trim().slice(0, 34),
            detail: String(n?.detail || "").trim().slice(0, 105),
          }))
          .filter((n) => n.label && n.detail)
          .slice(0, 6);

        if (validNodes.length >= 2) {
          const allowedLayouts: DiagramLayout[] = [
            "cycle",
            "flow",
            "anatomy",
            "comparison",
            "concept",
          ];
          const layout = allowedLayouts.includes(parsed.layout as DiagramLayout)
            ? (parsed.layout as DiagramLayout)
            : inferDiagramLayout(cleanTopic);
          const palette = pickPalette(cleanTopic);

          plan = {
            title: String(parsed.title || cleanTopic).trim().slice(0, 68),
            caption: String(
              parsed.caption || `Labeled visual study diagram of ${cleanTopic}`
            )
              .trim()
              .slice(0, 120),
            layout,
            accentColor: safeColor(parsed.accentColor, palette.accent),
            centerLabel: String(parsed.title || cleanTopic).trim().slice(0, 36),
            nodes: validNodes,
            summary: String(parsed.summary || "").trim(),
          };
          usedLocalLlm = true;
        }
      } else if (raw.trim().length > 30) {
        plan = buildFallbackDiagramPlan(options.prompt, raw);
        usedLocalLlm = true;
      }
    } catch {
      // Gracefully fall back to procedural offline diagram generator below
    }
  }

  if (!plan) {
    plan = buildFallbackDiagramPlan(options.prompt);
  }

  const svgCode = renderProceduralStudySvg(plan);
  const diagram: StudyDiagramMedia = {
    title: plan.title,
    caption: plan.caption,
    svgCode,
    scene3d: infer3DSceneBlueprint(plan.title, options.subject, plan.accentColor),
  };

  const photos = await fetchWikimediaPhotosIfOnline(cleanTopic);

  const bulletBreakdown = plan.nodes
    .map((n) => `- **${n.label}:** ${n.detail}`)
    .join("\n");
  const modeTag = usedLocalLlm
    ? `*(Generated on-device by Local AI${typeof navigator !== "undefined" && !navigator.onLine ? " · Offline Mode" : ""})*`
    : typeof navigator !== "undefined" && !navigator.onLine
      ? "*(Generated offline directly on your device)*"
      : "*(Generated locally on your device)*";

  const reply = [
    `### ${plan.title}`,
    plan.summary || plan.caption,
    "",
    bulletBreakdown,
    "",
    modeTag,
  ]
    .filter((line) => line !== undefined)
    .join("\n");

  return { reply, diagram, photos, usedLocalLlm };
}

function pickVisualAccent(
  topic: string,
  sceneIdx: number
): StudyVideoScene["visualAccent"] {
  const t = topic.toLowerCase();
  if (/(plant|leaf|photosynthesis|tree|cell|biology|forest)/i.test(t)) {
    const seq: StudyVideoScene["visualAccent"][] = ["leaf", "sun", "leaf", "chart", "book"];
    return seq[sceneIdx % seq.length];
  }
  if (/(heart|blood|human|body|digest|organ|medical)/i.test(t)) {
    const seq: StudyVideoScene["visualAccent"][] = ["heart", "wave", "heart", "chart", "book"];
    return seq[sceneIdx % seq.length];
  }
  if (/(water|ocean|rain|weather|wave|sound|light)/i.test(t)) {
    const seq: StudyVideoScene["visualAccent"][] = ["wave", "sun", "globe", "wave", "book"];
    return seq[sceneIdx % seq.length];
  }
  if (/(solar|planet|space|rocket|gravity|star|earth|geography)/i.test(t)) {
    const seq: StudyVideoScene["visualAccent"][] = ["rocket", "sun", "globe", "atom", "book"];
    return seq[sceneIdx % seq.length];
  }
  if (/(electric|circuit|computer|code|robot|ohm|current|volt)/i.test(t)) {
    const seq: StudyVideoScene["visualAccent"][] = ["circuit", "atom", "circuit", "chart", "book"];
    return seq[sceneIdx % seq.length];
  }
  if (/(atom|physics|newton|force|energy|chemistry|molecule)/i.test(t)) {
    const seq: StudyVideoScene["visualAccent"][] = ["atom", "rocket", "wave", "chart", "book"];
    return seq[sceneIdx % seq.length];
  }
  const defaults: StudyVideoScene["visualAccent"][] = ["book", "globe", "chart", "atom", "sun"];
  return defaults[sceneIdx % defaults.length];
}

function buildFallbackVideoStoryboard(
  topic: string,
  subject = "General",
  language?: string,
  rawLlmText?: string
): StudyVideoStoryboard {
  const title = cleanTopicTitle(topic);
  const known = findOfflineKnowledge(topic);
  const palette = pickPalette(title);

  if (known && !rawLlmText) {
    const scenes: StudyVideoScene[] = [
      {
        heading: `What Is ${known.title}?`,
        narration: `Let us learn ${known.title} slowly and simply. ${known.summary}`,
        keyFact: known.caption,
        visualAccent: pickVisualAccent(known.title, 0),
        bulletPoints: [known.caption, "Look calmly at the 3D physical model", "One simple idea at a time"],
        durationSec: 10,
      },
      {
        heading: "Look at the Main Parts",
        narration: `Look closely at the labels on the 3D model. ${known.nodes
          .slice(0, 2)
          .map((n) => `${n.label} means ${n.detail.toLowerCase()}.`)
          .join(" ")}`,
        keyFact: known.nodes[0] ? `${known.nodes[0].label}: ${known.nodes[0].detail}` : known.title,
        visualAccent: pickVisualAccent(known.title, 1),
        bulletPoints: known.nodes.slice(0, 3).map((n) => `${n.label}: ${n.detail}`),
        durationSec: 10,
      },
      {
        heading: "How It Works Step by Step",
        narration: `Now let us follow how it happens in order. ${known.nodes
          .slice(2)
          .map((n) => `${n.label}: ${n.detail}.`)
          .join(" ")}`,
        keyFact: known.nodes[2] ? `${known.nodes[2].label}: ${known.nodes[2].detail}` : known.caption,
        visualAccent: pickVisualAccent(known.title, 2),
        bulletPoints: known.nodes.slice(0, 3).map((n, i) => `${i + 1}. ${n.label}`),
        durationSec: 10,
      },
      {
        heading: "Real-Life Example",
        narration: `Here is an easy real-life example to help it click. ${known.realLifeExample}. Also remember: ${known.formulaOrFact}.`,
        keyFact: known.formulaOrFact,
        visualAccent: pickVisualAccent(known.title, 3),
        bulletPoints: [known.realLifeExample, known.formulaOrFact],
        durationSec: 10,
      },
      {
        heading: "Easy Way to Remember",
        narration: `Great job! To remember ${known.title} easily, just recall these simple parts in order: ${known.nodes
          .map((n) => n.label)
          .join(", ")}.`,
        keyFact: `Remember ${known.title} in ${known.nodes.length} easy steps`,
        visualAccent: pickVisualAccent(known.title, 4),
        bulletPoints: known.nodes.slice(0, 3).map((n) => `${n.label} — ${n.detail}`),
        durationSec: 10,
      },
    ];
    return {
      title: known.title,
      subtitle: known.caption,
      subject,
      themeColor: known.accentColor,
      language: language || "English",
      scenes,
    };
  }

  // If Local LLM produced free-text paragraphs/bullets, turn them into 5 calm, easy classroom steps
  const sentences = (rawLlmText || "")
    .replace(/\*\*/g, "")
    .split(/(?<=[.!?।])\s+|\n+/)
    .map((s) => s.replace(/^[-*•\d.)\s]+/, "").trim())
    .filter((s) => s.length >= 15);

  const s0 =
    sentences[0] ||
    `Let us understand ${title} calmly in five easy steps, looking closely at the 3D physical model.`;
  const s1 =
    sentences[1] ||
    `First, look at the main parts of ${title} and notice how each part has one simple job.`;
  const s2 =
    sentences[2] ||
    `Next, watch how each part works together slowly, one step after the other.`;
  const s3 =
    sentences[3] ||
    `Thinking about a familiar everyday example of ${title} makes it very easy to understand.`;
  const s4 =
    sentences[4] ||
    `To remember ${title}, pause and explain the main idea in your own simple words.`;

  const scenes: StudyVideoScene[] = [
    {
      heading: `What Is ${title}?`,
      narration: s0,
      keyFact: s0.slice(0, 84),
      visualAccent: pickVisualAccent(title, 0),
      bulletPoints: [s0.slice(0, 68), `Topic: ${title}`, "Simple 5-step lesson"],
      durationSec: 10,
    },
    {
      heading: "Look at the Main Parts",
      narration: s1,
      keyFact: s1.slice(0, 84),
      visualAccent: pickVisualAccent(title, 1),
      bulletPoints: [
        s1.slice(0, 72),
        (sentences[5] || `Main physical parts of ${title}`).slice(0, 72),
      ],
      durationSec: 10,
    },
    {
      heading: "How It Works Step by Step",
      narration: s2,
      keyFact: s2.slice(0, 84),
      visualAccent: pickVisualAccent(title, 2),
      bulletPoints: [
        s2.slice(0, 72),
        (sentences[6] || "Follow each simple step in order").slice(0, 72),
      ],
      durationSec: 10,
    },
    {
      heading: "Real-Life Example",
      narration: s3,
      keyFact: s3.slice(0, 84),
      visualAccent: pickVisualAccent(title, 3),
      bulletPoints: [
        s3.slice(0, 72),
        (sentences[7] || `Everyday example of ${title}`).slice(0, 72),
      ],
      durationSec: 10,
    },
    {
      heading: "Easy Way to Remember",
      narration: s4,
      keyFact: s4.slice(0, 84),
      visualAccent: pickVisualAccent(title, 4),
      bulletPoints: [s0.slice(0, 68), s2.slice(0, 68), s4.slice(0, 68)],
      durationSec: 10,
    },
  ];

  return {
    title,
    subtitle: `Calm 5-step physical 3D lesson for ${title}`,
    subject,
    themeColor: palette.accent,
    language: language || "English",
    scenes,
  };
}

/**
 * Generates a 5-scene narrated animated Study Video storyboard 100% locally on-device
 * (plays & exports .webm completely offline via StudyVideoPlayer).
 */
export async function generateLocalStudyVideo(options: {
  prompt: string;
  profile: FamilyProfile;
  subject?: string;
  language?: string;
  modelKey?: string;
  onProgress?: (info: LocalLlmProgress) => void;
}): Promise<LocalVideoResult> {
  const cleanTopic = cleanTopicTitle(options.prompt);
  const resolvedSubject = options.subject || "General";
  const langRule =
    options.language && options.language !== "Auto-Detect"
      ? `Write all headings, narrations, key facts, and bullet points in ${options.language}.`
      : "Write in the same language as the user request.";

  let storyboard: StudyVideoStoryboard | null = null;
  let usedLocalLlm = false;

  const runnableModelKey = await canRunLocalLlmNow(options.modelKey);
  if (runnableModelKey) {
    try {
      const raw = await generateLocalLlmPrompt({
        modelKey: runnableModelKey,
        systemPrompt: [
          "You are a warm, patient classroom teacher writing slow, simple 5-step educational video lessons for students using plain everyday words.",
          "Steps: 1) What Is It (simple analogy), 2) Main Physical Parts, 3) How It Works Step by Step (First, Then, Finally), 4) Real-Life Example, 5) Easy Way to Remember.",
          langRule,
          'Return ONLY valid JSON: {"title":"...","subtitle":"...","scenes":[{"heading":"...","narration":"2 simple calm spoken sentences","keyFact":"1 easy takeaway","bulletPoints":["short point 1","short point 2"],"visualAccent":"sun|atom|globe|wave|chart|book|leaf|rocket|circuit|heart","durationSec":10}]}. Provide exactly 5 scenes.',
        ].join(" "),
        userPrompt: `Create a calm, simple 5-step study video lesson about: ${options.prompt}${options.subject ? ` (Subject: ${options.subject})` : ""}`,
        maxTokens: 960,
        temperature: 0.3,
        onProgress: options.onProgress,
      });

      const parsed = parseLooseJson<{
        title?: string;
        subtitle?: string;
        themeColor?: string;
        accentColor?: string;
        scenes?: Array<{
          heading?: string;
          narration?: string;
          keyFact?: string;
          bulletPoints?: string[];
          bullets?: string[];
          visualAccent?: string;
          durationSec?: number;
        }>;
      }>(raw);

      if (parsed && Array.isArray(parsed.scenes) && parsed.scenes.length >= 3) {
        const validAccents = new Set<StudyVideoScene["visualAccent"]>([
          "sun",
          "atom",
          "globe",
          "wave",
          "chart",
          "book",
          "leaf",
          "rocket",
          "circuit",
          "heart",
        ]);
        const scenes: StudyVideoScene[] = parsed.scenes.slice(0, 5).map((sc, i) => {
          const rawBullets = Array.isArray(sc?.bulletPoints)
            ? sc.bulletPoints
            : Array.isArray(sc?.bullets)
              ? sc.bullets
              : [];
          const cleanedBullets = rawBullets
            .map((b) => String(b).trim().slice(0, 82))
            .filter(Boolean)
            .slice(0, 3);
          const heading = String(sc?.heading || `Step ${i + 1}`)
            .trim()
            .slice(0, 64);
          const narration = String(sc?.narration || heading || cleanTopic)
            .trim()
            .slice(0, 280);
          const visualAccent = validAccents.has(
            sc?.visualAccent as StudyVideoScene["visualAccent"]
          )
            ? (sc?.visualAccent as StudyVideoScene["visualAccent"])
            : pickVisualAccent(cleanTopic, i);
          return {
            heading,
            narration,
            keyFact: String(sc?.keyFact || cleanedBullets[0] || heading)
              .trim()
              .slice(0, 92),
            visualAccent,
            bulletPoints: cleanedBullets.length > 0 ? cleanedBullets : [heading],
            durationSec: Math.max(8, Math.min(12, Number(sc?.durationSec) || 10)),
          };
        });
        const palette = pickPalette(cleanTopic);
        storyboard = {
          title: String(parsed.title || cleanTopic).trim().slice(0, 68),
          subtitle: String(
            parsed.subtitle || `Calm 5-step physical 3D lesson for ${cleanTopic}`
          )
            .trim()
            .slice(0, 110),
          subject: resolvedSubject,
          themeColor: safeColor(
            parsed.themeColor || parsed.accentColor,
            palette.accent
          ),
          language:
            options.language && options.language !== "Auto-Detect"
              ? options.language
              : "English",
          scenes,
        };
        usedLocalLlm = true;
      } else if (raw.trim().length > 40) {
        storyboard = buildFallbackVideoStoryboard(
          options.prompt,
          resolvedSubject,
          options.language,
          raw
        );
        usedLocalLlm = true;
      }
    } catch {
      // Fall back to procedural offline storyboard below
    }
  }

  if (!storyboard) {
    storyboard = buildFallbackVideoStoryboard(
      options.prompt,
      resolvedSubject,
      options.language
    );
  }
  if (!storyboard.scene3d) {
    storyboard.scene3d = infer3DSceneBlueprint(
      storyboard.title,
      storyboard.subject,
      storyboard.themeColor
    );
  }

  const videoLinks: StudyVideoLink[] =
    typeof navigator === "undefined" || navigator.onLine
      ? [
          {
            title: `${cleanTopic} — YouTube Study Videos`,
            url: `https://www.youtube.com/results?search_query=${encodeURIComponent(
              `${cleanTopic} explained for students`
            )}`,
            source: "YouTube",
          },
          {
            title: `${cleanTopic} — Khan Academy Lessons`,
            url: `https://www.khanacademy.org/search?page_search_query=${encodeURIComponent(
              cleanTopic
            )}`,
            source: "Khan Academy",
          },
        ]
      : [];

  const modeNote = usedLocalLlm
    ? `*(Generated on-device by Local AI · Play & export .webm video even offline)*`
    : `*(Generated offline directly on your device · Play & export .webm video anytime)*`;

  const reply = `### ${storyboard.title}\n${storyboard.subtitle}\n\nYour ${storyboard.scenes.length}-scene narrated animated video is ready below — press **Play** to watch with voice narration or **Download .webm** to save it.\n\n${modeNote}`;

  return { reply, storyboard, videoLinks, usedLocalLlm };
}

/**
 * Local / Offline Search & Knowledge Lookup:
 * Combines locally saved Study Notes + On-Device Local LLM + offline math/knowledge + visual summary diagram.
 */
export async function generateLocalStudySearch(options: {
  query: string;
  profile: FamilyProfile;
  subject?: string;
  language?: string;
  modelKey?: string;
  onProgress?: (info: LocalLlmProgress) => void;
}): Promise<LocalSearchResult> {
  const query = options.query.trim();
  const matchedNotes = searchSavedStudyNotes(query);
  const mathAns = tryOfflineMathEval(query);
  const known = findOfflineKnowledge(query);
  const langRule =
    options.language && options.language !== "Auto-Detect"
      ? `Answer clearly in ${options.language}.`
      : "Answer in the same language as the user's query.";

  let llmAnswer = "";
  let usedLocalLlm = false;

  const runnableModelKey = await canRunLocalLlmNow(options.modelKey);
  if (runnableModelKey) {
    try {
      const notesContext =
        matchedNotes.length > 0
          ? `\n\nSaved Study Notes on this device:\n${matchedNotes
              .map((n) => `- ${n.title} (${n.subject}): ${n.summary}`)
              .join("\n")}`
          : "";
      llmAnswer = await generateLocalLlmPrompt({
        modelKey: runnableModelKey,
        systemPrompt: [
          "You are Jogi Jarvis running on-device. Provide a clear, accurate, well-structured answer with key facts, bullet points, and a practical example.",
          langRule,
        ].join(" "),
        userPrompt: `Answer and explain this topic clearly: ${query}${notesContext}`,
        maxTokens: 850,
        temperature: 0.4,
        onProgress: options.onProgress,
      });
      if (llmAnswer.trim()) {
        usedLocalLlm = true;
      }
    } catch {
      // Fall back to offline knowledge & notes below
    }
  }

  const sections: string[] = [];

  if (mathAns) {
    sections.push(mathAns);
  }

  if (llmAnswer.trim()) {
    sections.push(llmAnswer.trim());
  } else if (known) {
    sections.push(
      `### ${known.title}\n${known.summary}\n\n` +
        known.nodes.map((n) => `- **${n.label}:** ${n.detail}`).join("\n") +
        `\n\n**Key Fact / Formula:** ${known.formulaOrFact}\n\n**Real-Life Example:** ${known.realLifeExample}`
    );
  }

  if (matchedNotes.length > 0) {
    sections.push(
      `### Matching Saved Study Notes (Offline)\n` +
        matchedNotes
          .map(
            (n) =>
              `- **${n.title}** *(${n.subject})*: ${n.summary.slice(0, 200)}${n.summary.length > 200 ? "…" : ""}`
          )
          .join("\n")
    );
  }

  if (sections.length === 0) {
    const cachedModels = getRecordedDownloadedModels();
    const hint =
      cachedModels.length > 0
        ? `Your downloaded Local AI (${LOCAL_LLM_MODELS.find((m) => m.key === cachedModels[0])?.label || cachedModels[0]}) is ready for full offline answers.`
        : "Tip: While online once, download a small Local AI model like **Llama 3.2 1B** in the Engine bar so Jogi Jarvis can answer any question 100% offline forever.";
    sections.push(
      `### Offline Study Guide: ${cleanTopicTitle(query)}\nYou are currently offline, so live web search is paused. I created a structured visual study diagram below for **${cleanTopicTitle(query)}**.\n\n${hint}`
    );
  }

  const offlineBadge =
    typeof navigator !== "undefined" && !navigator.onLine
      ? "\n\n*(Offline Mode · Answered locally on your device without internet)*"
      : usedLocalLlm
        ? "\n\n*(Answered locally on your device by Local AI)*"
        : "";

  const plan = buildFallbackDiagramPlan(query, llmAnswer || undefined);
  const diagram: StudyDiagramMedia = {
    title: plan.title,
    caption: plan.caption,
    svgCode: renderProceduralStudySvg(plan),
  };

  const photos = await fetchWikimediaPhotosIfOnline(cleanTopicTitle(query));
  const videoLinks: StudyVideoLink[] =
    typeof navigator === "undefined" || navigator.onLine
      ? [
          {
            title: `${cleanTopicTitle(query)} — YouTube Study Videos`,
            url: `https://www.youtube.com/results?search_query=${encodeURIComponent(
              `${cleanTopicTitle(query)} explained`
            )}`,
            source: "YouTube",
          },
        ]
      : [];

  return {
    reply: sections.join("\n\n") + offlineBadge,
    sources: [],
    photos,
    videoLinks,
    diagram,
    usedLocalLlm,
  };
}

/**
 * Generates an instant offline Study Note when internet is unavailable or in Local AI mode.
 */
export async function generateLocalStudyNote(options: {
  topic: string;
  profile: FamilyProfile;
  subject: string;
  language?: string;
  modelKey?: string;
}): Promise<StudyNote> {
  const title = cleanTopicTitle(options.topic);
  const known = findOfflineKnowledge(options.topic);
  const now = new Date().toISOString();

  let noteData: {
    title?: string;
    subject?: string;
    summary?: string;
    keyPoints?: string[];
    definitions?: Array<{ term: string; meaning: string }>;
    practiceQuestions?: Array<{ question: string; answer: string }>;
    teacherTip?: string;
  } | null = null;

  const runnableModelKey = await canRunLocalLlmNow(options.modelKey);
  if (runnableModelKey) {
    try {
      const langRule =
        options.language && options.language !== "Auto-Detect"
          ? `Write the note in ${options.language}.`
          : "Write in the same language as the topic.";
      const raw = await generateLocalLlmPrompt({
        modelKey: runnableModelKey,
        systemPrompt: `You create structured study notes. ${langRule} Return ONLY JSON: {"title":"...","subject":"...","summary":"2-3 sentences","keyPoints":["p1","p2","p3","p4"],"definitions":[{"term":"...","meaning":"..."}],"practiceQuestions":[{"question":"...","answer":"..."}],"teacherTip":"1 helpful revision tip"}.`,
        userPrompt: `Create a study note for: ${options.topic} (Subject: ${options.subject})`,
        maxTokens: 850,
        temperature: 0.35,
      });
      noteData = parseLooseJson(raw);
    } catch {
      // fall through to offline template
    }
  }

  return {
    id: `note-local-${Date.now()}`,
    profileId: options.profile.id,
    profileName: options.profile.name,
    title: noteData?.title || known?.title || title,
    subject: noteData?.subject || options.subject || "General",
    summary:
      noteData?.summary ||
      known?.summary ||
      `${title} is an important concept in ${options.subject || "study"}. Review the core ideas, key terms, and self-test questions below to master it.`,
    keyPoints:
      Array.isArray(noteData?.keyPoints) && noteData.keyPoints.length > 0
        ? noteData.keyPoints
        : known
          ? known.nodes.map((n) => `${n.label}: ${n.detail}`)
          : [
              `Understand the core definition and purpose of ${title}.`,
              `Break ${title} into clear step-by-step parts.`,
              `Connect ${title} to real-life examples to remember it easily.`,
            ],
    definitions:
      Array.isArray(noteData?.definitions) && noteData.definitions.length > 0
        ? noteData.definitions
        : known
          ? known.nodes.slice(0, 4).map((n) => ({ term: n.label, meaning: n.detail }))
          : [{ term: title, meaning: `Core concept covered in this ${options.subject || "study"} note.` }],
    practiceQuestions:
      Array.isArray(noteData?.practiceQuestions) &&
      noteData.practiceQuestions.length > 0
        ? noteData.practiceQuestions
        : known
          ? [
              {
                question: `What is ${known.title} in your own words?`,
                answer: known.summary,
              },
              {
                question: `Give one real-life example of ${known.title}.`,
                answer: known.realLifeExample,
              },
            ]
          : [
              {
                question: `Explain the main idea of ${title} in 2–3 sentences.`,
                answer: `Focus on what ${title} is, how its main parts work together, and one real-world example.`,
              },
            ],
    teacherTip:
      noteData?.teacherTip ||
      (known ? `Remember: ${known.formulaOrFact}` : `Try explaining ${title} aloud in your own words to lock it into memory.`),
    createdAt: now,
    updatedAt: now,
    sourceMode: "topic",
  };
}

/**
 * Ultimate offline chat fallback: never fails when internet is disconnected.
 */
export function buildInstantOfflineChatFallback(prompt: string): {
  reply: string;
  diagram?: StudyDiagramMedia;
} {
  const mathAns = tryOfflineMathEval(prompt);
  if (mathAns) {
    return {
      reply: `${mathAns}\n\n*(Calculated instantly offline on your device)*`,
    };
  }

  const matchedNotes = searchSavedStudyNotes(prompt);
  const known = findOfflineKnowledge(prompt);
  const parts: string[] = [];

  if (known) {
    parts.push(
      `### ${known.title}\n${known.summary}\n\n` +
        known.nodes.map((n) => `- **${n.label}:** ${n.detail}`).join("\n") +
        `\n\n**Key Fact:** ${known.formulaOrFact}\n**Example:** ${known.realLifeExample}`
    );
  }

  if (matchedNotes.length > 0) {
    parts.push(
      `### From Your Saved Study Notes\n` +
        matchedNotes
          .map(
            (n) =>
              `- **${n.title}** *(${n.subject})*: ${n.summary}\n  ${n.keyPoints
                .slice(0, 2)
                .map((kp) => `• ${kp}`)
                .join("\n  ")}`
          )
          .join("\n")
    );
  }

  if (parts.length > 0) {
    return {
      reply:
        parts.join("\n\n") +
        "\n\n*(Answered offline directly on your device — you can also tap **Picture** or **Video** below to generate offline visual diagrams & animated videos!)*",
      diagram: known
        ? {
            title: known.title,
            caption: known.caption,
            svgCode: renderProceduralStudySvg({
              title: known.title,
              caption: known.caption,
              layout: known.layout,
              accentColor: known.accentColor,
              centerLabel: known.title,
              nodes: known.nodes,
              summary: known.summary,
            }),
          }
        : undefined,
    };
  }

  const title = cleanTopicTitle(prompt);
  return {
    reply: [
      `### Offline Assistant · ${title}`,
      `You're currently offline and no Local AI model is downloaded in this browser yet, so I've built an instant visual study framework below for **${title}**.`,
      "",
      "**What works right now even with zero internet:**",
      "- Tap **Picture** to generate & download labeled PNG/SVG diagrams offline",
      "- Tap **Video** to generate & download narrated 5-scene `.webm` videos offline",
      "- Solve arithmetic, percentages & roots instantly",
      "- Search & read all your saved **Study Notes** with offline voice playback",
      "",
      "**Want unlimited offline AI answers on ANY question?** Next time you're briefly online, pick **Local AI (Unlimited)** in the Engine bar and click **Download** on **Llama 3.2 1B** (~700 MB) — once cached, it answers everything 100% offline forever!",
    ].join("\n"),
    diagram: {
      title,
      caption: `Offline visual study map for ${title}`,
      svgCode: renderProceduralStudySvg(buildFallbackDiagramPlan(prompt)),
    },
  };
}
