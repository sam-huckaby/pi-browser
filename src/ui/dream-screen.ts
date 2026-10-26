import type { Component, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { DreamView } from "./dream-view.ts";

/** Owns input while startup is pending; never forwards loading-screen input to the page. */
export class DreamScreen implements Component {
  private view?: DreamView;
  private disposed = false;
  private readonly onAbort = () => { if (!this.view && !this.disposed) this.fail(new Error("Dream loading canceled.")); };

  constructor(private readonly tui: Pick<TUI, "requestRender">, private readonly controller: AbortController,
    private readonly message: string, private readonly fail: (error: unknown) => void) {
    controller.signal.addEventListener("abort", this.onAbort, { once: true });
  }

  ready(view: DreamView): void {
    if (this.disposed || this.controller.signal.aborted) { view.dispose(); return; }
    this.view = view;
    this.tui.requestRender(true);
  }
  render(width: number): string[] {
    return this.view?.render(width) ?? ["Loading Dream…", this.message, "Esc / Ctrl+Q: cancel"].map((line) => truncateToWidth(line, width));
  }
  handleInput(data: string): void {
    if (this.view) this.view.handleInput(data);
    else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("q"))) this.controller.abort();
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.view?.handleMouse(event) ?? { handled: true, render: false };
  }
  invalidate(): void { this.view?.invalidate(); }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.controller.signal.removeEventListener("abort", this.onAbort);
    if (this.view) this.view.dispose();
    else this.controller.abort();
  }
}
