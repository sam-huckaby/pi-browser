import type { Theme } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, Key, matchesKey, truncateToWidth, type Component, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { BrowserAction } from "../browser/actions.ts";
import { safeText, type BrowserBackend, type BrowserSnapshot } from "../browser/backend.ts";
import type { DreamResult } from "../dream/types.ts";
import { InspectionInputDecoder, maxInputText } from "./inspection-input.ts";
import { InspectionSurface, mapImageClick } from "./inspection-surface.ts";

export interface InspectionResult {
  snapshot: BrowserSnapshot;
  clicks: number;
  dreamRequested?: boolean;
  dream?: DreamResult;
}

const toolbar = "Inspection  [Refresh]  [Done]  [Dream]";
const dreamStart = toolbar.indexOf("[Dream]");
const refreshStart = toolbar.indexOf("[Refresh]");
const doneStart = toolbar.indexOf("[Done]");
const privateStart = toolbar.length + 2;
const headerRows = 3;
const pixelsPerWheelLine = 80;

/** Modal browser controls, using Pi's terminal renderer and normalized input. */
export class InspectionView implements Component {
  private readonly surface: InspectionSurface;
  private readonly input = new InspectionInputDecoder();
  private disposed = false;
  private busy = false;
  private dreaming = false;
  private error = "";
  private privacyChanging = false;
  private privacyPending: Promise<void> = Promise.resolve();
  private get isPrivate(): boolean { return this.backend.privateMode ?? !!this.snapshot.private; }
  private toolbar(): string { return `${toolbar}  [Private: ${this.isPrivate ? "ON" : "OFF"}]`; }
  private clicks = 0;
  private armed = false;
  private queue: BrowserAction[] = [];
  private queuedText = 0;
  private pending: Promise<void> = Promise.resolve();
  private readonly onAbort = () => this.finish();

  constructor(
    private snapshot: BrowserSnapshot,
    private readonly backend: BrowserBackend,
    private readonly tui: Pick<TUI, "terminal" | "requestRender">,
    private readonly theme: Theme,
    private readonly controller: AbortController,
    private readonly done: (result: InspectionResult) => void,
  ) {
    // Overlay margin 1 on all sides, three header rows, one footer row.
    this.surface = new InspectionSurface(snapshot, () => tui.terminal.rows - 2 - headerRows - 1, headerRows);
    controller.signal.addEventListener("abort", this.onAbort, { once: true });
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const status = this.privacyChanging ? "Switching privacy… wait before typing." : this.dreaming ? "Preparing Dream… finishing queued input. Esc cancels the handoff." : this.busy ? "Updating browser… typing and scrolling are queued." : this.error || "Click fields to type. Scroll over the page (Shift+wheel: horizontal).";
    const image = this.surface.render(width);
    const header = [
      this.theme.fg(this.isPrivate ? "warning" : "accent", this.theme.bold(this.toolbar())),
      this.theme.fg("muted", safeText(this.snapshot.url)),
      this.theme.fg(this.error ? "error" : "dim", safeText(`${this.isPrivate ? "PRIVATE · local-only; no page output or artifacts · " : ""}${status}`)),
    ];
    const footer = this.theme.fg("dim", "Shift+D: Dream (outside text fields) · [Dream]: always · Esc: done · Ctrl+R: snapshot");
    const availableRows = Math.max(0, this.tui.terminal.rows - 2);
    return [...header.map((line) => truncateToWidth(line, width)), ...image, truncateToWidth(footer, width)].slice(0, availableRows);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult {
    if (this.disposed) return { handled: true, render: false };
    if (this.dreaming || this.privacyChanging) return { handled: true, render: false };
    if (event.type === "wheel") {
      if (!event.ctrl && !event.alt && !this.error && this.surface.placement && Number.isFinite(event.wheelDelta)) {
        const point = mapImageClick(this.surface.placement, event.x, event.y);
        const delta = Math.max(-10000, Math.min(10000, event.wheelDelta! * pixelsPerWheelLine));
        if (point && delta) this.enqueue({ action: "scroll", ...point, deltaY: event.shift ? 0 : delta, deltaX: event.shift ? delta : 0 });
      }
      return { handled: true, render: false };
    }
    if (event.type === "press") {
      this.armed = event.button === "left";
      return { handled: true, capture: this.armed, render: false };
    }
    if (event.type === "drag") this.armed = false;
    // Only forward the synthesized click, never both press and release.
    if (event.type !== "click") return { handled: true, render: false };
    const isLeft = event.button === "left" || (event.button === "none" && this.armed);
    this.armed = false;
    if (!isLeft || event.shift || event.alt || event.ctrl) return { handled: true, render: false };
    if (event.y === 0 && event.x >= privateStart && event.x < this.toolbar().length) this.togglePrivate();
    else if (event.y === 0 && event.x >= doneStart && event.x < doneStart + "[Done]".length) this.finish();
    else if (event.y === 0 && event.x >= dreamStart && event.x < dreamStart + "[Dream]".length) this.requestDream();
    else if (event.y === 0 && event.x >= refreshStart && event.x < refreshStart + "[Refresh]".length) this.enqueue({ action: "screenshot" });
    else if (!this.busy && !this.error && this.surface.placement) {
      const point = mapImageClick(this.surface.placement, event.x, event.y);
      if (point) this.enqueue({ action: "click", target: point });
    }
    // No transcript selection or scrolling underneath the browser overlay.
    return { handled: true, render: false };
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    try {
      const shiftedD = !isKeyRelease(data) && matchesKey(data, Key.shift("d"));
      for (const input of this.input.feed(data)) {
        if (input.kind === "close") { this.finish(); return; }
        if (this.dreaming || this.privacyChanging) continue;
        if (input.kind === "action" && input.action.action === "press" && /^(?:(?:Control|Meta)\+Shift|Shift\+(?:Control|Meta))\+p$/i.test(input.action.key)) { this.togglePrivate(); continue; }
        // During updates, focus metadata can be stale (e.g. a pending field click).
        // Keep printable keys literal; the explicit toolbar can still queue a handoff.
        if (input.kind === "action" && !this.busy && !this.snapshot.focusedEditable && (
          (input.action.action === "type" && (input.action.text === "D" || (shiftedD && input.action.text === "d")) && !input.action.paste) ||
          (input.action.action === "press" && input.action.key === "Shift+d")
        )) { this.requestDream(); continue; }
        if (input.kind === "refresh") this.enqueue({ action: "screenshot" });
        if (input.kind === "action") this.enqueue(shiftedD && input.action.action === "type" && !input.action.paste && input.action.text === "d"
          ? { action: "press", key: "Shift+d" } : input.action);
      }
    } catch (error) { this.fail(error); this.tui.requestRender(); }
  }

  private enqueue(action: BrowserAction): void {
    if (this.disposed || (this.error && action.action !== "screenshot")) return;
    const textLength = action.action === "type" ? action.text.length : 0;
    if (this.queue.length >= 1024 || this.queuedText + textLength > maxInputText) {
      this.fail(new Error("Browser input queue is full. Wait, refresh, then retry."));
      this.tui.requestRender();
      return;
    }
    if (action.action === "screenshot") this.error = "";
    const last = this.queue.at(-1);
    // Coalesce only adjacent compatible actions, never across editing keys/clicks.
    if (action.action === "type" && last?.action === "type" && !!last.paste === !!action.paste) last.text += action.text;
    else if (action.action === "scroll" && last?.action === "scroll" && last.x === action.x && last.y === action.y &&
      Math.abs(last.deltaY + action.deltaY) <= 10000 && Math.abs((last.deltaX ?? 0) + (action.deltaX ?? 0)) <= 10000) {
      last.deltaY += action.deltaY;
      last.deltaX = (last.deltaX ?? 0) + (action.deltaX ?? 0);
    } else this.queue.push(action);
    this.queuedText += textLength;
    if (!this.busy) {
      this.busy = true;
      this.tui.requestRender();
      this.pending = this.drain();
    }
  }

  private async drain(): Promise<void> {
    try {
      while (!this.disposed && this.queue.length) {
        const batch = this.queue.splice(0);
        this.queuedText = 0;
        let snapshot: BrowserSnapshot | undefined;
        if (this.backend.runBatch) snapshot = await this.backend.runBatch(batch, this.controller.signal);
        else for (const action of batch) snapshot = await this.backend.run(action, this.controller.signal);
        if (this.disposed) return;
        if (!snapshot) throw new Error("The browser returned no screenshot.");
        this.snapshot = snapshot;
        this.surface.update(snapshot);
        this.clicks += batch.filter((action) => action.action === "click").length;
        this.tui.requestRender();
      }
    } catch (error) {
      if (!this.disposed) this.fail(error);
    } finally {
      this.busy = false;
      if (!this.disposed) this.tui.requestRender();
    }
  }

  private fail(error: unknown): void {
    this.error = safeText(error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 500);
    this.queue = [];
    this.queuedText = 0;
  }

  private togglePrivate(): void {
    if (!this.backend.setPrivate || this.privacyChanging) return;
    const enabled = !this.isPrivate;
    this.privacyChanging = true;
    this.tui.requestRender();
    const change = () => this.disposed ? undefined : this.backend.setPrivate!(enabled, this.controller.signal);
    const operation = !enabled && this.busy ? this.pending.then(change) : Promise.resolve(change());
    this.privacyPending = operation.then((snapshot) => {
      if (!this.disposed && snapshot) { this.snapshot = snapshot; this.surface.update(snapshot); }
    }).catch((error) => { if (!this.disposed) this.fail(error); }).finally(() => {
      this.privacyChanging = false;
      if (!this.disposed) this.tui.requestRender();
    });
  }

  /** Resolves after the entire buffered input burst, including privacy recapture. */
  whenIdle(): Promise<void> { return Promise.all([this.pending, this.privacyPending]).then(() => {}); }

  private requestDream(): void {
    if (this.disposed || this.dreaming || this.error) return;
    this.dreaming = true;
    this.tui.requestRender();
    this.pending = this.pending.then(() => {
      if (this.disposed) return;
      if (this.error) { this.dreaming = false; this.tui.requestRender(); return; }
      this.finish(true);
    });
  }

  private finish(dreamRequested = false): void {
    if (this.disposed) return;
    const result: InspectionResult = { snapshot: this.isPrivate ? { ...this.snapshot, private: true, accessibility: "", screenshotPath: "" } : this.snapshot, clicks: this.clicks, ...(dreamRequested ? { dreamRequested: true } : {}) };
    this.dispose();
    this.done(result);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.queue = [];
    this.queuedText = 0;
    this.controller.signal.removeEventListener("abort", this.onAbort);
    if (this.busy || this.privacyChanging) this.controller.abort();
  }

  invalidate(): void { this.surface.invalidate(); }
}
