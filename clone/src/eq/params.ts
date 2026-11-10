import type { Parameter } from "@vst-cloner/profile";
import { optionIndex, tableRange, tableValue, textDecimals } from "./mapping.ts";
import type { EqModel } from "./model.ts";

export interface CloneParam {
  /** plugin parameter id */
  id: string;
  /** parameter name shown in the DAW (same as in the original) */
  name: string;
  /** original parameter index */
  original: number;
  kind: "continuous" | "choice" | "toggle";
  /** default: physical value (continuous), option index (choice) or 0/1 (toggle) */
  defaultValue: number;
  /** continuous: normalized → physical points (same curve as the original) */
  points?: [number, number][];
  log?: boolean;
  unit?: string;
  choices?: string[];
  /** choice/toggle of an original that reports it as continuous: the original's normalised value per option */
  stepValues?: number[];
  /** decimal places of the value text (as in the original); undefined = automatic */
  decimals?: number;
}

/** Plugin parameters of the clone: the band parameters and output gain of the original. */
export function cloneParameters(model: EqModel, parameters: Parameter[]): CloneParam[] {
  const byIndex = new Map(parameters.map((p) => [p.index, p]));
  const result: CloneParam[] = [];
  const base = (p: Parameter) => p.value ?? p.default;

  const continuous = (index: number, id: string): CloneParam | undefined => {
    const table = model.mapping.tables[index];
    const p = byIndex.get(index);
    if (!table || !p) return undefined;
    const [lo, hi] = tableRange(table);
    return {
      id,
      name: p.name,
      original: index,
      kind: "continuous",
      defaultValue: Math.min(hi, Math.max(lo, tableValue(table, base(p)))),
      points: table.points,
      log: table.log,
      unit: table.unit,
      ...(textDecimals(p) !== undefined ? { decimals: textDecimals(p)! } : {}),
    };
  };

  for (const band of model.mapping.bands) {
    const prefix = `b${band.band}_`;
    const p = band.params;
    if (p.enable !== undefined) {
      const param = byIndex.get(p.enable)!;
      const on = model.mapping.enableValues?.on ?? 1;
      result.push({ id: `${prefix}enable`, name: param.name, original: p.enable, kind: "toggle", defaultValue: Math.abs(base(param) - on) < 0.5 ? 1 : 0 });
    }
    for (const [role, suffix] of [["frequency", "freq"], ["gain", "gain"], ["q", "q"]] as const) {
      const index = p[role];
      if (index === undefined) continue;
      const param = continuous(index, `${prefix}${suffix}`);
      if (param) result.push(param);
    }
    if (p.shape !== undefined && model.mapping.shapes) {
      const param = byIndex.get(p.shape)!;
      result.push({
        id: `${prefix}shape`, name: param.name, original: p.shape, kind: "choice",
        defaultValue: optionIndex(base(param), model.mapping.shapes.length), choices: model.mapping.shapes.map((s) => s.label),
      });
    }
    if (p.slope !== undefined && model.mapping.slopes) {
      const param = byIndex.get(p.slope)!;
      result.push({
        id: `${prefix}slope`, name: param.name, original: p.slope, kind: "choice",
        defaultValue: optionIndex(base(param), model.mapping.slopes.length), choices: model.mapping.slopes.map((s) => s.label),
      });
    }
  }

  if (model.mapping.outputGain !== undefined) {
    const param = continuous(model.mapping.outputGain, "output_gain");
    if (param) result.push(param);
  }
  return result;
}
