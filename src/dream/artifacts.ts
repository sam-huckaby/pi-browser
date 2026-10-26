import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DreamArtifact, DreamResult } from "./types.ts";

/** Durable goal artifacts, not application source edits or exported executable HTML. */
export async function saveDream(cwd: string, result: DreamResult): Promise<DreamArtifact> {
  if (result.snapshot.private) throw new Error("Private mode: goal artifacts are withheld. Turn Private off before saving.");
  if (result.canceled) throw new Error("A canceled Dream is not a completed goal.");
  const root = join(cwd, ".pi", "dreams");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, `${new Date().toISOString().replace(/[:.]/g, "-")}-`));
  const screenshotPath = join(directory, "goal.png");
  const manifestPath = join(directory, "changes.json");
  const activityPath = result.activity ? join(directory, "activity.json") : undefined;
  await writeFile(screenshotPath, result.snapshot.png, { mode: 0o600 });
  await writeFile(manifestPath, JSON.stringify({
    version: 1, createdAt: new Date().toISOString(), url: result.snapshot.url,
    viewport: result.snapshot.viewport, scroll: result.snapshot.scroll,
    screenshot: "goal.png", changes: result.state.changes,
    activityLog: activityPath ? "activity.json" : undefined,
    note: "User-created visual mockup. DOM-only edits, not source changes or approval.",
  }, null, 2) + "\n", { mode: 0o600 });
  if (activityPath) await writeFile(activityPath, JSON.stringify(result.activity, null, 2) + "\n", { mode: 0o600 });
  return { screenshotPath, manifestPath, activityPath };
}
