import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { getCapabilities, getCellDimensions, setCapabilities, setCellDimensions, TuiAltScreen } from "@earendil-works/pi-tui";
import type { Page } from "playwright";
import { DreamChromiumBackend } from "../src/dream/backend.ts";
import { saveDream } from "../src/dream/artifacts.ts";
import { activityAction } from "../src/dream/activity.ts";
import type { DreamAction, DreamFrame, ResizeHandle } from "../src/dream/types.ts";
import { DreamView } from "../src/ui/dream-view.ts";
import { mapImageClick, type ImagePlacement } from "../src/ui/inspection-surface.ts";
import { mouse, snapshot, theme, VirtualTerminal } from "./support.ts";

const fixture = `<!doctype html><meta charset=utf-8><title>Resize fixture</title><style>
body{margin:0;min-height:1800px;font:16px system-ui}#box,#neighbor{box-sizing:border-box;position:absolute;top:100px;width:220px;height:120px;padding:12px;border:3px solid #6875bd;background:#e7eaff}#box{left:100px}#neighbor{left:390px}#content{box-sizing:content-box;position:absolute;left:100px;top:330px;width:180px;height:70px;padding:12px;border:4px solid #859}#inline-wrap{position:absolute;left:100px;top:480px}#flow{position:absolute;left:100px;top:650px;width:700px}#flow-first{width:200px;height:80px;background:#eee}#flow-next{height:30px;background:#cce}#flex{position:absolute;left:700px;top:100px;display:flex;width:400px}#flex-first,#flex-next{flex:1;min-width:180px;height:80px;background:#cfc}#scaled{position:absolute;left:700px;top:330px;transform:scale(1.2);transform-origin:top left}#scaled-child{width:100px;height:80px;background:#fdd}#password{position:absolute;left:800px;top:500px;width:160px;height:40px}
</style><div id=box><button id=child>Child</button></div><div id=neighbor>Neighbor</div><div id=content>Content box</div><div id=inline-wrap><span id=inline>Inline text</span></div><div id=flow><div id=flow-first>First</div><div id=flow-next>Next</div></div><div id=flex><div id=flex-first>Flex</div><div id=flex-next>Next</div></div><div id=scaled><div id=scaled-child>Scaled</div></div><input id=password type=password value=synthetic-password><script>window.appClicks=0;document.addEventListener('click',()=>window.appClicks++);</script>`;
class ReadableDream extends DreamChromiumBackend {
  inspect<T>(fn: (page: Page) => Promise<T>): Promise<T> { return this.withPage(fn); }
}
let server: Server, url: string, caps: ReturnType<typeof getCapabilities>, cells: ReturnType<typeof getCellDimensions>;
before(async () => {
  server = createServer((_req, res) => { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(fixture); });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
beforeEach(() => { caps = getCapabilities(); cells = getCellDimensions(); setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false }); setCellDimensions({ widthPx: 10, heightPx: 20 }); });
afterEach(() => { setCapabilities(caps); setCellDimensions(cells); });
async function select(backend: ReadableDream, selector: string): Promise<DreamFrame> {
  const rect = await backend.inspect(page => page.locator(selector).boundingBox()); assert.ok(rect);
  return backend.apply([{ action: "select", x: rect.x + 3, y: rect.y + 3 }]);
}
function resize(frame: DreamFrame, handle: ResizeHandle, dx: number, dy: number): Extract<DreamAction, { action: "resize" }> {
  const selection = frame.state.selected?.resize; assert.ok(selection);
  const item = selection.handles.find(item => item.handle === handle); assert.ok(item);
  const from = { x: item.bounds.x + item.bounds.width / 2, y: item.bounds.y + item.bounds.height / 2 };
  return { action: "resize", selection: selection.token, handle, from, to: { x: from.x + dx, y: from.y + dy } };
}

test("all eight handles resize only a selected node, anchor the opposite edges, and undo/redo exact dimensions", async () => {
  const backend = new ReadableDream();
  try {
    const opened = await backend.open(url); assert.equal(opened.state.selected, undefined);
    assert.equal(await backend.inspect(p => p.locator("[data-pi-dream-resize]").count()), 0);
    for (const [handle, dx, dy] of [["nw", -40, -30], ["n", 0, 25], ["ne", 30, -20], ["e", 40, 0], ["se", 40, 30], ["s", 0, 25], ["sw", -30, 20], ["w", 35, 0]] as const) {
      const frame = await select(backend, "#box"); const original = frame.state.selected!.bounds;
      assert.equal(frame.state.selected?.resize?.handles.length, 8);
      const action = resize(frame, handle, dx, dy);
      const result = await backend.apply([action]); const box = result.state.selected!.bounds;
      assert.equal(box.width, original.width + (handle.includes("w") ? -dx : handle.includes("e") ? dx : 0));
      assert.equal(box.height, original.height + (handle.includes("n") ? -dy : handle.includes("s") ? dy : 0));
      assert.equal(box.x, original.x + (handle.includes("w") ? dx : 0));
      assert.equal(box.y, original.y + (handle.includes("n") ? dy : 0));
      assert.equal(result.state.changes.at(-1)?.kind, "resize");
      assert.deepEqual(result.state.changes.at(-1)?.from, original); assert.deepEqual(result.state.changes.at(-1)?.to, box);
      assert.deepEqual((await backend.apply([{ action: "undo" }])).state.selected?.bounds, original);
      assert.deepEqual((await backend.apply([{ action: "redo" }])).state.selected?.bounds, box);
      await backend.apply([{ action: "undo" }]);
    }
    assert.equal(await backend.inspect(p => p.locator("#neighbor").getAttribute("style")), null);
    assert.equal(await backend.inspect(p => p.locator("#box").getAttribute("style")), null);
    assert.equal(await backend.inspect(p => p.evaluate(() => (window as unknown as { appClicks: number }).appClicks)), 0);
  } finally { await backend.close(); }
});

test("resize never selects a target, rejects stale identities/off-handle gestures, and ignores replaced selections", async () => {
  const backend = new ReadableDream();
  try {
    await backend.open(url);
    const action: Extract<DreamAction, { action: "resize" }> = { action: "resize", selection: "missing", handle: "se", from: { x: 320, y: 220 }, to: { x: 350, y: 250 } };
    assert.equal((await backend.apply([action])).state.changes.length, 0);
    const selected = await select(backend, "#box"), stale = resize(selected, "se", 40, 30);
    await select(backend, "#neighbor");
    const rejected = await backend.apply([stale]); assert.equal(rejected.state.selected?.selector, "#neighbor"); assert.equal(rejected.state.changes.length, 0);
    const next = await select(backend, "#box");
    const badOrigin = { ...resize(next, "se", 40, 30), from: { x: 150, y: 150 } };
    assert.match((await backend.apply([badOrigin])).state.notice!, /current selection/);
    await backend.inspect(p => p.locator("#box").evaluate(node => node.replaceWith(node.cloneNode(true))));
    const removed = await backend.apply([stale]); assert.equal(removed.state.changes.length, 0); assert.equal(removed.state.selected, undefined);
  } finally { await backend.close(); }
});

test("content-box padding/borders, inline elements, and flex constraints produce requested rendered sizes", async () => {
  const backend = new ReadableDream();
  try {
    await backend.open(url);
    for (const selector of ["#content", "#inline", "#flex-first"]) {
      const selected = await select(backend, selector); const original = selected.state.selected!.bounds;
      const result = await backend.apply([resize(selected, "se", 40, 25)]);
      assert.ok(Math.abs(result.state.selected!.bounds.width - original.width - 40) < 0.1, selector);
      assert.ok(Math.abs(result.state.selected!.bounds.height - original.height - 25) < 0.1, selector);
      await backend.apply([{ action: "undo" }]);
      assert.equal(await backend.inspect(p => p.locator(selector).getAttribute("style")), null);
    }
    const horizontal = await select(backend, "#content");
    assert.equal((await backend.apply([resize(horizontal, "e", 35, 0)])).state.selected?.bounds.height, horizontal.state.selected?.bounds.height);
  } finally { await backend.close(); }
});

test("resizing reflows siblings, respects moved geometry, clamps minimums, and saves a clean resize goal", async () => {
  const backend = new ReadableDream(), cwd = await mkdtemp(join(tmpdir(), "dream-resize-"));
  try {
    await backend.open(url);
    const selected = await select(backend, "#flow-first");
    const originalNext = await backend.inspect(p => p.locator("#flow-next").boundingBox());
    await backend.apply([resize(selected, "s", 0, 40)]);
    assert.equal((await backend.inspect(p => p.locator("#flow-next").boundingBox()))!.y, originalNext!.y + 40);
    await backend.apply([{ action: "undo" }]);
    const moved = await backend.apply([{ action: "drag", from: { x: 110, y: 110 }, to: { x: 180, y: 150 } }]);
    const changed = await backend.apply([resize(moved, "se", 35, 25)]);
    assert.equal(changed.state.selected?.bounds.x, 170); assert.equal(changed.state.selected?.bounds.y, 140);
    const small = await backend.apply([resize(changed, "nw", 1000, 1000)]);
    assert.equal(small.state.selected?.bounds.width, 30, "padding and borders impose a physical minimum");
    assert.equal(small.state.selected?.bounds.height, 30);
    const final = await backend.apply([{ action: "finish" }]);
    assert.equal(await backend.inspect(p => p.locator("[data-pi-dream-resize],[data-pi-dream-overlay]").count()), 0);
    const artifact = await saveDream(cwd, { ...final, canceled: false });
    assert.equal(JSON.parse(await readFile(artifact.manifestPath, "utf8")).changes.at(-1).kind, "resize");
  } finally { await backend.close(); await rm(cwd, { recursive: true, force: true }); }
});

test("editing/menu/transformed selections have no resize handles; Alt+arrows resize only selected nonediting elements", async () => {
  const backend = new ReadableDream();
  try {
    await backend.open(url);
    assert.equal((await select(backend, "#scaled-child")).state.selected?.resize, undefined);
    const selected = await select(backend, "#box");
    const keyboard = await backend.apply([{ action: "key", key: "Alt+ArrowRight" }, { action: "key", key: "Alt+ArrowDown" }]);
    assert.equal(keyboard.state.selected?.bounds.width, selected.state.selected!.bounds.width + 10);
    assert.equal(keyboard.state.selected?.bounds.height, selected.state.selected!.bounds.height + 10);
    const menu = await backend.apply([{ action: "context" }]); assert.equal(menu.state.selected?.resize, undefined);
    const invalid = await backend.apply([resize(keyboard, "se", 30, 20)]); assert.equal(invalid.state.changes.length, 2);
    await backend.apply([{ action: "dismiss-menu" }]);
    await select(backend, "#inline"); const editing = await backend.apply([{ action: "edit" }]);
    assert.equal(editing.state.selected?.resize, undefined);
    assert.equal(await backend.inspect(p => p.locator("[data-pi-dream-resize]").count()), 0);
  } finally { await backend.close(); }
});

test("undo preserves inline sizing priorities, partial transitions, node identity, and unrelated app styles", async () => {
  const backend = new ReadableDream();
  try {
    await backend.open(url);
    await backend.inspect(p => p.locator("#box").evaluate(node => {
      const element = node as HTMLElement;
      element.style.setProperty("width", "220px", "important");
      element.style.transitionDuration = "2s";
      (window as unknown as { originalBox: HTMLElement }).originalBox = element;
    }));
    const selected = await select(backend, "#box");
    await backend.apply([resize(selected, "se", 50, 30)]);
    await backend.inspect(p => p.locator("#box").evaluate(node => { (node as HTMLElement).style.color = "red"; }));
    await backend.apply([{ action: "undo" }]);
    assert.deepEqual(await backend.inspect(p => p.locator("#box").evaluate(node => {
      const element = node as HTMLElement;
      return { width: element.style.width, priority: element.style.getPropertyPriority("width"), duration: element.style.transitionDuration,
        property: element.style.transitionProperty, color: element.style.color, same: element === (window as unknown as { originalBox: HTMLElement }).originalBox };
    })), { width: "220px", priority: "important", duration: "2s", property: "", color: "red", same: true });
    await backend.apply([{ action: "redo" }]);
    assert.equal(await backend.inspect(p => p.locator("#box").evaluate(node => node.getBoundingClientRect().width)), 270);
    await assert.rejects(backend.apply([{ ...resize(await select(backend, "#box"), "se", 20, 20), to: { x: Infinity, y: 200 } }]), /Invalid resize/);
    assert.equal((await backend.apply([{ action: "refresh" }])).state.changes.length, 1);
  } finally { await backend.close(); }
});

test("real Pi press/drag/release resizes Chromium's current selection and native undo restores it", async () => {
  const backend = new ReadableDream(), terminal = new VirtualTerminal(), tui = new TuiAltScreen(terminal);
  let view: DreamView | undefined;
  try {
    await backend.open(url); let latest = await select(backend, "#box"); const original = latest.state.selected!.bounds;
    view = new DreamView(latest, { open: (...args) => backend.open(...args), close: () => backend.close(),
      apply: async (actions, signal) => latest = await backend.apply(actions, signal) }, tui, theme, new AbortController(), () => {});
    tui.start(); const overlay = tui.showOverlay(view, { width: "100%", maxHeight: "100%", margin: 1, anchor: "top-left" }); tui.renderNow(true);
    const placement = (view as unknown as { surface: { placement: ImagePlacement } }).surface.placement, origin = overlay.getBounds()!;
    const handle = latest.state.selected!.resize!.handles.find(item => item.handle === "se")!.bounds;
    const x = origin.col + placement.left + Math.floor((handle.x + handle.width / 2) / 1280 * placement.widthPx / placement.cell.widthPx);
    const y = origin.row + placement.top + Math.floor((handle.y + handle.height / 2) / 800 * placement.heightPx / placement.cell.heightPx);
    terminal.onInput?.(`\u001b[<0;${x + 1};${y + 1}M`);
    terminal.onInput?.(`\u001b[<32;${x + 7};${y + 3}M`);
    terminal.onInput?.(`\u001b[<0;${x + 7};${y + 3}m`);
    await view.whenIdle(); tui.renderNow(true);
    assert.equal(latest.state.changes.at(-1)?.kind, "resize");
    assert.ok(latest.state.selected!.bounds.width > original.width); assert.ok(latest.state.selected!.bounds.height > original.height);
    assert.equal(tui.hasActiveSelection(), false);
    terminal.onInput?.("\u001a"); await view.whenIdle();
    assert.deepEqual(latest.state.selected?.bounds, original);
    overlay.hide();
  } finally { view?.dispose(); tui.stop(); await backend.close(); }
});

test("private resize history stays omitted after release and password controls keep their real value protected", async () => {
  const backend = new ReadableDream();
  try {
    await backend.open(url); await backend.setPrivate(true);
    const selected = await select(backend, "#password");
    const resized = await backend.apply([resize(selected, "se", 35, 20)]);
    assert.equal(resized.snapshot.private, true); assert.equal(resized.snapshot.screenshotPath, "");
    await backend.setPrivate(false);
    const released = await backend.apply([{ action: "refresh" }]);
    assert.deepEqual(released.state.changes.at(-1), { kind: "resize", selector: "[private edit omitted]", private: true });
    assert.doesNotMatch(JSON.stringify(released.state), /synthetic-password/); assert.doesNotMatch(released.snapshot.accessibility, /synthetic-password/);
    assert.equal(await backend.inspect(p => p.locator("#password").inputValue()), "synthetic-password");
    assert.deepEqual((await backend.apply([{ action: "undo" }])).state.selected?.bounds, selected.state.selected?.bounds);
  } finally { await backend.close(); }
});

test("terminal mouse capture routes only a selected handle to resize; other edges drag, and Escape cancels", async () => {
  const selected: DreamFrame = { snapshot, state: { editing: false, canPaste: false, canUndo: false, canRedo: false, message: "Selected", changes: [], selected: { selector: "#box", tag: "div", bounds: { x: 100, y: 100, width: 220, height: 120 }, resize: { token: "selection-1", handles: [{ handle: "se", bounds: { x: 312, y: 212, width: 16, height: 16 } }] } } } };
  const actions: DreamAction[] = [];
  const terminal = new VirtualTerminal(); let finished = false;
  const view = new DreamView(selected, { open: async () => selected, close: async () => {}, apply: async batch => { actions.push(...batch); return selected; } }, { terminal, requestRender: () => {} }, theme, new AbortController(), () => { finished = true; });
  try {
    view.render(120);
    // Derive the real rendered map, including handles smaller than a terminal row.
    const rendered = (view as unknown as { surface: { placement: ImagePlacement } }).surface.placement;
    let cell: { x: number; y: number } | undefined, nearest = Infinity;
    for (let y = rendered.top; y < rendered.top + rendered.rows; y++) for (let x = 0; x < rendered.columns; x++) {
      const point = mapImageClick(rendered, x, y); if (!point) continue;
      const distance = (point.x - 320) ** 2 + (point.y - 220) ** 2;
      if (distance < nearest) { nearest = distance; cell = { x, y }; }
    }
    assert.ok(cell);
    view.handleMouse(mouse(cell.x, cell.y, "press")); view.handleMouse(mouse(cell.x + 4, cell.y + 2, "drag")); view.handleMouse(mouse(cell.x + 4, cell.y + 2, "release")); await view.whenIdle();
    assert.equal(actions[0]?.action, "resize"); assert.equal((actions[0] as { selection: string }).selection, "selection-1");
    assert.deepEqual((actions[0] as { from: object }).from, { x: 320, y: 220 }, "quantized cell snaps to the selected handle, without a resize jump");
    view.render(120); view.handleMouse(mouse(20, 10, "press")); view.handleMouse(mouse(24, 12, "release")); await view.whenIdle();
    assert.equal(actions[1]?.action, "drag");
    view.render(120); view.handleMouse(mouse(cell.x, cell.y, "press")); view.handleInput("\u001b"); view.handleMouse(mouse(cell.x + 5, cell.y + 2, "release")); await view.whenIdle();
    assert.equal(actions.length, 2); assert.equal(finished, false);
    const projection = activityAction({ action: "resize", selection: "selection-1", handle: "se", from: { x: 1, y: 2 }, to: { x: 3, y: 4 } });
    assert.equal(projection.handle, "se"); assert.equal(projection.selection, undefined);
  } finally { view.dispose(); }
});
