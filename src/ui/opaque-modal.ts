import type { Component, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";

/**
 * Pi 1.0.4's overlay compositor preserves underlying native image lines. Hide
 * the mounted background components' rendering (not their data) for the modal's
 * lifetime. The renderer can then retire their graphics placements normally.
 * Use only public Component/TUI APIs; no terminal writes or second renderer.
 */
export class OpaqueModal implements Component {
  private restorations: Array<() => void> = [];
  private disposed = false;

  constructor(private readonly tui: TUI, private readonly view: Component & { dispose(): void }) {
    for (const component of tui.children ?? []) {
      const render = component.render;
      const hidden = () => [] as string[];
      component.render = hidden;
      this.restorations.push(() => {
        if (component.render === hidden) component.render = render;
        component.invalidate();
      });
    }
    tui.requestRender(true);
  }

  render(width: number): string[] { return this.view.render(width); }
  handleInput(data: string): void { this.view.handleInput?.(data); }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined { return this.view.handleMouse?.(event); }
  invalidate(): void { this.view.invalidate(); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try { this.view.dispose(); }
    finally {
      for (const restore of this.restorations) restore();
      this.restorations = [];
      this.tui.requestRender(true);
    }
  }
}
