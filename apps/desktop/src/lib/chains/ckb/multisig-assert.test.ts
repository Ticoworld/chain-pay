import { beforeEach, describe, expect, it, vi } from "vitest";
import { Transaction, WitnessArgs, hexFrom } from "@ckb-ccc/core";
import type { CkbMultisig, Hex20 } from "@chain-pay/shared";
import {
  assertMultisigBytesMatchTreasury,
  dumpInputsForInspection,
} from "./multisig-assert";
import { encodeMultisigScript, lockArgsFromConfig, type CkbMultisigConfig } from "./multisig";
import { deriveTreasuryAddress } from "./address";
import { bytesHex } from "./bytes";

const hash = (byte: string): Hex20 => ("0x" + byte.repeat(20)) as Hex20;

/**
 * A 2-of-3 config. The exact pubkey-hash bytes don't matter: every fixture
 * address is DERIVED from the config under test via the production
 * `deriveTreasuryAddress`, so the "matching" case is self-consistent by
 * construction rather than by a hand-written address literal.
 */
const CFG: CkbMultisigConfig = {
  s: 0,
  r: 0,
  m: 2,
  n: 3,
  pubkeyHashes: [hash("11"), hash("22"), hash("33")],
};

function multisigFor(cfg: CkbMultisigConfig): CkbMultisig {
  return {
    chain: "ckb:testnet",
    s: cfg.s,
    r: cfg.r,
    m: cfg.m,
    n: cfg.n,
    pubkeyHashes: cfg.pubkeyHashes,
    address: deriveTreasuryAddress(cfg, "testnet"),
  };
}

/** witness lock = multisig_script | M zeroed 65-byte signature slots. */
function placeholderLock(script: Uint8Array, m: number): Uint8Array {
  const lock = new Uint8Array(script.length + 65 * m);
  lock.set(script, 0);
  return lock;
}

function txWithWitnessLock(lock: Uint8Array): Transaction {
  const tx = Transaction.from({ inputs: [], outputs: [], outputsData: [] });
  tx.witnesses = [hexFrom(WitnessArgs.from({ lock: hexFrom(lock) }).toBytes())];
  return tx;
}

describe("assertMultisigBytesMatchTreasury", () => {
  it("passes when the witness script and the address both match the config", () => {
    const lock = placeholderLock(encodeMultisigScript(CFG).multisigScript, CFG.m);
    expect(() =>
      assertMultisigBytesMatchTreasury(txWithWitnessLock(lock), CFG, multisigFor(CFG)),
    ).not.toThrow();
  });

  it("throws when the treasury address decodes to different lock args", () => {
    const otherCfg: CkbMultisigConfig = {
      ...CFG,
      pubkeyHashes: [hash("99"), hash("88"), hash("77")],
    };
    const lock = placeholderLock(encodeMultisigScript(CFG).multisigScript, CFG.m);
    expect(() =>
      assertMultisigBytesMatchTreasury(txWithWitnessLock(lock), CFG, multisigFor(otherCfg)),
    ).toThrow(/Treasury config drift/);
  });

  it("throws when witness[0].lock is shorter than the multisig script prefix", () => {
    expect(() =>
      assertMultisigBytesMatchTreasury(
        txWithWitnessLock(new Uint8Array(8)),
        CFG,
        multisigFor(CFG),
      ),
    ).toThrow(/witness\[0\]\.lock too short/);
  });

  // The threshold is `4 + 20 * n` (S|R|M|N header + one 20-byte hash per
  // signer). The cases below sit either side of it so the test can tell that
  // formula apart from `20 * n` (60) and `4 + 20 * m` (44) — a lock of 8 bytes
  // is below all three and proves nothing about which one is implemented.
  it("rejects a lock one byte below the 4 + 20n threshold and reports the exact requirement", () => {
    const justUnder = new Uint8Array(4 + 20 * CFG.n - 1); // 63
    expect(() =>
      assertMultisigBytesMatchTreasury(txWithWitnessLock(justUnder), CFG, multisigFor(CFG)),
    ).toThrow("witness[0].lock too short: 63 bytes, need at least 64");
  });

  it("accepts the 4 + 20n length and falls through to the script-content check", () => {
    const exact = new Uint8Array(4 + 20 * CFG.n); // 64 — long enough, wrong bytes
    expect(() =>
      assertMultisigBytesMatchTreasury(txWithWitnessLock(exact), CFG, multisigFor(CFG)),
    ).toThrow(/multisig_script doesn't match/);
  });

  it("sizes the prefix from n, not m, for a config where n is not 3", () => {
    // 2-of-5: 4 + 20*5 = 104. A lock sized for `4 + 20*m` (44) must still fail.
    const wide: CkbMultisigConfig = {
      s: 0,
      r: 0,
      m: 2,
      n: 5,
      pubkeyHashes: [hash("11"), hash("22"), hash("33"), hash("44"), hash("55")],
    };
    expect(() =>
      assertMultisigBytesMatchTreasury(
        txWithWitnessLock(new Uint8Array(4 + 20 * wide.m)),
        wide,
        multisigFor(wide),
      ),
    ).toThrow("witness[0].lock too short: 44 bytes, need at least 104");

    // And the same 2-of-5 passes end-to-end with a correctly sized lock.
    const lock = placeholderLock(encodeMultisigScript(wide).multisigScript, wide.m);
    expect(() =>
      assertMultisigBytesMatchTreasury(txWithWitnessLock(lock), wide, multisigFor(wide)),
    ).not.toThrow();
  });

  it("throws when witness[0] carries a different multisig script", () => {
    // Same N (so same prefix length — the length guard must not fire first),
    // different pubkey hashes.
    const wrong = encodeMultisigScript({
      ...CFG,
      pubkeyHashes: [hash("aa"), hash("bb"), hash("cc")],
    }).multisigScript;
    const lock = placeholderLock(wrong, CFG.m);
    expect(() =>
      assertMultisigBytesMatchTreasury(txWithWitnessLock(lock), CFG, multisigFor(CFG)),
    ).toThrow(/multisig_script doesn't match/);
  });
});

describe("dumpInputsForInspection", () => {
  beforeEach(() => {
    delete (globalThis as any).__chainpay_debug;
  });

  it("publishes the debug global that manual smoke sessions read", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const multisig = multisigFor(CFG);
    const tx = Transaction.from({
      inputs: [
        { previousOutput: { txHash: "0x" + "ab".repeat(32), index: 3 } },
        { previousOutput: { txHash: "0x" + "cd".repeat(32), index: 0 } },
      ],
      outputs: [],
      outputsData: [],
    });

    dumpInputsForInspection(tx, multisig);

    const debug = (globalThis as any).__chainpay_debug;
    expect(debug).toBeDefined();
    expect(debug.treasuryAddress).toBe(multisig.address);
    // Assert the VALUE, not the shape. A shape-only regex passes even if the
    // payload slice drifts (e.g. slice(0, 20) instead of slice(33, 53)), which
    // would publish the code_hash prefix as if it were the lock args.
    expect(debug.expectedLockArgs).toBe("0x" + bytesHex(lockArgsFromConfig(CFG)));
    expect(debug.inputs).toEqual([
      { slot: 0, txHash: "0x" + "ab".repeat(32), index: 3 },
      { slot: 1, txHash: "0x" + "cd".repeat(32), index: 0 },
    ]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  // A time-locked treasury's lock.args is 28 bytes (20-byte blake160 hash +
  // 8-byte `since`, RFC 0017), not the usual 20. `dumpInputsForInspection`
  // used to hardcode `payload.slice(33, 53)`, silently truncating to 20
  // bytes — an operator investigating a real -52 would compare that
  // truncated value against the chain's real 28-byte lock.args, see a
  // mismatch, and wrongly conclude config drift. This is the case the
  // slice(33) fix (no upper bound) actually exists for.
  it("publishes the full 28-byte args for a time-locked (since-bearing) treasury, not a truncated 20", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const timeLocked: CkbMultisigConfig = { ...CFG, since: 12_345n };
    const multisig = multisigFor(timeLocked);
    const tx = Transaction.from({ inputs: [], outputs: [], outputsData: [] });

    dumpInputsForInspection(tx, multisig);

    const debug = (globalThis as any).__chainpay_debug;
    const expected = lockArgsFromConfig(timeLocked);
    expect(expected).toHaveLength(28); // sanity: fixture really is time-locked
    expect(debug.expectedLockArgs).toBe("0x" + bytesHex(expected));
  });
});
