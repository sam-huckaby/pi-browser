import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  getCapabilities, getCellDimensions, setCapabilities, setCellDimensions,
  TuiAltScreen, visibleWidth, type TerminalCapabilities,
} from "@earendil-works/pi-tui";
import type { BrowserAction } from "../src/browser/actions.ts";
import type { BrowserBackend } from "../src/browser/backend.ts";
import { createInspectionTool } from "../src/browser/inspection-tool.ts";
import { Inspections } from "../src/ui/inspection.ts";
import { InspectionSurface, imagePlacement, mapImageClick } from "../src/ui/inspection-surface.ts";
import { InspectionView, type InspectionResult } from "../src/ui/inspection-view.ts";
import { mouse, snapshot, theme, VirtualTerminal } from "./support.ts";

let savedCaps: TerminalCapabilities;
let savedCell: ReturnType<typeof getCellDimensions>;
beforeEach(() => {
  savedCaps = { ...getCapabilities() };
  savedCell = { ...getCellDimensions() };
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
  setCellDimensions({ widthPx: 10, heightPx: 20 });
});
afterEach(() => { setCapabilities(savedCaps); setCellDimensions(savedCell); });

function harness(run: BrowserBackend["run"] = async () => snapshot, runBatch?: BrowserBackend["runBatch"]) {
  const terminal = new VirtualTerminal();
  let renders = 0;
  let result: InspectionResult | undefined;
  const controller = new AbortController();
  const view = new InspectionView(snapshot, { run, runBatch, close: async () => {} }, {
    terminal, requestRender: () => renders++,
  }, theme, controller, (value) => { result = value; });
  return { view, terminal, controller, renders: () => renders, result: () => result };
}

test("Kitty click mapping uses cell centres and rejects header, padding, and edges", () => {
  const placement = imagePlacement(snapshot.viewport, 64, 20, { widthPx: 10, heightPx: 20 }, "kitty", 3);
  assert.deepEqual(mapImageClick(placement, 31, 12), { x: 630, y: 380 });
  assert.deepEqual(mapImageClick(placement, 0, 3), { x: 10, y: 20 });
  for (const [x, y] of [[0, 2], [-1, 3], [64, 3], [0, 23], [Infinity, 3]]) assert.equal(mapImageClick(placement, x!, y!), undefined);
});

test("iTerm2 mapping excludes unused pixels in a rounded-up final cell row", () => {
  const placement = imagePlacement({ width: 100, height: 21 }, 10, 2, { widthPx: 10, heightPx: 20 }, "iterm2", 3);
  assert.equal(placement.heightPx, 21);
  assert.deepEqual(mapImageClick(placement, 4, 3), { x: 45, y: 10 });
  assert.equal(mapImageClick(placement, 4, 4), undefined);
});

test("surface derives hit bounds from the native image result and adapts to resize/cell size", () => {
  let height = 30;
  const surface = new InspectionSurface(snapshot, () => height, 3);
  const lines = surface.render(120);
  const initial = surface.placement!;
  assert.equal(lines.length, initial.rows);
  assert.ok(initial.columns <= 118 && initial.rows <= 30);
  height = 10;
  surface.render(80);
  assert.ok(surface.placement!.rows <= 10);
  assert.notEqual(surface.placement!.columns, initial.columns);
  setCellDimensions({ widthPx: 8, heightPx: 17 });
  surface.render(80);
  assert.equal(surface.placement!.cell.widthPx, 8);
  surface.invalidate();
  assert.equal(surface.placement, undefined);
});

test("one left click forwards local image coordinates and refreshes the screenshot", async () => {
  const actions: BrowserAction[] = [];
  const h = harness(async (action) => { actions.push(action); return { ...snapshot, url: "http://localhost/next" }; });
  h.view.render(120);
  h.view.handleMouse(mouse(30, 10, "press"));
  h.view.handleMouse(mouse(30, 10, "release"));
  assert.equal(actions.length, 0);
  h.view.handleMouse(mouse(30, 10));
  await h.view.whenIdle();
  assert.equal(actions.length, 1);
  assert.equal(actions[0]!.action, "click");
  const lines = h.view.render(120);
  assert.match(lines[1]!, /localhost\/next/);
  h.view.handleInput("\u001b");
  assert.equal(h.result()?.clicks, 1);
  assert.equal(h.result()?.snapshot.url, "http://localhost/next");
});

test("right clicks, modifier clicks, drags, headers, and image padding don't reach Chromium", async () => {
  let actions = 0;
  const h = harness(async () => { actions++; return snapshot; });
  h.view.render(120);
  h.view.handleMouse({ ...mouse(10, 8), button: "right" });
  h.view.handleMouse({ ...mouse(10, 8), ctrl: true });
  h.view.handleMouse({ ...mouse(10, 8, "wheel"), ctrl: true, wheelDelta: 1 });
  h.view.handleMouse(mouse(10, 8, "drag"));
  h.view.handleMouse(mouse(0, 1));
  h.view.handleMouse(mouse(119, 8));
  await h.view.whenIdle();
  assert.equal(actions, 0);
  h.view.dispose();
});

test("busy view drops stale clicks; close cancels pending work without a late redraw", async () => {
  let calls = 0;
  let release!: () => void;
  const h = harness(async (_action, signal) => {
    calls++;
    await new Promise<void>((resolve) => { release = resolve; });
    signal?.throwIfAborted();
    return snapshot;
  });
  h.view.render(120);
  h.view.handleMouse(mouse(30, 10));
  h.view.handleMouse(mouse(31, 10));
  assert.equal(calls, 1);
  h.view.handleInput("\u001b");
  assert.ok(h.controller.signal.aborted);
  const rendersAtClose = h.renders();
  release();
  await h.view.whenIdle();
  assert.equal(h.renders(), rendersAtClose);
  assert.equal(h.result()?.clicks, 0);
  h.view.dispose();
});

test("click errors are recoverable with refresh, and aren't followed by stale-coordinate clicks", async () => {
  let calls = 0;
  const h = harness(async () => { if (++calls === 1) throw new Error("Page changed\u001b[31m"); return snapshot; });
  h.view.render(120);
  h.view.handleMouse(mouse(30, 10));
  await h.view.whenIdle();
  assert.match(h.view.render(120)[2]!, /Page changed/);
  h.view.handleMouse(mouse(30, 10));
  assert.equal(calls, 1);
  h.view.handleInput("\u0012"); // Ctrl+R, not the printable letter r
  await h.view.whenIdle();
  assert.equal(calls, 2);
  assert.doesNotMatch(h.view.render(120)[2]!, /Page changed/);
  h.view.dispose();
});

test("arrows and Enter reach the webpage while toolbar controls refresh and exit", async () => {
  const actions: BrowserAction[] = [];
  const h = harness(async (action) => { actions.push(action); return snapshot; });
  h.view.render(120);
  h.view.handleInput("\u001b[C"); // right arrow
  h.view.handleInput("\r");
  await h.view.whenIdle();
  assert.deepEqual(actions.slice(0, 2), [{ action: "press", key: "ArrowRight" }, { action: "press", key: "Enter" }]);
  h.view.handleMouse(mouse(14, 0));
  await h.view.whenIdle();
  assert.deepEqual(actions[2], { action: "screenshot" });
  h.view.handleMouse(mouse(24, 0));
  assert.ok(h.result());
});

test("wheel scrolls at the image pointer, supports horizontal scroll, and ignores margins", async () => {
  const actions: BrowserAction[] = [];
  const h = harness(async (action) => { actions.push(action); return snapshot; });
  h.view.render(120);
  h.view.handleMouse({ ...mouse(30, 10, "wheel"), wheelDelta: 2 });
  await h.view.whenIdle();
  assert.equal(actions[0]!.action, "scroll");
  assert.equal(actions[0]!.action === "scroll" && actions[0]!.deltaY, 160);
  assert.ok(actions[0]!.action === "scroll" && actions[0]!.x !== undefined);
  h.view.render(120);
  h.view.handleMouse({ ...mouse(30, 10, "wheel"), wheelDelta: -1, shift: true });
  await h.view.whenIdle();
  assert.equal(actions[1]!.action === "scroll" && actions[1]!.deltaX, -80);
  assert.equal(actions[1]!.action === "scroll" && actions[1]!.deltaY, 0);
  h.view.render(120);
  h.view.handleMouse({ ...mouse(30, 1, "wheel"), wheelDelta: 1 });
  h.view.handleMouse({ ...mouse(119, 10, "wheel"), wheelDelta: 1 });
  assert.equal(actions.length, 2);
  h.view.dispose();
});

test("rapid input is buffered, coalesced, and kept in order across editing keys", async () => {
  const batches: BrowserAction[][] = [];
  let release!: () => void;
  const h = harness(undefined, async (batch) => {
    batches.push(batch);
    if (batches.length === 1) await new Promise<void>((resolve) => { release = resolve; });
    return snapshot;
  });
  h.view.render(120);
  h.view.handleInput("a");
  h.view.handleInput("r");
  h.view.handleInput("b");
  h.view.handleInput("\u007f");
  h.view.handleInput("c");
  h.view.handleInput("\r");
  h.view.handleInput("\u0003"); // Ctrl+C is a browser key, not inspection exit.
  assert.equal(batches.length, 1);
  release();
  await h.view.whenIdle();
  assert.deepEqual(batches, [
    [{ action: "type", text: "a" }],
    [{ action: "type", text: "rb" }, { action: "press", key: "Backspace" }, { action: "type", text: "c" }, { action: "press", key: "Enter" }, { action: "press", key: "Control+c" }],
  ]);
  assert.equal(h.result(), undefined);
  h.view.dispose();
});

test("rapid wheel events accumulate while the browser updates instead of being dropped", async () => {
  const batches: BrowserAction[][] = [];
  let release!: () => void;
  const h = harness(undefined, async (batch) => {
    batches.push(batch);
    if (batches.length === 1) await new Promise<void>((resolve) => { release = resolve; });
    return snapshot;
  });
  h.view.render(120);
  for (let i = 0; i < 5; i++) h.view.handleMouse({ ...mouse(30, 10, "wheel"), wheelDelta: 1 });
  release();
  await h.view.whenIdle();
  assert.equal(batches.length, 2);
  assert.equal(batches[0]![0]!.action === "scroll" && batches[0]![0]!.deltaY, 80);
  assert.equal(batches[1]![0]!.action === "scroll" && batches[1]![0]!.deltaY, 320);
  h.view.dispose();
});

test("view fits terminal height and text widths, including very small terminals", () => {
  const h = harness();
  for (const rows of [2, 5, 10, 40]) {
    h.terminal.rows = rows;
    for (const width of [0, 1, 2, 20, 120]) {
      const lines = h.view.render(width);
      assert.ok(lines.length <= Math.max(0, rows - 2));
      for (const line of lines) assert.ok(visibleWidth(line) <= width);
    }
  }
  h.view.dispose();
});

test("real fullscreen renderer dispatches SGR mouse clicks through an offset overlay once", async () => {
  const terminal = new VirtualTerminal();
  const tui = new TuiAltScreen(terminal);
  const actions: BrowserAction[] = [];
  const view = new InspectionView(snapshot, { run: async (action) => { actions.push(action); return snapshot; }, close: async () => {} }, tui, theme, new AbortController(), () => {});
  try {
    tui.start();
    const overlay = tui.showOverlay(view, { width: "100%", maxHeight: "100%", margin: 1, anchor: "top-left" });
    tui.renderNow(true);
    const bounds = overlay.getBounds()!;
    assert.ok(bounds && bounds.col > 0 && bounds.row > 0);
    terminal.click(bounds.col + 30, bounds.row + 10);
    await view.whenIdle();
    assert.equal(actions.length, 1);
    assert.equal(actions[0]!.action, "click");
    assert.equal(tui.hasActiveSelection(), false);
    assert.ok(terminal.writes.some((write) => write.includes("\u001b_G")));
    overlay.hide();
  } finally { view.dispose(); tui.stop(); }
});

test("inspection rejects unsupported modes/graphics before launching a browser", async () => {
  let calls = 0;
  const inspections = new Inspections({ run: async () => { calls++; return snapshot; }, close: async () => {} });
  await assert.rejects(inspections.open({ mode: "rpc" } as ExtensionContext), /interactive/);
  function context(mode: "regular" | "fullscreen"): ExtensionContext {
    return { mode: "tui", ui: { custom: async (factory: Function) => factory({ mode }, theme, undefined, () => {}) } } as unknown as ExtensionContext;
  }
  await assert.rejects(inspections.open(context("regular")), /fullscreen/);
  setCapabilities({ images: null, trueColor: true, hyperlinks: false });
  await assert.rejects(inspections.open(context("fullscreen")), /Kitty graphics/);
  assert.equal(calls, 0);
});

test("inspection manager shares browser state, rejects overlap, and handles turn cancellation", async () => {
  const actions: BrowserAction[] = [];
  const inspections = new Inspections({ run: async (action) => { actions.push(action); return snapshot; }, close: async () => {} });
  let created!: (view: InspectionView) => void;
  const ctx = {
    mode: "tui", ui: {
      custom: (factory: Function) => new Promise((resolve, reject) => {
        Promise.resolve(factory({ mode: "fullscreen", terminal: new VirtualTerminal(), requestRender: () => {} }, theme, undefined, resolve)).then((view) => created(view), reject);
      }),
    },
  } as unknown as ExtensionContext;
  const viewReady = new Promise<InspectionView>((resolve) => { created = resolve; });
  const opening = inspections.open(ctx, "http://localhost/test");
  const view = await viewReady;
  await assert.rejects(inspections.open(ctx), /already open/);
  assert.deepEqual(actions[0], { action: "navigate", url: "http://localhost/test" });
  view.handleInput("\u001b");
  assert.equal((await opening).snapshot.url, snapshot.url);
  const readyAgain = new Promise<InspectionView>((resolve) => { created = resolve; });
  const controller = new AbortController();
  const next = inspections.open(ctx, undefined, controller.signal);
  const canceled = assert.rejects(next, { name: "AbortError" });
  await readyAgain;
  controller.abort();
  await canceled;
  assert.deepEqual(actions[1], { action: "screenshot" });
});

test("inspection tool returns last screenshot and click count, never implying approval", async () => {
  const inspections = { open: async () => ({ snapshot, clicks: 2 }) } as unknown as Inspections;
  const tool = createInspectionTool(inspections);
  const result = await tool.execute("inspection", {}, undefined, undefined, {} as never);
  assert.ok("clicks" in result.details);
  assert.equal(result.details.clicks, 2);
  assert.equal(result.content[1]!.type, "image");
  assert.equal("png" in result.details, false);
  assert.match(result.content[0]!.type === "text" ? result.content[0]!.text : "", /not an approval/);
  assert.equal(tool.exposure, "model-only");
});
