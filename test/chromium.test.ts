import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { after, before, test } from "node:test";
import { ChromiumBackend, type BrowserSnapshot } from "../src/browser/backend.ts";
import { createBrowserTool } from "../src/browser/tool.ts";
import { TuiAltScreen, getCapabilities, getCellDimensions, setCapabilities, setCellDimensions } from "@earendil-works/pi-tui";
import { InspectionView, type InspectionResult } from "../src/ui/inspection-view.ts";
import { InspectionSurface } from "../src/ui/inspection-surface.ts";
import { theme, VirtualTerminal } from "./support.ts";

let server: Server;
let origin: string;
const screenshotDirs = new Set<string>();
const backend = new ChromiumBackend();

function record(snapshot: BrowserSnapshot | undefined): BrowserSnapshot {
  assert.ok(snapshot);
  screenshotDirs.add(dirname(snapshot.screenshotPath));
  return snapshot;
}

before(async () => {
  server = createServer((request, response) => {
    if (request.url === "/slow") return; // Deliberately hangs to test cancellation.
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html><html><head><title>${request.url === "/next" ? "Next page" : "Browser fixture"}</title>
      <style>body { margin:0; font:20px sans-serif; background:#eef; } button { height:50px; } .spacer { height:2400px; }
      #name { position:absolute;left:40px;top:220px;width:300px;height:60px;font:20px sans-serif; }
      #notes { position:absolute;left:400px;top:220px;width:300px;height:120px; }
      #inner { position:absolute;left:800px;top:180px;width:350px;height:300px;overflow:auto;border:1px solid black; }
      #inner-status { position:absolute;left:800px;top:500px; }</style></head><body>
      <h1>Browser fixture</h1><form onsubmit="event.preventDefault(); document.querySelector('#result').textContent='Hello '+document.querySelector('input').value;">
      <label>Name <input id="name" name="name"></label><button type="submit">Greet</button></form>
      <p id="result">Ready</p><a href="/next" style="position:absolute;left:600px;top:90px;display:block;width:150px;height:50px">Next</a> <a href="/popup" target="_blank">Popup</a>
      <button style="position:absolute;left:600px;top:10px;width:150px" onclick="document.querySelector('#result').textContent='Coordinate clicked'">Coordinate</button>
      <textarea id="notes" aria-label="Notes"></textarea>
      <div id="inner" onscroll="document.querySelector('#inner-status').textContent='Inner scroll '+this.scrollTop"><div style="height:900px">Inner start</div><p>Inner bottom</p></div><p id="inner-status">Inner scroll 0</p>
      <div class="spacer"></div><p>Bottom of page</p></body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await backend.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const directory of screenshotDirs) await rm(directory, { recursive: true, force: true });
});

test("Chromium renders a local app, fills, clicks, and returns valid viewport PNGs", async () => {
  const initial = record(await backend.run({ action: "navigate", url: origin }));
  assert.equal(initial.title, "Browser fixture");
  assert.deepEqual(initial.viewport, { width: 1280, height: 800 });
  assert.match(initial.accessibility, /textbox "Name"/);
  assert.equal(initial.png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(initial.png.readUInt32BE(16), 1280);
  assert.equal(initial.png.readUInt32BE(20), 800);
  assert.deepEqual(await readFile(initial.screenshotPath), initial.png);
  record(await backend.run({ action: "fill", target: { role: "textbox", name: "Name" }, text: "Ada" }));
  const clicked = record(await backend.run({ action: "click", target: { role: "button", name: "Greet" } }));
  assert.match(clicked.accessibility, /Hello Ada/);
  assert.notDeepEqual(clicked.png, initial.png);
  const coordinate = record(await backend.run({ action: "click", target: { x: 650, y: 30 } }));
  assert.match(coordinate.accessibility, /Coordinate clicked/);
  await assert.rejects(backend.run({ action: "click", target: { x: 9999, y: 1 } }), /inside/);
});

test("keyboard, scroll, resize, wait, and screenshot work", async () => {
  record(await backend.run({ action: "navigate", url: origin }));
  record(await backend.run({ action: "fill", target: { selector: "#name" }, text: "Grace" }));
  const pressed = record(await backend.run({ action: "press", target: { selector: "#name" }, key: "Enter" }));
  assert.match(pressed.accessibility, /Hello Grace/);
  const scrolled = record(await backend.run({ action: "scroll", deltaY: 700 }));
  assert.ok(scrolled.scroll.y > 0);
  const resized = record(await backend.run({ action: "resize", width: 800, height: 600 }));
  assert.deepEqual(resized.viewport, { width: 800, height: 600 });
  assert.equal(resized.png.readUInt32BE(16), 800);
  record(await backend.run({ action: "wait", ms: 10 }));
  record(await backend.run({ action: "screenshot" }));
});

test("navigation history, reload, and popups use the active page", async () => {
  record(await backend.run({ action: "navigate", url: origin }));
  const next = record(await backend.run({ action: "click", target: { role: "link", name: "Next" } }));
  assert.equal(next.url, `${origin}/next`);
  assert.equal(next.title, "Next page");
  assert.equal(record(await backend.run({ action: "back" })).url, `${origin}/`);
  assert.equal(record(await backend.run({ action: "forward" })).url, `${origin}/next`);
  assert.equal(record(await backend.run({ action: "reload" })).title, "Next page");
  const popup = record(await backend.run({ action: "click", target: { role: "link", name: "Popup" } }));
  assert.equal(popup.url, `${origin}/popup`);
});

test("concurrent calls serialize and failures do not poison the queue", async () => {
  const [navigated, filled, clicked] = await Promise.all([
    backend.run({ action: "navigate", url: origin }),
    backend.run({ action: "fill", target: { selector: "#name" }, text: "Queued" }),
    backend.run({ action: "click", target: { role: "button", name: "Greet" } }),
  ]);
  record(navigated); record(filled);
  assert.match(record(clicked).accessibility, /Hello Queued/);
  await assert.rejects(backend.run({ action: "navigate", url: "file:///etc/passwd" }), /Only http/);
  assert.equal(record(await backend.run({ action: "screenshot" })).title, "Browser fixture");
});

test("actual tool returns Chromium screenshot to the model", async () => {
  const tool = createBrowserTool(backend);
  const result = await tool.execute("integration", { action: "screenshot" }, undefined, undefined, {} as never);
  const image = result.content.find((item) => item.type === "image");
  assert.ok(image && image.type === "image");
  assert.equal(Buffer.from(image.data, "base64").subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.ok(result.details && "screenshotPath" in result.details);
  screenshotDirs.add(dirname(result.details.screenshotPath));
});

test("terminal inspection clicks reach real Chromium and update buttons/navigation", async () => {
  record(await backend.run({ action: "resize", width: 1280, height: 800 }));
  const initial = record(await backend.run({ action: "navigate", url: origin }));
  const caps = { ...getCapabilities() }, cell = { ...getCellDimensions() };
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
  setCellDimensions({ widthPx: 10, heightPx: 20 });
  const terminal = new VirtualTerminal();
  const tui = new TuiAltScreen(terminal);
  let result: InspectionResult | undefined;
  const view = new InspectionView(initial, backend, tui, theme, new AbortController(), (value) => { result = value; });
  try {
    tui.start();
    const overlay = tui.showOverlay(view, { width: "100%", maxHeight: "100%", margin: 1, anchor: "top-left" });
    tui.renderNow(true);
    const bounds = overlay.getBounds()!;
    const surface = new InspectionSurface(initial, () => terminal.rows - 6, 3);
    surface.render(bounds.width);
    const placement = surface.placement!;
    function clickBrowser(x: number, y: number): void {
      terminal.click(bounds.col + Math.floor(x / initial.viewport.width * placement.columns), bounds.row + 3 + Math.floor(y / initial.viewport.height * placement.rows));
    }
    clickBrowser(650, 30);
    await view.whenIdle();
    tui.renderNow();
    const changed = record(await backend.run({ action: "screenshot" }));
    assert.match(changed.accessibility, /Coordinate clicked/);
    assert.notDeepEqual(changed.png, initial.png);
    clickBrowser(650, 115);
    await view.whenIdle();
    tui.renderNow();
    view.handleInput("\u001b");
    assert.ok(result);
    assert.equal(result.clicks, 2);
    assert.equal(result.snapshot.url, `${origin}/next`);
    record(result.snapshot);
    overlay.hide();
  } finally {
    view.dispose();
    tui.stop();
    setCapabilities(caps);
    setCellDimensions(cell);
  }
});

test("native inspection input focuses fields, preserves rapid typing/editing, pastes, and scrolls", async () => {
  const initial = record(await backend.run({ action: "navigate", url: origin }));
  const caps = { ...getCapabilities() }, cell = { ...getCellDimensions() };
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
  setCellDimensions({ widthPx: 10, heightPx: 20 });
  const terminal = new VirtualTerminal();
  const tui = new TuiAltScreen(terminal);
  const view = new InspectionView(initial, backend, tui, theme, new AbortController(), () => {});
  try {
    tui.start();
    const overlay = tui.showOverlay(view, { width: "100%", maxHeight: "100%", margin: 1, anchor: "top-left" });
    tui.renderNow(true);
    const bounds = overlay.getBounds()!;
    const surface = new InspectionSurface(initial, () => terminal.rows - 6, 3);
    surface.render(bounds.width);
    const placement = surface.placement!;
    const point = (x: number, y: number) => ({
      x: bounds.col + Math.floor(x / initial.viewport.width * placement.columns),
      y: bounds.row + 3 + Math.floor(y / initial.viewport.height * placement.rows),
    });
    const field = point(140, 250);
    terminal.click(field.x, field.y);
    // Type immediately, while click/capture is still running. Nothing can be lost.
    for (const char of "Rapid browser") terminal.onInput?.(char);
    terminal.onInput?.("\u007f");
    terminal.onInput?.("r");
    terminal.onInput?.("\r");
    await view.whenIdle();
    tui.renderNow();
    const typed = record(await backend.run({ action: "screenshot" }));
    assert.match(typed.accessibility, /Hello Rapid browser/);
    assert.match(typed.accessibility, /textbox "Name": Rapid browser/);
    terminal.onInput?.(process.platform === "darwin" ? "\u001b[97;9u" : "\u0001");
    terminal.onInput?.("Replaced");
    terminal.onInput?.("\r");
    await view.whenIdle();
    tui.renderNow();
    assert.match(record(await backend.run({ action: "screenshot" })).accessibility, /Hello Replaced/);
    const notes = point(500, 250);
    terminal.click(notes.x, notes.y);
    terminal.onInput?.("\u001b[200~line one\n中文 🚀\u001b[201~");
    await view.whenIdle();
    tui.renderNow();
    assert.match(record(await backend.run({ action: "screenshot" })).accessibility, /line one/);
    assert.match(record(await backend.run({ action: "screenshot" })).accessibility, /中文 🚀/);
    const inner = point(950, 300);
    terminal.onInput?.(`\u001b[<65;${inner.x + 1};${inner.y + 1}M`);
    await view.whenIdle();
    tui.renderNow();
    const scrolledInner = record(await backend.run({ action: "screenshot" }));
    assert.match(scrolledInner.accessibility, /Inner scroll [1-9]/);
    assert.equal(scrolledInner.scroll.y, 0);
    const body = point(740, 650);
    for (let i = 0; i < 4; i++) terminal.onInput?.(`\u001b[<65;${body.x + 1};${body.y + 1}M`);
    await view.whenIdle();
    tui.renderNow();
    const scrolled = record(await backend.run({ action: "screenshot" }));
    assert.ok(scrolled.scroll.y > 0);
    assert.notDeepEqual(scrolled.png, typed.png);
    view.handleInput("\u001b");
    overlay.hide();
  } finally { view.dispose(); tui.stop(); setCapabilities(caps); setCellDimensions(cell); }
});

test("input batches capture once and failed batches do not poison the browser queue", async () => {
  record(await backend.run({ action: "navigate", url: origin }));
  record(await backend.run({ action: "click", target: { selector: "#name" } }));
  const result = record(await backend.runBatch([
    { action: "type", text: "batch" }, { action: "press", key: "Backspace" },
    { action: "type", text: "h typed" }, { action: "press", key: "Enter" },
  ]));
  assert.match(result.accessibility, /Hello batch typed/);
  await assert.rejects(backend.runBatch([]), /cannot be empty/);
  await assert.rejects(backend.runBatch([{ action: "close" }, { action: "screenshot" }]), /only action/);
  assert.equal(record(await backend.run({ action: "screenshot" })).title, "Browser fixture");
});

test("cancellation interrupts navigation; close is idempotent and restart is fresh", async () => {
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(backend.run({ action: "screenshot" }, alreadyAborted.signal), { name: "AbortError" });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300);
  try {
    await assert.rejects(backend.run({ action: "navigate", url: `${origin}/slow` }, controller.signal), { name: "AbortError" });
  } finally { clearTimeout(timer); }
  assert.equal(await backend.run({ action: "close" }), undefined);
  await backend.close();
  await backend.close();
  const fresh = record(await backend.run({ action: "screenshot" }));
  assert.equal(fresh.url, "about:blank");
  assert.deepEqual(fresh.viewport, { width: 1280, height: 800 });
});
