import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type {
  AnyBatch,
  CommSendSlotStatus,
  PartialSigEntry,
  PayrollBatch,
  PayrollBatchState,
} from "@chain-pay/shared";
import { assertCanTransition, canTransition } from "@/lib/payroll/state-machine";
import { recoverPubkeyHashFromSignature } from "@/lib/signers/ckb-secp256k1";
import { useIncomingSigsStore } from "./incoming-sigs";

export interface MultisigDrainCfg {
  /** Threshold — auto-transitions to `approved` when partialSigs reaches this. */
  m: number;
  /** Canonical slot → pubkey hash mapping for sig validation. */
  pubkeyHashes: readonly `0x${string}`[];
}

interface PayrollBatchesStore {
  batches: AnyBatch[];
  /**
   * Batch id the user has elected to resume in PayPanel. PayPanel reads this
   * on mount, hydrates from the matching batch, then clears it. Lives in the
   * store (not URL state) so the Resume button on PayrollBatches doesn't need
   * to know about routing internals.
   */
  selectedDraftId: string | null;
  /**
   * Add a batch. Idempotent: if a batch with the same id is already in the
   * store, the call is a no-op (avoids accidental duplicate-listing from
   * effect-driven callers in 3a invoice → vendor-batch flow).
   */
  addBatch: (b: AnyBatch) => void;
  /**
   * Update a batch. Patch is typed against shared fields — lines (per-kind)
   * are never patched here; use kind-specific actions for those.
   */
  updateBatch: (id: string, patch: Partial<Omit<PayrollBatch, "id" | "createdAt" | "kind">>) => void;
  /** Advance a batch's state through the validated state machine. Throws on invalid transitions or unknown ids. */
  transition: (id: string, to: PayrollBatchState) => void;
  removeBatch: (id: string) => void;
  findById: (id: string) => AnyBatch | undefined;
  selectDraft: (id: string | null) => void;
  /**
   * Pull all buffered incoming sigs whose sighashDigest matches this batch's,
   * validate each against the given multisig config, and merge the valid ones
   * into partialSigs. Auto-transitions calculated → approved when partialSigs
   * reaches M. Invalid entries are dropped silently (NOT re-buffered).
   */
  drainIncomingSigsInto: (
    batchId: string,
    multisig: MultisigDrainCfg,
  ) => { merged: number; rejected: number };
  /** Record per-slot comm-send status (idle/sending/sent/acked/error) on a batch. */
  recordCommSendStatus: (
    batchId: string,
    slotIndex: number,
    status: CommSendSlotStatus["status"],
    detail?: { txHash?: string; error?: string; retryCount?: number; nextRetryAt?: number },
  ) => void;
  /** Reset retryCount to 0, clear nextRetryAt and dismissed, bump updatedAt — schedules retry from attempt 1. */
  retryNow: (batchId: string, slotIndex: number) => void;
  /** Set dismissed=true — retry scheduler will skip this slot indefinitely. */
  dismissRetry: (batchId: string, slotIndex: number) => void;
  /** Toggle the auto-broadcast flag on a batch. */
  setAutoBroadcast: (batchId: string, value: boolean) => void;
  /** Transition a batch into broadcast_countdown (called by external countdown timer or Mth-sig side-effect). */
  markBroadcastCountdown: (batchId: string) => void;
  /** Cancel a pending broadcast_countdown — returns to approved without clearing sigs or autoBroadcast flag. */
  cancelAutoBroadcast: (batchId: string) => void;
  /** Atomically claim the send; returns false if another callback already claimed it. */
  markBroadcastInitiating: (batchId: string) => boolean;
  /** Record a broadcast failure — sets broadcastError, clears broadcastInFlight, transitions to broadcast_failed. */
  markBroadcastFailed: (batchId: string, error: string) => void;
  /** Operator re-arms the countdown after a broadcast failure. */
  retryAutoBroadcast: (batchId: string) => void;
  /** Transition a confirmed (or post_failed) batch into posting — clears any prior postError. */
  markPosting: (batchId: string) => void;
  /** Record a successful journal-entry post — sets jeName and transitions to posted. */
  markPosted: (batchId: string, jeName: string) => void;
  /** Record a post failure — sets postError and transitions to post_failed. */
  markPostFailed: (batchId: string, error: string) => void;
}

// PayrollBatch holds bigints inside `lines[i].fiat.minor`, `lines[i].crypto.value`,
// and `lines[i].feeAllocated.value`. Same suffix-tagged JSON pattern as the
// treasury and payees stores so localStorage round-trips lossless.
function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? `${value.toString()}n` : value;
}

function bigintReviver(_key: string, value: unknown): unknown {
  if (typeof value === "string" && /^-?\d+n$/.test(value)) {
    return BigInt(value.slice(0, -1));
  }
  return value;
}

const batchesStorage: StateStorage = {
  getItem: (name) => globalThis.localStorage?.getItem(name) ?? null,
  setItem: (name, value) => globalThis.localStorage?.setItem(name, value),
  removeItem: (name) => globalThis.localStorage?.removeItem(name),
};

const jsonStorage = createJSONStorage(() => batchesStorage, {
  replacer: bigintReplacer,
  reviver: bigintReviver,
});

export const usePayrollBatchesStore = create<PayrollBatchesStore>()(
  persist(
    (set, get) => ({
      batches: [],
      selectedDraftId: null,
      addBatch: (b) =>
        set((s) => (s.batches.some((x) => x.id === b.id) ? s : { batches: [...s.batches, b] })),
      selectDraft: (id) => set({ selectedDraftId: id }),
      updateBatch: (id, patch) =>
        set((s) => ({
          batches: s.batches.map((b) =>
            b.id === id
              ? ({ ...b, ...patch, id: b.id, createdAt: b.createdAt, updatedAt: new Date().toISOString() } as AnyBatch)
              : b,
          ),
        })),
      transition: (id, to) => {
        const current = get().batches.find((b) => b.id === id);
        if (!current) throw new Error(`batch not found: ${id}`);
        assertCanTransition(current.state, to);
        set((s) => ({
          batches: s.batches.map((b) =>
            b.id === id ? { ...b, state: to, updatedAt: new Date().toISOString() } : b,
          ),
        }));
      },
      removeBatch: (id) => set((s) => ({ batches: s.batches.filter((b) => b.id !== id) })),
      findById: (id) => get().batches.find((b) => b.id === id),
      drainIncomingSigsInto: (batchId, multisig) => {
        const batch = get().batches.find((b) => b.id === batchId);
        if (!batch || !batch.sighashDigest) return { merged: 0, rejected: 0 };

        const existingSlots = new Set((batch.partialSigs ?? []).map((p) => p.slotIndex));
        const buffered = useIncomingSigsStore.getState().drain(batch.sighashDigest);

        const accepted: PartialSigEntry[] = [];
        let rejected = 0;
        for (const entry of buffered) {
          if (existingSlots.has(entry.slotIndex)) {
            rejected++;
            continue;
          }
          const expected = multisig.pubkeyHashes[entry.slotIndex];
          if (!expected) {
            rejected++;
            continue;
          }
          const recovered = recoverPubkeyHashFromSignature(batch.sighashDigest, entry.signature);
          if (!recovered || recovered !== expected) {
            rejected++;
            continue;
          }
          accepted.push({
            slotIndex: entry.slotIndex,
            signature: entry.signature,
            signerPubkeyHash: expected,
            ...(entry.sourceCommTx !== undefined ? { sourceCommTx: entry.sourceCommTx } : {}),
          });
          existingSlots.add(entry.slotIndex);
        }

        if (accepted.length === 0) return { merged: 0, rejected };

        const previousSigCount = batch.partialSigs?.length ?? 0;
        const mergedSigs = [...(batch.partialSigs ?? []), ...accepted];
        const justCrossedM =
          mergedSigs.length === multisig.m && previousSigCount < multisig.m;
        const shouldAutoBroadcast =
          justCrossedM &&
          batch.autoBroadcast === true &&
          canTransition("approved", "broadcast_countdown");
        const shouldPromoteApproved =
          justCrossedM && !shouldAutoBroadcast && canTransition(batch.state, "approved");

        set((s) => ({
          batches: s.batches.map((b) =>
            b.id === batchId
              ? {
                  ...b,
                  partialSigs: mergedSigs,
                  ...(shouldAutoBroadcast
                    ? { state: "broadcast_countdown" as PayrollBatchState }
                    : shouldPromoteApproved
                      ? { state: "approved" as PayrollBatchState }
                      : {}),
                  updatedAt: new Date().toISOString(),
                }
              : b,
          ),
        }));

        return { merged: accepted.length, rejected };
      },
      recordCommSendStatus: (batchId, slotIndex, status, detail) => {
        set((s) => ({
          batches: s.batches.map((b) => {
            if (b.id !== batchId) return b;
            const existing = b.commSendStatus?.[slotIndex] ?? {};
            const slot: CommSendSlotStatus = {
              ...existing,
              status,
              updatedAt: Date.now(),
              ...(detail?.txHash !== undefined ? { txHash: detail.txHash } : {}),
              ...(detail?.error !== undefined ? { error: detail.error } : {}),
              ...(detail?.retryCount !== undefined ? { retryCount: detail.retryCount } : {}),
              ...(detail?.nextRetryAt !== undefined ? { nextRetryAt: detail.nextRetryAt } : {}),
            };
            return {
              ...b,
              commSendStatus: { ...(b.commSendStatus ?? {}), [slotIndex]: slot },
              updatedAt: new Date().toISOString(),
            };
          }),
        }));
      },
      retryNow: (batchId, slotIndex) => {
        set((s) => ({
          batches: s.batches.map((b) => {
            if (b.id !== batchId) return b;
            const existing = b.commSendStatus?.[slotIndex];
            if (!existing) return b;
            // Strip nextRetryAt and dismissed; reset retryCount; bump updatedAt.
            const { nextRetryAt: _n, dismissed: _d, ...rest } = existing;
            return {
              ...b,
              commSendStatus: {
                ...b.commSendStatus,
                [slotIndex]: { ...rest, retryCount: 0, updatedAt: Date.now() },
              },
            };
          }),
        }));
      },
      dismissRetry: (batchId, slotIndex) => {
        set((s) => ({
          batches: s.batches.map((b) => {
            if (b.id !== batchId) return b;
            const existing = b.commSendStatus?.[slotIndex];
            if (!existing) return b;
            return {
              ...b,
              commSendStatus: {
                ...b.commSendStatus,
                [slotIndex]: { ...existing, dismissed: true },
              },
            };
          }),
        }));
      },
      setAutoBroadcast: (batchId, value) => {
        set((s) => ({
          batches: s.batches.map((b) =>
            b.id === batchId ? { ...b, autoBroadcast: value } : b,
          ),
        }));
      },
      markBroadcastCountdown: (batchId) => {
        set((s) => ({
          batches: s.batches.map((b) => {
            if (b.id !== batchId) return b;
            if (!canTransition(b.state, "broadcast_countdown")) return b;
            return { ...b, state: "broadcast_countdown" as PayrollBatchState };
          }),
        }));
      },
      cancelAutoBroadcast: (batchId) => {
        set((s) => ({
          batches: s.batches.map((b) => {
            if (b.id !== batchId || b.state !== "broadcast_countdown") return b;
            const { broadcastInFlight: _bif, ...rest } = b;
            return { ...rest, state: "approved" as PayrollBatchState };
          }),
        }));
      },
      markBroadcastInitiating: (batchId) => {
        let claimed = false;
        set((s) => ({
          batches: s.batches.map((b) => {
            if (b.id !== batchId) return b;
            if (b.broadcastInFlight === true) return b; // idempotency guard
            if (!canTransition(b.state, "broadcast_initiating")) return b;
            claimed = true;
            return { ...b, state: "broadcast_initiating" as PayrollBatchState, broadcastInFlight: true };
          }),
        }));
        return claimed;
      },
      markBroadcastFailed: (batchId, error) => {
        set((s) => ({
          batches: s.batches.map((b) => {
            if (b.id !== batchId) return b;
            if (!canTransition(b.state, "broadcast_failed")) return b;
            const { broadcastInFlight: _bif, ...rest } = b;
            return { ...rest, state: "broadcast_failed" as PayrollBatchState, broadcastError: error };
          }),
        }));
      },
      retryAutoBroadcast: (batchId) => {
        set((s) => ({
          batches: s.batches.map((b) => {
            if (b.id !== batchId) return b;
            if (!canTransition(b.state, "broadcast_countdown")) return b;
            const { broadcastError: _be, broadcastInFlight: _bif, ...rest } = b;
            return { ...rest, state: "broadcast_countdown" as PayrollBatchState };
          }),
        }));
      },
      markPosting: (batchId) => {
        set((s) => ({
          batches: s.batches.map((b) => {
            if (b.id !== batchId) return b;
            if (b.kind !== "payroll") return b;
            assertCanTransition(b.state, "posting");
            const { postError: _drop, ...rest } = b;
            return { ...rest, state: "posting" as PayrollBatchState, updatedAt: new Date().toISOString() };
          }),
        }));
      },
      markPosted: (batchId, jeName) => {
        set((s) => ({
          batches: s.batches.map((b) => {
            if (b.id !== batchId) return b;
            if (b.kind !== "payroll") return b;
            assertCanTransition(b.state, "posted");
            return { ...b, state: "posted" as PayrollBatchState, jeName, updatedAt: new Date().toISOString() };
          }),
        }));
      },
      markPostFailed: (batchId, error) => {
        set((s) => ({
          batches: s.batches.map((b) => {
            if (b.id !== batchId) return b;
            if (b.kind !== "payroll") return b;
            assertCanTransition(b.state, "post_failed");
            return { ...b, state: "post_failed" as PayrollBatchState, postError: error, updatedAt: new Date().toISOString() };
          }),
        }));
      },
    }),
    {
      name: "chain-pay:payroll-batches",
      storage: jsonStorage,
      version: 2,
      partialize: (state) => ({ batches: state.batches }),
      /**
       * v1→v2: backfill `kind: "payroll"` on persisted batches that predate
       * the discriminator. Idempotent — records already carrying a `kind`
       * (vendor batches written by ≥v2 builds) pass through untouched.
       *
       * Field shape is otherwise preserved; bigint suffix-tagging continues
       * to round-trip via the JSONStorage reviver, so no value coercion
       * happens here.
       */
      migrate: (persistedState, version) => {
        const state = (persistedState as { batches?: Array<Record<string, unknown>> }) ?? {
          batches: [],
        };
        const incoming = Array.isArray(state.batches) ? state.batches : [];
        if (version < 2) {
          return {
            batches: incoming.map((b) =>
              b !== null && typeof b === "object" && "kind" in b && b.kind
                ? (b as unknown as AnyBatch)
                : ({ ...b, kind: "payroll" } as unknown as AnyBatch),
            ),
          };
        }
        return { batches: incoming as unknown as AnyBatch[] };
      },
    },
  ),
);
