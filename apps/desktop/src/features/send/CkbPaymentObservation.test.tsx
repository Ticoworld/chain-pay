// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CkbPaymentObservation } from "./CkbPaymentObservation";
import type { PaymentObservation } from "@/lib/chains/ckb/observe-payment";
import type { PaymentObservationSource } from "@/lib/chains/ckb/payment-observation-source";
import { useSendsStore } from "@/stores/sends";
import { useSendConfirmationToAccounting } from "@/lib/send/use-send-confirmation-to-accounting";

const { postJournal } = vi.hoisted(() => ({ postJournal: vi.fn() }));
vi.mock("@/lib/accounting/ipc", () => ({ postJournal }));
const TX = `0x${"ab".repeat(32)}` as const;
const included: PaymentObservation = {
  state: "included", blockHash: TX, blockNumber: 100n,
  tipHash: TX, tipNumber: 102n, localDepth: 3n, checkedAt: Date.parse("2026-10-19T12:00:00Z"),
};
const uncertain: PaymentObservation = { state: "uncertain", reason: "Ancestry unavailable", checkedAt: Date.now() };

function fixture() {
  let session: object | null = {};
  const listeners = new Set<() => void>();
  const read = vi.fn<PaymentObservationSource["read"]>().mockResolvedValue(included);
  const source: PaymentObservationSource = {
    read, session: () => session,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return {
    read, connect: async () => source, listeners,
    change(next: object | null) { session = next; for (const listener of listeners) listener(); },
  };
}
beforeEach(() => { vi.useFakeTimers(); postJournal.mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
async function enable() { await act(async () => { fireEvent.click(screen.getByRole("checkbox")); }); }
async function tick(milliseconds = 5_000) { await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); }); }

describe("send-history local observation", () => {
  it.each(["Ancestry unavailable", "Checking current ancestry exceeds the 64-block limit", "Conflicting ancestry"])(
    "keeps original historical evidence separately from an unavailable current check (%s)", async (reason) => {
      const workflow = fixture();
      workflow.read.mockResolvedValueOnce(included).mockResolvedValue({ ...uncertain, reason });
      render(<CkbPaymentObservation chain="ckb:testnet" txHash={TX} connect={workflow.connect} />);
      expect(workflow.read).not.toHaveBeenCalled();
      await enable();
      expect(screen.getByRole("status").textContent).toMatch(/Observed depth 3/);
      await tick();
      expect(screen.getByRole("status").textContent).toContain(reason);
      expect(screen.getByRole("status").textContent).not.toMatch(/depth 3/);
      const history = screen.getByLabelText("Last observed inclusion");
      expect(history.textContent).toMatch(/sampled tip 102; depth was 3/);
      expect(history.textContent).toMatch(/historical, not a current confirmation/);
      expect(history.textContent).toContain(new Date(included.checkedAt).toLocaleString());
      expect(screen.getByText(/Connectivity is unverified/)).toBeTruthy();
      await enable();
      await tick(30_000);
      expect(workflow.read).toHaveBeenCalledTimes(2);
      expect(workflow.listeners.size).toBe(0);
    },
  );

  it("invalidates immediately on stop, ignores old replies and qualifies history after restart", async () => {
    const workflow = fixture();
    const view = render(<CkbPaymentObservation chain="ckb:testnet" txHash={TX} connect={workflow.connect} />);
    await enable();
    let resolveOld!: (value: PaymentObservation) => void;
    workflow.read.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    await tick();
    await act(async () => { workflow.change(null); });
    expect(screen.getByRole("status").textContent).toMatch(/session or selected network changed/);
    expect(screen.getByLabelText("Last observed inclusion").textContent).toMatch(/previous or inactive/);
    workflow.read.mockResolvedValue(uncertain);
    await act(async () => { workflow.change({}); resolveOld(included); });
    await tick(0);
    expect(screen.getByRole("status").textContent).toMatch(/Ancestry unavailable/);
    expect(screen.getByLabelText("Last observed inclusion").textContent).toMatch(/previous or inactive/);
    workflow.read.mockResolvedValue({ ...included, localDepth: 5n });
    await tick();
    expect(screen.getByRole("status").textContent).toMatch(/Observed depth 5/);
    view.unmount();
    expect(workflow.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows waiting without overlapping a hung read and discards history for another payment/network", async () => {
    const workflow = fixture();
    const view = render(<CkbPaymentObservation chain="ckb:testnet" txHash={TX} connect={workflow.connect} />);
    await enable();
    workflow.read.mockImplementation(() => new Promise(() => {}));
    await tick();
    await tick(60_000);
    expect(workflow.read).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status").textContent).toMatch(/Still waiting/);
    expect(screen.getByLabelText("Last observed inclusion")).toBeTruthy();
    await act(async () => { view.rerender(<CkbPaymentObservation chain="ckb:mainnet" txHash={TX} connect={workflow.connect} />); });
    expect(screen.queryByLabelText("Last observed inclusion")).toBeNull();
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves payment and journal state untouched with the real accounting reactor mounted", async () => {
    const workflow = fixture();
    useSendsStore.setState({ sends: [{
      id: "observed", sourceId: "source", chain: "ckb:testnet", txHash: TX,
      state: "broadcasted", outputs: [], feeShannons: 1000n,
      createdAt: "2026-10-19T00:00:00Z", updatedAt: "2026-10-19T00:00:00Z",
    }] });
    const before = useSendsStore.getState().sends;
    function Reactor() { useSendConfirmationToAccounting(); return null; }
    render(<><Reactor /><CkbPaymentObservation chain="ckb:testnet" txHash={TX} connect={workflow.connect} /></>);
    await enable();
    await tick(15_000);
    expect(screen.getByRole("status").textContent).toMatch(/Observed depth 3/);
    expect(useSendsStore.getState().sends).toBe(before);
    expect(postJournal).not.toHaveBeenCalled();
  });
});
