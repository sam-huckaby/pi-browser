import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, Text, matchesKey, truncateToWidth, type Component, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { safeText } from "../browser/backend.ts";
import type { DreamAction, DreamBackend, DreamFrame, DreamResult, Point, ResizeHandle } from "../dream/types.ts";
import { InspectionInputDecoder, maxInputText } from "./inspection-input.ts";
import { InspectionSurface, mapImageClick, type ImagePlacement } from "./inspection-surface.ts";
import { DreamActivity, activityError, formatActivityEvent } from "../dream/activity.ts";

const toolbar = "Dream  [Parent]  [Edit]  [Copy]  [Paste]  [Undo]  [Refresh]  [Actions]  [Log]  [Done]";
const buttons = ["Parent", "Edit", "Copy", "Paste", "Undo", "Refresh", "Actions", "Log", "Done"] as const;
const privateStart = toolbar.length + 2;
const headerRows = 3;

/** Screenshot-based DOM design, with native Pi mouse capture for drag/drop. */
export class DreamView implements Component {
  private readonly surface: InspectionSurface;
  private readonly input = new InspectionInputDecoder();
  private disposed = false;
  private busy = false;
  private finishing = false;
  private editingIntent = false;
  private menuIntent = false;
  private error = "";
  private privacyChanging = false;
  private privacyPending: Promise<void> = Promise.resolve();
  private get isPrivate(): boolean { return this.backend.privateMode ?? !!this.frame.snapshot.private; }
  private toolbar(): string { return `${toolbar}  [Private: ${this.isPrivate ? "ON" : "OFF"}]`; }
  private logOpen = false;
  private logOffset = 0;
  private logLineCount = 0;
  private queue: DreamAction[] = [];
  private queuedText = 0;
  private pending: Promise<void> = Promise.resolve();
  private drag?: { placement: ImagePlacement; from: Point; to: Point; pointerFrom: Point; moved: boolean; resize?: { selection: string; handle: ResizeHandle } };
  private readonly onAbort = () => this.cancel();

  constructor(
    private frame: DreamFrame,
    private readonly backend: DreamBackend,
    private readonly tui: Pick<TUI, "terminal" | "requestRender">,
    private readonly theme: Theme,
    private readonly controller: AbortController,
    private readonly done: (result: DreamResult) => void,
    private readonly activity?: DreamActivity,
  ) {
    this.surface = new InspectionSurface(frame.snapshot, () => tui.terminal.rows - 2 - headerRows - 2, headerRows);
    controller.signal.addEventListener("abort", this.onAbort, { once: true });
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    if (this.logOpen) return this.renderLog(width);
    const selected = this.frame.state.selected;
    const selection = selected ? `${selected.selector} · ${Math.round(selected.bounds.width)}×${Math.round(selected.bounds.height)}` : "No element selected";
    const status = this.privacyChanging ? "Switching privacy… wait before typing." : this.error || (this.finishing ? "Finishing queued edits and capturing your goal…" : this.busy ? "Updating mockup… input is queued." : this.frame.state.message);
    return [
      this.theme.fg(this.isPrivate ? "warning" : "accent", this.theme.bold(this.toolbar())),
      this.theme.fg("muted", safeText(this.frame.snapshot.url)),
      this.theme.fg(this.error ? "error" : this.frame.state.notice ? "warning" : "dim", safeText(`${this.isPrivate ? "PRIVATE · local-only; saving/publishing disabled · " : ""}${status}`)),
    ].map((line) => truncateToWidth(line, width)).concat(
      this.surface.render(width),
      [
        this.theme.fg("dim", safeText(`${this.frame.state.editing ? "Editing text" : selection} · ${this.frame.state.changes.length} change(s)`)),
        this.theme.fg("dim", this.frame.state.menu
          ? "Click a menu item · Arrows / Enter: choose · Esc: dismiss menu · Ctrl+Q: done"
          : "Selected handles: resize · Drag inside: move · Alt+arrows: size · Double-click: text · Actions: menu · Esc: commit/done"),
      ].map((line) => truncateToWidth(line, width)),
    ).slice(0, Math.max(0, this.tui.terminal.rows - 2));
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult {
    if (this.disposed || this.finishing || this.privacyChanging) return { handled: true, render: false };
    if (this.logOpen && event.type === "wheel") {
      this.scrollLog(-(event.wheelDelta ?? 0) * 3);
      return { handled: true, render: false };
    }
    if (this.logOpen && !(event.type === "click" && event.y === 0)) return { handled: true, render: false };
    if (event.type === "wheel") {
      if (!this.drag && !event.ctrl && !event.alt && this.surface.placement && Number.isFinite(event.wheelDelta)) {
        const point = mapImageClick(this.surface.placement, event.x, event.y);
        const delta = Math.max(-10000, Math.min(10000, (event.wheelDelta ?? 0) * 80));
        if (point && delta) this.enqueue({ action: "scroll", ...point, deltaY: event.shift ? 0 : delta, deltaX: event.shift ? delta : 0 });
      }
      return { handled: true, render: false };
    }
    if (event.type === "press") {
      this.drag = undefined;
      if (event.button === "right" && !this.busy && !event.shift && !event.alt && !event.ctrl && this.surface.placement) {
        const point = mapImageClick(this.surface.placement, event.x, event.y);
        if (point) this.enqueue({ action: "context", ...point });
        return { handled: true, render: false };
      }
      if (event.button === "left" && !this.frame.state.menu && !this.menuIntent && !this.busy && !event.shift && !event.alt && !event.ctrl && this.surface.placement) {
        const point = mapImageClick(this.surface.placement, event.x, event.y);
        if (point) {
          const resize = this.resizeAt(point);
          const from = resize?.point ?? point;
          this.drag = { placement: this.surface.placement, from, to: from, pointerFrom: point, moved: false,
            resize: resize ? { selection: resize.selection, handle: resize.handle } : undefined };
        }
      }
      return { handled: true, capture: event.button === "left", render: false };
    }
    if (event.type === "drag" || event.type === "release") {
      if (this.drag) {
        const { placement } = this.drag;
        const point = mapImageClick(placement,
          Math.max(placement.left, Math.min(placement.left + placement.columns - 1, event.x)),
          Math.max(placement.top, Math.min(placement.top + placement.rows - 1, event.y)));
        if (point) {
          this.drag.to = { x: this.drag.from.x + point.x - this.drag.pointerFrom.x, y: this.drag.from.y + point.y - this.drag.pointerFrom.y };
          this.drag.moved ||= point.x !== this.drag.pointerFrom.x || point.y !== this.drag.pointerFrom.y;
        }
        if (event.type === "release") {
          const drag = this.drag; this.drag = undefined;
          if (drag.moved) this.enqueue(drag.resize ? { action: "resize", ...drag.resize, from: drag.from, to: drag.to } : { action: "drag", from: drag.from, to: drag.to });
        }
      }
      return { handled: true, render: false };
    }
    if (event.type !== "click" || event.button !== "left" || event.shift || event.alt || event.ctrl) return { handled: true, render: false };
    if (event.y === 0) {
      if (event.x >= privateStart && event.x < this.toolbar().length) { this.togglePrivate(); return { handled: true, render: false }; }
      const button = buttons.find((name) => event.x >= toolbar.indexOf(`[${name}]`) && event.x < toolbar.indexOf(`[${name}]`) + name.length + 2);
      if (button === "Log") { this.logOpen = !this.logOpen; this.logOffset = 0; this.activity?.record("view.log", { open: this.logOpen }); this.tui.requestRender(); }
      else if (button === "Done") this.finish();
      else if (this.logOpen) return { handled: true, render: false };
      else if (button === "Actions") this.enqueue({ action: "context" });
      else if (button) this.enqueue({ action: button.toLowerCase() as "parent" | "edit" | "copy" | "paste" | "undo" | "refresh" });
    } else if (this.surface.placement && (!this.busy || (event.clickCount === 2 && !this.frame.state.menu && !this.menuIntent))) {
      const point = mapImageClick(this.surface.placement, event.x, event.y);
      if (point && this.resizeAt(point)) return { handled: true, render: false };
      if (point && (this.frame.state.menu || (event.clickCount ?? 1) <= 2)) this.enqueue({ action: !this.frame.state.menu && event.clickCount === 2 ? "edit" : "select", ...point });
    }
    return { handled: true, render: false };
  }

  handleInput(data: string): void {
    if (this.disposed || this.finishing) return;
    try {
      for (const input of this.input.feed(data)) {
        if (this.privacyChanging && input.kind !== "close") continue;
        if (this.drag) {
          // No model edits occur until drop. Esc cancels a gesture without
          // accidentally finishing Dream; suppress retargeting keys mid-gesture.
          if (input.kind === "close") {
            this.drag = undefined; this.tui.requestRender();
            if (!matchesKey(data, Key.ctrl("q"))) continue;
          } else continue;
        }
        if (input.kind === "action" && input.action.action === "press" && /^(?:(?:Control|Meta)\+Shift|Shift\+(?:Control|Meta))\+p$/i.test(input.action.key)) { this.togglePrivate(); continue; }
        if (this.logOpen && !matchesKey(data, Key.ctrl("q"))) {
          if (input.kind === "close") { this.logOpen = false; this.tui.requestRender(); }
          else if (input.kind === "action" && input.action.action === "press") {
            const key = input.action.key;
            this.scrollLog(key === "Home" ? this.logLineCount : key === "End" ? -this.logLineCount : key === "PageUp" ? 20 : key === "PageDown" ? -20 : key === "ArrowUp" ? 1 : key === "ArrowDown" ? -1 : 0);
          }
          continue;
        }
        if (input.kind === "close") {
          if (matchesKey(data, Key.ctrl("q")) && this.error) this.cancel();
          else if (!matchesKey(data, Key.ctrl("q")) && (this.frame.state.menu || this.menuIntent)) this.enqueue({ action: "dismiss-menu" });
          else if (!matchesKey(data, Key.ctrl("q")) && (this.frame.state.editing || this.editingIntent)) this.enqueue({ action: "commit" });
          else this.finish();
        } else if (input.kind === "refresh") this.enqueue({ action: "refresh" });
        else if (input.kind === "action" && input.action.action === "type") this.enqueue({ action: "text", text: input.action.text });
        else if (input.kind === "action" && input.action.action === "press") this.enqueue({ action: "key", key: input.action.key });
      }
    } catch (error) { this.fail(error); }
  }

  private resizeAt(point: Point): { selection: string; handle: ResizeHandle; point: Point } | undefined {
    const resize = this.frame.state.selected?.resize;
    if (!resize || this.frame.state.editing || this.editingIntent || this.frame.state.menu || this.menuIntent) return undefined;
    // A terminal cell may be taller than a handle. Accept cells intersecting
    // its painted bounds, then anchor the gesture at the exact handle centre.
    const placement = this.surface.placement;
    const padX = placement ? placement.viewport.width / placement.columns / 2 : 0;
    const padY = placement ? placement.viewport.height / placement.rows / 2 : 0;
    const hits = resize.handles.filter(({ bounds: b }) => point.x >= b.x - padX && point.x < b.x + b.width + padX && point.y >= b.y - padY && point.y < b.y + b.height + padY);
    hits.sort((a, b) => ((point.x - a.bounds.x - a.bounds.width / 2) ** 2 + (point.y - a.bounds.y - a.bounds.height / 2) ** 2) - ((point.x - b.bounds.x - b.bounds.width / 2) ** 2 + (point.y - b.bounds.y - b.bounds.height / 2) ** 2));
    return hits[0] ? { selection: resize.token, handle: hits[0].handle,
      point: { x: hits[0].bounds.x + hits[0].bounds.width / 2, y: hits[0].bounds.y + hits[0].bounds.height / 2 } } : undefined;
  }

  private renderLog(width: number): string[] {
    if (this.isPrivate) return [this.toolbar(), "Private mode: activity logging is paused.", "Esc / [Log]: return · Ctrl+Shift+P: turn Private off"].map((line) => truncateToWidth(line, width));
    const log = this.activity?.snapshot();
    const entries = log?.events.map(formatActivityEvent) ?? ["Activity logging is not enabled in this harness."];
    const lines = new Text(entries.join("\n"), 0, 0).render(width);
    this.logLineCount = lines.length;
    const available = Math.max(0, this.tui.terminal.rows - 7);
    this.logOffset = Math.max(0, Math.min(Math.max(0, lines.length - available), this.logOffset));
    const end = lines.length - this.logOffset;
    return [this.toolbar(), `Activity: ${this.activity?.path ?? "(memory only)"}`, log?.storageError ? `Log storage error: ${log.storageError}` : "Recent actions/errors · typed text and clipboard contents omitted"]
      .map((line) => truncateToWidth(safeText(line), width))
      .concat(lines.slice(Math.max(0, end - available), end), [truncateToWidth("Wheel / Up/Down / PageUp/Down: history · Esc / [Log]: return · /dream-log after closing", width)])
      .slice(0, Math.max(0, this.tui.terminal.rows - 2));
  }
  private scrollLog(delta: number): void {
    this.logOffset = Math.max(0, Math.min(this.logLineCount, this.logOffset + Math.round(delta)));
    this.tui.requestRender();
  }

  private enqueue(action: DreamAction): void {
    if (this.disposed) return;
    const length = action.action === "text" ? action.text.length : 0;
    if (action.action !== "finish" && (this.queue.length >= 1024 || this.queuedText + length > maxInputText)) {
      this.fail(new Error("Dream input queue is full. Wait, refresh, then retry.")); return;
    }
    this.error = "";
    if (action.action === "context" || (action.action === "key" && action.key === "Shift+F10")) this.menuIntent = true;
    if (action.action === "dismiss-menu") this.menuIntent = false;
    if (action.action === "edit") this.editingIntent = true;
    if (action.action === "commit") this.editingIntent = false;
    const last = this.queue.at(-1);
    if (action.action === "text" && last?.action === "text") last.text += action.text;
    else this.queue.push(action);
    this.queuedText += length;
    if (!this.busy) {
      this.busy = true;
      this.tui.requestRender();
      this.pending = this.drain();
    }
  }

  private async drain(): Promise<void> {
    try {
      while (!this.disposed && this.queue.length) {
        const batch = this.queue.splice(0); this.queuedText = 0;
        try {
          const frame = await this.backend.apply(batch, this.controller.signal);
          if (this.disposed) return;
          this.updateFrame(frame);
          if (batch.some((action) => action.action === "finish")) {
            this.busy = false; this.dispose(); this.done({ ...frame, snapshot: this.isPrivate ? { ...frame.snapshot, private: true, accessibility: "", screenshotPath: "" } : frame.snapshot, canceled: false }); return;
          }
        } catch (error) {
          if (this.disposed) return;
          this.fail(error);
          // Earlier actions may have applied. Recapture real state rather than
          // leaving stale menu hit areas/selection over the last good screenshot.
          try {
            const recovered = await this.backend.apply([{ action: "refresh" }], this.controller.signal);
            if (this.disposed) return;
            this.updateFrame(recovered);
            this.activity?.record("view.recovered");
          } catch { /* Keep the original error and allow retry or Ctrl+Q cancel. */ }
        }
        this.tui.requestRender();
      }
    } finally { this.busy = false; if (!this.disposed) this.tui.requestRender(); }
  }

  private updateFrame(frame: DreamFrame): void {
    this.frame = frame;
    this.editingIntent = frame.state.editing || this.queue.some((action) => action.action === "edit");
    this.menuIntent = !!frame.state.menu || this.queue.some((action) => action.action === "context");
    this.surface.update(frame.snapshot);
  }
  private fail(error: unknown): void {
    this.activity?.record("view.error", { error: activityError(error), droppedQueuedActions: this.queue.length });
    this.error = `${activityError(error)} · Try another action or Refresh; Ctrl+Q cancels. Log: /dream-log`;
    this.queue = []; this.queuedText = 0; this.drag = undefined; this.finishing = false; this.editingIntent = false; this.menuIntent = false;
    this.tui.requestRender();
  }
  private togglePrivate(): void {
    if (!this.backend.setPrivate || this.privacyChanging) return;
    const enabled = !this.isPrivate;
    this.privacyChanging = true;
    this.tui.requestRender();
    const change = () => this.disposed ? undefined : this.backend.setPrivate!(enabled, this.controller.signal);
    const operation = !enabled && this.busy ? this.pending.then(change) : Promise.resolve(change());
    this.privacyPending = operation.then((snapshot) => {
      if (!this.disposed && snapshot) {
        this.frame = { ...this.frame, snapshot }; this.surface.update(snapshot);
        this.enqueue({ action: "refresh" });
      }
    }).catch((error) => { if (!this.disposed) this.fail(error); }).finally(() => {
      this.privacyChanging = false;
      if (!this.disposed) this.tui.requestRender();
    });
  }
  async whenIdle(): Promise<void> { await this.privacyPending; await this.pending; }
  private finish(): void {
    if (this.disposed) return;
    this.finishing = true;
    this.enqueue({ action: "finish" });
    this.tui.requestRender();
  }
  private cancel(): void {
    if (this.disposed) return;
    this.activity?.record("view.cancel");
    const frame = this.isPrivate ? { ...this.frame, snapshot: { ...this.frame.snapshot, private: true, accessibility: "", screenshotPath: "" } } : this.frame;
    this.dispose(); this.done({ ...frame, canceled: true });
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.queue = []; this.drag = undefined;
    this.controller.signal.removeEventListener("abort", this.onAbort);
    if (this.busy || this.privacyChanging) this.controller.abort();
  }
  invalidate(): void { this.surface.invalidate(); }
}
