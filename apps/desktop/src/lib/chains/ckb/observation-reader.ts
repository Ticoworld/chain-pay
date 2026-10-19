import type { PaymentObservationReader } from "./observe-payment";

export const OBSERVATION_HEADER_LIMIT = 256;
export const OBSERVATION_QUERY_LIMIT = 32;

export function cacheObservationReader(reader: PaymentObservationReader): PaymentObservationReader {
  const headers = new Map<string, Awaited<ReturnType<PaymentObservationReader["getHeader"]>>>();
  const pending = new Map<string, Promise<unknown>>();
  function remember(hash: string, header: Awaited<ReturnType<PaymentObservationReader["getHeader"]>>) {
    if (!header || header.hash.toLowerCase() !== hash || header.number < 0n ||
        !/^0x[\da-f]{64}$/i.test(header.parentHash)) return;
    headers.delete(hash);
    headers.set(hash, header);
    if (headers.size > OBSERVATION_HEADER_LIMIT) headers.delete(headers.keys().next().value!);
  }
  function query<Value>(key: string, read: () => Promise<Value>): Promise<Value> {
    if (!reader.currentNetwork()) return Promise.reject(new Error("Observation session ended"));
    const existing = pending.get(key);
    if (existing) return existing as Promise<Value>;
    if (pending.size >= OBSERVATION_QUERY_LIMIT) return Promise.reject(new Error("Observation busy; retry later"));
    const result = Promise.resolve().then(read).finally(() => pending.delete(key));
    pending.set(key, result);
    return result;
  }
  return {
    currentNetwork: () => reader.currentNetwork(),
    getTipHeader: () => query("tip", () => reader.getTipHeader()),
    getPeers: () => query("peers", () => reader.getPeers()),
    getTransaction: (hash) => query(`transaction:${hash.toLowerCase()}`, () => reader.getTransaction(hash)),
    fetchTransaction: (hash) => query(`fetchTransaction:${hash.toLowerCase()}`, () => reader.fetchTransaction(hash)),
    getHeader: (hash) => query(`header:${hash.toLowerCase()}`, async () => {
      const key = hash.toLowerCase();
      const header = headers.get(key) ?? await reader.getHeader(hash);
      remember(key, header);
      return header;
    }),
    fetchHeader: (hash) => query(`fetchHeader:${hash.toLowerCase()}`, async () => {
      const result = await reader.fetchHeader(hash);
      if (result.status === "fetched") remember(hash.toLowerCase(), result.data);
      return result;
    }),
  };
}
