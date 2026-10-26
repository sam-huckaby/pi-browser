import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BrowserPlugins } from "../src/plugins/host.ts";
import { browserPluginProtocol, getBrowserPluginHost, registerBrowserPlugin, type BrowserPlugin, type BrowserPluginDiscovery } from "../src/plugins/sdk.ts";
import { createBrowserPluginTool } from "../src/plugins/tool.ts";
const ctx = { mode: "tui" } as ExtensionContext;
function bus() {
  const emitter = new EventEmitter();
  return { events: { emit: (key: string, data: unknown) => { emitter.emit(key, data); }, on: (key: string, fn: (data: unknown) => void) => { emitter.on(key, fn); return () => emitter.off(key, fn); } } } as Pick<ExtensionAPI, "events">;
}
function fixture() {
  const sequence: string[] = [];
  let privateMode = false;
  const host = new BrowserPlugins({ open: async (_ctx, _url, signal) => { signal?.throwIfAborted(); sequence.push("navigate"); return { snapshot: { private: privateMode } }; } }, async () => { sequence.push("private"); privateMode = true; });
  const plugin: BrowserPlugin = { id: "fixture", title: "Fixture", description: "Synthetic app", prepare: async () => { sequence.push("prepare"); return { url: "http://localhost:3000" }; } };
  return { host, plugin, sequence };
}
test("SDK discovers via event bus at use time and rejects missing/incompatible/multiple hosts", () => {
  const pi = bus(), { host, plugin } = fixture();
  assert.throws(() => getBrowserPluginHost(pi), /compatible/);
  pi.events.on(browserPluginProtocol, data => { const req = data as BrowserPluginDiscovery; req.reply(host); });
  assert.equal(registerBrowserPlugin(pi, plugin), host);
  assert.equal(registerBrowserPlugin(pi, plugin), host);
  assert.equal(host.list().length, 1);
  pi.events.on(browserPluginProtocol, data => (data as BrowserPluginDiscovery).reply(host));
  assert.throws(() => getBrowserPluginHost(pi), /single compatible/);
  const incompatible = bus();
  incompatible.events.on(browserPluginProtocol, data => (data as BrowserPluginDiscovery).reply({ ...host, version: 2 } as never));
  assert.throws(() => getBrowserPluginHost(incompatible), /compatible/);
});
test("registration validates metadata and detects conflicting IDs", () => {
  const { host, plugin } = fixture(); host.register(plugin);
  assert.throws(() => host.register({ ...plugin }), /already registered/);
  for (const change of [{ id: "UPPER" }, { title: "bad\ntext" }, { description: "x".repeat(501) }, { prepare: undefined }]) assert.throws(() => host.register({ ...plugin, ...change } as BrowserPlugin), /Invalid/);
});
test("open defaults private before target navigation and returns only flags", async () => {
  const { host, plugin, sequence } = fixture(); host.register(plugin);
  assert.deepEqual(await host.open(plugin.id, ctx), { completed: true, private: true });
  assert.deepEqual(sequence, ["prepare", "private", "navigate"]);
  plugin.prepare = async () => ({ url: "http://localhost:3000", private: false });
  sequence.length = 0;
  assert.equal((await host.open(plugin.id, ctx)).private, true, "public plugin never clears existing privacy");
  assert.deepEqual(sequence, ["navigate"]);
});
test("generic tool lists only descriptors and returns no page output", async () => {
  const { host, plugin } = fixture(); host.register(plugin);
  const tool = createBrowserPluginTool(host);
  const result = await tool.execute("id", { action: "open", plugin: "fixture" }, undefined, undefined, ctx as never);
  assert.deepEqual(result.details, { completed: true, private: true });
  assert.equal(result.content.length, 1); assert.equal(result.content[0]?.type, "text");
  assert.doesNotMatch(JSON.stringify(result), /localhost|png|screenshot/);
  const list = await tool.execute("id", { action: "list" }, undefined, undefined, ctx as never);
  assert.match(JSON.stringify(list), /Synthetic app/);
});
test("plugin failure, stop failure, and malformed target errors cannot leak secrets", async () => {
  const { host, plugin } = fixture(); host.register(plugin);
  plugin.prepare = async () => { throw new Error("SECRET_COOKIE https://example.test/?token=PRIVATE"); };
  await assert.rejects(host.open(plugin.id, ctx), error => !String(error).includes("SECRET_COOKIE") && !String(error).includes("PRIVATE"));
  plugin.prepare = async () => ({ url: "file:///private/SECRET_COOKIE" });
  await assert.rejects(host.open(plugin.id, ctx), /no page output/);
  plugin.stop = async () => { throw new Error("SECRET_COOKIE"); };
  await assert.rejects(host.stop(plugin.id), /owned resources/);
  await host.cleanup(); // one failing cleanup does not block others
});
test("noninteractive mode never prepares; cancellation and concurrent open fail safely", async () => {
  const { host, plugin, sequence } = fixture(); host.register(plugin);
  await assert.rejects(host.open(plugin.id, { mode: "rpc" } as ExtensionContext), /interactive/);
  assert.deepEqual(sequence, []);
  let resolve!: (value: { url: string }) => void;
  plugin.prepare = async () => new Promise(done => { resolve = done; });
  const first = host.open(plugin.id, ctx);
  await assert.rejects(host.open(plugin.id, ctx), /already active/);
  let stopped = 0; plugin.stop = async () => { stopped++; };
  await host.cleanup(); resolve({ url: "http://localhost:3000" });
  await assert.rejects(first, /canceled/);
  assert.equal(stopped, 1); assert.deepEqual(sequence, []);
});
