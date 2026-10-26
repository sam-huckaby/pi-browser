import type { Terminal } from "@earendil-works/pi-tui";

/** Native Pi renderer input harness, not a desktop terminal or OS input recorder. */
export class VirtualTerminal implements Terminal {
  columns = 120;
  rows = 40;
  kittyProtocolActive = true;
  onInput?: (data: string) => void;
  onResize?: () => void;
  writes: string[] = [];
  start(onInput: (data: string) => void, onResize: () => void): void { this.onInput = onInput; this.onResize = onResize; }
  stop(): void { this.onInput = undefined; this.onResize = undefined; }
  async drainInput(): Promise<void> {}
  write(data: string): void { this.writes.push(data); }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  click(x: number, y: number): void {
    this.onInput?.(`\u001b[<0;${x + 1};${y + 1}M`);
    this.onInput?.(`\u001b[<0;${x + 1};${y + 1}m`);
  }
  rightClick(x: number, y: number): void {
    this.onInput?.(`\u001b[<2;${x + 1};${y + 1}M`);
    this.onInput?.(`\u001b[<2;${x + 1};${y + 1}m`);
  }
  wheel(x: number, y: number, down = true, shift = false): void {
    this.onInput?.(`\u001b[<${(down ? 65 : 64) + (shift ? 4 : 0)};${x + 1};${y + 1}M`);
  }
}
