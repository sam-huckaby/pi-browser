import assert from "node:assert/strict";
import test from "node:test";
import { browserKey, InspectionInputDecoder, maxInputText } from "../src/ui/inspection-input.ts";

const press = (key: string) => ({ kind: "action", action: { action: "press", key } });
const type = (text: string) => ({ kind: "action", action: { action: "type", text } });

test("printable text, Unicode, and IME commits are forwarded, including former r shortcut", () => {
  for (const text of ["r", "R", "hello world", "中文", "🚀", "+"]) assert.deepEqual(browserKey(text), type(text));
});

test("editing, navigation, and modifier keys map to Playwright key names", () => {
  for (const [input, key] of [
    ["\r", "Enter"], ["\t", "Tab"], ["\u001b[Z", "Shift+Tab"], ["\u007f", "Backspace"],
    ["\u001b[3~", "Delete"], ["\u001b[C", "ArrowRight"], ["\u001b[H", "Home"], ["\u001b[F", "End"],
    ["\u001b[5~", "PageUp"], ["\u001b[6~", "PageDown"], ["\u0001", "Control+a"], ["\u0003", "Control+c"],
    ["\u001b[97;9u", "Meta+a"], ["\u001b[1;5D", "Control+ArrowLeft"],
  ]) assert.deepEqual(browserKey(input!), press(key!));
});

test("Kitty printable, Shift, repeats, and xterm modifyOtherKeys are decoded", () => {
  assert.deepEqual(browserKey("\u001b[114;1u"), type("r"));
  assert.deepEqual(browserKey("\u001b[97:65;2u"), type("A"));
  assert.deepEqual(browserKey("\u001b[49:33;2u"), type("!"));
  assert.deepEqual(browserKey("\u001b[97;1:2u"), type("a"));
  assert.deepEqual(browserKey("\u001b[27;2;65~"), press("Shift+a"));
});

test("inspection controls are explicit, and unknown escape/release events never become text", () => {
  assert.deepEqual(browserKey("\u001b"), { kind: "close" });
  assert.deepEqual(browserKey("\u0011"), { kind: "close" });
  assert.deepEqual(browserKey("\u0012"), { kind: "refresh" });
  assert.equal(browserKey("\u001b[97;1:3u"), undefined);
  assert.equal(browserKey("\u001b[99999~"), undefined);
});

test("bracketed paste preserves multiline text and doesn't execute pasted shortcuts", () => {
  const decoder = new InspectionInputDecoder();
  assert.deepEqual(decoder.feed("\u001b[200~hello\r\n中文\n\u0012\u001b[201~"), [
    { kind: "action", action: { action: "type", text: "hello\n中文\n\u0012", paste: true } },
  ]);
});

test("paste can span chunks and handles input after the closing marker", () => {
  const decoder = new InspectionInputDecoder();
  assert.deepEqual(decoder.feed("\u001b[200~Hello "), []);
  assert.deepEqual(decoder.feed("world\u001b[20"), []);
  assert.deepEqual(decoder.feed("1~r"), [
    { kind: "action", action: { action: "type", text: "Hello world", paste: true } }, type("r"),
  ]);
});

test("oversized paste fails explicitly and resets the decoder for recovery", () => {
  const decoder = new InspectionInputDecoder();
  assert.throws(() => decoder.feed("\u001b[200~" + "x".repeat(maxInputText + 10)), /too large/);
  assert.deepEqual(decoder.feed("r"), [type("r")]);
});
