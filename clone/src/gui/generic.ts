import type { CloneParam } from "../eq/params.ts";
import type { Control, GuiModel } from "./model.ts";

/**
 * An editor of the clone's own for originals without one (LV2 plugins without a UI, an empty window, an editor
 * the host cannot embed): its controls in a grid – a knob with name and value for a continuous control, a switch
 * for an on/off one, a selector for a choice – under the plugin's name. Same drawing as a rebuilt editor.
 */
export function genericGuiModel(params: CloneParam[], title = ""): GuiModel | undefined {
  if (!params.length) return undefined;
  const columns = Math.min(6, Math.max(2, Math.ceil(Math.sqrt(params.length * 1.6))));
  const rows = Math.ceil(params.length / columns);
  const cell = { w: 96, h: 118 };
  const header = title ? 48 : 16;
  const margin = 18;
  const width = columns * cell.w + 2 * margin;
  const height = header + rows * cell.h + margin;
  const colors = { background: "#1b1e24", panel: "#23272f", text: "#c9ced8", muted: "#8b93a1", accent: "#5b8cff", body: "#3a3f4a", bodyDark: "#262a32", track: "#353a45" };

  const controls: Control[] = [];
  const texts: GuiModel["texts"] = [];
  if (title) texts.push({ x: margin, y: 14, w: width - 2 * margin, h: 18, text: title, color: colors.text, size: 17, bold: true, align: "left", role: "title" });

  params.forEach((p, i) => {
    const x = margin + (i % columns) * cell.w, y = header + Math.floor(i / columns) * cell.h;
    const cx = x + cell.w / 2;
    const value = normalizedDefault(p);
    texts.push({ x: x + 4, y: y + 6, w: cell.w - 8, h: 11, text: shorten(p.name, 14), color: colors.muted, size: 12, bold: false, align: "center", role: "label" });
    if (p.kind === "toggle") {
      controls.push({ param: p.original, name: p.name, value, x: cx - 22, y: y + 42, w: 44, h: 22, kind: "toggle", toggle: { off: colors.track, on: colors.accent, radius: 11 } });
      return;
    }
    if (p.kind === "choice") {
      controls.push({
        param: p.original, name: p.name, value, ...(p.choices?.length ? { options: p.choices } : {}),
        x: x + 8, y: y + 40, w: cell.w - 16, h: 24, kind: "choice", choice: { background: colors.track, text: colors.text, size: 12 },
      });
      return;
    }
    const radius = 24, cy = y + 52;
    controls.push({
      param: p.original, name: p.name, value,
      x: cx - radius - 6, y: cy - radius - 6, w: (radius + 6) * 2, h: (radius + 6) * 2,
      kind: "rotary",
      rotary: {
        cx, cy, radius, startAngle: -Math.PI * 0.75, endAngle: Math.PI * 0.75,
        body: { color: colors.body, gradient: colors.bodyDark },
        pointer: "#e8ebf0", pointerInner: 0.35, pointerOuter: 0.85, pointerWidth: 2.5, pointerDot: false,
        arc: { color: colors.accent, radius: radius + 4, width: 3, track: colors.track },
      },
      readout: { x: x + 8, y: cy + radius + 8, w: cell.w - 16, h: 14, color: colors.text, size: 12 },
    });
  });

  return {
    type: "gui-layout",
    version: 1,
    width,
    height,
    background: { color: colors.background },
    panels: [{ x: margin / 2, y: header - 6, w: width - margin, h: rows * cell.h + 6, fill: { color: colors.panel }, radius: 8 }],
    lines: [],
    texts,
    controls,
    displays: [],
    hidden: [],
  };
}

/** the default as 0…1 of the control's travel */
function normalizedDefault(p: CloneParam): number {
  if (p.kind === "toggle") return p.defaultValue ? 1 : 0;
  if (p.kind === "choice") return p.choices && p.choices.length > 1 ? p.defaultValue / (p.choices.length - 1) : 0;
  const points = p.points;
  if (!points || points.length < 2) return 0.5;
  // physical → normalised along the original's curve (points rise or fall monotonically)
  for (let k = 1; k < points.length; k++) {
    const [n0, v0] = points[k - 1]!, [n1, v1] = points[k]!;
    if ((p.defaultValue - v0) * (p.defaultValue - v1) <= 0 && v1 !== v0) return n0 + ((p.defaultValue - v0) / (v1 - v0)) * (n1 - n0);
  }
  return Math.abs(p.defaultValue - points[0]![1]) < Math.abs(p.defaultValue - points[points.length - 1]![1]) ? points[0]![0] : points[points.length - 1]![0];
}

function shorten(name: string, max: number): string {
  return name.length <= max ? name : `${name.slice(0, max - 1)}…`;
}
