import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";
import { browserPluginProtocol, type BrowserPlugin, type BrowserPluginDiscovery } from "pi-browser/plugins";

test("template registers lazily and prepares a private target", async () => {
  let plugin: BrowserPlugin | undefined;
  const handlers = new Map<string, Function>();
  const pi = {
    events: { emit: (channel: string, data: BrowserPluginDiscovery) => {
      assert.equal(channel, browserPluginProtocol);
      data.reply({ version: 1, register: value => { plugin = value; }, list: () => [], open: async () => ({ completed: true, private: true }), stop: async () => {} });
    } },
    on: (event: string, handler: Function) => { handlers.set(event, handler); },
    registerCommand: () => {},
  } as unknown as ExtensionAPI;
  extension(pi);
  assert.equal(plugin, undefined, "factory does not launch or prepare anything");
  await handlers.get("session_start")!({}, { ui: { notify: () => assert.fail("unexpected notification") } });
  assert.equal(plugin!.id, "example");
  assert.deepEqual(await plugin!.prepare({} as never, ""), { url: "http://localhost:3000", private: true });
  await assert.rejects(plugin!.prepare({} as never, "--password secret"), /no arguments/);
});
