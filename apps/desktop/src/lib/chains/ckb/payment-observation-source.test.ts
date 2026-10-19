import { afterEach, describe, expect, it, vi } from "vitest";
import { useNetworkConfigStore } from "@/stores/network-config";
import { connectPaymentObservation } from "./payment-observation-source";

const { host } = vi.hoisted(() => ({ host: {
  isStarted: vi.fn(() => true), currentNetwork: () => "testnet",
  paymentObservationReader: vi.fn(), onSessionChange: vi.fn(() => vi.fn()),
} }));
vi.mock("@/lib/light-client/client", () => ({ lightClient: () => host }));
afterEach(() => { useNetworkConfigStore.getState().setNetwork("testnet"); vi.clearAllMocks(); });

describe("observation source network boundary", () => {
  it("invalidates on configured network changes and unsubscribes without financial actions", async () => {
    const reader = { currentNetwork: () => "testnet", getTipHeader: vi.fn() };
    host.paymentObservationReader.mockReturnValue(reader);
    const source = await connectPaymentObservation();
    const changed = vi.fn();
    const unsubscribe = source.subscribe(changed);
    const identity = source.session();
    expect(identity).not.toBe(reader);
    expect(identity).not.toBeNull();
    expect(source.session()).toBe(identity);
    expect((await connectPaymentObservation()).session()).toBe(identity);
    useNetworkConfigStore.getState().setNetwork("mainnet");
    expect(changed).toHaveBeenCalledTimes(1);
    expect(source.session()).toBeNull();
    expect(await source.read("ckb:testnet", `0x${"ab".repeat(32)}`)).toMatchObject({ state: "uncertain" });
    expect(reader.getTipHeader).not.toHaveBeenCalled();
    unsubscribe();
    useNetworkConfigStore.getState().setNetwork("testnet");
    expect(changed).toHaveBeenCalledTimes(1);
  });
});
