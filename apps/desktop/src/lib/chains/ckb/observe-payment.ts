type Network = "mainnet" | "testnet";
type FetchResult<Value> = { status: "added" | "fetching" | "not_found" } |
  { status: "fetched"; data: Value };

interface Header {
  hash: string;
  parentHash: string;
  number: bigint;
  timestamp: bigint;
}

interface TransactionEvidence {
  status: string;
  blockHash?: string | undefined;
  transaction: { hash(): string };
}

export interface PaymentObservationReader {
  currentNetwork(): Network | null;
  getTipHeader(): Promise<Header>;
  getPeers(): Promise<readonly unknown[]>;
  getTransaction(hash: `0x${string}`): Promise<TransactionEvidence | undefined>;
  fetchTransaction(hash: `0x${string}`): Promise<FetchResult<TransactionEvidence | undefined>>;
  getHeader(hash: `0x${string}`): Promise<Header | undefined>;
  fetchHeader(hash: `0x${string}`): Promise<FetchResult<Header>>;
}

export type PaymentObservation = {
  state: "included";
  blockHash: string;
  blockNumber: bigint;
  tipHash: string;
  tipNumber: bigint;
  localDepth: bigint;
  checkedAt: number;
} | {
  state: "pending" | "uncertain";
  reason: string;
  checkedAt: number;
};

export const MAX_ANCESTRY_LINKS = 64n;
const MAX_TIP_AGE_MS = 300_000n;
const MAX_FUTURE_MS = 60_000n;
const isHash = (value: string): value is `0x${string}` => /^0x[\da-f]{64}$/i.test(value);
const sameHash = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
const validHeader = (header: Header) =>
  isHash(header.hash) && isHash(header.parentHash) && header.number >= 0n;
const validatedAncestry = new WeakMap<PaymentObservationReader, Set<string>>();

export async function observePayment(
  reader: PaymentObservationReader,
  chain: `ckb:${Network}`,
  txHash: string,
  now = Date.now,
): Promise<PaymentObservation> {
  const uncertain = (reason: string): PaymentObservation =>
    ({ state: "uncertain", reason, checkedAt: now() });
  if (!isHash(txHash)) return uncertain("Invalid saved transaction hash.");
  if (`ckb:${reader.currentNetwork()}` !== chain) {
    return uncertain("The running light-client session does not match this payment's network.");
  }
  try {
    const tip = await reader.getTipHeader();
    const tipAge = BigInt(now()) - tip.timestamp;
    if (!validHeader(tip) || tipAge > MAX_TIP_AGE_MS || tipAge < -MAX_FUTURE_MS) {
      return uncertain("The local tip is stale or unavailable; current ancestry cannot be checked.");
    }
    let transaction = await reader.getTransaction(txHash);
    if (!transaction) {
      const fetched = await reader.fetchTransaction(txHash);
      if (fetched.status !== "fetched") {
        return uncertain(fetched.status === "not_found"
          ? "Not observed by the light client; this does not prove failure."
          : "A transaction proof has been requested from light-client peers.");
      }
      transaction = fetched.data;
    }
    if (!transaction || !sameHash(transaction.transaction.hash(), txHash)) {
      return uncertain("Transaction evidence is unavailable or does not match the saved hash.");
    }
    if (transaction.status !== "committed") {
      if (`ckb:${reader.currentNetwork()}` !== chain) return uncertain("The light-client session changed.");
      return transaction.status === "pending"
        ? { state: "pending", reason: "Known to the local relay; inclusion has not been observed.", checkedAt: now() }
        : uncertain("No usable inclusion evidence was returned by the light client.");
    }
    if (!transaction.blockHash || !isHash(transaction.blockHash)) {
      return uncertain("The light client reported inclusion without a usable block hash.");
    }
    return await checkInclusion(reader, chain, txHash, transaction.blockHash, tip, now);
  } catch {
    return uncertain("Light-client evidence is unavailable. Retry after the client has synchronized.");
  }
}

async function checkInclusion(
  reader: PaymentObservationReader, chain: `ckb:${Network}`, txHash: `0x${string}`,
  blockHash: `0x${string}`, tip: Header, now: () => number,
): Promise<PaymentObservation> {
  const uncertain = (reason: string): PaymentObservation => ({ state: "uncertain", reason, checkedAt: now() });
  const block = await readHeader(reader, blockHash);
  if (!block) return uncertain("The inclusion header is not available yet.");
  if (!validHeader(block) || !sameHash(block.hash, blockHash)) {
    return uncertain("The inclusion header does not match the reported block.");
  }
  const distance = tip.number - block.number;
  if (distance < 0n) return uncertain("The reported inclusion is ahead of the sampled local tip.");
  if (distance > MAX_ANCESTRY_LINKS) {
    return uncertain("Inclusion was reported, but checking current ancestry exceeds the 64-block limit.");
  }
  const ancestryKey = `${tip.hash.toLowerCase()}:${block.hash.toLowerCase()}`;
  const validated = validatedAncestry.get(reader) ?? new Set<string>();
  validatedAncestry.set(reader, validated);
  const ancestryError = validated.has(ancestryKey) ? null : await ancestryProblem(reader, tip, block);
  if (ancestryError) return uncertain(ancestryError);
  validated.add(ancestryKey);
  if (validated.size > 64) validated.delete(validated.values().next().value!);
  const tipAfter = await reader.getTipHeader();
  const transactionAfter = await reader.getTransaction(txHash);
  if (`ckb:${reader.currentNetwork()}` !== chain || !sameHash(tip.hash, tipAfter.hash) ||
      !transactionAfter || transactionAfter.status !== "committed" ||
      !sameHash(transactionAfter.transaction.hash(), txHash) ||
      !transactionAfter.blockHash || !sameHash(transactionAfter.blockHash, block.hash)) {
    return uncertain("The light-client session, tip or transaction changed during the check.");
  }
  const tipAge = BigInt(now()) - tip.timestamp;
  if (tipAge > MAX_TIP_AGE_MS || tipAge < -MAX_FUTURE_MS) {
    return uncertain("The local tip became stale or the clock changed during the check.");
  }
  return {
    state: "included", blockHash: block.hash, blockNumber: block.number,
    tipHash: tip.hash, tipNumber: tip.number, localDepth: distance + 1n, checkedAt: now(),
  };
}

async function ancestryProblem(reader: PaymentObservationReader, tip: Header, block: Header) {
  let ancestor = tip;
  while (ancestor.number > block.number) {
    if (!isHash(ancestor.parentHash)) return "A parent header hash is invalid.";
    const parent = await readHeader(reader, ancestor.parentHash);
    if (!parent) return "Current ancestry is incomplete; a header proof may still be fetching.";
    if (!validHeader(parent) || !sameHash(parent.hash, ancestor.parentHash) || parent.number !== ancestor.number - 1n) {
      return "The returned headers do not form a continuous parent chain.";
    }
    ancestor = parent;
  }
  return sameHash(ancestor.hash, block.hash) ? null
    : "The reported inclusion block is outside the sampled tip's ancestry. Recheck after sync.";
}

async function readHeader(reader: PaymentObservationReader, hash: `0x${string}`) {
  const cached = await reader.getHeader(hash);
  if (cached) return cached;
  const response = await reader.fetchHeader(hash);
  return response.status === "fetched" ? response.data : undefined;
}
