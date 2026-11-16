import { createRandom, type CapturePlan, type CapturePlanner, type HostInfo, type PlannedRender, type PlanOptions } from "@vst-cloner/capture";
import type { Parameter } from "@vst-cloner/profile";
import { bandGroups, bandLabel, CUT_SHAPES, detectEq, tableNorm, tableRange, type EqMapping, type ShapeKind, type ShapeOption } from "./mapping.ts";

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

function formatLabel(t: Target, shapes: ShapeOption[] | undefined, mapping: EqMapping, prefix: string): string {
  const parts = [t.shape !== undefined && shapes ? shapes[t.shape]!.label : prefix ? "" : t.kind].filter(Boolean);
  if (t.frequency !== undefined) parts.push(`${Math.round(t.frequency)} Hz`);
  if (t.gainDb !== undefined) parts.push(`${t.gainDb > 0 ? "+" : ""}${t.gainDb.toFixed(1)} dB`);
  if (t.q !== undefined) parts.push(`Q ${t.q.toFixed(2)}`);
  if (t.slope !== undefined && mapping.slopes) parts.push(mapping.slopes[t.slope]!.label);
  return (prefix ? `${prefix}: ` : "") + parts.join(" · ");
}

/** settings of several bands at once: they check that the bands add up as the model assumes */
export const COMBINATION_RENDERS = 6;
export const COMBINATION_LABEL = "combination";

/**
 * Builds the EQ measurement plan: for every group of bands its template band alone, with every shape at several
 * frequencies, gains and Qs, plus random validation settings and a few settings of all bands at once.
 */
export function planEq(parameters: Parameter[], options: Pick<PlanOptions, "seed" | "fixed">): CapturePlan & { mapping: EqMapping } {
  const mapping = detectEq(parameters);
  const byIndex = new Map(parameters.map((p) => [p.index, p]));
  const groups = bandGroups(mapping);
  const random = createRandom(options.seed);

  const discreteNorm = (index: number, option: number) => {
    const count = byIndex.get(index)!.numSteps;
    return count > 1 ? option / (count - 1) : 0;
  };
  const shapeNorm = (index: number, shapes: ShapeOption[], option: number) => shapes[option]!.value ?? discreteNorm(index, option);

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

  // every band out of the way: switched off, or – without a switch – at 0 dB
  const base = new Map<number, number>((options.fixed ?? []).map((f) => [f.index, f.value]));
  const enableValues = mapping.enableValues ?? { on: 1, off: 0 };
  for (const band of mapping.bands) {
    if (band.params.enable !== undefined) base.set(band.params.enable, enableValues.off);
    else if (band.params.gain !== undefined) base.set(band.params.gain, physicalNorm(band.params.gain, 0)!);
  }

  const renders: Omit<PlannedRender, "id">[] = [];
  const seen = new Set<string>();
  const randomLog = (lo: number, hi: number) => Math.exp(Math.log(lo) + random() * (Math.log(hi) - Math.log(lo)));

  renders.push({ kind: "default", label: "all bands off", params: [...base.entries()].map(([index, value]) => ({ index, value })) });

  groups.forEach((group) => {
    const template = mapping.bands.find((b) => b.band === group.template)!;
    const p = template.params;
    const prefix = groups.length > 1 ? bandLabel(template) : "";

    const add = (wanted: Target, purpose: "train" | "validate") => {
      // only what the band has a control for is set and named
      const target: Target = {
        ...wanted,
        frequency: p.frequency !== undefined && wanted.frequency !== undefined ? clampedValue(p.frequency, wanted.frequency) : undefined,
        gainDb: p.gain !== undefined && wanted.gainDb !== undefined ? clampedValue(p.gain, wanted.gainDb) : undefined,
        q: p.q !== undefined && wanted.q !== undefined ? clampedValue(p.q, wanted.q) : undefined,
      };
      const params = new Map(base);
      if (p.enable !== undefined) params.set(p.enable, enableValues.on);
      if (p.shape !== undefined && target.shape !== undefined) params.set(p.shape, shapeNorm(p.shape, group.shapes!, target.shape));
      if (p.slope !== undefined && target.slope !== undefined) params.set(p.slope, discreteNorm(p.slope, target.slope));
      for (const [role, value] of [["frequency", target.frequency], ["gain", target.gainDb], ["q", target.q]] as const) {
        const norm = physicalNorm(p[role], value);
        if (norm !== undefined) params.set(p[role]!, norm);
      }
      const list = [...params.entries()].map(([index, value]) => ({ index, value }));
      // a band without frequency or Q control gives the same setting several times
      const key = `${purpose}|${list.map((v) => `${v.index}=${v.value.toFixed(6)}`).join(",")}`;
      if (seen.has(key)) return;
      seen.add(key);
      renders.push({ kind: "custom", purpose, label: formatLabel(target, group.shapes, mapping, prefix), params: list });
    };

    // without a shape control the fit finds the shape: a band with a gain is a bell or a shelf, one without a cut
    const shapes = group.shapes ?? [{ label: bandLabel(template), kind: group.hint ?? (p.gain !== undefined ? "bell" : "lowCut") as ShapeKind }];
    // sliders: more gains instead of frequencies and Qs
    const gains = p.frequency === undefined ? [-12, -6, 6, 12] : GAINS;

    shapes.forEach((shape, shapeIndex) => {
      const s = group.shapes ? shapeIndex : undefined;
      const kind = shape.kind;

      if (CUT_SHAPES.includes(kind)) {
        const slopes = mapping.slopes && p.slope !== undefined && shape.order === undefined ? mapping.slopes.map((_, i) => i) : [undefined];
        for (const slope of slopes) {
          for (const frequency of CUT_FREQUENCIES) add({ shape: s, kind, frequency, q: clampedValue(p.q, Math.SQRT1_2), slope }, "train");
        }
        const resonant = slopes[0] !== undefined ? mapping.slopes?.findIndex((o) => o.order === 2) : undefined;
        for (const frequency of CUT_FREQUENCIES) {
          add({ shape: s, kind, frequency, q: clampedValue(p.q, 2), slope: resonant !== undefined && resonant >= 0 ? resonant : slopes[0] }, "train");
        }
        for (let i = 0; i < VALIDATE_PER_SHAPE; i++) {
          const slope = slopes[0] !== undefined ? Math.floor(random() * mapping.slopes!.length) : undefined;
          add({ shape: s, kind, frequency: clampedValue(p.frequency, randomLog(60, 8000)), q: clampedValue(p.q, randomLog(0.5, 3)), slope }, "validate");
        }
      } else if (kind === "notch" || kind === "bandPass") {
        for (const frequency of TRAIN_FREQUENCIES) for (const q of NARROW_QS) add({ shape: s, kind, frequency, q: clampedValue(p.q, q) }, "train");
        for (let i = 0; i < VALIDATE_PER_SHAPE; i++) add({ shape: s, kind, frequency: randomLog(60, 10000), q: clampedValue(p.q, randomLog(0.5, 8)) }, "validate");
      } else {
        // gain shapes and unknown shapes
        for (const frequency of TRAIN_FREQUENCIES) {
          for (const gainDb of gains) for (const q of QS) add({ shape: s, kind, frequency: clampedValue(p.frequency, frequency), gainDb: clampedValue(p.gain, gainDb), q: clampedValue(p.q, q) }, "train");
        }
        for (let i = 0; i < VALIDATE_PER_SHAPE; i++) {
          const gainDb = Math.round((random() * 36 - 18) * 10) / 10;
          add({ shape: s, kind, frequency: clampedValue(p.frequency, randomLog(40, 12000)), gainDb: clampedValue(p.gain, Math.abs(gainDb) < 2 ? 6 : gainDb), q: clampedValue(p.q, randomLog(0.4, 6)) }, "validate");
        }
      }
    });
  });

  // all bands at once, each with a setting of its own
  if (mapping.bands.length > 1) {
    for (let i = 0; i < COMBINATION_RENDERS; i++) {
      const params = new Map(base);
      for (const band of mapping.bands) {
        const p = band.params;
        const group = groups[band.group ?? 0]!;
        if (p.enable !== undefined) params.set(p.enable, random() < 0.75 ? enableValues.on : enableValues.off);
        if (p.shape !== undefined && group.shapes) {
          const usable = group.shapes.map((s, index) => ({ s, index })).filter(({ s }) => s.kind !== "unsupported");
          if (usable.length) params.set(p.shape, shapeNorm(p.shape, group.shapes, usable[Math.floor(random() * usable.length)]!.index));
        }
        const values = { frequency: randomLog(40, 12000), gain: Math.round((random() * 18 - 9) * 10) / 10, q: randomLog(0.5, 3) };
        for (const role of ["frequency", "gain", "q"] as const) {
          const norm = physicalNorm(p[role], values[role]);
          if (norm !== undefined) params.set(p[role]!, norm);
        }
      }
      renders.push({ kind: "custom", purpose: "validate", label: `${COMBINATION_LABEL} ${i + 1}`, params: [...params.entries()].map(([index, value]) => ({ index, value })) });
    }
  }

  const width = Math.max(4, String(renders.length - 1).length);
  const selected = [...new Set(mapping.bands.flatMap((b) => Object.values(b.params)))].map((index) => byIndex.get(index)!);
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
