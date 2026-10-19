import {
  buildBatchJournal,
  type AccountingJournalPreview,
  type ConfirmedPaymentRecord,
  type FiatAmount,
  type PayrollBatch,
  type PayrollBatchLine,
  type PaymentJournalInput,
  type TransactionHash,
} from "@chain-pay/shared";
import type { AccountMap } from "./account-map";

/**
 * Fee in fiat for a line. CARRYING-COST POLICY (Slice C): feeAllocated is the
 * crypto fee for this line; convert it to fiat at the line's fxRate (fiat per 1
 * whole crypto unit). feeAllocated is currently always 0n, so this is 0 today.
 */
function feeFiatForLine(line: PayrollBatchLine): FiatAmount {
  const currency = line.fiat.currency;
  if (line.feeAllocated.value === 0n) return { currency, minor: 0n };
  const divisor = 10n ** BigInt(line.feeAllocated.decimals);
  const whole = line.feeAllocated.value; // smallest units
  // fiat_minor = cryptoSmallest * rate / 10^decimals, rate scaled to 2dp fiat.
  const rateMinor = BigInt(Math.round(Number(line.fxRate) * 100)); // fiat cents per 1 crypto
  return { currency, minor: (whole * rateMinor) / divisor };
}

function lineToPaymentInput(
  line: PayrollBatchLine,
  txHash: TransactionHash,
  map: AccountMap,
): PaymentJournalInput {
  const obligation = { ...line.fiat };
  const feeFiat = feeFiatForLine(line);
  // Zero-FX policy: carryingCost = obligation + feeFiat ⇒ FX gain/loss plug is 0.
  const carryingCost: FiatAmount = {
    currency: obligation.currency,
    minor: obligation.minor + feeFiat.minor,
  };
  return {
    payeeId: line.payeeId,
    obligation,
    feeFiat,
    carryingCost,
    crypto: { ...line.crypto },
    chain: "ckb:testnet",
    txHash,
    salaryAccount: map.salary,
    treasuryAccount: map.treasury,
  };
}

/** Build a balanced AccountingJournalPreview from a confirmed payroll batch. */
export function buildBatchJournalForBatch(
  batch: PayrollBatch,
  map: AccountMap,
): AccountingJournalPreview {
  if (!batch.pendingTxId) {
    throw new Error(`batch ${batch.id} has no pendingTxId; cannot build journal`);
  }
  const txHash = batch.pendingTxId as TransactionHash;
  const payments = batch.lines.map((l) => lineToPaymentInput(l, txHash, map));
  return buildBatchJournal(batch.id, payments, {
    networkFeeExpense: map.networkFeeExpense,
    fxGainLoss: map.fxGainLoss,
  });
}

export function buildConfirmedPayrollRecord(batch: PayrollBatch): ConfirmedPaymentRecord {
  if (!batch.pendingTxId) {
    throw new Error(`batch ${batch.id} has no pendingTxId; cannot persist accounting`);
  }
  if (batch.lines.length === 0) {
    throw new Error(`batch ${batch.id} has no payment lines; cannot persist accounting`);
  }
  return {
    batchId: batch.id,
    sourceType: "payroll",
    label: batch.label,
    chain: "ckb:testnet",
    txHash: batch.pendingTxId as TransactionHash,
    confirmedAt: batch.confirmedAt ?? batch.updatedAt,
    lines: batch.lines.map((line) => ({
      payeeId: line.payeeId,
      fiat: { ...line.fiat },
      crypto: { ...line.crypto },
    })),
  };
}
