import type { Locator, Page } from "playwright";

export const privateMessage = "Private mode is on. Page images, text, URLs and artifacts are withheld. Turn Private off in the browser toolbar to share the current page.";
export const passwordSelector = 'input[type="password"],input[autocomplete~="current-password" i],input[autocomplete~="new-password" i],input[data-pi-browser-password]';

/** Ephemeral policy and known password values. Never serialized or exposed as a tool. */
export class BrowserPrivacy {
  enabled = false;
  epoch = 0;
  private values = new Set<string>();
  private characters = 0;

  set(enabled: boolean): void { if (this.enabled !== enabled) { this.enabled = enabled; this.epoch++; } }
  clearSecrets(): void { this.values.clear(); this.characters = 0; }
  redact(value: string): string {
    const variants = [...this.values].flatMap((secret) => [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)]);
    if (!variants.length) return value;
    const pattern = [...new Set(variants)].sort((a, b) => b.length - a.length)
      .map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    return value.replace(new RegExp(pattern, "g"), "[password redacted]");
  }
  project<T>(value: T): T {
    if (typeof value === "string") return this.redact(value) as T;
    if (Array.isArray(value)) return value.map((item) => this.project(item)) as T;
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.project(item)])) as T;
    return value;
  }
  async accessibility(page: Page): Promise<string> {
    // Omit password controls entirely, rather than trusting their role or the
    // accessibility serializer's treatment of input.value. Restore real nodes.
    const handles = await page.locator(`${passwordSelector},[data-pi-browser-secret]`).elementHandles();
    const previous: Array<string | null> = [];
    try {
      for (const handle of handles) previous.push(await handle.evaluate((node) => {
        const element = node as Element;
        const value = element.getAttribute("aria-hidden"); element.setAttribute("aria-hidden", "true"); return value;
      }));
      return await page.locator("body").ariaSnapshot({ timeout: 5000 });
    } finally {
      for (const [index, handle] of handles.entries()) {
        if (index < previous.length) await handle.evaluate((node, value) => {
          const element = node as Element;
          if (value === null) element.removeAttribute("aria-hidden"); else element.setAttribute("aria-hidden", value);
        }, previous[index]!).catch(() => {});
        await handle.dispose().catch(() => {});
      }
    }
  }
  async collect(page: Page): Promise<Locator[]> {
    const masks: Locator[] = [];
    for (const frame of page.frames()) {
      if (frame.isDetached()) continue;
      const inputs = frame.locator(passwordSelector);
      try {
        const values = await inputs.evaluateAll((nodes) => nodes.map((node) => {
          // Remember fields after a site switches them to type=text (Show password).
          if (!node.hasAttribute("data-pi-browser-password")) node.setAttribute("data-pi-browser-password", "");
          return (node as HTMLInputElement).value;
        }));
        for (const value of values) {
          if (value && !this.values.has(value)) { this.values.add(value); this.characters += value.length; }
          if (this.values.size > 2000 || value.length > 100000 || this.characters > 1000000) throw new Error("Password filtering capacity exceeded.");
        }
        masks.push(frame.locator(`${passwordSelector},[data-pi-browser-secret]`));
      } catch {
        if (!frame.isDetached()) throw new Error("Could not safely filter password fields. No page output was released.");
      }
    }
    // Also cover exact, known password literals echoed into ordinary DOM text or
    // other controls. This is not OCR and cannot recognize transformed secrets.
    if (this.values.size) for (const frame of page.frames()) {
      if (frame.isDetached()) continue;
      try {
        await frame.locator("*").evaluateAll((nodes, secrets) => {
          for (const node of nodes) {
            if (["script", "style", "noscript", "template"].includes(node.localName)) continue;
            const texts = Array.from(node.childNodes).filter((child) => child.nodeType === Node.TEXT_NODE).map((child) => child.textContent ?? "");
            if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) texts.push(node.value);
            if (texts.some((text) => secrets.some((secret) => text.includes(secret))) && !node.hasAttribute("data-pi-browser-secret")) node.setAttribute("data-pi-browser-secret", "");
          }
        }, [...this.values]);
      } catch { if (!frame.isDetached()) throw new Error("Could not safely mask known password text. No page output was released."); }
    }
    return masks;
  }
}
