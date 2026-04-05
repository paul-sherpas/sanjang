import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { allocate, portsForSlot, setPortConfig } from "../lib/engine/ports.ts";

describe("ports", () => {
  // Use high port range to avoid collisions with running services
  const FE_BASE = 19000;
  const BE_BASE = 29000;

  it("returns correct ports for a slot", () => {
    setPortConfig({ fe: { base: FE_BASE, slots: 8 }, be: { base: BE_BASE, slots: 8 } });
    const { fePort, bePort } = portsForSlot(1);
    assert.equal(fePort, FE_BASE + 1);
    assert.equal(bePort, BE_BASE + 1);
  });

  it("allocates first free slot", () => {
    setPortConfig({ fe: { base: FE_BASE, slots: 8 }, be: { base: BE_BASE, slots: 8 } });
    const result = allocate([]);
    assert.equal(result.slot, 1);
    assert.equal(result.fePort, FE_BASE + 1);
  });

  it("skips used slots", () => {
    setPortConfig({ fe: { base: FE_BASE, slots: 8 }, be: { base: BE_BASE, slots: 8 } });
    const result = allocate([{ slot: 1, fePort: FE_BASE + 1, bePort: BE_BASE + 1 }]);
    assert.ok(result.slot > 1, `slot should be > 1, got ${result.slot}`);
    assert.ok(result.fePort > FE_BASE + 1);
  });

  it("skips slots whose ports collide with existing camps actual ports", () => {
    setPortConfig({ fe: { base: FE_BASE, slots: 8 }, be: { base: BE_BASE, slots: 8 } });
    // Camp at slot 3 but actually using port FE_BASE+2 (Vite fallback)
    const result = allocate([{ slot: 3, fePort: FE_BASE + 2, bePort: BE_BASE + 3 }]);
    // Slot 1 would give fePort FE_BASE+1 — no collision, should be allocated
    assert.equal(result.slot, 1);
    assert.equal(result.fePort, FE_BASE + 1);
  });

  it("avoids port collision even when slot is free", () => {
    setPortConfig({ fe: { base: FE_BASE, slots: 8 }, be: { base: BE_BASE, slots: 8 } });
    // Slot 1 is free, but its fePort is already used by another camp (via Vite fallback)
    const result = allocate([{ slot: 5, fePort: FE_BASE + 1, bePort: BE_BASE + 5 }]);
    // Should skip slot 1 (fePort collision) and pick slot 2
    assert.equal(result.slot, 2);
    assert.equal(result.fePort, FE_BASE + 2);
  });

  it("throws when all slots used", () => {
    setPortConfig({ fe: { base: FE_BASE, slots: 8 }, be: { base: BE_BASE, slots: 8 } });
    const all = Array.from({ length: 7 }, (_, i) => ({
      slot: i + 1,
      fePort: FE_BASE + i + 1,
      bePort: BE_BASE + i + 1,
    }));
    assert.throws(() => allocate(all), /포트/);
  });
});
