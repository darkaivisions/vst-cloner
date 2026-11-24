import type { Control, Display, Fill, GuiModel } from "./model.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * SVG preview of a layout model (same drawing rules as the plugin editor in plugin-template/eq).
 * `values` maps parameter index → normalized value (default 0.5).
 */
export function renderSvg(model: GuiModel, values: Map<number, number> = new Map()): string {
  const defs: string[] = [];
  let gradientId = 0;
  const fill = (f: Fill) => {
    if (!f.gradient) return f.color;
    const id = `g${gradientId++}`;
    defs.push(`<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${f.color}"/><stop offset="1" stop-color="${f.gradient}"/></linearGradient>`);
    return `url(#${id})`;
  };

  const out: string[] = [];
  out.push(`<rect width="${model.width}" height="${model.height}" fill="${fill(model.background)}"/>`);
  for (const p of model.panels) out.push(`<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="${p.radius}" fill="${fill(p.fill)}"/>`);
  (model.circles ?? []).forEach((c, i) => {
    out.push(`<defs><radialGradient id="disc${i}" cx="0.5" cy="0.5" r="0.5">${c.stops.map((st) => `<stop offset="${st.at.toFixed(4)}" stop-color="${st.color}"/>`).join("")}</radialGradient></defs>`);
    out.push(`<circle cx="${c.cx}" cy="${c.cy}" r="${c.r}" fill="url(#disc${i})"/>`);
    for (const a of c.spokes?.angles ?? []) {
      out.push(`<line x1="${c.cx}" y1="${c.cy}" x2="${(c.cx + Math.sin(a) * c.r * 0.97).toFixed(2)}" y2="${(c.cy - Math.cos(a) * c.r * 0.97).toFixed(2)}" stroke="${c.spokes!.color}" stroke-width="${c.spokes!.width}"/>`);
    }
  });
  for (const l of model.lines) out.push(`<line x1="${l.x1}" y1="${l.y1}" x2="${l.x2}" y2="${l.y2}" stroke="${l.color}" stroke-width="${l.thickness}"/>`);

  for (const d of model.displays) {
    if (d.kind === "meter") continue; // drawn after the texts (needle only)
    if (d.kind === "bar") {
      // unlit, as the clone shows it without audio (same rules as LevelBar in CloneEditor.cpp)
      const bar = d.bar!, off = bar.offColor ?? d.background;
      const vertical = (bar.origin ?? "bottom") === "bottom" || bar.origin === "top";
      if (!bar.segments) {
        out.push(`<rect x="${d.x}" y="${d.y}" width="${d.w}" height="${d.h}" fill="${off}"/>`);
        continue;
      }
      const pitch = (vertical ? d.h : d.w) / bar.segments;
      for (let k = 0; k < bar.segments; k++) {
        const from = k * pitch + pitch * 0.1, to = (k + 1) * pitch - pitch * 0.1;
        let x = vertical ? d.x : d.x + from, y = vertical ? d.y + from : d.y, w = vertical ? d.w : to - from, h = vertical ? to - from : d.h;
        if (vertical) { x += w * 0.08; w *= 0.84; } else { y += h * 0.08; h *= 0.84; }
        if (bar.round) {
          const r = Math.min(w, h) / 2;
          out.push(`<circle cx="${(x + w / 2).toFixed(2)}" cy="${(y + h / 2).toFixed(2)}" r="${r.toFixed(2)}" fill="${off}"/>`);
        } else out.push(`<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" fill="${off}"/>`);
      }
      continue;
    }
    let background = fill(d.backgroundTop && d.backgroundBottom ? { color: d.backgroundTop, gradient: d.backgroundBottom } : { color: d.background });
    if (d.backgroundRight) {
      const id = `g${gradientId++}`;
      defs.push(`<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${d.background}"/><stop offset="1" stop-color="${d.backgroundRight}"/></linearGradient>`);
      background = `url(#${id})`;
    }
    out.push(`<rect x="${d.x}" y="${d.y}" width="${d.w}" height="${d.h}" rx="${d.radius ?? 0}" fill="${background}"/>`);
    if (d.kind === "generic" && d.role) {
      out.push(...(d.role === "curve" ? transferCurve(d) : levelHistory(d)));
      continue;
    }
    const fMin = d.fMin ?? 10, fMax = d.fMax ?? 30000, top = d.dbTop ?? 13.3, bottom = d.dbBottom ?? -13.3;
    const plotH = d.h - (d.labelBand ?? 0);
    const xOf = (f: number) => d.x + (Math.log(f / fMin) / Math.log(fMax / fMin)) * d.w;
    const yOf = (db: number) => d.y + ((top - db) / (top - bottom)) * plotH;
    // (same rules as EqDisplay in CloneEditor.cpp)
    if (d.plain) {
      out.push(`<line x1="${d.curveLeft ?? d.x}" y1="${yOf(0)}" x2="${d.curveRight ?? d.x + d.w}" y2="${yOf(0)}" stroke="${d.curve}" stroke-width="2"/>`);
      continue;
    }
    for (let decade = 1; decade < 1e6; decade *= 10) for (const m of [1, 2, 5]) {
      const f = decade * m;
      if (f > fMin && f < fMax) out.push(`<line x1="${xOf(f)}" y1="${d.y}" x2="${xOf(f)}" y2="${d.y + plotH}" stroke="${d.grid}" stroke-width="1"/>`);
    }
    const range = Math.abs(top - bottom), step = d.dbStep ?? (range <= 16 ? 3 : range <= 40 ? 6 : 12);
    for (const [f, label] of [[20, "20"], [50, "50"], [100, "100"], [200, "200"], [500, "500"], [1000, "1k"], [2000, "2k"], [5000, "5k"], [10000, "10k"], [20000, "20k"]] as const) {
      if (f > fMin && f < fMax) out.push(`<text x="${xOf(f)}" y="${d.labelBand ? d.y + plotH + d.labelBand / 2 : d.y + d.h - 9}" font-size="11" fill="${d.text}" text-anchor="middle" dominant-baseline="central" font-family="DejaVu Sans, sans-serif">${label}</text>`);
    }
    for (let db = Math.ceil(Math.min(top, bottom) / step) * step; db <= Math.max(top, bottom); db += step) {
      out.push(`<line x1="${d.x}" y1="${yOf(db)}" x2="${d.x + d.w}" y2="${yOf(db)}" stroke="${d.grid}" stroke-width="1"/>`);
      out.push(`<text x="${d.dbLabelRight ?? d.x + d.w - 4}" y="${yOf(db)}" font-size="11" fill="${d.text}" text-anchor="end" dominant-baseline="central" font-family="DejaVu Sans, sans-serif">${db > 0 ? "+" : ""}${db}</text>`);
    }
    out.push(`<line x1="${d.curveLeft ?? d.x}" y1="${yOf(0)}" x2="${d.curveRight ?? d.x + d.w}" y2="${yOf(0)}" stroke="${d.curve}" stroke-width="2"/>`);
  }

  for (const t of model.texts) {
    const anchor = t.align === "center" ? "middle" : t.align === "right" ? "end" : "start";
    const x = t.align === "center" ? t.x + t.w / 2 : t.align === "right" ? t.x + t.w : t.x;
    out.push(`<text x="${x}" y="${t.y + t.h / 2}" font-size="${t.size}" font-weight="${t.bold ? 700 : 400}" fill="${t.color}" text-anchor="${anchor}" dominant-baseline="central" font-family="DejaVu Sans, sans-serif" textLength="${t.w}" lengthAdjust="spacingAndGlyphs">${esc(t.text)}</text>`);
  }

  for (const c of model.controls) out.push(renderControl(c, values.get(c.param) ?? c.value ?? 0.5, fill));

  for (const d of model.displays) {
    const n = d.needle;
    if (d.kind !== "meter" || !n) continue;
    const x = n.pivotX + Math.sin(n.angleZero) * n.length, y = n.pivotY - Math.cos(n.angleZero) * n.length;
    out.push(`<line x1="${n.pivotX}" y1="${n.pivotY}" x2="${x}" y2="${y}" stroke="${n.color}" stroke-width="${n.width}"/>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${model.width}" height="${model.height}" viewBox="0 0 ${model.width} ${model.height}"><defs>${defs.join("")}</defs>${out.join("")}</svg>`;
}

const font = `font-family="DejaVu Sans, sans-serif"`;

/** the original's scale numbers, where they stood (drawScaleLabels in CloneEditor.cpp) */
function scaleLabels(d: Display): string[] {
  return (d.scale?.labels ?? []).map((l) =>
    `<text x="${l.x + l.w / 2}" y="${l.y + l.h / 2}" font-size="${(l.h * 1.05).toFixed(2)}" fill="${l.color}" text-anchor="middle" dominant-baseline="central" ${font}>${esc(l.text)}</text>`);
}

/** a step of 1, 2, 3, 5, 6, 10, 12, 20 … dB that gives about `lines` grid lines over `range` (niceStep in CloneEditor.cpp) */
function niceStep(range: number, lines: number): number {
  return [1, 2, 3, 5, 6, 10, 12, 20, 24, 30, 50].find((s) => range / s <= lines) ?? 100;
}

/**
 * Transfer curve (TransferCurve in CloneEditor.cpp): grid on the original's axes, the dashed diagonal, the
 * numbers. The clone draws its own curve from the compressor it computes; the preview, which has none, draws
 * the curve without reduction (output = input).
 */
function transferCurve(d: Display): string[] {
  const out: string[] = [];
  let lowDb = -60, highDb = 0, lowY = -60, highY = 0;
  const sx = d.scale?.x, sy = d.scale?.y;
  if (sx) { lowDb = sx.a + sx.b * d.x; highDb = sx.a + sx.b * (d.x + d.w); }
  if (sy) {
    lowY = sy.a + sy.b * (d.y + d.h); highY = sy.a + sy.b * d.y;
    if (!sx) { lowDb = lowY; highDb = highY; }
  } else { lowY = lowDb; highY = highDb; }
  if (!(highDb > lowDb + 1 && highY > lowY + 1)) { lowDb = lowY = -60; highDb = highY = 0; }
  const x = (db: number) => d.x + ((db - lowDb) / (highDb - lowDb)) * d.w;
  const y = (db: number) => d.y + d.h - ((db - lowY) / (highY - lowY)) * d.h;
  const step = niceStep(highDb - lowDb, 8), stepY = niceStep(highY - lowY, 8);
  for (let db = Math.ceil(lowDb / step) * step; db <= highDb + 0.1; db += step) out.push(`<line x1="${x(db)}" y1="${d.y}" x2="${x(db)}" y2="${d.y + d.h}" stroke="${d.grid}" stroke-width="1"/>`);
  for (let db = Math.ceil(lowY / stepY) * stepY; db <= highY + 0.1; db += stepY) out.push(`<line x1="${d.x}" y1="${y(db)}" x2="${d.x + d.w}" y2="${y(db)}" stroke="${d.grid}" stroke-width="1"/>`);
  const from = Math.max(lowDb, lowY), to = Math.min(highDb, highY);
  out.push(`<line x1="${x(from)}" y1="${y(from)}" x2="${x(to)}" y2="${y(to)}" stroke="${d.text}" stroke-opacity="0.5" stroke-dasharray="3 3" stroke-width="1"/>`);
  if (d.scale?.labels.length) out.push(...scaleLabels(d));
  else {
    const labelStep = niceStep(highDb - lowDb, 4);
    for (let db = Math.ceil(lowDb / labelStep) * labelStep; db < highDb - 0.1; db += labelStep) {
      const t = String(Math.round(db));
      out.push(`<text x="${x(db) + 2}" y="${d.y + d.h - 7}" font-size="10" fill="${d.text}" fill-opacity="0.75" dominant-baseline="central" ${font}>${t}</text>`);
      if (db > lowDb + 0.1) out.push(`<text x="${d.x + 2}" y="${y(db) - 7}" font-size="10" fill="${d.text}" fill-opacity="0.75" dominant-baseline="central" ${font}>${t}</text>`);
    }
  }
  out.push(`<line x1="${x(from)}" y1="${y(from)}" x2="${x(to)}" y2="${y(to)}" stroke="${d.curve}" stroke-width="2"/>`);
  return out;
}

/**
 * Analyzer or time graph (LevelHistory in CloneEditor.cpp), as it stands without audio: the grid, the input level
 * at the bottom, no gain reduction, the numbers.
 */
function levelHistory(d: Display): string[] {
  const out: string[] = [];
  for (let k = 1; k < 6; k++) {
    const y = Math.round(d.y + (d.h * k) / 6);
    out.push(`<line x1="${d.x}" y1="${y}" x2="${d.x + d.w}" y2="${y}" stroke="${d.grid}" stroke-width="1"/>`);
  }
  const sy = d.scale?.y;
  const y = (db: number) => d.y + Math.min(d.h, Math.max(0, sy && Math.abs(sy.b) > 1e-6 ? (db - sy.a) / sy.b - d.y : (-db / 72) * d.h));
  out.push(`<line x1="${d.x}" y1="${y(-120)}" x2="${d.x + d.w}" y2="${y(-120)}" stroke="${d.curve}" stroke-width="1.5"/>`);
  out.push(`<line x1="${d.x}" y1="${y(0)}" x2="${d.x + d.w}" y2="${y(0)}" stroke="${d.text}" stroke-width="1.5"/>`);
  if (d.scale?.labels.length) out.push(...scaleLabels(d));
  else for (let k = 1; k < 6; k++) out.push(`<text x="${d.x + 2}" y="${d.y + (d.h * k) / 6 - 6.5}" font-size="10" fill="${d.text}" fill-opacity="0.75" dominant-baseline="central" ${font}>${-12 * k}</text>`);
  return out;
}

function polar(cx: number, cy: number, r: number, a: number): [number, number] {
  return [cx + Math.sin(a) * r, cy - Math.cos(a) * r];
}

function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  // either direction; a full circle as two halves (one SVG arc cannot end where it starts)
  if (a1 < a0) [a0, a1] = [a1, a0];
  if (a1 - a0 >= Math.PI * 1.99) return `${arcPath(cx, cy, r, a0, a0 + Math.PI)} ${arcPath(cx, cy, r, a0 + Math.PI, a1)}`;
  const [x0, y0] = polar(cx, cy, r, a0);
  const [x1, y1] = polar(cx, cy, r, a1);
  return `M${x0} ${y0} A${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1} ${y1}`;
}

/** the value as the original shows it: the plugin's text, with the digits after the point the original shows */
export function shownValue(text: string, decimals: number | undefined): string {
  if (decimals === undefined || !/^\s*[-+]?\d+(\.\d+)?\s*$/.test(text)) return text;
  return Number(text).toFixed(decimals);
}

function renderControl(c: Control, value: number, fill: (f: Fill) => string): string {
  const parts: string[] = [];
  const readout = () => {
    const r = c.readout!;
    if (r.background) parts.push(`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="${r.background}"${r.border ? ` stroke="${r.border}" stroke-width="1"` : ""}/>`);
    const text = shownValue(c.valueText && value === c.value ? c.valueText : (value * 100).toFixed(2), r.decimals);
    const size = r.onKnob ? r.h * 1.3 : Math.min(r.size, r.h * 0.85);
    parts.push(`<text x="${r.x + r.w / 2}" y="${r.y + r.h / 2}" font-size="${size}" fill="${r.color}" text-anchor="middle" dominant-baseline="central" font-family="DejaVu Sans, sans-serif" textLength="${Math.min(r.onKnob ? r.w : r.w - 4, esc(text).length * size * 0.55)}" lengthAdjust="spacingAndGlyphs">${esc(text)}</text>`);
  };
  // a value on the knob is drawn over it, any other one first
  if (c.readout && !c.readout.onKnob) readout();

  if (c.kind === "rotary" && c.rotary) {
    const s = c.rotary;
    const angle = s.startAngle + value * (s.endAngle - s.startAngle);
    if (s.ticks) {
      for (const a of s.ticks.angles) {
        const [x0, y0] = polar(s.cx, s.cy, s.radius * s.ticks.inner, a);
        const [x1, y1] = polar(s.cx, s.cy, s.radius * s.ticks.outer, a);
        parts.push(`<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" stroke="${s.ticks.color}" stroke-width="${s.ticks.width}"/>`);
      }
    }
    if (s.arc) {
      if (s.arc.track) parts.push(`<path d="${arcPath(s.cx, s.cy, s.arc.radius, s.arc.trackStart ?? s.startAngle, s.arc.trackEnd ?? s.endAngle)}" stroke="${s.arc.track}" stroke-width="${s.arc.width}" fill="none"/>`);
      const from = s.startAngle + (s.arc.origin ?? 0) * (s.endAngle - s.startAngle);
      if (s.arc.trackStart === undefined && Math.abs(angle - from) > 0.01) parts.push(`<path d="${arcPath(s.cx, s.cy, s.arc.radius, from, angle)}" stroke="${s.arc.color}" stroke-width="${s.arc.width}" fill="none"/>`);
    }
    parts.push(`<circle cx="${s.cx}" cy="${s.cy}" r="${s.radius}" fill="${fill(s.body)}"${s.outline ? ` stroke="${s.outline}" stroke-width="1.5"` : ""}/>`);
    if (s.pointerDot) {
      const [x, y] = polar(s.cx, s.cy, s.radius * (s.pointerInner + s.pointerOuter) / 2, angle);
      parts.push(`<circle cx="${x}" cy="${y}" r="${Math.max(1.5, s.pointerWidth / 2 + 1)}" fill="${s.pointer}"/>`);
    } else {
      const [x0, y0] = polar(s.cx, s.cy, s.radius * s.pointerInner, angle);
      const [x1, y1] = polar(s.cx, s.cy, s.radius * s.pointerOuter, angle);
      parts.push(`<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" stroke="${s.pointer}" stroke-width="${s.pointerWidth}" stroke-linecap="round"/>`);
    }
    if (s.cap) parts.push(`<circle cx="${s.cx}" cy="${s.cy}" r="${s.cap.radius}" fill="${s.cap.color}"/>`);
  } else if ((c.kind === "slider-h" || c.kind === "slider-v") && c.slider) {
    const s = c.slider;
    const horizontal = c.kind === "slider-h";
    // (same rules as Fader in CloneEditor.cpp)
    if (s.trackWidth) {
      parts.push(horizontal
        ? `<rect x="${c.x}" y="${c.y + c.h / 2 - s.trackWidth / 2}" width="${c.w}" height="${s.trackWidth}" fill="${s.track}"/>`
        : `<rect x="${c.x + c.w / 2 - s.trackWidth / 2}" y="${c.y}" width="${s.trackWidth}" height="${c.h}" fill="${s.track}"/>`);
    } else parts.push(`<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" fill="${s.track}" rx="${Math.min(c.w, c.h) / 2}"/>`);
    const at = horizontal ? c.x + value * (c.w - s.thumbSize) : c.y + (1 - value) * (c.h - s.thumbSize);
    if (s.roundThumb) {
      const d = Math.min(s.thumbSize, horizontal ? c.h : c.w);
      parts.push(horizontal
        ? `<circle cx="${at + s.thumbSize / 2}" cy="${c.y + c.h / 2}" r="${d / 2}" fill="${s.thumb}"/>`
        : `<circle cx="${c.x + c.w / 2}" cy="${at + s.thumbSize / 2}" r="${d / 2}" fill="${s.thumb}"/>`);
    } else if (horizontal) parts.push(`<rect x="${at}" y="${c.y}" width="${s.thumbSize}" height="${c.h}" fill="${s.thumb}" rx="2"/>`);
    else parts.push(`<rect x="${c.x}" y="${at}" width="${c.w}" height="${s.thumbSize}" fill="${s.thumb}" rx="2"/>`);
  } else if (c.kind === "toggle" && c.toggle) {
    parts.push(`<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" rx="${c.toggle.radius}" fill="${value > 0.5 ? c.toggle.on : c.toggle.off}"/>`);
  } else if (c.kind === "value" && c.choice) {
    parts.push(`<text x="${c.x + c.w / 2}" y="${c.y + c.h / 2}" font-size="${c.choice.size}" fill="${c.choice.text}" text-anchor="middle" dominant-baseline="central" font-family="DejaVu Sans, sans-serif">${esc(c.valueText && value === c.value ? c.valueText : (value * 100).toFixed(1))}</text>`);
  } else if (c.kind === "choice" && c.choice) {
    parts.push(`<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" rx="3" fill="${c.choice.background}"/>`);
    // current option (as the plugin's combo box shows it), fitted into the box
    const option = c.options?.length ? c.options[Math.min(c.options.length - 1, Math.max(0, Math.round(value * (c.options.length - 1))))]! : c.valueText ?? c.name;
    const size = Math.min(c.choice.size, c.h * 0.85);
    parts.push(`<text x="${c.x + c.w / 2}" y="${c.y + c.h / 2}" font-size="${size}" fill="${c.choice.text}" text-anchor="middle" dominant-baseline="central" font-family="DejaVu Sans, sans-serif"${option.length * size * 0.55 > c.w - 4 ? ` textLength="${c.w - 4}" lengthAdjust="spacingAndGlyphs"` : ""}>${esc(option)}</text>`);
  }
  if (c.readout?.onKnob) readout();
  return parts.join("");
}
