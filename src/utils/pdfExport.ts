import { jsPDF } from "jspdf";
import type { StudyNote } from "../types";

// A4 geometry in pixels at 150 DPI equivalent for crisp printing & fast generation
const PAGE_W = 1240;
const PAGE_H = 1754;
const MARGIN_X = 96;
const MARGIN_TOP = 92;
const MARGIN_BOTTOM = 96;
const CONTENT_W = PAGE_W - MARGIN_X * 2;

const FONT_DISPLAY =
  '"Bricolage Grotesque", "Plus Jakarta Sans", "Noto Sans Oriya", "Noto Sans Devanagari", "Noto Sans", system-ui, sans-serif';
const FONT_BODY =
  '"Plus Jakarta Sans", "Noto Sans Oriya", "Noto Sans Devanagari", "Noto Sans", system-ui, sans-serif';
const FONT_MONO =
  '"IBM Plex Mono", "Noto Sans Oriya", "Noto Sans Devanagari", "Noto Sans", ui-monospace, monospace';

const RTL_REGEX = /[\u0591-\u07FF\u200F\u202B\u202E\uFB1D-\uFDFD\uFE70-\uFEFC]/;

function isRtlText(text: string): boolean {
  return RTL_REGEX.test(text);
}

interface PageSurface {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

class UnicodePdfBuilder {
  private pages: PageSurface[] = [];
  private cursorY = MARGIN_TOP;
  private currentHeaderLabel = "Jogi Jarvis · Family Study Notes";

  constructor() {
    this.addPage();
  }

  private get current(): PageSurface {
    return this.pages[this.pages.length - 1];
  }

  public setHeaderLabel(label: string) {
    this.currentHeaderLabel = label;
  }

  public addPage() {
    const canvas = document.createElement("canvas");
    canvas.width = PAGE_W;
    canvas.height = PAGE_H;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Unable to initialize canvas for PDF export.");
    }

    // Crisp white paper background
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, PAGE_W, PAGE_H);

    // Subtle top accent bar & running header
    ctx.fillStyle = "#1D4ED8";
    ctx.fillRect(0, 0, PAGE_W, 10);

    ctx.font = `500 20px ${FONT_BODY}`;
    ctx.fillStyle = "#64748B";
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.direction = "ltr";
    ctx.fillText(this.currentHeaderLabel, MARGIN_X, 38);

    ctx.strokeStyle = "#E2E8F0";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(MARGIN_X, 72);
    ctx.lineTo(PAGE_W - MARGIN_X, 72);
    ctx.stroke();

    this.pages.push({ canvas, ctx });
    this.cursorY = MARGIN_TOP + 12;
  }

  public ensureSpace(neededHeight: number) {
    if (this.cursorY + neededHeight > PAGE_H - MARGIN_BOTTOM) {
      this.addPage();
    }
  }

  public addGap(px: number) {
    this.cursorY += px;
  }

  public drawDivider() {
    this.ensureSpace(24);
    const { ctx } = this.current;
    ctx.strokeStyle = "#E2E8F0";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(MARGIN_X, this.cursorY);
    ctx.lineTo(PAGE_W - MARGIN_X, this.cursorY);
    ctx.stroke();
    this.cursorY += 24;
  }

  private wrapLines(
    text: string,
    font: string,
    maxWidth: number
  ): string[] {
    const { ctx } = this.current;
    ctx.font = font;
    const paragraphs = text.replace(/\r\n/g, "\n").split("\n");
    const lines: string[] = [];

    for (const para of paragraphs) {
      if (!para.trim()) {
        lines.push("");
        continue;
      }
      const words = para.split(/\s+/);
      let currentLine = "";

      for (const word of words) {
        const candidate = currentLine ? `${currentLine} ${word}` : word;
        if (ctx.measureText(candidate).width <= maxWidth) {
          currentLine = candidate;
        } else {
          if (currentLine) {
            lines.push(currentLine);
            currentLine = "";
          }
          // Handle long single words / CJK strings without spaces
          if (ctx.measureText(word).width <= maxWidth) {
            currentLine = word;
          } else {
            let chunk = "";
            for (const ch of Array.from(word)) {
              const nextChunk = chunk + ch;
              if (ctx.measureText(nextChunk).width > maxWidth && chunk) {
                lines.push(chunk);
                chunk = ch;
              } else {
                chunk = nextChunk;
              }
            }
            currentLine = chunk;
          }
        }
      }
      if (currentLine) {
        lines.push(currentLine);
      }
    }

    return lines;
  }

  public drawWrappedText(
    text: string,
    options: {
      font: string;
      color: string;
      lineHeight: number;
      indentX?: number;
      maxWidth?: number;
      marginBottom?: number;
    }
  ) {
    const indentX = options.indentX ?? 0;
    const maxWidth = options.maxWidth ?? CONTENT_W - indentX;
    const lines = this.wrapLines(text, options.font, maxWidth);
    const rtl = isRtlText(text);

    for (const line of lines) {
      this.ensureSpace(options.lineHeight + 4);
      const { ctx } = this.current;
      ctx.font = options.font;
      ctx.fillStyle = options.color;
      ctx.textBaseline = "top";
      if (rtl) {
        ctx.direction = "rtl";
        ctx.textAlign = "right";
        ctx.fillText(line, MARGIN_X + indentX + maxWidth, this.cursorY);
      } else {
        ctx.direction = "ltr";
        ctx.textAlign = "left";
        ctx.fillText(line, MARGIN_X + indentX, this.cursorY);
      }
      this.cursorY += options.lineHeight;
    }

    if (options.marginBottom) {
      this.cursorY += options.marginBottom;
    }
  }

  public drawSectionTitle(title: string) {
    this.ensureSpace(58);
    this.drawWrappedText(title, {
      font: `700 26px ${FONT_DISPLAY}`,
      color: "#0F172A",
      lineHeight: 36,
      marginBottom: 12,
    });
  }

  public drawNumberedPoint(index: number, text: string) {
    const numStr = String(index + 1).padStart(2, "0");
    const font = `400 24px ${FONT_BODY}`;
    const lineHeight = 36;
    const indentX = 48;
    const lines = this.wrapLines(text, font, CONTENT_W - indentX);
    const totalH = Math.max(1, lines.length) * lineHeight + 12;

    if (totalH < PAGE_H - MARGIN_TOP - MARGIN_BOTTOM) {
      this.ensureSpace(totalH);
    } else {
      this.ensureSpace(lineHeight + 8);
    }

    const { ctx } = this.current;
    ctx.font = `500 21px ${FONT_MONO}`;
    ctx.fillStyle = "#64748B";
    ctx.direction = "ltr";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(numStr, MARGIN_X, this.cursorY + 3);

    this.drawWrappedText(text, {
      font,
      color: "#1E293B",
      lineHeight,
      indentX,
      marginBottom: 10,
    });
  }

  public drawDefinitionRow(term: string, meaning: string) {
    const termFont = `600 22px ${FONT_MONO}`;
    const meaningFont = `400 23px ${FONT_BODY}`;
    const termW = Math.floor(CONTENT_W * 0.34);
    const meaningX = termW + 28;
    const meaningW = CONTENT_W - meaningX;

    const termLines = this.wrapLines(term, termFont, termW);
    const meaningLines = this.wrapLines(meaning, meaningFont, meaningW);
    const rowH = Math.max(termLines.length * 32, meaningLines.length * 34) + 22;

    this.ensureSpace(rowH + 8);
    const { ctx } = this.current;
    const startY = this.cursorY;

    // Subtle row separator above
    ctx.strokeStyle = "#E2E8F0";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(MARGIN_X, startY);
    ctx.lineTo(PAGE_W - MARGIN_X, startY);
    ctx.stroke();

    const textY = startY + 12;
    ctx.textBaseline = "top";

    const termRtl = isRtlText(term);
    ctx.font = termFont;
    ctx.fillStyle = "#0F172A";
    ctx.direction = termRtl ? "rtl" : "ltr";
    ctx.textAlign = termRtl ? "right" : "left";
    termLines.forEach((line, i) => {
      const x = termRtl ? MARGIN_X + termW : MARGIN_X;
      ctx.fillText(line, x, textY + i * 32);
    });

    const meaningRtl = isRtlText(meaning);
    ctx.font = meaningFont;
    ctx.fillStyle = "#334155";
    ctx.direction = meaningRtl ? "rtl" : "ltr";
    ctx.textAlign = meaningRtl ? "right" : "left";
    meaningLines.forEach((line, i) => {
      const x = meaningRtl
        ? MARGIN_X + meaningX + meaningW
        : MARGIN_X + meaningX;
      ctx.fillText(line, x, textY + i * 34);
    });

    this.cursorY = startY + rowH;
  }

  public drawCalloutBox(label: string, body: string) {
    const bodyFont = `400 23px ${FONT_BODY}`;
    const padX = 28;
    const padY = 24;
    const innerW = CONTENT_W - padX * 2;
    const lines = this.wrapLines(body, bodyFont, innerW);
    const boxH = padY * 2 + 32 + lines.length * 34;

    this.ensureSpace(boxH + 16);
    const { ctx } = this.current;
    const startY = this.cursorY;

    ctx.fillStyle = "#FFFBEB";
    ctx.strokeStyle = "#FDE68A";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(MARGIN_X, startY, CONTENT_W, boxH, 14);
    ctx.fill();
    ctx.stroke();

    ctx.font = `700 20px ${FONT_BODY}`;
    ctx.fillStyle = "#92400E";
    ctx.direction = "ltr";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(label, MARGIN_X + padX, startY + padY);

    const rtl = isRtlText(body);
    ctx.font = bodyFont;
    ctx.fillStyle = "#78350F";
    ctx.direction = rtl ? "rtl" : "ltr";
    ctx.textAlign = rtl ? "right" : "left";
    lines.forEach((line, i) => {
      const x = rtl
        ? MARGIN_X + padX + innerW
        : MARGIN_X + padX;
      ctx.fillText(line, x, startY + padY + 34 + i * 34);
    });

    this.cursorY = startY + boxH + 20;
  }

  public renderNote(note: StudyNote, isFirstNote: boolean) {
    this.setHeaderLabel(`Jogi Jarvis · ${note.subject} · ${note.profileName}`);
    if (!isFirstNote) {
      this.addPage();
    } else {
      // Refresh first page header text cleanly
      const { ctx } = this.current;
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(MARGIN_X, 30, CONTENT_W, 38);
      ctx.font = `500 20px ${FONT_BODY}`;
      ctx.fillStyle = "#64748B";
      ctx.direction = "ltr";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(this.currentHeaderLabel, MARGIN_X, 38);
    }

    const formattedDate = new Date(note.createdAt).toLocaleDateString([], {
      month: "long",
      day: "numeric",
      year: "numeric",
    });

    // Quiet metadata line
    this.drawWrappedText(
      `${note.subject}  ·  ${note.profileName}  ·  ${formattedDate}`,
      {
        font: `600 21px ${FONT_BODY}`,
        color: "#1D4ED8",
        lineHeight: 30,
        marginBottom: 10,
      }
    );

    // Note Title
    this.drawWrappedText(note.title, {
      font: `700 42px ${FONT_DISPLAY}`,
      color: "#0F172A",
      lineHeight: 54,
      marginBottom: 18,
    });

    this.drawDivider();

    // 01. The Big Idea
    if (note.summary) {
      this.drawSectionTitle("01. The Big Idea");
      this.drawWrappedText(note.summary, {
        font: `400 25px ${FONT_BODY}`,
        color: "#1E293B",
        lineHeight: 38,
        marginBottom: 26,
      });
    }

    // 02. Key Takeaways
    if (note.keyPoints.length > 0) {
      this.drawDivider();
      this.drawSectionTitle("02. Key Takeaways");
      note.keyPoints.forEach((pt, idx) => {
        this.drawNumberedPoint(idx, pt);
      });
      this.addGap(16);
    }

    // 03. Key Terms & Formulas
    if (note.definitions.length > 0) {
      this.drawDivider();
      this.drawSectionTitle("03. Key Terms & Formulas");
      note.definitions.forEach((def) => {
        this.drawDefinitionRow(def.term, def.meaning);
      });
      this.addGap(22);
    }

    // 04. Practice & Self-Check
    if (note.practiceQuestions.length > 0) {
      this.drawDivider();
      this.drawSectionTitle("04. Practice & Self-Check");
      note.practiceQuestions.forEach((pq, idx) => {
        this.ensureSpace(96);
        this.drawWrappedText(`Q${idx + 1}. ${pq.question}`, {
          font: `600 24px ${FONT_BODY}`,
          color: "#0F172A",
          lineHeight: 35,
          marginBottom: 6,
        });
        this.drawWrappedText(`Answer: ${pq.answer}`, {
          font: `400 23px ${FONT_BODY}`,
          color: "#334155",
          lineHeight: 34,
          indentX: 24,
          marginBottom: 18,
        });
      });
    }

    // Teacher's Revision Tip
    if (note.teacherTip) {
      this.addGap(8);
      this.drawCalloutBox("Teacher's Revision Tip", note.teacherTip);
    }
  }

  public finalizeAndSave(filename: string) {
    const totalPages = this.pages.length;
    const printDate = new Date().toLocaleDateString([], {
      month: "short",
      day: "numeric",
      year: "numeric",
    });

    const pdf = new jsPDF({
      orientation: "portrait",
      unit: "mm",
      format: "a4",
      compress: true,
    });

    this.pages.forEach((page, idx) => {
      const { ctx, canvas } = page;

      // Footer divider & page numbering
      ctx.strokeStyle = "#E2E8F0";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(MARGIN_X, PAGE_H - 68);
      ctx.lineTo(PAGE_W - MARGIN_X, PAGE_H - 68);
      ctx.stroke();

      ctx.font = `400 19px ${FONT_BODY}`;
      ctx.fillStyle = "#64748B";
      ctx.direction = "ltr";
      ctx.textBaseline = "top";
      ctx.textAlign = "left";
      ctx.fillText(`Exported from Jogi Jarvis · ${printDate}`, MARGIN_X, PAGE_H - 52);

      ctx.textAlign = "right";
      ctx.fillText(
        `Page ${idx + 1} of ${totalPages}`,
        PAGE_W - MARGIN_X,
        PAGE_H - 52
      );

      if (idx > 0) {
        pdf.addPage("a4", "portrait");
      }
      const imgData = canvas.toDataURL("image/jpeg", 0.94);
      pdf.addImage(imgData, "JPEG", 0, 0, 210, 297);
    });

    pdf.save(filename);
  }
}

function toSafePdfFilename(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return `${cleaned || "jogi-jarvis-study-notes"}.pdf`;
}

/**
 * Exports one or multiple StudyNotes into a cleanly formatted A4 printable PDF file.
 * Uses native Canvas text shaping so any script (Hindi, Punjabi, Arabic, Tamil,
 * Chinese, English, etc.) renders accurately without missing glyph boxes.
 */
export async function exportStudyNotesToPdf(
  notes: StudyNote[],
  customFilename?: string
): Promise<void> {
  if (!notes || notes.length === 0) {
    throw new Error("No study notes available to export.");
  }

  // Ensure loaded web fonts are ready before painting canvas pages
  if (document.fonts && document.fonts.ready) {
    try {
      await document.fonts.ready;
    } catch {
      // proceed with system fonts
    }
  }

  const builder = new UnicodePdfBuilder();
  notes.forEach((note, index) => {
    builder.renderNote(note, index === 0);
  });

  const filename =
    customFilename ||
    (notes.length === 1
      ? toSafePdfFilename(notes[0].title)
      : `jogi-jarvis-study-notes-${notes.length}.pdf`);

  builder.finalizeAndSave(filename);
}
