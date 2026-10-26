import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCapabilities } from "@earendil-works/pi-tui";
import { parseBrowserUrl } from "../browser/url.ts";
import type { DreamBackend, DreamResult } from "../dream/types.ts";
import { DreamView } from "./dream-view.ts";
import { DreamScreen } from "./dream-screen.ts";
import { privateMessage } from "../browser/privacy.ts";
import type { ChromiumBackend } from "../browser/backend.ts";
import { OpaqueModal } from "./opaque-modal.ts";
import { DreamActivity, activityError } from "../dream/activity.ts";

export class Dreams {
  private controller?: AbortController;
  constructor(private readonly backend: DreamBackend, private readonly activity?: DreamActivity) {}

  async open(ctx: ExtensionContext, input?: string, signal?: AbortSignal, source?: ChromiumBackend): Promise<DreamResult> {
    if (ctx.mode !== "tui") throw new Error("Dream requires interactive Pi in fullscreen mode.");
    if (this.controller) throw new Error("A Dream is already open. Finish it before opening another.");
    const url = parseBrowserUrl(input ?? "");
    if (source && !this.backend.openFromInspection) throw new Error("This Dream backend cannot accept an inspection session.");
    signal?.throwIfAborted();
    const controller = new AbortController(); this.controller = controller;
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let view: DreamView | undefined;
    let modal: OpaqueModal | undefined;
    let startup: Promise<void> | undefined;
    try {
      const outcome = await ctx.ui.custom<DreamResult | { error: unknown }>((tui, theme, _keys, done) => {
        if (tui.mode !== "fullscreen") throw new Error("Dream needs fullscreen mode. Choose fullscreen in /settings, or start Pi with --tui-mode fullscreen.");
        if (getCapabilities().images !== "kitty") throw new Error("Dream needs Kitty graphics (Ghostty, Kitty, or WezTerm).");
        controller.signal.throwIfAborted();
        let completed = false;
        const complete = (value: DreamResult | { error: unknown }) => { if (!completed) { completed = true; done(value); } };
        const screen = new DreamScreen(tui, controller, source
          ? "Keeping your authenticated browser session; reloading the page for visual editing."
          : "Opening the visual editor.", (error) => complete({ error }));
        modal = new OpaqueModal(tui, screen);
        startup = (async () => {
          this.activity?.setPrivate(source?.privateMode ?? this.backend.privateMode ?? false);
          // Record the URL only after the backend has collected password values.
          await this.activity?.start(ctx.cwd);
          controller.signal.throwIfAborted();
          const frame = source ? await this.backend.openFromInspection!(source, controller.signal) : await this.backend.open(url, controller.signal);
          controller.signal.throwIfAborted();
          view = new DreamView(frame, this.backend, tui, theme, controller, complete, this.activity);
          screen.ready(view);
        })().catch((error) => complete({ error }));
        return modal;
      }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: 1, anchor: "top-left" } });
      if ("error" in outcome) throw outcome.error;
      const result = outcome;
      await view?.whenIdle();
      signal?.throwIfAborted();
      this.activity?.record(result.canceled ? "session.cancel" : "session.complete", { changes: result.state.changes.length });
      await this.activity?.flush();
      return { ...result, activity: this.activity?.snapshot() };
    } catch (error) {
      this.activity?.record("session.error", { error: activityError(error) });
      if (this.backend.privateMode || source?.privateMode) throw new Error(privateMessage);
      throw error;
    } finally {
      modal?.dispose();
      await startup;
      await this.activity?.flush();
      modal?.dispose(); view?.dispose();
      signal?.removeEventListener("abort", onAbort);
      if (this.controller === controller) this.controller = undefined;
    }
  }
  cancel(): void { this.controller?.abort(); }
}
