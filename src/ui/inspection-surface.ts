import {
  allocateImageId, getCapabilities, getCellDimensions, renderImage,
  type CellDimensions, type Component, type ImageProtocol,
} from "@earendil-works/pi-tui";
import type { BrowserSnapshot } from "../browser/backend.ts";

export interface ImagePlacement {
  left: number;
  top: number;
  columns: number;
  rows: number;
  /** Actual drawn extent, not the rounded-up cell reservation on iTerm2. */
  widthPx: number;
  heightPx: number;
  cell: CellDimensions;
  viewport: BrowserSnapshot["viewport"];
}

/** Cell-centre targeting: terminal mouse protocols don't provide sub-cell pixels. */
export function mapImageClick(placement: ImagePlacement, column: number, row: number): { x: number; y: number } | undefined {
  const col = column - placement.left;
  const line = row - placement.top;
  if (!Number.isFinite(col) || !Number.isFinite(line) || col < 0 || line < 0 || col >= placement.columns || line >= placement.rows) return undefined;
  const px = (col + 0.5) * placement.cell.widthPx;
  const py = (line + 0.5) * placement.cell.heightPx;
  if (px >= placement.widthPx || py >= placement.heightPx) return undefined;
  return {
    x: Math.min(placement.viewport.width - 1, Math.floor(px / placement.widthPx * placement.viewport.width)),
    y: Math.min(placement.viewport.height - 1, Math.floor(py / placement.heightPx * placement.viewport.height)),
  };
}

export function imagePlacement(
  viewport: BrowserSnapshot["viewport"], columns: number, rows: number,
  cell: CellDimensions, protocol: ImageProtocol, top: number,
): ImagePlacement {
  const widthPx = columns * cell.widthPx;
  return {
    left: 0, top, columns, rows, widthPx,
    heightPx: protocol === "kitty" ? rows * cell.heightPx : widthPx * viewport.height / viewport.width,
    cell: { ...cell }, viewport: { ...viewport },
  };
}

/** Uses Pi's native image primitive so rendering and hit-testing share exact dimensions. */
export class InspectionSurface implements Component {
  private readonly imageId = allocateImageId();
  private cache?: { key: string; lines: string[] };
  private revision = 0;
  private data: string;
  placement?: ImagePlacement;

  constructor(private snapshot: BrowserSnapshot, private readonly maxRows: () => number, private readonly top: number) {
    this.data = snapshot.png.toString("base64");
  }

  update(snapshot: BrowserSnapshot): void {
    this.snapshot = snapshot;
    this.data = snapshot.png.toString("base64");
    this.revision++;
    this.invalidate();
  }

  render(width: number): string[] {
    const cell = getCellDimensions();
    const protocol = getCapabilities().images;
    const rows = this.maxRows();
    const key = [width, rows, cell.widthPx, cell.heightPx, protocol, this.revision].join(":");
    if (this.cache?.key === key) return this.cache.lines;
    this.placement = undefined;
    if (width < 3 || rows < 1 || !protocol) return [];
    const image = renderImage(this.data, {
      widthPx: this.snapshot.viewport.width, heightPx: this.snapshot.viewport.height,
    }, { maxWidthCells: width - 2, maxHeightCells: rows, imageId: this.imageId, moveCursor: false });
    if (!image) return [];
    this.placement = imagePlacement(this.snapshot.viewport, image.columns, image.rows, cell, protocol, this.top);
    const lines = Array<string>(image.rows).fill("");
    if (protocol === "kitty") lines[0] = image.sequence;
    else {
      // Same cursor accounting as Pi's Image component for iTerm2's inline protocol.
      const offset = image.rows - 1;
      lines[offset] = (offset ? `\u001b[${offset}A` : "") + image.sequence + (offset ? `\u001b[${offset}B` : "");
    }
    this.cache = { key, lines };
    return lines;
  }

  invalidate(): void { this.cache = undefined; this.placement = undefined; }
}
