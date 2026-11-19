import { call } from "./bridge.ts";
import { clear, h } from "./dom.ts";

/** bridge: gui.replay */
export interface ReplayInfo {
  available: boolean;
  width: number;
  height: number;
  segments: { kind: "rest" | "control" | "film"; label: string; frames: number; param?: number; values?: number[]; times?: { t: number; levelDb: number }[] }[];
  overlay?: {
    controls: { param: number; name: string; kind: string; x: number; y: number; w: number; h: number }[];
    displays: { kind: string; role?: string; x: number; y: number; w: number; h: number; source?: string; origin?: string; segments?: number }[];
  };
}

const SVG = "http://www.w3.org/2000/svg";
const svg = (tag: string, attrs: Record<string, string | number>, text?: string) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (text !== undefined) el.textContent = text;
  return el;
};

const CONTROL_NAMES: Record<string, string> = { rotary: "knob", "slider-h": "slider", "slider-v": "slider", toggle: "switch", choice: "selector", value: "value field" };

/** What a recognised display is, in words. */
function displayLabel(d: NonNullable<ReplayInfo["overlay"]>["displays"][number]): string {
  if (d.kind === "meter") return "Gain reduction needle";
  if (d.kind === "bar") {
    const what = d.source === "input" ? "Input meter" : d.source === "output" ? "Output meter" : "Gain reduction meter";
    return `${what}${d.segments ? ` · ${d.segments} LEDs` : ""}`;
  }
  if (d.kind === "eq") return "EQ curve";
  if (d.role === "curve") return "Transfer curve";
  if (d.role === "analyzer") return "Analyzer / time graph";
  return "Display";
}

/**
 * Player for the pictures the editor recognition took – the initial state, every control moved through its range,
 * the films of the level meters – with the recognised elements drawn over them.
 */
export class ReplayPlayer {
  readonly element: HTMLElement;
  private info?: ReplayInfo;
  private segment = 0;
  private frame = 0;
  private playing = false;
  private timer?: number;
  private loading = false;
  private showOverlay = true;
  private readonly image = h("img.replay-image", { alt: "Editor of the original" });
  private readonly overlay = document.createElementNS(SVG, "svg");
  private readonly stage = h("div.replay-stage");
  private readonly chips = h("div.replay-chips");
  private readonly scrub = h("input.replay-scrub", { type: "range", min: "0", max: "0", value: "0" }) as HTMLInputElement;
  private readonly playButton = h("button.ghost.small", {}, "▶ Play");
  private readonly caption = h("div.replay-caption");
  private readonly legend = h("div.replay-legend");

  constructor(private readonly profile: string) {
    this.overlay.classList.add("replay-overlay");
    this.stage.append(this.image, this.overlay);
    this.playButton.addEventListener("click", () => (this.playing ? this.stop() : this.play()));
    this.scrub.addEventListener("input", () => { this.stop(); void this.show(this.segment, Number(this.scrub.value)); });
    const toggle = h("label.check.small", {}, h("input", { type: "checkbox", checked: true, onchange: (e: Event) => { this.showOverlay = (e.target as HTMLInputElement).checked; this.drawOverlay(); } }), "Show what was recognised");
    this.element = h("div.replay", {}, this.chips, this.stage, h("div.replay-controls", {}, this.playButton, this.scrub, toggle), this.caption, this.legend);
  }

  /** Loads the outline; false when the profile has no saved editor probe. */
  async load(): Promise<boolean> {
    this.info = await call<ReplayInfo>("gui.replay", { profile: this.profile });
    if (!this.info.available) return false;
    this.stage.style.aspectRatio = `${this.info.width} / ${this.info.height}`;
    this.stage.style.maxWidth = `${this.info.width}px`;
    this.overlay.setAttribute("viewBox", `0 0 ${this.info.width} ${this.info.height}`);
    this.renderChips();
    this.renderLegend();
    await this.show(0, 0);
    return true;
  }

  dispose(): void {
    this.stop();
  }

  private renderChips() {
    clear(this.chips);
    const info = this.info!;
    info.segments.forEach((s, i) => {
      const label = s.kind === "control" ? s.label : s.kind === "film" ? (s.label.includes("threshold") ? "Meters · threshold down" : "Meters · rising sine") : "Initial state";
      this.chips.appendChild(h("button.chip", { class: i === this.segment ? "active" : "", title: s.label, onclick: () => { this.stop(); void this.show(i, 0); } }, label));
    });
  }

  private renderLegend() {
    clear(this.legend);
    const o = this.info?.overlay;
    if (!o) {
      this.legend.appendChild(h("p.hint", {}, "No recognised layout stored in the profile – only the pictures are shown."));
      return;
    }
    const kinds = new Map<string, number>();
    for (const c of o.controls) kinds.set(CONTROL_NAMES[c.kind] ?? c.kind, (kinds.get(CONTROL_NAMES[c.kind] ?? c.kind) ?? 0) + 1);
    this.legend.append(
      h("span.legend-item.control", {}, `${o.controls.length} controls (${[...kinds].map(([k, n]) => `${n} ${k}${n === 1 ? "" : k.endsWith("h") ? "es" : "s"}`).join(", ")})`),
      ...o.displays.map((d) => h("span.legend-item.display", {}, displayLabel(d))));
  }

  private async show(segment: number, frame: number) {
    const info = this.info!;
    const s = info.segments[segment]!;
    if (this.loading) return;
    this.loading = true;
    try {
      const { src } = await call<{ src: string }>("gui.frame", { profile: this.profile, segment, index: frame });
      const changedSegment = segment !== this.segment;
      this.segment = segment;
      this.frame = frame;
      this.image.src = src;
      this.scrub.max = String(Math.max(0, s.frames - 1));
      this.scrub.value = String(frame);
      this.scrub.disabled = s.frames <= 1;
      if (changedSegment) this.renderChips();
      this.caption.textContent = this.describe(s, frame);
      this.drawOverlay();
    } finally {
      this.loading = false;
    }
  }

  private describe(s: ReplayInfo["segments"][number], frame: number): string {
    if (s.kind === "rest") return "The editor as the plugin opens it – the reference everything else is compared with.";
    if (s.kind === "control") {
      const value = s.values?.[frame];
      return `Moving "${s.label}" through its range: step ${frame + 1} of ${s.frames}${value !== undefined ? ` (value ${value.toFixed(2)})` : ""} – what changes is where its control is.`;
    }
    const t = s.times?.[frame];
    const level = !t || t.levelDb <= -150 ? "silence" : `${t.levelDb.toFixed(1)} dBFS sine`;
    return `${s.label}: ${t ? (t.t / 1000).toFixed(2) : "0.00"} s · input ${level} – areas that light up with the level are meters.`;
  }

  /** Recognised elements over the picture; the control being moved and meters during a film stand out. */
  private drawOverlay() {
    while (this.overlay.firstChild) this.overlay.removeChild(this.overlay.firstChild);
    const o = this.info?.overlay;
    if (!o || !this.showOverlay) return;
    const s = this.info!.segments[this.segment]!;
    for (const d of o.displays) {
      const active = s.kind === "film" && (d.kind === "bar" || d.kind === "meter" || d.role === "analyzer");
      this.overlay.appendChild(svg("rect", { x: d.x, y: d.y, width: d.w, height: d.h, class: `ov-display${active ? " active" : ""}`, rx: 3 }));
      if (d.kind === "bar" && d.origin) {
        // arrow from the end the meter grows from
        const cx = d.x + d.w / 2, cy = d.y + d.h / 2, len = Math.min(18, Math.max(d.w, d.h) / 3);
        const dir = { bottom: [0, -1], top: [0, 1], left: [1, 0], right: [-1, 0] }[d.origin] ?? [0, -1];
        const x0 = cx - dir[0]! * len, y0 = cy - dir[1]! * len, x1 = cx + dir[0]! * len, y1 = cy + dir[1]! * len;
        this.overlay.appendChild(svg("line", { x1: x0, y1: y0, x2: x1, y2: y1, class: "ov-arrow" }));
        this.overlay.appendChild(svg("polygon", { points: `${x1},${y1} ${x1 - dir[0]! * 6 - dir[1]! * 4},${y1 - dir[1]! * 6 - dir[0]! * 4} ${x1 - dir[0]! * 6 + dir[1]! * 4},${y1 - dir[1]! * 6 + dir[0]! * 4}`, class: "ov-arrow-head" }));
      }
      this.overlay.appendChild(svg("text", { x: d.x + 3, y: Math.max(11, d.y - 4), class: `ov-label display${active ? " active" : ""}` }, displayLabel(d)));
    }
    for (const c of o.controls) {
      const active = s.kind === "control" && c.param === s.param;
      this.overlay.appendChild(svg("rect", { x: c.x, y: c.y, width: c.w, height: c.h, class: `ov-control${active ? " active" : ""}`, rx: 3 }));
      if (active || s.kind === "rest") this.overlay.appendChild(svg("text", { x: c.x, y: Math.max(11, c.y - 3), class: `ov-label${active ? " active" : ""}` }, `${c.name} · ${CONTROL_NAMES[c.kind] ?? c.kind}`));
    }
  }

  private play() {
    const info = this.info!;
    this.playing = true;
    this.playButton.textContent = "❚❚ Pause";
    const tick = async () => {
      if (!this.playing) return;
      const s = info.segments[this.segment]!;
      let segment = this.segment, frame = this.frame + 1;
      if (frame >= s.frames) {
        segment = (this.segment + 1) % info.segments.length;
        frame = 0;
      }
      await this.show(segment, frame);
      // films at their own pace (50 ms per frame), a control's steps slower so they can be followed
      const next = info.segments[segment]!;
      this.timer = window.setTimeout(tick, next.kind === "film" ? 60 : next.kind === "rest" ? 1200 : 450);
    };
    this.timer = window.setTimeout(tick, 100);
  }

  private stop() {
    this.playing = false;
    this.playButton.textContent = "▶ Play";
    if (this.timer) window.clearTimeout(this.timer);
  }
}
