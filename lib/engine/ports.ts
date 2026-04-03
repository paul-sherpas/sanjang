import { execSync } from "node:child_process";
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

function isPortBusy(port: number): boolean {
  try {
    const out = execSync(`lsof -i :${port} -t 2>/dev/null`, { encoding: "utf8" }).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

export function scanPorts(): PortStatus[] {
  const status: PortStatus[] = [];
  const maxSlots = Math.max(portConfig.fe.slots, portConfig.be.slots);
  for (let slot = 0; slot < maxSlots; slot++) {
    const { fePort, bePort } = portsForSlot(slot);
    status.push({
      slot,
      fePort,
      feBusy: isPortBusy(fePort),
      bePort,
      beBusy: isPortBusy(bePort),
    });
  }
  return status;
}

export function allocate(existingCamps: Pick<Camp, "slot">[]): PortAllocation {
  const usedSlots = new Set(existingCamps.map((p) => p.slot));
  const maxSlots = portConfig.fe.slots;

  for (let slot = 1; slot < maxSlots; slot++) {
    if (usedSlots.has(slot)) continue;
    const { fePort, bePort } = portsForSlot(slot);
    if (!isPortBusy(fePort) && !isPortBusy(bePort)) {
      return { slot, fePort, bePort };
    }
  }

  throw new Error("사용 가능한 포트가 없습니다. 다른 프로그램이 포트를 점유하고 있거나, 캠프를 정리해주세요.");
}

export function release(_name: string): void {}
