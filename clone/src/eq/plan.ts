import { createRandom, type CapturePlan, type CapturePlanner, type HostInfo, type PlannedRender, type PlanOptions } from "@vst-cloner/capture";
import type { Parameter } from "@vst-cloner/profile";
import { CUT_SHAPES, detectEq, tableNorm, tableRange, type EqMapping, type ShapeKind } from "./mapping.ts";

interface Target {
  shape?: number;
  kind: ShapeKind;
  frequency?: number;
  gainDb?: number;
  q?: number;
  slope?: number;
}

const TRAIN_FREQUENCIES = [100, 1000, 8000];
const CUT_FREQUENCIES = [150, 4000];
const GAINS = [-12, 12];
const QS = [0.7, 3];
const NARROW_QS = [0.5, 2, 8];
const VALIDATE_PER_SHAPE = 3;

function formatLabel(t: Target, mapping: EqMapping): string {
  const parts = [t.shape !== undefined && mapping.shapes ? mapping.shapes[t.shape]!.label : t.kind];
  if (t.frequency !== undefined) parts.push(`${Math.round(t.frequency)} Hz`);
  if (t.gainDb !== undefined) parts.push(`${t.gainDb > 0 ? "+" : ""}${t.gainDb.toFixed(1)} dB`);
  if (t.q !== undefined) parts.push(`Q ${t.q.toFixed(2)}`);
  if (t.slope !== undefined && mapping.slopes) parts.push(mapping.slopes[t.slope]!.label);
  return parts.join(" · ");
}

/** Builds the EQ measurement plan: every shape at several frequencies, gains and Qs, plus random validation settings. */
export function planEq(parameters: Parameter[], options: Pick<PlanOptions, "seed" | "fixed">): CapturePlan & { mapping: EqMapping } {
  const mapping = detectEq(parameters);
  const byIndex = new Map(parameters.map((p) => [p.index, p]));
  const template = mapping.bands.find((b) => b.band === mapping.templateBand)!;
  const random = createRandom(options.seed);

  const discreteNorm = (index: number, option: number) => {
    const count = byIndex.get(index)!.numSteps;
    return count > 1 ? option / (count - 1) : 0;
  };

  const physicalNorm = (index: number | undefined, value: number | undefined) => {
    if (index === undefined || value === undefined) return undefined;
    const table = mapping.tables[index];
    if (!table) return undefined;
    const [lo, hi] = tableRange(table);
    return tableNorm(table, Math.min(hi, Math.max(lo, value)));
  };

  const clampedValue = (index: number | undefined, value: number) => {
    const table = index !== undefined ? mapping.tables[index] : undefined;
    if (!table) return value;
    const [lo, hi] = tableRange(table);
    return Math.min(hi, Math.max(lo, value));
  };

  // all other bands off, template band on
  const base = new Map<number, number>((options.fixed ?? []).map((f) => [f.index, f.value]));
  const enableValues = mapping.enableValues ?? { on: 1, off: 0 };
  for (const band of mapping.bands) {
    if (band.params.enable !== undefined && band.band !== template.band) base.set(band.params.enable, enableValues.off);
  }

  const renders: Omit<PlannedRender, "id">[] = [];
  const add = (target: Target, purpose: "train" | "validate") => {
    const params = new Map(base);
    const p = template.params;
    if (p.enable !== undefined) params.set(p.enable, enableValues.on);
    if (p.shape !== undefined && target.shape !== undefined) params.set(p.shape, discreteNorm(p.shape, target.shape));
    if (p.slope !== undefined && target.slope !== undefined) params.set(p.slope, discreteNorm(p.slope, target.slope));
    for (const [role, value] of [["frequency", target.frequency], ["gain", target.gainDb], ["q", target.q]] as const) {
      const norm = physicalNorm(p[role], value);
      if (norm !== undefined) params.set(p[role]!, norm);
    }
    renders.push({
      kind: "custom",
      purpose,
      label: formatLabel(target, mapping),
      params: [...params.entries()].map(([index, value]) => ({ index, value })),
    });
  };

  // reference: template band off as well
  const reference = new Map(base);
  if (template.params.enable !== undefined) reference.set(template.params.enable, enableValues.off);
  renders.push({ kind: "default", label: "all bands off", params: [...reference.entries()].map(([index, value]) => ({ index, value })) });

  const shapes = mapping.shapes ?? [{ label: "bell", kind: "bell" as ShapeKind }];
  const randomLog = (lo: number, hi: number) => Math.exp(Math.log(lo) + random() * (Math.log(hi) - Math.log(lo)));
  const p = template.params;

  shapes.forEach((shape, shapeIndex) => {
    const s = mapping.shapes ? shapeIndex : undefined;
    const kind = shape.kind;

    if (CUT_SHAPES.includes(kind)) {
      const slopes = mapping.slopes ? mapping.slopes.map((_, i) => i) : [undefined];
      for (const slope of slopes) {
        for (const frequency of CUT_FREQUENCIES) add({ shape: s, kind, frequency, q: clampedValue(p.q, Math.SQRT1_2), slope }, "train");
      }
      const resonant = mapping.slopes?.findIndex((o) => o.order === 2);
      for (const frequency of CUT_FREQUENCIES) {
        add({ shape: s, kind, frequency, q: clampedValue(p.q, 2), slope: resonant !== undefined && resonant >= 0 ? resonant : slopes[0] }, "train");
      }
      for (let i = 0; i < VALIDATE_PER_SHAPE; i++) {
        const slope = mapping.slopes ? Math.floor(random() * mapping.slopes.length) : undefined;
        add({ shape: s, kind, frequency: randomLog(60, 8000), q: clampedValue(p.q, randomLog(0.5, 3)), slope }, "validate");
      }
    } else if (kind === "notch" || kind === "bandPass") {
      for (const frequency of TRAIN_FREQUENCIES) for (const q of NARROW_QS) add({ shape: s, kind, frequency, q: clampedValue(p.q, q) }, "train");
      for (let i = 0; i < VALIDATE_PER_SHAPE; i++) add({ shape: s, kind, frequency: randomLog(60, 10000), q: clampedValue(p.q, randomLog(0.5, 8)) }, "validate");
    } else {
      // gain shapes and unknown shapes
      for (const frequency of TRAIN_FREQUENCIES) {
        for (const gainDb of GAINS) for (const q of QS) add({ shape: s, kind, frequency, gainDb, q: clampedValue(p.q, q) }, "train");
      }
      for (let i = 0; i < VALIDATE_PER_SHAPE; i++) {
        const gainDb = Math.round((random() * 36 - 18) * 10) / 10;
        add({ shape: s, kind, frequency: randomLog(40, 12000), gainDb: Math.abs(gainDb) < 2 ? 6 : gainDb, q: clampedValue(p.q, randomLog(0.4, 6)) }, "validate");
      }
    }
  });

  const width = Math.max(4, String(renders.length - 1).length);
  const selected = Object.values(template.params).map((index) => byIndex.get(index)!);
  return {
    mapping,
    selected,
    renders: renders.map((r, i) => ({ id: `r${String(i).padStart(width, "0")}`, ...r })),
  };
}

export const eqPlanner: CapturePlanner = {
  name: "eq",
  signalPreset: "eq",
  plan: (info: HostInfo, options: PlanOptions) => planEq(info.parameters, options),
};
