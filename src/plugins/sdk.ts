import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
export { BrowserPluginError, browserPluginFailure, type BrowserPluginErrorCode } from "./errors.ts";

/** Shared through Pi's event bus, never through a module-global singleton. */
export const browserPluginProtocol = "pi-browser:plugins:v1";
export const browserPluginApiVersion = 1 as const;
export interface BrowserPluginTarget {
  url: string;
  /** Defaults to true. Only an explicit false permits an initial public capture. */
  private?: boolean;
}
export interface BrowserPlugin {
  id: string;
  title: string;
  description: string;
  /** Runs only on explicit command/tool invocation, not registration/startup. */
  prepare(ctx: ExtensionContext, args: string, signal?: AbortSignal): Promise<BrowserPluginTarget>;
  /** Idempotent: release only resources owned by this plugin. */
  stop?(): Promise<void>;
}
export interface BrowserPluginInfo { id: string; title: string; description: string }
export interface BrowserPluginOutcome { completed: true; private: boolean }
export interface BrowserPluginHost {
  readonly version: typeof browserPluginApiVersion;
  register(plugin: BrowserPlugin): void;
  list(): BrowserPluginInfo[];
  open(id: string, ctx: ExtensionContext, args?: string, signal?: AbortSignal): Promise<BrowserPluginOutcome>;
  stop(id: string): Promise<void>;
}
export interface BrowserPluginDiscovery {
  version: number;
  reply(host: BrowserPluginHost): void;
}

/** Discover at use time: independent package instances and extension load order work. */
export function getBrowserPluginHost(pi: Pick<ExtensionAPI, "events">): BrowserPluginHost {
  const replies: BrowserPluginHost[] = [];
  pi.events.emit(browserPluginProtocol, { version: browserPluginApiVersion, reply: (host: BrowserPluginHost) => replies.push(host) } satisfies BrowserPluginDiscovery);
  if (replies.length !== 1 || replies[0]?.version !== browserPluginApiVersion) {
    throw new Error("A single compatible pi-browser host is required. Install pi-browser, then /reload (finish active inspection/Dream first).");
  }
  return replies[0];
}

/** Re-register after /reload; identical-object registration is intentionally idempotent. */
export function registerBrowserPlugin(pi: Pick<ExtensionAPI, "events">, plugin: BrowserPlugin): BrowserPluginHost {
  const host = getBrowserPluginHost(pi);
  host.register(plugin);
  return host;
}
