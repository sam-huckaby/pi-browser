import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import type { BrowserSnapshot } from "../src/browser/backend.ts";

export const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
export const snapshot: BrowserSnapshot = {
  title: "Inspection fixture", url: "http://localhost/", viewport: { width: 1280, height: 800 },
  scroll: { x: 0, y: 0 }, accessibility: '- button "Click"', screenshotPath: "/tmp/inspection.png",
  png: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=", "base64"),
};

export function mouse(x: number, y: number, type: TuiMouseEvent["type"] = "click"): TuiMouseEvent {
  return { type, button: "left", x, y, screenX: x + 10, screenY: y + 7, width: 120, height: 40, shift: false, alt: false, ctrl: false };
}

export async function waitDreamReady(component: { render(width: number): string[] }): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (!component.render(120)[0]?.includes("Loading Dream")) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Dream did not finish loading.");
}

export { VirtualTerminal } from "../examples/virtual-terminal.ts";
