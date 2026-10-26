import type { ChromiumBackend, BrowserSnapshot } from "../browser/backend.ts";
import type { DreamActivitySnapshot } from "./activity.ts";

export interface Point { x: number; y: number }
export interface Bounds extends Point { width: number; height: number }
export type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export interface DreamResizeHandle { handle: ResizeHandle; bounds: Bounds }
export interface DreamResizeSelection { token: string; handles: DreamResizeHandle[] }
export type DreamAction =
  | { action: "privacy"; enabled: boolean }
  | { action: "select" | "edit" | "context"; x?: number; y?: number }
  | { action: "drag"; from: Point; to: Point }
  | { action: "resize"; selection: string; handle: ResizeHandle; from: Point; to: Point }
  | { action: "text"; text: string }
  | { action: "key" | "menu-key"; key: string }
  | { action: "scroll"; x: number; y: number; deltaY: number; deltaX?: number }
  | { action: "copy" | "paste" | "delete" | "parent" | "commit" | "undo" | "redo" | "refresh" | "finish" | "resume" | "dismiss-menu" };

export interface DreamChange {
  kind: "move" | "resize" | "duplicate" | "text" | "delete";
  /** Private edit metadata is deliberately omitted; undo closures stay local. */
  private?: true;
  selector: string;
  before?: string;
  after?: string;
  from?: Bounds;
  to?: Bounds;
}
export type DreamMenuCommand = "copy" | "paste" | "duplicate" | "edit" | "parent" | "delete" | "undo" | "redo";
export interface DreamMenuItem { command: DreamMenuCommand; label: string; enabled: boolean }
export interface DreamMenuState { bounds: Bounds; items: DreamMenuItem[]; focused: number }

export interface DreamState {
  selected?: { selector: string; tag: string; bounds: Bounds; resize?: DreamResizeSelection };
  editing: boolean;
  menu?: DreamMenuState;
  canPaste: boolean;
  canUndo: boolean;
  canRedo: boolean;
  message: string;
  /** Expected interaction feedback, never an input-locking failure. */
  notice?: string;
  changes: DreamChange[];
}
export interface DreamFrame { snapshot: BrowserSnapshot; state: DreamState }
export interface DreamBackend {
  readonly privateMode?: boolean;
  setPrivate?(enabled: boolean, signal?: AbortSignal): Promise<BrowserSnapshot | undefined>;
  redactText?(value: string): string;
  open(url?: string, signal?: AbortSignal): Promise<DreamFrame>;
  openFromInspection?(source: ChromiumBackend, signal?: AbortSignal): Promise<DreamFrame>;
  apply(actions: DreamAction[], signal?: AbortSignal): Promise<DreamFrame>;
  close(): Promise<void>;
}
export interface DreamResult extends DreamFrame { canceled: boolean; activity?: DreamActivitySnapshot }
export interface DreamArtifact { screenshotPath: string; manifestPath: string; activityPath?: string }

export interface DreamEditor { dispatch(action: DreamAction): DreamState }
declare global { interface Window { __piBrowserDream?: DreamEditor } }
