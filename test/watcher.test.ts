import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { CampWatcher } from "../lib/engine/watcher.ts";

describe("CampWatcher", () => {
  let tempDir: string;
  let watcher: CampWatcher | null = null;

  afterEach(() => {
    watcher?.stop();
    watcher = null;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("calls onChange when a file is modified", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "watcher-test-"));
    const testFile = join(tempDir, "hello.txt");
    writeFileSync(testFile, "initial");

    let called = false;
    watcher = new CampWatcher(
      tempDir,
      () => {
        called = true;
      },
      100,
    );
    watcher.start();

    await new Promise((r) => setTimeout(r, 200));
    writeFileSync(testFile, "changed");
    await new Promise((r) => setTimeout(r, 300));

    assert.ok(called, "onChange should have been called");
  });

  it("debounces rapid changes into a single callback", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "watcher-test-"));
    const testFile = join(tempDir, "hello.txt");
    writeFileSync(testFile, "initial");

    let callCount = 0;
    watcher = new CampWatcher(
      tempDir,
      () => {
        callCount++;
      },
      200,
    );
    watcher.start();

    await new Promise((r) => setTimeout(r, 200));
    writeFileSync(testFile, "a");
    writeFileSync(testFile, "b");
    writeFileSync(testFile, "c");
    await new Promise((r) => setTimeout(r, 500));

    assert.ok(callCount <= 2, `Expected at most 2 calls, got ${callCount}`);
  });

  it("stop() prevents further callbacks", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "watcher-test-"));
    const testFile = join(tempDir, "hello.txt");
    writeFileSync(testFile, "initial");

    let called = false;
    watcher = new CampWatcher(
      tempDir,
      () => {
        called = true;
      },
      100,
    );
    watcher.start();
    watcher.stop();
    watcher = null;

    await new Promise((r) => setTimeout(r, 200));
    writeFileSync(testFile, "changed");
    await new Promise((r) => setTimeout(r, 300));

    assert.ok(!called, "onChange should not be called after stop");
  });
});
