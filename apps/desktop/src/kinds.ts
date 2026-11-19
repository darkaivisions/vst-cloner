import { h } from "./dom.ts";

/** Effect groups in the order of the filter bar (bridge: kinds.ts). */
export const GROUPS: { id: string; label: string }[] = [
  { id: "eq", label: "EQ" },
  { id: "dynamics", label: "Dynamics" },
  { id: "distortion", label: "Distortion" },
  { id: "delay", label: "Delay" },
  { id: "modulation", label: "Modulation" },
  { id: "reverb", label: "Reverb" },
  { id: "filter", label: "Filter" },
  { id: "other", label: "Other" },
  { id: "instrument", label: "Instruments" },
];

const ENGINE_NAMES: Record<string, string> = {
  eq: "EQ engine", dynamics: "compressor engine", distortion: "distortion engine", delay: "delay engine", modulation: "modulation engine", reverb: "reverb engine",
};

/** Badge with what kind of effect a plugin is; coloured when vst-cloner has an engine for it. */
export function kindBadge(kind: { group: string; label: string; engine?: boolean; category?: string } | undefined): HTMLElement {
  if (!kind) return h("span.badge.kind.pending", { title: "Looking at the plugin …" }, "…");
  const how = kind.group === "instrument"
    ? "an instrument – nothing to clone, it does not process an input"
    : kind.group === "unknown"
      ? "could not be loaded"
      : kind.engine
        ? `cloned with the ${ENGINE_NAMES[kind.group] ?? "engine of its class"}`
        : "no engine of its own – cloned as a universal network";
  const title = `${kind.label}${kind.category ? ` (category "${kind.category}")` : ""}: ${how}`;
  return h("span.badge.kind", { class: kind.engine ? `engine group-${kind.group}` : `group-${kind.group}`, title }, kind.label);
}

/**
 * Row of filter chips: "All" and every group with its count (groups without plugins are left out unless chosen).
 * `extra` goes at the end of the row (format chips, switches).
 */
export function filterBar(counts: Map<string, number>, total: number, active: string, onChange: (group: string) => void, ...extra: (HTMLElement | false | undefined)[]): HTMLElement {
  const chip = (id: string, label: string, count: number) =>
    h("button.chip", { class: active === id ? "active" : "", onclick: () => onChange(id) }, label, h("span.chip-count", {}, String(count)));
  return h("div.filter-bar", {},
    chip("all", "All", total),
    ...GROUPS.filter((g) => (counts.get(g.id) ?? 0) > 0 || active === g.id).map((g) => chip(g.id, g.label, counts.get(g.id) ?? 0)),
    ...extra);
}
