import { describe, expect, it, vi } from "vitest";
const { client } = vi.hoisted(() => ({ client: {
  start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined),
  getTipHeader: vi.fn(async () => ({ number: 1n, timestamp: 1n })),
  getPeers: vi.fn(async () => []), getTransaction: vi.fn(async () => undefined),
  fetchTransaction: vi.fn(async () => ({ status: "added" })),
  getHeader: vi.fn(async () => undefined), fetchHeader: vi.fn(async () => ({ status: "added" })),
} }));
vi.mock("@nervosnetwork/ckb-light-client-js", () => ({
  LightClient: class { constructor() { return { ...client }; } },
  LightClientSetScriptsCommand: {}, randomSecretKey: () => `0x${"ab".repeat(32)}`,
}));
import { LightClientHost } from "./host";

describe("session-bound observation reader", () => {
  it("settles an observation query when stop terminates a native worker that never replies", async () => {
    const previousWindow = globalThis.window;
    Object.assign(globalThis, { window: { localStorage: { getItem: () => null, setItem: () => undefined } } });
    const host = new LightClientHost();
    try {
      await host.start("testnet");
      client.getTransaction.mockImplementationOnce(() => new Promise<undefined>(() => undefined));
      const read = host.paymentObservationReader().getTransaction("0x1234")
        .then(() => "completed", () => "interrupted");
      await Promise.resolve();
      expect(client.getTransaction).toHaveBeenCalledWith("0x1234");
      await host.stop();
      expect(await Promise.race([
        read, new Promise((resolve) => setTimeout(() => resolve("still pending"), 30)),
      ])).toBe("interrupted");
    } finally {
      await host.stop();
      Object.assign(globalThis, { window: previousWindow });
    }
  });

  it("delegates to LC queries and invalidates a reader on stop or same-network restart", async () => {
    const previousWindow = globalThis.window;
    Object.assign(globalThis, { window: { localStorage: { getItem: () => null, setItem: () => undefined } } });
    const host = new LightClientHost();
    try {
      await host.start("testnet");
      const reader = host.paymentObservationReader();
      expect(host.paymentObservationReader()).toBe(reader);
      const changed = vi.fn();
      const unsubscribe = host.onSessionChange(changed);
      expect(reader.currentNetwork()).toBe("testnet");
      await reader.fetchTransaction("0x1234");
      expect(client.fetchTransaction).toHaveBeenCalledWith("0x1234");
      await host.stop();
      expect(changed).toHaveBeenCalledTimes(1);
      expect(reader.currentNetwork()).toBeNull();
      await host.start("testnet");
      expect(changed).toHaveBeenCalledTimes(2);
      expect(reader.currentNetwork()).toBeNull();
      expect(host.paymentObservationReader().currentNetwork()).toBe("testnet");
      expect(host.paymentObservationReader()).not.toBe(reader);
      unsubscribe();
    } finally {
      await host.stop();
      Object.assign(globalThis, { window: previousWindow });
    }
  });
});
