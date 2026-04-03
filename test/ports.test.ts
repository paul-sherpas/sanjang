import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { allocate, portsForSlot, setPortConfig } from "../lib/engine/ports.ts";

describe("ports", () => {
  it("returns correct ports for a slot", () => {
    setPortConfig({ fe: { base: 3000, slots: 8 }, be: { base: 8000, slots: 8 } });
    const { fePort, bePort } = portsForSlot(1);
    assert.equal(fePort, 3001);
    assert.equal(bePort, 8001);
  });

  it("allocates first free slot", () => {
    const result = allocate([]);
    assert.equal(result.slot, 1);
    assert.equal(result.fePort, 3001);
  });

  it("skips used slots", () => {
    const result = allocate([{ slot: 1 }]);
    assert.ok(result.slot > 1, `slot should be > 1, got ${result.slot}`);
    assert.ok(result.fePort > 3001);
  });

  it("throws when all slots used", () => {
    const all = Array.from({ length: 7 }, (_, i) => ({ slot: i + 1 }));
    assert.throws(() => allocate(all), /포트/);
  });
});
