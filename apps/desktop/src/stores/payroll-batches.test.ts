import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PayrollBatch, PayrollBatchLine, VendorPaymentBatch } from "@chain-pay/shared";
import { MemoryStorage } from "./test-utils/memory-storage";

const sampleLine: PayrollBatchLine = {
  payeeId: "p1",
  fiat: { currency: "USD", minor: 500000n },
  crypto: { asset: "CKB", value: 119047619047619n, decimals: 8 },
  fxRate: "0.0042",
  feeAllocated: { asset: "CKB", value: 100_000n, decimals: 8 },
};

const sampleBatch: PayrollBatch = {
  id: "b1",
  kind: "payroll",
  label: "May 2026 payroll",
  treasuryId: "t-testnet",
  cycleStart: "2026-05-01",
  cycleEnd: "2026-05-31",
  fxSnapshot: [
    {
      base: "CKB",
      quote: "USD",
      rate: "0.0042",
      source: "coingecko",
      takenAt: 1747900000000,
    },
  ],
  lines: [sampleLine],
  state: "draft",
  createdAt: "2026-05-22T00:00:00Z",
  updatedAt: "2026-05-22T00:00:00Z",
};

beforeEach(() => {
  (globalThis as { localStorage?: Storage }).localStorage = new MemoryStorage();
  vi.resetModules();
});

afterEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

describe("payroll-batches store", () => {
  it("starts with an empty batch list", async () => {
    const { usePayrollBatchesStore } = await import("./payroll-batches");
    expect(usePayrollBatchesStore.getState().batches).toEqual([]);
  });

  it("persists added batches across re-imports", async () => {
    const first = await import("./payroll-batches");
    first.usePayrollBatchesStore.getState().addBatch(sampleBatch);

    vi.resetModules();
    const second = await import("./payroll-batches");
    const got = second.usePayrollBatchesStore.getState().batches[0];
    expect(got?.id).toBe("b1");
    expect(got?.label).toBe("May 2026 payroll");
    expect(got?.state).toBe("draft");
  });

  it("round-trips bigint values through localStorage (fiat.minor and crypto.value)", async () => {
    const first = await import("./payroll-batches");
    first.usePayrollBatchesStore.getState().addBatch(sampleBatch);

    vi.resetModules();
    const second = await import("./payroll-batches");
    const got = second.usePayrollBatchesStore.getState().batches[0];
    if (!got || got.kind !== "payroll") throw new Error("expected a PayrollBatch");
    expect(got.lines[0]?.fiat.minor).toBe(500000n);
    expect(got.lines[0]?.crypto.value).toBe(119047619047619n);
  });

  it("transition() advances state on valid transitions and bumps updatedAt", async () => {
    const { usePayrollBatchesStore } = await import("./payroll-batches");
    usePayrollBatchesStore.getState().addBatch(sampleBatch);
    const originalUpdatedAt = usePayrollBatchesStore.getState().batches[0]?.updatedAt;

    // Microsleep so updatedAt actually differs
    await new Promise((r) => setTimeout(r, 5));

    usePayrollBatchesStore.getState().transition("b1", "calculated");
    const b = usePayrollBatchesStore.getState().batches[0];
    expect(b?.state).toBe("calculated");
    expect(b?.updatedAt).not.toBe(originalUpdatedAt);
    expect(b?.createdAt).toBe(sampleBatch.createdAt); // preserved
  });

  it("transition() throws on invalid transition without mutating the batch", async () => {
    const { usePayrollBatchesStore } = await import("./payroll-batches");
    usePayrollBatchesStore.getState().addBatch(sampleBatch);

    expect(() => usePayrollBatchesStore.getState().transition("b1", "broadcasted")).toThrow(
      /draft.*broadcasted/,
    );
    const b = usePayrollBatchesStore.getState().batches[0];
    expect(b?.state).toBe("draft"); // unchanged
  });

  it("transition() is a no-op (throws) for unknown batch id", async () => {
    const { usePayrollBatchesStore } = await import("./payroll-batches");
    expect(() => usePayrollBatchesStore.getState().transition("nope", "calculated")).toThrow(
      /batch.*nope/i,
    );
  });

  it("updateBatch preserves id and createdAt, replaces other fields", async () => {
    const { usePayrollBatchesStore } = await import("./payroll-batches");
    usePayrollBatchesStore.getState().addBatch(sampleBatch);
    usePayrollBatchesStore.getState().updateBatch("b1", { label: "May payroll v2" });
    const b = usePayrollBatchesStore.getState().batches[0];
    expect(b?.id).toBe("b1");
    expect(b?.createdAt).toBe(sampleBatch.createdAt);
    expect(b?.label).toBe("May payroll v2");
  });

  it("removeBatch deletes by id", async () => {
    const { usePayrollBatchesStore } = await import("./payroll-batches");
    usePayrollBatchesStore.getState().addBatch(sampleBatch);
    usePayrollBatchesStore.getState().addBatch({ ...sampleBatch, id: "b2", label: "June" });
    usePayrollBatchesStore.getState().removeBatch("b1");
    const batches = usePayrollBatchesStore.getState().batches;
    expect(batches).toHaveLength(1);
    expect(batches[0]?.id).toBe("b2");
  });

  it("findById returns the matching batch or undefined", async () => {
    const { usePayrollBatchesStore } = await import("./payroll-batches");
    usePayrollBatchesStore.getState().addBatch(sampleBatch);
    expect(usePayrollBatchesStore.getState().findById("b1")?.label).toBe("May 2026 payroll");
    expect(usePayrollBatchesStore.getState().findById("nope")).toBeUndefined();
  });

  it("multiple batches at different states stay independent under transition()", async () => {
    const { usePayrollBatchesStore } = await import("./payroll-batches");
    usePayrollBatchesStore.getState().addBatch(sampleBatch);
    usePayrollBatchesStore.getState().addBatch({ ...sampleBatch, id: "b2", label: "June" });

    usePayrollBatchesStore.getState().transition("b1", "calculated");

    const all = usePayrollBatchesStore.getState().batches;
    expect(all.find((b) => b.id === "b1")?.state).toBe("calculated");
    expect(all.find((b) => b.id === "b2")?.state).toBe("draft");
  });

  it("draft persistence: txBytes + sighashDigest + totals + partialSigs round-trip lossless", async () => {
    const draftBatch: PayrollBatch = {
      ...sampleBatch,
      id: "draft-1",
      state: "calculated",
      txBytes:
        "0x00000000010000000000000000000000000000000000000000000000000000000000000000000000",
      sighashDigest:
        "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      totals: {
        totalIn: 50_000_000_000n,
        totalOut: 49_500_000_000n,
        fee: 500_000n,
        change: 0n,
      },
      partialSigs: [
        { slotIndex: 0, signature: "0x" + "11".repeat(65) },
        { slotIndex: 1, signature: "0x" + "22".repeat(65) },
      ],
    };

    const first = await import("./payroll-batches");
    first.usePayrollBatchesStore.getState().addBatch(draftBatch);

    vi.resetModules();
    const second = await import("./payroll-batches");
    const got = second.usePayrollBatchesStore.getState().batches[0];

    expect(got?.txBytes).toBe(draftBatch.txBytes);
    expect(got?.sighashDigest).toBe(draftBatch.sighashDigest);
    expect(got?.totals?.totalIn).toBe(50_000_000_000n);
    expect(got?.totals?.totalOut).toBe(49_500_000_000n);
    expect(got?.totals?.fee).toBe(500_000n);
    expect(got?.totals?.change).toBe(0n);
    expect(got?.partialSigs).toHaveLength(2);
    expect(got?.partialSigs?.[0]?.signature).toBe("0x" + "11".repeat(65));
    expect(got?.partialSigs?.[1]?.slotIndex).toBe(1);
  });

  it("selectDraft sets and clears selectedDraftId without persisting it", async () => {
    const first = await import("./payroll-batches");
    first.usePayrollBatchesStore.getState().selectDraft("draft-1");
    expect(first.usePayrollBatchesStore.getState().selectedDraftId).toBe("draft-1");

    // selectedDraftId is intentionally ephemeral — the partialize config keeps
    // it out of localStorage so a fresh window doesn't auto-resume a draft.
    vi.resetModules();
    const second = await import("./payroll-batches");
    expect(second.usePayrollBatchesStore.getState().selectedDraftId).toBeNull();
  });
});

// ── 2.7b-2: drainIncomingSigsInto + recordCommSendStatus + auto-transition ───

describe("payroll-batches store — comm-channel auto-match", () => {
  const DIGEST = "0x" + "ab".repeat(32);
  // Two real secp keys so we can produce recoverable sigs.
  const KEY_A = "0x" + "11".repeat(32);
  const KEY_B = "0x" + "22".repeat(32);
  const KEY_C = "0x" + "33".repeat(32);

  async function setup() {
    const batches = await import("./payroll-batches");
    const incoming = await import("./incoming-sigs");
    const signer = await import("@/lib/signers/ckb-secp256k1");
    return { batches, incoming, signer };
  }

  function calculatedBatch(): PayrollBatch {
    return {
      ...sampleBatch,
      id: "comm-1",
      state: "calculated",
      sighashDigest: DIGEST,
      partialSigs: [],
    };
  }

  it("drainIncomingSigsInto pulls a valid buffered sig and stamps signerPubkeyHash + sourceCommTx", async () => {
    const { batches, incoming, signer } = await setup();
    const hashA = signer.pubkeyHashFromPrivateKey(KEY_A);
    const sigA = signer.signDigest(DIGEST, KEY_A);

    batches.usePayrollBatchesStore.getState().addBatch(calculatedBatch());
    incoming.useIncomingSigsStore.getState().enqueue({
      sighashDigest: DIGEST,
      slotIndex: 0,
      signature: sigA,
      senderAddrHash: "0x" + "aa".repeat(20),
      receivedAt: 1700000000000,
      sourceCommTx: "0xc0c0",
    });

    const result = batches.usePayrollBatchesStore.getState().drainIncomingSigsInto(
      "comm-1",
      { m: 2, pubkeyHashes: [hashA, signer.pubkeyHashFromPrivateKey(KEY_B)] },
    );

    expect(result).toEqual({ merged: 1, rejected: 0 });
    const got = batches.usePayrollBatchesStore.getState().findById("comm-1");
    expect(got?.partialSigs).toHaveLength(1);
    expect(got?.partialSigs?.[0]?.slotIndex).toBe(0);
    expect(got?.partialSigs?.[0]?.signerPubkeyHash).toBe(hashA);
    expect(got?.partialSigs?.[0]?.sourceCommTx).toBe("0xc0c0");
    expect(incoming.useIncomingSigsStore.getState().bySighash[DIGEST]).toBeUndefined();
  });

  it("drainIncomingSigsInto dedups by slotIndex — first valid wins", async () => {
    const { batches, incoming, signer } = await setup();
    const hashA = signer.pubkeyHashFromPrivateKey(KEY_A);
    const hashB = signer.pubkeyHashFromPrivateKey(KEY_B);
    const sigA = signer.signDigest(DIGEST, KEY_A);
    const sigB = signer.signDigest(DIGEST, KEY_B);

    batches.usePayrollBatchesStore.getState().addBatch({
      ...calculatedBatch(),
      partialSigs: [
        {
          slotIndex: 0,
          signature: sigA,
          signerPubkeyHash: hashA,
        },
      ],
    });
    // Second sig for slot 0 (from a different signer) — should be rejected as dup.
    incoming.useIncomingSigsStore.getState().enqueue({
      sighashDigest: DIGEST,
      slotIndex: 0,
      signature: sigB,
      senderAddrHash: "0x" + "bb".repeat(20),
      receivedAt: 1700000000000,
    });

    const result = batches.usePayrollBatchesStore.getState().drainIncomingSigsInto(
      "comm-1",
      { m: 2, pubkeyHashes: [hashA, hashB] },
    );
    expect(result.rejected).toBe(1);
    expect(batches.usePayrollBatchesStore.getState().findById("comm-1")?.partialSigs).toHaveLength(
      1,
    );
  });

  it("drainIncomingSigsInto rejects a sig that recovers to the wrong slot hash", async () => {
    const { batches, incoming, signer } = await setup();
    const hashA = signer.pubkeyHashFromPrivateKey(KEY_A);
    const hashB = signer.pubkeyHashFromPrivateKey(KEY_B);
    const hashC = signer.pubkeyHashFromPrivateKey(KEY_C);
    const sigC = signer.signDigest(DIGEST, KEY_C);

    batches.usePayrollBatchesStore.getState().addBatch(calculatedBatch());
    // KEY_C signed, but pubkeyHashes only knows A and B — recovered hash won't match either.
    incoming.useIncomingSigsStore.getState().enqueue({
      sighashDigest: DIGEST,
      slotIndex: 0,
      signature: sigC,
      senderAddrHash: "0x" + "cc".repeat(20),
      receivedAt: 1700000000000,
    });
    void hashC;

    const result = batches.usePayrollBatchesStore.getState().drainIncomingSigsInto(
      "comm-1",
      { m: 2, pubkeyHashes: [hashA, hashB] },
    );
    expect(result).toEqual({ merged: 0, rejected: 1 });
    expect(batches.usePayrollBatchesStore.getState().findById("comm-1")?.partialSigs).toEqual([]);
  });

  it("drainIncomingSigsInto on a missing batch returns zero merges and zero rejects", async () => {
    const { batches } = await setup();
    const result = batches.usePayrollBatchesStore.getState().drainIncomingSigsInto(
      "does-not-exist",
      { m: 2, pubkeyHashes: [`0x${"00".repeat(20)}`] },
    );
    expect(result).toEqual({ merged: 0, rejected: 0 });
  });

  it("drainIncomingSigsInto auto-transitions calculated → approved when M sigs collected", async () => {
    const { batches, incoming, signer } = await setup();
    const hashA = signer.pubkeyHashFromPrivateKey(KEY_A);
    const hashB = signer.pubkeyHashFromPrivateKey(KEY_B);
    const sigA = signer.signDigest(DIGEST, KEY_A);
    const sigB = signer.signDigest(DIGEST, KEY_B);

    batches.usePayrollBatchesStore.getState().addBatch(calculatedBatch());
    incoming.useIncomingSigsStore.getState().enqueue({
      sighashDigest: DIGEST,
      slotIndex: 0,
      signature: sigA,
      senderAddrHash: "0x" + "aa".repeat(20),
      receivedAt: 1700000000000,
    });
    incoming.useIncomingSigsStore.getState().enqueue({
      sighashDigest: DIGEST,
      slotIndex: 1,
      signature: sigB,
      senderAddrHash: "0x" + "bb".repeat(20),
      receivedAt: 1700000000000,
    });

    batches.usePayrollBatchesStore.getState().drainIncomingSigsInto("comm-1", {
      m: 2,
      pubkeyHashes: [hashA, hashB],
    });

    const got = batches.usePayrollBatchesStore.getState().findById("comm-1");
    expect(got?.partialSigs).toHaveLength(2);
    expect(got?.state).toBe("approved");
  });

  it("recordCommSendStatus writes a per-slot entry under commSendStatus", async () => {
    const { batches } = await setup();
    batches.usePayrollBatchesStore.getState().addBatch(calculatedBatch());
    batches.usePayrollBatchesStore
      .getState()
      .recordCommSendStatus("comm-1", 0, "sent", { txHash: "0xdeadbeef" });
    const got = batches.usePayrollBatchesStore.getState().findById("comm-1");
    expect(got?.commSendStatus?.[0]?.status).toBe("sent");
    expect(got?.commSendStatus?.[0]?.txHash).toBe("0xdeadbeef");
    expect(typeof got?.commSendStatus?.[0]?.updatedAt).toBe("number");
  });

  it("recordCommSendStatus patches the existing slot — txHash from a prior call is preserved across a retryCount-only update", async () => {
    const { batches } = await setup();
    batches.usePayrollBatchesStore.getState().addBatch(calculatedBatch());
    batches.usePayrollBatchesStore
      .getState()
      .recordCommSendStatus("comm-1", 0, "sent", { txHash: "0xinitial" });
    batches.usePayrollBatchesStore
      .getState()
      .recordCommSendStatus("comm-1", 0, "sent", { retryCount: 1 });
    const got = batches.usePayrollBatchesStore.getState().findById("comm-1");
    expect(got?.commSendStatus?.[0]?.txHash).toBe("0xinitial");
    expect(got?.commSendStatus?.[0]?.retryCount).toBe(1);
    expect(got?.commSendStatus?.[0]?.status).toBe("sent");
  });
});

describe("2.7c retryNow + dismissRetry", () => {
  it("retryNow resets retryCount, clears nextRetryAt and dismissed", async () => {
    const { usePayrollBatchesStore } = await import("./payroll-batches");
    const store = usePayrollBatchesStore.getState();
    store.addBatch({
      id: "b1",
      state: "approved",
      commSendStatus: {
        0: {
          status: "sent",
          updatedAt: Date.now() - 1000,
          retryCount: 5,
          nextRetryAt: Date.now() + 30 * 60_000,
          dismissed: false,
        },
      },
    } as any);
    store.retryNow("b1", 0);
    const slot = store.findById("b1")!.commSendStatus![0]!;
    expect(slot.retryCount).toBe(0);
    expect(slot.nextRetryAt).toBeUndefined();
    expect(slot.dismissed).toBeUndefined();
  });

  it("dismissRetry sets dismissed=true", async () => {
    const { usePayrollBatchesStore } = await import("./payroll-batches");
    const store = usePayrollBatchesStore.getState();
    store.addBatch({
      id: "b1",
      state: "approved",
      commSendStatus: { 0: { status: "sent", updatedAt: Date.now(), retryCount: 1 } },
    } as any);
    store.dismissRetry("b1", 0);
    const slot = store.findById("b1")!.commSendStatus![0]!;
    expect(slot.dismissed).toBe(true);
  });

  it("retryNow on non-existent batch is a no-op", async () => {
    const { usePayrollBatchesStore } = await import("./payroll-batches");
    const store = usePayrollBatchesStore.getState();
    store.retryNow("doesnotexist", 0);
    // No throw; nothing changes
    expect(store.findById("doesnotexist")).toBeUndefined();
  });

  it("dismissRetry on non-existent slot is a no-op", async () => {
    const { usePayrollBatchesStore } = await import("./payroll-batches");
    const store = usePayrollBatchesStore.getState();
    store.addBatch({ id: "b1", state: "approved" } as any);
    store.dismissRetry("b1", 99);
    expect(store.findById("b1")!.commSendStatus).toBeUndefined();
  });
});

describe("2.7c auto-broadcast state transitions", () => {
  it("setAutoBroadcast(batchId, true) flips the toggle", async () => {
    const { usePayrollBatchesStore } = await import("./payroll-batches");
    const store = usePayrollBatchesStore.getState();
    store.addBatch({ id: "b1", state: "approved" } as any);
    store.setAutoBroadcast("b1", true);
    expect(store.findById("b1")!.autoBroadcast).toBe(true);
  });

  it("cancelAutoBroadcast transitions broadcast_countdown → approved (sigs preserved, toggle stays on)", async () => {
    const { usePayrollBatchesStore } = await import("./payroll-batches");
    const store = usePayrollBatchesStore.getState();
    store.addBatch({
      id: "b1",
      state: "broadcast_countdown",
      autoBroadcast: true,
      partialSigs: [
        { slotIndex: 0, signature: "0xa" },
        { slotIndex: 1, signature: "0xb" },
      ],
    } as any);
    store.cancelAutoBroadcast("b1");
    const b = store.findById("b1")!;
    expect(b.state).toBe("approved");
    expect(b.partialSigs).toHaveLength(2);
    expect(b.autoBroadcast).toBe(true);
  });

  it("markBroadcastInitiating sets broadcastInFlight=true and transitions state", async () => {
    const { usePayrollBatchesStore } = await import("./payroll-batches");
    const store = usePayrollBatchesStore.getState();
    store.addBatch({ id: "b1", state: "broadcast_countdown" } as any);
    store.markBroadcastInitiating("b1");
    const b = store.findById("b1")!;
    expect(b.state).toBe("broadcast_initiating");
    expect(b.broadcastInFlight).toBe(true);
  });

  it("markBroadcastInitiating is idempotent — no-op if broadcastInFlight is already true", async () => {
    const { usePayrollBatchesStore } = await import("./payroll-batches");
    const store = usePayrollBatchesStore.getState();
    store.addBatch({
      id: "b1",
      state: "broadcast_initiating",
      broadcastInFlight: true,
    } as any);
    const before = store.findById("b1")!;
    store.markBroadcastInitiating("b1");
    const after = store.findById("b1")!;
    expect(after.state).toBe(before.state);
    expect(after.broadcastInFlight).toBe(before.broadcastInFlight);
  });

  it("markBroadcastFailed sets state + broadcastError and clears broadcastInFlight", async () => {
    const { usePayrollBatchesStore } = await import("./payroll-batches");
    const store = usePayrollBatchesStore.getState();
    store.addBatch({
      id: "b1",
      state: "broadcast_initiating",
      broadcastInFlight: true,
    } as any);
    store.markBroadcastFailed("b1", "RPC timeout after 30s");
    const b = store.findById("b1")!;
    expect(b.state).toBe("broadcast_failed");
    expect(b.broadcastError).toBe("RPC timeout after 30s");
    expect(b.broadcastInFlight).toBeUndefined();
  });

  it("markBroadcastFailed transitions broadcast_countdown → broadcast_failed (onElapsed pre-check)", async () => {
    // BUG 4 fix: this is the transition AutoBroadcastCountdown.onElapsed's
    // three pre-checks rely on — before state-machine.ts allowed it, this
    // call silently no-op'd (canTransition guard returned the batch
    // untouched), leaving broadcast_countdown wedged with no error and no
    // Retry button. See docs/superpowers/plans/2026-08-12-auto-broadcast-bundle.md Task A.
    const { usePayrollBatchesStore } = await import("./payroll-batches");
    const store = usePayrollBatchesStore.getState();
    store.addBatch({
      id: "b1",
      state: "broadcast_countdown",
      broadcastInFlight: undefined,
    } as any);
    store.markBroadcastFailed("b1", "Configure broadcast RPC URL in Settings");
    const b = store.findById("b1")!;
    expect(b.state).toBe("broadcast_failed");
    expect(b.broadcastError).toBe("Configure broadcast RPC URL in Settings");
    expect(b.broadcastInFlight).toBeUndefined();
  });

  it("retryAutoBroadcast re-arms the countdown after a failed send", async () => {
    const { usePayrollBatchesStore } = await import("./payroll-batches");
    const store = usePayrollBatchesStore.getState();
    store.addBatch({ id: "b1", state: "broadcast_failed", broadcastError: "x" } as any);
    store.retryAutoBroadcast("b1");
    const b = store.findById("b1")!;
    expect(b.state).toBe("broadcast_countdown");
    expect(b.broadcastError).toBeUndefined();
  });

  it("lets only the first countdown callback claim broadcast initiation", async () => {
    const { usePayrollBatchesStore } = await import("./payroll-batches");
    const store = usePayrollBatchesStore.getState();
    store.addBatch({ id: "b1", state: "broadcast_countdown" } as any);
    expect(store.markBroadcastInitiating("b1")).toBe(true);
    expect(store.markBroadcastInitiating("b1")).toBe(false);
  });
});

// ── Phase 5 Slice C: accounting-post lifecycle ───────────────────────────────

describe("accounting-post lifecycle (markPosting / markPosted / markPostFailed)", () => {
  it("drives the accounting-post lifecycle", async () => {
    const { usePayrollBatchesStore } = await import("./payroll-batches");
    const store = usePayrollBatchesStore.getState();
    const addConfirmedBatch = (id: string) =>
      store.addBatch({ ...sampleBatch, id, state: "confirmed" });
    const get = (id: string) => store.findById(id) as PayrollBatch;

    addConfirmedBatch("pbX");
    store.markPosting("pbX");
    expect(get("pbX").state).toBe("posting");
    store.markPosted("pbX", "ACC-JV-0009");
    expect(get("pbX").state).toBe("posted");
    expect(get("pbX").jeName).toBe("ACC-JV-0009");
  });

  it("records a post failure with the error and allows retry", async () => {
    const { usePayrollBatchesStore } = await import("./payroll-batches");
    const store = usePayrollBatchesStore.getState();
    const addConfirmedBatch = (id: string) =>
      store.addBatch({ ...sampleBatch, id, state: "confirmed" });
    const get = (id: string) => store.findById(id) as PayrollBatch;

    addConfirmedBatch("pbY");
    store.markPosting("pbY");
    store.markPostFailed("pbY", "boom");
    expect(get("pbY").state).toBe("post_failed");
    expect(get("pbY").postError).toBe("boom");
    store.markPosting("pbY"); // retry: post_failed → posting
    expect(get("pbY").state).toBe("posting");
  });

  it("markPosting clears postError from a previous failure", async () => {
    const { usePayrollBatchesStore } = await import("./payroll-batches");
    const store = usePayrollBatchesStore.getState();
    const addConfirmedBatch = (id: string) =>
      store.addBatch({ ...sampleBatch, id, state: "confirmed" });
    const get = (id: string) => store.findById(id) as PayrollBatch;

    addConfirmedBatch("pbZ");
    store.markPosting("pbZ");
    store.markPostFailed("pbZ", "transient error");
    store.markPosting("pbZ"); // retry
    expect(get("pbZ").postError).toBeUndefined();
  });
});

// ── Phase 5 Slice C: kind guard — vendor batches immune to accounting-post actions ──

describe("accounting-post kind guard — vendor batch is never mutated", () => {
  it("markPosting called with a vendor batch id is a no-op (state stays confirmed, no jeName/postError)", async () => {
    const { usePayrollBatchesStore } = await import("./payroll-batches");
    const store = usePayrollBatchesStore.getState();

    const vendorBatch: VendorPaymentBatch = {
      kind: "vendor",
      id: "vb-guard-1",
      createdAt: "2026-06-25T00:00:00Z",
      updatedAt: "2026-06-25T00:00:00Z",
      label: "Acme INV-002",
      treasuryId: "tr_1",
      invoiceIds: ["inv_2"],
      vendorId: "vendor_1",
      fxSnapshot: [],
      lines: [
        {
          vendorId: "vendor_1",
          fiat: { minor: 200n, currency: "AUD" },
          crypto: { value: 2_000_000n, asset: "CKB", decimals: 8 },
          fxRate: "1",
          feeAllocated: { value: 0n, asset: "CKB", decimals: 8 },
        },
      ],
      state: "confirmed",
    };

    store.addBatch(vendorBatch);
    store.markPosting("vb-guard-1");

    const got = store.findById("vb-guard-1")!;
    expect(got.kind).toBe("vendor");
    expect(got.state).toBe("confirmed");
    // PayrollBatch-only fields must not have been written onto the vendor batch
    expect((got as unknown as Record<string, unknown>)["jeName"]).toBeUndefined();
    expect((got as unknown as Record<string, unknown>)["postError"]).toBeUndefined();
  });
});

// ── 3a-T11: kind discriminator + v1→v2 migration ────────────────────────────

describe("kind discriminator + v1→v2 migration", () => {
  it("addBatch accepts a VendorPaymentBatch", async () => {
    const { usePayrollBatchesStore } = await import("./payroll-batches");
    const vb: VendorPaymentBatch = {
      kind: "vendor",
      id: "vb_1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      label: "Acme INV-001",
      treasuryId: "tr_1",
      invoiceIds: ["inv_1"],
      vendorId: "vendor_1",
      fxSnapshot: [],
      lines: [
        {
          vendorId: "vendor_1",
          fiat: { minor: 100n, currency: "AUD" },
          crypto: { value: 1_000_000n, asset: "CKB", decimals: 8 },
          fxRate: "1",
          feeAllocated: { value: 0n, asset: "CKB", decimals: 8 },
        },
      ],
      state: "draft",
    };
    usePayrollBatchesStore.getState().addBatch(vb);
    const stored = usePayrollBatchesStore.getState().findById("vb_1");
    expect(stored?.kind).toBe("vendor");
  });

  it("v1→v2 migration backfills kind: payroll on records without one", async () => {
    const v1Blob = {
      state: {
        batches: [
          {
            id: "old_1",
            label: "Old Batch",
            treasuryId: "tr_1",
            cycleStart: "2026-01-01",
            cycleEnd: "2026-01-31",
            fxSnapshot: [],
            lines: [],
            state: "draft",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          },
        ],
      },
      version: 1,
    };
    globalThis.localStorage?.setItem("chain-pay:payroll-batches", JSON.stringify(v1Blob));

    const { usePayrollBatchesStore } = await import("./payroll-batches");
    await usePayrollBatchesStore.persist.rehydrate();

    const migrated = usePayrollBatchesStore.getState().batches;
    expect(migrated).toHaveLength(1);
    expect(migrated[0]?.kind).toBe("payroll");
    // Migration must not lose fields.
    expect(migrated[0]?.id).toBe("old_1");
    expect(migrated[0]?.label).toBe("Old Batch");
  });

  it("migration is idempotent — v2 records already having kind are unchanged", async () => {
    const v2Blob = {
      state: {
        batches: [
          {
            kind: "vendor",
            id: "vb_1",
            label: "X",
            treasuryId: "tr_1",
            invoiceIds: ["inv_1"],
            vendorId: "v_1",
            fxSnapshot: [],
            lines: [
              {
                vendorId: "v_1",
                fiat: { minor: "100n", currency: "AUD" },
                crypto: { value: "1000000n", asset: "CKB", decimals: 8 },
                fxRate: "1",
                feeAllocated: { value: "0n", asset: "CKB", decimals: 8 },
              },
            ],
            state: "draft",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          },
        ],
      },
      version: 2,
    };
    globalThis.localStorage?.setItem("chain-pay:payroll-batches", JSON.stringify(v2Blob));

    const { usePayrollBatchesStore } = await import("./payroll-batches");
    await usePayrollBatchesStore.persist.rehydrate();

    expect(usePayrollBatchesStore.getState().batches[0]?.kind).toBe("vendor");
  });
});
