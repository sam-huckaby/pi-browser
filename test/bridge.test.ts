import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { discoverAndLoadExtensions, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getCapabilities, getCellDimensions, setCapabilities, setCellDimensions, TuiAltScreen } from "@earendil-works/pi-tui";
import type { Page } from "playwright";
import { ChromiumBackend } from "../src/browser/backend.ts";
import { DreamChromiumBackend } from "../src/dream/backend.ts";
import { DreamActivity } from "../src/dream/activity.ts";
import { saveDream } from "../src/dream/artifacts.ts";
import { InspectionView, type InspectionResult } from "../src/ui/inspection-view.ts";
import { DreamScreen } from "../src/ui/dream-screen.ts";
import { OpaqueModal } from "../src/ui/opaque-modal.ts";
import { mouse, snapshot, theme, VirtualTerminal, waitDreamReady } from "./support.ts";

class ReadableBrowser extends ChromiumBackend {
  inspect<T>(fn: (page: Page) => Promise<T>): Promise<T> { return this.withPage(fn); }
}
class ReadableDream extends DreamChromiumBackend {
  inspect<T>(fn: (page: Page) => Promise<T>): Promise<T> { return this.withPage(fn); }
}
let server: Server, url: string;
let caps: ReturnType<typeof getCapabilities>, cell: ReturnType<typeof getCellDimensions>;
let mutations = 0;
before(async () => {
  server = createServer((request, response) => {
    if (request.url === "/mutation") { mutations++; response.end("mutated"); return; }
    response.setHeader("Content-Type", "text/html");
    if (request.url === "/app" && !request.headers.cookie?.includes("CF_Authorization=fixture-cookie")) {
      response.writeHead(302, { Location: "/login" }); response.end(); return;
    }
    if (request.url === "/login") {
      response.setHeader("Set-Cookie", ["CF_Authorization=fixture-cookie; HttpOnly; SameSite=Lax; Path=/", "CF_Binding=fixture-binding; HttpOnly; Path=/"]);
      response.end(`<!doctype html><title>Login fixture</title><button onclick="sessionStorage.setItem('session','fixture-session');localStorage.setItem('local','fixture-local');location.href='/app'">Log in</button>`);
      return;
    }
    response.end(`<!doctype html><title>Authenticated bridge fixture</title><style>body{font:24px sans-serif;background:#eff4fb;padding:60px}h1{color:#243650}input{font:24px sans-serif}</style>
      <h1 id="headline">${request.url === "/app" ? "Authenticated project" : "Fresh browser"}</h1><input aria-label="Text"><a href="/popup" target="_blank">Popup</a>
      <p id="state"></p><script>
      document.querySelector('#state').textContent = sessionStorage.getItem('session') === 'fixture-session' && localStorage.getItem('local') === 'fixture-local' ? 'Session and local storage retained' : 'No authenticated storage';
      window.appActivations=0; window.addEventListener('click',()=>{window.appActivations++;fetch('/mutation')},true);
      </script>`);
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

test("Dream toolbar drains native inspection input before transferring; release and paste remain inert", async () => {
  const terminal = new VirtualTerminal(), tui = new TuiAltScreen(terminal);
  let release!: () => void, result: InspectionResult | undefined;
  const controller = new AbortController();
  const view = new InspectionView(snapshot, {
    run: async () => { await new Promise<void>((resolve) => { release = resolve; }); return { ...snapshot, url: url + "/app" }; },
    close: async () => {},
  }, tui, theme, controller, (value) => { result = value; });
  try {
    tui.start(); const overlay = tui.showOverlay(view, { width: "100%", margin: 1, anchor: "top-left" }); tui.renderNow(true);
    terminal.onInput?.("\u001b[100:68;2:3u"); assert.equal(result, undefined);
    terminal.onInput?.("\u001b[200~D\u001b[201~");
    const bounds = overlay.getBounds()!;
    terminal.click(bounds.col + view.render(120)[0]!.indexOf("[Dream]") + 2, bounds.row);
    assert.match(view.render(120)[2]!, /Preparing Dream/);
    assert.equal(result, undefined); release(); await view.whenIdle();
    assert.equal((result as InspectionResult | undefined)?.dreamRequested, true);
    assert.equal((result as InspectionResult | undefined)?.snapshot.url, url + "/app");
    assert.equal(controller.signal.aborted, false);
  } finally { view.dispose(); tui.stop(); }
});

test("Shift+D types in a field; Dream toolbar explicitly overrides field focus", async () => {
  const actions: string[] = [];
  let result: InspectionResult | undefined;
  const view = new InspectionView({ ...snapshot, focusedEditable: true }, {
    run: async (action) => { if (action.action === "type") actions.push(action.text); return { ...snapshot, focusedEditable: true }; },
    close: async () => {},
  }, { terminal: new VirtualTerminal(), requestRender: () => {} }, theme, new AbortController(), (value) => { result = value; });
  view.handleInput("D"); await view.whenIdle();
  assert.deepEqual(actions, ["D"]); assert.equal(result, undefined);
  view.handleMouse(mouse(view.render(120)[0]!.indexOf("[Dream]") + 2, 0)); await view.whenIdle();
  assert.equal((result as InspectionResult | undefined)?.dreamRequested, true);
});

test("failed queued input cancels the transition, and Esc cancels a pending handoff", async () => {
  let result: InspectionResult | undefined;
  const controller = new AbortController();
  const view = new InspectionView(snapshot, { run: async () => { throw new Error("Input failed"); }, close: async () => {} },
    { terminal: new VirtualTerminal(), requestRender: () => {} }, theme, controller, (value) => { result = value; });
  view.handleInput("x"); view.handleInput("D"); await view.whenIdle();
  assert.equal(result, undefined); assert.match(view.render(120)[2]!, /Input failed/); view.dispose();
  const view2 = new InspectionView(snapshot, { run: async () => snapshot, close: async () => {} },
    { terminal: new VirtualTerminal(), requestRender: () => {} }, theme, new AbortController(), (value) => { result = value; });
  view2.handleInput("D"); view2.handleInput("\u001b"); await view2.whenIdle(); assert.equal((result as InspectionResult | undefined)?.dreamRequested, undefined);
});

test("idle Shift+D works across terminal protocols; pending field focus keeps D literal", async () => {
  for (const key of ["D", "\u001b[100;2u", "\u001b[100:68;2u", "\u001b[68;2u", "\u001b[27;2;68~"]) {
    let result: InspectionResult | undefined;
    const view = new InspectionView(snapshot, { run: async () => snapshot, close: async () => {} },
      { terminal: new VirtualTerminal(), requestRender: () => {} }, theme, new AbortController(), (value) => { result = value; });
    view.handleInput(key); await view.whenIdle(); assert.equal(result?.dreamRequested, true, JSON.stringify(key));
  }
  let release!: () => void, calls = 0, result: InspectionResult | undefined;
  const actions: string[] = [];
  const view = new InspectionView(snapshot, { run: async (action) => {
    if (++calls === 1) await new Promise<void>((resolve) => { release = resolve; });
    if (action.action === "type") actions.push(action.text);
    return { ...snapshot, focusedEditable: true };
  }, close: async () => {} }, { terminal: new VirtualTerminal(), requestRender: () => {} }, theme, new AbortController(), (value) => { result = value; });
  view.render(120); view.handleMouse(mouse(30, 10)); view.handleInput("D"); release(); await view.whenIdle();
  assert.deepEqual(actions, ["D"]); assert.equal(result, undefined); view.dispose();
});

test("loading screen blocks page input and supports cancellation", () => {
  const controller = new AbortController(); let failed = 0;
  const screen = new DreamScreen({ requestRender: () => {} }, controller, "Keeping browser session", () => failed++);
  assert.match(screen.render(80).join("\n"), /Loading Dream/);
  screen.handleInput("typed while loading"); screen.handleMouse(mouse(10, 10)); assert.equal(failed, 0);
  screen.handleInput("\u001b"); assert.equal(controller.signal.aborted, true); assert.equal(failed, 1); screen.dispose();
});

test("real handoff retains the exact page, HttpOnly/binding cookies, session/local storage and IndexedDB", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-bridge-auth-"));
  const activity = new DreamActivity(); await activity.start(directory, url + "/app");
  const source = new ReadableBrowser(), dream = new ReadableDream({}, activity);
  try {
    await source.run({ action: "navigate", url: url + "/login" });
    await source.run({ action: "click", target: { role: "button", name: "Log in" } });
    const page = await source.inspect(async (page) => {
      await page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve) => { const request = indexedDB.open("auth", 1); request.onupgradeneeded = () => request.result.createObjectStore("tokens"); request.onsuccess = () => resolve(request.result); });
        await new Promise<void>((resolve) => { const transaction = db.transaction("tokens", "readwrite"); transaction.objectStore("tokens").put("fixture-idb", "token"); transaction.oncomplete = () => resolve(); }); db.close();
      }); return page;
    });
    const cookies = await page.context().cookies(); mutations = 0;
    const frame = await dream.openFromInspection(source);
    assert.equal(await dream.inspect(async (current) => current), page);
    assert.deepEqual(await page.context().cookies(), cookies);
    assert.equal(frame.snapshot.url, url + "/app"); assert.match(frame.snapshot.accessibility, /Session and local storage retained/);
    const stored = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve) => { const request = indexedDB.open("auth"); request.onsuccess = () => resolve(request.result); });
      const value = await new Promise((resolve) => { const request = db.transaction("tokens").objectStore("tokens").get("token"); request.onsuccess = () => resolve(request.result); }); db.close(); return value;
    }); assert.equal(stored, "fixture-idb");
    await page.mouse.click(100, 100);
    assert.equal(await page.evaluate(() => (window as unknown as { appActivations: number }).appActivations), 0); assert.equal(mutations, 0);
    await dream.apply([{ action: "edit", x: 120, y: 110 }, { action: "text", text: "Authenticated Dream goal" }, { action: "commit" }]);
    const finished = await dream.apply([{ action: "finish" }]);
    const artifact = await saveDream(directory, { ...finished, canceled: false, activity: activity.snapshot() });
    assert.match(finished.snapshot.accessibility, /Authenticated Dream goal/);
    assert.equal(await page.locator("[data-pi-dream-overlay]").count(), 0);
    const serialized = await readFile(artifact.manifestPath, "utf8") + await readFile(artifact.activityPath!, "utf8");
    for (const secret of ["fixture-cookie", "fixture-binding", "fixture-session", "fixture-local", "fixture-idb"]) assert.equal(serialized.includes(secret), false);
    await source.close(); assert.equal(page.isClosed(), false);
    const fresh = await source.run({ action: "navigate", url: url + "/app" }); assert.equal(fresh?.url, url + "/login");
    const popup = await dream.inspect(async (current) => { await current.evaluate(() => window.open("/popup")); await current.waitForTimeout(200); return current; });
    assert.equal(popup, page); assert.equal(await dream.inspect(async (current) => current.url()), url + "/popup");
  } finally { await source.close(); await dream.close(); await activity.flush(); await rm(directory, { recursive: true, force: true }); }
});

test("handoff rejects missing or aborted sessions without replacing the existing Dream", async () => {
  const source = new ReadableBrowser(), dream = new ReadableDream();
  try {
    const original = await dream.open(url);
    await assert.rejects(dream.openFromInspection(source), /no longer available/);
    assert.equal((await dream.apply([{ action: "refresh" }])).snapshot.url, original.snapshot.url);
    await source.run({ action: "navigate", url });
    const controller = new AbortController(); controller.abort();
    await assert.rejects(dream.openFromInspection(source, controller.signal), { name: "AbortError" });
    assert.equal((await source.run({ action: "screenshot" }))?.url, url + "/");
    await assert.rejects(source.transferTo(source), /itself/);
  } finally { await source.close(); await dream.close(); }
});

test("real Pi extension loader bridges /inspect to Dream, publishes an Esc-saved goal, and supports the tool entry point", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-bridge-loader-"));
  const loaded = await discoverAndLoadExtensions([join(process.cwd(), "src/index.ts")], directory, join(directory, "agent"));
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions.find((item) => item.commands.has("inspect"))!;
  const messages: { details?: unknown; customType?: string }[] = [];
  loaded.runtime.sendMessage = (message, options) => { assert.equal(options?.triggerTurn, false); messages.push(message); };
  const terminal = new VirtualTerminal(), tui = new TuiAltScreen(terminal);
  const notifications: string[] = []; let screens = 0;
  const ctx = { cwd: directory, mode: "tui", hasUI: true, waitForIdle: async () => {}, ui: {
    notify: (message: string) => notifications.push(message),
    custom: (factory: Function) => new Promise((resolve, reject) => {
      let component: OpaqueModal | undefined;
      Promise.resolve(factory(tui, theme, undefined, (value: unknown) => { component?.dispose(); resolve(value); })).then(async (view: OpaqueModal) => {
        component = view;
        if (screens++ % 2 === 0) component.handleInput("\u001b[100:68;2u");
        else { assert.match(component.render(120)[0]!, /Loading Dream/); await waitDreamReady(component); component.handleInput("\u001b"); }
      }).catch(reject);
    }),
  } } as unknown as ExtensionCommandContext;
  try {
    tui.start();
    await extension.commands.get("inspect")!.handler(url + "/app", ctx);
    assert.deepEqual(notifications, []); assert.equal(messages[0]?.customType, "dream-result");
    const details = messages[0]!.details as { screenshotPath: string; activityPath: string };
    assert.equal((await readFile(details.screenshotPath)).subarray(1, 4).toString(), "PNG");
    assert.match(await readFile(details.activityPath, "utf8"), /browser.handoff/);
    const tool = extension.tools.get("browser_inspect")!;
    const result = await tool.definition.execute("bridge", { url }, undefined, undefined, ctx as never);
    assert.match(result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n"), /Dream goal saved/);
    assert.equal(messages.length, 2);
  } finally {
    for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" }, ctx);
    tui.stop(); await rm(directory, { recursive: true, force: true });
  }
});
