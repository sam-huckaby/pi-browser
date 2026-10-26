import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Value } from "typebox/value";
import browserExtension from "../src/index.ts";
import { BrowserActions } from "../src/browser/actions.ts";
import { safeText, type BrowserSnapshot } from "../src/browser/backend.ts";
import { createBrowserTool } from "../src/browser/tool.ts";
import { parseBrowserUrl } from "../src/browser/url.ts";
import { BrowserView } from "../src/ui/browser-view.ts";

const snapshot: BrowserSnapshot = {
  title: "Browser 中文 🚀", url: "https://example.com/", viewport: { width: 1, height: 1 },
  scroll: { x: 0, y: 0 }, accessibility: '- button "Save"', screenshotPath: "/tmp/browser.png",
  png: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=", "base64"),
};

test("URLs are optional and normalized, including localhost", () => {
  assert.equal(parseBrowserUrl("  "), undefined);
  assert.equal(parseBrowserUrl(" https://example.com "), "https://example.com/");
  assert.equal(parseBrowserUrl("http://localhost:3000/page?q=hello#top"), "http://localhost:3000/page?q=hello#top");
});

test("invalid, unsafe, and credential-bearing URLs are rejected", () => {
  for (const value of ["example.com", "not a url", "file:///etc/passwd", "javascript:alert(1)", "https://user:secret@example.com", "https://example.com/\u001b[31m", "https://example.com/a b"]) {
    assert.throws(() => parseBrowserUrl(value), Error, value);
  }
});

test("tool schema validates action-specific parameters", () => {
  for (const action of [
    { action: "navigate", url: "http://localhost:3000" },
    { action: "click", target: { role: "button", name: "Save" } },
    { action: "click", target: { x: 20, y: 40 } },
    { action: "fill", target: { selector: "#name" }, text: "Ada" },
    { action: "type", text: "typing" }, { action: "type", text: "line one\nline two", paste: true },
    { action: "press", key: "Enter" }, { action: "scroll", deltaY: 500 },
    { action: "resize", width: 800, height: 600 }, { action: "screenshot" },
  ]) assert.ok(Value.Check(BrowserActions, action));
  for (const action of [
    { action: "navigate" }, { action: "click" }, { action: "fill", target: { x: 2, y: 3 }, text: "x" },
    { action: "type" }, { action: "type", text: "x".repeat(100001) },
    { action: "resize", width: 99999, height: 800 }, { action: "wait", ms: 20000 },
    { action: "click", target: { role: "imaginary", name: "Save" } },
  ]) assert.equal(Value.Check(BrowserActions, action), false);
});

test("screenshots reach the model as image blocks and not duplicated in details", async () => {
  const tool = createBrowserTool({ run: async () => snapshot, close: async () => {} });
  const result = await tool.execute("test", { action: "screenshot" }, undefined, undefined, {} as never);
  assert.deepEqual(result.content[1], { type: "image", mimeType: "image/png", data: snapshot.png.toString("base64") });
  assert.equal("png" in result.details, false);
  assert.equal((result.details as { screenshotPath: string }).screenshotPath, snapshot.screenshotPath);
});

test("close returns no image", async () => {
  const tool = createBrowserTool({ run: async () => undefined, close: async () => {} });
  const result = await tool.execute("test", { action: "close" }, undefined, undefined, {} as never);
  assert.deepEqual(result.details, { closed: true });
  assert.equal(result.content.some((item) => item.type === "image"), false);
});

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;

test("read-only viewer handles narrow widths and close keys", () => {
  let closed = 0;
  const view = new BrowserView(snapshot, theme, () => closed++);
  for (const width of [0, 1, 2, 10, 40, 80]) {
    for (const line of view.render(width)) assert.ok(visibleWidth(line) <= width);
  }
  view.handleInput("x");
  assert.equal(closed, 0);
  view.handleInput("\u001b");
  view.handleInput("\r");
  assert.equal(closed, 2);
  view.invalidate();
});

test("terminal controls are stripped from page metadata", () => {
  assert.equal(safeText("hello\u001b[31m\u0007\u009bworld\n"), "hello[31mworld\n");
});

test("extension registers browser tool, preview command, and lifecycle cleanup", () => {
  const commands: string[] = [], events: string[] = [], tools: string[] = [], renderers: string[] = [];
  const pi = {
    registerCommand: (name: string) => commands.push(name),
    registerTool: (tool: { name: string }) => tools.push(tool.name),
    registerMessageRenderer: (name: string) => renderers.push(name),
    on: (event: string) => events.push(event),
    events: { on: () => () => {} },
  } as unknown as ExtensionAPI;
  browserExtension(pi);
  assert.deepEqual(commands, ["browser-plugins", "browser-plugin", "inspect", "dream-log", "dream", "browser"]);
  assert.deepEqual(renderers, ["dream-result"]);
  assert.deepEqual(tools, ["browser", "browser_inspect", "browser_plugin"]);
  assert.deepEqual(events, ["session_start", "session_shutdown"]);
});
