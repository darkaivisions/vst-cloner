import type { CaptureRender, Parameter } from "@vst-cloner/profile";
import { buildTable, tableRange, tableValue } from "../eq/mapping.ts";
import type { CloneParam } from "../eq/params.ts";
import type { DynamicsModel } from "./fit.ts";

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "param";

/**
 * Plugin parameters of a dynamics clone: every parameter the model depends on, with the original's name,
 * display table (normalised ↔ physical) and options. The normalised values equal the original's, so the
 * model tables (indexed by normalised values) apply directly.
 */
export function dynamicsCloneParameters(model: DynamicsModel, parameters: Parameter[], renders: CaptureRender[] = []): CloneParam[] {
  const byIndex = new Map(parameters.map((p) => [p.index, p]));
  const used = new Set<string>();
  return model.tables.map((table) => {
    const p = byIndex.get(table.index)!;
    let id = slug(p.name);
    while (used.has(id)) id += "_";
    used.add(id);
    const norm = p.value ?? p.default;

    if (p.discrete && p.numSteps >= 2 && p.numSteps <= 64) {
      const texts = [...(p.texts ?? [])].sort((a, b) => a.value - b.value);
      const choices = texts.length === p.numSteps ? texts.map((t) => t.text) : Array.from({ length: p.numSteps }, (_, i) => String(i));
      const index = Math.round(norm * (p.numSteps - 1));
      if (p.numSteps === 2 && p.boolean) return { id, name: p.name, original: p.index, kind: "toggle", defaultValue: index };
      return { id, name: p.name, original: p.index, kind: "choice", defaultValue: index, choices };
    }

    const value = buildTable(p, renders);
    const monotonic = value && value.points.every((pt, i, all) => i === 0 || Math.sign(pt[1] - all[i - 1]![1]) === Math.sign(all[all.length - 1]![1] - all[0]![1]));
    if (value && monotonic) {
      const [lo, hi] = tableRange(value);
      return {
        id, name: p.name, original: p.index, kind: "continuous",
        defaultValue: Math.min(hi, Math.max(lo, tableValue(value, norm))),
        points: value.points, log: value.log, unit: value.unit,
      };
    }
    return { id, name: p.name, original: p.index, kind: "continuous", defaultValue: norm, points: [[0, 0], [1, 1]], unit: "" };
  });
}
