import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCapabilities } from "@earendil-works/pi-tui";
import type { BrowserBackend } from "../browser/backend.ts";
import { privateMessage } from "../browser/privacy.ts";
import { browserPluginFailure } from "../plugins/errors.ts";
import { parseBrowserUrl } from "../browser/url.ts";
import { InspectionView, type InspectionResult } from "./inspection-view.ts";
import type { DreamResult } from "../dream/types.ts";
import { OpaqueModal } from "./opaque-modal.ts";

/** Shared command/tool entry point. Owns only the active inspection, not the browser. */
export class Inspections {
  private controller?: AbortController;

  constructor(private readonly backend: BrowserBackend,
    private readonly enterDream?: (ctx: ExtensionContext, inspection: InspectionResult, signal?: AbortSignal) => Promise<DreamResult>) {}

  async open(ctx: ExtensionContext, input?: string, signal?: AbortSignal): Promise<InspectionResult> {
    if (ctx.mode !== "tui") throw new Error("Inspection requires interactive Pi in fullscreen mode. Use the browser tool for screenshots in other modes.");
    if (this.controller) throw new Error("An inspection is already open. Close it before opening another.");
    const url = parseBrowserUrl(input ?? "");
    signal?.throwIfAborted();
    const controller = new AbortController();
    this.controller = controller;
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let view: InspectionView | undefined;
    let modal: OpaqueModal | undefined;
    let result: InspectionResult;
    try {
      result = await ctx.ui.custom<InspectionResult>(async (tui, theme, _keys, done) => {
        if (tui.mode !== "fullscreen") throw new Error("Clickable inspection needs fullscreen mode. Choose fullscreen in /settings, or start Pi with --tui-mode fullscreen.");
        if (getCapabilities().images !== "kitty") throw new Error("Clickable inspection needs Kitty graphics (for example Ghostty, Kitty, or WezTerm). This Pi version disables iTerm2-only images in fullscreen mode. Use the browser tool for static screenshots instead.");
        const snapshot = await this.backend.run(url ? { action: "navigate", url } : { action: "screenshot" }, controller.signal);
        controller.signal.throwIfAborted();
        if (!snapshot) throw new Error("The browser returned no screenshot.");
        view = new InspectionView(snapshot, this.backend, tui, theme, controller, done);
        modal = new OpaqueModal(tui, view);
        return modal;
      }, {
        overlay: true,
        overlayOptions: { width: "100%", maxHeight: "100%", margin: 1, anchor: "top-left" },
      });
      await view?.whenIdle();
      signal?.throwIfAborted();
    } catch (error) {
      if (this.backend.privateMode) throw Object.assign(new Error(privateMessage), { code: browserPluginFailure(error).code });
      throw error;
    } finally {
      modal?.dispose();
      view?.dispose();
      signal?.removeEventListener("abort", onAbort);
      if (this.controller === controller) this.controller = undefined;
    }
    if (result.dreamRequested) {
      if (!this.enterDream) throw new Error("Inspection-to-Dream handoff is unavailable in this host.");
      const dream = await this.enterDream(ctx, result, signal);
      return { ...result, snapshot: dream.snapshot, dream };
    }
    return result;
  }

  /** Called on reload, session switch, or shutdown, including while loading the initial URL. */
  cancel(): void { this.controller?.abort(); }
}
