import {
  buildBatchJournal,
  type AccountingJournalPreview,
  type ConfirmedPaymentRecord,
  type PaymentJournalInput,
  type SendRecord,
  type TransactionHash,
} from "@chain-pay/shared";
import { useSendsStore } from "@/stores/sends";
import { postJournal } from "@/lib/accounting/ipc";

export interface SendAccountMap {
  expense: string;
  treasury: string;
  networkFeeExpense: string;
  fxGainLoss: string;
}

/**
 * Preview-only defaults. Production posting sends a ConfirmedPaymentRecord
 * without account names; Frappe owns the actual company-bound account mapping.
 */
export const DEFAULT_SEND_ACCOUNT_MAP: SendAccountMap = {
  expense: "Salary or Wage Expense",
  treasury: "Crypto Treasury Asset",
  networkFeeExpense: "Network Fee Expense",
  fxGainLoss: "FX Gain/Loss",
};

const postingBySend = new Map<string, Promise<void>>();

export function buildSendJournal(send: SendRecord, map: SendAccountMap): AccountingJournalPreview {
  if (!send.txHash) throw new Error(`send ${send.id} has no txHash; cannot build journal`);
  for (const output of send.outputs) {
    if (output.fiat.minor <= 0n) {
      throw new Error(
        `Accounting fiat value is required for ${output.payeeId}; ` +
          "enter a positive value before retrying",
      );
    }
  }
  const txHash = send.txHash as TransactionHash;
  const payments: PaymentJournalInput[] = send.outputs.map((o) => ({
    payeeId: o.payeeId,
    obligation: { ...o.fiat },
    feeFiat: { currency: o.fiat.currency, minor: 0n },
    carryingCost: { ...o.fiat }, // zero-FX
    crypto: { ...o.amount },
    chain: send.chain,
    txHash,
    salaryAccount: map.expense,
    treasuryAccount: map.treasury,
  }));
  return buildBatchJournal(send.id, payments, {
    networkFeeExpense: map.networkFeeExpense,
    fxGainLoss: map.fxGainLoss,
    memoLabel: "Send",
  });
}

export function buildConfirmedSendRecord(send: SendRecord): ConfirmedPaymentRecord {
  if (!send.txHash) throw new Error(`send ${send.id} has no txHash; cannot persist accounting`);
  if (send.outputs.length === 0) {
    throw new Error(`send ${send.id} has no outputs; cannot persist accounting`);
  }
  for (const output of send.outputs) {
    if (output.fiat.minor <= 0n) {
      throw new Error(
        `Accounting fiat value is required for ${output.payeeId}; ` +
          "enter a positive value before retrying",
      );
    }
  }
  return {
    batchId: send.id,
    sourceType: "send",
    label: `Send ${send.id}`,
    chain: send.chain,
    txHash: send.txHash,
    confirmedAt: send.confirmedAt ?? send.updatedAt,
    lines: send.outputs.map((output) => ({
      payeeId: output.payeeId,
      fiat: { ...output.fiat },
      crypto: { ...output.amount },
    })),
  };
}

/**
 * Post a confirmed send's JE. Mirrors postBatchJournal: confirmed|post_failed →
 * posting → posted|post_failed. Never throws — failures land as post_failed.
 */
async function runPostSendJournal(sendId: string): Promise<void> {
  const store = useSendsStore.getState();
  const send = store.sends.find((s) => s.id === sendId);
  if (!send) return;
  if (send.state !== "confirmed" && send.state !== "post_failed") return; // double-fire guard

  store.markPosting(sendId);
  try {
    const record = buildConfirmedSendRecord(send);
    const { jeName } = await postJournal(record);
    useSendsStore.getState().markPosted(sendId, jeName);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown posting error";
    useSendsStore.getState().markPostFailed(sendId, message);
  }
}

/**
 * Single-flight accounting recovery. Repeated confirmation events or Retry
 * clicks for the same send share one POST. This function has no dependency on
 * the transaction builder or broadcaster: a send with a txHash is never sent
 * to the chain again from the accounting recovery path.
 */
export function postSendJournal(sendId: string): Promise<void> {
  const existing = postingBySend.get(sendId);
  if (existing) return existing;

  const posting = runPostSendJournal(sendId).finally(() => {
    if (postingBySend.get(sendId) === posting) postingBySend.delete(sendId);
  });
  postingBySend.set(sendId, posting);
  return posting;
}
