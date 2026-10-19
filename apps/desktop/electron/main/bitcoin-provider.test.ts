import { describe, expect, it, vi } from "vitest";
import {
  BitcoinProviderError,
  getBitcoinTransactionStatus,
  providerConfigFromEnvironment,
  scanBitcoinAddresses,
  reviewBitcoinBroadcast,
  confirmBitcoinBroadcast,
  getFinalizedBitcoinPaymentEvidence,
} from "./bitcoin-provider";

const ADDRESS_A = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const ADDRESS_B = "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g";
const TIP_HASH = "a".repeat(64);
const BLOCK_HASH = "b".repeat(64);
const ORPHAN_HASH = "c".repeat(64);
const BIP143_SIGNED = "01000000000101db6b1b20aa0fd7b23880be2ecbd4a98130974cf4748fb66092ac4d3ceb1a5477010000001716001479091972186c449eb1ded22b78e40d009bdf0089feffffff02b8b4eb0b000000001976a914a457b684d7f0d539a46a45bbc043f35b59d0d96388ac0008af2f000000001976a914fd270b1ee6abcaea97fea7ad0402e8bd8ad6d77c88ac02473044022047ac8e878352d3ebbde1c94ce3a10d057c24175747116f8288e5d794d12d482f0220217f36a485cae903c713331d877c1f64677e3622ad4010726870540656fe9dcb012103ad1d8e89212f0b92c74d23bb710c00662ad1470198ac48c43f7d6f93a2a2687392040000";
const BIP143_TXID = "ef48d9d0f595052e0f8cdcf825f7a5e50b6a388a81f206f3f4846e5ecd7a0c23";
const BIP143_PREV_TXID = "77541aeb3c4dac9260b68f74f44c973081a9d4cb2ebe8038b2d70faa201b6bdb";
const BIP143_ADDRESS = "38BW8nqpHSWpkf5sXrQd2xYwvnPJwP59ic";

function tx(index: number, overrides: Record<string, unknown> = {}) {
  return {
    txid: index.toString(16).padStart(64, "0"),
    vin: [{ prevout: { scriptpubkey_address: ADDRESS_A, value: 1_000 } }],
    vout: [{ scriptpubkey_address: ADDRESS_B, value: 400 }],
    status: {
      confirmed: true,
      block_height: 99,
      block_hash: BLOCK_HASH,
      block_time: 1_700_000_000,
    },
    ...overrides,
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Esplora Bitcoin provider", () => {
  it("validates configuration without ever returning provider credentials", () => {
    const config = providerConfigFromEnvironment("btc:mainnet", {
      BITCOIN_MAINNET_ESPLORA_URL: "https://user:password@example.com/api/?token=must-not-survive#fragment",
      BITCOIN_MAINNET_ESPLORA_BEARER_TOKEN: "top-secret",
    });
    expect(config).toEqual({ baseUrl: "https://example.com/api", bearerToken: "top-secret" });
    expect(providerConfigFromEnvironment("btc:testnet", {
      BITCOIN_TESTNET_ESPLORA_URL: "http://remote.example/api",
    })).toBeNull();
    expect(providerConfigFromEnvironment("btc:testnet", {
      BITCOIN_TESTNET_ESPLORA_URL: "http://127.0.0.1:3002/api",
    })).toEqual({ baseUrl: "http://127.0.0.1:3002/api" });
  });

  it("paginates and deduplicates history, preserves exact sats, and invalidates orphan confirmations", async () => {
    const firstPage = [
      tx(27, { status: { confirmed: false } }),
      ...Array.from({ length: 25 }, (_, index) => tx(index + 1)),
    ];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer top-secret");
      const url = String(input);
      if (url.endsWith("/blocks/tip/height")) return new Response("100");
      if (url.endsWith("/blocks/tip/hash")) return new Response(TIP_HASH);
      if (url.endsWith("/block-height/99")) return new Response(BLOCK_HASH);
      if (url.endsWith(`/address/${ADDRESS_A}`) || url.endsWith(`/address/${ADDRESS_B}`)) {
        return json({ chain_stats: { tx_count: 1 }, mempool_stats: { tx_count: 0 } });
      }
      if (url.includes(`${ADDRESS_A}/txs/chain/`)) return json([tx(26), tx(1)]);
      if (url.endsWith(`/address/${ADDRESS_A}/txs`)) return json(firstPage);
      if (url.endsWith(`/address/${ADDRESS_B}/txs`)) return json([tx(1)]);
      if (url.endsWith(`/address/${ADDRESS_A}/utxo`)) {
        return json([
          {
            txid: "d".repeat(64),
            vout: 0,
            value: 2_100_000_000_000_000,
            status: { confirmed: true, block_height: 99, block_hash: BLOCK_HASH },
          },
        ]);
      }
      if (url.endsWith(`/address/${ADDRESS_B}/utxo`)) {
        return json([
          {
            txid: "e".repeat(64),
            vout: 1,
            value: 7,
            status: { confirmed: true, block_height: 99, block_hash: ORPHAN_HASH },
          },
        ]);
      }
      return new Response("not found", { status: 404 });
    });

    const result = await scanBitcoinAddresses({
      chain: "btc:mainnet",
      addresses: [ADDRESS_A, ADDRESS_B],
      config: { baseUrl: "https://example.com/api", bearerToken: "top-secret" },
      fetchImpl,
    });

    expect(result.activity).toEqual([
      { address: ADDRESS_A, used: true },
      { address: ADDRESS_B, used: true },
    ]);
    expect(result.snapshot.transactions).toHaveLength(27);
    expect(result.snapshot.transactions[0]).toMatchObject({ txid: tx(27).txid, confirmed: false });
    expect(result.snapshot.transactions.find((item) => item.txid === tx(1).txid)?.netValueSats).toBe("-600");
    expect(result.snapshot.balanceSats).toBe("2100000000000000");
    expect(result.snapshot.utxos[0]).toMatchObject({ confirmed: true, confirmations: 2 });
    expect(result.snapshot.utxos).toHaveLength(1);
  });

  it("returns sanitized provider errors that cannot contain URLs, tokens, or response bodies", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response("top-secret upstream diagnostic", { status: 500 }),
    );
    const promise = scanBitcoinAddresses({
      chain: "btc:mainnet",
      addresses: [ADDRESS_A],
      config: { baseUrl: "https://private.example/api", bearerToken: "top-secret" },
      fetchImpl,
    });
    await expect(promise).rejects.toEqual(
      expect.objectContaining<Partial<BitcoinProviderError>>({
        code: "unavailable",
        message: "Bitcoin provider is unavailable (HTTP 500)",
      }),
    );
    await promise.catch((error: unknown) => {
      const text = String(error);
      expect(text).not.toContain("top-secret");
      expect(text).not.toContain("private.example");
    });
  });

  it("reports the HTTP status so a rejected request is distinguishable from provider downtime", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response("Too many history entries", { status: 400 }),
    );
    const promise = scanBitcoinAddresses({
      chain: "btc:mainnet",
      addresses: [ADDRESS_A],
      config: { baseUrl: "https://private.example/api", bearerToken: "top-secret" },
      fetchImpl,
    });
    await expect(promise).rejects.toMatchObject({ code: "unavailable", httpStatus: 400 });
    await promise.catch((error: unknown) => {
      expect(String(error)).toContain("400");
    });
  });

  it("still withholds the URL, token, and response body when reporting an HTTP status", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response("top-secret upstream diagnostic", { status: 400 }),
    );
    const promise = scanBitcoinAddresses({
      chain: "btc:mainnet",
      addresses: [ADDRESS_A],
      config: { baseUrl: "https://private.example/api", bearerToken: "top-secret" },
      fetchImpl,
    });
    await expect(promise).rejects.toBeInstanceOf(BitcoinProviderError);
    await promise.catch((error: unknown) => {
      const text = String(error);
      expect(text).not.toContain("top-secret");
      expect(text).not.toContain("private.example");
      expect(text).not.toContain("upstream diagnostic");
    });
  });

  it("omits an HTTP status when the request never produced a response", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed");
    });
    const promise = scanBitcoinAddresses({
      chain: "btc:mainnet",
      addresses: [ADDRESS_A],
      config: { baseUrl: "https://private.example/api" },
      fetchImpl,
    });
    await expect(promise).rejects.toMatchObject({ code: "unavailable" });
    await promise.catch((error: unknown) => {
      expect((error as BitcoinProviderError).httpStatus).toBeUndefined();
    });
  });

  it("reports confirmations only when the transaction block remains canonical", async () => {
    const txid = "f".repeat(64);
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/blocks/tip/height")) return new Response("104");
      if (url.endsWith(`/tx/${txid}/status`)) {
        return json({ confirmed: true, block_height: 99, block_hash: BLOCK_HASH });
      }
      if (url.endsWith("/block-height/99")) return new Response(BLOCK_HASH);
      return new Response("not found", { status: 404 });
    });
    await expect(
      getBitcoinTransactionStatus({
        txid,
        config: { baseUrl: "https://example.com/api" },
        fetchImpl,
      }),
    ).resolves.toEqual({
      state: "confirmed",
      confirmations: 6,
      blockHeight: 99,
      blockHash: BLOCK_HASH,
    });

    fetchImpl.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/blocks/tip/height")) return new Response("104");
      if (url.includes("/status")) return json({ confirmed: true, block_height: 99, block_hash: ORPHAN_HASH });
      return new Response(BLOCK_HASH);
    });
    await expect(
      getBitcoinTransactionStatus({
        txid,
        config: { baseUrl: "https://example.com/api" },
        fetchImpl,
      }),
    ).resolves.toMatchObject({ state: "pending", confirmations: 0, blockHeight: null });
  });

  it("reviews every prevout, binds the tip, and broadcasts only the approved digest", async () => {
    let postedBody: string | null = null;
    const fetchImpl = bitcoinBroadcastFetch({
      onPost(body) { postedBody = body; },
    });
    const request = {
      chain: "btc:mainnet" as const,
      treasuryId: "btc-treasury",
      watchedAddresses: [BIP143_ADDRESS],
      rawTxHex: BIP143_SIGNED,
    };
    const review = await reviewBitcoinBroadcast({ request, config: { baseUrl: "https://example.com/api", bearerToken: "top-secret" }, fetchImpl });
    expect(review).toMatchObject({ txid: BIP143_TXID, feeSats: "3400", tipHeight: 2_000, tipHash: TIP_HASH });

    const result = await confirmBitcoinBroadcast({
      request: { ...request, reviewDigest: review.digest },
      config: { baseUrl: "https://example.com/api", bearerToken: "top-secret" },
      fetchImpl,
      now: () => new Date("2026-08-03T00:00:00.000Z"),
    });
    expect(result).toEqual({
      ok: true,
      receipt: {
        txid: BIP143_TXID,
        reviewDigest: review.digest,
        state: "submitted",
        submittedAt: "2026-08-03T00:00:00.000Z",
      },
    });
    expect(postedBody).toBe(BIP143_SIGNED);
  });

  it("does not submit when the immutable review digest is stale or tampered", async () => {
    let postCount = 0;
    const fetchImpl = bitcoinBroadcastFetch({ onPost() { postCount++; } });
    const result = await confirmBitcoinBroadcast({
      request: {
        chain: "btc:mainnet",
        treasuryId: "btc-treasury",
        watchedAddresses: [BIP143_ADDRESS],
        rawTxHex: BIP143_SIGNED,
        reviewDigest: "0".repeat(64),
      },
      config: { baseUrl: "https://example.com/api" },
      fetchImpl,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "review_changed" }, review: { txid: BIP143_TXID } });
    expect(postCount).toBe(0);
  });

  it("is idempotent for an already-known transaction and rejects a provider txid mismatch", async () => {
    const knownFetch = bitcoinBroadcastFetch({ known: true });
    const request = {
      chain: "btc:mainnet" as const,
      treasuryId: "btc-treasury",
      watchedAddresses: [BIP143_ADDRESS],
      rawTxHex: BIP143_SIGNED,
      reviewDigest: "unused",
    };
    // Obtain the same deterministic digest with the known check disabled.
    const review = await reviewBitcoinBroadcast({
      request,
      config: { baseUrl: "https://example.com/api" },
      fetchImpl: bitcoinBroadcastFetch({}),
    });
    const known = await confirmBitcoinBroadcast({
      request: { ...request, reviewDigest: review.digest },
      config: { baseUrl: "https://example.com/api" },
      fetchImpl: knownFetch,
    });
    expect(known).toMatchObject({ ok: true, receipt: { state: "already_broadcast", txid: BIP143_TXID } });

    await expect(confirmBitcoinBroadcast({
      request: { ...request, reviewDigest: review.digest },
      config: { baseUrl: "https://example.com/api" },
      fetchImpl: bitcoinBroadcastFetch({ returnedTxid: "9".repeat(64) }),
    })).rejects.toMatchObject({ code: "txid_mismatch", message: "Bitcoin provider returned a mismatched transaction id" });
  });

  it("rejects already-known reviews and prevouts absent from the selected network", async () => {
    const request = {
      chain: "btc:mainnet" as const,
      treasuryId: "btc-treasury",
      watchedAddresses: [BIP143_ADDRESS],
      rawTxHex: BIP143_SIGNED,
    };
    await expect(reviewBitcoinBroadcast({
      request,
      config: { baseUrl: "https://example.com/api" },
      fetchImpl: bitcoinBroadcastFetch({ known: true }),
    })).rejects.toMatchObject({ code: "already_known" });
    await expect(reviewBitcoinBroadcast({
      request,
      config: { baseUrl: "https://example.com/api" },
      fetchImpl: bitcoinBroadcastFetch({ missingPrevout: true }),
    })).rejects.toMatchObject({ code: "wrong_network" });
  });

  it("keeps provider rejection distinct from provider unavailability", async () => {
    const baseRequest = {
      chain: "btc:mainnet" as const,
      treasuryId: "btc-treasury",
      watchedAddresses: [BIP143_ADDRESS],
      rawTxHex: BIP143_SIGNED,
    };
    const review = await reviewBitcoinBroadcast({ request: baseRequest, config: { baseUrl: "https://example.com/api" }, fetchImpl: bitcoinBroadcastFetch({}) });
    await expect(confirmBitcoinBroadcast({
      request: { ...baseRequest, reviewDigest: review.digest },
      config: { baseUrl: "https://example.com/api" },
      fetchImpl: bitcoinBroadcastFetch({ postStatus: 400 }),
    })).rejects.toMatchObject({ code: "rejected" });
    await expect(confirmBitcoinBroadcast({
      request: { ...baseRequest, reviewDigest: review.digest },
      config: { baseUrl: "https://example.com/api" },
      fetchImpl: bitcoinBroadcastFetch({ postStatus: 503 }),
    })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("reports unknown when a submitted transaction disappears from the provider", async () => {
    await expect(getBitcoinTransactionStatus({
      txid: BIP143_TXID,
      config: { baseUrl: "https://example.com/api" },
      fetchImpl: vi.fn<typeof fetch>(async (input) => String(input).endsWith("/blocks/tip/height")
        ? new Response("2000")
        : new Response("not found", { status: 404 })),
    })).resolves.toEqual({ state: "unknown", confirmations: 0, blockHeight: null, blockHash: null });
  });

  it("returns exact finalized evidence only at six canonical confirmations", async () => {
    const baseRequest = { chain: "btc:mainnet" as const, treasuryId: "btc-treasury", watchedAddresses: [BIP143_ADDRESS], rawTxHex: BIP143_SIGNED };
    const inspected = await reviewBitcoinBroadcast({ request: baseRequest, config: { baseUrl: "https://example.com/api" }, fetchImpl: bitcoinBroadcastFetch({}) });
    const accounting = inspected.outputs.map((output, index) => ({ vout: output.vout, destination: output.address!, valueSats: output.valueSats, payeeId: `vendor-${index}`, fiat: { currency: "USD" as const, minor: "100" } }));
    const request = { ...baseRequest, accounting };
    const review = await reviewBitcoinBroadcast({ request, config: { baseUrl: "https://example.com/api" }, fetchImpl: bitcoinBroadcastFetch({}) });
    if (review.reviewVersion !== 2) throw new Error("expected v2 review");
    const receipt = { txid: review.txid, reviewDigest: review.digest, state: "submitted" as const, submittedAt: "2026-08-03T00:00:00.000Z" };
    const evidenceFetch = finalizedFetch(2_005);
    const result = await getFinalizedBitcoinPaymentEvidence({ request: { chain: review.chain, treasuryId: review.treasuryId, review, receipt }, config: { baseUrl: "https://example.com/api" }, fetchImpl: evidenceFetch });
    expect(result.evidence).toMatchObject({ txid: review.txid, wtxid: review.wtxid, blockHeight: "2000", blockHash: BLOCK_HASH, confirmations: 6, feeSats: "3400", outputs: review.outputs });
    expect(JSON.stringify(result)).not.toContain(BIP143_SIGNED);

    await expect(getFinalizedBitcoinPaymentEvidence({ request: { chain: review.chain, treasuryId: review.treasuryId, review, receipt }, config: { baseUrl: "https://example.com/api" }, fetchImpl: finalizedFetch(2_004) })).rejects.toMatchObject({ code: "not_finalized" });
    await expect(getFinalizedBitcoinPaymentEvidence({ request: { chain: review.chain, treasuryId: review.treasuryId, review, receipt }, config: { baseUrl: "https://example.com/api" }, fetchImpl: finalizedFetch(2_005, `${BIP143_SIGNED.slice(0, -2)}01`) })).rejects.toMatchObject({ code: "evidence_mismatch" });
    await expect(getFinalizedBitcoinPaymentEvidence({ request: { chain: review.chain, treasuryId: review.treasuryId, review, receipt }, config: { baseUrl: "https://example.com/api" }, fetchImpl: finalizedFetch(2_005, BIP143_SIGNED, 999_999_999) })).rejects.toMatchObject({ code: "evidence_mismatch" });
  });
});

function finalizedFetch(tipHeight: number, rawHex = BIP143_SIGNED, prevoutValue = 1_000_000_000): typeof fetch {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith("/blocks/tip/height")) return new Response(String(tipHeight));
    if (url.endsWith(`/tx/${BIP143_TXID}/status`)) return json({ confirmed: true, block_height: 2_000, block_hash: BLOCK_HASH, block_time: 1_700_000_000 });
    if (url.endsWith(`/tx/${BIP143_TXID}/hex`)) return new Response(rawHex);
    if (url.endsWith(`/tx/${BIP143_PREV_TXID}`)) return json({
      txid: BIP143_PREV_TXID,
      vout: [
        { scriptpubkey: "6a", value: 0 },
        { scriptpubkey: "a9144733f37cf4db86fbc2efed2500b4f4e49f31202387", scriptpubkey_address: BIP143_ADDRESS, value: prevoutValue },
      ],
      status: { confirmed: true, block_height: 1_000, block_hash: BLOCK_HASH },
    });
    if (url.endsWith("/block-height/2000")) return new Response(BLOCK_HASH);
    if (url.endsWith(`/block/${BLOCK_HASH}`)) return json({ id: BLOCK_HASH, height: 2_000, mediantime: 1_699_999_000, timestamp: 1_700_000_000 });
    return new Response("not found", { status: 404 });
  });
}

function bitcoinBroadcastFetch(options: {
  known?: boolean;
  returnedTxid?: string;
  missingPrevout?: boolean;
  postStatus?: number;
  onPost?: (body: string) => void;
}): typeof fetch {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    expect(url).not.toContain("top-secret");
    if (url.endsWith("/blocks/tip/height")) return new Response("2000");
    if (url.endsWith("/blocks/tip/hash")) return new Response(TIP_HASH);
    if (url.endsWith(`/block/${TIP_HASH}`)) return json({ id: TIP_HASH, height: 2_000, mediantime: 1_700_000_000 });
    if (url.endsWith(`/tx/${BIP143_TXID}/status`)) {
      return options.known ? json({ confirmed: false }) : new Response("not found", { status: 404 });
    }
    if (url.endsWith(`/tx/${BIP143_PREV_TXID}`)) {
      if (options.missingPrevout) return new Response("not found", { status: 404 });
      return json({
        txid: BIP143_PREV_TXID,
        vout: [
          { scriptpubkey: "6a", value: 0 },
          { scriptpubkey: "a9144733f37cf4db86fbc2efed2500b4f4e49f31202387", scriptpubkey_address: BIP143_ADDRESS, value: 1_000_000_000 },
        ],
        status: { confirmed: true, block_height: 1_000, block_hash: BLOCK_HASH },
      });
    }
    if (url.endsWith("/tx") && init?.method === "POST") {
      options.onPost?.(String(init.body));
      expect(new Headers(init.headers).get("authorization")).toBe(init.headers && new Headers(init.headers).has("authorization") ? "Bearer top-secret" : null);
      if (options.postStatus) return new Response("sanitized upstream detail", { status: options.postStatus });
      return new Response(options.returnedTxid ?? BIP143_TXID);
    }
    return new Response("not found", { status: 404 });
  });
}
