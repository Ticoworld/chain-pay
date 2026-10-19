// @vitest-environment jsdom
//
// Characterization tests for PayPanel's payroll-batch lifecycle, resume
// hydration and FX column. Draft/build/packet/broadcast live in
// PayPanel.test.tsx. Shared fixtures/harness: PayPanel.fixtures.tsx.
//
// These pin CURRENT behaviour, including behaviour that is wrong. Anything
// marked BUG PIN is a real defect recorded on purpose so the Task 14/15 split
// can be proven behaviour-preserving. Do not "fix" a pinned bug while
// splitting the component.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const listCellsForLock = vi.hoisted(() => vi.fn());
const broadcastTransaction = vi.hoisted(() => vi.fn());
const assertGuardSpy = vi.hoisted(() => vi.fn());
const dumpInputsSpy = vi.hoisted(() => vi.fn());

// Same boundary mocks as PayPanel.test.tsx — see the comment there. Mock
// registration is per-file in Vitest, so it cannot live in the fixtures module.
vi.mock("@/lib/light-client/client", () => ({
  lightClient: () => ({
    listCellsForLock,
    broadcastTransaction,
    onSnapshot: vi.fn(),
    onError: vi.fn(),
    isStarted: () => false,
    currentNetwork: () => null,
    start: vi.fn(),
    stop: vi.fn(),
    setBroadcastRpcUrl: vi.fn(),
    getBroadcastRpcUrl: () => "",
  }),
}));
vi.mock("@/lib/chains/ckb/tx-builder", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chains/ckb/tx-builder")>()),
  buildPaymentSkeleton: vi.fn(),
}));
vi.mock("@/lib/chains/ckb/transfer-packet", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chains/ckb/transfer-packet")>()),
  encodeTransferPacket: vi.fn(),
  treasurySighashDigest: vi.fn(),
}));
vi.mock("@/lib/chains/ckb/merge-signatures", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chains/ckb/merge-signatures")>()),
  mergeSignatures: vi.fn(),
}));
vi.mock("@/lib/fx/coingecko", async (importOriginal) => ({
  // fiatToCkbShannons / formatFxQuote stay REAL — the FX tests assert amounts
  // that production arithmetic computed, not numbers the test invented.
  ...(await importOriginal<typeof import("@/lib/fx/coingecko")>()),
  fetchCkbPrices: vi.fn(),
}));
vi.mock("@/lib/chains/ckb/multisig-assert", () => ({
  assertMultisigBytesMatchTreasury: assertGuardSpy,
  dumpInputsForInspection: dumpInputsSpy,
}));

import { hexFrom } from "@ckb-ccc/core";
import type { PayrollBatch } from "@chain-pay/shared";
import { buildPaymentSkeleton } from "@/lib/chains/ckb/tx-builder";
import { encodeTransferPacket } from "@/lib/chains/ckb/transfer-packet";
import { fetchCkbPrices } from "@/lib/fx/coingecko";
import { useTreasuryStore } from "@/stores/treasury";
import { usePayeesStore } from "@/stores/payees";
import { usePayrollBatchesStore } from "@/stores/payroll-batches";
import {
  addPayeeFromPicker,
  addressInputs,
  amountInputs,
  broadcastButton,
  buildButton,
  buildOnce,
  CFG_B,
  currentSkeletonTx,
  DIGEST,
  draftBatch,
  fillAllSignatures,
  makeTx,
  PACKET_JSON,
  payee,
  primeMocks,
  primeStores,
  RECIPIENT_ADDRESS,
  RECIPIENT_ADDRESS_2,
  renderPanel,
  sigBoxes,
  TOTALS,
  TREASURY_A,
  TREASURY_B,
  TX_HASH,
  USD_QUOTE,
} from "./PayPanel.fixtures";

const spies = {
  listCellsForLock,
  broadcastTransaction,
  assertGuard: assertGuardSpy,
  dumpInputs: dumpInputsSpy,
};

/** Add the single payee, wait for FX, and confirm the amount landed. */
async function draftFromPayee(expectedAmount: string): Promise<void> {
  await addPayeeFromPicker();
  await waitFor(() => expect(amountInputs()[0]).toHaveValue(expectedAmount));
}

beforeEach(() => {
  primeStores();
  primeMocks(spies);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PayPanel — batch lifecycle", () => {
  it("attaches no payroll batch to a manual payment with no payee rows", async () => {
    renderPanel();
    await buildOnce();
    expect(usePayrollBatchesStore.getState().batches).toHaveLength(0);
    fillAllSignatures();
    fireEvent.click(broadcastButton());
    await screen.findByText("Broadcast successful");
    expect(usePayrollBatchesStore.getState().batches).toHaveLength(0);
  });

  it("snapshots a payroll batch when the rows came from payees, and advances it on broadcast", async () => {
    usePayeesStore.setState({ payees: [payee()] });
    vi.mocked(fetchCkbPrices).mockResolvedValue(new Map([["USD", USD_QUOTE]]));
    renderPanel();
    await draftFromPayee("500");

    fireEvent.click(buildButton());
    await waitFor(() => expect(screen.getByDisplayValue(PACKET_JSON)).toBeInTheDocument());

    const batches = usePayrollBatchesStore.getState().batches;
    expect(batches).toHaveLength(1);
    const batch = batches[0] as PayrollBatch;
    expect(batch.kind).toBe("payroll");
    expect(batch.state).toBe("calculated");
    expect(batch.treasuryId).toBe("ckb-1");
    expect(batch.sighashDigest).toBe(DIGEST);
    expect(batch.txBytes).toBe(hexFrom(currentSkeletonTx().toBytes()));
    expect(batch.commPacket).toBe(PACKET_JSON);
    expect(batch.totals).toEqual(TOTALS);
    expect(batch.lines).toEqual([
      {
        payeeId: "p1",
        fiat: { currency: "USD", minor: 250n },
        crypto: { asset: "CKB", value: 50_000_000_000n, decimals: 8 },
        fxRate: "0.005",
        feeAllocated: { asset: "CKB", value: 0n, decimals: 8 },
      },
    ]);
    expect(batch.fxSnapshot).toEqual([USD_QUOTE]);

    fillAllSignatures();
    fireEvent.click(broadcastButton());
    await screen.findByText("Broadcast successful");
    const after = usePayrollBatchesStore.getState().batches[0] as PayrollBatch;
    expect(after.state).toBe("broadcasted");
    expect(after.pendingTxId).toBe(TX_HASH);
    // Sigs are embedded in the broadcast tx — no reason to keep them persisted.
    expect(after.partialSigs).toEqual([]);
  });

  it("mounts the real CommSendSection with one row per signer once a batch exists", async () => {
    // PayPanel.comm.test.tsx stubs CommSendSection to assert the props PayPanel
    // computes; this one renders the genuine component so a crash or a broken
    // prop contract in the real child is caught too.
    usePayeesStore.setState({ payees: [payee()] });
    vi.mocked(fetchCkbPrices).mockResolvedValue(new Map([["USD", USD_QUOTE]]));
    renderPanel();
    await draftFromPayee("500");
    fireEvent.click(buildButton());
    await waitFor(() => expect(screen.getByDisplayValue(PACKET_JSON)).toBeInTheDocument());

    expect(
      screen.getByRole("region", { name: "Send to signers via comm" }),
    ).toBeInTheDocument();
    // One row per pubkey hash in the treasury (N = 3), each currently unmapped.
    expect(screen.getAllByLabelText(/^slot-\d$/)).toHaveLength(3);
    expect(screen.getByText(/sighash: 0xdededede/)).toBeInTheDocument();
  });

  it("persists each pasted signature onto the active batch as it is typed", async () => {
    usePayeesStore.setState({ payees: [payee()] });
    vi.mocked(fetchCkbPrices).mockResolvedValue(new Map([["USD", USD_QUOTE]]));
    renderPanel();
    await draftFromPayee("500");
    fireEvent.click(buildButton());
    await waitFor(() => expect(screen.getByDisplayValue(PACKET_JSON)).toBeInTheDocument());

    fireEvent.change(sigBoxes()[0]!, { target: { value: `  0x${"11".repeat(65)}  ` } });
    const batch = usePayrollBatchesStore.getState().batches[0] as PayrollBatch;
    expect(batch.partialSigs).toEqual([{ slotIndex: 0, signature: `0x${"11".repeat(65)}` }]);
  });
});

describe("PayPanel — hydration from a persisted batch", () => {
  it("hydrates recipient rows from a batch passed via router state and kicks off an FX refresh", async () => {
    usePayeesStore.setState({ payees: [payee()] });
    usePayrollBatchesStore.setState({ batches: [draftBatch()], selectedDraftId: null });
    // Empty quote map so hydration's own values survive and can be asserted.
    vi.mocked(fetchCkbPrices).mockResolvedValue(new Map());

    renderPanel([{ pathname: "/pay", state: { autoSelectBatchId: "batch-1" } }]);

    await waitFor(() => expect(addressInputs()[0]).toHaveValue(RECIPIENT_ADDRESS));
    expect(amountInputs()[0]).toHaveValue("123");
    // The mount effect fires FX for the payee's currency without operator action.
    await waitFor(() => expect(fetchCkbPrices).toHaveBeenCalledWith(["USD"]));
  });

  it("hydrates a sub-100-shannon line as plain decimal, not exponential notation, and survives into a built batch", async () => {
    // 42 shannons = 4.2e-7 CKB. (Number(v) / 1e8).toString() renders that as
    // "4.2e-7", which ckbToShannons's /^\d+(\.\d+)?$/ regex rejects — the row
    // is then silently dropped by buildBatchLinesFromRecipients, the same
    // silent-drop class as the FX-refresh regression fixed in Task B.
    usePayeesStore.setState({ payees: [payee()] });
    usePayrollBatchesStore.setState({
      batches: [
        draftBatch({
          id: "batch-dust",
          lines: [
            {
              payeeId: "p1",
              fiat: { currency: "USD", minor: 250n },
              crypto: { asset: "CKB", value: 42n, decimals: 8 },
              fxRate: "0.005",
              feeAllocated: { asset: "CKB", value: 0n, decimals: 8 },
            },
          ],
        }),
      ],
      selectedDraftId: null,
    });
    vi.mocked(fetchCkbPrices).mockResolvedValue(new Map());

    renderPanel([{ pathname: "/pay", state: { autoSelectBatchId: "batch-dust" } }]);

    await waitFor(() => expect(amountInputs()[0]).toHaveValue("0.00000042"));

    fireEvent.click(buildButton());
    await waitFor(() => expect(screen.getByDisplayValue(PACKET_JSON)).toBeInTheDocument());

    const built = usePayrollBatchesStore
      .getState()
      .batches.find((b) => b.id !== "batch-dust") as PayrollBatch;
    expect(built).toBeDefined();
    expect(built.lines).toHaveLength(1);
    expect(built.lines[0]?.crypto.value).toBe(42n);
  });

  it("switches treasury first, then hydrates the packet and signature slots on the next render", async () => {
    useTreasuryStore.setState({
      treasuries: [TREASURY_A, TREASURY_B],
      activeTreasuryId: TREASURY_A.id,
    });
    const batch = draftBatch({
      id: "batch-2",
      treasuryId: "ckb-2",
      txBytes: hexFrom(makeTx().toBytes()),
      sighashDigest: DIGEST,
      totals: { ...TOTALS },
      partialSigs: [{ slotIndex: 0, signature: `0x${"77".repeat(65)}` }],
    });
    usePayrollBatchesStore.setState({ batches: [batch], selectedDraftId: "batch-2" });

    renderPanel();

    // Step 1: the treasury selector (first combobox; the rest are sig slots)
    // moved to the batch's treasury.
    await waitFor(() => expect(screen.getAllByRole("combobox")[0]).toHaveValue("ckb-2"));
    // Step 2: the ephemeral state was rebuilt from the persisted bytes.
    expect(screen.getByDisplayValue(PACKET_JSON)).toBeInTheDocument();
    const boxes = sigBoxes();
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toHaveValue(`0x${"77".repeat(65)}`);
    expect(boxes[1]).toHaveValue("");
    // The packet is re-encoded against the treasury the batch belongs to.
    expect(vi.mocked(encodeTransferPacket).mock.calls[0]![0]).toMatchObject({
      label: "Resumed batch",
      network: "testnet",
      treasuryConfig: expect.objectContaining({ pubkeyHashes: CFG_B.pubkeyHashes }),
    });
    // Resume is one-shot: the selection is cleared so a remount doesn't re-fire.
    expect(usePayrollBatchesStore.getState().selectedDraftId).toBeNull();
  });

  it("clears the selection and stays on the draft form when the batch has no frozen tx bytes", async () => {
    usePayrollBatchesStore.setState({ batches: [draftBatch()], selectedDraftId: "batch-1" });
    renderPanel();
    await waitFor(() => expect(usePayrollBatchesStore.getState().selectedDraftId).toBeNull());
    expect(addressInputs()).toHaveLength(1);
    expect(screen.queryByDisplayValue(PACKET_JSON)).not.toBeInTheDocument();
  });
});

describe("PayPanel — FX", () => {
  it("fills the amount column for payee-sourced rows from a successful quote", async () => {
    usePayeesStore.setState({ payees: [payee()] });
    vi.mocked(fetchCkbPrices).mockResolvedValue(new Map([["USD", USD_QUOTE]]));
    renderPanel();
    // $2.50 ÷ 0.005 USD/CKB = 500 CKB, computed by the real fiatToCkbShannons.
    await draftFromPayee("500");
    expect(screen.getByText(/FX snapshot: 1 CKB = 0\.005 USD/)).toBeInTheDocument();
    expect(screen.getByText("CoinGecko")).toBeInTheDocument();
    expect(fetchCkbPrices).toHaveBeenCalledWith(["USD"]);
  });

  it("REGRESSION FIXED: an FX amount of 1000 CKB or more still builds — fillAmountsFromFx no longer stores a thousands-separated string", async () => {
    // Previously fillAmountsFromFx stored formatCkb(shannons) — a *display*
    // string with thousands separators — into amountCkb, but ckbToShannons
    // only accepts /^\d+(\.\d+)?$/. Any payee whose converted salary reached
    // 1000 CKB could not be built, and buildBatchLinesFromRecipients silently
    // dropped the line. Fixed by writing toCkbInputValue(shannons) instead,
    // which round-trips through ckbToShannons with no separators.
    usePayeesStore.setState({
      payees: [payee({ salaryFiat: { currency: "USD", minor: 500_000n } })],
    });
    vi.mocked(fetchCkbPrices).mockResolvedValue(new Map([["USD", USD_QUOTE]]));
    renderPanel();
    await draftFromPayee("1000000");

    fireEvent.click(buildButton());
    await waitFor(() => expect(screen.getByDisplayValue(PACKET_JSON)).toBeInTheDocument());
    expect(
      screen.queryByText("Recipient 1: amount must be a positive number"),
    ).not.toBeInTheDocument();
    expect(buildPaymentSkeleton).toHaveBeenCalled();

    // The row must also survive into the persisted payroll batch line, not
    // just pass the build-time parse — this is the actual payee-sourced
    // payroll path the regression broke end to end.
    const batch = usePayrollBatchesStore.getState().batches[0] as PayrollBatch;
    expect(batch.lines).toEqual([
      {
        payeeId: "p1",
        fiat: { currency: "USD", minor: 500_000n },
        crypto: { asset: "CKB", value: 100_000_000_000_000n, decimals: 8 },
        fxRate: "0.005",
        feeAllocated: { asset: "CKB", value: 0n, decimals: 8 },
      },
    ]);
  });

  it("shows the FX error and leaves manually typed amounts untouched", async () => {
    usePayeesStore.setState({ payees: [payee()] });
    vi.mocked(fetchCkbPrices).mockRejectedValue(new Error("CoinGecko HTTP 429 Too Many Requests"));
    renderPanel();
    // A manually entered row that must survive the failed fetch.
    fireEvent.change(addressInputs()[0]!, { target: { value: RECIPIENT_ADDRESS_2 } });
    fireEvent.change(amountInputs()[0]!, { target: { value: "42.5" } });

    await addPayeeFromPicker();

    expect(await screen.findByText(/FX fetch failed: CoinGecko HTTP 429/)).toBeInTheDocument();
    expect(amountInputs()[0]).toHaveValue("42.5");
    expect(addressInputs()[0]).toHaveValue(RECIPIENT_ADDRESS_2);
    // The payee row was still appended, just without an amount.
    expect(amountInputs()[1]).toHaveValue("");
    expect(screen.queryByText(/FX snapshot/)).not.toBeInTheDocument();
  });

  it("the re-fetch button actually re-fetches (previously BUG PIN)", async () => {
    // FIXED (was BUG PIN): FxSnapshotPanel used to render
    // <button onClick={onRefresh}>, so React invoked it as
    // refetchFx(mouseEvent); refetchFx treated its first argument as
    // `rowsOverride` and called rows.map(...) on the event → TypeError,
    // swallowed as an unhandled rejection with no visible effect. Both call
    // sites in FxSnapshotPanel now wrap the handler as
    // `onClick={() => void onRefresh()}`, so no event ever reaches
    // refetchFx and it re-fetches with the current draft rows instead.
    usePayeesStore.setState({ payees: [payee()] });
    vi.mocked(fetchCkbPrices).mockResolvedValue(new Map([["USD", USD_QUOTE]]));
    renderPanel();
    await draftFromPayee("500");

    vi.mocked(fetchCkbPrices)
      .mockClear()
      .mockResolvedValue(new Map([["USD", { ...USD_QUOTE, rate: "0.01" }]]));
    fireEvent.click(screen.getByRole("button", { name: "re-fetch" }));

    await waitFor(() => expect(fetchCkbPrices).toHaveBeenCalledWith(["USD"]));
    // $2.50 at the new rate (1 CKB = 0.01 USD) re-quotes to 250 CKB.
    await waitFor(() => expect(amountInputs()[0]).toHaveValue("250"));
  });

  it("the error-state retry button actually re-fetches (previously same bug as re-fetch)", async () => {
    // Same defect and fix as "the re-fetch button actually re-fetches" above,
    // but through FxSnapshotPanel's OTHER call site — the inline "retry" link
    // shown in its error branch. Task B wrapped both buttons identically
    // (`onClick={() => void onRefresh()}`), but only the success-state
    // "re-fetch" button had a test; this button was left exercising the same
    // MouseEvent-as-rowsOverride bug unverified.
    usePayeesStore.setState({ payees: [payee()] });
    vi.mocked(fetchCkbPrices).mockRejectedValue(new Error("CoinGecko HTTP 429 Too Many Requests"));
    renderPanel();
    await addPayeeFromPicker();

    expect(await screen.findByText(/FX fetch failed: CoinGecko HTTP 429/)).toBeInTheDocument();

    vi.mocked(fetchCkbPrices)
      .mockClear()
      .mockResolvedValue(new Map([["USD", USD_QUOTE]]));
    fireEvent.click(screen.getByRole("button", { name: "retry" }));

    await waitFor(() => expect(fetchCkbPrices).toHaveBeenCalledWith(["USD"]));
  });

  it("re-quotes correctly when refetchFx is reached with a real rows array", async () => {
    // The same function, reached the way the batch-hydration effect reaches it
    // (refetchFx(hydratedRows)) rather than through the broken button, does
    // recompute the column — proving the defect above is the call site.
    usePayeesStore.setState({ payees: [payee()] });
    usePayrollBatchesStore.setState({
      batches: [
        draftBatch({
          id: "batch-fx",
          // Invoice-built lines carry fiat but crypto.value 0 — the row
          // hydrates blank and FX is what fills it.
          lines: [
            {
              payeeId: "p1",
              fiat: { currency: "USD", minor: 250n },
              crypto: { asset: "CKB", value: 0n, decimals: 8 },
              fxRate: "0",
              feeAllocated: { asset: "CKB", value: 0n, decimals: 8 },
            },
          ],
        }),
      ],
      selectedDraftId: null,
    });
    vi.mocked(fetchCkbPrices).mockResolvedValue(new Map([["USD", USD_QUOTE]]));

    renderPanel([{ pathname: "/pay", state: { autoSelectBatchId: "batch-fx" } }]);

    await waitFor(() => expect(amountInputs()[0]).toHaveValue("500"));
    expect(fetchCkbPrices).toHaveBeenCalledWith(["USD"]);
  });
});
