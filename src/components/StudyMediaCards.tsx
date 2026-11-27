import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Download,
  ExternalLink,
  Film,
  Image as ImageIcon,
  Layers,
  Loader2,
  Maximize2,
  Pause,
  Play,
  RotateCcw,
  Sun,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import type {
  Study3DSceneBlueprint,
  StudyDiagramMedia,
  StudyPhotoResult,
  StudyVideoLink,
  StudyVideoScene,
  StudyVideoStoryboard,
} from "../types";
import {
  infer3DSceneBlueprint,
  Study3DViewportEngine,
  type CameraPreset,
  type LightingPreset,
} from "../utils/study3dEngine";

function slugifyFilename(text: string, fallback: string): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return cleaned || fallback;
}

function getSpeechLangCode(language?: string): string {
  const map: Record<string, string> = {
    English: "en-IN",
    Hindi: "hi-IN",
    Odia: "or-IN",
    Bengali: "bn-IN",
    Tamil: "ta-IN",
    Telugu: "te-IN",
    Marathi: "mr-IN",
    Gujarati: "gu-IN",
    Punjabi: "pa-IN",
    Kannada: "kn-IN",
    Malayalam: "ml-IN",
    Urdu: "ur-PK",
    Spanish: "es-ES",
    French: "fr-FR",
    German: "de-DE",
    Arabic: "ar-SA",
    Japanese: "ja-JP",
    Korean: "ko-KR",
    Chinese: "zh-CN",
  };
  return (language && map[language]) || "en-IN";
}

function safeHexColor(color?: string): string {
  if (color && /^#[0-9a-fA-F]{6}$/.test(color.trim())) {
    return color.trim();
  }
  return "#2563EB";
}

function Interactive3DSceneStage({
  blueprint,
  heightClass = "h-[330px] sm:h-[380px]",
  onEngineReady,
}: {
  blueprint: Study3DSceneBlueprint;
  heightClass?: string;
  onEngineReady?: (engine: Study3DViewportEngine | null) => void;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<Study3DViewportEngine | null>(null);
  const onEngineReadyRef = useRef(onEngineReady);
  onEngineReadyRef.current = onEngineReady;

  const [cameraPreset, setCameraPreset] = useState<CameraPreset>("hero");
  const [lightingPreset, setLightingPreset] = useState<LightingPreset>("studio");
  const [autoRotate, setAutoRotate] = useState(true);
  const [webglError, setWebglError] = useState(false);

  // Isolated WebGL lifecycle (never tears down on control state changes)
  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    let engine: Study3DViewportEngine | null = null;
    try {
      const rect = container.getBoundingClientRect();
      const width = Math.max(320, Math.round(rect.width || 640));
      const height = Math.max(220, Math.round(rect.height || 360));
      engine = new Study3DViewportEngine({
        width,
        height,
        interactive: true,
      });
      engine.domElement.className = "w-full h-full block cursor-grab active:cursor-grabbing";
      container.innerHTML = "";
      container.appendChild(engine.domElement);
      engine.loadBlueprint(blueprint);
      engine.startLoop();
      engineRef.current = engine;
      onEngineReadyRef.current?.(engine);
      setWebglError(false);
    } catch {
      setWebglError(true);
      onEngineReadyRef.current?.(null);
      return;
    }

    const ro = new ResizeObserver(() => {
      if (!mountRef.current || !engineRef.current) return;
      const r = mountRef.current.getBoundingClientRect();
      if (r.width > 10 && r.height > 10) {
        engineRef.current.resize(Math.round(r.width), Math.round(r.height));
      }
    });
    ro.observe(container);

    return () => {
      ro.disconnect();
      onEngineReadyRef.current?.(null);
      engine?.dispose();
      engineRef.current = null;
      if (container) container.innerHTML = "";
    };
  }, [blueprint]);

  if (webglError) {
    return (
      <div className={`w-full ${heightClass} bg-slate-900 text-slate-300 flex items-center justify-center text-xs px-4 text-center`}>
        3D WebGL preview is unavailable on this browser—switch to the 2D Diagram tab above.
      </div>
    );
  }

  return (
    <div className="relative w-full bg-slate-950 overflow-hidden select-none">
      {/* Isolated WebGL canvas mount */}
      <div ref={mountRef} className={`w-full ${heightClass}`} />

      {/* Top-left subtle static badge (no backdrop-blur over WebGL) */}
      <div className="pointer-events-none absolute top-3 left-3 px-2.5 py-1 rounded-md bg-slate-950/85 border border-slate-700/70 text-[11px] font-semibold text-sky-300 flex items-center gap-1.5">
        <Box className="h-3 w-3 shrink-0" />
        <span>Interactive 3D Real Render · Drag to Orbit</span>
      </div>

      {/* Unified bottom control dock (solid surface, zero viewport occlusion) */}
      <div className="px-3 py-2 bg-slate-900 border-t border-slate-800 flex flex-wrap items-center justify-between gap-2 text-[11px]">
        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-slate-400 font-medium mr-1">View:</span>
          {(["hero", "closeup", "top", "side"] as const).map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => {
                setCameraPreset(preset);
                engineRef.current?.setCameraPreset(preset);
              }}
              className={`px-2 py-0.5 rounded font-semibold capitalize transition-colors ${
                cameraPreset === preset
                  ? "bg-sky-500 text-slate-950"
                  : "bg-slate-800 text-slate-300 hover:bg-slate-700"
              }`}
            >
              {preset === "closeup" ? "Close" : preset}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              const next = !autoRotate;
              setAutoRotate(next);
              engineRef.current?.setAutoRotate(next);
            }}
            className={`px-2 py-0.5 rounded font-semibold transition-colors ${
              autoRotate
                ? "bg-blue-600 text-white"
                : "bg-slate-800 text-slate-300 hover:bg-slate-700"
            }`}
          >
            {autoRotate ? "Spin On" : "Spin Off"}
          </button>
        </div>

        <div className="flex items-center gap-1">
          <Sun className="h-3 w-3 text-amber-400 mr-0.5" />
          {(["studio", "dramatic", "daylight"] as const).map((light) => (
            <button
              key={light}
              type="button"
              onClick={() => {
                setLightingPreset(light);
                engineRef.current?.setLightingPreset(light);
              }}
              className={`px-2 py-0.5 rounded font-semibold capitalize transition-colors ${
                lightingPreset === light
                  ? "bg-amber-400 text-slate-950"
                  : "bg-slate-800 text-slate-300 hover:bg-slate-700"
              }`}
            >
              {light}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function StudyDiagramCard({ diagram }: { diagram: StudyDiagramMedia }) {
  const [viewMode, setViewMode] = useState<"3d" | "2d">("3d");
  const [expanded, setExpanded] = useState(false);
  const [downloadingPng, setDownloadingPng] = useState(false);
  const inline3dEngineRef = useRef<Study3DViewportEngine | null>(null);
  const modal3dEngineRef = useRef<Study3DViewportEngine | null>(null);

  const resolvedBlueprint = useMemo<Study3DSceneBlueprint>(
    () =>
      diagram.scene3d ||
      infer3DSceneBlueprint(diagram.title, diagram.caption),
    [diagram.scene3d, diagram.title, diagram.caption]
  );

  const svgDataUrl = useMemo(() => {
    const encoded = encodeURIComponent(diagram.svgCode);
    return `data:image/svg+xml;charset=utf-8,${encoded}`;
  }, [diagram.svgCode]);

  const handleDownloadSvg = () => {
    const blob = new Blob([diagram.svgCode], {
      type: "image/svg+xml;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slugifyFilename(diagram.title, "study-diagram")}.svg`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handleDownloadPng = async () => {
    setDownloadingPng(true);
    try {
      // When in 3D Real Render mode, capture high-res WebGL 3D PNG directly!
      const active3dEngine = expanded
        ? modal3dEngineRef.current || inline3dEngineRef.current
        : inline3dEngineRef.current;

      if (viewMode === "3d" && active3dEngine) {
        const pngUrl = active3dEngine.capturePngDataUrl(diagram.title);
        if (pngUrl) {
          const a = document.createElement("a");
          a.href = pngUrl;
          a.download = `${slugifyFilename(diagram.title, "3d-real-image")}-3d.png`;
          a.click();
          return;
        }
      }

      const img = new Image();
      img.crossOrigin = "anonymous";
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Failed to render SVG"));
        img.src = svgDataUrl;
      });
      const canvas = document.createElement("canvas");
      canvas.width = 1600;
      canvas.height = 1040;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const pngUrl = canvas.toDataURL("image/png");
      const a = document.createElement("a");
      a.href = pngUrl;
      a.download = `${slugifyFilename(diagram.title, "study-diagram")}.png`;
      a.click();
    } catch {
      handleDownloadSvg();
    } finally {
      setDownloadingPng(false);
    }
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/70 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 bg-white border-b border-slate-200">
        <div className="flex items-center gap-2 min-w-0">
          {viewMode === "3d" ? (
            <Box className="h-4 w-4 text-sky-600 shrink-0" />
          ) : (
            <ImageIcon className="h-4 w-4 text-blue-700 shrink-0" />
          )}
          <div className="min-w-0">
            <p className="text-xs font-semibold text-slate-900 truncate">
              {diagram.title}
            </p>
            {diagram.caption && (
              <p className="text-[11px] text-slate-500 truncate">
                {diagram.caption}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
          <div className="inline-flex items-center rounded-md bg-slate-100 p-0.5">
            <button
              type="button"
              onClick={() => setViewMode("3d")}
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold transition-colors ${
                viewMode === "3d"
                  ? "bg-slate-900 text-sky-300"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              <Box className="h-3 w-3" />
              <span>3D Real</span>
            </button>
            <button
              type="button"
              onClick={() => setViewMode("2d")}
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold transition-colors ${
                viewMode === "2d"
                  ? "bg-blue-700 text-white"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              <Layers className="h-3 w-3" />
              <span>2D Diagram</span>
            </button>
          </div>
          <button
            type="button"
            disabled={downloadingPng}
            onClick={() => void handleDownloadPng()}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-semibold bg-blue-700 hover:bg-blue-800 text-white disabled:opacity-50 transition-colors whitespace-nowrap"
          >
            {downloadingPng ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Download className="h-3 w-3" />
            )}
            <span>{viewMode === "3d" ? "3D PNG" : "PNG"}</span>
          </button>
          {viewMode === "2d" && (
            <button
              type="button"
              onClick={handleDownloadSvg}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium bg-white border border-slate-200 text-slate-700 hover:bg-slate-100 transition-colors whitespace-nowrap"
            >
              <span>SVG</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => setExpanded(true)}
            aria-label="Expand 3D visual"
            className="inline-flex items-center justify-center h-7 w-7 rounded-md bg-white border border-slate-200 text-slate-600 hover:text-slate-900 hover:bg-slate-100 transition-colors"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {viewMode === "3d" ? (
        <Interactive3DSceneStage
          blueprint={resolvedBlueprint}
          onEngineReady={(engine) => {
            inline3dEngineRef.current = engine;
          }}
        />
      ) : (
        <div className="p-3 bg-white flex items-center justify-center">
          <img
            src={svgDataUrl}
            alt={diagram.title}
            referrerPolicy="no-referrer"
            className="w-full max-h-[420px] object-contain rounded-lg border border-slate-100 cursor-zoom-in"
            onClick={() => setExpanded(true)}
          />
        </div>
      )}

      {expanded && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/85 flex items-center justify-center p-4"
          onClick={() => setExpanded(false)}
        >
          <div
            className="bg-white rounded-2xl max-w-5xl w-full max-h-[92vh] flex flex-col overflow-hidden shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-200">
              <p className="text-sm font-semibold text-slate-900 truncate">
                {diagram.title}
              </p>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => void handleDownloadPng()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-700 hover:bg-blue-800 text-white"
                >
                  <Download className="h-3.5 w-3.5" />
                  <span>{viewMode === "3d" ? "Download 3D PNG" : "Download PNG"}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setExpanded(false)}
                  aria-label="Close preview"
                  className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            {viewMode === "3d" ? (
              <Interactive3DSceneStage
                blueprint={resolvedBlueprint}
                heightClass="h-[68vh]"
                onEngineReady={(engine) => {
                  modal3dEngineRef.current = engine;
                }}
              />
            ) : (
              <div className="p-4 overflow-auto flex-1 flex items-center justify-center bg-slate-50">
                <img
                  src={svgDataUrl}
                  alt={diagram.title}
                  referrerPolicy="no-referrer"
                  className="max-w-full max-h-[75vh] object-contain rounded-lg bg-white"
                />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function StudyPhotoGallery({ photos }: { photos: StudyPhotoResult[] }) {
  const [brokenUrls, setBrokenUrls] = useState<Set<string>>(new Set());

  const visiblePhotos = photos.filter((p) => !brokenUrls.has(p.imageUrl));
  if (visiblePhotos.length === 0) return null;

  return (
    <div className="pt-3 border-t border-slate-100 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-slate-600">
          Reference Study Pictures
        </p>
        <span className="text-[11px] text-slate-400">Wikimedia Commons</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        {visiblePhotos.map((photo) => (
          <a
            key={photo.imageUrl}
            href={photo.pageUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="group rounded-xl overflow-hidden border border-slate-200 bg-slate-50 hover:border-blue-300 transition-colors flex flex-col"
          >
            <div className="aspect-[4/3] w-full bg-slate-100 overflow-hidden">
              <img
                src={photo.imageUrl}
                alt={photo.title}
                loading="lazy"
                referrerPolicy="no-referrer"
                onError={() =>
                  setBrokenUrls((prev) => new Set(prev).add(photo.imageUrl))
                }
                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
              />
            </div>
            <div className="px-2 py-1.5 flex items-center justify-between gap-1">
              <p className="text-[11px] font-medium text-slate-700 truncate">
                {photo.title}
              </p>
              <ExternalLink className="h-3 w-3 text-slate-400 group-hover:text-blue-700 shrink-0" />
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}

function wrapCanvasLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number
): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let current = words[0];

  for (let i = 1; i < words.length; i += 1) {
    const test = `${current} ${words[i]}`;
    if (ctx.measureText(test).width <= maxWidth) {
      current = test;
    } else {
      lines.push(current);
      current = words[i];
      if (lines.length === maxLines - 1) {
        const rest = words.slice(i).join(" ");
        let trimmed = rest;
        while (trimmed.length > 3 && ctx.measureText(`${trimmed}…`).width > maxWidth) {
          trimmed = trimmed.slice(0, -1);
        }
        lines.push(rest === trimmed ? trimmed : `${trimmed}…`);
        return lines;
      }
    }
  }
  lines.push(current);
  return lines.slice(0, maxLines);
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawSceneVisualAccent(
  ctx: CanvasRenderingContext2D,
  accent: StudyVideoScene["visualAccent"],
  cx: number,
  cy: number,
  t: number,
  color: string
) {
  ctx.save();
  ctx.translate(cx, cy);

  // Soft glowing halo
  const halo = ctx.createRadialGradient(0, 0, 12, 0, 0, 118);
  halo.addColorStop(0, `${color}55`);
  halo.addColorStop(1, "rgba(15, 23, 42, 0)");
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(0, 0, 118, 0, Math.PI * 2);
  ctx.fill();

  switch (accent) {
    case "atom": {
      ctx.strokeStyle = "#93C5FD";
      ctx.lineWidth = 2.5;
      for (let i = 0; i < 3; i += 1) {
        ctx.save();
        ctx.rotate((i * Math.PI) / 3 + t * 0.45);
        ctx.beginPath();
        ctx.ellipse(0, 0, 76, 28, 0, 0, Math.PI * 2);
        ctx.stroke();
        const angle = t * 2.1 + i * 2.1;
        ctx.fillStyle = "#FDE047";
        ctx.beginPath();
        ctx.arc(Math.cos(angle) * 76, Math.sin(angle) * 28, 6.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(0, 0, 16 + Math.sin(t * 3) * 2, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "sun": {
      ctx.strokeStyle = "#FBBF24";
      ctx.lineWidth = 4;
      for (let i = 0; i < 12; i += 1) {
        const a = (i * Math.PI) / 6 + t * 0.35;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * 44, Math.sin(a) * 44);
        ctx.lineTo(Math.cos(a) * 72, Math.sin(a) * 72);
        ctx.stroke();
      }
      ctx.fillStyle = "#F59E0B";
      ctx.beginPath();
      ctx.arc(0, 0, 34 + Math.sin(t * 2.5) * 2.5, 0, Math.PI * 2);
      ctx.fill();
      // Orbiting planet
      ctx.fillStyle = "#38BDF8";
      ctx.beginPath();
      ctx.arc(Math.cos(t * 1.2) * 86, Math.sin(t * 1.2) * 50, 10, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "globe": {
      ctx.strokeStyle = "#60A5FA";
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.arc(0, 0, 64, 0, Math.PI * 2);
      ctx.stroke();
      for (let i = -2; i <= 2; i += 1) {
        const ry = i * 22;
        const rx = Math.sqrt(Math.max(0, 64 * 64 - ry * ry));
        ctx.beginPath();
        ctx.moveTo(-rx, ry);
        ctx.lineTo(rx, ry);
        ctx.stroke();
      }
      for (let i = 0; i < 3; i += 1) {
        const w = Math.abs(Math.cos(t * 0.7 + i * 1.05)) * 64;
        ctx.beginPath();
        ctx.ellipse(0, 0, Math.max(8, w), 64, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = "#34D399";
      ctx.beginPath();
      ctx.arc(Math.cos(t * 1.4) * 84, Math.sin(t * 1.4) * 40, 7, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "wave": {
      for (let layer = 0; layer < 3; layer += 1) {
        ctx.strokeStyle = layer === 0 ? "#38BDF8" : layer === 1 ? "#818CF8" : "#34D399";
        ctx.lineWidth = 3.5 - layer * 0.7;
        ctx.beginPath();
        for (let x = -85; x <= 85; x += 4) {
          const y =
            Math.sin((x + t * (70 + layer * 25)) * 0.055) * (34 - layer * 7) +
            (layer - 1) * 14;
          if (x === -85) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      break;
    }
    case "chart": {
      const heights = [48, 82, 64, 108, 92];
      ctx.strokeStyle = "rgba(148, 163, 184, 0.5)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-82, 58);
      ctx.lineTo(84, 58);
      ctx.stroke();
      heights.forEach((h, i) => {
        const anim = Math.min(1, Math.max(0.15, Math.sin(t * 1.4 - i * 0.3) * 0.15 + 0.85));
        const barH = h * anim;
        ctx.fillStyle = i % 2 === 0 ? color : "#38BDF8";
        drawRoundedRect(ctx, -74 + i * 32, 58 - barH, 22, barH, 5);
        ctx.fill();
      });
      break;
    }
    case "leaf": {
      ctx.save();
      ctx.rotate(Math.sin(t * 1.2) * 0.08);
      ctx.fillStyle = "#10B981";
      ctx.beginPath();
      ctx.moveTo(0, 62);
      ctx.quadraticCurveTo(66, 22, 0, -68);
      ctx.quadraticCurveTo(-66, 22, 0, 62);
      ctx.fill();
      ctx.strokeStyle = "#ECFDF5";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(0, 66);
      ctx.lineTo(0, -48);
      ctx.stroke();
      for (let i = -1; i <= 1; i += 1) {
        const y = i * 24;
        ctx.beginPath();
        ctx.moveTo(0, y + 10);
        ctx.lineTo(26, y - 8);
        ctx.moveTo(0, y + 10);
        ctx.lineTo(-26, y - 8);
        ctx.stroke();
      }
      ctx.restore();
      // Rising oxygen bubbles
      for (let i = 0; i < 4; i += 1) {
        const prog = (t * 0.55 + i * 0.25) % 1;
        ctx.fillStyle = `rgba(186, 230, 253, ${1 - prog})`;
        ctx.beginPath();
        ctx.arc(-44 + i * 30, 40 - prog * 115, 5, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case "rocket": {
      const bob = Math.sin(t * 3) * 7;
      ctx.save();
      ctx.translate(0, bob);
      // Flame
      ctx.fillStyle = "#F59E0B";
      ctx.beginPath();
      ctx.moveTo(-12, 36);
      ctx.lineTo(0, 68 + Math.sin(t * 18) * 9);
      ctx.lineTo(12, 36);
      ctx.closePath();
      ctx.fill();
      // Body
      ctx.fillStyle = "#F8FAFC";
      ctx.beginPath();
      ctx.moveTo(0, -64);
      ctx.quadraticCurveTo(28, -22, 22, 36);
      ctx.lineTo(-22, 36);
      ctx.quadraticCurveTo(-28, -22, 0, -64);
      ctx.fill();
      // Fins
      ctx.fillStyle = "#EF4444";
      ctx.beginPath();
      ctx.moveTo(-22, 10);
      ctx.lineTo(-42, 42);
      ctx.lineTo(-18, 36);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(22, 10);
      ctx.lineTo(42, 42);
      ctx.lineTo(18, 36);
      ctx.closePath();
      ctx.fill();
      // Window
      ctx.fillStyle = "#38BDF8";
      ctx.beginPath();
      ctx.arc(0, -14, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      break;
    }
    case "circuit": {
      ctx.strokeStyle = "#38BDF8";
      ctx.lineWidth = 3;
      const nodes: Array<[number, number]> = [
        [-64, -42],
        [0, -42],
        [64, -18],
        [-58, 34],
        [10, 34],
        [64, 46],
      ];
      ctx.beginPath();
      ctx.moveTo(-64, -42);
      ctx.lineTo(0, -42);
      ctx.lineTo(0, 34);
      ctx.lineTo(-58, 34);
      ctx.moveTo(0, -18);
      ctx.lineTo(64, -18);
      ctx.moveTo(0, 34);
      ctx.lineTo(10, 34);
      ctx.lineTo(64, 46);
      ctx.stroke();
      nodes.forEach(([nx, ny], idx) => {
        const pulse = (Math.sin(t * 3.5 + idx) + 1) / 2;
        ctx.fillStyle = pulse > 0.5 ? "#34D399" : "#93C5FD";
        ctx.beginPath();
        ctx.arc(nx, ny, 7 + pulse * 2.5, 0, Math.PI * 2);
        ctx.fill();
      });
      break;
    }
    case "heart": {
      const beat = 1 + Math.pow(Math.max(0, Math.sin(t * 4.2)), 4) * 0.14;
      ctx.save();
      ctx.scale(beat, beat);
      ctx.fillStyle = "#F43F5E";
      ctx.beginPath();
      ctx.moveTo(0, 44);
      ctx.bezierCurveTo(-72, 2, -62, -56, 0, -24);
      ctx.bezierCurveTo(62, -56, 72, 2, 0, 44);
      ctx.fill();
      ctx.restore();
      // ECG line
      ctx.strokeStyle = "#FCA5A5";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(-84, 72);
      ctx.lineTo(-26, 72);
      ctx.lineTo(-14, 52);
      ctx.lineTo(0, 86);
      ctx.lineTo(14, 60);
      ctx.lineTo(26, 72);
      ctx.lineTo(84, 72);
      ctx.stroke();
      break;
    }
    default: {
      // "book"
      ctx.fillStyle = "#EFF6FF";
      drawRoundedRect(ctx, -68, -42, 64, 84, 8);
      ctx.fill();
      drawRoundedRect(ctx, 4, -42, 64, 84, 8);
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(0, -44);
      ctx.lineTo(0, 44);
      ctx.stroke();
      ctx.strokeStyle = "#94A3B8";
      ctx.lineWidth = 2.5;
      for (let i = 0; i < 4; i += 1) {
        const y = -22 + i * 16;
        ctx.beginPath();
        ctx.moveTo(-54, y);
        ctx.lineTo(-16, y);
        ctx.moveTo(18, y);
        ctx.lineTo(54, y);
        ctx.stroke();
      }
      // Floating spark
      ctx.fillStyle = "#FBBF24";
      ctx.beginPath();
      ctx.arc(Math.sin(t * 2) * 32, -64 + Math.cos(t * 3) * 6, 7, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
  }

  ctx.restore();
}

function drawStudyVideoFrame(
  ctx: CanvasRenderingContext2D,
  storyboard: StudyVideoStoryboard,
  sceneIndex: number,
  sceneProgress: number,
  globalTimeSec: number,
  webgl3dCanvas?: HTMLCanvasElement | null
) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const scale = W / 960;
  const accent = safeHexColor(storyboard.themeColor);
  const scenes = storyboard.scenes;
  const scene = scenes[sceneIndex] || scenes[0];
  if (!scene) return;

  ctx.save();
  ctx.scale(scale, scale);
  const vW = 960;
  const vH = 540;

  if (webgl3dCanvas && webgl3dCanvas.width > 0 && webgl3dCanvas.height > 0) {
    // 1. Live Real 3D WebGL PBR Cinema Viewport
    ctx.drawImage(webgl3dCanvas, 0, 0, vW, vH);

    // Subtle left-to-right cinema scrim so typography reads razor-sharp while 3D hero shines on right
    const scrim = ctx.createLinearGradient(0, 0, vW * 0.72, 0);
    scrim.addColorStop(0, "rgba(2, 6, 23, 0.86)");
    scrim.addColorStop(0.58, "rgba(2, 6, 23, 0.56)");
    scrim.addColorStop(1, "rgba(2, 6, 23, 0.04)");
    ctx.fillStyle = scrim;
    ctx.fillRect(0, 0, vW, vH);
  } else {
    // Fallback 2D Slides Mode: Deep navy academic gradient backdrop
    const bg = ctx.createLinearGradient(0, 0, vW, vH);
    bg.addColorStop(0, "#0F172A");
    bg.addColorStop(0.6, "#1E293B");
    bg.addColorStop(1, "#0B1120");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, vW, vH);

    ctx.strokeStyle = "rgba(148, 163, 184, 0.08)";
    ctx.lineWidth = 1;
    const offset = (globalTimeSec * 12) % 48;
    for (let x = -48 + offset; x < vW; x += 48) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, vH);
      ctx.stroke();
    }
    for (let y = 0; y < vH; y += 48) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(vW, y);
      ctx.stroke();
    }
  }

  // 3. Top header bar
  ctx.fillStyle = "rgba(2, 6, 23, 0.72)";
  ctx.fillRect(0, 0, vW, 58);
  ctx.fillStyle = accent;
  ctx.fillRect(0, 56, vW, 2);

  ctx.fillStyle = "#F8FAFC";
  ctx.font = "700 19px Inter, system-ui, -apple-system, sans-serif";
  ctx.fillText(storyboard.title.slice(0, 48), 28, 36);

  const badgeText = webgl3dCanvas
    ? `3D CINEMA · Scene ${sceneIndex + 1} / ${scenes.length}`
    : `Scene ${sceneIndex + 1} / ${scenes.length}`;
  ctx.font = "600 12px Inter, system-ui, sans-serif";
  const badgeW = ctx.measureText(badgeText).width + 24;
  ctx.fillStyle = `${accent}38`;
  drawRoundedRect(ctx, vW - badgeW - 24, 15, badgeW, 28, 14);
  ctx.fill();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.fillStyle = "#E2E8F0";
  ctx.fillText(badgeText, vW - badgeW - 12, 33);

  // 4. Left content column with smooth fade-in transition
  const fadeIn = Math.min(1, sceneProgress * 4.5);
  const slideX = (1 - fadeIn) * 18;
  const colMaxW = webgl3dCanvas ? 450 : 540;

  ctx.save();
  ctx.globalAlpha = fadeIn;

  // Scene Heading
  ctx.fillStyle = "#FFFFFF";
  ctx.font = "700 28px Inter, system-ui, -apple-system, sans-serif";
  const headingLines = wrapCanvasLines(ctx, scene.heading, colMaxW, 2);
  headingLines.forEach((line, idx) => {
    ctx.fillText(line, 32 + slideX, 112 + idx * 36);
  });

  // Bullet Points (staggered reveal)
  const bulletStartY = 118 + headingLines.length * 36 + 12;
  ctx.font = "500 17px Inter, system-ui, -apple-system, sans-serif";
  const bullets = (scene.bulletPoints || []).slice(0, 3);
  bullets.forEach((pt, idx) => {
    const bulletAlpha = Math.min(1, Math.max(0, (sceneProgress - idx * 0.14) * 5));
    ctx.save();
    ctx.globalAlpha = fadeIn * bulletAlpha;
    const by = bulletStartY + idx * 44;
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(42 + slideX, by - 6, 4.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#E2E8F0";
    const wrapped = wrapCanvasLines(ctx, pt, colMaxW - 30, 2);
    wrapped.forEach((line, lIdx) => {
      ctx.fillText(line, 56 + slideX, by + lIdx * 20);
    });
    ctx.restore();
  });

  // Highlighted Key Fact Card
  if (scene.keyFact) {
    const cardY = 342;
    ctx.fillStyle = "rgba(15, 23, 42, 0.88)";
    drawRoundedRect(ctx, 32 + slideX, cardY, colMaxW, 74, 12);
    ctx.fill();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.6;
    ctx.stroke();

    ctx.fillStyle = "#93C5FD";
    ctx.font = "700 11px Inter, system-ui, sans-serif";
    ctx.fillText("KEY TAKEAWAY", 48 + slideX, cardY + 22);

    ctx.fillStyle = "#F8FAFC";
    ctx.font = "600 15px Inter, system-ui, sans-serif";
    const factLines = wrapCanvasLines(ctx, scene.keyFact, colMaxW - 32, 2);
    factLines.forEach((line, idx) => {
      ctx.fillText(line, 48 + slideX, cardY + 43 + idx * 19);
    });
  }

  ctx.restore();

  // 5. Right animated vector visual ONLY in 2D Slides mode
  if (!webgl3dCanvas) {
    drawSceneVisualAccent(ctx, scene.visualAccent, 770, 240, globalTimeSec, accent);
  }

  // 6. Bottom subtitle / teacher narration bar
  ctx.fillStyle = "rgba(2, 6, 23, 0.84)";
  ctx.fillRect(0, vH - 92, vW, 92);

  ctx.fillStyle = "#F1F5F9";
  ctx.font = "500 17px Inter, system-ui, -apple-system, sans-serif";
  const subLines = wrapCanvasLines(ctx, scene.narration, vW - 72, 2);
  subLines.forEach((line, idx) => {
    const textW = ctx.measureText(line).width;
    ctx.fillText(line, (vW - textW) / 2, vH - 52 + idx * 24);
  });

  // 7. Overall timeline progress bar
  const totalProgress =
    (sceneIndex + Math.min(1, sceneProgress)) / Math.max(1, scenes.length);
  ctx.fillStyle = "rgba(148, 163, 184, 0.25)";
  ctx.fillRect(0, vH - 6, vW, 6);
  ctx.fillStyle = accent;
  ctx.fillRect(0, vH - 6, vW * totalProgress, 6);

  ctx.restore();
}

export function StudyVideoPlayer({
  storyboard,
  videoLinks,
}: {
  storyboard: StudyVideoStoryboard;
  videoLinks?: StudyVideoLink[];
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engine3dRef = useRef<Study3DViewportEngine | null>(null);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const ttsCacheRef = useRef<Map<number, string>>(new Map());
  const narrationRunIdRef = useRef(0);

  const [renderMode, setRenderMode] = useState<"3d" | "2d">("3d");
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [sceneIndex, setSceneIndex] = useState(0);
  const [isExporting, setIsExporting] = useState(false);
  const [exportPercent, setExportPercent] = useState(0);

  const renderModeRef = useRef(renderMode);
  renderModeRef.current = renderMode;
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;
  const isMutedRef = useRef(isMuted);
  isMutedRef.current = isMuted;
  const sceneIndexRef = useRef(sceneIndex);
  sceneIndexRef.current = sceneIndex;
  const sceneElapsedRef = useRef(0);
  const globalTimeRef = useRef(0);
  const spokenSceneRef = useRef<number>(-1);

  const scenes = storyboard.scenes || [];

  const resolvedBlueprint = useMemo<Study3DSceneBlueprint>(
    () =>
      storyboard.scene3d ||
      infer3DSceneBlueprint(
        storyboard.title,
        storyboard.subject,
        storyboard.themeColor
      ),
    [storyboard.scene3d, storyboard.title, storyboard.subject, storyboard.themeColor]
  );

  // Initialize dedicated offscreen 3D WebGL Cinema engine for the video player
  useEffect(() => {
    let engine: Study3DViewportEngine | null = null;
    try {
      engine = new Study3DViewportEngine({
        width: 960,
        height: 540,
        interactive: false,
      });
      engine.loadBlueprint(resolvedBlueprint);
      engine3dRef.current = engine;
    } catch {
      engine3dRef.current = null;
    }
    return () => {
      engine?.dispose();
      engine3dRef.current = null;
    };
  }, [resolvedBlueprint]);

  // Clear TTS audio cache when storyboard changes
  useEffect(() => {
    const cache = ttsCacheRef.current;
    cache.clear();
  }, [storyboard]);

  const stopNarration = useCallback(() => {
    narrationRunIdRef.current += 1;
    if (ttsAudioRef.current) {
      try {
        ttsAudioRef.current.pause();
        ttsAudioRef.current.src = "";
      } catch {
        // ignore
      }
      ttsAudioRef.current = null;
    }
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // ignore
      }
    }
  }, []);

  const speakBrowserNarration = useCallback(
    (narration: string) => {
      if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
      try {
        window.speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(narration);
        utter.lang = getSpeechLangCode(storyboard.language);
        utter.volume = 1.0;
        utter.rate = 0.98;
        window.speechSynthesis.speak(utter);
      } catch {
        // ignore speech synthesis errors
      }
    },
    [storyboard.language]
  );

  const speakSceneNarration = useCallback(
    (idx: number) => {
      if (isMutedRef.current) return;
      const scene = scenes[idx];
      if (!scene?.narration) return;

      stopNarration();
      const myRun = narrationRunIdRef.current;

      // Offline immediate loud browser speech
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        speakBrowserNarration(scene.narration);
        return;
      }

      const playWavBase64 = (b64: string) => {
        if (narrationRunIdRef.current !== myRun || isMutedRef.current) return;
        const audio = new Audio(`data:audio/wav;base64,${b64}`);
        audio.muted = false;
        audio.volume = 1.0;
        ttsAudioRef.current = audio;
        audio.play().catch(() => {
          if (narrationRunIdRef.current === myRun && !isMutedRef.current) {
            speakBrowserNarration(scene.narration);
          }
        });
      };

      const cached = ttsCacheRef.current.get(idx);
      if (cached) {
        playWavBase64(cached);
        return;
      }

      // Fetch loud broadcast-mastered voice from /api/tts with fast fallback to browser TTS
      void fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: scene.narration,
          voiceName: "Kore",
          role: "student",
          language: storyboard.language || "Auto-Detect",
        }),
      })
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error("TTS unavailable"))))
        .then((data: { audioBase64?: string }) => {
          if (!data?.audioBase64) throw new Error("Empty TTS");
          ttsCacheRef.current.set(idx, data.audioBase64);
          playWavBase64(data.audioBase64);
        })
        .catch(() => {
          if (narrationRunIdRef.current === myRun && !isMutedRef.current) {
            speakBrowserNarration(scene.narration);
          }
        });
    },
    [scenes, storyboard.language, stopNarration, speakBrowserNarration]
  );

  // Main 3D Cinema + 2D composite animation loop
  useEffect(() => {
    let rafId = 0;
    let timerId = 0;
    let lastTs = performance.now();
    let cancelled = false;

    const tick = () => {
      if (cancelled) return;
      const now = performance.now();
      const dt = Math.min(0.1, (now - lastTs) / 1000);
      lastTs = now;
      globalTimeRef.current += dt;

      if (isPlayingRef.current && scenes.length > 0) {
        const currentIdx = sceneIndexRef.current;
        const currentScene = scenes[currentIdx];
        const dur = Math.max(4, Math.min(10, currentScene?.durationSec || 6));

        if (spokenSceneRef.current !== currentIdx) {
          spokenSceneRef.current = currentIdx;
          speakSceneNarration(currentIdx);
        }

        sceneElapsedRef.current += dt;
        if (sceneElapsedRef.current >= dur) {
          if (currentIdx + 1 < scenes.length) {
            sceneElapsedRef.current = 0;
            sceneIndexRef.current = currentIdx + 1;
            setSceneIndex(currentIdx + 1);
          } else {
            sceneElapsedRef.current = dur;
            isPlayingRef.current = false;
            setIsPlaying(false);
          }
        }
      }

      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (ctx && scenes.length > 0) {
        const idx = sceneIndexRef.current;
        const dur = Math.max(4, Math.min(10, scenes[idx]?.durationSec || 6));
        const progress = isPlayingRef.current
          ? Math.min(1, sceneElapsedRef.current / dur)
          : Math.max(0.55, Math.min(1, sceneElapsedRef.current / dur));

        let webglCanvas: HTMLCanvasElement | null = null;
        if (renderModeRef.current === "3d" && engine3dRef.current) {
          engine3dRef.current.renderCinematicFrame(
            globalTimeRef.current,
            idx,
            progress
          );
          webglCanvas = engine3dRef.current.domElement;
        }

        drawStudyVideoFrame(
          ctx,
          storyboard,
          idx,
          progress,
          globalTimeRef.current,
          webglCanvas
        );
      }

      if (engine3dRef.current?.isSoftwareGl && renderModeRef.current === "3d") {
        timerId = window.setTimeout(tick, 90);
      } else {
        rafId = window.requestAnimationFrame(tick);
      }
    };

    rafId = window.requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(rafId);
      window.clearTimeout(timerId);
      stopNarration();
    };
  }, [scenes, storyboard, speakSceneNarration, stopNarration]);

  const handleTogglePlay = () => {
    if (isPlaying) {
      setIsPlaying(false);
      stopNarration();
      return;
    }
    const lastIdx = scenes.length - 1;
    const lastDur = Math.max(4, Math.min(10, scenes[lastIdx]?.durationSec || 6));
    if (sceneIndexRef.current >= lastIdx && sceneElapsedRef.current >= lastDur - 0.1) {
      sceneIndexRef.current = 0;
      sceneElapsedRef.current = 0;
      setSceneIndex(0);
    }
    spokenSceneRef.current = -1;
    setIsPlaying(true);
  };

  const handleJumpScene = (idx: number) => {
    sceneIndexRef.current = idx;
    sceneElapsedRef.current = 0;
    spokenSceneRef.current = -1;
    setSceneIndex(idx);
    if (isPlaying) {
      speakSceneNarration(idx);
      spokenSceneRef.current = idx;
    }
  };

  const handleDownloadWebm = async () => {
    if (isExporting || scenes.length === 0) return;
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext("2d");
    if (!ctx || typeof canvas.captureStream !== "function" || typeof MediaRecorder === "undefined") {
      return;
    }

    setIsExporting(true);
    setExportPercent(2);
    setIsPlaying(false);
    stopNarration();

    let export3dEngine: Study3DViewportEngine | null = null;
    try {
      if (renderModeRef.current === "3d") {
        try {
          export3dEngine = new Study3DViewportEngine({
            width: 1280,
            height: 720,
            interactive: false,
          });
          export3dEngine.loadBlueprint(resolvedBlueprint);
        } catch {
          export3dEngine = null;
        }
      }

      const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
        ? "video/webm;codecs=vp9"
        : MediaRecorder.isTypeSupported("video/webm;codecs=vp8")
          ? "video/webm;codecs=vp8"
          : "video/webm";

      const stream = canvas.captureStream(30);
      const recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 3_600_000,
      });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunks.push(ev.data);
      };

      const donePromise = new Promise<Blob>((resolve) => {
        recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
      });

      recorder.start();

      const secPerScene = 4.0;
      const totalDuration = scenes.length * secPerScene;
      const startTime = performance.now();

      await new Promise<void>((resolve) => {
        const renderStep = () => {
          const elapsed = (performance.now() - startTime) / 1000;
          if (elapsed >= totalDuration) {
            setExportPercent(100);
            resolve();
            return;
          }
          const idx = Math.min(scenes.length - 1, Math.floor(elapsed / secPerScene));
          const progress = (elapsed - idx * secPerScene) / secPerScene;
          if (export3dEngine) {
            export3dEngine.renderCinematicFrame(elapsed, idx, progress);
          }
          drawStudyVideoFrame(
            ctx,
            storyboard,
            idx,
            progress,
            elapsed,
            export3dEngine?.domElement || null
          );
          setExportPercent(Math.min(99, Math.round((elapsed / totalDuration) * 100)));
          window.requestAnimationFrame(renderStep);
        };
        window.requestAnimationFrame(renderStep);
      });

      recorder.stop();
      const videoBlob = await donePromise;
      const url = URL.createObjectURL(videoBlob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${slugifyFilename(storyboard.title, "3d-real-video")}-3d.webm`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } finally {
      export3dEngine?.dispose();
      setIsExporting(false);
      setExportPercent(0);
    }
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-950 overflow-hidden">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 bg-slate-900 border-b border-slate-800">
        <div className="flex items-center gap-2 min-w-0">
          <Film className="h-4 w-4 text-sky-400 shrink-0" />
          <div className="min-w-0">
            <p className="text-xs font-semibold text-white truncate">
              {storyboard.title}
            </p>
            <p className="text-[11px] text-slate-400 truncate">
              {renderMode === "3d" ? "3D Real Cinema Video" : "2D Slide Video"} · {scenes.length} narrated scenes
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
          <div className="inline-flex items-center rounded-md bg-slate-800 p-0.5">
            <button
              type="button"
              onClick={() => setRenderMode("3d")}
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold transition-colors ${
                renderMode === "3d"
                  ? "bg-sky-500 text-slate-950"
                  : "text-slate-300 hover:text-white"
              }`}
            >
              <Box className="h-3 w-3" />
              <span>3D Cinema</span>
            </button>
            <button
              type="button"
              onClick={() => setRenderMode("2d")}
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold transition-colors ${
                renderMode === "2d"
                  ? "bg-blue-600 text-white"
                  : "text-slate-300 hover:text-white"
              }`}
            >
              <Layers className="h-3 w-3" />
              <span>2D</span>
            </button>
          </div>
          <button
            type="button"
            disabled={isExporting}
            onClick={() => void handleDownloadWebm()}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-semibold bg-sky-600 hover:bg-sky-500 text-white disabled:opacity-60 transition-colors whitespace-nowrap shrink-0"
          >
            {isExporting ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                <span>Rendering 3D {exportPercent}%…</span>
              </>
            ) : (
              <>
                <Download className="h-3 w-3" />
                <span>Download 3D Video (.webm)</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* 16:9 3D Animated Video Viewport */}
      <div className="relative bg-slate-950 cursor-pointer" onClick={handleTogglePlay}>
        <canvas
          ref={canvasRef}
          width={960}
          height={540}
          className="w-full aspect-video block"
        />
        {!isPlaying && !isExporting && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-950/25 transition-colors hover:bg-slate-950/15">
            <span className="h-14 w-14 rounded-full bg-blue-600/95 text-white flex items-center justify-center shadow-lg">
              <Play className="h-6 w-6 fill-white ml-0.5" />
            </span>
          </div>
        )}
      </div>

      {/* Playback & Chapter Controls */}
      <div className="px-3.5 py-2.5 bg-slate-900 border-t border-slate-800 flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleTogglePlay}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-colors"
          >
            {isPlaying ? (
              <>
                <Pause className="h-3.5 w-3.5" />
                <span>Pause</span>
              </>
            ) : (
              <>
                <Play className="h-3.5 w-3.5 fill-white" />
                <span>Play 3D Video</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={() => handleJumpScene(0)}
            aria-label="Restart video"
            className="h-8 w-8 inline-flex items-center justify-center rounded-md bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>

          <button
            type="button"
            onClick={() => {
              const nextMuted = !isMuted;
              setIsMuted(nextMuted);
              if (nextMuted) stopNarration();
            }}
            aria-label={isMuted ? "Unmute narration" : "Mute narration"}
            className="h-8 w-8 inline-flex items-center justify-center rounded-md bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors"
          >
            {isMuted ? (
              <VolumeX className="h-3.5 w-3.5 text-slate-400" />
            ) : (
              <Volume2 className="h-3.5 w-3.5 text-sky-400" />
            )}
          </button>
        </div>

        {/* Scene step buttons */}
        <div className="flex items-center gap-1 overflow-x-auto">
          {scenes.map((sc, idx) => (
            <button
              key={`${sc.heading}-${idx}`}
              type="button"
              onClick={() => handleJumpScene(idx)}
              title={sc.heading}
              className={`px-2 py-1 rounded text-[11px] font-semibold transition-colors whitespace-nowrap ${
                idx === sceneIndex
                  ? "bg-sky-500 text-slate-950"
                  : "bg-slate-800 text-slate-300 hover:bg-slate-700"
              }`}
            >
              {idx + 1}
            </button>
          ))}
        </div>
      </div>

      {/* Curated Free Educational Video Links */}
      {videoLinks && videoLinks.length > 0 && (
        <div className="px-3.5 py-2.5 bg-slate-50 border-t border-slate-200 flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold text-slate-500">
            Watch More Videos:
          </span>
          {videoLinks.map((link) => (
            <a
              key={link.url}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium bg-white border border-slate-200 text-blue-700 hover:border-blue-300 hover:bg-blue-50 transition-colors"
            >
              <span>{link.title}</span>
              <ExternalLink className="h-3 w-3 shrink-0" />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

export function StudyVideoLinksStrip({ links }: { links: StudyVideoLink[] }) {
  if (!links || links.length === 0) return null;
  return (
    <div className="pt-3 border-t border-slate-100">
      <p className="text-xs font-semibold text-slate-500 mb-1.5">
        Related Study Videos
      </p>
      <div className="flex flex-wrap gap-2">
        {links.map((link) => (
          <a
            key={link.url}
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-slate-50 hover:bg-blue-50 border border-slate-200 hover:border-blue-300 text-slate-800 hover:text-blue-800 transition-colors"
          >
            <Play className="h-3 w-3 text-red-600 fill-red-600 shrink-0" />
            <span>{link.title}</span>
            <ExternalLink className="h-3 w-3 text-slate-400 shrink-0" />
          </a>
        ))}
      </div>
    </div>
  );
}
