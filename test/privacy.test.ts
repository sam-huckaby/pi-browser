import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { discoverAndLoadExtensions, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getCapabilities, getCellDimensions, setCapabilities, setCellDimensions, TuiAltScreen } from "@earendil-works/pi-tui";
import type { Page } from "playwright";
import { ChromiumBackend, type BrowserSnapshot } from "../src/browser/backend.ts";
import { BrowserPrivacy, privateMessage } from "../src/browser/privacy.ts";
import { createBrowserTool, snapshotResult } from "../src/browser/tool.ts";
import { createInspectionTool } from "../src/browser/inspection-tool.ts";
import type { Inspections } from "../src/ui/inspection.ts";
import { InspectionView, type InspectionResult } from "../src/ui/inspection-view.ts";
import { DreamView } from "../src/ui/dream-view.ts";
import type { OpaqueModal } from "../src/ui/opaque-modal.ts";
import { DreamChromiumBackend } from "../src/dream/backend.ts";
import { DreamActivity } from "../src/dream/activity.ts";
import { saveDream } from "../src/dream/artifacts.ts";
import type { DreamResult } from "../src/dream/types.ts";
import { mouse, snapshot, theme, VirtualTerminal, waitDreamReady } from "./support.ts";

class ReadableBrowser extends ChromiumBackend {
  inspect<T>(fn: (page: Page) => Promise<T>): Promise<T> { return this.withPage(fn); }
}
class ReadableDream extends DreamChromiumBackend {
  inspect<T>(fn: (page: Page) => Promise<T>): Promise<T> { return this.withPage(fn); }
}
const password = "PäSS-test-42-🚀";
const privateText = "PRIVATE-NAME-NEVER-LOGGED";
let server: Server, url: string;
let caps: ReturnType<typeof getCapabilities>, cells: ReturnType<typeof getCellDimensions>;
before(async () => {
  server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    if (request.url === "/frame") {
      response.end(`<input type="password" aria-label="Frame password" value="frame-password-99">`); return;
    }
    response.end(`<!doctype html><title>Password privacy fixture</title><style>body{margin:0;background:#f1f5fb;font:24px sans-serif}h1{position:absolute;left:80px;top:70px}input{position:absolute;left:80px;width:340px;height:45px;font:24px sans-serif}#password{top:230px}#name{top:300px}#group{position:absolute;left:500px;top:230px}#group input{position:static}button{position:absolute;top:400px;left:80px}iframe{position:absolute;left:500px;top:400px}#echo{position:absolute;top:490px;left:80px}</style>
      <h1 id="headline">Public heading</h1><input id="password" type="password" aria-label="Password" autocomplete="current-password" value="${password}"><input id="name" aria-label="Name" value="Public name">
      <section id="group"><input type="password" aria-label="Group password" value="group-password-88"></section>
      <button onclick="document.querySelector('#password').type='text'">Show password</button>
      <p id="echo">Ready</p><iframe src="/frame"></iframe><script>
      const host=document.createElement('div');host.id='shadow-host';document.body.append(host);host.attachShadow({mode:'open'}).innerHTML='<input type="password" aria-label="Shadow password" value="shadow-password-77">';
      </script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
beforeEach(() => {
  caps = { ...getCapabilities() }; cells = { ...getCellDimensions() };
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false }); setCellDimensions({ widthPx: 10, heightPx: 20 });
});
afterEach(() => { setCapabilities(caps); setCellDimensions(cells); });
const forbidden = [password, "frame-password-99", "group-password-88", "shadow-password-77"];
const assertClean = (value: unknown) => { const text = JSON.stringify(value); for (const secret of forbidden) assert.equal(text.includes(secret), false, secret); };

test("password controls are omitted, tracked after Show password, masked in frames/shadow DOM, and values are not changed", async () => {
  const backend = new ReadableBrowser();
  try {
    const original = (await backend.run({ action: "navigate", url }))!;
    assertClean(snapshotResult(original)); assert.doesNotMatch(original.accessibility, /textbox "Password"/);
    assert.equal(await backend.inspect((page) => page.locator("#password").inputValue()), password);
    assert.equal(await backend.inspect((page) => page.locator("#password").getAttribute("aria-hidden")), null);
    assert.equal(await backend.inspect((page) => page.locator("#shadow-host input").getAttribute("data-pi-browser-password")), "");
    assert.equal(await backend.inspect((page) => page.frames()[1]!.locator("input").getAttribute("data-pi-browser-password")), "");
    const shown = (await backend.run({ action: "click", target: { role: "button", name: "Show password" } }))!;
    assertClean(snapshotResult(shown)); assert.doesNotMatch(shown.accessibility, /textbox "Password"/);
    const unmasked = await backend.inspect((page) => page.screenshot({ caret: "initial" }));
    assert.notDeepEqual(unmasked, shown.png);
    await backend.inspect((page) => page.evaluate((secret) => {
      document.title = `Title ${secret}`; history.replaceState({}, "", `?password=${encodeURIComponent(secret)}`);
      document.querySelector("#echo")!.textContent = secret;
    }, password));
    const echoed = (await backend.run({ action: "screenshot" }))!;
    assertClean(snapshotResult(echoed)); assert.match(echoed.title, /password redacted/);
    assert.equal(await backend.inspect((page) => page.locator("#echo").getAttribute("data-pi-browser-secret")), "");
  } finally { await backend.close(); }
});

test("private captures have no disk path or accessibility text; model actions are blocked, toggling off creates fresh safe output", async () => {
  const backend = new ReadableBrowser();
  try {
    const publicFrame = (await backend.run({ action: "navigate", url }))!;
    const files = await readdir(dirname(publicFrame.screenshotPath));
    const frame = (await backend.setPrivate(true))!;
    assert.equal(frame.private, true); assert.equal(frame.screenshotPath, ""); assert.equal(frame.accessibility, "");
    await backend.run({ action: "fill", target: { selector: "#name" }, text: privateText });
    assert.deepEqual(await readdir(dirname(publicFrame.screenshotPath)), files);
    const tool = createBrowserTool(backend);
    const result = await tool.execute("private", { action: "navigate", url: url + "/different" }, undefined, undefined, {} as never);
    assert.deepEqual(result.content, [{ type: "text", text: privateMessage }]); assert.deepEqual(result.details, { private: true });
    assert.equal(await backend.inspect(async (page) => page.url()), url + "/");
    const released = (await backend.setPrivate(false))!;
    assert.notEqual(released.private, true); assert.ok(released.screenshotPath);
    assert.match(released.accessibility, new RegExp(privateText)); assertClean(snapshotResult(released));
    assert.deepEqual(snapshotResult(frame).content, [{ type: "text", text: privateMessage }]); // Old frames cannot be released later.
  } finally { await backend.close(); }
});

test("private result boundaries never touch page pixels or metadata, including inspection results", async () => {
  const frame = { ...snapshot, private: true, title: privateText, url: privateText, accessibility: privateText };
  Object.defineProperty(frame, "png", { get() { throw new Error("Pixels must not be serialized"); } });
  assert.deepEqual(snapshotResult(frame).details, { private: true });
  const tool = createInspectionTool({ open: async () => ({ snapshot: frame, clicks: 100 }) } as unknown as Inspections);
  const result = await tool.execute("private-inspection", {}, undefined, undefined, {} as never);
  assert.equal(JSON.stringify(result).includes(privateText), false); assert.equal(result.content.length, 1);
});

test("enabling privacy during an in-flight capture tags it private and prevents disk output", async () => {
  class Racing extends ReadableBrowser {
    entered?: () => void; release?: Promise<void>;
    protected override async capture(page: Page, signal?: AbortSignal): Promise<BrowserSnapshot> {
      if (this.entered) { const entered = this.entered; this.entered = undefined; entered(); await this.release; }
      return super.capture(page, signal);
    }
  }
  const backend = new Racing();
  try {
    const initial = (await backend.run({ action: "navigate", url }))!;
    const before = await readdir(dirname(initial.screenshotPath));
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    backend.entered = entered; backend.release = new Promise<void>((resolve) => { release = resolve; });
    const pending = backend.run({ action: "screenshot" }); await started;
    const toggled = backend.setPrivate(true); release();
    assert.equal((await pending)?.private, true); await toggled;
    assert.deepEqual(await readdir(dirname(initial.screenshotPath)), before);
  } finally { await backend.close(); }
});

test("password values never enter Dream edits/clipboard; copying a group clears password controls", async () => {
  const backend = new ReadableDream();
  try {
    await backend.open(url);
    const denied = await backend.apply([{ action: "edit", x: 120, y: 250 }, { action: "text", text: "replacement" }, { action: "commit" }]);
    assert.equal(denied.state.changes.length, 0); assert.equal(denied.state.editing, false);
    assert.equal(await backend.inspect((page) => page.locator("#password").inputValue()), password);
    await backend.apply([{ action: "select", x: 530, y: 250 }, { action: "parent" }, { action: "copy" }, { action: "paste" }]);
    assert.equal(await backend.inspect((page) => page.locator("[data-pi-dream-clone] input").inputValue()), "");
    assertClean((await backend.apply([{ action: "finish" }])).state);
  } finally { await backend.close(); }
});

test("private edits retain local undo but omit text history after toggling off; private goals and logs are withheld", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-private-dream-"));
  const activity = new DreamActivity(); await activity.start(directory, url);
  const backend = new ReadableDream({}, activity);
  try {
    await backend.open(url); await activity.flush(); const events = activity.snapshot().events.length;
    await backend.setPrivate(true);
    await backend.apply([{ action: "edit", x: 120, y: 320 }, { action: "text", text: privateText }, { action: "commit" }]);
    const privateGoal = await backend.apply([{ action: "finish" }]);
    assert.equal(privateGoal.snapshot.private, true); assert.equal(activity.snapshot().events.length, events);
    await assert.rejects(saveDream(directory, { ...privateGoal, canceled: false }), /Private mode/);
    assert.deepEqual((await readdir(join(directory, ".pi", "dreams"))).filter((name) => name !== "activity.json"), []);
    await backend.open(); await backend.setPrivate(false);
    const current = await backend.apply([{ action: "refresh" }]);
    assert.equal(current.state.changes[0]?.private, true); assert.equal(JSON.stringify(current.state).includes(privateText), false);
    assert.equal(await backend.inspect((page) => page.locator("#name").inputValue()), privateText);
    await backend.apply([{ action: "undo" }]);
    assert.equal(await backend.inspect((page) => page.locator("#name").inputValue()), "Public name");
    await backend.apply([{ action: "redo" }, { action: "edit", x: 120, y: 320 }, { action: "text", text: "Released replacement" }, { action: "commit" }]);
    const finished = await backend.apply([{ action: "finish" }]);
    const artifact = await saveDream(directory, { ...finished, canceled: false, activity: activity.snapshot() });
    assert.equal((await readFile(artifact.manifestPath, "utf8")).includes(privateText), false);
    assert.equal((await readFile(artifact.activityPath!, "utf8")).includes(privateText), false);
  } finally { await backend.close(); await activity.flush(); await rm(directory, { recursive: true, force: true }); }
});

test("private mode and password filters survive the inspection-to-Dream ownership transfer", async () => {
  const source = new ReadableBrowser(), target = new ReadableDream();
  try {
    await source.run({ action: "navigate", url }); await source.setPrivate(true);
    const frame = await target.openFromInspection(source);
    assert.equal(frame.snapshot.private, true); assert.equal(target.privateMode, true); assert.equal(source.privateMode, false);
    assert.equal(frame.snapshot.screenshotPath, "");
    assert.equal(await target.inspect((page) => page.locator("#password").inputValue()), password);
    const released = (await target.setPrivate(false))!; assertClean(snapshotResult(released));
  } finally { await source.close(); await target.close(); }
});

test("native toolbar and keyboard privacy toggles work in inspection and Dream, including close during recapture", async () => {
  const terminal = new VirtualTerminal(), tui = new TuiAltScreen(terminal);
  const source = new ReadableBrowser();
  let view: InspectionView | undefined, result: InspectionResult | undefined;
  try {
    const initial = (await source.run({ action: "navigate", url }))!;
    view = new InspectionView(initial, source, tui, theme, new AbortController(), (value) => { result = value; });
    tui.start(); const overlay = tui.showOverlay(view, { width: "100%", margin: 1, anchor: "top-left" }); tui.renderNow(true);
    const bounds = overlay.getBounds()!;
    terminal.click(bounds.col + view.render(bounds.width)[0]!.indexOf("[Private:") + 2, bounds.row);
    await view.whenIdle(); assert.equal(source.privateMode, true); assert.match(view.render(120)[0]!, /Private: ON/);
    terminal.onInput?.("\u001b[112;6u"); await view.whenIdle(); assert.equal(source.privateMode, false);
    terminal.onInput?.("\u001b[112;6u"); terminal.onInput?.("\u001b"); await view.whenIdle();
    assert.equal(result?.snapshot.private, true); overlay.hide();
  } finally { view?.dispose(); tui.stop(); await source.close(); }
  const backend = new ReadableDream(); let dreamView: DreamView | undefined, goal: DreamResult | undefined;
  try {
    const frame = await backend.open(url);
    dreamView = new DreamView(frame, backend, { terminal: new VirtualTerminal(), requestRender: () => {} }, theme, new AbortController(), (value) => { goal = value; });
    dreamView.handleMouse(mouse(dreamView.render(120)[0]!.indexOf("[Private:") + 2, 0)); await dreamView.whenIdle();
    assert.equal(backend.privateMode, true); assert.match(dreamView.render(120)[0]!, /Private: ON/);
    dreamView.handleInput("\u001b"); await dreamView.whenIdle(); assert.equal(goal?.snapshot.private, true);
  } finally { dreamView?.dispose(); await backend.close(); }
});

test("real extension publishes neither a private goal nor private diagnostics; model-tool results remain constant", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-private-loader-"));
  const loaded = await discoverAndLoadExtensions([join(process.cwd(), "src/index.ts")], directory, join(directory, "agent"));
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions.find((item) => item.commands.has("dream"))!;
  const messages: { content?: unknown }[] = [], notifications: string[] = [];
  loaded.runtime.sendMessage = (message) => messages.push(message);
  const terminal = new VirtualTerminal(), tui = new TuiAltScreen(terminal);
  const ctx = { cwd: directory, mode: "tui", hasUI: true, waitForIdle: async () => {}, ui: {
    notify: (text: string) => notifications.push(text),
    custom: (factory: Function) => new Promise((resolve, reject) => {
      let component: OpaqueModal | undefined;
      Promise.resolve(factory(tui, theme, undefined, (value: unknown) => { component?.dispose(); resolve(value); })).then(async (view: OpaqueModal) => {
        component = view; await waitDreamReady(component);
        component.handleInput("\u001b[112;6u");
        for (let i = 0; i < 200; i++) {
          if (component.render(120)[0]?.includes("Private: ON") && !component.render(120)[2]?.includes("Switching") && !component.render(120)[2]?.includes("Updating")) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        component.handleInput("\u001b");
      }).catch(reject);
    }),
  } } as unknown as ExtensionCommandContext;
  try {
    tui.start(); await extension.commands.get("dream")!.handler(url, ctx);
    assert.equal(messages.length, 0); assert.match(notifications[0]!, /Private mode/);
    await extension.commands.get("dream-log")!.handler("", ctx);
    assert.deepEqual(messages[0]?.content, privateMessage);
    const entries = await readdir(join(directory, ".pi", "dreams")); assert.deepEqual(entries, ["activity.json"]);
  } finally {
    for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" }, ctx);
    tui.stop(); await rm(directory, { recursive: true, force: true });
  }
});

test("turning Private off waits for buffered input and recaptures before releasing output", async () => {
  let enabled = true, release!: () => void, result: InspectionResult | undefined;
  const privateFrame = { ...snapshot, private: true, screenshotPath: "", accessibility: "" };
  const view = new InspectionView(privateFrame, {
    get privateMode() { return enabled; },
    run: async () => { await new Promise<void>((resolve) => { release = resolve; }); return privateFrame; },
    setPrivate: async (value) => { enabled = value; return { ...snapshot, ...(value ? { private: true } : {}) }; },
    close: async () => {},
  }, { terminal: new VirtualTerminal(), requestRender: () => {} }, theme, new AbortController(), (value) => { result = value; });
  view.handleInput("buffered private input"); view.handleInput("\u001b[112;6u");
  assert.equal(enabled, true); assert.match(view.render(120)[2]!, /Switching privacy/);
  release(); await view.whenIdle(); assert.equal(enabled, false);
  view.handleInput("\u001b"); assert.equal(result?.snapshot.private, undefined);
});

test("private mode refuses video recording and literal filtering handles regex metacharacters safely", async () => {
  const backend = new ChromiumBackend({ recordVideo: { dir: "/tmp/not-started-private-video" } });
  await assert.rejects(backend.setPrivate(true), /video recording/); assert.equal(backend.privateMode, false); await backend.close();
  const filter = new BrowserPrivacy();
  assert.equal(filter.redact("ordinary text"), "ordinary text");
  const source = new ReadableBrowser();
  try {
    await source.run({ action: "navigate", url });
    await source.run({ action: "fill", target: { selector: "#password" }, text: "a.*[x]$\\" });
    assert.equal(source.redactText("prefix a.*[x]$\\ suffix"), "prefix [password redacted] suffix");
  } finally { await source.close(); }
});
