import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripAnsi, buildDevCommand } from "../lib/engine/process-utils.ts";

describe("process-utils", () => {
  describe("stripAnsi", () => {
    it("strips color codes", () => {
      assert.equal(stripAnsi("\x1b[36mhttp://localhost:\x1b[1m3001\x1b[22m/\x1b[39m"), "http://localhost:3001/");
    });
    it("returns plain text unchanged", () => {
      assert.equal(stripAnsi("hello world"), "hello world");
    });
  });

  describe("buildDevCommand", () => {
    it("appends port flag directly for non-npm commands", () => {
      assert.equal(buildDevCommand("vite", "--port", 3001), "vite --port 3001");
    });
    it("adds -- separator for npm run", () => {
      assert.equal(buildDevCommand("npm run dev", "--port", 3001), "npm run dev -- --port 3001");
    });
    it("adds -- separator for yarn run", () => {
      assert.equal(buildDevCommand("yarn run dev", "--port", 3001), "yarn run dev -- --port 3001");
    });
    it("adds -- separator for pnpm run", () => {
      assert.equal(buildDevCommand("pnpm run dev", "--port", 3001), "pnpm run dev -- --port 3001");
    });
    it("returns command as-is when no port flag", () => {
      assert.equal(buildDevCommand("npm run dev", null, 3001), "npm run dev");
    });
  });
});
