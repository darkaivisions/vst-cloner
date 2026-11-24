import type { JobEvent } from "../bridge.ts";
import { clear, h, zoomImage } from "../dom.ts";

/**
 * Side panel next to the clone workflow: what the running job is doing, as it happens – the original's editor (it
 * follows every measured setting), the controls of that setting, the level over time and the response of each
 * render, the network's training error, and the rebuilt editor of the clone. It keeps the last state when the job
 * ends, until the next one starts.
 */

/** effect class of the job: decides which response is drawn */
export type LiveMode = "eq" | "dynamics" | "distortion" | "delay" | "modulation" | "reverb" | "neural" | "best";

type Phase = "measure" | "verify";

/** A render as the bridge sends it (bridge/src/live.ts): levels in dBFS, third-octave bands from 25 Hz. */
interface LiveAudio {
  type: "audio";
  phase: Phase;
  id: string;
  controls: { name: string; text: string }[];
  seconds: number;
  envIn: number[];
  envOut: number[];
  envRef?: number[];
  bandsIn: number[];
  bandsOut: number[];
  bandsRef?: number[];
}

type LiveData =
  | LiveAudio
  | { type: "training"; step: number; seconds: number; budget: number; loss: number }
  | { type: "validation"; step: number; seconds: number; esr: number }
  | { type: "editor"; svg: string };

const BAND_CENTRES = Array.from({ length: 30 }, (_, i) => 25 * Math.pow(2, i / 3));
/** renders drawn faded behind the current one */
const HISTORY = 12;

const COLORS = { clone: "#5b8cff", original: "#f0b429", input: "#8b93a1", grid: "#2a2f39", text: "#8b93a1", good: "#3ecf8e", bad: "#f2555a" };

export class LivePanel {
  readonly element: HTMLElement;

  private mode: LiveMode = "neural";
  private stage = "";
  /** id of the running stage ("gui-verify": the clone's own editor is being filmed) */
  private stageId = "";
  private renders = 0;
  private history: LiveAudio[] = [];
  private training: { seconds: number; loss: number }[] = [];
  private validation: { seconds: number; esr: number }[] = [];
  private budget = 0;
  /** clone vs. original per verified setting (mean band deviation, dB) */
  private deviations: number[] = [];

  private readonly status = h("div.live-status");
  private readonly placeholder = h("p.live-empty", {},
    "Starts with measuring or building: the plugin's editor, every measured setting and the training show up here as they happen.");
  private readonly original = new Picture("Original");
  private readonly clone = new Picture("Clone");
  private readonly editors = h("div.live-editors.hidden", {}, this.original.element, this.clone.element);
  private readonly controls = h("div.live-controls.hidden");
  private readonly levelPlot = new Plot("Level over time");
  private readonly responsePlot = new Plot("Response");
  private readonly fitPlot = new Plot("Training");
  private readonly legend = h("div.live-legend.hidden");

  constructor() {
    this.element = h("aside.live-panel.card", {},
      h("header.live-header", {}, h("span.live-dot"), h("h2", {}, "Live"), this.status),
      this.placeholder, this.editors, this.controls, this.legend,
      this.levelPlot.element, this.responsePlot.element, this.fitPlot.element);
    for (const plot of [this.levelPlot, this.responsePlot, this.fitPlot]) plot.element.classList.add("hidden");
    new ResizeObserver(() => this.redraw()).observe(this.element);
  }

  /** A new job: everything from the last one goes away. */
  start(mode: LiveMode, what: string): void {
    this.mode = mode;
    this.stage = what;
    this.stageId = "";
    this.renders = 0;
    this.history = [];
    this.training = [];
    this.validation = [];
    this.deviations = [];
    this.original.reset();
    this.clone.reset();
    this.controls.classList.add("hidden");
    this.legend.classList.add("hidden");
    for (const plot of [this.levelPlot, this.responsePlot, this.fitPlot]) plot.element.classList.add("hidden");
    this.editors.classList.add("hidden");
    this.placeholder.classList.add("hidden");
    this.element.classList.add("running");
    this.renderStatus();
  }

  /** The job ended (the panel keeps its last state). */
  finish(text: string): void {
    this.element.classList.remove("running");
    this.stage = text;
    this.renderStatus();
  }

  handle(event: JobEvent): void {
    if (event.kind === "stage") {
      this.stage = event.title;
      this.stageId = event.stage;
      this.renderStatus();
    } else if (event.kind === "progress") {
      this.renderStatus(event.total > 1 ? `${event.done} / ${event.total}` : undefined);
    } else if (event.kind === "preview") {
      // the clone's own editor is filmed when it is compared; everything else is the original
      const isClone = this.stageId === "gui-verify";
      (isClone ? this.clone : this.original).show(event.src, isClone ? "the clone's editor, filmed for the comparison" : describePicture(event.label));
      this.editors.classList.remove("hidden");
    } else if (event.kind === "live") {
      this.receive(event.live as LiveData);
    }
  }

  private receive(data: LiveData): void {
    if (data.type === "audio") {
      this.renders++;
      // a new phase starts a new history (the clone's renders are not compared with the original's measurements)
      if (this.history.length && this.history[this.history.length - 1]!.phase !== data.phase) this.history = [];
      this.history.push(data);
      if (this.history.length > HISTORY) this.history.shift();
      if (data.bandsRef) this.deviations.push(bandDeviation(data.bandsOut, data.bandsRef));
      this.renderControls(data);
      this.renderLegend(data);
      this.levelPlot.element.classList.remove("hidden");
      this.responsePlot.element.classList.remove("hidden");
      if (this.deviations.length) this.fitPlot.element.classList.remove("hidden");
    } else if (data.type === "training") {
      this.budget = data.budget;
      this.training.push({ seconds: data.seconds, loss: data.loss });
      this.fitPlot.element.classList.remove("hidden");
    } else if (data.type === "validation") {
      this.validation.push({ seconds: data.seconds, esr: data.esr });
    } else if (data.type === "editor") {
      this.clone.show(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(data.svg)}`, "rebuilt from the original's editor");
      this.editors.classList.remove("hidden");
    }
    this.redraw();
  }

  private renderStatus(progress?: string): void {
    this.status.textContent = [this.stage, progress].filter(Boolean).join(" · ");
  }

  private renderControls(audio: LiveAudio): void {
    clear(this.controls);
    this.controls.classList.remove("hidden");
    this.controls.append(h("span.live-render", {}, audio.phase === "verify" ? `Clone · ${audio.id}` : audio.id));
    if (!audio.controls.length) this.controls.append(h("span.live-control.muted", {}, "all controls at their default"));
    for (const c of audio.controls.slice(0, 16)) this.controls.append(h("span.live-control", {}, h("span.muted", {}, `${c.name} `), tidyNumber(c.text)));
    if (audio.controls.length > 16) this.controls.append(h("span.live-control.muted", {}, `+${audio.controls.length - 16} more`));
  }

  private renderLegend(audio: LiveAudio): void {
    clear(this.legend);
    this.legend.classList.remove("hidden");
    const item = (color: string, text: string) => h("span.live-key", {}, h("i", { style: `background:${color}` }), text);
    if (audio.phase === "verify") this.legend.append(item(COLORS.original, "original"), item(COLORS.clone, "clone"), item(COLORS.input, "test signal"));
    else this.legend.append(item(COLORS.clone, "plugin output"), item(COLORS.input, "test signal"));
  }

  private redraw(): void {
    const current = this.history[this.history.length - 1];
    if (current) {
      this.levelPlot.draw((g) => drawLevel(g, current));
      if (this.mode === "eq") {
        this.responsePlot.setTitle("Frequency response");
        this.responsePlot.draw((g) => drawFrequencyResponse(g, this.history));
      } else if (this.mode === "dynamics") {
        this.responsePlot.setTitle("Transfer curve (input → output level)");
        this.responsePlot.draw((g) => drawTransfer(g, this.history));
      } else {
        this.responsePlot.setTitle("Spectrum (third octaves)");
        this.responsePlot.draw((g) => drawSpectrum(g, current));
      }
    }
    if (this.training.length) {
      this.fitPlot.setTitle(`Training the network · error ${this.training[this.training.length - 1]!.loss.toFixed(4)}` +
        (this.validation.length ? ` · held-back settings ${this.validation[this.validation.length - 1]!.esr.toFixed(4)}` : ""));
      this.fitPlot.draw((g) => drawTraining(g, this.training, this.validation, this.budget));
    } else if (this.deviations.length) {
      const sorted = [...this.deviations].sort((a, b) => a - b);
      this.fitPlot.setTitle(`Clone vs. original · ${this.deviations.length} settings · typical ${sorted[Math.floor(sorted.length / 2)]!.toFixed(1)} dB`);
      this.fitPlot.draw((g) => drawDeviations(g, this.deviations));
    }
  }
}

/** One editor picture with a caption; click enlarges it. */
class Picture {
  readonly element: HTMLElement;
  private readonly image = h("img.live-editor-image");
  private readonly caption = h("figcaption.live-caption");

  constructor(private readonly title: string) {
    this.element = h("figure.live-editor.hidden", {}, this.image, this.caption);
    this.image.addEventListener("click", () => zoomImage(this.image.src, `${this.title}: ${this.caption.textContent ?? ""}`));
  }

  show(src: string, what: string): void {
    this.image.src = src;
    this.caption.textContent = `${this.title} · ${what}`;
    this.element.classList.remove("hidden");
  }

  reset(): void {
    this.element.classList.add("hidden");
    this.image.removeAttribute("src");
  }
}

/** A canvas with a title, drawn at the screen's pixel density. */
class Plot {
  readonly element: HTMLElement;
  private readonly title = h("div.live-plot-title");
  private readonly canvas = h("canvas.live-canvas");

  constructor(title: string) {
    this.title.textContent = title;
    this.element = h("div.live-plot", {}, this.title, this.canvas);
  }

  setTitle(text: string): void {
    this.title.textContent = text;
  }

  draw(paint: (g: Graph) => void): void {
    if (this.element.classList.contains("hidden")) return;
    const width = this.canvas.clientWidth, height = this.canvas.clientHeight;
    if (!width || !height) return;
    const ratio = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(width * ratio) || this.canvas.height !== Math.round(height * ratio)) {
      this.canvas.width = Math.round(width * ratio);
      this.canvas.height = Math.round(height * ratio);
    }
    const ctx = this.canvas.getContext("2d")!;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    paint(new Graph(ctx, width, height));
  }
}

/** Plot area with axes: x and y ranges mapped into the canvas, leaving room for the labels. */
class Graph {
  readonly left = 34;
  readonly right = 6;
  readonly top = 6;
  readonly bottom = 16;
  xMin = 0; xMax = 1; yMin = 0; yMax = 1; logX = false;

  constructor(readonly ctx: CanvasRenderingContext2D, readonly width: number, readonly height: number) {}

  range(x: [number, number], y: [number, number], logX = false): this {
    [this.xMin, this.xMax] = x;
    [this.yMin, this.yMax] = y;
    this.logX = logX;
    return this;
  }

  px(x: number): number {
    const t = this.logX ? Math.log(x / this.xMin) / Math.log(this.xMax / this.xMin) : (x - this.xMin) / (this.xMax - this.xMin);
    return this.left + t * (this.width - this.left - this.right);
  }

  py(y: number): number {
    const t = (Math.min(this.yMax, Math.max(this.yMin, y)) - this.yMin) / (this.yMax - this.yMin);
    return this.height - this.bottom - t * (this.height - this.top - this.bottom);
  }

  grid(xTicks: { at: number; label: string }[], yTicks: { at: number; label: string }[]): void {
    const { ctx } = this;
    ctx.lineWidth = 1;
    ctx.strokeStyle = COLORS.grid;
    ctx.fillStyle = COLORS.text;
    ctx.font = "10px Inter, system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (const t of yTicks) {
      const y = Math.round(this.py(t.at)) + 0.5;
      ctx.beginPath(); ctx.moveTo(this.left, y); ctx.lineTo(this.width - this.right, y); ctx.stroke();
      ctx.fillText(t.label, this.left - 4, y);
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const t of xTicks) {
      const x = Math.round(this.px(t.at)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, this.top); ctx.lineTo(x, this.height - this.bottom); ctx.stroke();
      // labels at the edges stay inside the canvas
      const half = ctx.measureText(t.label).width / 2;
      ctx.fillText(t.label, Math.min(this.width - half - 1, Math.max(half + 1, x)), this.height - this.bottom + 3);
    }
  }

  line(xs: ArrayLike<number>, ys: ArrayLike<number>, color: string, alpha = 1, width = 1.5, dash: number[] = []): void {
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dash);
    ctx.beginPath();
    for (let i = 0; i < xs.length; i++) {
      const x = this.px(xs[i]!), y = this.py(ys[i]!);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  dots(xs: number[], ys: number[], color: string, alpha = 1, radius = 1.6): void {
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    for (let i = 0; i < xs.length; i++) {
      ctx.beginPath();
      ctx.arc(this.px(xs[i]!), this.py(ys[i]!), radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

const FREQ_TICKS = [{ at: 50, label: "50" }, { at: 100, label: "100" }, { at: 500, label: "500" }, { at: 1000, label: "1k" }, { at: 5000, label: "5k" }, { at: 10000, label: "10k" }];
const dbTicks = (from: number, to: number, step: number) => {
  const ticks = [];
  for (let v = Math.ceil(from / step) * step; v <= to; v += step) ticks.push({ at: v, label: `${v}` });
  return ticks;
};

/** Level of input and output (or original and clone) over the render. */
function drawLevel(g: Graph, audio: LiveAudio): void {
  const n = audio.envOut.length;
  const xs = Array.from({ length: n }, (_, i) => ((i + 0.5) / n) * audio.seconds);
  const all = [...audio.envOut, ...audio.envIn, ...(audio.envRef ?? [])].filter((v) => v > -119);
  const top = Math.min(12, Math.ceil(Math.max(-60, ...all) / 6) * 6 + 6);
  g.range([0, audio.seconds], [Math.max(-100, top - 96), top]);
  const step = audio.seconds > 20 ? 5 : audio.seconds > 8 ? 2 : 1;
  g.grid(Array.from({ length: Math.floor(audio.seconds / step) }, (_, i) => ({ at: (i + 1) * step, label: `${(i + 1) * step} s` })), dbTicks(g.yMin, g.yMax, 24));
  g.line(xs, audio.envIn, COLORS.input, 0.6, 1);
  if (audio.envRef) g.line(xs, audio.envRef, COLORS.original, 0.95, 1.5);
  g.line(xs, audio.envOut, COLORS.clone, 1, 1.5);
}

/** Output minus input per third-octave band: the EQ's curve, the last renders faded behind the current one. */
function drawFrequencyResponse(g: Graph, history: LiveAudio[]): void {
  const curves = history.map((a) => ({ out: a.bandsOut.map((v, i) => v - a.bandsIn[i]!), ref: a.bandsRef?.map((v, i) => v - a.bandsIn[i]!) }));
  const values = curves.flatMap((c) => [...c.out, ...(c.ref ?? [])]).filter(Number.isFinite);
  const span = Math.min(36, Math.max(12, Math.ceil(Math.max(...values.map(Math.abs)) / 6) * 6));
  g.range([BAND_CENTRES[0]!, BAND_CENTRES[BAND_CENTRES.length - 1]!], [-span, span], true);
  g.grid(FREQ_TICKS, dbTicks(-span, span, span > 18 ? 12 : 6));
  curves.forEach((c, k) => {
    const latest = k === curves.length - 1;
    if (c.ref) g.line(BAND_CENTRES, c.ref, COLORS.original, latest ? 0.95 : 0.15, latest ? 1.5 : 1);
    g.line(BAND_CENTRES, c.out, COLORS.clone, latest ? 1 : 0.18, latest ? 2 : 1);
  });
}

/** Output level against input level (the level curve's slices), the last renders faded. */
function drawTransfer(g: Graph, history: LiveAudio[]): void {
  g.range([-96, 0], [-96, 12]);
  g.grid(dbTicks(-96, 0, 24).map((t) => ({ ...t, label: `${t.at}` })), dbTicks(-96, 12, 24));
  g.line([-96, 0], [-96, 0], COLORS.grid, 1, 1, [3, 3]);
  history.forEach((a, k) => {
    const latest = k === history.length - 1;
    const xs: number[] = [], ys: number[] = [], rs: number[] = [];
    for (let i = 0; i < a.envIn.length; i++) {
      if (a.envIn[i]! <= -100) continue;
      xs.push(a.envIn[i]!);
      ys.push(a.envOut[i]!);
      if (a.envRef) rs.push(a.envRef[i]!);
    }
    if (rs.length) g.dots(xs, rs, COLORS.original, latest ? 0.9 : 0.12, latest ? 2 : 1.4);
    g.dots(xs, ys, COLORS.clone, latest ? 1 : 0.15, latest ? 2 : 1.4);
  });
}

/** Spectrum of input and output (or original and clone), third octaves. */
function drawSpectrum(g: Graph, audio: LiveAudio): void {
  const all = [...audio.bandsOut, ...audio.bandsIn, ...(audio.bandsRef ?? [])].filter((v) => v > -119);
  const top = Math.ceil(Math.max(-60, ...all) / 12) * 12 + 6;
  g.range([BAND_CENTRES[0]!, BAND_CENTRES[BAND_CENTRES.length - 1]!], [top - 72, top], true);
  g.grid(FREQ_TICKS, dbTicks(top - 72, top, 24));
  g.line(BAND_CENTRES, audio.bandsIn, COLORS.input, 0.6, 1);
  if (audio.bandsRef) g.line(BAND_CENTRES, audio.bandsRef, COLORS.original, 0.95, 1.5);
  g.line(BAND_CENTRES, audio.bandsOut, COLORS.clone, 1, 2);
}

/** Training error over time (logarithmic), validation as dots; the x axis spans the training time. */
function drawTraining(g: Graph, training: { seconds: number; loss: number }[], validation: { seconds: number; esr: number }[], budget: number): void {
  const values = [...training.map((t) => t.loss), ...validation.map((v) => v.esr)].filter((v) => v > 0 && Number.isFinite(v));
  const lo = Math.floor(Math.log10(Math.min(...values))), hi = Math.ceil(Math.log10(Math.max(...values)));
  const span = Math.max(budget, training[training.length - 1]!.seconds, 1);
  g.range([0, span], [lo, Math.max(hi, lo + 1)]);
  const minutes = span / 60, step = minutes > 20 ? 10 : minutes > 6 ? 2 : 1;
  g.grid(Array.from({ length: Math.floor(minutes / step) }, (_, i) => ({ at: (i + 1) * step * 60, label: `${(i + 1) * step} min` })),
    Array.from({ length: Math.max(hi, lo + 1) - lo + 1 }, (_, i) => ({ at: lo + i, label: formatPower(lo + i) })));
  g.line(training.map((t) => t.seconds), training.map((t) => Math.log10(Math.max(t.loss, 1e-9))), COLORS.clone, 0.9, 1.2);
  g.dots(validation.map((v) => v.seconds), validation.map((v) => Math.log10(Math.max(v.esr, 1e-9))), COLORS.original, 1, 3);
}

/** Deviation of the clone from the original per verified setting, in the order they were checked. */
function drawDeviations(g: Graph, deviations: number[]): void {
  const top = Math.max(3, Math.ceil(Math.max(...deviations) / 3) * 3);
  g.range([0, Math.max(deviations.length, 10)], [0, top]);
  g.grid([], dbTicks(0, top, top > 12 ? 6 : 3).map((t) => ({ ...t, label: `${t.at} dB` })));
  const { ctx } = g;
  const w = Math.max(1, (g.px(1) - g.px(0)) * 0.7);
  deviations.forEach((d, i) => {
    ctx.fillStyle = d < 1 ? COLORS.good : d < 3 ? COLORS.original : COLORS.bad;
    ctx.fillRect(g.px(i + 0.15), g.py(d), w, g.py(0) - g.py(d));
  });
}

/** "79.541862" → "79.5", "-68.069000" → "−68.1"; texts with units or words stay as the plugin shows them */
function tidyNumber(text: string): string {
  if (!/^\s*-?\d+(\.\d+)?\s*$/.test(text)) return text;
  const v = Number(text);
  const digits = Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2;
  return v.toFixed(digits).replace("-", "−");
}

function formatPower(exponent: number): string {
  return exponent >= 0 ? `${Math.pow(10, exponent)}` : `1e${exponent}`;
}

/** mean deviation of two spectra over the bands that carry signal */
function bandDeviation(out: number[], ref: number[]): number {
  const loud = Math.max(...ref);
  let sum = 0, n = 0;
  for (let i = 0; i < ref.length; i++) {
    if (ref[i]! < loud - 60) continue;
    sum += Math.abs(out[i]! - ref[i]!);
    n++;
  }
  return n ? sum / n : 0;
}

/** "live r0012" → "following setting r0012", "p3_2" → "moving parameter 3", "film -20 dBFS" → meters */
function describePicture(label: string): string {
  if (label.startsWith("live ")) return label === "live base" ? "opened invisibly next to the measurement" : `follows the measurement · ${label.slice(5)}`;
  if (label.startsWith("film")) return `filming the meters (${label.slice(5)})`;
  if (label === "base" || label === "base2") return "initial state";
  const moving = /^p(\d+)/.exec(label);
  return moving ? `captured invisibly · moving parameter ${moving[1]}` : label;
}
