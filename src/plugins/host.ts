import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseBrowserUrl } from "../browser/url.ts";
import { BrowserPluginError, browserPluginFailure } from "./errors.ts";
import type { BrowserPlugin, BrowserPluginHost, BrowserPluginInfo, BrowserPluginOutcome } from "./sdk.ts";

export interface PluginInspection {
  open(ctx: ExtensionContext, url: string, signal?: AbortSignal): Promise<{ snapshot: { private?: boolean } }>;
}
export class BrowserPlugins implements BrowserPluginHost {
  readonly version = 1 as const;
  private readonly plugins = new Map<string, BrowserPlugin>();
  private active?: { id: string; controller: AbortController };
  constructor(private readonly inspection: PluginInspection, private readonly enablePrivate: (signal?: AbortSignal) => Promise<unknown>) {}
  register(plugin: BrowserPlugin): void {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(plugin.id) || typeof plugin.prepare !== "function" ||
      !this.validText(plugin.title, 100) || !this.validText(plugin.description, 500)) throw new Error("Invalid browser plugin descriptor.");
    const existing = this.plugins.get(plugin.id);
    if (existing && existing !== plugin) throw new Error(`Browser plugin ID already registered: ${plugin.id}`);
    this.plugins.set(plugin.id, plugin);
  }
  list(): BrowserPluginInfo[] {
    return [...this.plugins.values()].map(({ id, title, description }) => ({ id, title, description })).sort((a, b) => a.id.localeCompare(b.id));
  }
  async open(id: string, ctx: ExtensionContext, args = "", signal?: AbortSignal): Promise<BrowserPluginOutcome> {
    const plugin = this.find(id);
    if (ctx.mode !== "tui") throw new Error("Browser plugins require interactive fullscreen Pi.");
    if (this.active) throw new Error("A browser plugin operation is already active.");
    if (args.length > 4096) throw new Error("Browser plugin arguments are too long. Never pass credentials here.");
    signal?.throwIfAborted();
    const controller = new AbortController();
    this.active = { id, controller };
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const target = await plugin.prepare(ctx, args, controller.signal);
      controller.signal.throwIfAborted();
      const url = parseBrowserUrl(target.url);
      if (!url) throw new Error("Missing plugin URL.");
      if (target.private !== false) await this.enablePrivate(controller.signal);
      controller.signal.throwIfAborted();
      const result = await this.inspection.open(ctx, url, controller.signal);
      return { completed: true, private: result.snapshot.private === true };
    } catch (error) {
      // Preserve only allowlisted diagnostic codes, not raw third-party errors.
      const failure = controller.signal.aborted ? new BrowserPluginError("PLUGIN_CANCELED") : browserPluginFailure(error);
      throw Object.assign(new Error(`Browser plugin ${id} could not open inspection. ${failure.message} No page output was shared.`), { code: failure.code });
    } finally {
      signal?.removeEventListener("abort", abort);
      this.active = undefined;
    }
  }
  async stop(id: string): Promise<void> {
    const plugin = this.find(id);
    if (this.active?.id === id) this.active.controller.abort();
    try { await plugin.stop?.(); } catch { throw new Error(`Browser plugin ${id} could not stop its owned resources.`); }
  }
  async cleanup(): Promise<void> {
    this.active?.controller.abort();
    await Promise.allSettled([...this.plugins.keys()].map(id => this.stop(id)));
  }
  private find(id: string): BrowserPlugin {
    const plugin = this.plugins.get(id);
    if (!plugin) throw new Error("Unknown browser plugin. Use /browser-plugins to list installed integrations.");
    return plugin;
  }
  private validText(text: string, length: number): boolean {
    return typeof text === "string" && text.length > 0 && text.length <= length && !/[\u0000-\u001f\u007f-\u009f]/u.test(text);
  }
}
