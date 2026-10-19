// @vitest-environment jsdom
//
// Characterization tests for the three PayPanel paths the Task 13 review found
// uncovered: the incoming-sigs drain effect (:146-154), the auto-broadcast
// countdown path (:624-670), and the CommSendSection render gate (:591-609).
//
// All three are code Tasks 14–15 will rearrange, and all three previously had
// zero assertions — the drain effect returned at `buffered.length === 0` in
// every one of the 34 original tests, and the auto path could have lost its
// pre-broadcast guard entirely with a green suite.
//
// Shared fixtures/harness: PayPanel.fixtures.tsx. Pins CURRENT behaviour.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const listCellsForLock = vi.hoisted(() => vi.fn());
const broadcastTransaction = vi.hoisted(() => vi.fn());
const assertGuardSpy = vi.hoisted(() => vi.fn());
const dumpInputsSpy = vi.hoisted(() => vi.fn());
/** Props every CommSendSection render received, newest last. */
const commSendProps = vi.hoisted(() => [] as Record<string, unknown>[]);

// Same boundary mocks as the sibling suites — see PayPanel.test.tsx. Mock
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
  ...(await importOriginal<typeof import("@/lib/fx/coingecko")>()),
  fetchCkbPrices: vi.fn(),
}));
vi.mock("@/lib/chains/ckb/multisig-assert", () => ({
  assertMultisigBytesMatchTreasury: assertGuardSpy,
  dumpInputsForInspection: dumpInputsSpy,
}));
// Stubbed so the render-gate test can assert the PROPS PayPanel computes.
// PayPanel.batch.test.tsx renders the real component and asserts its markup.
vi.mock("./CommSendSection", () => ({
  CommSendSection: (props: Record<string, unknown>) => {
    commSendProps.push(props);
    return <div data-testid="comm-send-section" />;
  },
}));

import { hexFrom } from "@ckb-ccc/core";
import type { PayrollBatch } from "@chain-pay/shared";
import { pubkeyHashFromPrivateKey, signDigest } from "@/lib/signers/ckb-secp256k1";
import { useTreasuryStore } from "@/stores/treasury";
import { usePayeesStore } from "@/stores/payees";
import { usePayrollBatchesStore } from "@/stores/payroll-batches";
import { useIncomingSigsStore } from "@/stores/incoming-sigs";
import { useNetworkConfigStore } from "@/stores/network-config";
import { fetchCkbPrices } from "@/lib/fx/coingecko";
import {
  addPayeeFromPicker,
  amountInputs,
  buildButton,
  fillAllSignatures,
  buildOnce,
  CFG_B,
  ckbTreasury,
  DIGEST,
  draftBatch,
  makeTx,
  PACKET_JSON,
  payee,
  primeMocks,
  primeStores,
  renderPanel,
  sigBoxes,
  TOTALS,
  TX_HASH,
  USD_QUOTE,
} from "./PayPanel.fixtures";
import type { CkbMultisigConfig } from "@/lib/chains/ckb/multisig";

const spies = {
  listCellsForLock,
  broadcastTransaction,
  assertGuard: assertGuardSpy,
  dumpInputs: dumpInputsSpy,
};

// Real secp256k1 keys so the drain's signature recovery actually validates —
// drainIncomingSigsInto recovers each sig's pubkey hash and compares it to
// multisig.pubkeyHashes[slotIndex], so a fabricated hash would be rejected.
const KEY_A = `0x${"11".repeat(32)}`;
const KEY_B = `0x${"22".repeat(32)}`;
const KEY_C = `0x${"33".repeat(32)}`;
const HASH_A = pubkeyHashFromPrivateKey(KEY_A);
const HASH_B = pubkeyHashFromPrivateKey(KEY_B);
const HASH_C = pubkeyHashFromPrivateKey(KEY_C);
const SIG_A = signDigest(DIGEST, KEY_A);
const SIG_B = signDigest(DIGEST, KEY_B);

/** 2-of-3 whose pubkey hashes are the real hashes of KEY_A/B/C. */
const CFG_SIGNERS: CkbMultisigConfig = {
  s: 0,
  r: 0,
  m: 2,
  n: 3,
  pubkeyHashes: [HASH_A, HASH_B, HASH_C],
};
const TREASURY_SIGNERS = ckbTreasury({
  id: "ckb-1",
  label: "Signer treasury",
  cfg: CFG_SIGNERS,
});

function bufferSig(slotIndex: number, signature: string): void {
  useIncomingSigsStore.getState().enqueue({
    sighashDigest: DIGEST,
    slotIndex,
    signature,
    senderAddrHash: `0x${"aa".repeat(20)}`,
    receivedAt: 1_760_000_000_000,
  });
}

/** Build a payee-sourced draft, which is what creates the active batch. */
async function buildPayeeBatch(): Promise<void> {
  usePayeesStore.setState({ payees: [payee()] });
  vi.mocked(fetchCkbPrices).mockResolvedValue(new Map([["USD", USD_QUOTE]]));
  renderPanel();
  await addPayeeFromPicker();
  await waitFor(() => expect(amountInputs()[0]).toHaveValue("500"));
  fireEvent.click(buildButton());
  await waitFor(() => expect(screen.getByDisplayValue(PACKET_JSON)).toBeInTheDocument());
}

/** A batch parked in `broadcast_countdown`, resumable and ready to auto-send. */
function countdownBatch(over: Partial<PayrollBatch> = {}): PayrollBatch {
  return draftBatch({
    id: "batch-auto",
    state: "broadcast_countdown",
    autoBroadcast: true,
    txBytes: hexFrom(makeTx().toBytes()),
    sighashDigest: DIGEST,
    totals: { ...TOTALS },
    partialSigs: [
      { slotIndex: 0, signature: SIG_A },
      { slotIndex: 1, signature: SIG_B },
    ],
    ...over,
  });
}

beforeEach(() => {
  primeStores();
  primeMocks(spies);
  useTreasuryStore.setState({
    treasuries: [TREASURY_SIGNERS],
    activeTreasuryId: TREASURY_SIGNERS.id,
  });
  commSendProps.length = 0;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// GAP 1 — the incoming-sigs drain effect (PayPanel.tsx:146-154)
// ---------------------------------------------------------------------------

describe("PayPanel — incoming-sigs drain", () => {
  it("drains signatures buffered at the built batch's digest into its partialSigs", async () => {
    // Buffered BEFORE render: PayPanel reads the buffer with getState() rather
    // than subscribing, so nothing re-renders when a sig arrives later. The
    // drain runs when `activeBatch.sighashDigest` first becomes known — i.e.
    // when handleBuild snapshots the batch.
    bufferSig(0, SIG_A);
    bufferSig(1, SIG_B);

    await buildPayeeBatch();

    await waitFor(() => {
      const batch = usePayrollBatchesStore.getState().batches[0] as PayrollBatch;
      expect(batch.partialSigs).toHaveLength(2);
    });
    const batch = usePayrollBatchesStore.getState().batches[0] as PayrollBatch;
    expect(batch.partialSigs).toEqual([
      { slotIndex: 0, signature: SIG_A, signerPubkeyHash: HASH_A },
      { slotIndex: 1, signature: SIG_B, signerPubkeyHash: HASH_B },
    ]);
    // The buffer is consumed, not merely peeked — a second drain must not
    // double-count.
    expect(useIncomingSigsStore.getState().bySighash[DIGEST]).toBeUndefined();
    // M reached → the store promotes calculated → approved, which is what
    // makes the auto-broadcast toggle appear.
    expect(batch.state).toBe("approved");
    expect(
      screen.getByText("Auto-broadcast when M sigs collected"),
    ).toBeInTheDocument();
  });

  it("passes the treasury's own m and pubkeyHashes to the drain, so a foreign signer is rejected", async () => {
    // Slot 0 signed by KEY_C, whose hash sits at slot 2 — recovery succeeds but
    // does not match pubkeyHashes[0], so the drain must reject it. This pins
    // that the effect forwards the SELECTED treasury's config rather than
    // anything stale or hard-coded.
    bufferSig(0, signDigest(DIGEST, KEY_C));
    await buildPayeeBatch();

    await waitFor(() =>
      expect(useIncomingSigsStore.getState().bySighash[DIGEST]).toBeUndefined(),
    );
    const batch = usePayrollBatchesStore.getState().batches[0] as PayrollBatch;
    expect(batch.partialSigs).toEqual([]);
    expect(batch.state).toBe("calculated");
  });

  it("a drained signature reaches the signature textareas and unlocks Merge & broadcast (previously BUG PIN)", async () => {
    // FIXED (was BUG PIN): the drain wrote to batch.partialSigs, but nothing
    // synced PayPanel's `sigs` React state — the drain effect now calls
    // lifecycle.setSigs after a merge, reconciling each persisted slot back
    // into the row the SignaturePanel textareas and the M-of-N gate read.
    bufferSig(0, SIG_A);
    bufferSig(1, SIG_B);
    await buildPayeeBatch();

    await waitFor(() => {
      const batch = usePayrollBatchesStore.getState().batches[0] as PayrollBatch;
      expect(batch.partialSigs).toHaveLength(2);
    });
    await waitFor(() => {
      expect(sigBoxes().map((b) => (b as HTMLTextAreaElement).value)).toEqual([SIG_A, SIG_B]);
    });
    expect(screen.getByRole("button", { name: /Merge & broadcast/ })).toBeEnabled();
  });

  it("does not overwrite an operator-typed signature when a later drain touches the same slot", async () => {
    // Proves the reconciliation added for the fix above cannot reopen the
    // "never clobber operator input" guarantee that drainIncomingSigsInto
    // already provides at the store layer (its `existingSlots` check). A
    // comm signature arriving for a slot the operator already filled must
    // leave that slot's textarea untouched; a genuine signature for a
    // still-empty slot must still come through.
    await buildPayeeBatch();

    const operatorSig = `0x${"99".repeat(65)}`;
    fireEvent.change(sigBoxes()[0]!, { target: { value: operatorSig } });
    await waitFor(() => {
      const batch = usePayrollBatchesStore.getState().batches[0] as PayrollBatch;
      expect(batch.partialSigs?.find((p) => p.slotIndex === 0)?.signature).toBe(operatorSig);
    });

    // A comm signature for the SAME slot the operator just filled — SIG_A is
    // genuinely valid for slot 0 (recovers to HASH_A, pubkeyHashes[0]), so
    // only the `existingSlots` occupied-slot check can reject it; a
    // signature from the wrong key would be rejected by pubkey-mismatch
    // instead and prove nothing about the occupied-slot guard specifically.
    // Plus a genuine signature for the still-empty slot.
    bufferSig(0, SIG_A);
    bufferSig(1, SIG_B);

    // Nudge the drain effect to re-run: any write to the batches store gives
    // PayPanel a fresh `batchStore` reference, which is exactly what a
    // second comm delivery does in the running app. This mirrors that
    // without touching the sig rows themselves.
    act(() => {
      const id = usePayrollBatchesStore.getState().batches[0]!.id;
      usePayrollBatchesStore.getState().updateBatch(id, {});
    });

    await waitFor(() => {
      expect((sigBoxes()[1] as HTMLTextAreaElement).value).toBe(SIG_B);
    });
    // Slot 0 is exactly what the operator typed — the rejected, otherwise-
    // valid SIG_A never reached the textarea or the store.
    expect((sigBoxes()[0] as HTMLTextAreaElement).value).toBe(operatorSig);
    const batch = usePayrollBatchesStore.getState().batches[0] as PayrollBatch;
    expect(batch.partialSigs?.find((p) => p.slotIndex === 0)?.signature).toBe(operatorSig);
    // Array.find returns the FIRST match, so if drainIncomingSigsInto's
    // existingSlots guard were ever dropped, a second (accepted) entry for
    // slot 0 would be appended alongside the operator's — masked by the
    // .find() above, which would keep reporting the operator's value
    // regardless. Asserting the exact length closes that blind spot: there
    // must be exactly the operator's slot-0 entry and the drain's slot-1
    // entry, no silently-appended duplicate.
    expect(batch.partialSigs).toHaveLength(2);
  });

  it("leaves the buffer untouched for a manual payment with no active batch", async () => {
    // No payee rows → no batch → activeBatchId stays null → the effect returns
    // at its first guard and the sigs stay buffered for a later batch.
    bufferSig(0, SIG_A);
    renderPanel();
    await buildOnce();
    expect(usePayrollBatchesStore.getState().batches).toHaveLength(0);
    expect(useIncomingSigsStore.getState().bySighash[DIGEST]).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// GAP 2 — the auto-broadcast countdown path (PayPanel.tsx:624-670)
// ---------------------------------------------------------------------------

describe("PayPanel — auto-broadcast", () => {
  it("does not offer a second manual broadcast while the countdown is armed", () => {
    const batch = countdownBatch();
    usePayrollBatchesStore.setState({ batches: [batch], selectedDraftId: batch.id });
    renderPanel();
    expect(screen.getByText(/Broadcasting in/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Merge & broadcast" })).not.toBeInTheDocument();
  });

  /** Resume a countdown batch and let the 5s countdown elapse. */
  async function elapseCountdown(batch: PayrollBatch): Promise<void> {
    usePayrollBatchesStore.setState({ batches: [batch], selectedDraftId: batch.id });
    vi.useFakeTimers();
    renderPanel();
    expect(screen.getByText(/Broadcasting in/)).toBeInTheDocument();
    // One act() per second: AutoBroadcastCountdown chains its setTimeout from
    // an effect, so the next timer is only registered once React commits the
    // previous tick. Advancing 6000ms in a single act would fire only the
    // first timeout.
    for (let tick = 0; tick <= 5; tick += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
    }
  }

  it("runs the pre-broadcast multisig guard before broadcasting on the auto path", async () => {
    useNetworkConfigStore.setState({ network: "testnet", broadcastRpcUrl: "http://node:8114" });
    await elapseCountdown(countdownBatch());

    // The whole point: the auto path shares buildSignedTxAndBroadcast, so the
    // guard must fire here too. If Task 15 moves the guard into a manual-only
    // hook, this is the only test that notices.
    expect(assertGuardSpy).toHaveBeenCalledTimes(1);
    expect(broadcastTransaction).toHaveBeenCalledTimes(1);
    expect(assertGuardSpy.mock.invocationCallOrder[0]!).toBeLessThan(
      broadcastTransaction.mock.invocationCallOrder[0]!,
    );
    const [, cfgArg, multisigArg] = assertGuardSpy.mock.calls[0]!;
    expect(cfgArg).toMatchObject({ m: 2, n: 3, pubkeyHashes: CFG_SIGNERS.pubkeyHashes });
    expect(multisigArg).toEqual(TREASURY_SIGNERS.multisig);

    // The batch and the panel both land on broadcasted.
    const after = usePayrollBatchesStore.getState().batches[0] as PayrollBatch;
    expect(after.state).toBe("broadcasted");
    expect(after.pendingTxId).toBe(TX_HASH);
    expect(after.partialSigs).toEqual([]);
    expect(screen.getByText("Broadcast successful")).toBeInTheDocument();
    expect(screen.getByText(TX_HASH)).toBeInTheDocument();
  });

  it("aborts the auto broadcast and records the failure when the real guard detects drift", async () => {
    const actual = await vi.importActual<typeof import("@/lib/chains/ckb/multisig-assert")>(
      "@/lib/chains/ckb/multisig-assert",
    );
    assertGuardSpy.mockImplementation(actual.assertMultisigBytesMatchTreasury);
    // Stored address derived from CFG_B while the live config is CFG_SIGNERS.
    useTreasuryStore.setState({
      treasuries: [
        ckbTreasury({
          id: "ckb-1",
          label: "Drifted treasury",
          cfg: CFG_SIGNERS,
          addressFromCfg: CFG_B,
        }),
      ],
      activeTreasuryId: "ckb-1",
    });
    useNetworkConfigStore.setState({ network: "testnet", broadcastRpcUrl: "http://node:8114" });

    await elapseCountdown(countdownBatch());

    expect(broadcastTransaction).not.toHaveBeenCalled();
    const after = usePayrollBatchesStore.getState().batches[0] as PayrollBatch;
    expect(after.state).toBe("broadcast_failed");
    expect(after.broadcastError).toMatch(/Treasury config drift/);
    expect(screen.getByText("Broadcast failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry broadcast" })).toBeInTheDocument();
    // Sigs are preserved so the operator can re-arm rather than re-collect.
    expect(after.partialSigs).toHaveLength(2);
  });

  it("a missing broadcast RPC URL surfaces an error and reaches broadcast_failed", async () => {
    // FIXED (was BUG PIN): onElapsed's three pre-checks call
    // markBroadcastFailed while the batch is STILL in `broadcast_countdown`.
    // Before Task A of the auto-broadcast bug bundle, the state machine only
    // allowed broadcast_countdown → {broadcast_initiating, approved,
    // cancelled}, so markBroadcastFailed no-op'd on the illegal transition
    // (`if (!canTransition(...)) return b`) — no state change, no
    // broadcastError, no Retry button, and the countdown's firedRef meant it
    // never fired again either. The batch sat stuck showing "Broadcasting in
    // 0…" forever. state-machine.ts now allows broadcast_countdown →
    // broadcast_failed, so this pre-check reaches the user for the first
    // time. The post-markBroadcastInitiating catch block was always fine
    // (see the drift test above) because broadcast_initiating →
    // broadcast_failed was already legal.
    //
    // primeStores leaves broadcastRpcUrl empty on purpose here.
    await elapseCountdown(countdownBatch());

    expect(assertGuardSpy).not.toHaveBeenCalled();
    expect(broadcastTransaction).not.toHaveBeenCalled();
    const after = usePayrollBatchesStore.getState().batches[0] as PayrollBatch;
    expect(after.state).toBe("broadcast_failed");
    expect(after.broadcastError).toBe("Configure broadcast RPC URL in Settings");
    expect(screen.getByText("Broadcast failed")).toBeInTheDocument();
    expect(screen.getByText("Configure broadcast RPC URL in Settings")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry broadcast" })).toBeInTheDocument();
    expect(screen.queryByText(/Broadcasting in/)).not.toBeInTheDocument();
  });

  it("retries a failed auto broadcast after the operator configures the RPC URL", async () => {
    await elapseCountdown(countdownBatch());
    expect(usePayrollBatchesStore.getState().batches[0]?.state).toBe("broadcast_failed");

    useNetworkConfigStore.setState({ network: "testnet", broadcastRpcUrl: "http://node:8114" });
    fireEvent.click(screen.getByRole("button", { name: "Retry broadcast" }));
    expect(usePayrollBatchesStore.getState().batches[0]?.state).toBe("broadcast_countdown");
    expect(screen.getByText(/Broadcasting in/)).toBeInTheDocument();

    for (let tick = 0; tick <= 5; tick += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
    }

    expect(broadcastTransaction).toHaveBeenCalledTimes(1);
    expect(usePayrollBatchesStore.getState().batches[0]?.state).toBe("broadcasted");
  });

  it("a batch with no collected signatures surfaces an error and reaches broadcast_failed", async () => {
    // FIXED (was BUG PIN): same defect as the missing-RPC-URL case above, hit
    // via the third onElapsed pre-check instead of the first. Not "another"
    // bug — it is the identical broadcast_countdown → broadcast_failed
    // transition, exercised through a different guard clause, so it flips to
    // asserting fixed behaviour in the same commit as that test.
    useNetworkConfigStore.setState({ network: "testnet", broadcastRpcUrl: "http://node:8114" });
    await elapseCountdown(countdownBatch({ partialSigs: [] }));

    expect(assertGuardSpy).not.toHaveBeenCalled();
    expect(broadcastTransaction).not.toHaveBeenCalled();
    const after = usePayrollBatchesStore.getState().batches[0] as PayrollBatch;
    expect(after.state).toBe("broadcast_failed");
    expect(after.broadcastError).toBe(
      "No partial signatures collected yet — collect signatures, then retry the broadcast",
    );
    expect(screen.getByText("Broadcast failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry broadcast" })).toBeInTheDocument();
  });

  it("a batch with no transaction bytes surfaces an error and reaches broadcast_failed", async () => {
    // FIXED (was BUG PIN): same defect as the missing-RPC-URL and
    // no-collected-signatures cases above, hit via the second onElapsed
    // pre-check (Task A's third armed guard) instead of the first or third.
    // Not "another" bug — it is the identical broadcast_countdown →
    // broadcast_failed transition, exercised through the !txBytes guard
    // clause. Task A also reworded this branch's message (step A5), so
    // neither the branch nor the new string had coverage before this test.
    //
    // Can't reuse elapseCountdown()/countdownBatch() as-is: it drives
    // activeBatchId via `selectedDraftId`, whose resume-hydration effect
    // (PayPanel.tsx) itself bails out — and never sets activeBatchId — when
    // `batch.txBytes` is missing, so the countdown UI would never mount and
    // the very guard under test would stay unreached. Instead, set
    // activeBatchId directly via the `autoSelectBatchId` router-state path
    // (the same one ReviewInvoiceForm uses), which only needs the batch id
    // to exist in the store — no txBytes required to reach the countdown.
    useNetworkConfigStore.setState({ network: "testnet", broadcastRpcUrl: "http://node:8114" });
    // `Partial<PayrollBatch>` overrides can't carry `txBytes: undefined`
    // under `exactOptionalPropertyTypes` (the property must be absent, not
    // present-and-undefined) — strip it via destructuring instead.
    const { txBytes: _txBytes, ...batch } = countdownBatch();
    usePayrollBatchesStore.setState({
      batches: [batch as PayrollBatch],
      selectedDraftId: null,
    });
    vi.useFakeTimers();
    renderPanel([{ pathname: "/pay", state: { autoSelectBatchId: batch.id } }]);
    expect(screen.getByText(/Broadcasting in/)).toBeInTheDocument();
    // One act() per second: AutoBroadcastCountdown chains its setTimeout from
    // an effect, so the next timer is only registered once React commits the
    // previous tick.
    for (let tick = 0; tick <= 5; tick += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
    }

    expect(assertGuardSpy).not.toHaveBeenCalled();
    expect(broadcastTransaction).not.toHaveBeenCalled();
    const after = usePayrollBatchesStore.getState().batches[0] as PayrollBatch;
    expect(after.state).toBe("broadcast_failed");
    expect(after.broadcastError).toBe(
      "No transaction bytes in batch — this draft can't be resumed; start a new payment",
    );
    expect(screen.getByText("Broadcast failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry broadcast" })).toBeInTheDocument();
  });

  it("cancelling the countdown returns the batch to approved without broadcasting", async () => {
    useNetworkConfigStore.setState({ network: "testnet", broadcastRpcUrl: "http://node:8114" });
    usePayrollBatchesStore.setState({
      batches: [countdownBatch()],
      selectedDraftId: "batch-auto",
    });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const after = usePayrollBatchesStore.getState().batches[0] as PayrollBatch;
    expect(after.state).toBe("approved");
    expect(broadcastTransaction).not.toHaveBeenCalled();
    expect(after.partialSigs).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// GAP 3 — the CommSendSection render gate (PayPanel.tsx:591-609)
// ---------------------------------------------------------------------------

describe("PayPanel — CommSendSection gate", () => {
  it("renders the comm section with the batch digest, treasury address and packet", async () => {
    await buildPayeeBatch();

    expect(screen.getByTestId("comm-send-section")).toBeInTheDocument();
    const props = commSendProps.at(-1)!;
    const activeBatch = usePayrollBatchesStore.getState().batches[0] as PayrollBatch;
    expect(props["batchId"]).toBe(activeBatch.id);
    expect(props["multisig"]).toEqual({ pubkeyHashes: CFG_SIGNERS.pubkeyHashes });
    // The packet co-signers receive must carry the digest they will sign, the
    // treasury they are signing for, and the packet JSON itself. Mis-wiring any
    // of the three sends co-signers something they cannot act on.
    expect(props["packet"]).toMatchObject({
      txHash: DIGEST,
      treasuryAddress: TREASURY_SIGNERS.multisig.address,
      packet: PACKET_JSON,
    });
    expect((props["packet"] as { expiresAt: number }).expiresAt).toBeGreaterThan(
      Math.floor(Date.now() / 1000),
    );
  });

  it("stops rendering the comm section once the payment is broadcast", async () => {
    // Pins the `phase === "packet-ready" || "broadcast-ready"` half of the
    // gate: after a successful broadcast the phase becomes "broadcasted" and
    // there is nothing left for co-signers to sign, so the section must go.
    await buildPayeeBatch();
    expect(screen.getByTestId("comm-send-section")).toBeInTheDocument();

    fillAllSignatures();
    fireEvent.click(screen.getByRole("button", { name: /Merge & broadcast/ }));
    await screen.findByText("Broadcast successful");
    expect(screen.queryByTestId("comm-send-section")).not.toBeInTheDocument();
  });

  it("does not render the comm section for a manual payment with no batch", async () => {
    // Phase is packet-ready and multisig + packetJson are both present, so the
    // only condition failing is `activeBatchId` — this pins that specific one.
    renderPanel();
    await buildOnce();
    expect(screen.getByDisplayValue(PACKET_JSON)).toBeInTheDocument();
    expect(screen.queryByTestId("comm-send-section")).not.toBeInTheDocument();
    expect(commSendProps).toHaveLength(0);
  });

  it("does not render the comm section while still on the draft form", () => {
    renderPanel();
    expect(screen.queryByTestId("comm-send-section")).not.toBeInTheDocument();
  });
});
