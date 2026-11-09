import { onJobEvent, type JobEvent } from "./bridge.ts";
import { h } from "./dom.ts";

/** Protocol panel: all job events, grouped by stage, with optional detail lines. */
export class LogPanel {
  readonly element: HTMLElement;
  private readonly list: HTMLElement;
  private readonly count: HTMLElement;
  private entries = 0;
  private lines: string[] = [];

  constructor() {
    this.list = h("div.log-list");
    this.count = h("span.log-count");
    const detailsToggle = h("input", { type: "checkbox", onchange: (e: Event) => this.element.classList.toggle("show-details", (e.target as HTMLInputElement).checked) });

    this.element = h(
      "section.log",
      {},
      h(
        "header.log-header",
        {},
        h("button.log-title", { onclick: () => this.element.classList.toggle("collapsed"), title: "Ein-/ausklappen" }, h("span.chevron"), "Protokoll", this.count),
        h("div.log-actions", {},
          h("label.toggle", {}, detailsToggle, "Details"),
          h("button.ghost.small", { onclick: () => this.copy() }, "Kopieren"),
          h("button.ghost.small", { onclick: () => this.clear() }, "Leeren"),
        ),
      ),
      this.list,
    );

    onJobEvent((event) => this.add(event));
  }

  private time(ms: number): string {
    return new Date(ms).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  private push(row: HTMLElement, text: string) {
    const atBottom = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 40;
    this.list.appendChild(row);
    this.lines.push(text);
    if (this.list.childElementCount > 3000) this.list.firstElementChild?.remove();
    this.entries++;
    this.count.textContent = String(this.entries);
    if (atBottom) this.list.scrollTop = this.list.scrollHeight;
  }

  add(event: JobEvent): void {
    const time = this.time(event.time);
    switch (event.kind) {
      case "stage":
        this.push(h("div.log-stage", {}, h("span", {}, event.title), h("span.log-time", {}, time)), `── ${event.title} ── ${time}`);
        break;
      case "log": {
        const multiline = event.message.includes("\n");
        this.push(
          h(`div.log-row.${event.level}`, {}, h("span.log-time", {}, time), h("span.log-dot"), h(multiline ? "pre" : "span", { class: "log-msg" }, event.message)),
          `${time} [${event.level}] ${event.message}`,
        );
        break;
      }
      case "done":
        this.push(h("div.log-row.success.done", {}, h("span.log-time", {}, time), h("span.log-dot"), h("span.log-msg", {}, "Fertig")), `${time} Fertig`);
        break;
      case "failed":
        this.push(
          h(`div.log-row.${event.cancelled ? "warn" : "error"}`, {}, h("span.log-time", {}, time), h("span.log-dot"), h("pre.log-msg", {}, event.cancelled ? "Abgebrochen" : `Fehler: ${event.error}`)),
          `${time} ${event.cancelled ? "Abgebrochen" : `Fehler: ${event.error}`}`,
        );
        this.element.classList.remove("collapsed");
        break;
      case "progress":
        break;
    }
  }

  note(level: "info" | "error" | "success", message: string): void {
    this.add({ kind: "log", level, message, time: Date.now(), job: "ui" });
  }

  private async copy() {
    const text = this.lines.join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = h("textarea", {}, text);
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
  }

  private clear() {
    this.list.replaceChildren();
    this.lines = [];
    this.entries = 0;
    this.count.textContent = "";
  }
}
