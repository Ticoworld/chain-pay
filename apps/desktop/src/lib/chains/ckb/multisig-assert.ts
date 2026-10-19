import { addressPayloadFromString } from "@ckb-ccc/core/advanced";
import { bytesFrom, hexFrom, Transaction, WitnessArgs } from "@ckb-ccc/core";
import type { CkbMultisig } from "@chain-pay/shared";
import { encodeMultisigScript, lockArgsFromConfig, type CkbMultisigConfig } from "./multisig";
import { bytesEqual, bytesHex } from "./bytes";

/**
 * Pre-broadcast sanity: catch the -52 (ERROR_MULTSIG_SCRIPT_HASH) class of
 * failures before the tx leaves the renderer. Reports drift in plain bytes
 * so we can diagnose without round-tripping the chain.
 */
export function assertMultisigBytesMatchTreasury(
  tx: Transaction,
  cfg: CkbMultisigConfig,
  multisig: CkbMultisig,
): void {
  const addrPayload = addressPayloadFromString(multisig.address);
  // CCC's addressPayloadFromString returns `format` separately and `payload` =
  // code_hash(32) | hash_type(1) | args(variable). Args therefore starts at
  // index 33 (NOT 34 — the format byte lives in `format`, not `payload`).
  const addrArgs = new Uint8Array(addrPayload.payload.slice(33));
  const fromCfg = lockArgsFromConfig(cfg);
  if (!bytesEqual(addrArgs, fromCfg)) {
    throw new Error(
      `Treasury config drift: blake160(multisig_script(cfg)) = 0x${bytesHex(fromCfg)}, ` +
        `but treasury.address decodes to lock.args 0x${bytesHex(addrArgs)}. ` +
        `cfg.pubkeyHashes order may have been mutated since wizard. ` +
        `Re-create the treasury from debug/keystores/setup.json.`,
    );
  }

  // Witness[0] consistency: the multisig_script we wrote must match what cfg encodes.
  const witnessBytes = bytesFrom(tx.witnesses[0] ?? "0x");
  const witnessArgs = WitnessArgs.fromBytes(witnessBytes);
  const lockBytes = witnessArgs.lock ? bytesFrom(witnessArgs.lock) : new Uint8Array(0);
  const scriptPrefixLen = 4 + 20 * cfg.n;
  if (lockBytes.length < scriptPrefixLen) {
    throw new Error(
      `witness[0].lock too short: ${lockBytes.length} bytes, need at least ${scriptPrefixLen}`,
    );
  }
  const expectedScript = encodeMultisigScript(cfg).multisigScript;
  if (!bytesEqual(lockBytes.slice(0, scriptPrefixLen), expectedScript)) {
    throw new Error(
      `witness[0] multisig_script doesn't match cfg.pubkeyHashes — mergeSignatures bug?`,
    );
  }
}

/**
 * Pre-broadcast diagnostic: surface the outpoints of every input so we can
 * look them up on an explorer when -52 fires. Doesn't throw — just enriches
 * the error path by dumping context onto window.__chainpay_debug.
 */
export function dumpInputsForInspection(tx: Transaction, multisig: CkbMultisig): void {
  const summary = tx.inputs.map((inp, i) => ({
    slot: i,
    txHash: hexFrom(inp.previousOutput.txHash),
    index: Number(inp.previousOutput.index),
  }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__chainpay_debug = {
    treasuryAddress: multisig.address,
    // Open-ended slice (no upper bound): args are 20 bytes normally but 28
    // for a time-locked treasury (20-byte hash + 8-byte `since`, RFC 0017).
    // A fixed slice(33, 53) truncates the latter, producing a diagnostic
    // that falsely disagrees with the real 28-byte lock.args on chain. The
    // guard above (assertMultisigBytesMatchTreasury) already uses the same
    // open-ended slice(33) and is since-safe; this mirrors it.
    expectedLockArgs: "0x" + bytesHex(
      new Uint8Array(addressPayloadFromString(multisig.address).payload.slice(33)),
    ),
    inputs: summary,
  };
  console.warn("[chainpay] tx inputs to broadcast", summary);
}
