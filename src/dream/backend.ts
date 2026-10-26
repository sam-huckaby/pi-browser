import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "playwright";
import { ChromiumBackend } from "../browser/backend.ts";
import { parseBrowserUrl } from "../browser/url.ts";
import { dreamEditorScript } from "./editor.ts";
import type { DreamAction, DreamBackend, DreamFrame, DreamState } from "./types.ts";
import { DreamActivity, activityAction, activityError, activityState, activityUrl } from "./activity.ts";

/** Isolated by default; an explicit inspection handoff moves the whole profile here. */
export class DreamChromiumBackend extends ChromiumBackend implements DreamBackend {
  private readonly initialized = new WeakSet<Page>();

  constructor(options: ConstructorParameters<typeof ChromiumBackend>[0] = {}, private readonly activity?: DreamActivity) {
    super(options);
    activity?.setFilter((value) => this.privacy.project(value));
  }
  protected override privacyChanged(): void { this.activity?.setPrivate(this.privateMode); }

  private async initialize(page: Page): Promise<void> {
    if (this.initialized.has(page)) return;
    await page.addInitScript({ content: dreamEditorScript() });
    this.initialized.add(page);
  }

  open(input?: string, signal?: AbortSignal): Promise<DreamFrame> {
    const url = parseBrowserUrl(input ?? "");
    return this.withPage(async (page) => {
      await this.initialize(page);
      if (url) await page.goto(url, { waitUntil: "domcontentloaded" });
      else if (page.url() === "about:blank") throw new Error("Start with /dream URL. Without a URL, /dream resumes the current mockup.");
      await page.waitForLoadState("domcontentloaded");
      await delay(200, undefined, { signal });
      await page.evaluate(dreamEditorScript());
      await this.privacy.collect(page);
      await this.dispatch(page, { action: "privacy", enabled: this.privateMode });
      await this.dispatch(page, { action: "resume" });
      this.activity?.record("browser.open", { url: activityUrl(page.url()) });
      return this.frame(page, signal);
    }, signal).catch((error) => { this.activity?.record("browser.error", { error: activityError(error) }); throw error; });
  }

  async openFromInspection(source: ChromiumBackend, signal?: AbortSignal): Promise<DreamFrame> {
    await source.transferTo(this, signal);
    try {
      return await this.withPage(async (page) => {
        const scroll = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
        await this.initialize(page);
        // Register capture listeners before application scripts. Reload the same
        // page: cookies, sessionStorage, localStorage and IndexedDB stay intact.
        await page.reload({ waitUntil: "domcontentloaded" });
        await delay(200, undefined, { signal });
        await page.evaluate(dreamEditorScript());
        await page.evaluate(({ x, y }) => window.scrollTo(x, y), scroll);
        await this.privacy.collect(page);
        await this.dispatch(page, { action: "privacy", enabled: this.privateMode });
        await this.dispatch(page, { action: "resume" });
        this.activity?.record("browser.handoff", { url: activityUrl(page.url()), note: "Inspection profile transferred; page reloaded for Dream." });
        return this.frame(page, signal);
      }, signal);
    } catch (error) {
      this.activity?.record("browser.error", { error: activityError(error) });
      if (signal?.aborted) await this.close();
      throw error;
    }
  }

  apply(actions: DreamAction[], signal?: AbortSignal): Promise<DreamFrame> {
    return this.withPage(async (page) => {
      if (!actions.length) throw new Error("A Dream input batch cannot be empty.");
      for (const action of actions) {
        signal?.throwIfAborted();
        await this.privacy.collect(page);
        await this.dispatch(page, { action: "privacy", enabled: this.privateMode });
        this.activity?.record("input", activityAction(action));
        if (action.action === "scroll") {
          await this.dispatch(page, { action: "dismiss-menu" });
          const viewport = page.viewportSize()!;
          if (action.x < 0 || action.y < 0 || action.x >= viewport.width || action.y >= viewport.height) throw new Error("Scroll point is outside the viewport.");
          await page.mouse.move(action.x, action.y);
          await page.mouse.wheel(action.deltaX ?? 0, action.deltaY);
          await delay(100, undefined, { signal });
        } else if (action.action === "key") {
          const state = await this.dispatch(page, { action: "refresh" });
          if (state.menu) { await this.dispatch(page, { action: "menu-key", key: action.key }); continue; }
          if (action.key === "Shift+F10") { await this.dispatch(page, { action: "context" }); continue; }
          const resizeKey = !state.editing && /^Alt\+Arrow(Left|Right|Up|Down)$/.exec(action.key);
          if (resizeKey && state.selected?.resize) {
            const horizontal = resizeKey[1] === "Left" || resizeKey[1] === "Right";
            const handle = state.selected.resize.handles.find((item) => item.handle === (horizontal ? "e" : "s"));
            if (handle) {
              const from = { x: handle.bounds.x + handle.bounds.width / 2, y: handle.bounds.y + handle.bounds.height / 2 };
              const delta = resizeKey[1] === "Left" || resizeKey[1] === "Up" ? -10 : 10;
              await this.dispatch(page, { action: "resize", selection: state.selected.resize.token, handle: handle.handle, from,
                to: { x: from.x + (horizontal ? delta : 0), y: from.y + (horizontal ? 0 : delta) } });
            }
            continue;
          }
          const shortcut = /^(?:Control|Meta)\+([acvz])$/i.exec(action.key);
          if (shortcut?.[1]?.toLowerCase() === "c") await this.dispatch(page, { action: "copy" });
          else if (shortcut?.[1]?.toLowerCase() === "v") await this.dispatch(page, { action: "paste" });
          else if (/^(?:Control|Meta)\+Shift\+z$/i.test(action.key)) await this.dispatch(page, { action: "redo" });
          else if (shortcut?.[1]?.toLowerCase() === "z") await this.dispatch(page, { action: "undo" });
          else if (action.key === "Enter" || action.key === "Escape") {
            if (state.editing) await this.dispatch(page, { action: "commit" });
            else if (action.key === "Enter" && state.selected) await this.dispatch(page, { action: "edit" });
          } else if (!state.editing && state.selected && (action.key === "Delete" || action.key === "Backspace")) await this.dispatch(page, { action: "delete" });
          else if (state.editing) await page.keyboard.press(shortcut?.[1]?.toLowerCase() === "a" ? "ControlOrMeta+a" : action.key);
        } else await this.dispatch(page, action);
      }
      const frame = await this.frame(page, signal);
      this.activity?.record("batch.complete", activityState(frame.state));
      return frame;
    }, signal).catch((error) => { this.activity?.record("batch.error", { error: activityError(error), note: "Earlier actions in this batch may have applied." }); throw error; });
  }

  private async dispatch(page: Page, action: DreamAction): Promise<DreamState> {
    const state = await page.evaluate((input) => {
      if (!window.__piBrowserDream) throw new Error("The page navigated away from Dream. Reopen /dream URL.");
      return window.__piBrowserDream.dispatch(input);
    }, action);
    if (!["refresh", "privacy"].includes(action.action)) this.activity?.record(state.notice ? "editor.notice" : "editor.action", { ...activityAction(action), ...activityState(state) });
    return this.privacy.project(state);
  }

  private async frame(page: Page, signal?: AbortSignal): Promise<DreamFrame> {
    // Refresh remains allowed after finish, when all editor graphics are removed.
    await this.privacy.collect(page);
    const state = this.privacy.project(await page.evaluate(() => window.__piBrowserDream!.dispatch({ action: "refresh" })));
    return { state, snapshot: await this.capture(page, signal) };
  }
}
