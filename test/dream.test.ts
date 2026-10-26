import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { discoverAndLoadExtensions, type ExtensionCommandContext, type ExtensionContext, type ExtensionRuntime } from "@earendil-works/pi-coding-agent";
import { Container, getCapabilities, getCellDimensions, Image, ScrollView, setCapabilities, setCellDimensions, TuiAltScreen, VStack, visibleWidth, type TerminalCapabilities } from "@earendil-works/pi-tui";
import type { Page } from "playwright";
import { dreamFixture } from "../examples/dream-fixture.ts";
import { ghostFixture } from "./ghost-fixture.ts";
import { ChromiumBackend } from "../src/browser/backend.ts";
import { saveDream } from "../src/dream/artifacts.ts";
import { DreamActivity } from "../src/dream/activity.ts";
import { DreamChromiumBackend } from "../src/dream/backend.ts";
import type { DreamAction, DreamBackend, DreamFrame, DreamResult } from "../src/dream/types.ts";
import { Dreams } from "../src/ui/dream.ts";
import { DreamView } from "../src/ui/dream-view.ts";
import { InspectionSurface, mapImageClick } from "../src/ui/inspection-surface.ts";
import { OpaqueModal } from "../src/ui/opaque-modal.ts";
import { mouse, snapshot, theme, VirtualTerminal, waitDreamReady } from "./support.ts";

const isImageLine = (line: string): boolean => line.includes("\u001b_G");

class ReadableDream extends DreamChromiumBackend {
  inspect<T>(fn: (page: Page) => Promise<T>): Promise<T> { return this.withPage(fn); }
}
let server: Server;
let url: string;
let caps: TerminalCapabilities;
let cell: ReturnType<typeof getCellDimensions>;
before(async () => {
  server = createServer((request, response) => {
    if (request.url === "/slow") return;
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(request.url === "/ghost" ? ghostFixture : dreamFixture);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
beforeEach(() => {
  caps = { ...getCapabilities() }; cell = { ...getCellDimensions() };
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false }); setCellDimensions({ widthPx: 10, heightPx: 20 });
});
afterEach(() => { setCapabilities(caps); setCellDimensions(cell); });

const initial: DreamFrame = { snapshot, state: { editing: false, canPaste: false, canUndo: false, canRedo: false, message: "Select an element", changes: [] } };

function fakeHarness(apply: DreamBackend["apply"] = async () => initial) {
  let result: DreamResult | undefined;
  const controller = new AbortController();
  const terminal = new VirtualTerminal();
  const view = new DreamView(initial, { open: async () => initial, apply, close: async () => {} }, { terminal, requestRender: () => {} }, theme, controller, (value) => { result = value; });
  return { view, terminal, controller, result: () => result };
}

test("Dream selects DOM bounds, moves, duplicates, rewrites text, and undo/redo restores the exact page", async () => {
  const backend = new ReadableDream();
  try {
    const opened = await backend.open(url);
    assert.equal(opened.snapshot.png.subarray(1, 4).toString(), "PNG");
    assert.equal(opened.state.selected, undefined);
    const selected = await backend.apply([{ action: "select", x: 160, y: 190 }]);
    assert.equal(selected.state.selected?.selector, "#headline");
    assert.deepEqual(selected.state.selected?.bounds, { x: 80, y: 157, width: 560, height: 112 });
    assert.equal(await backend.inspect((page) => page.locator("[data-pi-dream-overlay]").count()), 1);
    const moved = await backend.apply([{ action: "drag", from: { x: 160, y: 190 }, to: { x: 200, y: 225 } }]);
    assert.equal(moved.state.selected?.bounds.x, 120);
    assert.equal(moved.state.selected?.bounds.y, 192);
    const copied = await backend.apply([{ action: "key", key: "Meta+c" }, { action: "key", key: "Meta+v" }]);
    assert.equal(copied.state.selected?.bounds.x, 144);
    assert.equal(copied.state.selected?.bounds.y, 216);
    assert.equal(await backend.inspect((page) => page.locator("#headline").count()), 1);
    const edited = await backend.apply([{ action: "edit", x: 180, y: 235 }, { action: "text", text: "Dream a better page." }, { action: "key", key: "Enter" }]);
    assert.equal(edited.state.editing, false);
    assert.deepEqual(edited.state.changes.map((change) => change.kind), ["move", "duplicate", "text"]);
    assert.match(edited.snapshot.accessibility, /Dream a better page/);
    assert.equal(await backend.inspect((page) => page.locator("#headline").innerText()), "A better first\nimpression.");
    assert.equal(await backend.inspect((page) => page.evaluate(() => (window as unknown as { appKeys: number }).appKeys)), 0);
    await backend.apply([{ action: "undo" }, { action: "undo" }, { action: "undo" }]);
    assert.equal(await backend.inspect((page) => page.locator("[data-pi-dream-clone]").count()), 0);
    assert.equal(await backend.inspect((page) => page.locator("#headline").evaluate((node) => node.getBoundingClientRect().x)), 80);
    const redone = await backend.apply([{ action: "redo" }, { action: "redo" }, { action: "redo" }]);
    assert.match(redone.snapshot.accessibility, /Dream a better page/);
    const finished = await backend.apply([{ action: "finish" }]);
    assert.equal(finished.state.selected, undefined);
    assert.equal(await backend.inspect((page) => page.locator("[data-pi-dream-overlay],[contenteditable]").count()), 0);
    assert.equal((await backend.open()).state.changes.length, 3);
    assert.equal((await backend.open(url)).state.changes.length, 0);
  } finally { await backend.close(); }
});

test("Parent selects a card and dragging through its child moves the selected group", async () => {
  const backend = new ReadableDream();
  try {
    await backend.open(url);
    const parent = await backend.apply([{ action: "select", x: 830, y: 210 }, { action: "parent" }]);
    assert.equal(parent.state.selected?.selector, "#card");
    const moved = await backend.apply([{ action: "drag", from: { x: 830, y: 210 }, to: { x: 865, y: 240 } }]);
    assert.equal(moved.state.selected?.selector, "#card");
    assert.equal(moved.state.selected?.bounds.x, 800);
    const pasted = await backend.apply([{ action: "copy" }, { action: "paste" }]);
    assert.equal(pasted.state.selected?.bounds.width, 350);
    assert.equal(await backend.inspect((page) => page.locator("[data-pi-dream-clone] h2").innerText()), "Small changes. Big impact.");
    assert.equal(await backend.inspect((page) => page.locator("[data-pi-dream-clone]").evaluate((node) => getComputedStyle(node).backgroundImage)), await backend.inspect((page) => page.locator("#card").evaluate((node) => getComputedStyle(node).backgroundImage)));
    const notText = await backend.apply([{ action: "edit" }]);
    assert.match(notText.state.notice!, /not plain text/);
    assert.equal(notText.state.editing, false);
    assert.equal(notText.state.selected?.selector, pasted.state.selected?.selector);
    assert.equal((await backend.apply([{ action: "refresh" }])).state.changes.length, 2);
  } finally { await backend.close(); }
});

test("moved avatars leave no selectable empty button/span ghosts; undo/redo uses current geometry", async () => {
  const backend = new ReadableDream();
  try {
    await backend.open(url + "/ghost");
    await backend.inspect((page) => page.evaluate(() => {
      const sibling = document.getElementById("avatar")!.cloneNode(true) as HTMLElement;
      sibling.id = "remaining-avatar";
      sibling.style.cssText = "position:absolute;left:70px;top:0;width:24px;height:24px";
      document.getElementById("row")!.append(sibling);
    }));
    const original = { x: 114, y: 214 };
    const moved = await backend.apply([{ action: "drag", from: original, to: { x: 874, y: 164 } }]);
    assert.equal(moved.state.selected?.selector, "#avatar");
    const avatar = moved.state.selected!.bounds;
    const oldSlot = await backend.apply([{ action: "select", ...original }]);
    assert.equal(oldSlot.state.selected?.selector, "#underlay");
    assert.equal((await backend.apply([{ action: "select", x: 182, y: 212 }])).state.selected?.selector, "#remaining-avatar");
    await backend.apply([{ action: "drag", from: original, to: { x: 144, y: 229 } }]);
    assert.deepEqual(await backend.inspect((page) => page.locator("#avatar").boundingBox()), avatar);
    assert.deepEqual(await backend.inspect((page) => page.locator("#row,#slot,#avatar-button,#image-wrapper").evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).style.translate))), ["", "", "", ""]);
    await backend.apply([{ action: "undo" }, { action: "undo" }]);
    assert.equal((await backend.apply([{ action: "select", ...original }])).state.selected?.selector, "#avatar");
    await backend.apply([{ action: "redo" }]);
    assert.equal((await backend.apply([{ action: "select", ...original }])).state.selected?.selector, "#underlay");
    assert.equal((await backend.apply([{ action: "select", x: avatar.x + 12, y: avatar.y + 12 }])).state.selected?.selector, "#avatar");
  } finally { await backend.close(); }
});

test("dragging an emptied slot over the page background is a no-op, not an error or another avatar move", async () => {
  const backend = new ReadableDream();
  try {
    await backend.open(url + "/ghost");
    await backend.inspect((page) => page.locator("#underlay").evaluate((node) => { (node as HTMLElement).style.display = "none"; }));
    const moved = await backend.apply([{ action: "drag", from: { x: 114, y: 214 }, to: { x: 874, y: 164 } }]);
    const attempted = await backend.apply([{ action: "drag", from: { x: 114, y: 214 }, to: { x: 200, y: 240 } }]);
    assert.equal(attempted.state.selected, undefined);
    assert.equal(attempted.state.changes.length, 1);
    assert.deepEqual(await backend.inspect((page) => page.locator("#avatar").boundingBox()), moved.state.selected!.bounds);
  } finally { await backend.close(); }
});

test("painted wrappers and wrappers with remaining visible content stay selectable", async () => {
  const backend = new ReadableDream();
  try {
    await backend.open(url + "/ghost");
    await backend.apply([{ action: "drag", from: { x: 114, y: 214 }, to: { x: 874, y: 164 } }]);
    await backend.inspect((page) => page.locator("#avatar-button").evaluate((node) => { (node as HTMLElement).style.background = "#ffcc00"; }));
    assert.equal((await backend.apply([{ action: "select", x: 114, y: 214 }])).state.selected?.selector, "#avatar-button");
    await backend.inspect((page) => page.evaluate(() => {
      document.getElementById("avatar-button")!.style.background = "transparent";
      const label = document.createElement("span"); label.textContent = "X";
      label.style.cssText = "position:absolute;left:4px;top:2px";
      document.getElementById("image-wrapper")!.append(label);
    }));
    const label = await backend.inspect((page) => page.locator("#image-wrapper > span").boundingBox());
    assert.ok(label);
    const selected = await backend.apply([{ action: "select", x: label.x + label.width / 2, y: label.y + label.height / 2 }]);
    assert.notEqual(selected.state.selected?.selector, "#underlay");
    assert.notEqual(selected.state.selected, undefined);
  } finally { await backend.close(); }
});

test("a selected parent does not hijack dragging its displaced child outside the parent's visible bounds", async () => {
  const backend = new ReadableDream();
  try {
    await backend.open(url);
    const moved = await backend.apply([{ action: "drag", from: { x: 830, y: 210 }, to: { x: 300, y: 120 } }]);
    const heading = moved.state.selected!.bounds;
    assert.equal((await backend.apply([{ action: "parent" }])).state.selected?.selector, "#card");
    const from = { x: heading.x + 30, y: heading.y + 10 };
    const dragged = await backend.apply([{ action: "drag", from, to: { x: from.x + 30, y: from.y + 20 } }]);
    assert.equal(dragged.state.selected?.tag, "h2");
    assert.equal(dragged.state.selected?.bounds.x, heading.x + 30);
    assert.equal(await backend.inspect((page) => page.locator("#card").evaluate((node) => node.getBoundingClientRect().x)), 765);
  } finally { await backend.close(); }
});

test("Dream edits existing inputs, supports Unicode/paste/editing keys, and suppresses app activation", async () => {
  const backend = new ReadableDream();
  try {
    await backend.open(url);
    await backend.apply([{ action: "select", x: 120, y: 425 }]);
    assert.equal(await backend.inspect((page) => page.evaluate(() => (window as unknown as { appClicks: number }).appClicks)), 0);
    await backend.apply([{ action: "scroll", x: 600, y: 650, deltaY: 400 }]);
    const rect = await backend.inspect((page) => page.locator("#field").boundingBox());
    assert.ok(rect);
    await backend.apply([{ action: "edit", x: rect.x + 20, y: rect.y + 20 }, { action: "text", text: "Ada 🌸" }, { action: "key", key: "Backspace" }, { action: "text", text: "界" }, { action: "key", key: "Enter" }]);
    assert.equal(await backend.inspect((page) => page.locator("#field").inputValue()), "Ada 界");
    await backend.apply([{ action: "edit", x: rect.x + 20, y: rect.y + 20 }, { action: "key", key: "Control+a" }, { action: "key", key: "Control+c" }, { action: "text", text: "Replacement" }, { action: "key", key: "Control+a" }, { action: "key", key: "Control+v" }, { action: "commit" }]);
    assert.equal(await backend.inspect((page) => page.locator("#field").inputValue()), "Ada 界");
    assert.equal(await backend.inspect((page) => page.evaluate(() => (window as unknown as { appKeys: number }).appKeys)), 0);
  } finally { await backend.close(); }
});

test("Dream supports native email input editing and literal HTML-looking text, without executing it", async () => {
  const backend = new ReadableDream();
  try {
    await backend.open(url);
    await backend.inspect((page) => page.locator("#field").evaluate((node) => {
      (node as HTMLInputElement).type = "email";
      (node as HTMLInputElement).value = "old@example.com";
      (node as HTMLElement).style.top = "690px";
    }));
    await backend.apply([{ action: "edit", x: 120, y: 715 }, { action: "text", text: "new@example.com" }, { action: "commit" }]);
    assert.equal(await backend.inspect((page) => page.locator("#field").inputValue()), "new@example.com");
    await backend.apply([{ action: "edit", x: 120, y: 425 }, { action: "text", text: "<script>not executable</script>" }, { action: "commit" }]);
    assert.equal(await backend.inspect((page) => page.locator("#cta").textContent()), "<script>not executable</script>");
    assert.equal(await backend.inspect((page) => page.locator("#cta script").count()), 0);
  } finally { await backend.close(); }
});

test("Dream is isolated from inspection, rejects unsafe URLs, and cancellation permits a fresh restart", async () => {
  const dream = new DreamChromiumBackend();
  const browser = new ChromiumBackend();
  try {
    assert.throws(() => dream.open("file:///etc/passwd"), /http/);
    await assert.rejects(dream.open(), /Start with/);
    await dream.open(url);
    await dream.apply([{ action: "edit", x: 120, y: 320 }, { action: "text", text: "Only in the dream" }, { action: "commit" }]);
    assert.doesNotMatch((await browser.run({ action: "navigate", url }))!.accessibility, /Only in the dream/);
    const controller = new AbortController();
    const pending = dream.open(url + "/slow", controller.signal);
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal((await dream.open(url)).state.changes.length, 0);
  } finally { await Promise.all([dream.close(), browser.close()]); }
});

async function chooseContext(backend: ReadableDream, label: string): Promise<DreamFrame> {
  const row = await backend.inspect((page) => page.getByRole("menuitem", { name: label, exact: true }).boundingBox());
  assert.ok(row);
  return backend.apply([{ action: "select", x: row.x + row.width / 2, y: row.y + row.height / 2 }]);
}

test("Delete element removes a group, preserves clipboard and subtree identity, and undo/redo restores exact order", async () => {
  const backend = new ReadableDream();
  try {
    await backend.open(url);
    await backend.inspect((page) => page.evaluate(() => {
      const card = document.querySelector<HTMLElement>("#card")!;
      const input = document.createElement("input"); input.id = "retained-field"; input.value = "Unsaved field value"; card.append(input);
      const probe = window as unknown as { retainedCard: HTMLElement; restoredEvents: number };
      probe.retainedCard = card; probe.restoredEvents = 0;
      card.addEventListener("restore-probe", () => probe.restoredEvents++);
    }));
    const before = await backend.inspect((page) => page.locator("body").innerHTML());
    await backend.apply([{ action: "select", x: 830, y: 210 }, { action: "parent" }, { action: "copy" }, { action: "context" }]);
    const removed = await chooseContext(backend, "Delete element");
    assert.equal(await backend.inspect((page) => page.locator("#card").count()), 0);
    assert.equal(removed.state.selected, undefined); assert.equal(removed.state.menu, undefined);
    assert.equal(removed.state.canPaste, true);
    assert.equal(removed.state.changes.at(-1)?.kind, "delete");
    assert.equal(removed.state.changes.at(-1)?.selector, "#card");
    await backend.apply([{ action: "context" }]);
    const disabled = await chooseContext(backend, "Delete element");
    assert.equal(disabled.state.menu?.items.find((item) => item.command === "delete")?.enabled, false);
    assert.equal(disabled.state.changes.length, 1);
    await chooseContext(backend, "Undo");
    assert.equal(await backend.inspect((page) => page.locator("body").innerHTML()), before);
    assert.equal(await backend.inspect((page) => page.locator("#retained-field").inputValue()), "Unsaved field value");
    assert.equal(await backend.inspect((page) => page.evaluate(() => {
      const probe = window as unknown as { retainedCard: HTMLElement; restoredEvents: number };
      const card = document.querySelector("#card")!;
      card.dispatchEvent(new Event("restore-probe"));
      return card === probe.retainedCard && probe.restoredEvents === 1;
    })), true);
    const redone = await backend.apply([{ action: "redo" }]);
    assert.equal(redone.state.selected, undefined);
    assert.equal(await backend.inspect((page) => page.locator("#card").count()), 0);
    await backend.apply([{ action: "paste" }]);
    assert.equal(await backend.inspect((page) => page.locator("[data-pi-dream-clone] h2").innerText()), "Small changes. Big impact.");
    const goal = await backend.apply([{ action: "finish" }]);
    assert.equal(await backend.inspect((page) => page.locator("[data-pi-dream-overlay],[data-pi-dream-menu]").count()), 0);
    const cwd = await mkdtemp(join(tmpdir(), "dream-delete-"));
    try {
      const artifact = await saveDream(cwd, { ...goal, canceled: false });
      assert.equal(JSON.parse(await readFile(artifact.manifestPath, "utf8")).changes[0].kind, "delete");
    } finally { await rm(cwd, { recursive: true, force: true }); }
  } finally { await backend.close(); }
});

test("undoing deletion of a moved element preserves ghost-wrapper hit-testing", async () => {
  const backend = new ReadableDream();
  try {
    await backend.open(url + "/ghost");
    const original = { x: 114, y: 214 };
    await backend.apply([{ action: "drag", from: original, to: { x: 874, y: 164 } }, { action: "delete" }]);
    await backend.apply([{ action: "select", ...original }]); // prune detached moved identities
    await backend.apply([{ action: "undo" }]);
    assert.equal((await backend.apply([{ action: "select", ...original }])).state.selected?.selector, "#underlay");
    await backend.apply([{ action: "undo" }]);
    assert.equal((await backend.apply([{ action: "select", ...original }])).state.selected?.selector, "#avatar");
  } finally { await backend.close(); }
});

test("Delete/Backspace remove only selected elements, preserve text editing, and menu keyboard deletion works", async () => {
  const backend = new ReadableDream();
  try {
    await backend.open(url);
    assert.equal((await backend.apply([{ action: "key", key: "Backspace" }])).state.changes.length, 0);
    await backend.apply([{ action: "edit", x: 160, y: 190 }, { action: "key", key: "Backspace" }]);
    assert.equal(await backend.inspect((page) => page.locator("#headline").count()), 1);
    assert.equal((await backend.inspect((page) => page.locator("#headline").innerText())).trim(), "");
    await backend.apply([{ action: "text", text: "Keep this heading" }, { action: "commit" }, { action: "key", key: "Delete" }]);
    assert.equal(await backend.inspect((page) => page.locator("#headline").count()), 0);
    await backend.apply([{ action: "undo" }]);
    assert.equal(await backend.inspect((page) => page.locator("#headline").innerText()), "Keep this heading");
    await backend.apply([{ action: "key", key: "Backspace" }, { action: "undo" }, { action: "context" }, { action: "key", key: "Delete" }]);
    assert.equal(await backend.inspect((page) => page.locator("#headline").count()), 0);
    await backend.apply([{ action: "undo" }, { action: "undo" }]);
    assert.match(await backend.inspect((page) => page.locator("#headline").innerText()), /A better first/);
    await backend.inspect((page) => page.evaluate(() => window.scrollTo(0, 420)));
    await backend.apply([{ action: "edit", x: 120, y: 400 }, { action: "key", key: "Delete" }]);
    assert.equal(await backend.inspect((page) => page.locator("#field").inputValue()), "");
    await backend.apply([{ action: "text", text: "Preserve my input" }, { action: "commit" }, { action: "key", key: "Backspace" }, { action: "undo" }]);
    assert.equal(await backend.inspect((page) => page.locator("#field").inputValue()), "Preserve my input");
    assert.equal(await backend.inspect((page) => page.evaluate(() => (window as unknown as { appKeys: number }).appKeys)), 0);
  } finally { await backend.close(); }
});

test("deletion allows layout reflow and restores sibling order across nested and duplicated deletions", async () => {
  const backend = new ReadableDream();
  try {
    await backend.open(url);
    await backend.inspect((page) => page.evaluate(() => {
      const row = document.createElement("div"); row.id = "flow-row";
      row.style.cssText = "position:absolute;left:80px;top:690px;display:flex;gap:20px";
      row.innerHTML = '<span id="flow-a" style="width:80px">Alpha</span> <span id="flow-b" style="width:80px">Beta</span> <span id="flow-c" style="width:80px">Gamma</span>';
      document.body.append(row);
    }));
    const before = await backend.inspect((page) => page.locator("#flow-c").boundingBox()); assert.ok(before);
    await backend.apply([{ action: "select", x: 200, y: 695 }, { action: "delete" }]);
    const after = await backend.inspect((page) => page.locator("#flow-c").boundingBox()); assert.ok(after);
    assert.equal(after.x, before.x - 100);
    await backend.apply([{ action: "select", x: 100, y: 695 }, { action: "parent" }, { action: "delete" }, { action: "undo" }, { action: "undo" }]);
    assert.equal(await backend.inspect((page) => page.locator("#flow-row").innerHTML()), '<span id="flow-a" style="width:80px">Alpha</span> <span id="flow-b" style="width:80px">Beta</span> <span id="flow-c" style="width:80px">Gamma</span>');
    await backend.apply([{ action: "copy" }, { action: "paste" }, { action: "delete" }]);
    assert.equal(await backend.inspect((page) => page.locator("[data-pi-dream-clone]").count()), 0);
    await backend.apply([{ action: "undo" }, { action: "undo" }, { action: "redo" }, { action: "redo" }]);
    assert.equal(await backend.inspect((page) => page.locator("[data-pi-dream-clone]").count()), 0);
  } finally { await backend.close(); }
});

test("context menu copies, pastes at the pointer, clamps to the viewport, and supports undo/redo", async () => {
  const backend = new ReadableDream();
  try {
    await backend.open(url);
    const opened = await backend.apply([{ action: "context", x: 130, y: 425 }]);
    assert.equal(opened.state.selected?.selector, "#cta");
    assert.equal(opened.state.menu?.items.find((item) => item.command === "paste")?.enabled, false);
    assert.ok((await chooseContext(backend, "Paste here")).state.menu); // disabled item is inert
    const copied = await chooseContext(backend, "Copy");
    assert.equal(copied.state.menu, undefined);
    assert.equal(copied.state.canPaste, true);
    assert.equal(copied.state.changes.length, 0);
    const edge = await backend.apply([{ action: "context", x: 1279, y: 799 }]);
    const menu = edge.state.menu!.bounds;
    assert.ok(menu.x >= 8 && menu.y >= 8 && menu.x + menu.width <= 1272 && menu.y + menu.height <= 792);
    await backend.apply([{ action: "dismiss-menu" }, { action: "context", x: 580, y: 460 }]);
    const pasted = await chooseContext(backend, "Paste here");
    assert.equal(pasted.state.selected?.bounds.x, 580);
    assert.equal(pasted.state.selected?.bounds.y, 460);
    assert.equal(pasted.state.changes.length, 1);
    await backend.apply([{ action: "context" }]);
    await chooseContext(backend, "Undo");
    assert.equal(await backend.inspect((page) => page.locator("[data-pi-dream-clone]").count()), 0);
    await backend.apply([{ action: "context" }]);
    await chooseContext(backend, "Redo");
    assert.equal(await backend.inspect((page) => page.locator("[data-pi-dream-clone]").count()), 1);
    assert.equal(await backend.inspect((page) => page.evaluate(() => (window as unknown as { appClicks: number }).appClicks)), 0);
  } finally { await backend.close(); }
});

test("context menu duplicates a selected group, selects parents, and disables inappropriate actions", async () => {
  const backend = new ReadableDream();
  try {
    await backend.open(url);
    await backend.apply([{ action: "context", x: 830, y: 210 }]);
    assert.equal((await chooseContext(backend, "Select parent")).state.selected?.selector, "#card");
    const group = await backend.apply([{ action: "context" }]);
    assert.equal(group.state.selected?.selector, "#card");
    assert.equal(group.state.menu?.items.find((item) => item.command === "edit")?.enabled, false);
    assert.ok((await chooseContext(backend, "Edit text")).state.menu);
    const duplicate = await chooseContext(backend, "Duplicate");
    assert.equal(duplicate.state.selected?.bounds.width, 350);
    assert.equal(duplicate.state.menu, undefined);
    assert.equal(await backend.inspect((page) => page.locator("[data-pi-dream-clone] h2").innerText()), "Small changes. Big impact.");
  } finally { await backend.close(); }
});

test("context keyboard navigation skips disabled items, edits text, and outside clicks dismiss without activating the page", async () => {
  const backend = new ReadableDream();
  try {
    await backend.open(url);
    await backend.apply([{ action: "select", x: 160, y: 190 }, { action: "key", key: "Shift+F10" }]);
    const next = await backend.apply([{ action: "key", key: "ArrowDown" }]);
    assert.equal(next.state.menu!.items[next.state.menu!.focused]?.command, "duplicate");
    const editing = await backend.apply([{ action: "key", key: "ArrowDown" }, { action: "key", key: "Enter" }]);
    assert.equal(editing.state.editing, true); assert.equal(editing.state.menu, undefined);
    await backend.apply([{ action: "text", text: "A context-edited headline" }, { action: "key", key: "Enter" }, { action: "context" }]);
    const dismissed = await backend.apply([{ action: "select", x: 120, y: 425 }]);
    assert.equal(dismissed.state.menu, undefined);
    assert.equal(dismissed.state.selected?.selector, "#headline"); // dismissal doesn't select/activate the button beneath
    await backend.apply([{ action: "context" }, { action: "key", key: "Escape" }]);
    assert.equal(await backend.inspect((page) => page.locator("[data-pi-dream-menu]").count()), 0);
    await backend.apply([{ action: "context" }, { action: "finish" }]);
    assert.equal(await backend.inspect((page) => page.locator("[data-pi-dream-menu],[data-pi-dream-overlay]").count()), 0);
    assert.equal(await backend.inspect((page) => page.evaluate(() => (window as unknown as { appClicks: number }).appClicks)), 0);
  } finally { await backend.close(); }
});

test("Esc dismisses a pending context menu without finishing Dream; right-click opens it only once", async () => {
  const actions: DreamAction[] = [];
  const h = fakeHarness(async (batch) => { actions.push(...batch); return initial; });
  h.view.render(120);
  h.view.handleMouse({ ...mouse(10, 10, "press"), button: "right" });
  h.view.handleMouse({ ...mouse(10, 10, "release"), button: "right" });
  h.view.handleMouse({ ...mouse(10, 10, "click"), button: "right" });
  h.view.handleInput("\u001b");
  await h.view.whenIdle();
  assert.equal(actions.filter((action) => action.action === "context").length, 1);
  assert.equal(actions.at(-1)?.action, "dismiss-menu");
  assert.equal(h.result(), undefined);
  h.view.dispose();
});

test("real fullscreen right-click and menu clicks copy/paste through Pi into Chromium", async () => {
  const backend = new ReadableDream(); const terminal = new VirtualTerminal(); const tui = new TuiAltScreen(terminal);
  let view: DreamView | undefined;
  const results: DreamResult[] = [];
  let latest = initial;
  try {
    latest = await backend.open(url);
    view = new DreamView(latest, {
      open: (...args) => backend.open(...args), close: () => backend.close(),
      apply: async (...args) => { latest = await backend.apply(...args); return latest; },
    }, tui, theme, new AbortController(), (value) => { results.push(value); });
    tui.start();
    const overlay = tui.showOverlay(view, { width: "100%", maxHeight: "100%", margin: 1, anchor: "top-left" });
    tui.renderNow(true);
    const bounds = overlay.getBounds()!;
    const surface = new InspectionSurface(latest.snapshot, () => terminal.rows - 7, 3);
    surface.render(bounds.width);
    const placement = surface.placement!;
    const cell = (x: number, y: number) => ({
      x: bounds.col + Math.floor(x / 1280 * placement.widthPx / placement.cell.widthPx),
      y: bounds.row + placement.top + Math.floor(y / 800 * placement.heightPx / placement.cell.heightPx),
    });
    const rightClick = async (x: number, y: number) => { const at = cell(x, y); terminal.rightClick(at.x, at.y); await view!.whenIdle(); tui.renderNow(true); };
    const clickItem = async (label: string) => {
      const row = await backend.inspect((page) => page.getByRole("menuitem", { name: label, exact: true }).boundingBox()); assert.ok(row);
      const at = cell(row.x + row.width / 2, row.y + row.height / 2);
      terminal.click(at.x, at.y); await view!.whenIdle(); tui.renderNow(true);
    };
    await rightClick(170, 425);
    assert.ok(latest.state.menu);
    assert.equal(latest.state.selected?.selector, "#cta");
    await clickItem("Copy"); assert.equal(latest.state.canPaste, true);
    await rightClick(580, 460); const origin = cell(580, 460);
    await clickItem("Paste here");
    assert.equal(await backend.inspect((page) => page.locator("[data-pi-dream-clone]").count()), 1);
    assert.equal(latest.state.menu, undefined);
    assert.equal(latest.state.selected?.bounds.x, mapImageClick(placement, origin.x - bounds.col, origin.y - bounds.row)!.x);
    await rightClick(620, 480); await clickItem("Delete element");
    assert.equal(await backend.inspect((page) => page.locator("[data-pi-dream-clone]").count()), 0);
    assert.equal(latest.state.changes.at(-1)?.kind, "delete");
    terminal.onInput?.("\u001b[122;5u"); // Kitty Ctrl+Z
    await view.whenIdle(); tui.renderNow(true);
    assert.equal(await backend.inspect((page) => page.locator("[data-pi-dream-clone]").count()), 1);
    await rightClick(850, 200);
    terminal.onInput?.("\u001b"); await view.whenIdle(); tui.renderNow(true);
    assert.equal(latest.state.menu, undefined); assert.equal(results.length, 0);
    assert.equal(tui.hasActiveSelection(), false);
    terminal.onInput?.("\u0011"); await view.whenIdle();
    assert.equal(results[0]?.canceled, false);
    assert.equal(await backend.inspect((page) => page.locator("[data-pi-dream-menu]").count()), 0);
    overlay.hide();
  } finally { view?.dispose(); tui.stop(); await backend.close(); }
});

test("Dream terminal view decodes double-click, completed drag, Cmd clipboard and bracketed paste", async () => {
  const actions: DreamAction[] = [];
  const h = fakeHarness(async (batch) => { actions.push(...batch); return initial; });
  h.view.render(120);
  h.view.handleMouse({ ...mouse(10, 10), clickCount: 2 });
  await h.view.whenIdle();
  h.view.render(120);
  h.view.handleMouse(mouse(10, 10, "press"));
  h.view.handleMouse(mouse(20, 12, "drag"));
  h.view.handleMouse(mouse(20, 12, "release"));
  await h.view.whenIdle();
  h.view.handleInput("\u001b[99;9u"); // Kitty super+c
  h.view.handleInput("\u001b[118;9u");
  h.view.handleInput("\u001b[200~Unicode 界\nsecond line\u001b[201~");
  await h.view.whenIdle();
  assert.equal(actions[0]?.action, "edit");
  assert.equal(actions[1]?.action, "drag");
  assert.deepEqual(actions.slice(2), [{ action: "key", key: "Meta+c" }, { action: "key", key: "Meta+v" }, { action: "text", text: "Unicode 界\nsecond line" }]);
  h.view.dispose();
});

test("Done flushes pending typing before removing selection and returning a goal", async () => {
  const batches: DreamAction[][] = [];
  let release!: () => void;
  const h = fakeHarness(async (batch) => {
    batches.push(batch);
    if (batches.length === 1) await new Promise<void>((resolve) => { release = resolve; });
    return { ...initial, snapshot: { ...snapshot, title: "Finished edits" } };
  });
  h.view.handleInput("first"); h.view.handleInput("second"); h.view.handleInput("\u0011");
  assert.equal(h.result(), undefined);
  release(); await h.view.whenIdle();
  assert.deepEqual(batches, [[{ action: "text", text: "first" }], [{ action: "text", text: "second" }, { action: "finish" }]]);
  assert.equal(h.result()?.canceled, false);
  assert.equal(h.result()?.snapshot.title, "Finished edits");
  assert.equal(h.controller.signal.aborted, false);
});

test("double-clicking a container is a logged notice, not an input lock; editing and deletion still work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dream-notice-"));
  const activity = new DreamActivity();
  const backend = new ReadableDream({}, activity);
  const terminal = new VirtualTerminal();
  let view: DreamView | undefined;
  let latest = initial;
  try {
    await activity.start(directory, url);
    latest = await backend.open(url);
    view = new DreamView(latest, { open: (...args) => backend.open(...args), close: () => backend.close(),
      apply: async (...args) => { latest = await backend.apply(...args); return latest; } },
      { terminal, requestRender: () => {} }, theme, new AbortController(), () => {}, activity);
    view.render(120);
    // Map CSS to terminal cells using the same renderer placement as real input.
    const surface = new InspectionSurface(latest.snapshot, () => terminal.rows - 7, 3);
    surface.render(120); const placement = surface.placement!;
    const click = async (x: number, y: number, clickCount = 1) => {
      view!.handleMouse({ ...mouse(Math.floor(x / 1280 * placement.widthPx / placement.cell.widthPx),
        placement.top + Math.floor(y / 800 * placement.heightPx / placement.cell.heightPx)), clickCount });
      await view!.whenIdle(); view!.render(120);
    };
    await click(780, 180, 2); // card padding: a container, not its text child
    assert.equal(latest.state.selected?.selector, "#card");
    assert.equal(latest.state.editing, false);
    assert.match(view.render(120)[2]!, /not plain text/);
    assert.ok(activity.snapshot().events.some((entry) => entry.event === "editor.notice"));
    await click(170, 425); // no refresh needed
    assert.equal(latest.state.selected?.selector, "#cta");
    await click(160, 190, 2);
    view.handleInput("PRIVATE-TYPED-CONTENT"); view.handleInput("\r"); await view.whenIdle();
    assert.equal(await backend.inspect((page) => page.locator("#headline").innerText()), "PRIVATE-TYPED-CONTENT");
    view.render(120);
    const toolbar = view.render(120)[0]!;
    view.handleMouse(mouse(toolbar.indexOf("[Log]") + 2, 0));
    assert.match(view.render(120).join("\n"), /Recent actions\/errors/);
    view.handleInput("DO-NOT-TYPE-WHILE-READING-LOG");
    view.handleInput("\u001b");
    view.handleInput("\u007f"); await view.whenIdle();
    assert.equal(await backend.inspect((page) => page.locator("#headline").count()), 0);
    await activity.flush();
    const persisted = await readFile(activity.path!, "utf8");
    assert.doesNotMatch(persisted, /PRIVATE-TYPED-CONTENT|DO-NOT-TYPE-WHILE-READING-LOG/);
    assert.match(persisted, /editor.notice/);
  } finally { view?.dispose(); await backend.close(); await activity.flush(); await rm(directory, { recursive: true, force: true }); }
});

test("a real backend failure refreshes stale state, remains clickable, and preserves a readable error log", async () => {
  const activity = new DreamActivity();
  let calls = 0;
  const terminal = new VirtualTerminal();
  const controller = new AbortController();
  let result: DreamResult | undefined;
  const view = new DreamView(initial, { open: async () => initial, close: async () => {},
    apply: async (batch) => { calls++; if (calls === 1) throw new Error("Simulated failure\u001b[31m\nprivate stack detail"); return { ...initial, state: { ...initial.state, message: batch[0]!.action } }; } },
    { terminal, requestRender: () => {} }, theme, controller, (value) => { result = value; }, activity);
  try {
    view.render(120); view.handleMouse(mouse(10, 10)); await view.whenIdle();
    assert.equal(calls, 2); // original action + automatic real-state recapture
    assert.match(view.render(120)[2]!, /Simulated failure/);
    assert.ok(activity.snapshot().events.some((entry) => entry.event === "view.error"));
    assert.doesNotMatch(JSON.stringify(activity.snapshot()), /private stack detail|\\u001b/);
    view.handleMouse(mouse(12, 12)); await view.whenIdle();
    assert.equal(calls, 3); assert.doesNotMatch(view.render(120)[2]!, /Simulated failure/);
    view.handleInput("\u0011"); await view.whenIdle(); assert.equal(result?.canceled, false);
  } finally { view.dispose(); }
});

test("Dream error recovery, abort cleanup, and small-terminal sizing", async () => {
  let calls = 0;
  const h = fakeHarness(async () => { if (++calls === 1) throw new Error("Changed page\u001b[31m"); return initial; });
  h.view.render(120); h.view.handleMouse(mouse(10, 10)); await h.view.whenIdle();
  assert.match(h.view.render(120)[2]!, /Changed page/);
  h.view.handleInput("\u0012"); await h.view.whenIdle();
  assert.doesNotMatch(h.view.render(120)[2]!, /Changed page/);
  for (const rows of [2, 5, 10, 40]) {
    h.terminal.rows = rows;
    for (const width of [0, 1, 10, 120]) for (const line of h.view.render(width)) assert.ok(visibleWidth(line) <= width);
    assert.ok(h.view.render(120).length <= Math.max(0, rows - 2));
  }
  h.controller.abort(); assert.equal(h.result()?.canceled, true);
});

test("Opaque modal hides existing Kitty graphics in Pi's actual viewport tree, then restores the transcript", () => {
  const terminal = new VirtualTerminal(); const tui = new TuiAltScreen(terminal);
  const document = new Container(); document.addChild(new Image(snapshot.png.toString("base64"), "image/png", { fallbackColor: (text) => text }));
  tui.addChild(document);
  tui.setLayoutRoot(new VStack([{ component: new ScrollView(document), grow: 1 }]));
  const h = fakeHarness();
  let modal: OpaqueModal | undefined;
  try {
    tui.start(); tui.renderNow(true);
    assert.equal(tui.getScreenLines().filter(isImageLine).length, 1);
    modal = new OpaqueModal(tui, h.view);
    const overlay = tui.showOverlay(modal, { width: "100%", maxHeight: "100%", margin: 1, anchor: "top-left" });
    tui.renderNow(true);
    assert.equal(tui.getScreenLines().filter(isImageLine).length, 1); // Dream only, never both images
    assert.match(tui.getScreenLines().join("\n"), /Dream/);
    overlay.hide(); modal.dispose(); tui.renderNow(true);
    assert.equal(tui.getScreenLines().filter(isImageLine).length, 1);
    assert.equal(document.children.length, 1);
    assert.equal(tui.hasActiveSelection(), false);
  } finally { modal?.dispose(); tui.stop(); }
});

test("real Pi mouse capture, double-click, keyboard and drag produce actual Chromium mockup edits", async () => {
  const activity = new DreamActivity();
  const backend = new ReadableDream({}, activity); const terminal = new VirtualTerminal(); const tui = new TuiAltScreen(terminal);
  let view: DreamView | undefined;
  try {
    const initialFrame = await backend.open(url);
    view = new DreamView(initialFrame, backend, tui, theme, new AbortController(), () => {}, activity);
    tui.start(); const overlay = tui.showOverlay(view, { width: "100%", maxHeight: "100%", margin: 1, anchor: "top-left" });
    tui.renderNow(true);
    // With 10x20px cells and 33 image rows: image is 105 columns, browser scales to 1050x660.
    const bounds = overlay.getBounds()!;
    const surface = new InspectionSurface(initialFrame.snapshot, () => terminal.rows - 7, 3);
    surface.render(bounds.width); const placement = surface.placement!;
    const cardX = bounds.col + Math.floor(780 / 1280 * placement.widthPx / placement.cell.widthPx);
    const cardY = bounds.row + placement.top + Math.floor(180 / 800 * placement.heightPx / placement.cell.heightPx);
    terminal.click(cardX, cardY); terminal.click(cardX, cardY); await view.whenIdle(); tui.renderNow(true);
    assert.match(tui.getScreenLines().join("\n"), /not plain text/);
    assert.equal((await backend.apply([{ action: "refresh" }])).state.selected?.selector, "#card");
    const logX = bounds.col + view.render(bounds.width)[0]!.indexOf("[Log]") + 2;
    terminal.click(logX, bounds.row); tui.renderNow(true);
    assert.match(tui.getScreenLines().join("\n"), /Recent actions\/errors/);
    assert.equal(tui.getScreenLines().some(isImageLine), false);
    terminal.onInput?.("\u001b"); tui.renderNow(true);
    assert.equal(tui.getScreenLines().some(isImageLine), true);
    const x = bounds.col + 11, y = bounds.row + 3 + 7;
    terminal.click(x, y); terminal.click(x, y); // Native clickCount, not a synthetic editor method
    terminal.onInput?.("Native Dream headline"); terminal.onInput?.("\r");
    await view.whenIdle();
    assert.equal(await backend.inspect((page) => page.locator("#headline").innerText()), "Native Dream headline");
    tui.renderNow(true);
    terminal.onInput?.("\u001b[99;9u"); terminal.onInput?.("\u001b[118;9u");
    await view.whenIdle(); tui.renderNow(true);
    assert.equal(await backend.inspect((page) => page.locator("[data-pi-dream-clone]").count()), 1);
    const rx = x + 2, ry = y + 1;
    terminal.onInput?.(`\u001b[<0;${rx + 1};${ry + 1}M`);
    terminal.onInput?.(`\u001b[<32;${rx + 8};${ry + 3}M`);
    terminal.onInput?.(`\u001b[<0;${rx + 8};${ry + 3}m`);
    await view.whenIdle();
    assert.notEqual(await backend.inspect((page) => page.locator("[data-pi-dream-clone]").evaluate((node) => getComputedStyle(node).translate)), "none");
    assert.equal(tui.hasActiveSelection(), false);
    overlay.hide();
  } finally { view?.dispose(); tui.stop(); await backend.close(); }
});

test("Dream manager mode guards, overlap rejection, and cancellation do not publish a goal", async () => {
  let launches = 0;
  const dreams = new Dreams({ open: async () => { launches++; return initial; }, apply: async () => initial, close: async () => {} });
  await assert.rejects(dreams.open({ mode: "rpc" } as ExtensionContext, url), /interactive/);
  const unsupported = { mode: "tui", ui: { custom: (factory: Function) => factory({ mode: "regular" }, theme, undefined, () => {}) } } as unknown as ExtensionContext;
  await assert.rejects(dreams.open(unsupported, url), /fullscreen/);
  assert.equal(launches, 0);
  let ready!: () => void;
  const mounted = new Promise<void>((resolve) => { ready = resolve; });
  const ctx = { mode: "tui", ui: { custom: (factory: Function) => new Promise((resolve, reject) => {
    Promise.resolve(factory({ mode: "fullscreen", terminal: new VirtualTerminal(), requestRender: () => {} }, theme, undefined, resolve)).then(ready, reject);
  }) } } as unknown as ExtensionContext;
  const controller = new AbortController();
  const pending = dreams.open(ctx, url, controller.signal);
  const rejection = assert.rejects(pending, { name: "AbortError" });
  await mounted; await assert.rejects(dreams.open(ctx, url), /already open/); controller.abort(); await rejection;
});

test("canceling after a decoder error retains the rolling log without publishing a goal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dream-cancel-log-"));
  const activity = new DreamActivity();
  const dreams = new Dreams({ open: async () => initial, apply: async () => initial, close: async () => {} }, activity);
  const ctx = { cwd: directory, mode: "tui", ui: { custom: (factory: Function) => new Promise((resolve, reject) => {
    Promise.resolve(factory({ mode: "fullscreen", terminal: new VirtualTerminal(), requestRender: () => {} }, theme, undefined, resolve))
      .then(async (view: OpaqueModal) => {
        await waitDreamReady(view);
        view.handleInput(`\u001b[200~${"x".repeat(100001)}\u001b[201~`);
        view.handleInput("\u0011");
      }, reject);
  }) } } as unknown as ExtensionContext;
  try {
    const result = await dreams.open(ctx, url);
    assert.equal(result.canceled, true);
    await assert.rejects(saveDream(directory, result), /canceled/);
    const persisted = JSON.parse(await readFile(activity.path!, "utf8"));
    assert.ok(persisted.events.some((entry: { event: string }) => entry.event === "view.error"));
    assert.equal(persisted.events.at(-1).event, "session.cancel");
  } finally { await activity.flush(); await rm(directory, { recursive: true, force: true }); }
});

test("Pi's real TypeScript loader runs /dream and publishes a model image plus a visible goal renderer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-dream-loader-test-"));
  const project = fileURLToPath(new URL("../", import.meta.url));
  const loaded = await discoverAndLoadExtensions([join(project, "src/index.ts")], directory, join(directory, "agent"));
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions.find((item) => item.commands.has("dream"))!;
  assert.ok(extension);
  const messages: Parameters<ExtensionRuntime["sendMessage"]>[0][] = [];
  const notifications: string[] = [];
  loaded.runtime.sendMessage = (message, options) => { assert.equal(options?.triggerTurn, false); messages.push(message); };
  const terminal = new VirtualTerminal(); const tui = new TuiAltScreen(terminal);
  try {
    tui.start();
    const ctx = {
      cwd: directory, mode: "tui", hasUI: true, waitForIdle: async () => {},
      ui: {
        notify: (text: string) => notifications.push(text),
        custom: (factory: Function) => new Promise((resolve, reject) => {
          let component: OpaqueModal | undefined;
          Promise.resolve(factory(tui, theme, undefined, (value: unknown) => { component?.dispose(); resolve(value); })).then((view: OpaqueModal) => {
            component = view;
            void waitDreamReady(component).then(() => component!.handleInput("\u0011")).catch(reject);
          }, reject);
        }),
      },
    } as unknown as ExtensionCommandContext;
    await extension.commands.get("dream")!.handler(url, ctx);
    assert.deepEqual(notifications, []);
    assert.equal(messages.length, 1);
    const message = messages[0]!;
    assert.equal(message.customType, "dream-result");
    assert.ok(Array.isArray(message.content));
    assert.equal(message.content[1]?.type, "image");
    const details = message.details as { screenshotPath: string; activityPath: string };
    assert.equal((await readFile(details.screenshotPath)).subarray(1, 4).toString(), "PNG");
    const activity = JSON.parse(await readFile(details.activityPath, "utf8"));
    assert.ok(activity.events.some((entry: { event: string }) => entry.event === "session.complete"));
    assert.equal((await readFile(DreamActivity.path(directory), "utf8")), await readFile(details.activityPath, "utf8"));
    await extension.commands.get("dream-log")!.handler("", ctx);
    assert.equal(messages[1]?.customType, "dream-activity");
    assert.match(String(messages[1]?.content), /session.complete/);
    const renderer = extension.messageRenderers.get("dream-result")!;
    const component = renderer({ ...message, role: "custom", timestamp: Date.now() }, { expanded: false, outputPad: 0 }, theme)!;
    assert.ok(component.render(120).some(isImageLine));
  } finally {
    for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" }, {} as never);
    tui.stop(); await rm(directory, { recursive: true, force: true });
  }
});

test("Dream saves a clean PNG and bounded edit manifest separately from application source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-dream-artifact-test-"));
  try {
    const result: DreamResult = { ...initial, canceled: false };
    const artifact = await saveDream(directory, result);
    assert.ok(artifact.screenshotPath.startsWith(join(directory, ".pi", "dreams")));
    assert.deepEqual(await readFile(artifact.screenshotPath), snapshot.png);
    const manifest = JSON.parse(await readFile(artifact.manifestPath, "utf8"));
    assert.equal(manifest.version, 1); assert.deepEqual(manifest.changes, []);
    assert.match(manifest.note, /not source changes or approval/);
    await assert.rejects(saveDream(directory, { ...result, canceled: true }), /canceled/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
