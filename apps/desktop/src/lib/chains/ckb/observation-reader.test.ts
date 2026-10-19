import { describe, expect, it, vi } from "vitest";
import { cacheObservationReader, OBSERVATION_HEADER_LIMIT, OBSERVATION_QUERY_LIMIT } from "./observation-reader";
import type { PaymentObservationReader } from "./observe-payment";
import { observePayment } from "./observe-payment";

const hash = (number: number) => `0x${number.toString(16).padStart(64, "0")}` as const;
function fixture() {
  const native = {
    currentNetwork: vi.fn((): "testnet" | null => "testnet"),
    getTipHeader: vi.fn(), getPeers: vi.fn(), getTransaction: vi.fn(), fetchTransaction: vi.fn(),
    getHeader: vi.fn<PaymentObservationReader["getHeader"]>(async (value) => ({ hash: value, parentHash: hash(0), number: 1n, timestamp: 1n })),
    fetchHeader: vi.fn(),
  } satisfies PaymentObservationReader;
  return { native, reader: cacheObservationReader(native) };
}

describe("bounded session observation reads", () => {
  it("shares ancestry and duplicate transaction reads across concurrent payment observations", async () => {
    const { native, reader } = fixture();
    const timestamp = BigInt(Date.now());
    native.getTipHeader.mockResolvedValue({ hash: hash(3), parentHash: hash(2), number: 3n, timestamp });
    native.getHeader.mockImplementation(async (value) => ({
      hash: value, parentHash: hash(Number(BigInt(value)) - 1), number: BigInt(value), timestamp,
    }));
    native.getTransaction.mockImplementation(async (value: string) => ({
      status: "committed", blockHash: hash(1), transaction: { hash: () => value },
    }));
    const results = await Promise.all([100, 101, 100].map((number) => observePayment(reader, "ckb:testnet", hash(number))));
    expect(results).toEqual(Array.from({ length: 3 }, () => expect.objectContaining({ state: "included", localDepth: 3n })));
    expect(native.getHeader).toHaveBeenCalledTimes(2);
    expect(native.getTipHeader).toHaveBeenCalledTimes(2);
    expect(native.getTransaction).toHaveBeenCalledTimes(4);
  });

  it("shares overlapping queries and immutable headers while rereading mutable data", async () => {
    const { native, reader } = fixture();
    await Promise.all([reader.getHeader(hash(1)), reader.getHeader(hash(1))]);
    await reader.getHeader(hash(1));
    expect(native.getHeader).toHaveBeenCalledTimes(1);
    await Promise.all([reader.getTransaction(hash(1)), reader.getTransaction(hash(1))]);
    expect(native.getTransaction).toHaveBeenCalledTimes(1);
    await reader.getTransaction(hash(1));
    expect(native.getTransaction).toHaveBeenCalledTimes(2);
  });

  it("bounds header memory and never caches missing or mismatched responses", async () => {
    const { native, reader } = fixture();
    for (let index = 0; index <= OBSERVATION_HEADER_LIMIT; index++) await reader.getHeader(hash(index));
    native.getHeader.mockClear();
    await reader.getHeader(hash(0));
    expect(native.getHeader).toHaveBeenCalledTimes(1);
    native.getHeader.mockResolvedValueOnce(undefined);
    await reader.getHeader(hash(500));
    await reader.getHeader(hash(500));
    expect(native.getHeader).toHaveBeenCalledTimes(3);
    native.getHeader.mockResolvedValueOnce({ hash: hash(999), parentHash: hash(0), number: 1n, timestamp: 1n });
    await reader.getHeader(hash(501));
    await reader.getHeader(hash(501));
    expect(native.getHeader).toHaveBeenCalledTimes(5);
  });

  it("bounds hanging requests and refuses even cached headers after session retirement", async () => {
    const { native, reader } = fixture();
    await reader.getHeader(hash(1));
    native.getTransaction.mockImplementation(() => new Promise(() => {}));
    for (let index = 0; index < OBSERVATION_QUERY_LIMIT; index++) void reader.getTransaction(hash(index));
    await expect(reader.getTransaction(hash(100))).rejects.toThrow(/busy/);
    native.currentNetwork.mockReturnValue(null);
    await expect(reader.getHeader(hash(1))).rejects.toThrow(/ended/);
    const replacement = cacheObservationReader({ ...native, currentNetwork: () => "testnet" });
    await replacement.getHeader(hash(1));
    expect(native.getHeader).toHaveBeenCalledTimes(2);
  });
});
