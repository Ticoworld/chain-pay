import type { Identified, Timestamped, TransactionHash } from "./types";
import type { Money, FiatAmount } from "./money";

export type SendState =
  | "draft"
  | "built"
  | "signing"
  | "broadcasted"
  | "confirmed"
  | "posting"
  | "posted"
  | "post_failed";

export interface SendOutput {
  payeeId: string;
  payeeAddress: string;
  amount: Money;
  /** User-entered fiat valuation of this line (zero-FX: obligation == carryingCost). */
  fiat: FiatAmount;
}

export interface SendRecord extends Identified, Timestamped {
  sourceId: string;
  chain: "ckb:mainnet" | "ckb:testnet";
  outputs: SendOutput[];
  feeShannons: bigint;
  state: SendState;
  txHash?: TransactionHash;
  confirmedAt?: string;
  journalEntryName?: string;
  postError?: string;
}
