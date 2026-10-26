import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCapabilities, setCapabilities } from "@earendil-works/pi-tui";
import { BrowserPluginError, browserPluginFailure } from "../src/plugins/sdk.ts";
import { BrowserPlugins } from "../src/plugins/host.ts";
import { Inspections } from "../src/ui/inspection.ts";
import { privateMessage } from "../src/browser/privacy.ts";

test("diagnostics recognize allowlisted codes across copies and discard all raw error data", () => {
  for (const error of [new BrowserPluginError("PLUGIN_CHECKOUT"), { code: "PLUGIN_CHECKOUT", message: "SECRET_COOKIE", cause: "SECRET_TOKEN" }]) {
    const failure = browserPluginFailure(error);
    assert.equal(failure.code, "PLUGIN_CHECKOUT"); assert.doesNotMatch(failure.message, /SECRET/);
  }
  const unknown = browserPluginFailure({ code: "SECRET_COOKIE", message: "SECRET_TOKEN" });
  assert.equal(unknown.code, "PLUGIN_INSPECTION"); assert.doesNotMatch(unknown.message, /SECRET/);
  assert.equal(browserPluginFailure(new Error("net::ERR_CERT_DATE_INVALID at https://secret.test/?token=SECRET")).code, "PLUGIN_TLS_DATE");
  assert.equal(browserPluginFailure(new Error("net::ERR_CERT_AUTHORITY_INVALID SECRET")).code, "PLUGIN_TLS_TRUST");
});

test("private inspection preserves a safe TLS code but never releases its underlying message", async () => {
  const caps = getCapabilities(); setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
  const inspections = new Inspections({ privateMode: true, run: async () => { throw new Error("page.goto: net::ERR_CERT_DATE_INVALID at https://localhost:7445/?token=SECRET_TOKEN"); }, close: async () => {} });
  const ctx = { mode: "tui", ui: { custom: async (factory: Function) => factory({ mode: "fullscreen" }, {}, {}, () => {}) } } as unknown as ExtensionContext;
  try {
    await assert.rejects(inspections.open(ctx, "https://localhost:7445"), error => {
      assert.equal((error as Error).message, privateMessage);
      assert.equal(browserPluginFailure(error).code, "PLUGIN_TLS_DATE");
      assert.doesNotMatch(String(error), /SECRET_TOKEN|7445|ERR_CERT/); return true;
    });
    const host = new BrowserPlugins(inspections, async () => {});
    host.register({ id: "fixture", title: "Fixture", description: "Synthetic target", prepare: async () => ({ url: "https://localhost:7445" }) });
    await assert.rejects(host.open("fixture", ctx), error => {
      assert.equal(browserPluginFailure(error).code, "PLUGIN_TLS_DATE");
      assert.match(String(error), /restart the server/);
      assert.doesNotMatch(String(error), /SECRET_TOKEN|7445/); return true;
    });
  } finally { setCapabilities(caps); }
});
