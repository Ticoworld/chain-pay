import { describe, expect, it, vi } from "vitest";
import { observePayment, type PaymentObservationReader } from "./observe-payment";

const NOW = Date.parse("2026-10-19T12:00:00Z");
const hash = (number: number) => `0x${number.toString(16).padStart(64, "0")}` as const;
const TX = hash(999);
const header = (number: number, branch = 0) => ({
  hash: hash(number + branch), parentHash: hash(number - 1 + branch),
  number: BigInt(number), timestamp: BigInt(NOW),
});
const included = (block = 100) => ({
  status: "committed", transaction: { hash: () => TX }, blockHash: hash(block),
});

function fixture() {
  const headers = new Map(Array.from({ length: 66 }, (_, index) => {
    const value = header(100 + index);
    return [value.hash, value] as const;
  }));
  const reader = {
    currentNetwork: vi.fn<PaymentObservationReader["currentNetwork"]>(() => "testnet"),
    getTipHeader: vi.fn(async () => header(102)),
    getPeers: vi.fn(async (): Promise<unknown[]> => [{}]),
    getTransaction: vi.fn<PaymentObservationReader["getTransaction"]>(async () => included()),
    fetchTransaction: vi.fn<PaymentObservationReader["fetchTransaction"]>(async () => ({ status: "added" })),
    getHeader: vi.fn<PaymentObservationReader["getHeader"]>(async (value) => headers.get(value)),
    fetchHeader: vi.fn<PaymentObservationReader["fetchHeader"]>(async () => ({ status: "added" })),
  };
  return { reader, headers, observe: () => observePayment(reader, "ckb:testnet", TX, () => NOW) };
}

describe("read-only local CKB payment observation", () => {
  it("moves from proof requested to inclusion, growing depth, uncertainty and re-inclusion", async () => {
    const { reader, observe } = fixture();
    reader.getTransaction.mockResolvedValue(undefined);
    expect(await observe()).toMatchObject({ state: "uncertain", reason: expect.stringMatching(/requested/) });
    reader.getTransaction.mockResolvedValue(included());
    expect(await observe()).toMatchObject({ state: "included", blockNumber: 100n, localDepth: 3n });
    reader.getTipHeader.mockResolvedValue(header(104));
    expect(await observe()).toMatchObject({ state: "included", localDepth: 5n });
    reader.getTransaction.mockResolvedValue(undefined);
    reader.fetchTransaction.mockResolvedValue({ status: "not_found" });
    const missing = await observe();
    expect(missing).toMatchObject({ state: "uncertain", reason: expect.stringMatching(/does not prove failure/) });
    expect(missing).not.toHaveProperty("localDepth");
    reader.getTransaction.mockResolvedValue(included(103));
    expect(await observe()).toMatchObject({ state: "included", blockNumber: 103n, localDepth: 2n });
  });

  it("recognizes only locally pending evidence without claiming network mempool acceptance", async () => {
    const { reader, observe } = fixture();
    reader.getTransaction.mockResolvedValue({ status: "pending", transaction: { hash: () => TX } });
    expect(await observe()).toMatchObject({ state: "pending", reason: expect.stringMatching(/local relay/) });
    expect(reader.fetchTransaction).not.toHaveBeenCalled();
  });

  it("counts the inclusion block once", async () => {
    const { reader, observe } = fixture();
    reader.getTipHeader.mockResolvedValue(header(100));
    expect(await observe()).toMatchObject({ state: "included", localDepth: 1n });
  });

  it.each(["added", "fetching", "not_found"] as const)("does not equate %s with transaction failure", async (status) => {
    const { reader, observe } = fixture();
    reader.getTransaction.mockResolvedValue(undefined);
    reader.fetchTransaction.mockResolvedValue({ status });
    expect(await observe()).toMatchObject({ state: "uncertain" });
    expect(reader.fetchTransaction).toHaveBeenCalledWith(TX);
  });

  it("uses the dependency's fetched-data shape", async () => {
    const { reader, observe } = fixture();
    reader.getTransaction.mockResolvedValueOnce(undefined);
    reader.fetchTransaction.mockResolvedValue({ status: "fetched", data: included() });
    expect(await observe()).toMatchObject({ state: "included" });
  });

  it.each([null, "mainnet"] as const)("does not query the wrong or stopped session (%s)", async (network) => {
    const { reader, observe } = fixture();
    reader.currentNetwork.mockReturnValue(network);
    expect(await observe()).toMatchObject({ state: "uncertain", reason: expect.stringMatching(/network/) });
    expect(reader.getTransaction).not.toHaveBeenCalled();
    expect(reader.getTipHeader).not.toHaveBeenCalled();
  });

  it.each([-300_001, 60_001])("withholds evidence for a stale or future local tip (%s ms)", async (offset) => {
    const { reader, observe } = fixture();
    reader.getTipHeader.mockResolvedValue({ ...header(102), timestamp: BigInt(NOW + offset) });
    expect(await observe()).toMatchObject({ state: "uncertain" });
    expect(reader.getTransaction).not.toHaveBeenCalled();
  });

  it("does not infer connectivity from either cached peers or an empty peer list", async () => {
    const { reader, observe } = fixture();
    reader.getPeers.mockResolvedValue([]);
    expect(await observe()).toMatchObject({ state: "included" });
    reader.getPeers.mockResolvedValue([{}]);
    expect(await observe()).toMatchObject({ state: "included" });
    expect(reader.getPeers).not.toHaveBeenCalled();
  });

  it("queues a missing parent header without inventing its ancestry", async () => {
    const { reader, headers, observe } = fixture();
    headers.delete(hash(101));
    expect(await observe()).toMatchObject({ state: "uncertain", reason: expect.stringMatching(/ancestry is incomplete/) });
    expect(reader.fetchHeader).toHaveBeenCalledExactlyOnceWith(hash(101));
    reader.fetchHeader.mockResolvedValue({ status: "fetched", data: header(101) });
    expect(await observe()).toMatchObject({ state: "included", localDepth: 3n });
  });

  it("rejects an orphan inclusion even when block heights suggest confirmations", async () => {
    const { reader, headers, observe } = fixture();
    const orphan = header(100, 1000);
    headers.set(orphan.hash, orphan);
    reader.getTransaction.mockResolvedValue({ ...included(), blockHash: orphan.hash });
    expect(await observe()).toMatchObject({ state: "uncertain", reason: expect.stringMatching(/outside/) });
  });

  it("invalidates a sample if the tip, session or inclusion changes while reading", async () => {
    for (const change of ["tip", "session", "transaction"]) {
      const { reader, observe } = fixture();
      if (change === "tip") reader.getTipHeader.mockResolvedValueOnce(header(102)).mockResolvedValue(header(103));
      if (change === "session") reader.currentNetwork.mockReturnValueOnce("testnet").mockReturnValue(null);
      if (change === "transaction") reader.getTransaction.mockResolvedValueOnce(included()).mockResolvedValue(undefined);
      expect(await observe()).toMatchObject({ state: "uncertain", reason: expect.stringMatching(/changed/) });
    }
  });

  it("bounds ancestry reads, allowing exactly 64 links", async () => {
    const { reader, observe } = fixture();
    reader.getTipHeader.mockResolvedValue(header(164));
    expect(await observe()).toMatchObject({ state: "included", localDepth: 65n });
    reader.getHeader.mockClear();
    reader.getTipHeader.mockResolvedValue(header(165));
    expect(await observe()).toMatchObject({ state: "uncertain", reason: expect.stringMatching(/limit/) });
    expect(reader.getHeader).toHaveBeenCalledTimes(1);
  });

  it("rejects mismatched transaction evidence, broken links and unavailable reads", async () => {
    const { reader, headers, observe } = fixture();
    reader.getTransaction.mockResolvedValueOnce({ ...included(), transaction: { hash: () => hash(998) } });
    expect(await observe()).toMatchObject({ state: "uncertain" });
    headers.set(hash(101), { ...header(101), number: 99n });
    expect(await observe()).toMatchObject({ state: "uncertain", reason: expect.stringMatching(/continuous/) });
    reader.getTransaction.mockRejectedValue(new Error("worker stopped"));
    expect(await observe()).toMatchObject({ state: "uncertain", reason: expect.stringMatching(/unavailable/) });
  });

  it("requires an inclusion header and never counts a future block", async () => {
    const { reader, headers, observe } = fixture();
    headers.delete(hash(100));
    expect(await observe()).toMatchObject({ state: "uncertain", reason: expect.stringMatching(/header/) });
    reader.getTransaction.mockResolvedValue(included(103));
    expect(await observe()).toMatchObject({ state: "uncertain", reason: expect.stringMatching(/ahead/) });
  });

  it("discards an otherwise good sample that became stale during lookup", async () => {
    const { reader } = fixture();
    let clock = NOW;
    reader.getTransaction.mockImplementationOnce(async () => included()).mockImplementation(async () => {
      clock += 300_001;
      return included();
    });
    expect(await observePayment(reader, "ckb:testnet", TX, () => clock))
      .toMatchObject({ state: "uncertain", reason: expect.stringMatching(/stale/) });
  });

  it("does not dispatch malformed hashes to the WASM client", async () => {
    const { reader } = fixture();
    expect(await observePayment(reader, "ckb:testnet", "0x1234", () => NOW)).toMatchObject({ state: "uncertain" });
    expect(reader.getTipHeader).not.toHaveBeenCalled();
  });

  it("reuses only a validated tip/block pair and still checks mutable transaction evidence", async () => {
    const { reader, observe } = fixture();
    expect(await observe()).toMatchObject({ state: "included" });
    reader.getHeader.mockClear();
    expect(await observe()).toMatchObject({ state: "included" });
    expect(reader.getHeader).toHaveBeenCalledTimes(1);
    reader.getTransaction.mockResolvedValue(undefined);
    expect(await observe()).toMatchObject({ state: "uncertain" });
    reader.getTransaction.mockResolvedValue(included());
    reader.getTipHeader.mockResolvedValue(header(102, 1000));
    expect(await observe()).toMatchObject({ state: "uncertain" });
  });
});
