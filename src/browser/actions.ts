import { Type, type Static } from "typebox";

const elementTarget = Type.Union([
  Type.Object({ selector: Type.String({ minLength: 1, description: "Playwright/CSS selector; must match exactly one element." }) }),
  Type.Object({
    role: Type.Union([Type.Literal("button"), Type.Literal("link"), Type.Literal("textbox"), Type.Literal("checkbox"), Type.Literal("radio"), Type.Literal("combobox"), Type.Literal("tab"), Type.Literal("menuitem"), Type.Literal("switch")]),
    name: Type.String({ description: "Exact accessible name from the page snapshot." }),
  }),
]);
const point = Type.Object({
  x: Type.Number({ minimum: 0, description: "Viewport CSS pixels, matching the screenshot." }),
  y: Type.Number({ minimum: 0, description: "Viewport CSS pixels, matching the screenshot." }),
});

export const BrowserActions = Type.Union([
  Type.Object({ action: Type.Literal("navigate"), url: Type.String({ description: "HTTP(S) URL, including localhost." }) }),
  Type.Object({ action: Type.Literal("click"), target: Type.Union([elementTarget, point]) }),
  Type.Object({ action: Type.Literal("fill"), target: elementTarget, text: Type.String({ description: "Replace the field's value. May contain sensitive data; it is recorded in the session." }) }),
  Type.Object({ action: Type.Literal("type"), text: Type.String({ maxLength: 100000, description: "Type into the focused control without replacing its value. Text is recorded in the session." }), paste: Type.Optional(Type.Boolean({ description: "Insert literal pasted text (including multiline text), rather than per-character key events." })) }),
  Type.Object({ action: Type.Literal("press"), key: Type.String({ minLength: 1, description: "Playwright key, e.g. Enter, Tab, ArrowDown, ControlOrMeta+A." }), target: Type.Optional(elementTarget) }),
  Type.Object({ action: Type.Literal("scroll"), deltaY: Type.Number({ minimum: -10000, maximum: 10000 }), deltaX: Type.Optional(Type.Number({ minimum: -10000, maximum: 10000 })), x: Type.Optional(Type.Number({ minimum: 0 })), y: Type.Optional(Type.Number({ minimum: 0 })) }),
  Type.Object({ action: Type.Literal("resize"), width: Type.Integer({ minimum: 320, maximum: 2560 }), height: Type.Integer({ minimum: 240, maximum: 1600 }) }),
  Type.Object({ action: Type.Literal("wait"), ms: Type.Integer({ minimum: 0, maximum: 10000, description: "Wait for asynchronous UI changes, then capture." }) }),
  Type.Object({ action: Type.Literal("screenshot") }),
  Type.Object({ action: Type.Literal("back") }),
  Type.Object({ action: Type.Literal("forward") }),
  Type.Object({ action: Type.Literal("reload") }),
  Type.Object({ action: Type.Literal("close") }),
]);

export type ElementTarget = Static<typeof elementTarget>;
export type BrowserAction = Static<typeof BrowserActions>;
