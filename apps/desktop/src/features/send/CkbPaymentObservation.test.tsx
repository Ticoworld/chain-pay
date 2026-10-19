// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CkbPaymentObservation } from "./CkbPaymentObservation";
import type { PaymentObservation } from "@/lib/chains/ckb/observe-payment";
import { useSendsStore } from "@/stores/sends";
import { useSendConfirmationToAccounting } from "@/lib/send/use-send-confirmation-to-accounting";

const { postJournal } = vi.hoisted(() => ({ postJournal: vi.fn() }));
vi.mock("@/lib/accounting/ipc", () => ({ postJournal }));
const TX = `0x${"ab".repeat(32)}`;
const included: PaymentObservation = {
  state: "included", blockHash: TX, blockNumber: 100n,
  tipHash: TX, tipNumber: 102n, localDepth: 3n, checkedAt: Date.now(),
};
const uncertain: PaymentObservation = { state: "uncertain", reason: "Ancestry unavailable", checkedAt: Date.now() };

beforeEach(() => { vi.useFakeTimers(); postJournal.mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
async function enable() {
  await act(async () => { fireEvent.click(screen.getByRole("checkbox")); });
}

describe("send-history network observation", () => {
  it("polls only when enabled and drops an old inclusion when evidence disappears", async () => {
    const read = vi.fn().mockResolvedValueOnce(included).mockResolvedValue(uncertain);
    render(<CkbPaymentObservation chain="ckb:testnet" txHash={TX} read={read} />);
    expect(read).not.toHaveBeenCalled();
    await enable();
    expect(screen.getByRole("status").textContent).toMatch(/local depth 3/);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(screen.getByRole("status").textContent).toMatch(/Uncertain: Ancestry/);
    expect(screen.getByRole("status").textContent).not.toMatch(/depth 3/);
    await enable();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("withholds status while a request hangs and does not overlap polls", async () => {
    const read = vi.fn(() => new Promise<PaymentObservation>(() => undefined));
    const view = render(<CkbPaymentObservation chain="ckb:testnet" txHash={TX} read={read} />);
    await enable();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(read).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toMatch(/Still waiting/);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores a late response from an old payment or network", async () => {
    let resolveOld!: (value: PaymentObservation) => void;
    const read = vi.fn()
      .mockImplementationOnce(() => new Promise<PaymentObservation>((resolve) => { resolveOld = resolve; }))
      .mockResolvedValue(uncertain);
    const view = render(<CkbPaymentObservation chain="ckb:testnet" txHash={TX} read={read} />);
    await enable();
    await act(async () => { view.rerender(<CkbPaymentObservation chain="ckb:mainnet" txHash={TX} read={read} />); });
    await act(async () => { resolveOld(included); });
    expect(screen.getByRole("status").textContent).toMatch(/Uncertain/);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("leaves payment and journal state untouched even with the real accounting reactor mounted", async () => {
    useSendsStore.setState({ sends: [{
      id: "observed", sourceId: "source", chain: "ckb:testnet", txHash: TX as `0x${string}`,
      state: "broadcasted", outputs: [], feeShannons: 1000n,
      createdAt: "2026-10-19T00:00:00Z", updatedAt: "2026-10-19T00:00:00Z",
    }] });
    const before = useSendsStore.getState().sends;
    function Reactor() { useSendConfirmationToAccounting(); return null; }
    render(<><Reactor /><CkbPaymentObservation chain="ckb:testnet" txHash={TX} read={async () => included} /></>);
    await enable();
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(screen.getByRole("status").textContent).toMatch(/local depth 3/);
    expect(useSendsStore.getState().sends).toBe(before);
    expect(postJournal).not.toHaveBeenCalled();
  });
});
