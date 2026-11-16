import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";

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
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export function formatDb(db: number): string {
  return `${db.toFixed(2)} dB`;
}

export function formatDate(iso: string): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

/** CSS class for a verdict text from the bridge. */
export function verdictClass(verdict: string | undefined): string {
  switch (verdict) {
    case "excellent": return "good";
    case "very good": return "good";
    case "good": return "ok";
    case "approximate": return "warn";
    case "usable": return "warn";
    case "off": return "bad";
    case "inaccurate": return "bad";
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

/** Opens a file or folder with the system's default program; failures are shown instead of swallowed. */
export async function openInSystem(path: string): Promise<void> {
  try {
    await openPath(path);
  } catch (error) {
    toast(`Could not open ${path} (${errorText(error)})`, "error");
  }
}

/** Shows a file in the file manager. */
export async function revealInFolder(path: string): Promise<void> {
  try {
    await revealItemInDir(path);
  } catch {
    // some file managers do not support selecting an item: open the folder instead
    await openInSystem(path.replace(/[\\/][^\\/]+$/, ""));
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Enlarged view of an image inside the app: fitted to the window, a click shows it at full size (scrollable),
 * Escape, the close button or a click beside the image closes it. `file` adds a button for the system viewer.
 */
export function zoomImage(src: string, alt: string, file?: string): void {
  const image = h("img.lightbox-image", { src, alt });
  const frame = h("div.lightbox-frame", {}, image);
  const close = () => {
    overlay.remove();
    window.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    // the lightbox may sit above a dialog that closes on Escape too: only the lightbox goes
    e.stopPropagation();
    e.preventDefault();
    close();
  };
  const overlay = h("div.lightbox", { onclick: (e: Event) => (e.target === overlay || e.target === frame) && close() },
    h("div.lightbox-bar", {},
      h("span.lightbox-title", {}, alt),
      h("span.muted.small", {}, "Click the image: actual size · Esc: close"),
      h("div.spacer"),
      file ? h("button.ghost.small", { onclick: () => void openInSystem(file) }, "Open in image viewer") : "",
      h("button.ghost.small", { onclick: close }, "Close")),
    frame);
  image.addEventListener("click", () => overlay.classList.toggle("actual-size"));
  window.addEventListener("keydown", onKey, true);
  document.body.appendChild(overlay);
}
