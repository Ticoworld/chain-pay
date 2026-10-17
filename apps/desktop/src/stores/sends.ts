import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { SendRecord, SendState, TransactionHash } from "@chain-pay/shared";
import { assertCanTransition } from "@/lib/send/state-machine";

interface SendsStore {
  sends: SendRecord[];
  addSend: (s: SendRecord) => void;
  markBuilt: (id: string, feeShannons: bigint) => void;
  markSigning: (id: string) => void;
  markBroadcasted: (id: string, txHash: TransactionHash) => void;
  markBackToBuilt: (id: string) => void;
  markConfirmed: (id: string) => void;
  markPosting: (id: string) => void;
  markPosted: (id: string, jeName: string) => void;
  markPostFailed: (id: string, error: string) => void;
  updateAccountingValues: (id: string, minorValues: bigint[]) => void;
  recoverInterruptedPostings: () => void;
}

export const INTERRUPTED_POST_ERROR =
  "Accounting post was interrupted before ChainPay received the result. Retry is safe and will reuse the existing Journal Entry if Frappe already created it.";

function bigintReplacer(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? `${v.toString()}n` : v;
}
function bigintReviver(_k: string, v: unknown): unknown {
  return typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v;
}

const sendsStorage: StateStorage = {
  getItem: (name) => globalThis.localStorage?.getItem(name) ?? null,
  setItem: (name, value) => globalThis.localStorage?.setItem(name, value),
  removeItem: (name) => globalThis.localStorage?.removeItem(name),
};

function transition(
  sends: SendRecord[],
  id: string,
  to: SendState,
  patch: (s: SendRecord) => SendRecord,
): SendRecord[] {
  if (!sends.find((s) => s.id === id)) {
    throw new Error(`send not found: ${id}`);
  }
  return sends.map((s) => {
    if (s.id !== id) return s;
    assertCanTransition(s.state, to);
    const updatedAt = new Date().toISOString();
    return {
      ...patch(s),
      state: to,
      updatedAt,
      ...(to === "confirmed" ? { confirmedAt: updatedAt } : {}),
    };
  });
}

export const useSendsStore = create<SendsStore>()(
  persist(
    (set) => ({
      sends: [],
      addSend: (s) => set((st) => ({ sends: [...st.sends, s] })),
      markBuilt: (id, feeShannons) =>
        set((st) => ({ sends: transition(st.sends, id, "built", (s) => ({ ...s, feeShannons })) })),
      markSigning: (id) =>
        set((st) => ({ sends: transition(st.sends, id, "signing", (s) => s) })),
      markBroadcasted: (id, txHash) =>
        set((st) => ({ sends: transition(st.sends, id, "broadcasted", (s) => ({ ...s, txHash })) })),
      markBackToBuilt: (id) =>
        set((st) => ({ sends: transition(st.sends, id, "built", (s) => s) })),
      markConfirmed: (id) =>
        set((st) => ({ sends: transition(st.sends, id, "confirmed", (s) => s) })),
      markPosting: (id) =>
        set((st) => ({
          sends: transition(st.sends, id, "posting", (s) => {
            const { postError: _drop, ...rest } = s;
            return { ...rest, confirmedAt: s.confirmedAt ?? s.updatedAt };
          }),
        })),
      markPosted: (id, jeName) =>
        set((st) => ({
          sends: transition(st.sends, id, "posted", (s) => {
            const { postError: _drop, ...rest } = s;
            return { ...rest, journalEntryName: jeName };
          }),
        })),
      markPostFailed: (id, error) =>
        set((st) => ({
          sends: transition(st.sends, id, "post_failed", (s) => ({ ...s, postError: error })),
        })),
      updateAccountingValues: (id, minorValues) =>
        set((st) => ({
          sends: st.sends.map((s) => {
            if (s.id !== id) return s;
            if (s.state !== "post_failed") {
              throw new Error(
                `accounting values can only be updated for post_failed sends (got ${s.state})`,
              );
            }
            if (s.journalEntryName) {
              throw new Error("accounting values cannot change after a Journal Entry exists");
            }
            if (
              minorValues.length !== s.outputs.length ||
              minorValues.some((minor) => minor <= 0n)
            ) {
              throw new Error("every send output requires a positive accounting value");
            }
            return {
              ...s,
              outputs: s.outputs.map((output, index) => ({
                ...output,
                fiat: { ...output.fiat, minor: minorValues[index]! },
              })),
              postError: "Accounting value updated. Retry to post the committed transaction.",
              updatedAt: new Date().toISOString(),
            };
          }),
        })),
      recoverInterruptedPostings: () =>
        set((st) => ({
          sends: st.sends.map((s) =>
            s.state === "posting"
              ? {
                  ...s,
                  state: "post_failed" as const,
                  postError: INTERRUPTED_POST_ERROR,
                  updatedAt: new Date().toISOString(),
                }
              : s,
          ),
        })),
    }),
    {
      name: "chain-pay:sends",
      storage: createJSONStorage(() => sendsStorage, { replacer: bigintReplacer, reviver: bigintReviver }),
      version: 1,
      partialize: (st) => ({ sends: st.sends }),
      onRehydrateStorage: () => (state) => {
        state?.recoverInterruptedPostings();
      },
    },
  ),
);
