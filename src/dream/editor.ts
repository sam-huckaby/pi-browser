import type { Bounds, DreamAction, DreamChange, DreamMenuCommand, DreamMenuItem, DreamResizeSelection, DreamState, ResizeHandle } from "./types.ts";

/** Self-contained browser-side editor. No page text is ever interpreted as code. */
export function installDreamEditor(): void {
  if (window.__piBrowserDream) return;
  let active = false;
  let privateMode = false;
  const privateNodes = new WeakSet<HTMLElement>();
  let selected: HTMLElement | undefined;
  let message = "Click an element to select its DOM bounds.";
  let notice: string | undefined;
  let box: HTMLDivElement | undefined;
  let menu: { node: HTMLDivElement; origin: { x: number; y: number }; items: DreamMenuItem[]; focused: number } | undefined;
  let clipboard: { node: HTMLElement; bounds: Bounds; scrollX: number; scrollY: number; count: number } | undefined;
  let clipboardText = "";
  let clipboardTextPrivate = false;
  type TextField = HTMLInputElement | HTMLTextAreaElement;
  let editing: { node: HTMLElement; before: string; html: string; editable: string | null; spellcheck: string | null } | undefined;
  type History = { change: DreamChange; undo: () => void; redo: () => void; node: HTMLElement };
  const history: History[] = [];
  const future: History[] = [];
  let cloneSequence = 0;
  let selectionSequence = 0;
  const selectionTokens = new WeakMap<HTMLElement, string>();
  // Track identities, not original rectangles: undo/redo and ancestor movement
  // must be evaluated against the current rendered geometry on every hit-test.
  const repositioned = new Set<HTMLElement>();

  const bounds = (node: HTMLElement): Bounds => {
    const rect = node.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  };
  const selector = (node: HTMLElement): string => {
    if (node.dataset.piDreamClone) return `[data-pi-dream-clone="${node.dataset.piDreamClone}"]`;
    if (node.id) return `#${CSS.escape(node.id)}`.slice(0, 500);
    const parts: string[] = [];
    let current: HTMLElement | null = node;
    while (current && current !== document.body && parts.length < 6) {
      const tag = current.localName;
      const siblings = current.parentElement ? Array.from(current.parentElement.children).filter((child) => child.localName === tag) : [];
      parts.unshift(`${tag}${siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : ""}`);
      current = current.parentElement;
    }
    return parts.join(" > ").slice(0, 500);
  };
  const protectedField = (node: HTMLElement): boolean => node instanceof HTMLInputElement &&
    (node.type === "password" || node.autocomplete.toLowerCase().split(/\s+/).some((token) => ["current-password", "new-password"].includes(token)) || node.hasAttribute("data-pi-browser-password"));
  const field = (node: HTMLElement): node is TextField => !protectedField(node) && (node instanceof HTMLTextAreaElement ||
    (node instanceof HTMLInputElement && ["text", "search", "email", "url", "tel"].includes(node.type)));
  const text = (node: HTMLElement): string => field(node) ? node.value : node.innerText;
  const remember = (entry: History): void => {
    if (privateMode || privateNodes.has(entry.node)) {
      privateNodes.add(entry.node);
      entry.change = { kind: entry.change.kind, selector: "[private edit omitted]", private: true };
    }
    history.push(entry);
    if (history.length > 100) history.shift();
    future.length = 0;
  };
  const commit = (): void => {
    if (!editing) return;
    const { node, before, html, editable, spellcheck } = editing;
    const protectedNow = protectedField(node);
    const after = protectedNow ? "" : text(node);
    const afterHtml = protectedNow ? "" : node.innerHTML;
    editing = undefined;
    if (editable === null) node.removeAttribute("contenteditable"); else node.setAttribute("contenteditable", editable);
    if (spellcheck === null) node.removeAttribute("spellcheck"); else node.setAttribute("spellcheck", spellcheck);
    node.blur();
    window.getSelection()?.removeAllRanges();
    if (protectedNow) { message = "Password fields are protected; their values are not recorded."; return; }
    if (before !== after || (!field(node) && html !== afterHtml)) remember({ change: { kind: "text", selector: selector(node), before, after }, node,
      undo: () => { if (field(node)) node.value = before; else node.innerHTML = html; },
      redo: () => { if (field(node)) node.value = after; else node.innerHTML = afterHtml; } });
    message = "Text edit committed.";
  };
  const intersects = (a: Bounds, b: Bounds): boolean => a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0 &&
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  const containsPoint = (rect: Bounds, x: number, y: number): boolean => x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
  const transparent = (color: string): boolean => color === "transparent" || /^rgba\([^)]*,\s*0(?:\.0+)?\)$/.test(color) || /\/\s*0(?:\.0+)?%?\s*\)$/.test(color);
  const hasPaintWithin = (element: Element, clip: Bounds): boolean => {
    const style = getComputedStyle(element);
    if (style.display === "none" || Number(style.opacity) === 0) return false;
    const visible = style.visibility !== "hidden" && style.visibility !== "collapse";
    const rect = element.getBoundingClientRect();
    if (visible && intersects(rect, clip)) {
      if (!transparent(style.backgroundColor) || style.backgroundImage !== "none" || element instanceof SVGElement ||
        ["img", "input", "textarea", "select", "canvas", "video", "audio", "iframe", "object", "embed"].includes(element.localName)) return true;
      for (const pseudo of ["::before", "::after"]) {
        const decoration = getComputedStyle(element, pseudo);
        if (decoration.content !== "none" && decoration.content !== "normal" && decoration.display !== "none" &&
          (decoration.content !== '""' || !transparent(decoration.backgroundColor) || decoration.backgroundImage !== "none")) return true;
      }
      // Text belongs to its actual line boxes, not a now-empty ancestor's slot.
      for (const child of Array.from(element.childNodes)) {
        if (child.nodeType !== Node.TEXT_NODE || !child.textContent?.trim()) continue;
        const range = document.createRange(); range.selectNodeContents(child);
        if (Array.from(range.getClientRects()).some((line) => intersects(line, clip))) return true;
      }
    }
    return Array.from(element.children).some((child) => hasPaintWithin(child, clip));
  };
  const isEmptyMovedWrapper = (element: HTMLElement, x: number, y: number): boolean => {
    let affected = false;
    for (const moved of repositioned) {
      if (!moved.isConnected) { repositioned.delete(moved); continue; }
      if (moved !== element && element.contains(moved)) { affected = true; break; }
    }
    // Check the pointer, not the entire wrapper: another avatar or text elsewhere
    // in a row must not make an empty slot selectable. Decorative borders alone
    // also must not keep an empty avatar button alive. Real backgrounds do.
    return affected && !hasPaintWithin(element, { x, y, width: 0.01, height: 0.01 });
  };
  const at = (x?: number, y?: number): HTMLElement | undefined => {
    if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) return selected;
    const seen = new Set<HTMLElement>();
    for (const candidate of document.elementsFromPoint(x, y)) {
      let element: Element | null = candidate;
      // SVG icons select their containing HTML element. Main-document HTML only for now.
      while (element && !(element instanceof HTMLElement)) element = element.parentElement;
      if (!(element instanceof HTMLElement) || seen.has(element)) continue;
      seen.add(element);
      if (element === document.body || element === document.documentElement || element === box || menu?.node.contains(element) || isEmptyMovedWrapper(element, x, y)) continue;
      if (element.getRootNode() !== document || ["iframe", "canvas", "video", "audio", "object", "embed"].includes(element.localName) || element.localName.includes("-")) {
        notice = message = "Dream currently edits ordinary main-document HTML, not frames, media surfaces, or custom elements.";
        return undefined;
      }
      return element;
    }
    return undefined;
  };
  const resizeSupported = (node: HTMLElement): boolean => {
    if (node === document.body || node === document.documentElement || node.getRootNode() !== document || ["iframe", "canvas", "video", "audio", "object", "embed"].includes(node.localName) || node.localName.includes("-")) return false;
    // Pixel sizing assumes unscaled axes. Translation is fine; rotations,
    // perspective, zoom and scaled ancestors need a separate coordinate model.
    for (let ancestor: HTMLElement | null = node; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (style.display === "contents" || !["normal", "1"].includes(style.zoom) ||
        !["none", "0deg"].includes(style.rotate) || !["none", "1", "1 1", "1 1 1"].includes(style.scale)) return false;
      if (style.transform !== "none") {
        const matrix = new DOMMatrixReadOnly(style.transform);
        if (!matrix.is2D || Math.abs(matrix.a - 1) > 0.0001 || Math.abs(matrix.d - 1) > 0.0001 || Math.abs(matrix.b) > 0.0001 || Math.abs(matrix.c) > 0.0001) return false;
      }
    }
    const rect = bounds(node);
    return rect.width > 0 && rect.height > 0;
  };
  const resizeSelection = (): DreamResizeSelection | undefined => {
    if (!active || !selected?.isConnected || editing || menu || !resizeSupported(selected)) return undefined;
    let token = selectionTokens.get(selected);
    if (!token) { token = String(++selectionSequence); selectionTokens.set(selected, token); }
    const rect = bounds(selected);
    const points: Array<[ResizeHandle, number, number]> = [
      ["nw", rect.x, rect.y], ["n", rect.x + rect.width / 2, rect.y], ["ne", rect.x + rect.width, rect.y],
      ["e", rect.x + rect.width, rect.y + rect.height / 2], ["se", rect.x + rect.width, rect.y + rect.height],
      ["s", rect.x + rect.width / 2, rect.y + rect.height], ["sw", rect.x, rect.y + rect.height], ["w", rect.x, rect.y + rect.height / 2],
    ];
    const size = 16;
    return { token, handles: points.filter(([, x, y]) => x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight).map(([handle, x, y]) => ({ handle,
      bounds: { x: Math.max(0, Math.min(innerWidth - size, x - size / 2)), y: Math.max(0, Math.min(innerHeight - size, y - size / 2)), width: size, height: size } })) };
  };
  const redraw = (): void => {
    if (selected && !selected.isConnected) { selected = undefined; commit(); message = "The page replaced the selected element. Select it again."; }
    if (!active || !selected) { box?.remove(); return; }
    if (!box) {
      box = document.createElement("div");
      box.setAttribute("aria-hidden", "true");
      box.dataset.piDreamOverlay = "";
      box.style.cssText = "all:initial;position:fixed;box-sizing:border-box;pointer-events:none;z-index:2147483646;border:2px solid #8b5cf6;background:rgba(139,92,246,.055);border-radius:3px;";
    }
    const rect = bounds(selected);
    box.style.left = `${rect.x}px`;
    box.style.top = `${rect.y}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
    box.replaceChildren();
    for (const item of resizeSelection()?.handles ?? []) {
      const handle = document.createElement("div");
      handle.dataset.piDreamResize = item.handle;
      handle.style.cssText = `all:initial;position:fixed;box-sizing:border-box;pointer-events:none;left:${item.bounds.x}px;top:${item.bounds.y}px;width:${item.bounds.width}px;height:${item.bounds.height}px;background:#fff;border:2px solid #8b5cf6;border-radius:3px;`;
      box.append(handle);
    }
    if (!box.isConnected) document.documentElement.append(box);
  };
  const state = (): DreamState => {
    redraw();
    return { selected: selected ? { selector: selector(selected), tag: selected.localName, bounds: bounds(selected), resize: resizeSelection() } : undefined,
      editing: !!editing, menu: menu ? { bounds: bounds(menu.node), items: menu.items, focused: menu.focused } : undefined, canPaste: !!clipboard, canUndo: !!history.length, canRedo: !!future.length,
      message, notice, changes: history.map((entry) => entry.change) };
  };
  const requireSelected = (): HTMLElement => {
    if (!selected?.isConnected) throw new Error("Select an element first.");
    return selected;
  };
  const editableText = (node: HTMLElement): boolean => !protectedField(node) && (field(node) ||
    (Array.from(node.children).every((child) => child.localName === "br") && !!node.textContent?.trim()));
  const startEditing = (): void => {
    const node = selected?.isConnected ? selected : undefined;
    if (!node) { notice = message = notice ?? "No editable text here. Click an element to select it."; return; }
    if (protectedField(node)) { notice = message = "Password fields are protected; their values cannot be edited or copied in Dream."; return; }
    if (!editableText(node)) { notice = message = "This element is not plain text. It stays selected; drag to move it, or use Actions to copy/delete."; return; }
    if (text(node).length > 100000) { notice = message = "This text element is too large to edit."; return; }
    if (privateMode) privateNodes.add(node);
    editing = { node, before: text(node), html: node.innerHTML, editable: node.getAttribute("contenteditable"), spellcheck: node.getAttribute("spellcheck") };
    if (!field(node)) node.setAttribute("contenteditable", "plaintext-only");
    node.setAttribute("spellcheck", "false");
    node.focus({ preventScroll: true });
    if (field(node)) node.select();
    else {
      const range = document.createRange(); range.selectNodeContents(node);
      const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    }
    message = "Text selected. Type to replace it; Enter/Esc commits. Shift+Enter adds a line.";
  };
  const copy = (): void => {
    if (editing) {
      if (protectedField(editing.node)) { notice = message = "Password fields are protected; their values cannot be copied."; return; }
      clipboardTextPrivate = privateMode || privateNodes.has(editing.node);
      clipboardText = field(editing.node) && editing.node.selectionStart !== null
        ? editing.node.value.slice(editing.node.selectionStart, editing.node.selectionEnd ?? editing.node.selectionStart)
        : window.getSelection()?.toString() ?? "";
      message = "Text copied within Dream.";
      return;
    }
    const source = requireSelected();
    if (protectedField(source)) { notice = message = "Password fields are protected; their values cannot be copied."; return; }
    const originals = [source, ...Array.from(source.querySelectorAll<HTMLElement | SVGElement>("*"))];
    if (originals.length > 500) throw new Error("Copy a smaller element (maximum 500 DOM nodes).");
    if (originals.some((node) => !(node instanceof HTMLElement || node instanceof SVGElement) || node.localName.includes("-") || ["iframe", "canvas", "video", "audio", "object", "embed"].includes(node.localName))) throw new Error("Copy currently supports ordinary HTML and SVG icons, not embedded media, frames, or custom elements.");
    const clone = source.cloneNode(true) as HTMLElement;
    const copies = [clone, ...Array.from(clone.querySelectorAll<HTMLElement | SVGElement>("*"))];
    for (const [index, node] of copies.entries()) {
      const original = originals[index]!;
      const computed = getComputedStyle(original);
      for (const property of Array.from(computed)) {
        // This computed internal property would override contenteditable on duplicates.
        if (property !== "-webkit-user-modify") node.style.setProperty(property, computed.getPropertyValue(property));
      }
      node.style.setProperty("animation", "none", "important"); node.style.setProperty("transition", "none", "important");
      for (const attribute of Array.from(node.attributes)) if (/^on/i.test(attribute.name) || ["id", "autofocus", "contenteditable", "data-pi-dream-clone"].includes(attribute.name)) node.removeAttribute(attribute.name);
      if (node instanceof HTMLInputElement && original instanceof HTMLElement && protectedField(original)) {
        node.value = ""; node.removeAttribute("value"); node.setAttribute("data-pi-browser-password", "");
      } else if (original instanceof HTMLElement && node instanceof HTMLElement && field(original) && field(node)) node.value = original.value;
      if (node instanceof HTMLElement && (privateMode || privateNodes.has(source) || (original instanceof HTMLElement && privateNodes.has(original)))) privateNodes.add(node);
    }
    if (privateMode || originals.some((node) => node instanceof HTMLElement && privateNodes.has(node))) privateNodes.add(clone);
    for (const node of clone.querySelectorAll("script,style,link,meta,base")) node.remove();
    clipboard = { node: clone, bounds: bounds(source), scrollX: window.scrollX, scrollY: window.scrollY, count: 0 };
    message = `Copied ${selector(source)}. Paste creates an independent visual duplicate.`;
  };
  const paste = (destination?: { x: number; y: number }): void => {
    if (editing) { if (clipboardTextPrivate) privateNodes.add(editing.node); insertText(clipboardText); return; }
    if (!clipboard) throw new Error("Copy an element first.");
    const { bounds: rect, scrollX, scrollY } = clipboard;
    const offset = destination ? 0 : 24 * ++clipboard.count;
    const x = destination ? destination.x + window.scrollX : rect.x + scrollX + offset;
    const y = destination ? destination.y + window.scrollY : rect.y + scrollY + offset;
    const clone = clipboard.node.cloneNode(true) as HTMLElement;
    if (privateMode || privateNodes.has(clipboard.node)) {
      for (const node of [clone, ...clone.querySelectorAll<HTMLElement>("*")]) privateNodes.add(node);
    }
    clone.dataset.piDreamClone = String(++cloneSequence);
    const styles: Record<string, string> = { position: "absolute", inset: "auto", left: `${x}px`, top: `${y}px`,
      width: `${rect.width}px`, height: `${rect.height}px`, margin: "0", "box-sizing": "border-box", translate: "none", transform: "none", rotate: "none", scale: "none", "z-index": "2147483646" };
    for (const [key, value] of Object.entries(styles)) clone.style.setProperty(key, value, "important");
    document.body.append(clone);
    // Correct for a positioned body so the duplicate appears near the copied object.
    const placed = bounds(clone);
    clone.style.setProperty("left", `${parseFloat(clone.style.left) + x - window.scrollX - placed.x}px`, "important");
    clone.style.setProperty("top", `${parseFloat(clone.style.top) + y - window.scrollY - placed.y}px`, "important");
    selected = clone;
    remember({ change: { kind: "duplicate", selector: selector(clone), from: rect, to: bounds(clone) }, node: clone,
      undo: () => clone.remove(), redo: () => document.body.append(clone) });
    message = "Duplicate pasted and selected. Drag it into place.";
  };
  const insertText = (value: string): void => {
    if (!editing) { message = "Double-click a text element before typing."; return; }
    if (!value) return;
    const node = editing.node;
    const removed = field(node) && node.selectionStart !== null
      ? Math.max(0, (node.selectionEnd ?? node.selectionStart) - node.selectionStart)
      : window.getSelection()?.toString().length ?? 0;
    if (text(node).length - removed + value.length > 100000) throw new Error("Text limit is 100000 characters.");
    if (field(node) && node.selectionStart !== null) {
      node.setRangeText(value, node.selectionStart, node.selectionEnd ?? node.selectionStart, "end");
    } else if (!document.execCommand("insertText", false, value)) throw new Error("The browser could not insert text into this element.");
  };
  const drag = (action: Extract<DreamAction, { action: "drag" }>): void => {
    const hit = at(action.from.x, action.from.y);
    const insideSelection = selected?.isConnected && containsPoint(bounds(selected), action.from.x, action.from.y);
    if (!insideSelection || !hit || (selected !== hit && !selected!.contains(hit))) selected = hit;
    if (!selected) { message = "No visible element at the drag start."; return; }
    const node = requireSelected();
    const from = bounds(node);
    const dx = action.to.x - action.from.x, dy = action.to.y - action.from.y;
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.abs(dx) > 10000 || Math.abs(dy) > 10000) throw new Error("Invalid drag distance.");
    const before = node.style.getPropertyValue("translate");
    const priority = node.style.getPropertyPriority("translate");
    const computed = getComputedStyle(node).translate;
    const parts = computed === "none" ? ["0px", "0px"] : computed.split(/\s+/);
    if (parts.length > 3) throw new Error("Dragging complex CSS translate expressions is not supported yet.");
    const after = `calc(${parts[0]} + ${dx}px) calc(${parts[1] ?? "0px"} + ${dy}px)${parts[2] ? ` ${parts[2]}` : ""}`;
    node.style.setProperty("translate", after, "important");
    repositioned.add(node);
    remember({ change: { kind: "move", selector: selector(node), from, to: bounds(node) }, node,
      undo: () => { if (before) node.style.setProperty("translate", before, priority); else node.style.removeProperty("translate"); },
      redo: () => node.style.setProperty("translate", after, "important") });
    message = "Element repositioned visually; the original layout flow is unchanged.";
  };

  const resize = (action: Extract<DreamAction, { action: "resize" }>): void => {
    const target = resizeSelection();
    // Never hit-test and select another element for a resize. A gesture belongs
    // to one node identity, and must begin on its currently visible handle.
    const handle = target?.handles.find((item) => item.handle === action.handle);
    if (!target || target.token !== action.selection || !handle || !containsPoint(handle.bounds, action.from.x, action.from.y)) {
      notice = message = "Resize only the current selection: drag one of its visible handles."; return;
    }
    const dx = action.to.x - action.from.x, dy = action.to.y - action.from.y;
    if (![action.from.x, action.from.y, action.to.x, action.to.y, dx, dy].every(Number.isFinite) || Math.abs(dx) > 10000 || Math.abs(dy) > 10000) throw new Error("Invalid resize distance.");
    const horizontal = /[ew]/.test(action.handle), vertical = /[ns]/.test(action.handle);
    if ((!horizontal || dx === 0) && (!vertical || dy === 0)) return;
    const node = requireSelected();
    const from = bounds(node);
    const properties = ["display", "transition-property", "transition-duration", "transition-timing-function", "transition-delay", "transition-behavior", "translate", ...(horizontal ? ["width", "min-width", "max-width", "flex-grow", "flex-basis", "flex-shrink"] : []), ...(vertical ? ["height", "min-height", "max-height"] : [])];
    const styles = () => properties.map((name) => ({ name, value: node.style.getPropertyValue(name), priority: node.style.getPropertyPriority(name) }));
    const hadStyle = node.hasAttribute("style");
    const before = styles();
    const restore = (values: ReturnType<typeof styles>) => {
      for (const item of values) { if (item.value) node.style.setProperty(item.name, item.value, item.priority); else node.style.removeProperty(item.name); }
      if (!hadStyle && !node.style.length) node.removeAttribute("style");
    };
    try {
      const computedStyle = getComputedStyle(node);
      const display = computedStyle.display;
      const extraWidth = computedStyle.boxSizing === "border-box" ? 0 : ["paddingLeft", "paddingRight", "borderLeftWidth", "borderRightWidth"].reduce((sum, key) => sum + (parseFloat(computedStyle[key as keyof CSSStyleDeclaration] as string) || 0), 0);
      const extraHeight = computedStyle.boxSizing === "border-box" ? 0 : ["paddingTop", "paddingBottom", "borderTopWidth", "borderBottomWidth"].reduce((sum, key) => sum + (parseFloat(computedStyle[key as keyof CSSStyleDeclaration] as string) || 0), 0);
      node.style.setProperty("transition", "none", "important");
      if (display === "inline") node.style.setProperty("display", "inline-block", "important");
      if (horizontal) {
        const width = Math.max(16, Math.min(10000, from.width + (action.handle.includes("w") ? -dx : dx)));
        node.style.setProperty("width", `${Math.max(0, width - extraWidth)}px`, "important");
        node.style.setProperty("min-width", "0px", "important"); node.style.setProperty("max-width", "none", "important");
        node.style.setProperty("flex-grow", "0", "important"); node.style.setProperty("flex-basis", "auto", "important"); node.style.setProperty("flex-shrink", "0", "important");
      }
      if (vertical) {
        const height = Math.max(16, Math.min(10000, from.height + (action.handle.includes("n") ? -dy : dy)));
        node.style.setProperty("height", `${Math.max(0, height - extraHeight)}px`, "important");
        node.style.setProperty("min-height", "0px", "important"); node.style.setProperty("max-height", "none", "important");
      }
      const resized = bounds(node);
      const x = (action.handle.includes("w") ? from.x + from.width - resized.width : from.x) - resized.x;
      const y = (action.handle.includes("n") ? from.y + from.height - resized.height : from.y) - resized.y;
      if (Math.abs(x) > 0.001 || Math.abs(y) > 0.001) {
        const computed = getComputedStyle(node).translate;
        const parts = computed === "none" ? ["0px", "0px"] : computed.split(/\s+/);
        if (parts.length > 3) throw new Error("Resizing complex CSS translate expressions is not supported yet.");
        node.style.setProperty("translate", `calc(${parts[0]} + ${x}px) calc(${parts[1] ?? "0px"} + ${y}px)${parts[2] ? ` ${parts[2]}` : ""}`, "important");
      }
      const to = bounds(node), after = styles();
      if ([to.x, to.y, to.width, to.height].some((value) => !Number.isFinite(value))) throw new Error("Invalid resized bounds.");
      if (Math.abs(to.x - from.x) > 0.001 || Math.abs(to.y - from.y) > 0.001) repositioned.add(node);
      remember({ change: { kind: "resize", selector: selector(node), from, to }, node, undo: () => restore(before), redo: () => restore(after) });
      message = `Selection resized to ${Math.round(to.width)} × ${Math.round(to.height)}. Undo restores its original sizing.`;
    } catch (error) { restore(before); throw error; }
  };

  const deleteElement = (): void => {
    commit();
    const node = requireSelected();
    const parent = node.parentNode;
    if (!parent || node === document.body || node === document.documentElement) throw new Error("The document root cannot be deleted.");
    const next = node.nextSibling;
    const change: DreamChange = { kind: "delete", selector: selector(node), from: bounds(node) };
    // Retain the actual subtree (including fields/listeners), not a serialized copy.
    // Hit-testing can prune detached moved nodes; restore their identities on undo.
    const moved = Array.from(repositioned).filter((element) => node.contains(element));
    node.remove(); selected = undefined;
    remember({ change, node,
      undo: () => {
        if (!parent.isConnected) throw new Error("The page replaced this element's parent. It cannot be restored here.");
        parent.insertBefore(node, next?.parentNode === parent ? next : null);
        for (const element of moved) repositioned.add(element);
      },
      redo: () => node.remove() });
    message = "Element deleted from the mockup. Undo restores it.";
  };

  const closeMenu = (): void => { menu?.node.remove(); menu = undefined; };
  const paintMenuFocus = (): void => {
    if (!menu) return;
    Array.from(menu.node.querySelectorAll<HTMLButtonElement>("[data-pi-dream-menu-command]")).forEach((row, index) => {
      row.style.setProperty("background", index === menu!.focused ? "#ede9fe" : "transparent", "important");
      if (index === menu!.focused) row.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  };
  const openMenu = (x?: number, y?: number): void => {
    commit(); closeMenu();
    const rect = selected?.isConnected ? bounds(selected) : undefined;
    const point = {
      x: x ?? (rect ? rect.x + rect.width / 2 : window.innerWidth / 2),
      y: y ?? (rect ? rect.y + rect.height / 2 : window.innerHeight / 2),
    };
    point.x = Math.max(0, Math.min(window.innerWidth - 1, point.x));
    point.y = Math.max(0, Math.min(window.innerHeight - 1, point.y));
    // Toolbar/Shift+F10 act on the current selection; pointer context menus hit-test.
    if (x !== undefined && y !== undefined) {
      const hit = at(point.x, point.y);
      if (!(selected?.isConnected && hit && containsPoint(bounds(selected), point.x, point.y) && selected.contains(hit))) selected = hit;
    }
    const items: DreamMenuItem[] = [
      { command: "copy", label: "Copy", enabled: !!selected && !protectedField(selected) },
      { command: "paste", label: "Paste here", enabled: !!clipboard },
      { command: "duplicate", label: "Duplicate", enabled: !!selected && !protectedField(selected) },
      { command: "edit", label: "Edit text", enabled: !!selected && editableText(selected) },
      { command: "parent", label: "Select parent", enabled: !!selected?.parentElement && selected.parentElement !== document.body && selected.parentElement !== document.documentElement },
      { command: "delete", label: "Delete element", enabled: !!selected?.isConnected },
      { command: "undo", label: "Undo", enabled: !!history.length },
      { command: "redo", label: "Redo", enabled: !!future.length },
    ];
    const node = document.createElement("div");
    node.dataset.piDreamMenu = "";
    node.setAttribute("role", "menu"); node.setAttribute("aria-label", "Dream element actions");
    node.style.cssText = `all:initial;position:fixed;z-index:2147483647;box-sizing:border-box;width:${Math.min(236, window.innerWidth - 16)}px;max-height:${window.innerHeight - 16}px;overflow:auto;padding:6px;background:#fff;border:1px solid #d8d3e5;border-radius:12px;box-shadow:0 16px 48px #17213c30;pointer-events:auto;`;
    const title = document.createElement("div");
    title.textContent = selected ? selector(selected) : "Dream actions";
    title.style.cssText = "all:initial;display:block;padding:6px 10px 9px;color:#777085;font:11px/1.4 system-ui;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
    node.append(title);
    for (const item of items) {
      if (item.command === "undo") {
        const divider = document.createElement("div");
        divider.style.cssText = "all:initial;display:block;height:1px;background:#e9e5f0;margin:5px 4px;";
        node.append(divider);
      }
      const row = document.createElement("button");
      row.dataset.piDreamMenuCommand = item.command;
      row.setAttribute("role", "menuitem"); row.setAttribute("aria-disabled", String(!item.enabled));
      row.disabled = !item.enabled;
      row.textContent = item.label;
      row.style.cssText = `all:initial;display:block;box-sizing:border-box;width:100%;padding:8px 10px;border-radius:6px;color:${item.enabled ? "#241d36" : "#a9a4b1"};font:13px/1.4 system-ui;cursor:${item.enabled ? "pointer" : "not-allowed"};`;
      node.append(row);
    }
    document.documentElement.append(node);
    const size = node.getBoundingClientRect();
    node.style.left = `${Math.max(8, Math.min(point.x, window.innerWidth - size.width - 8))}px`;
    node.style.top = `${Math.max(8, Math.min(point.y, window.innerHeight - size.height - 8))}px`;
    menu = { node, origin: point, items, focused: items.findIndex((item) => item.enabled) };
    paintMenuFocus();
    message = "Element actions · click an item, use arrows/Enter, or Esc to dismiss.";
  };
  const chooseMenu = (command: DreamMenuCommand): void => {
    const item = menu?.items.find((entry) => entry.command === command);
    if (!item?.enabled || !menu) return;
    const origin = menu.origin;
    closeMenu();
    if (command === "paste") paste(origin);
    else if (command === "duplicate") { copy(); paste(); }
    else window.__piBrowserDream!.dispatch({ action: command });
  };
  const clickMenu = (x?: number, y?: number): void => {
    if (!menu || x === undefined || y === undefined) { closeMenu(); return; }
    const hit = document.elementFromPoint(x, y);
    if (!hit || !menu.node.contains(hit)) { closeMenu(); message = "Menu dismissed."; return; }
    const row = hit.closest<HTMLElement>("[data-pi-dream-menu-command]");
    const item = menu.items.find((entry) => entry.command === row?.dataset.piDreamMenuCommand);
    if (item) chooseMenu(item.command);
  };
  const menuKey = (key: string): void => {
    if (!menu) return;
    if (key === "Escape") { closeMenu(); message = "Menu dismissed."; return; }
    if (key === "Enter") { const item = menu.items[menu.focused]; if (item) chooseMenu(item.command); return; }
    if (key === "Delete" || key === "Backspace") { chooseMenu("delete"); return; }
    const shortcut = /^(?:Control|Meta)\+(c|v|z)$/i.exec(key)?.[1]?.toLowerCase();
    if (shortcut) { chooseMenu(shortcut === "c" ? "copy" : shortcut === "v" ? "paste" : "undo"); return; }
    if (/^(?:Control|Meta)\+Shift\+z$/i.test(key)) { chooseMenu("redo"); return; }
    const enabled = menu.items.map((item, index) => item.enabled ? index : -1).filter((index) => index >= 0);
    if (!enabled.length) return;
    const current = enabled.indexOf(menu.focused);
    if (key === "Home") menu.focused = enabled[0]!;
    else if (key === "End") menu.focused = enabled.at(-1)!;
    else if (["ArrowDown", "Tab", "ArrowUp", "Shift+Tab"].includes(key)) {
      const direction = key === "ArrowUp" || key === "Shift+Tab" ? -1 : 1;
      menu.focused = enabled[(current + direction + enabled.length) % enabled.length]!;
    }
    paintMenuFocus();
  };

  // Installed before page scripts. Block app event handlers during editing, while
  // allowing the browser's native text/cursor defaults. DOM selection never clicks links.
  for (const type of ["keydown", "keyup", "beforeinput", "input", "change", "click", "dblclick", "submit", "focusin", "focusout"]) {
    window.addEventListener(type, (event) => {
      if (!active) return;
      event.stopImmediatePropagation();
      if (["click", "dblclick", "submit"].includes(type)) event.preventDefault();
    }, true);
  }
  window.addEventListener("scroll", redraw, true);
  window.addEventListener("resize", redraw);
  window.__piBrowserDream = {
    dispatch(action): DreamState {
      if (action.action === "privacy") {
        privateMode = action.enabled;
        if (privateMode && editing) privateNodes.add(editing.node);
        return state();
      }
      if (action.action !== "refresh") notice = undefined;
      if (action.action === "resume") { closeMenu(); active = true; message = "Click an element to select its DOM bounds."; return state(); }
      if (!active && action.action !== "finish" && action.action !== "refresh") throw new Error("Dream is not active. Reopen /dream.");
      if (action.action === "resize") { resize(action); return state(); }
      if (action.action === "context") { openMenu(action.x, action.y); return state(); }
      if (action.action === "dismiss-menu") { if (menu) { closeMenu(); message = "Menu dismissed."; } return state(); }
      if (action.action === "menu-key") { menuKey(action.key); return state(); }
      if (menu && (action.action === "select" || action.action === "edit")) { clickMenu(action.x, action.y); return state(); }
      if (menu && action.action === "text") return state();
      if (!["refresh", "text"].includes(action.action)) closeMenu();
      if (action.action === "select" || action.action === "edit") {
        commit(); selected = at(action.x, action.y);
        if (!notice) message = selected ? `Selected ${selector(selected)}. Drag, copy, or double-click text.` : "Selection cleared.";
        if (action.action === "edit") startEditing();
      } else if (action.action === "text") insertText(action.text);
      else if (action.action === "copy") copy();
      else if (action.action === "paste") paste();
      else if (action.action === "delete") deleteElement();
      else if (action.action === "refresh") { /* Only recapture. */ }
      else if (action.action === "commit") commit();
      else if (action.action === "finish") { commit(); active = false; selected = undefined; box?.remove(); }
      else if (action.action === "parent") { commit(); const parent = requireSelected().parentElement; if (parent && parent !== document.body && parent !== document.documentElement) selected = parent; }
      else if (action.action === "drag") { commit(); drag(action); }
      else if (action.action === "undo" || action.action === "redo") {
        commit();
        const undo = action.action === "undo";
        const stack = undo ? history : future;
        const entry = stack.at(-1);
        if (entry) { if (undo) entry.undo(); else entry.redo(); stack.pop(); (undo ? future : history).push(entry); selected = entry.node.isConnected ? entry.node : undefined; }
        message = undo ? "Undid the last edit." : "Redid the last edit.";
      }
      return state();
    },
  };
}

/** Scope tsx's function-name helper alongside the serialized trusted function. */
export function dreamEditorScript(): string {
  return `(() => { const __name = (value) => value; (${installDreamEditor.toString()})(); })()`;
}
