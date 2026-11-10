/** Nelder–Mead simplex minimisation (unconstrained; transform bounded parameters before). */
export function nelderMead(
  f: (x: number[]) => number,
  start: number[],
  options: { step?: number[]; maxEvaluations?: number; tolerance?: number } = {},
): { x: number[]; value: number; evaluations: number } {
  const n = start.length;
  const step = options.step ?? start.map((v) => (Math.abs(v) > 1e-3 ? Math.abs(v) * 0.1 : 0.1));
  const maxEvaluations = options.maxEvaluations ?? 200 * n;
  const tolerance = options.tolerance ?? 1e-7;

  let evaluations = 0;
  const evaluate = (x: number[]) => {
    evaluations++;
    const v = f(x);
    return Number.isFinite(v) ? v : Infinity;
  };

  let simplex = [start, ...start.map((_, i) => start.map((v, j) => (i === j ? v + step[i]! : v)))].map((x) => ({ x, v: evaluate(x) }));

  while (evaluations < maxEvaluations) {
    simplex.sort((a, b) => a.v - b.v);
    const best = simplex[0]!, worst = simplex[n]!;
    if (Math.abs(worst.v - best.v) <= tolerance * (Math.abs(best.v) + 1e-12)) break;

    const centroid = new Array<number>(n).fill(0);
    for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) centroid[i]! += simplex[k]!.x[i]! / n;
    const along = (t: number) => centroid.map((c, i) => c + t * (worst.x[i]! - c));

    const reflected = along(-1);
    const rv = evaluate(reflected);
    if (rv < best.v) {
      const expanded = along(-2);
      const ev = evaluate(expanded);
      simplex[n] = ev < rv ? { x: expanded, v: ev } : { x: reflected, v: rv };
    } else if (rv < simplex[n - 1]!.v) {
      simplex[n] = { x: reflected, v: rv };
    } else {
      const contracted = rv < worst.v ? along(-0.5) : along(0.5);
      const cv = evaluate(contracted);
      if (cv < Math.min(rv, worst.v)) simplex[n] = { x: contracted, v: cv };
      else simplex = simplex.map((p, k) => (k === 0 ? p : { x: p.x.map((v, i) => best.x[i]! + 0.5 * (v - best.x[i]!)), v: evaluate(p.x.map((v, i) => best.x[i]! + 0.5 * (v - best.x[i]!))) }));
    }
  }
  simplex.sort((a, b) => a.v - b.v);
  return { x: simplex[0]!.x, value: simplex[0]!.v, evaluations };
}
