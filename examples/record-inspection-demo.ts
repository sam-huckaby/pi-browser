import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { getCapabilities, getCellDimensions, setCapabilities, setCellDimensions, TuiAltScreen } from "@earendil-works/pi-tui";
import { ChromiumBackend, type BrowserBackend, type BrowserSnapshot } from "../src/browser/backend.ts";
import { InspectionSurface } from "../src/ui/inspection-surface.ts";
import { InspectionView } from "../src/ui/inspection-view.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

// Records the browser, not a desktop terminal. All demonstrated input is routed
// through the real Pi fullscreen renderer and InspectionView, using synthetic SGR
// mouse and terminal key events. No direct Playwright clicks/type/wheel in this script.
const url = process.argv[2] ?? "http://127.0.0.1:4173";
const output = resolve("artifacts", "inspection-demo");
await mkdir(output, { recursive: true });
const videoDir = await mkdtemp(join(output, "recording-"));
const browser = new ChromiumBackend({ recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } } });
const caps = { ...getCapabilities() }, cell = { ...getCellDimensions() };
const terminal = new VirtualTerminal();
terminal.columns = 160;
terminal.rows = 48;
const tui = new TuiAltScreen(terminal);
const theme = { fg: (_token: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
let latest: BrowserSnapshot;
let view: InspectionView | undefined;
const stages: string[] = [];
const stage = (message: string) => { stages.push(message); console.log(message); };

try {
  latest = (await browser.run({ action: "navigate", url }))!;
  const backend: BrowserBackend = {
    run: async (action, signal) => { const result = await browser.run(action, signal); if (result) latest = result; return result; },
    runBatch: async (actions, signal) => { const result = await browser.runBatch(actions, signal); if (result) latest = result; return result; },
    close: () => browser.close(),
  };
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
  setCellDimensions({ widthPx: 10, heightPx: 20 });
  view = new InspectionView(latest, backend, tui, theme, new AbortController(), () => {});
  tui.start();
  const overlay = tui.showOverlay(view, { width: "100%", maxHeight: "100%", margin: 1, anchor: "top-left" });
  const probe = new InspectionSurface(latest, () => terminal.rows - 6, 3);
  function point(x: number, y: number) {
    tui.renderNow();
    const bounds = overlay.getBounds()!;
    probe.update(latest);
    probe.render(bounds.width);
    const placement = probe.placement!;
    assert.ok(placement);
    return {
      x: bounds.col + Math.floor(x / latest.viewport.width * placement.columns),
      y: bounds.row + 3 + Math.floor(y / latest.viewport.height * placement.rows),
    };
  }
  async function settle(ms = 700) { await view!.whenIdle(); tui.renderNow(); await delay(ms); }

  stage("1. Open the playground and click the Name field.");
  await settle(1200);
  const name = point(320, 518);
  terminal.click(name.x, name.y);
  await settle(400);

  stage("2. Type into the focused field through inspection keyboard input.");
  for (const char of "Ada Lovelace") { terminal.onInput?.(char); await delay(180); }
  await settle();
  assert.match(latest.accessibility, /textbox "Name":[\s\S]*?- text: Ada Lovelace/);

  stage("3. Press Enter to submit the local greeting form.");
  terminal.onInput?.("\r");
  await settle(1200);
  assert.match(latest.accessibility, /Hello Ada Lovelace! Form submitted locally/);

  stage("4. Scroll the main page to the Notes field and nested panel.");
  for (let i = 0; i < 7; i++) {
    const body = point(1240, 650);
    terminal.wheel(body.x, body.y);
    await settle(180);
  }
  assert.ok(latest.scroll.y > 0);

  stage("5. Click Notes and paste multiline Unicode text.");
  const notes = point(340, 445);
  terminal.click(notes.x, notes.y);
  terminal.onInput?.("\u001b[200~This text was pasted in Pi.\nMultiline input works too.\nUnicode: 中文 🌍\u001b[201~");
  await settle(1500);
  assert.match(latest.accessibility, /This text was pasted in Pi/);
  assert.match(latest.accessibility, /Unicode: 中文 🌍/);

  stage("6. Scroll inside the nested panel without moving the main document.");
  const documentScroll = latest.scroll.y;
  for (let i = 0; i < 6; i++) {
    const inner = point(920, 550);
    terminal.wheel(inner.x, inner.y);
    await settle(250);
  }
  assert.equal(latest.scroll.y, documentScroll);

  stage("7. Shift+wheel scrolls the inner panel horizontally.");
  for (let i = 0; i < 3; i++) {
    const inner = point(920, 550);
    terminal.wheel(inner.x, inner.y, true, true);
    await settle(250);
  }
  await settle(1500);
  await writeFile(join(output, "last-frame.png"), latest.png);
  view.handleInput("\u001b");
  overlay.hide();
} finally {
  view?.dispose();
  tui.stop();
  await browser.close(); // Graceful context close finalizes the WebM.
  setCapabilities(caps);
  setCellDimensions(cell);
}

const videos = (await readdir(videoDir)).filter((file) => file.endsWith(".webm"));
assert.equal(videos.length, 1, "Expected one recorded browser page");
await copyFile(join(videoDir, videos[0]!), join(output, "inspection-demo.webm"));
await writeFile(join(output, "steps.json"), JSON.stringify({ url, inputPath: "Pi fullscreen renderer → InspectionView → Chromium", stages }, null, 2));
await writeFile(join(output, "index.html"), `<!doctype html><html lang="en"><meta charset="utf-8"><title>Pi inspection controls demo</title>
<style>body{margin:30px auto;max-width:1200px;padding:0 24px;background:#101827;color:#eef;font:18px system-ui}video{width:100%;border-radius:12px}li{margin:10px 0}p{color:#acbad0}</style>
<h1>Inspection: typing and scrolling</h1><p>Browser footage driven by synthetic terminal input through Pi's real fullscreen renderer and inspection controls. This is not a recording of a human's terminal session.</p>
<video controls autoplay muted src="inspection-demo.webm"></video><ol>${stages.map((text) => `<li>${text}</li>`).join("")}</ol>
<p>Load current extension code with /reload, then /inspect your URL. Click a field to type; wheel over the page or a nested panel to scroll. Esc or Done exits inspection.</p></html>`);
await rm(videoDir, { recursive: true, force: true });
console.log(`\nVideo: ${join(output, "inspection-demo.webm")}\nViewer: ${join(output, "index.html")}`);
