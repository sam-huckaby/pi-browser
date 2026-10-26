import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { BrowserPlugins } from "./host.ts";

const parameters = Type.Object({
  action: Type.Union([Type.Literal("list"), Type.Literal("open"), Type.Literal("stop")]),
  plugin: Type.Optional(Type.String({ description: "Installed plugin ID from list." })),
  args: Type.Optional(Type.String({ description: "Plugin-specific options; never credentials, cookies, or tokens." })),
});
export function createBrowserPluginTool(host: BrowserPlugins) {
  return defineTool({
    name: "browser_plugin", label: "Browser plugin", parameters,
    description: "List installed pi-browser integrations, open one in interactive inspection, or stop its owned resources. Packages are installed with Pi's normal `pi install <source>` command, then /reload. Opening pauses the agent until the user finishes. Plugins default to Private ON before navigation; page output is never returned by this tool. Starting processes requires the plugin's explicit user confirmation. Do not put credentials in arguments. Stopping may terminate a plugin-owned dev server.",
    exposure: "model-only", executionMode: "sequential",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    async execute(_id, params, signal, _update, ctx) {
      if (params.action === "list") {
        const plugins = host.list();
        return { content: [{ type: "text" as const, text: JSON.stringify({ apiVersion: host.version, plugins }) }], details: { plugins } };
      }
      if (!params.plugin) throw new Error("Specify an installed plugin ID.");
      if (params.action === "stop") {
        await host.stop(params.plugin);
        return { content: [{ type: "text" as const, text: "Plugin-owned resources stopped." }], details: { stopped: true } };
      }
      const result = await host.open(params.plugin, ctx, params.args, signal);
      return { content: [{ type: "text" as const, text: "Plugin inspection ended. No page output returned. Finishing inspection is not approval." }], details: result };
    },
  });
}
