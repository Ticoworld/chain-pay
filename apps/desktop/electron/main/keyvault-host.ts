/**
 * Keyvault host — Electron main-process vault operations.
 *
 * Security contract:
 *   1. Every sign request is Zod-validated at the untrusted IPC boundary.
 *   2. The vault's derived lock-args are compared to the caller-supplied
 *      sourceLockArgs before ANY signature is produced (anti-blind-sign).
 *   3. The sighash-all digest is recomputed from the tx object here in main —
 *      a renderer-supplied digest is NEVER trusted.
 *   4. The 65-byte signature is placed in witnesses[groupInputIndices[0]].lock.
 *   5. The password bytes are overwritten with zeros in a `finally` block.
 *
 * Key material (seed, mnemonic, private key) NEVER leaves this module.
 * No raw secret is logged, returned over IPC, or held beyond the call frame.
 */

import { clipboard, dialog, ipcMain } from "electron";
import {
  Transaction,
  WitnessArgs,
  hexFrom,
  bytesFrom,
  stringify,
} from "@ckb-ccc/core";
import { KeyvaultStore } from "./keyvault-store";
import { KeyvaultRateLimiter } from "./keyvault-rate-limit";
import { computeSighashAllDigest } from "@shared/ckb-sighash";
import {
  SignTxRequest,
  ImportRequest,
  CreateRequest,
  ExportRequest,
  ChangePasswordRequest,
  DeleteRequest,
  UnlockDeriveRequest,
  KEYVAULT_CHANNELS,
} from "@shared/keyvault-ipc";
import type { SignTxResponse } from "@shared/keyvault-ipc";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Minimal surface of the ckb-keyvault-wasm pkg consumed by this host. */
interface WasmVault {
  import_seed_phrase(mnemonic: Uint8Array, password: Uint8Array): Uint8Array;
  derive_lock_args(
    blob: Uint8Array,
    password: Uint8Array,
    index: number,
  ): Uint8Array;
  sign_digest(
    blob: Uint8Array,
    password: Uint8Array,
    index: number,
    digest: Uint8Array,
  ): Uint8Array;
  generate_master_seed(password: Uint8Array): unknown;
  export_seed_phrase(blob: Uint8Array, password: Uint8Array): Uint8Array;
  change_password(
    blob: Uint8Array,
    old: Uint8Array,
    _new: Uint8Array,
  ): Uint8Array;
}

export interface Deps {
  store: KeyvaultStore;
  wasm: WasmVault;
  /**
   * Optional brute-force guard. When present, decryption entry points
   * (signTxInVault, unlockDeriveInVault) check it before attempting a
   * password decrypt, record failures, and reset it on success.
   */
  limiter?: KeyvaultRateLimiter;
}

/**
 * Derive lock-args from the vault, funnelled through the rate limiter so a
 * wrong password counts toward lockout and a correct one resets the counter.
 * The thrown error from a wrong password (or a locked-out `check`) propagates
 * unchanged — callers surface it to the renderer.
 */
function deriveLockArgsGuarded(
  deps: Deps,
  vaultId: string,
  blob: Uint8Array,
  password: Uint8Array,
  index: number,
): string {
  deps.limiter?.check(vaultId);
  let args: Uint8Array;
  try {
    args = deps.wasm.derive_lock_args(blob, password, index);
  } catch (err) {
    deps.limiter?.recordFailure(vaultId);
    throw err;
  }
  deps.limiter?.recordSuccess(vaultId);
  return hexFrom(args);
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/** Default vault id — v1 supports exactly one local keyvault. */
const VAULT_ID = "main";

async function showRecoveryWords(phrase: string): Promise<void> {
  await dialog.showMessageBox({
    type: "warning",
    title: "ChainPay recovery words",
    message: phrase,
    detail: "Write these words down in order and store them offline. ChainPay will not copy them to the app window or clipboard.",
    buttons: ["I have written them down"],
    defaultId: 0,
    noLink: true,
  });
}

// ---------------------------------------------------------------------------
// Exported pure functions (unit-testable without Electron)
// ---------------------------------------------------------------------------

/**
 * Import a BIP39 mnemonic phrase into the vault, encrypted with `password`.
 *
 * Returns the vault id and the derived lock-args at index 0 (0x-prefixed hex).
 * No key material is returned — only the lock-args (public information).
 */
export async function importVault(
  req: { mnemonic: string; password: string },
  deps: Deps,
): Promise<{ id: string; lockArgs: string }> {
  ImportRequest.parse({ password: req.password });
  if (!req.mnemonic.trim()) throw new Error("Recovery words are empty");
  if (deps.store.has(VAULT_ID)) throw new Error("keyvault already exists");

  const mnemonic = new TextEncoder().encode(req.mnemonic);
  const password = new TextEncoder().encode(req.password);
  try {
    const blob = deps.wasm.import_seed_phrase(mnemonic, password);
    const args = deps.wasm.derive_lock_args(blob, password, 0);
    deps.store.create(VAULT_ID, Buffer.from(blob));
    return { id: VAULT_ID, lockArgs: hexFrom(args) };
  } finally {
    mnemonic.fill(0);
    password.fill(0);
  }
}

/**
 * Sign a CKB transaction inside the vault.
 *
 * The full security contract (see module docblock) is enforced here:
 *   • Zod validates every field of the incoming request.
 *   • The vault's own derived lock-args are compared to sourceLockArgs.
 *   • The digest is recomputed from the raw tx, never taken from the caller.
 *   • The password is zeroized in `finally` regardless of outcome.
 */
export async function signTxInVault(
  reqIn: unknown,
  deps: Deps,
): Promise<SignTxResponse> {
  const req = SignTxRequest.parse(reqIn);

  if (!deps.store.has(req.keyvaultId)) {
    throw new Error(`keyvault not found: ${req.keyvaultId}`);
  }

  const blob = deps.store.read(req.keyvaultId);
  const password = new TextEncoder().encode(req.password);

  try {
    // Step 2 — Verify the vault's derived key owns the claimed source lock.
    // This is the anti-blind-sign gate: if the vault doesn't control the
    // lock being spent, we refuse to produce a signature for it. The derive
    // is funnelled through the rate limiter (wrong password ⇒ lockout).
    const derivedArgs = deriveLockArgsGuarded(
      deps,
      req.keyvaultId,
      blob,
      password,
      req.derivationIndex,
    );
    if (derivedArgs.toLowerCase() !== req.sourceLockArgs.toLowerCase()) {
      throw new Error(
        "source lock args do not match this keyvault's derived key",
      );
    }

    // Step 3 — Recompute the sighash-all digest from the tx WE hold.
    // We parse the tx ourselves and feed it to the digest helper — the
    // renderer-supplied JSON is the raw material, NOT a pre-hashed value.
    const tx = Transaction.from(JSON.parse(req.unsignedTx) as object);
    const digest = computeSighashAllDigest(tx, req.groupInputIndices);

    // Step 4 — Sign inside the vault.  The 65-byte recoverable sig is placed
    // into witnesses[groupInputIndices[0]].lock and the tx is returned.
    const sig = deps.wasm.sign_digest(
      blob,
      password,
      req.derivationIndex,
      bytesFrom(digest),
    );

    const g0 = req.groupInputIndices[0]!;
    const existingHex = tx.witnesses[g0] ?? "0x";
    const existingWa =
      existingHex === "0x"
        ? WitnessArgs.from({})
        : WitnessArgs.fromBytes(bytesFrom(existingHex));

    const finalWa = WitnessArgs.from({
      lock: hexFrom(sig),
      ...(existingWa.inputType !== undefined
        ? { inputType: existingWa.inputType }
        : {}),
      ...(existingWa.outputType !== undefined
        ? { outputType: existingWa.outputType }
        : {}),
    });
    tx.witnesses[g0] = hexFrom(finalWa.toBytes());

    // Use CCC's bigint-aware stringify so `since` and capacity round-trip.
    return { signedTx: stringify(tx) };
  } finally {
    // Step 5 — Zeroize the password bytes.
    password.fill(0);
  }
}

/**
 * Unlock the vault and derive the lock-args at `derivationIndex` — the
 * password-only "is this my vault" path. This is the cheapest brute-force
 * surface (no tx required), so it goes through the rate limiter too.
 *
 * Returns only the public lock-args; no key material crosses the boundary.
 */
export async function unlockDeriveInVault(
  reqIn: unknown,
  deps: Deps,
): Promise<{ lockArgs: string }> {
  const req = UnlockDeriveRequest.parse(reqIn);
  if (!deps.store.has(req.keyvaultId)) {
    throw new Error(`keyvault not found: ${req.keyvaultId}`);
  }
  const blob = deps.store.read(req.keyvaultId);
  const password = new TextEncoder().encode(req.password);
  try {
    const lockArgs = deriveLockArgsGuarded(
      deps,
      req.keyvaultId,
      blob,
      password,
      req.derivationIndex,
    );
    return { lockArgs };
  } finally {
    password.fill(0);
  }
}

// ---------------------------------------------------------------------------
// IPC registration (Electron main only — not called during unit tests)
// ---------------------------------------------------------------------------

/**
 * Register `ipcMain.handle` for every keyvault channel.
 *
 * Call once inside `app.whenReady()` after constructing the KeyvaultStore
 * and loading the wasm module.
 */
export function registerKeyvaultHost(depsIn: Deps): void {
  // One shared brute-force guard for every decryption channel, unless the
  // caller injected its own (tests do). State lives only in the main process.
  const deps: Deps = {
    ...depsIn,
    limiter: depsIn.limiter ?? new KeyvaultRateLimiter(),
  };
  let vaultSetupPending = false;
  async function withEmptyVault<T>(work: () => Promise<T>): Promise<T> {
    if (vaultSetupPending || deps.store.has(VAULT_ID)) throw new Error("keyvault already exists");
    vaultSetupPending = true;
    try {
      return await work();
    } finally {
      vaultSetupPending = false;
    }
  }

  ipcMain.handle(KEYVAULT_CHANNELS.import, (_e, r: unknown) => withEmptyVault(async () => {
    const { password } = ImportRequest.parse(r);
    let mnemonic: string;
    try {
      mnemonic = (await clipboard.readText()).trim();
    } finally {
      clipboard.clear();
    }
    if (!mnemonic) throw new Error("Clipboard has no recovery words");
    if (mnemonic.length > 1_024) throw new Error("Recovery words are too long");
    return importVault({ mnemonic, password }, deps);
  }));

  ipcMain.handle(KEYVAULT_CHANNELS.create, (_e, r: unknown) => withEmptyVault(async () => {
    const { password: pw } = CreateRequest.parse(r);
    const password = new TextEncoder().encode(pw);
    let mnemonicBytes: Uint8Array | null = null;
    try {
      const result = deps.wasm.generate_master_seed(password) as {
        blob: Uint8Array;
        mnemonic: Uint8Array;
      };
      mnemonicBytes = result.mnemonic;
      const args = hexFrom(deps.wasm.derive_lock_args(result.blob, password, 0));
      await showRecoveryWords(new TextDecoder().decode(mnemonicBytes));
      deps.store.create(VAULT_ID, Buffer.from(result.blob));
      return { id: VAULT_ID, lockArgs: args };
    } finally {
      mnemonicBytes?.fill(0);
      password.fill(0);
    }
  }));

  ipcMain.handle(KEYVAULT_CHANNELS.signTx, (_e, r: unknown) =>
    signTxInVault(r, deps),
  );

  ipcMain.handle(KEYVAULT_CHANNELS.status, () => ({
    exists: deps.store.has(VAULT_ID),
  }));

  ipcMain.handle(KEYVAULT_CHANNELS.unlockDerive, (_e, r: unknown) =>
    unlockDeriveInVault(r, deps),
  );

  ipcMain.handle(KEYVAULT_CHANNELS.export, async (_e, r: unknown) => {
    const req = ExportRequest.parse(r);
    if (!deps.store.has(req.keyvaultId)) {
      throw new Error(`keyvault not found: ${req.keyvaultId}`);
    }
    const blob = deps.store.read(req.keyvaultId);
    const password = new TextEncoder().encode(req.password);
    let mnemonicBytes: Uint8Array | null = null;
    try {
      deps.limiter?.check(req.keyvaultId);
      try {
        mnemonicBytes = deps.wasm.export_seed_phrase(blob, password);
      } catch (err) {
        deps.limiter?.recordFailure(req.keyvaultId);
        throw err;
      }
      await showRecoveryWords(new TextDecoder().decode(mnemonicBytes));
      deps.limiter?.recordSuccess(req.keyvaultId);
      return { ok: true };
    } finally {
      mnemonicBytes?.fill(0);
      password.fill(0);
    }
  });

  ipcMain.handle(KEYVAULT_CHANNELS.changePassword, (_e, r: unknown) => {
    const req = ChangePasswordRequest.parse(r);
    if (!deps.store.has(req.keyvaultId)) {
      throw new Error(`keyvault not found: ${req.keyvaultId}`);
    }
    const blob = deps.store.read(req.keyvaultId);
    const oldPw = new TextEncoder().encode(req.oldPassword);
    const newPw = new TextEncoder().encode(req.newPassword);
    try {
      deps.limiter?.check(req.keyvaultId);
      let newBlob: Uint8Array;
      try {
        newBlob = deps.wasm.change_password(blob, oldPw, newPw);
      } catch (err) {
        deps.limiter?.recordFailure(req.keyvaultId);
        throw err;
      }
      deps.store.write(req.keyvaultId, Buffer.from(newBlob));
      deps.limiter?.recordSuccess(req.keyvaultId);
      return { ok: true };
    } finally {
      oldPw.fill(0);
      newPw.fill(0);
    }
  });

  ipcMain.handle(KEYVAULT_CHANNELS.delete, (_e, r: unknown) => {
    const req = DeleteRequest.parse(r);
    if (!deps.store.has(req.keyvaultId)) throw new Error(`keyvault not found: ${req.keyvaultId}`);
    const password = new TextEncoder().encode(req.password);
    try {
      deriveLockArgsGuarded(deps, req.keyvaultId, deps.store.read(req.keyvaultId), password, 0);
      deps.store.delete(req.keyvaultId);
      return { ok: true };
    } finally {
      password.fill(0);
    }
  });
}
