type Child = Node | string | number | false | null | undefined;
type Attrs = Record<string, string | number | boolean | EventListener | undefined | null>;

/** Minimal element factory: h("button.primary", { onclick }, "Text") */
export function h<K extends keyof HTMLElementTagNameMap>(spec: K | `${K}.${string}` | `${K}#${string}`, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const [tagAndId, ...classes] = spec.split(".");
  const [tag, id] = tagAndId!.split("#");
  const el = document.createElement(tag as K);
  if (id) el.id = id;
  if (classes.length) el.className = classes.join(" ");
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value as EventListener);
    else if (key === "class") el.className += ` ${value}`;
    else if (value === true) el.setAttribute(key, "");
    else el.setAttribute(key, String(value));
  }
  append(el, ...children);
  return el;
}

export function append(parent: Node, ...children: Child[]): void {
  for (const child of children) {
    if (child === false || child === null || child === undefined) continue;
    parent.appendChild(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MiB`;
}

export function formatDb(db: number): string {
  return `${db.toFixed(2).replace(".", ",")} dB`;
}

export function formatDate(iso: string): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" });
}

/** CSS class for a verdict text from the bridge. */
export function verdictClass(verdict: string | undefined): string {
  switch (verdict) {
    case "ausgezeichnet": return "good";
    case "sehr gut": return "good";
    case "gut": return "ok";
    case "angenähert": return "warn";
    case "abweichend": return "bad";
    default: return "neutral";
  }
}

export function toast(message: string, kind: "info" | "error" = "info"): void {
  const el = h("div.toast", { class: kind }, message);
  document.body.appendChild(el);
  setTimeout(() => el.classList.add("visible"), 10);
  setTimeout(() => {
    el.classList.remove("visible");
    setTimeout(() => el.remove(), 300);
  }, kind === "error" ? 6000 : 3000);
}
