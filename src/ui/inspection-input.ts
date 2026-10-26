import { decodeKittyPrintable, isKeyRelease, Key, matchesKey, parseKey } from "@earendil-works/pi-tui";
import type { BrowserAction } from "../browser/actions.ts";

export type InspectionInput = { kind: "action"; action: BrowserAction } | { kind: "close" | "refresh" };
const pasteStart = "\u001b[200~";
const pasteEnd = "\u001b[201~";
export const maxInputText = 100000;
const keyNames: Record<string, string> = {
  escape: "Escape", enter: "Enter", return: "Enter", tab: "Tab", space: "Space",
  backspace: "Backspace", delete: "Delete", insert: "Insert", home: "Home", end: "End",
  pageUp: "PageUp", pageDown: "PageDown", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
};
const modifiers: Record<string, string> = { ctrl: "Control", alt: "Alt", shift: "Shift", super: "Meta" };

/** Pi parses the terminal protocol; we translate its key IDs into Playwright keys. */
export function browserKey(data: string): InspectionInput | undefined {
  if (isKeyRelease(data)) return undefined;
  if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("q"))) return { kind: "close" };
  if (matchesKey(data, Key.ctrl("r"))) return { kind: "refresh" };
  const parsed = parseKey(data);
  let base = parsed ?? "";
  const mods: string[] = [];
  while (true) {
    const match = /^(ctrl|alt|shift|super)\+/.exec(base);
    if (!match) break;
    mods.push(modifiers[match[1]!]!);
    base = base.slice(match[0].length);
  }
  const named = keyNames[base] ?? (/^f(?:[1-9]|1[0-2])$/.test(base) ? base.toUpperCase() : undefined);
  if (named) return { kind: "action", action: { action: "press", key: [...mods, named].join("+") } };
  if (mods.some((mod) => mod !== "Shift")) {
    if ([...base].length === 1) return { kind: "action", action: { action: "press", key: [...mods, base].join("+") } };
    return undefined;
  }
  const decoded = decodeKittyPrintable(data);
  // xterm modifyOtherKeys isn't exposed by Pi's printable decoder; its parsed
  // ASCII key ID can still be forwarded with the original modifiers.
  if (!decoded && data.startsWith("\u001b") && parsed && [...base].length === 1) {
    return { kind: "action", action: { action: "press", key: [...mods, base].join("+") } };
  }
  const text = decoded ?? data;
  // Never insert raw terminal control sequences. Accept Unicode/IME commits too.
  if (text && !/[\u0000-\u001f\u007f-\u009f]/u.test(text) && !/[\ue000-\uf8ff]/u.test(decoded ?? "")) {
    return { kind: "action", action: { action: "type", text } };
  }
  return undefined;
}

/** Bracketed paste can span chunks; pasted shortcuts must remain literal text. */
export class InspectionInputDecoder {
  private paste?: string;

  feed(data: string): InspectionInput[] {
    if (this.paste !== undefined) {
      this.paste += data;
      const end = this.paste.indexOf(pasteEnd);
      if (end === -1) {
        if (this.paste.length > maxInputText + pasteEnd.length) this.tooLong();
        return [];
      }
      const text = this.paste.slice(0, end).replace(/\r\n?/g, "\n");
      const rest = this.paste.slice(end + pasteEnd.length);
      this.paste = undefined;
      if (text.length > maxInputText) this.tooLong();
      return [
        ...(text ? [{ kind: "action" as const, action: { action: "type" as const, text, paste: true } }] : []),
        ...this.feed(rest),
      ];
    }
    const start = data.indexOf(pasteStart);
    if (start !== -1) {
      const prefix = this.feed(data.slice(0, start));
      this.paste = "";
      return [...prefix, ...this.feed(data.slice(start + pasteStart.length))];
    }
    if (data.length > maxInputText) this.tooLong();
    const input = browserKey(data);
    return input ? [input] : [];
  }

  private tooLong(): never {
    this.paste = undefined;
    throw new Error(`Input is too large (maximum ${maxInputText} characters).`);
  }
}
