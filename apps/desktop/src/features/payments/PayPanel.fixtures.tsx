/**
 * Shared fixtures and harness for the PayPanel characterization suites
 * (`PayPanel.test.tsx` and `PayPanel.batch.test.tsx`).
 *
 * Everything here is built from the real exported types and derived with the
 * real production helpers — there is not a single hand-written CKB address
 * literal, so a fixture cannot silently drift out of shape.
 *
 * NOTE: this file deliberately does NOT call `vi.mock`. Mock registration is
 * per-test-file and must stay in each suite; this module only knows how to
 * *prime* whatever mocks the importing suite installed.
 */
import { expect, vi, type Mock } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { Transaction } from "@ckb-ccc/core";
import type {
  FxQuote,
  Hex20,
  MultisigTreasury,
  PayeeProfile,
  PayrollBatch,
} from "@chain-pay/shared";
import { PayPanel } from "./PayPanel";
import { useTreasuryStore } from "@/stores/treasury";
import { useSyncStore, type CkbSyncState } from "@/stores/sync";
import { usePayeesStore } from "@/stores/payees";
import { usePayrollBatchesStore } from "@/stores/payroll-batches";
import { useIncomingSigsStore } from "@/stores/incoming-sigs";
import { useNetworkConfigStore } from "@/stores/network-config";
import { buildPaymentSkeleton, type PaymentSkeleton } from "@/lib/chains/ckb/tx-builder";
import {
  encodeTransferPacket,
  treasurySighashDigest,
} from "@/lib/chains/ckb/transfer-packet";
import { mergeSignatures } from "@/lib/chains/ckb/merge-signatures";
import { fetchCkbPrices } from "@/lib/fx/coingecko";
import { deriveTreasuryAddress } from "@/lib/chains/ckb/address";
import type { CkbMultisigConfig } from "@/lib/chains/ckb/multisig";

export const hash20 = (byte: string): Hex20 => `0x${byte.repeat(20)}` as Hex20;

/** 2-of-3, the shape PayPanel's treasury guard and SignaturePanel assume. */
export const CFG_A: CkbMultisigConfig = {
  s: 0,
  r: 0,
  m: 2,
  n: 3,
  pubkeyHashes: [hash20("11"), hash20("22"), hash20("33")],
};

/** A second, deliberately different 2-of-3 for cross-treasury tests. */
export const CFG_B: CkbMultisigConfig = {
  s: 0,
  r: 0,
  m: 2,
  n: 3,
  pubkeyHashes: [hash20("44"), hash20("55"), hash20("66")],
};

export const RECIPIENT_ADDRESS = deriveTreasuryAddress(
  { s: 0, r: 0, m: 1, n: 1, pubkeyHashes: [hash20("ab")] },
  "testnet",
);
export const RECIPIENT_ADDRESS_2 = deriveTreasuryAddress(
  { s: 0, r: 0, m: 1, n: 1, pubkeyHashes: [hash20("cd")] },
  "testnet",
);

export function ckbTreasury(opts: {
  id: string;
  label: string;
  cfg: CkbMultisigConfig;
  chain?: "ckb:testnet" | "ckb:mainnet";
  /** Override to simulate config/address drift. */
  addressFromCfg?: CkbMultisigConfig;
}): MultisigTreasury {
  const chain = opts.chain ?? "ckb:testnet";
  const network = chain === "ckb:mainnet" ? "mainnet" : "testnet";
  return {
    id: opts.id,
    kind: "multisig",
    label: opts.label,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    multisig: {
      chain,
      s: 0,
      r: opts.cfg.r,
      m: opts.cfg.m,
      n: opts.cfg.n,
      pubkeyHashes: opts.cfg.pubkeyHashes,
      address: deriveTreasuryAddress(opts.addressFromCfg ?? opts.cfg, network),
    },
  };
}

export const TREASURY_A = ckbTreasury({ id: "ckb-1", label: "Ops treasury", cfg: CFG_A });
export const TREASURY_B = ckbTreasury({ id: "ckb-2", label: "Payroll treasury", cfg: CFG_B });

export function syncState(over: Partial<CkbSyncState> = {}): CkbSyncState {
  // syncReady === ckb.started && ckb.peers > 0 (PayPanel line 563). There is no
  // `ready` flag on CkbSyncState — priming one would silently leave Build
  // disabled and every build test would fail on the control, not the behaviour.
  return {
    started: true,
    starting: false,
    network: "testnet",
    tipBlockNumber: 21_000_000n,
    tipBlockTimestampMs: 0n,
    peers: 3,
    lastPolledAt: 0,
    startedAt: 0,
    lastError: null,
    ...over,
  };
}

/** A real CCC Transaction so hexFrom(tx.toBytes()) and tx.inputs work. */
export function makeTx(): Transaction {
  return Transaction.from({
    inputs: [{ previousOutput: { txHash: `0x${"ab".repeat(32)}`, index: 0 } }],
    outputs: [],
    outputsData: [],
  });
}

export const PACKET_JSON = '{"version":1,"network":"testnet","label":null}';
export const DIGEST = `0x${"de".repeat(32)}`;
export const TX_HASH = `0x${"f0".repeat(32)}`;

export const TOTALS = {
  totalIn: 30_000_000_000n, // 300 CKB
  totalOut: 10_000_000_000n, // 100 CKB
  fee: 100_000n, // 0.001 CKB
  change: 19_999_900_000n,
} as const;

/** The tx instance the mocked builder hands back for the current test. */
let skeletonTx: Transaction = makeTx();
export const currentSkeletonTx = (): Transaction => skeletonTx;

export function payee(over: Partial<PayeeProfile> = {}): PayeeProfile {
  return {
    id: "p1",
    displayName: "Ada Lovelace",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    // $2.50 at 1 CKB = 0.005 USD → 500 CKB exactly (no thousands separator).
    salaryFiat: { currency: "USD", minor: 250n },
    preferredChain: "ckb:testnet",
    preferredAsset: "CKB",
    walletAddress: RECIPIENT_ADDRESS,
    active: true,
    ...over,
  };
}

export const USD_QUOTE: FxQuote = {
  base: "CKB",
  quote: "USD",
  rate: "0.005",
  source: "coingecko",
  takenAt: 1_760_000_000_000,
};

export function draftBatch(over: Partial<PayrollBatch> = {}): PayrollBatch {
  return {
    id: "batch-1",
    kind: "payroll",
    label: "Resumed batch",
    treasuryId: "ckb-1",
    cycleStart: "2026-08-01",
    cycleEnd: "2026-08-31",
    fxSnapshot: [USD_QUOTE],
    lines: [
      {
        payeeId: "p1",
        fiat: { currency: "USD", minor: 250n },
        crypto: { asset: "CKB", value: 12_300_000_000n, decimals: 8 },
        fxRate: "0.005",
        feeAllocated: { asset: "CKB", value: 0n, decimals: 8 },
      },
    ],
    state: "calculated",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

/** The mocks each suite installs, handed back here so we can prime them. */
export interface PanelSpies {
  listCellsForLock: Mock;
  broadcastTransaction: Mock;
  assertGuard: Mock;
  dumpInputs: Mock;
}

/** Reset every store PayPanel reads to a known single-treasury baseline. */
export function primeStores(): void {
  globalThis.localStorage?.clear();
  useTreasuryStore.setState({ treasuries: [TREASURY_A], activeTreasuryId: TREASURY_A.id });
  useSyncStore.setState({ ckb: syncState() });
  usePayeesStore.setState({ payees: [] });
  usePayrollBatchesStore.setState({ batches: [], selectedDraftId: null });
  useIncomingSigsStore.setState({ bySighash: {} });
  useNetworkConfigStore.setState({ network: "testnet", broadcastRpcUrl: "" });
}

/** Reset every mocked chain/network boundary to its happy-path default. */
export function primeMocks(spies: PanelSpies): void {
  skeletonTx = makeTx();

  spies.listCellsForLock
    .mockReset()
    .mockResolvedValue([{ outPoint: { txHash: `0x${"11".repeat(32)}`, index: 0 } }]);
  spies.broadcastTransaction.mockReset().mockResolvedValue(TX_HASH);
  spies.dumpInputs.mockReset();
  // Default: the pre-broadcast guard passes. The guard tests either assert on
  // this spy's calls or swap in the REAL implementation.
  spies.assertGuard.mockReset().mockImplementation(() => undefined);

  vi.mocked(buildPaymentSkeleton)
    .mockReset()
    .mockImplementation((): PaymentSkeleton => ({ tx: skeletonTx, ...TOTALS }));
  vi.mocked(encodeTransferPacket).mockReset().mockReturnValue(PACKET_JSON);
  vi.mocked(treasurySighashDigest).mockReset().mockReturnValue(DIGEST as `0x${string}`);
  // Real mergeSignatures mutates and returns the same tx; mirror that.
  vi.mocked(mergeSignatures).mockReset().mockImplementation((tx) => tx);
  vi.mocked(fetchCkbPrices).mockReset().mockResolvedValue(new Map());
}

export function renderPanel(
  entries: Parameters<typeof MemoryRouter>[0]["initialEntries"] = ["/pay"],
): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={entries}>
        <PayPanel />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// --- Queries, taken from the current JSX --------------------------------

export const addressInputs = (): HTMLElement[] =>
  screen.getAllByPlaceholderText("ckb1… or ckt1…");
export const amountInputs = (): HTMLElement[] =>
  screen.getAllByPlaceholderText("amount CKB");
export const buildButton = (): HTMLElement =>
  screen.getByRole("button", { name: /Build payment|waiting for sync|fetching cells/ });
export const broadcastButton = (): HTMLElement =>
  screen.getByRole("button", { name: /Merge & broadcast|broadcasting/ });
export const sigBoxes = (): HTMLElement[] =>
  screen.getAllByPlaceholderText("0x… (130 hex chars)");

// --- Flows ---------------------------------------------------------------

export async function buildOnce(
  address = RECIPIENT_ADDRESS,
  amount = "100",
): Promise<void> {
  fireEvent.change(addressInputs()[0]!, { target: { value: address } });
  fireEvent.change(amountInputs()[0]!, { target: { value: amount } });
  fireEvent.click(buildButton());
  await waitFor(() => expect(screen.getByDisplayValue(PACKET_JSON)).toBeInTheDocument());
}

export function fillAllSignatures(): void {
  sigBoxes().forEach((box, i) => {
    fireEvent.change(box, { target: { value: `0x${String(i + 1).repeat(130)}`.slice(0, 132) } });
  });
}

/** Open the payee picker and add the single listed payee to the draft. */
export async function addPayeeFromPicker(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "+ load from payees" }));
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: /to draft/ }));
  await waitFor(() => expect(fetchCkbPrices).toHaveBeenCalled());
}
