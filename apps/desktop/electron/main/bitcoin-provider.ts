import { z } from "zod";
import { Address, NETWORK, OutScript, TEST_NETWORK } from "@scure/btc-signer";
import type {
  BitcoinAddressActivity,
  BitcoinChain,
  BitcoinScanResponse,
  BitcoinWatchTransaction,
  BitcoinWatchUtxo,
  BitcoinTransactionStatusResponse,
  BitcoinBroadcastConfirmRequest,
  BitcoinBroadcastConfirmResponse,
  BitcoinBroadcastReview,
  BitcoinBroadcastReviewRequest,
  BitcoinFinalizedEvidenceRequest,
  BitcoinFinalizedEvidenceResponse,
} from "@chain-pay/shared";
import {
  BitcoinBroadcastValidationError,
  buildBitcoinBroadcastReview,
  parseFinalBitcoinTransaction,
  validateBitcoinBroadcastReview,
  validateFinalizedBitcoinTransaction,
  validateFinalizedBitcoinPrevouts,
  toHex,
  validateBitcoinAddresses,
  type ResolvedBitcoinPrevout,
} from "./bitcoin-broadcast";

const HASH = /^[0-9a-f]{64}$/;
const MAX_ADDRESSES_PER_SCAN = 10_000;
const MAX_HISTORY_PAGES = 10_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const rawScriptSchema = z.string().regex(/^(?:[0-9a-f]{2})*$/).max(20_000);

const statusSchema = z.object({
  confirmed: z.boolean(),
  block_height: z.number().int().nonnegative().optional(),
  block_hash: z.string().regex(HASH).optional(),
  block_time: z.number().int().nonnegative().optional(),
});

const prevoutSchema = z.object({
  scriptpubkey_address: z.string().optional(),
  value: z.number().int().nonnegative().safe(),
}).nullable();

const txSchema = z.object({
  txid: z.string().regex(HASH),
  vin: z.array(z.object({ prevout: prevoutSchema })),
  vout: z.array(
    z.object({
      scriptpubkey_address: z.string().optional(),
      value: z.number().int().nonnegative().safe(),
    }),
  ),
  status: statusSchema,
});

const prevoutTxSchema = z.object({
  txid: z.string().regex(HASH),
  vout: z.array(z.object({
    scriptpubkey: rawScriptSchema,
    scriptpubkey_address: z.string().optional(),
    value: z.number().int().nonnegative().safe(),
  })),
  status: statusSchema,
}).passthrough();

const blockSchema = z.object({
  id: z.string().regex(HASH),
  height: z.number().int().nonnegative().safe(),
  mediantime: z.number().int().nonnegative().safe(),
}).passthrough();
const finalizedBlockSchema = blockSchema.extend({ timestamp: z.number().int().nonnegative().safe() });

const utxoSchema = z.object({
  txid: z.string().regex(HASH),
  vout: z.number().int().nonnegative().safe(),
  value: z.number().int().nonnegative().safe(),
  status: statusSchema,
});

const addressStatsSchema = z.object({
  chain_stats: z.object({ tx_count: z.number().int().nonnegative().safe() }).passthrough(),
  mempool_stats: z.object({ tx_count: z.number().int().nonnegative().safe() }).passthrough(),
}).passthrough();

type EsploraTx = z.infer<typeof txSchema>;
type EsploraUtxo = z.infer<typeof utxoSchema>;

export interface BitcoinProviderConfig {
  baseUrl: string;
  bearerToken?: string;
}

export class BitcoinProviderError extends Error {
  constructor(
    readonly code: "not_configured" | "unavailable" | "invalid_response" | "invalid_request" | "rejected" | "txid_mismatch" | "not_finalized" | "evidence_mismatch",
    message: string,
    /**
     * Upstream HTTP status, when the request produced a response at all.
     * A bounded integer is the only upstream detail safe to surface: the URL,
     * the bearer token, and the response body are all withheld deliberately.
     */
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "BitcoinProviderError";
  }
}

export async function reviewBitcoinBroadcast(args: {
  request: BitcoinBroadcastReviewRequest;
  config: BitcoinProviderConfig;
  fetchImpl?: typeof fetch;
}): Promise<BitcoinBroadcastReview> {
  const prepared = await prepareBitcoinBroadcast({ ...args, allowKnown: false });
  return prepared.review;
}

export async function confirmBitcoinBroadcast(args: {
  request: BitcoinBroadcastConfirmRequest;
  config: BitcoinProviderConfig;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): Promise<BitcoinBroadcastConfirmResponse> {
  const prepared = await prepareBitcoinBroadcast({ ...args, allowKnown: true });
  if (prepared.review.digest !== args.request.reviewDigest) {
    return {
      ok: false,
      error: { code: "review_changed", message: "Transaction review changed; inspect and approve the refreshed review" },
      review: prepared.review,
    };
  }
  const submittedAt = (args.now ?? (() => new Date()))().toISOString();
  if (prepared.alreadyKnown) {
    return {
      ok: true,
      receipt: { txid: prepared.review.txid, reviewDigest: prepared.review.digest, state: "already_broadcast", submittedAt },
    };
  }
  try {
    const returnedTxid = await prepared.client.postText("/tx", prepared.parsed.rawHex);
    if (!HASH.test(returnedTxid) || returnedTxid !== prepared.review.txid) {
      throw new BitcoinProviderError("txid_mismatch", "Bitcoin provider returned a mismatched transaction id");
    }
    return {
      ok: true,
      receipt: { txid: returnedTxid, reviewDigest: prepared.review.digest, state: "submitted", submittedAt },
    };
  } catch (error) {
    if (error instanceof BitcoinProviderError && error.code === "txid_mismatch") throw error;
    const knownAfterConflict = await prepared.client.optionalJson(`/tx/${prepared.review.txid}/status`, statusSchema);
    if (knownAfterConflict) {
      return {
        ok: true,
        receipt: { txid: prepared.review.txid, reviewDigest: prepared.review.digest, state: "already_broadcast", submittedAt },
      };
    }
    if (error instanceof BitcoinProviderError && error.code === "rejected") throw error;
    throw unavailable();
  }
}

async function prepareBitcoinBroadcast(args: {
  request: BitcoinBroadcastReviewRequest;
  config: BitcoinProviderConfig;
  fetchImpl?: typeof fetch;
  allowKnown: boolean;
}): Promise<{
  review: BitcoinBroadcastReview;
  alreadyKnown: boolean;
  parsed: ReturnType<typeof parseFinalBitcoinTransaction>;
  client: EsploraClient;
}> {
  const { request } = args;
  validateBitcoinAddresses(request.chain, request.watchedAddresses);
  const parsed = parseFinalBitcoinTransaction(request.rawTxHex);
  const client = new EsploraClient(args.config, args.fetchImpl ?? fetch);
  const [tipHeightText, tipHashText, existing] = await Promise.all([
    client.text("/blocks/tip/height"),
    client.text("/blocks/tip/hash"),
    client.optionalJson(`/tx/${parsed.transaction.id}/status`, statusSchema),
  ]);
  if (existing && !args.allowKnown) {
    throw new BitcoinBroadcastValidationError("already_known", "Transaction is already known to the selected Bitcoin provider");
  }
  const tipHeight = parseHeight(tipHeightText);
  const tipHash = parseHash(tipHashText);
  const block = await client.json(`/block/${tipHash}`, blockSchema);
  if (block.id !== tipHash || block.height !== tipHeight) throw invalidResponse();

  const prevouts = await resolveBitcoinPrevouts(client, parsed, request.chain);
  const review = buildBitcoinBroadcastReview({
    chain: request.chain,
    treasuryId: request.treasuryId,
    watchedAddresses: request.watchedAddresses,
    parsed,
    prevouts,
    tip: { height: tipHeight, hash: tipHash, medianTimePast: block.mediantime },
    ...(request.accounting === undefined ? {} : { accounting: request.accounting }),
  });
  const [finalTipHeight, finalTipHash] = await Promise.all([
    client.text("/blocks/tip/height"),
    client.text("/blocks/tip/hash"),
  ]);
  if (parseHeight(finalTipHeight) !== tipHeight || parseHash(finalTipHash) !== tipHash) {
    throw new BitcoinProviderError("unavailable", "Bitcoin chain tip changed during review; retry");
  }
  return { review, alreadyKnown: existing !== null, parsed, client };
}

async function resolveBitcoinPrevouts(
  client: EsploraClient,
  parsed: ReturnType<typeof parseFinalBitcoinTransaction>,
  chain: BitcoinChain,
): Promise<ResolvedBitcoinPrevout[]> {
  const transactionIds = [...new Set(parsed.raw.inputs.map((input) => toHex(input.txid)))];
  const transactions = new Map<string, z.infer<typeof prevoutTxSchema>>();
  await mapWithConcurrency(transactionIds, 4, async (txid) => {
    const transaction = await client.optionalJson(`/tx/${txid}`, prevoutTxSchema);
    if (!transaction) {
      throw new BitcoinBroadcastValidationError(
        "wrong_network",
        "A transaction prevout is unavailable on the selected Bitcoin network",
      );
    }
    if (transaction.txid !== txid) throw invalidResponse();
    transactions.set(txid, transaction);
  });
  const addressCoder = Address(chain === "btc:mainnet" ? NETWORK : TEST_NETWORK);
  return parsed.raw.inputs.map((input) => {
    const txid = toHex(input.txid);
    const output = transactions.get(txid)?.vout[input.index];
    if (!output) throw invalidResponse();
    const script = Uint8Array.from(Buffer.from(output.scriptpubkey, "hex"));
    let derivedAddress: string | null = null;
    try {
      derivedAddress = addressCoder.encode(
        OutScript.decode(script) as Parameters<typeof addressCoder.encode>[0],
      );
    } catch {
      // The validation layer will return a precise unsupported-script error.
    }
    if (output.scriptpubkey_address && derivedAddress !== output.scriptpubkey_address) throw invalidResponse();
    return {
      txid,
      vout: input.index,
      script,
      address: derivedAddress,
      value: BigInt(output.value),
    };
  });
}

export async function getFinalizedBitcoinPaymentEvidence(args: {
  request: BitcoinFinalizedEvidenceRequest;
  config: BitcoinProviderConfig;
  fetchImpl?: typeof fetch;
}): Promise<BitcoinFinalizedEvidenceResponse> {
  const { request } = args;
  const review = request.review;
  try { validateBitcoinBroadcastReview(review); } catch { throw new BitcoinProviderError("invalid_request", "Bitcoin finalized-evidence review is invalid"); }
  if (review.reviewVersion !== 2) throw new BitcoinProviderError("invalid_request", "Legacy Bitcoin reviews have no committed accounting intent");
  if (request.chain !== review.chain || request.treasuryId !== review.treasuryId || request.receipt.txid !== review.txid || request.receipt.reviewDigest !== review.digest) {
    throw new BitcoinProviderError("invalid_request", "Bitcoin finalized-evidence request does not match the reviewed payment");
  }
  const client = new EsploraClient(args.config, args.fetchImpl ?? fetch);
  const [tipText, status, rawHex] = await Promise.all([
    client.text("/blocks/tip/height"),
    client.optionalJson(`/tx/${review.txid}/status`, statusSchema),
    client.text(`/tx/${review.txid}/hex`),
  ]);
  const tipHeight = parseHeight(tipText);
  if (!status?.confirmed || status.block_height === undefined || status.block_hash === undefined || status.block_time === undefined) {
    throw new BitcoinProviderError("not_finalized", "Bitcoin payment does not yet have finalized transaction evidence");
  }
  const confirmations = tipHeight - status.block_height + 1;
  if (status.block_height > tipHeight || confirmations < 6) throw new BitcoinProviderError("not_finalized", "Bitcoin payment has fewer than six canonical confirmations");
  const canonicalHash = parseHash(await client.text(`/block-height/${status.block_height}`));
  if (canonicalHash !== status.block_hash) throw new BitcoinProviderError("evidence_mismatch", "Bitcoin payment block is no longer canonical");
  const block = await client.json(`/block/${canonicalHash}`, finalizedBlockSchema);
  if (block.id !== canonicalHash || block.height !== status.block_height || block.timestamp !== status.block_time) throw new BitcoinProviderError("evidence_mismatch", "Bitcoin block evidence is inconsistent");
  try {
    const parsed = validateFinalizedBitcoinTransaction(review, rawHex);
    const prevouts = await resolveBitcoinPrevouts(client, parsed, review.chain);
    validateFinalizedBitcoinPrevouts(review, parsed, prevouts);
  }
  catch { throw new BitcoinProviderError("evidence_mismatch", "Finalized Bitcoin transaction bytes do not match the reviewed payment"); }
  const finalCanonicalHash = parseHash(await client.text(`/block-height/${status.block_height}`));
  const finalTip = parseHeight(await client.text("/blocks/tip/height"));
  if (finalCanonicalHash !== canonicalHash || finalTip < tipHeight) throw new BitcoinProviderError("unavailable", "Bitcoin chain context changed during finalized evidence retrieval");
  return { evidence: {
    version: 1,
    chain: review.chain,
    reviewDigest: review.digest,
    txid: review.txid,
    wtxid: review.wtxid,
    rawTransactionHash: review.rawTransactionHash,
    blockHeight: String(status.block_height),
    blockHash: canonicalHash,
    blockTime: new Date(block.timestamp * 1_000).toISOString(),
    confirmations: finalTip - status.block_height + 1,
    transactionVersion: review.version,
    lockTime: review.lockTime,
    inputValueSats: review.inputValueSats,
    outputValueSats: review.outputValueSats,
    feeSats: review.feeSats,
    feeRateSatsPerVbyte: review.feeRateSatsPerVbyte,
    feePayerPolicy: "transaction_inputs",
    outputs: review.outputs,
  } };
}

export function providerConfigFromEnvironment(
  chain: BitcoinChain,
  env: NodeJS.ProcessEnv = process.env,
): BitcoinProviderConfig | null {
  const suffix = chain === "btc:mainnet" ? "MAINNET" : "TESTNET";
  const rawUrl = env[`BITCOIN_${suffix}_ESPLORA_URL`]?.trim();
  if (!rawUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  const local = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1";
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) return null;
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  const baseUrl = parsed.toString().replace(/\/$/, "");
  const bearerToken = env[`BITCOIN_${suffix}_ESPLORA_BEARER_TOKEN`]?.trim();
  return { baseUrl, ...(bearerToken ? { bearerToken } : {}) };
}

export async function scanBitcoinAddresses(args: {
  chain: BitcoinChain;
  addresses: string[];
  config: BitcoinProviderConfig;
  fetchImpl?: typeof fetch;
}): Promise<BitcoinScanResponse> {
  validateAddresses(args.chain, args.addresses);
  const fetchImpl = args.fetchImpl ?? fetch;
  const client = new EsploraClient(args.config, fetchImpl);
  const [tipHeightText, tipHashText] = await Promise.all([
    client.text("/blocks/tip/height"),
    client.text("/blocks/tip/hash"),
  ]);
  const tipHeight = parseHeight(tipHeightText);
  const tipHash = parseHash(tipHashText);
  const watched = new Set(args.addresses);

  const results = await mapWithConcurrency(args.addresses, 4, async (address) => {
    const encoded = encodeURIComponent(address);
    const stats = await client.json(`/address/${encoded}`, addressStatsSchema);
    const used = stats.chain_stats.tx_count > 0 || stats.mempool_stats.tx_count > 0;
    if (!used) return { address, transactions: [], utxos: [], used: false };
    const [transactions, utxos] = await Promise.all([
      fetchAddressTransactions(client, address),
      client.json(`/address/${encoded}/utxo`, z.array(utxoSchema)),
    ]);
    return { address, transactions, utxos, used: true };
  });

  const blockHeights = new Set<number>();
  for (const result of results) {
    for (const tx of result.transactions) if (tx.status.confirmed && tx.status.block_height !== undefined) blockHeights.add(tx.status.block_height);
    for (const utxo of result.utxos) if (utxo.status.confirmed && utxo.status.block_height !== undefined) blockHeights.add(utxo.status.block_height);
  }
  const canonicalHashes = new Map<number, string>();
  await mapWithConcurrency([...blockHeights], 6, async (height) => {
    canonicalHashes.set(height, parseHash(await client.text(`/block-height/${height}`)));
  });

  const transactionsById = new Map<string, EsploraTx>();
  const utxosByOutpoint = new Map<string, { address: string; utxo: EsploraUtxo }>();
  const activity: BitcoinAddressActivity[] = [];
  for (const result of results) {
    activity.push({
      address: result.address,
      used: result.used,
    });
    for (const tx of result.transactions) transactionsById.set(tx.txid, tx);
    for (const utxo of result.utxos) {
      utxosByOutpoint.set(`${utxo.txid}:${utxo.vout}`, { address: result.address, utxo });
    }
  }

  const utxos = [...utxosByOutpoint.values()]
    .map(({ address, utxo }) => ({ normalized: normalizeUtxo(address, utxo, tipHeight, canonicalHashes), source: utxo }))
    // A provider response can straddle a reorg. An output claimed as confirmed
    // in a non-canonical block must not inflate the spendable-looking balance.
    .filter(({ normalized, source }) => !source.status.confirmed || normalized.confirmed)
    .map(({ normalized }) => normalized);
  const transactions = [...transactionsById.values()]
    .map((tx) => normalizeTransaction(tx, watched, tipHeight, canonicalHashes))
    .sort(compareTransactions);
  const balanceSats = utxos.reduce((sum, utxo) => sum + BigInt(utxo.valueSats), 0n).toString();
  const [finalTipHeightText, finalTipHashText] = await Promise.all([
    client.text("/blocks/tip/height"),
    client.text("/blocks/tip/hash"),
  ]);
  if (parseHeight(finalTipHeightText) !== tipHeight || parseHash(finalTipHashText) !== tipHash) {
    throw new BitcoinProviderError("unavailable", "Bitcoin chain tip changed during sync; retry");
  }

  return {
    snapshot: {
      tipHeight,
      tipHash,
      balanceSats,
      addresses: [...args.addresses],
      utxos: utxos.sort((a, b) => `${a.txid}:${a.vout}`.localeCompare(`${b.txid}:${b.vout}`)),
      transactions,
    },
    activity,
  };
}

export async function getBitcoinTransactionStatus(args: {
  txid: string;
  config: BitcoinProviderConfig;
  fetchImpl?: typeof fetch;
}): Promise<BitcoinTransactionStatusResponse> {
  if (!HASH.test(args.txid)) {
    throw new BitcoinProviderError("invalid_request", "Bitcoin transaction id is invalid");
  }
  const client = new EsploraClient(args.config, args.fetchImpl ?? fetch);
  const [tipHeightText, status] = await Promise.all([
    client.text("/blocks/tip/height"),
    client.optionalJson(`/tx/${args.txid}/status`, statusSchema),
  ]);
  const tipHeight = parseHeight(tipHeightText);
  if (!status) return { state: "unknown", confirmations: 0, blockHeight: null, blockHash: null };
  if (!status.confirmed) {
    return { state: "pending", confirmations: 0, blockHeight: null, blockHash: null };
  }
  if (status.block_height === undefined || status.block_hash === undefined) {
    throw invalidResponse();
  }
  const canonicalHash = parseHash(await client.text(`/block-height/${status.block_height}`));
  if (canonicalHash !== status.block_hash || status.block_height > tipHeight) {
    return { state: "pending", confirmations: 0, blockHeight: null, blockHash: null };
  }
  const confirmations = tipHeight - status.block_height + 1;
  return {
    state: confirmations >= 6 ? "confirmed" : "confirming",
    confirmations,
    blockHeight: status.block_height,
    blockHash: status.block_hash,
  };
}

class EsploraClient {
  constructor(
    private readonly config: BitcoinProviderConfig,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async text(path: string): Promise<string> {
    const response = await this.request(path);
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw invalidResponse();
    return text.trim();
  }

  async json<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const response = await this.request(path);
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (contentLength > MAX_RESPONSE_BYTES) throw invalidResponse();
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw invalidResponse();
    try {
      return schema.parse(JSON.parse(text));
    } catch {
      throw invalidResponse();
    }
  }

  async optionalJson<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
    const response = await this.request(path, "GET", undefined, true);
    if (response.status === 404) return null;
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (contentLength > MAX_RESPONSE_BYTES) throw invalidResponse();
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw invalidResponse();
    try {
      return schema.parse(JSON.parse(text));
    } catch {
      throw invalidResponse();
    }
  }

  async postText(path: string, body: string): Promise<string> {
    const response = await this.request(path, "POST", body);
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw invalidResponse();
    return text.trim();
  }

  private async request(path: string, method: "GET" | "POST" = "GET", body?: string, allowNotFound = false): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
        method,
        headers: {
          accept: "application/json, text/plain",
          ...(method === "POST" ? { "content-type": "text/plain" } : {}),
          ...(this.config.bearerToken
            ? { authorization: `Bearer ${this.config.bearerToken}` }
            : {}),
        },
        ...(body === undefined ? {} : { body }),
        signal: controller.signal,
      });
      if (allowNotFound && response.status === 404) return response;
      if (!response.ok) {
        if (method === "POST" && response.status >= 400 && response.status < 500) {
          throw new BitcoinProviderError("rejected", "Bitcoin provider rejected the transaction", response.status);
        }
        throw unavailable(response.status);
      }
      return response;
    } catch (error) {
      if (error instanceof BitcoinProviderError) throw error;
      throw unavailable();
    } finally {
      clearTimeout(timer);
    }
  }
}

async function fetchAddressTransactions(client: EsploraClient, address: string): Promise<EsploraTx[]> {
  const encoded = encodeURIComponent(address);
  const first = await client.json(`/address/${encoded}/txs`, z.array(txSchema));
  const all = [...first];
  // The first endpoint can contain up to 50 mempool entries plus exactly one
  // 25-item confirmed page. Continue from the last confirmed tx, never from a
  // mempool txid.
  let page = first.filter((tx) => tx.status.confirmed);
  let pages = 1;
  while (page.length === 25) {
    if (pages++ >= MAX_HISTORY_PAGES) throw invalidResponse();
    const last = page.at(-1);
    if (!last) break;
    page = await client.json(`/address/${encoded}/txs/chain/${last.txid}`, z.array(txSchema));
    if (page.length === 0) break;
    all.push(...page);
  }
  const unique = new Map(all.map((tx) => [tx.txid, tx]));
  return [...unique.values()];
}

function normalizeUtxo(
  address: string,
  utxo: EsploraUtxo,
  tipHeight: number,
  canonicalHashes: Map<number, string>,
): BitcoinWatchUtxo {
  const canonical = canonicalStatus(utxo.status, tipHeight, canonicalHashes);
  return {
    txid: utxo.txid,
    vout: utxo.vout,
    address,
    valueSats: BigInt(utxo.value).toString(),
    ...canonical,
  };
}

function normalizeTransaction(
  tx: EsploraTx,
  watched: Set<string>,
  tipHeight: number,
  canonicalHashes: Map<number, string>,
): BitcoinWatchTransaction {
  let net = 0n;
  for (const input of tx.vin) {
    if (input.prevout?.scriptpubkey_address && watched.has(input.prevout.scriptpubkey_address)) {
      net -= BigInt(input.prevout.value);
    }
  }
  for (const output of tx.vout) {
    if (output.scriptpubkey_address && watched.has(output.scriptpubkey_address)) {
      net += BigInt(output.value);
    }
  }
  const canonical = canonicalStatus(tx.status, tipHeight, canonicalHashes);
  return {
    txid: tx.txid,
    netValueSats: net.toString(),
    ...canonical,
    blockTime: canonical.confirmed ? (tx.status.block_time ?? null) : null,
  };
}

function canonicalStatus(
  status: z.infer<typeof statusSchema>,
  tipHeight: number,
  canonicalHashes: Map<number, string>,
): Pick<BitcoinWatchUtxo, "confirmed" | "blockHeight" | "blockHash" | "confirmations"> {
  const height = status.block_height;
  const hash = status.block_hash;
  const confirmed =
    status.confirmed &&
    height !== undefined &&
    hash !== undefined &&
    height <= tipHeight &&
    canonicalHashes.get(height) === hash;
  return confirmed
    ? { confirmed: true, blockHeight: height, blockHash: hash, confirmations: tipHeight - height + 1 }
    : { confirmed: false, blockHeight: null, blockHash: null, confirmations: 0 };
}

function compareTransactions(a: BitcoinWatchTransaction, b: BitcoinWatchTransaction): number {
  if (a.confirmed !== b.confirmed) return a.confirmed ? 1 : -1;
  if ((a.blockHeight ?? -1) !== (b.blockHeight ?? -1)) return (b.blockHeight ?? -1) - (a.blockHeight ?? -1);
  return a.txid.localeCompare(b.txid);
}

function validateAddresses(chain: BitcoinChain, addresses: string[]): void {
  if (!Array.isArray(addresses) || addresses.length < 1 || addresses.length > MAX_ADDRESSES_PER_SCAN) {
    throw new BitcoinProviderError("invalid_request", "Bitcoin scan address count is invalid");
  }
  const unique = new Set(addresses);
  if (unique.size !== addresses.length || addresses.some((address) => typeof address !== "string" || address.length < 14 || address.length > 90)) {
    throw new BitcoinProviderError("invalid_request", "Bitcoin scan addresses are invalid");
  }
  const coder = Address(chain === "btc:mainnet" ? NETWORK : TEST_NETWORK);
  try {
    for (const address of addresses) {
      const decoded = coder.decode(address);
      if (!decoded || coder.encode(decoded) !== address) throw new Error("non-canonical address");
    }
  } catch {
    throw new BitcoinProviderError("invalid_request", "Bitcoin scan addresses are invalid");
  }
}

function parseHeight(value: string): number {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) throw invalidResponse();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw invalidResponse();
  return parsed;
}

function parseHash(value: string): string {
  if (!HASH.test(value)) throw invalidResponse();
  return value;
}

function unavailable(httpStatus?: number): BitcoinProviderError {
  const suffix = httpStatus === undefined ? "" : ` (HTTP ${httpStatus})`;
  return new BitcoinProviderError("unavailable", `Bitcoin provider is unavailable${suffix}`, httpStatus);
}

function invalidResponse(): BitcoinProviderError {
  return new BitcoinProviderError("invalid_response", "Bitcoin provider returned an invalid response");
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  task: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (next < values.length) {
        const index = next++;
        const value = values[index];
        if (value !== undefined) results[index] = await task(value);
      }
    }),
  );
  return results;
}
