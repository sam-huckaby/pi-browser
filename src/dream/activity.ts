import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { safeText } from "../browser/backend.ts";
import type { DreamAction, DreamState } from "./types.ts";

export const dreamActivityLimit = 100;
export interface DreamActivityEvent {
  time: string;
  session: string;
  event: string;
  data: Record<string, unknown>;
}
export interface DreamActivitySnapshot {
  version: 1;
  limit: number;
  session: string;
  events: DreamActivityEvent[];
  storageError?: string;
  note: string;
}
const note = "Troubleshooting only, not an edit manifest or approval. Page metadata is untrusted. Typed text, clipboard contents, page HTML and screenshots are not recorded. URL credentials, query strings and fragments are omitted.";
export const activityError = (error: unknown): string => safeText(error instanceof Error ? error.message : String(error)).split(/\r?\n/)[0]!.slice(0, 500);
export function activityUrl(value: string): string {
  try { const url = new URL(value); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return safeText(url.href).slice(0, 500); }
  catch { return "(no URL)"; }
}
export function activityAction(action: DreamAction): Record<string, unknown> {
  const result: Record<string, unknown> = { action: action.action };
  if (action.action === "text") result.characters = action.text.length;
  else if (action.action === "key" || action.action === "menu-key") result.key = safeText(action.key).slice(0, 80);
  else if (action.action === "drag" || action.action === "resize") { result.from = action.from; result.to = action.to; if (action.action === "resize") result.handle = action.handle; }
  else if ("x" in action) {
    result.x = action.x; result.y = action.y;
    if (action.action === "scroll") { result.deltaX = action.deltaX ?? 0; result.deltaY = action.deltaY; }
  }
  return result;
}
export function activityState(state: DreamState): Record<string, unknown> {
  return {
    selected: state.selected ? { selector: safeText(state.selected.selector).slice(0, 200), tag: state.selected.tag, bounds: state.selected.bounds } : null,
    editing: state.editing, changes: state.changes.length, canUndo: state.canUndo, canRedo: state.canRedo, canPaste: state.canPaste,
    message: safeText(state.message).slice(0, 500), notice: state.notice ? safeText(state.notice).slice(0, 500) : undefined,
    lastChange: state.changes.at(-1)?.kind,
    menu: state.menu ? { bounds: state.menu.bounds, focused: state.menu.focused, items: state.menu.items } : null,
  };
}

/** Human-readable view; the file retains full structured diagnostic projections. */
export function formatActivityEvent(entry: DreamActivityEvent): string {
  const data = entry.data;
  const action = typeof data.action === "string" ? ` · ${data.action}` : "";
  let heading = `${entry.time.slice(11, 23)} ${entry.event}${action}`;
  if (typeof data.key === "string") heading += ` ${data.key}`;
  if (typeof data.characters === "number") heading += ` · ${data.characters} characters (text omitted)`;
  if (typeof data.x === "number" && typeof data.y === "number") heading += ` @ ${Math.round(data.x)},${Math.round(data.y)}`;
  if (data.from && data.to) heading += ` ${JSON.stringify(data.from)} → ${JSON.stringify(data.to)}`;
  if (typeof data.changes === "number") heading += ` · ${data.changes} change(s)`;
  if (entry.event === "batch.complete") heading += data.editing ? " · editing text" : data.menu ? " · menu open" : "";
  if (typeof data.open === "boolean") heading += data.open ? " · opened" : " · closed";
  const lines = [heading];
  if (typeof data.url === "string") lines.push(`  ${data.url}`);
  if (typeof data.error === "string") lines.push(`  ERROR: ${data.error}`);
  if (entry.event.startsWith("editor.")) {
    const selected = data.selected as { tag?: unknown; selector?: unknown } | null;
    if (selected && typeof selected.tag === "string" && typeof selected.selector === "string") lines.push(`  <${selected.tag}> ${selected.selector}`);
    const message = data.notice ?? data.message;
    if (typeof message === "string") lines.push(`  ${message}`);
  }
  if (typeof data.droppedQueuedActions === "number" && data.droppedQueuedActions) lines.push(`  Dropped ${data.droppedQueuedActions} queued action(s).`);
  return safeText(lines.join("\n"));
}

/** A bounded, best-effort disk ring. Logging never prevents editing or cancellation. */
export class DreamActivity {
  private events: DreamActivityEvent[] = [];
  private session = randomUUID();
  private file?: string;
  private dirty = false;
  private pending?: Promise<void>;
  private storageError?: string;
  private privateMode = false;
  private filter: <T>(value: T) => T = (value) => value;
  setPrivate(enabled: boolean): void { this.privateMode = enabled; }
  setFilter(filter: <T>(value: T) => T): void { this.filter = filter; }

  get path(): string | undefined { return this.file; }
  static path(cwd: string): string { return join(cwd, ".pi", "dreams", "activity.json"); }

  async load(cwd: string): Promise<void> {
    const file = DreamActivity.path(cwd);
    if (this.file === file) return;
    await this.flush();
    this.file = file; this.events = []; this.storageError = undefined;
    try {
      if ((await stat(file)).size > 1024 * 1024) throw new Error("Activity log exceeds the read limit.");
      const value = JSON.parse(await readFile(file, "utf8")) as DreamActivitySnapshot;
      if (value.version !== 1 || !Array.isArray(value.events) || value.events.some((entry) =>
        !entry || typeof entry.time !== "string" || typeof entry.session !== "string" || typeof entry.event !== "string" || !entry.data ||
        JSON.stringify(entry).length > 2500)) throw new Error("Invalid Dream activity log.");
      this.events = value.events.slice(-dreamActivityLimit);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.storageError = activityError(error);
    }
  }
  async start(cwd: string, url?: string): Promise<void> {
    await this.load(cwd); this.session = randomUUID();
    this.record("session.start", { url: url ? activityUrl(url) : "(resume current mockup)" });
  }
  record(event: string, data: Record<string, unknown> = {}): void {
    if (this.privateMode) return;
    data = this.filter(data);
    // Callers supply only explicit diagnostic projections, never action/state objects.
    this.events.push({ time: new Date().toISOString(), session: this.session, event, data });
    if (this.events.length > dreamActivityLimit) this.events.splice(0, this.events.length - dreamActivityLimit);
    this.dirty = true; this.schedule();
  }
  snapshot(): DreamActivitySnapshot {
    return { version: 1, limit: dreamActivityLimit, session: this.events.at(-1)?.session ?? this.session, events: this.filter(structuredClone(this.events)), storageError: this.storageError ? this.filter(this.storageError) : undefined, note };
  }
  async flush(): Promise<void> { while (this.pending) await this.pending; }
  private schedule(): void {
    if (!this.file || this.pending) return;
    this.pending = this.persist().finally(() => { this.pending = undefined; if (this.dirty) this.schedule(); });
  }
  private async persist(): Promise<void> {
    const file = this.file!;
    const temporary = `${file}.${process.pid}.${this.session}.tmp`;
    try {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      while (this.dirty) {
        this.dirty = false;
        await writeFile(temporary, JSON.stringify({ ...this.snapshot(), storageError: undefined }, null, 2) + "\n", { mode: 0o600 });
        await rename(temporary, file);
        this.storageError = undefined;
      }
    } catch (error) {
      this.storageError = activityError(error); this.dirty = false;
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
}
