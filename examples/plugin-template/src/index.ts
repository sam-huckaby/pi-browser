import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBrowserPlugin, type BrowserPlugin } from "pi-browser/plugins";

export default function exampleExtension(pi: ExtensionAPI): void {
  const plugin: BrowserPlugin = {
    id: "example", title: "Example local app", description: "Template for an optional private browser integration.",
    async prepare(_ctx, args, signal) {
      signal?.throwIfAborted();
      // Validate application-specific options here. Do not accept credentials.
      if (args.trim()) throw new Error("This example takes no arguments.");
      // Confirm before starting processes or other consequential actions.
      // Keep resources in this factory's closure; clean up only what you own.
      return { url: "http://localhost:3000", private: true };
    },
    async stop() { /* Abort pending work and release your owned resources. */ },
  };
  const register = () => registerBrowserPlugin(pi, plugin);
  pi.on("session_start", (_event, ctx) => {
    try { register(); }
    catch { ctx.ui.notify("Example plugin needs pi-browser API v1. Install it and /reload.", "warning"); }
  });
  pi.on("session_shutdown", () => plugin.stop?.());
  pi.registerCommand("example-browser", {
    description: "Open the example app in private inspection",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      try { await register().open(plugin.id, ctx, args, ctx.signal); }
      catch { ctx.ui.notify("Example inspection could not open. Check local setup; no raw errors shared.", "error"); }
    },
  });
}
