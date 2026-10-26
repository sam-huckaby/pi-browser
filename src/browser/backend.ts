import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Locator, type Page } from "playwright";
import type { BrowserAction, ElementTarget } from "./actions.ts";
import { parseBrowserUrl } from "./url.ts";
import { BrowserPrivacy } from "./privacy.ts";

export interface BrowserSnapshot {
  url: string;
  title: string;
  viewport: { width: number; height: number };
  scroll: { x: number; y: number };
  accessibility: string;
  screenshotPath: string;
  /** PNG, viewport-only, at device scale 1 (coordinates are CSS pixels). */
  png: Buffer;
  /** Preserve text entry when inspection shortcuts overlap printable keys. */
  focusedEditable?: boolean;
  /** Local-only frame: never serialize its pixels or metadata to model/artifacts. */
  private?: boolean;
}

export interface BrowserBackend {
  readonly privateMode?: boolean;
  setPrivate?(enabled: boolean, signal?: AbortSignal): Promise<BrowserSnapshot | undefined>;
  redactText?(value: string): string;
  run(action: BrowserAction, signal?: AbortSignal): Promise<BrowserSnapshot | undefined>;
  /** Apply queued user input in order, capturing once at the end of a burst. */
  runBatch?(actions: BrowserAction[], signal?: AbortSignal): Promise<BrowserSnapshot | undefined>;
  close(): Promise<void>;
}

/** Strip terminal control characters from untrusted page metadata. */
export function safeText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "");
}

/** One isolated, ephemeral browser context per extension runtime. No work in construction. */
export class ChromiumBackend implements BrowserBackend {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private queue: Promise<unknown> = Promise.resolve();
  private screenshotDir?: string;
  private sequence = 0;
  protected privacy = new BrowserPrivacy();

  get privateMode(): boolean { return this.privacy.enabled; }
  redactText(value: string): string { return this.privacy.redact(value); }
  protected privacyChanged(): void {}
  setPrivate(enabled: boolean, signal?: AbortSignal): Promise<BrowserSnapshot | undefined> {
    if (enabled && this.options.recordVideo) return Promise.reject(new Error("Private mode is unavailable while video recording is configured."));
    // Enabling is immediate: already-running captures become private too. Turning
    // off is requested only after the UI drains pending input.
    this.privacy.set(enabled);
    this.privacyChanged();
    return this.run({ action: "screenshot" }, signal);
  }

  private readonly onPage = (page: Page): void => {
    this.page = page;
    page.on("dialog", (dialog) => { void dialog.dismiss().catch(() => {}); });
    page.on("download", (download) => { void download.cancel().catch(() => {}); });
  };

  /** Recording is opt-in for the local demo harness; normal Pi sessions do not record video. */
  constructor(private readonly options: Pick<BrowserContextOptions, "recordVideo"> = {}) {}

  /** Queue commands/tools together: Pi can issue multiple calls in one turn. */
  run(action: BrowserAction, signal?: AbortSignal): Promise<BrowserSnapshot | undefined> {
    return this.runBatch([action], signal);
  }

  runBatch(actions: BrowserAction[], signal?: AbortSignal): Promise<BrowserSnapshot | undefined> {
    return this.exclusive(() => this.perform(actions, signal));
  }

  close(): Promise<void> {
    return this.exclusive(async () => { await this.dispose(); this.privacy.set(false); this.privacyChanged(); });
  }

  /** Move ownership, not serialized credentials. The source next opens a fresh profile. */
  transferTo(target: ChromiumBackend, signal?: AbortSignal): Promise<void> {
    if (target === this) return Promise.reject(new Error("Cannot transfer a browser to itself."));
    return this.exclusive(() => target.exclusive(async () => {
      signal?.throwIfAborted();
      if (!this.browser?.isConnected() || !this.context || !this.page || this.page.isClosed()) {
        throw new Error("The inspection browser is no longer available. Reopen /inspect URL.");
      }
      parseBrowserUrl(this.page.url());
      await target.dispose();
      signal?.throwIfAborted();
      this.context.off("page", this.onPage);
      target.browser = this.browser;
      target.context = this.context;
      target.page = this.page;
      target.privacy = this.privacy;
      target.privacyChanged();
      this.privacy = new BrowserPrivacy();
      this.privacyChanged();
      target.context.on("page", target.onPage);
      this.browser = undefined;
      this.context = undefined;
      this.page = undefined;
    }));
  }

  /** Trusted extension code only; never exposed as an arbitrary JavaScript agent tool. */
  protected withPage<T>(operation: (page: Page) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.exclusive(async () => {
      signal?.throwIfAborted();
      const onAbort = () => { void this.dispose().catch(() => {}); };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const page = await this.ensurePage();
        signal?.throwIfAborted();
        const result = await operation(page);
        signal?.throwIfAborted();
        return result;
      } catch (error) {
        if (signal?.aborted) { await this.dispose(); signal.throwIfAborted(); }
        throw error;
      } finally { signal?.removeEventListener("abort", onAbort); }
    });
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  private async ensurePage(): Promise<Page> {
    if (!this.browser?.isConnected() || !this.context) {
      await this.dispose();
      try {
        this.browser = await chromium.launch({ headless: true, chromiumSandbox: true });
      } catch (error) {
        throw new Error(`Unable to launch Chromium. Run "npm run browser:install" in pi-browser.\n${safeText(String(error))}`);
      }
      this.context = await this.browser.newContext({
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 1,
        acceptDownloads: false,
        serviceWorkers: "block",
        recordVideo: this.options.recordVideo,
      });
      this.context.setDefaultTimeout(10000);
      this.context.setDefaultNavigationTimeout(30000);
      // All pages, including popups, share the same ephemeral context.
      this.context.on("page", this.onPage);
      // Local apps are allowed deliberately, but local files are not.
      await this.context.route("**/*", (route) => {
        const protocol = new URL(route.request().url()).protocol;
        return ["http:", "https:", "data:", "blob:", "about:"].includes(protocol)
          ? route.continue()
          : route.abort("blockedbyclient");
      });
    }
    if (!this.page || this.page.isClosed()) {
      this.page = this.context!.pages().find((page) => !page.isClosed()) ?? await this.context!.newPage();
    }
    return this.page;
  }

  private locator(page: Page, target: ElementTarget): Locator {
    return "selector" in target
      ? page.locator(target.selector)
      : page.getByRole(target.role, { name: target.name, exact: true });
  }

  private validatePoint(page: Page, x: number, y: number): void {
    const viewport = page.viewportSize()!;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) {
      throw new Error(`Coordinates must be inside the ${viewport.width}x${viewport.height} viewport.`);
    }
  }

  private async perform(actions: BrowserAction[], signal?: AbortSignal): Promise<BrowserSnapshot | undefined> {
    signal?.throwIfAborted();
    if (!actions.length) throw new Error("A browser input batch cannot be empty.");
    if (actions.some((action) => action.action === "close")) {
      if (actions.length !== 1) throw new Error("close must be the only action in a batch.");
      await this.dispose();
      return undefined;
    }
    // Validate URLs before launching; blank URLs are not navigations to about:blank.
    const urls = actions.map((action) => {
      if (action.action !== "navigate") return undefined;
      const url = parseBrowserUrl(action.url);
      if (!url) throw new Error("navigate requires an HTTP(S) URL.");
      return url;
    });

    // Playwright has no AbortSignal for most calls. Closing Chromium interrupts them.
    const onAbort = () => { void this.dispose().catch(() => {}); };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      for (const [index, action] of actions.entries()) {
        const page = await this.ensurePage();
        signal?.throwIfAborted();
        await this.privacy.collect(page);
        switch (action.action) {
        case "navigate": await page.goto(urls[index]!, { waitUntil: "domcontentloaded" }); break;
        case "click":
          if ("x" in action.target) {
            this.validatePoint(page, action.target.x, action.target.y);
            await page.mouse.click(action.target.x, action.target.y);
          } else await this.locator(page, action.target).click();
          break;
        case "fill": await this.locator(page, action.target).fill(action.text); break;
        case "type":
          if (action.text.length > 100000) throw new Error("Input exceeds 100000 characters.");
          if (action.paste) await page.keyboard.insertText(action.text);
          else await page.keyboard.type(action.text);
          break;
        case "press":
          if (action.target) await this.locator(page, action.target).press(action.key);
          else await page.keyboard.press(action.key);
          break;
        case "scroll": {
          const viewport = page.viewportSize()!;
          const x = action.x ?? Math.floor(viewport.width / 2);
          const y = action.y ?? Math.floor(viewport.height / 2);
          this.validatePoint(page, x, y);
          await page.mouse.move(x, y);
          await page.mouse.wheel(action.deltaX ?? 0, action.deltaY);
          break;
        }
        case "resize": await page.setViewportSize({ width: action.width, height: action.height }); break;
        case "wait": await page.waitForTimeout(action.ms); break;
        case "back": await page.goBack({ waitUntil: "domcontentloaded" }); break;
        case "forward": await page.goForward({ waitUntil: "domcontentloaded" }); break;
        case "reload": await page.reload({ waitUntil: "domcontentloaded" }); break;
        case "screenshot": break;
        }
      }
      // Use the latest popup if an action opened a new page. Not networkidle: many
      // apps poll indefinitely. The agent can explicitly wait for further updates.
      // Popup creation and mouse-wheel dispatch are asynchronous. Let them settle
      // before selecting the active page, not after selecting the previous page.
      await delay(200, undefined, { signal });
      const current = await this.ensurePage();
      await current.waitForLoadState("domcontentloaded");
      await current.waitForTimeout(100);
      signal?.throwIfAborted();
      return await this.capture(current, signal);
    } catch (error) {
      if (signal?.aborted) {
        await this.dispose();
        signal.throwIfAborted();
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  protected async capture(page: Page, signal?: AbortSignal): Promise<BrowserSnapshot> {
    signal?.throwIfAborted();
    const epoch = this.privacy.epoch;
    const startedPrivate = this.privateMode;
    const masks = await this.privacy.collect(page);
    const png = await page.screenshot({ type: "png", caret: "initial", timeout: 10000, mask: masks, maskColor: "#172033" });
    const title = this.redactText(safeText(await page.title())).slice(0, 500);
    const accessibility = startedPrivate ? "" : this.redactText(safeText(await this.privacy.accessibility(page))).slice(0, 12000);
    const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
    const focusedEditable = await page.evaluate(() => {
      let element = document.activeElement;
      while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
      return !!element && (element.matches("input,textarea,select,iframe,[role=textbox],[role=searchbox],[role=combobox]") ||
        (element instanceof HTMLElement && element.isContentEditable));
    });
    signal?.throwIfAborted();
    let screenshotPath = "";
    const isPrivate = () => startedPrivate || this.privateMode || epoch !== this.privacy.epoch;
    if (!isPrivate()) {
      this.screenshotDir ??= await mkdtemp(join(tmpdir(), "pi-browser-"));
      if (!isPrivate()) {
        screenshotPath = join(this.screenshotDir, `${String(++this.sequence).padStart(4, "0")}.png`);
        await writeFile(screenshotPath, png, { mode: 0o600 });
        // A toggle during the async write must not leave a private frame behind.
        if (isPrivate()) { await rm(screenshotPath, { force: true }); screenshotPath = ""; }
      }
    }
    return { url: this.redactText(safeText(page.url())), title, viewport: page.viewportSize()!, scroll,
      accessibility: isPrivate() ? "" : accessibility, screenshotPath, png, focusedEditable, ...(isPrivate() ? { private: true } : {}) };
  }

  private async dispose(): Promise<void> {
    const browser = this.browser;
    const context = this.context;
    this.browser = undefined;
    this.context = undefined;
    this.page = undefined;
    try { await context?.close(); }
    finally { await browser?.close(); this.privacy.clearSecrets(); }
    // Keep screenshots for review after close/reload. The OS may clean tmpdir later.
  }
}
