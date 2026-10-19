import { contextBridge, ipcRenderer } from "electron";
import type { PairedDevice } from "../main/pair-store";
import {
  KEYVAULT_CHANNELS,
  type SignTxRequest,
} from "../../../../packages/shared/src/keyvault-ipc";
import {
  BITCOIN_CHANNELS,
  type BitcoinChain,
  type BitcoinProviderStatus,
  type BitcoinScanRequest,
  type BitcoinScanResponse,
  type BitcoinTransactionStatusRequest,
  type BitcoinTransactionStatusResponse,
  type BitcoinBroadcastConfirmRequest,
  type BitcoinBroadcastConfirmResponse,
  type BitcoinBroadcastReviewRequest,
  type BitcoinBroadcastReviewResponse,
  type BitcoinFinalizedEvidenceRequest,
  type BitcoinFinalizedEvidenceResponse,
  SOLANA_CHANNELS,
  type SolanaChain,
  type SolanaProviderStatus,
  type SolanaScanRequest,
  type SolanaScanResponse,
  type SolanaTransactionStatusRequest,
  type SolanaTransactionStatusResponse,
  type SolanaPaymentInspectRequest,
  type SolanaPaymentInspectResponse,
  type SolanaPaymentPrepareRequest,
  type SolanaPaymentPrepareResponse,
  type SolanaPaymentValidateProposalRequest,
  type SolanaPaymentValidateProposalResponse,
  type SolanaPaymentFinalizedEvidenceRequest,
  type SolanaPaymentFinalizedEvidenceResponse,
  type SolanaPaymentSubmitRequest,
  type SolanaPaymentSubmitResponse,
  type SolanaPaymentVerifySignatureRequest,
  type SolanaPaymentVerifySignatureResponse,
} from "../../../../packages/shared/src";

const platformApi = {
  platform: process.platform,
  versions: process.versions,
};

contextBridge.exposeInMainWorld("platform", platformApi);

export type PlatformApi = typeof platformApi;

const chainpayApi = {
  commIdentity: {
    exists: (): Promise<boolean> => ipcRenderer.invoke("commIdentity:exists"),
    publicInfo: (): Promise<{
      mlDsaPub: string;
      mlKemPub: string;
      address: string;
      addresses: { testnet: string; mainnet: string | null };
      publishedOn: ("testnet" | "mainnet")[];
      addrHash: string;
      createdAt: number;
    } | null> => ipcRenderer.invoke("commIdentity:publicInfo"),
    generate: (): Promise<{
      mlDsaPub: string;
      mlKemPub: string;
      address: string;
      addrHash: string;
      createdAt: number;
    }> => ipcRenderer.invoke("commIdentity:generate"),
    delete: (): Promise<void> => ipcRenderer.invoke("commIdentity:delete"),
  },
  commTransport: {
    publishProfile: (
      metadata: { displayName?: string } | undefined,
    ): Promise<{ txHash: string; txBytes: string }> =>
      ipcRenderer.invoke("commTransport:publishProfile", metadata ?? {}),
    sendMessage: (
      recipientAddress: string,
      envelopeBytesHex: string,
    ): Promise<{ txHash: string; txBytes: string }> =>
      ipcRenderer.invoke(
        "commTransport:sendMessage",
        recipientAddress,
        envelopeBytesHex,
      ),
    decryptIncoming: (messageOutPoint: {
      txHash: string;
      index: number;
    }): Promise<string> =>
      ipcRenderer.invoke("commTransport:decryptIncoming", messageOutPoint),
    resolveProfile: (address: string): Promise<{
      address: string;
      mlDsaPubKey: string;
      mlKemPubKey: string;
      metadata: string;
    }> => ipcRenderer.invoke("commTransport:resolveProfile", address),
  },
  network: {
    get: (): Promise<"testnet" | "mainnet"> =>
      ipcRenderer.invoke("network:get"),
    set: (network: "testnet" | "mainnet"): Promise<void> =>
      ipcRenderer.invoke("network:set", network),
  },
  lcStorage: {
    clear: (): Promise<void> => ipcRenderer.invoke("lcStorage:clear"),
  },
  app: {
    quit: (): Promise<void> => ipcRenderer.invoke("app:quit"),
  },
  invoiceFiles: {
    store: (bytes: Uint8Array, sha256: string): Promise<string> =>
      ipcRenderer.invoke("invoice-files:store", bytes, sha256),
    read: (uri: string): Promise<Uint8Array> =>
      ipcRenderer.invoke("invoice-files:read", uri),
    delete: (uri: string): Promise<void> =>
      ipcRenderer.invoke("invoice-files:delete", uri),
  },
  pair: {
    list: (): Promise<PairedDevice[]> => ipcRenderer.invoke("pair:list"),
    revoke: (tokenId: string): Promise<void> =>
      ipcRenderer.invoke("pair:revoke", tokenId),
    issue: (deviceLabel: string): Promise<{ token: string; tokenId: string }> =>
      ipcRenderer.invoke("pair:issue", deviceLabel),
    setCommPubkey: (tokenId: string, commPubkey: string): Promise<void> =>
      ipcRenderer.invoke("pair:setCommPubkey", tokenId, commPubkey),
    info: (): Promise<{ certFingerprint: string; port: number } | null> =>
      ipcRenderer.invoke("pair:info"),
    rotateCert: (): Promise<
      | { ok: true; fingerprint: string; port: number }
      | { ok: false; reason: string }
    > => ipcRenderer.invoke("pair:rotateCert"),
    onInvoiceReceived: (cb: (payload: unknown) => void): (() => void) => {
      const listener = (_e: unknown, p: unknown): void => cb(p);
      ipcRenderer.on("mobile-invoice:received", listener);
      return () => {
        ipcRenderer.removeListener("mobile-invoice:received", listener);
      };
    },
  },
  accounting: {
    postJournal: (
      record: unknown,
    ): Promise<{
      jeName: string;
      idempotent: boolean;
      recordName: string;
      recordIdempotent: boolean;
    }> => ipcRenderer.invoke("accounting:postJournal", record),
    exportCompliance: (
      filters: {
        fromDate?: string;
        toDate?: string;
        chain?: "ckb:mainnet" | "ckb:testnet" | "evm:11155111" | "sol:devnet" | "sol:mainnet" | "btc:testnet" | "btc:mainnet";
      },
      format: "csv" | "pdf",
    ): Promise<{
      canceled: boolean;
      filePath?: string;
      rowCount?: number;
      sha256?: string;
    }> => ipcRenderer.invoke("accounting:exportCompliance", filters, format),
  },
  bitcoin: {
    status: (chain: BitcoinChain): Promise<BitcoinProviderStatus> =>
      ipcRenderer.invoke(BITCOIN_CHANNELS.status, chain),
    scan: (request: BitcoinScanRequest): Promise<BitcoinScanResponse> =>
      ipcRenderer.invoke(BITCOIN_CHANNELS.scan, request),
    transactionStatus: (
      request: BitcoinTransactionStatusRequest,
    ): Promise<BitcoinTransactionStatusResponse> =>
      ipcRenderer.invoke(BITCOIN_CHANNELS.transactionStatus, request),
    reviewBroadcast: (request: BitcoinBroadcastReviewRequest): Promise<BitcoinBroadcastReviewResponse> =>
      ipcRenderer.invoke(BITCOIN_CHANNELS.reviewBroadcast, request),
    confirmBroadcast: (request: BitcoinBroadcastConfirmRequest): Promise<BitcoinBroadcastConfirmResponse> =>
      ipcRenderer.invoke(BITCOIN_CHANNELS.confirmBroadcast, request),
    finalizedEvidence: (request: BitcoinFinalizedEvidenceRequest): Promise<BitcoinFinalizedEvidenceResponse> =>
      ipcRenderer.invoke(BITCOIN_CHANNELS.finalizedEvidence, request),
  },
  solana: {
    status: (chain: SolanaChain): Promise<SolanaProviderStatus> =>
      ipcRenderer.invoke(SOLANA_CHANNELS.status, chain),
    scan: (request: SolanaScanRequest): Promise<SolanaScanResponse> =>
      ipcRenderer.invoke(SOLANA_CHANNELS.scan, request),
    transactionStatus: (
      request: SolanaTransactionStatusRequest,
    ): Promise<SolanaTransactionStatusResponse> =>
      ipcRenderer.invoke(SOLANA_CHANNELS.transactionStatus, request),
    paymentInspect: (request: SolanaPaymentInspectRequest): Promise<SolanaPaymentInspectResponse> =>
      ipcRenderer.invoke(SOLANA_CHANNELS.paymentInspect, request),
    paymentPrepare: (request: SolanaPaymentPrepareRequest): Promise<SolanaPaymentPrepareResponse> =>
      ipcRenderer.invoke(SOLANA_CHANNELS.paymentPrepare, request),
    paymentValidateProposal: (request: SolanaPaymentValidateProposalRequest): Promise<SolanaPaymentValidateProposalResponse> =>
      ipcRenderer.invoke(SOLANA_CHANNELS.paymentValidateProposal, request),
    paymentFinalizedEvidence: (request: SolanaPaymentFinalizedEvidenceRequest): Promise<SolanaPaymentFinalizedEvidenceResponse> =>
      ipcRenderer.invoke(SOLANA_CHANNELS.paymentFinalizedEvidence, request),
    paymentSubmit: (request: SolanaPaymentSubmitRequest): Promise<SolanaPaymentSubmitResponse> =>
      ipcRenderer.invoke(SOLANA_CHANNELS.paymentSubmit, request),
    paymentVerifySignature: (request: SolanaPaymentVerifySignatureRequest): Promise<SolanaPaymentVerifySignatureResponse> =>
      ipcRenderer.invoke(SOLANA_CHANNELS.paymentVerifySignature, request),
  },
  keyvault: {
    /** Check whether a keyvault blob exists on disk. */
    status: (): Promise<{ exists: boolean }> =>
      ipcRenderer.invoke(KEYVAULT_CHANNELS.status),
    /** Generate and display recovery words in a native main-process dialog. */
    create: (
      password: string,
    ): Promise<{ id: string; lockArgs: string }> =>
      ipcRenderer.invoke(KEYVAULT_CHANNELS.create, { password }),
    /** Import recovery words from the system clipboard in Electron main. */
    import: (
      password: string,
    ): Promise<{ id: string; lockArgs: string }> =>
      ipcRenderer.invoke(KEYVAULT_CHANNELS.import, { password }),
    /** Decrypt the keyvault and return derived lock-args without signing. */
    unlockDerive: (
      keyvaultId: string,
      password: string,
      derivationIndex: number,
    ): Promise<{ lockArgs: string }> =>
      ipcRenderer.invoke(KEYVAULT_CHANNELS.unlockDerive, {
        keyvaultId,
        password,
        derivationIndex,
      }),
    /** Sign a CKB tx inside main (anti-blind-sign enforced; digest recomputed in main). */
    signTx: (req: SignTxRequest): Promise<{ signedTx: string }> =>
      ipcRenderer.invoke(KEYVAULT_CHANNELS.signTx, req),
    /** Show recovery words in a native main-process dialog. */
    export: (
      keyvaultId: string,
      password: string,
    ): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(KEYVAULT_CHANNELS.export, { keyvaultId, password }),
    /** Re-encrypt the keyvault blob under a new password. */
    changePassword: (
      keyvaultId: string,
      oldPassword: string,
      newPassword: string,
    ): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(KEYVAULT_CHANNELS.changePassword, {
        keyvaultId,
        oldPassword,
        newPassword,
      }),
    /** Permanently delete the keyvault blob after main verifies its password. */
    delete: (keyvaultId: string, password: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(KEYVAULT_CHANNELS.delete, { keyvaultId, password }),
  },
};

contextBridge.exposeInMainWorld("chainpay", chainpayApi);

export type ChainpayApi = typeof chainpayApi;
