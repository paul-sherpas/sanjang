import { createServer } from "node:net";
import type { Camp, PortAllocation, PortStatus, PortsConfig } from "../types.ts";

const portConfig: PortsConfig = {
  fe: { base: 3000, slots: 8 },
  be: { base: 8000, slots: 8 },
};

export function setPortConfig(config: Partial<PortsConfig>): void {
  if (config?.fe) portConfig.fe = config.fe;
  if (config?.be) portConfig.be = config.be;
}

export function portsForSlot(slot: number): { fePort: number; bePort: number } {
  return {
    fePort: portConfig.fe.base + slot,
    bePort: portConfig.be.base + slot,
  };
}

function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(true));
    srv.once("listening", () => {
      srv.close(() => resolve(false));
    });
    srv.listen(port, "127.0.0.1");
  });
}

// --- 10-second cache ---
let _cache: PortStatus[] | null = null;
let _cacheTime = 0;
const CACHE_TTL = 10_000;

export async function scanPorts(): Promise<PortStatus[]> {
  const now = Date.now();
  if (_cache && now - _cacheTime < CACHE_TTL) return _cache;

  const maxSlots = Math.max(portConfig.fe.slots, portConfig.be.slots);
  const slots = Array.from({ length: maxSlots }, (_, i) => i);
  const results = await Promise.all(
    slots.map(async (slot) => {
      const { fePort, bePort } = portsForSlot(slot);
      const [feBusy, beBusy] = await Promise.all([probePort(fePort), probePort(bePort)]);
      return { slot, fePort, feBusy, bePort, beBusy };
    }),
  );

  _cache = results;
  _cacheTime = Date.now();
  return results;
}

export async function allocate(existingCamps: Pick<Camp, "slot" | "fePort" | "bePort">[]): Promise<PortAllocation> {
  const usedSlots = new Set(existingCamps.map((p) => p.slot));
  const usedFePorts = new Set(existingCamps.map((p) => p.fePort));
  const usedBePorts = new Set(existingCamps.map((p) => p.bePort));
  const maxSlots = portConfig.fe.slots;

  for (let slot = 1; slot < maxSlots; slot++) {
    if (usedSlots.has(slot)) continue;
    const { fePort, bePort } = portsForSlot(slot);
    if (usedFePorts.has(fePort) || usedBePorts.has(bePort)) continue;
    const [feBusy, beBusy] = await Promise.all([probePort(fePort), probePort(bePort)]);
    if (!feBusy && !beBusy) {
      return { slot, fePort, bePort };
    }
  }

  throw new Error("사용 가능한 포트가 없습니다. 다른 프로그램이 포트를 점유하고 있거나, 캠프를 정리해주세요.");
}

export function release(_name: string): void {}
