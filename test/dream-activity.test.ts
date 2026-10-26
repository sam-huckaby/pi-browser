import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DreamActivity, activityAction, dreamActivityLimit } from "../src/dream/activity.ts";

test("activity persists a bounded ring atomically, redacts text/URL secrets, and survives a fresh logger", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dream-activity-"));
  const log = new DreamActivity();
  try {
    await log.start(directory, "https://name:password@example.com/page?secret=QUERY-SECRET#FRAGMENT-SECRET");
    log.record("input", activityAction({ action: "text", text: "TYPED-SECRET" }));
    await log.flush();
    const first = await readFile(log.path!, "utf8");
    assert.doesNotMatch(first, /TYPED-SECRET|QUERY-SECRET|FRAGMENT-SECRET|password|name:/);
    assert.match(first, /https:\/\/example.com\/page/);
    assert.match(first, /characters/);
    for (let i = 0; i < 300; i++) log.record("test", { index: i });
    await log.flush();
    const snapshot = log.snapshot();
    assert.equal(snapshot.events.length, dreamActivityLimit);
    assert.equal(snapshot.events[0]!.data.index, 200);
    const info = await stat(log.path!); assert.equal(info.mode & 0o777, 0o600);
    assert.ok(info.size < 256 * 1024);
    snapshot.events.length = 0; assert.equal(log.snapshot().events.length, dreamActivityLimit);
    const reloaded = new DreamActivity(); await reloaded.load(directory);
    assert.deepEqual(reloaded.snapshot().events, log.snapshot().events);
    await reloaded.start(directory);
    await reloaded.flush();
    assert.equal(reloaded.snapshot().events.length, dreamActivityLimit);
    assert.equal(reloaded.snapshot().events.at(-1)!.event, "session.start");
    assert.notEqual(reloaded.snapshot().events.at(-1)!.session, reloaded.snapshot().events[0]!.session);
  } finally { await log.flush(); await rm(directory, { recursive: true, force: true }); }
});

test("activity storage failures are best-effort and retain diagnostics in memory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dream-activity-error-"));
  try {
    await writeFile(join(directory, ".pi"), "not a directory");
    const log = new DreamActivity(); await log.start(directory);
    log.record("view.error", { error: "Recoverable input failure" });
    await log.flush();
    assert.ok(log.snapshot().storageError);
    assert.equal(log.snapshot().events.at(-1)!.event, "view.error");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
