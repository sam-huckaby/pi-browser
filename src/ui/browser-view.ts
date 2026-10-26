import type { Theme } from "@earendil-works/pi-coding-agent";
import { Image, Key, matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { safeText, type BrowserSnapshot } from "../browser/backend.ts";

/** Optional read-only viewer for /browser. Agent actions render in the transcript. */
export class BrowserView implements Component {
  private readonly image: Image;

  constructor(
    private readonly snapshot: BrowserSnapshot,
    private readonly theme: Theme,
    private readonly done: () => void,
  ) {
    this.image = new Image(snapshot.png.toString("base64"), "image/png", {
      fallbackColor: (text) => theme.fg("muted", text),
    }, { maxHeightCells: 30, filename: snapshot.screenshotPath });
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const header = [
      this.theme.fg("accent", this.theme.bold(safeText(this.snapshot.title || "Browser"))),
      this.theme.fg("muted", safeText(this.snapshot.url)),
      this.theme.fg("dim", "Read-only preview · Esc or Enter to return to Pi"),
    ].map((line) => truncateToWidth(line, width));
    return [...header, ...this.image.render(width)];
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || matchesKey(data, Key.ctrl("c"))) this.done();
  }

  invalidate(): void { this.image.invalidate(); }
}
