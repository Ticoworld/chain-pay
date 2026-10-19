import { z } from "zod";

// 20-byte address hash, 0x-prefixed hex (40 hex chars).
const Hex20 = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

// ---------------------------------------------------------------------------
// Request schemas (validated by main at the untrusted IPC boundary)
// ---------------------------------------------------------------------------

export const SignTxRequest = z.object({
  /** ID of the keyvault blob file to use (e.g. "main"). */
  keyvaultId: z.string().min(1),
  /** User password — zeroized in main after use; never logged or stored. */
  password: z.string().min(1),
  /** BIP32 child index: m/44'/309'/0'/0/<derivationIndex>. */
  derivationIndex: z.number().int().min(0).max(2_147_483_647),
  /** JSON-serialized unsigned CKB Transaction. Main re-serializes and re-hashes this. */
  unsignedTx: z.string(),
  /** 0x-prefixed 20-byte blake160 lock-args of the source cell being spent.
   *  Main verifies the derived key matches this before signing (anti-blind-sign). */
  sourceLockArgs: Hex20,
  /** Input indices that share this signing group (secp256k1_blake160_sighash_all group). */
  groupInputIndices: z.array(z.number().int().min(0)).min(1),
});
export type SignTxRequest = z.infer<typeof SignTxRequest>;

export const SignTxResponse = z.object({
  /** JSON-serialized signed CKB Transaction (witnesses[groupInputIndices[0]] set). */
  signedTx: z.string(),
});
export type SignTxResponse = z.infer<typeof SignTxResponse>;

export const CreateRequest = z.object({
  /** Password for the new keyvault. Never sent back over IPC. */
  password: z.string().min(1),
});
export type CreateRequest = z.infer<typeof CreateRequest>;

export const ImportRequest = z.object({
  /** Encryption password. Main reads recovery words from the system clipboard. */
  password: z.string().min(1),
}).strict();
export type ImportRequest = z.infer<typeof ImportRequest>;

export const UnlockDeriveRequest = z.object({
  /** Keyvault blob ID. */
  keyvaultId: z.string().min(1),
  /** Decryption password. */
  password: z.string().min(1),
  /** BIP32 child index to derive the lock-args for. */
  derivationIndex: z.number().int().min(0),
});
export type UnlockDeriveRequest = z.infer<typeof UnlockDeriveRequest>;

export const ExportRequest = z.object({
  keyvaultId: z.string().min(1),
  password: z.string().min(1),
});
export type ExportRequest = z.infer<typeof ExportRequest>;

export const ChangePasswordRequest = z.object({
  keyvaultId: z.string().min(1),
  oldPassword: z.string().min(1),
  newPassword: z.string().min(1),
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>;

export const DeleteRequest = z.object({
  keyvaultId: z.string().min(1),
  password: z.string().min(1),
});
export type DeleteRequest = z.infer<typeof DeleteRequest>;

// ---------------------------------------------------------------------------
// Channel constants (used by preload bridge and renderer — never raw strings)
// ---------------------------------------------------------------------------

export const KEYVAULT_CHANNELS = Object.freeze({
  /** Check whether a keyvault blob exists. */
  status: "keyvault:status",
  /** Create a new keyvault (generates mnemonic inside main). */
  create: "keyvault:create",
  /** Import recovery words read and cleared by Electron main from the clipboard. */
  import: "keyvault:import",
  /** Decrypt the keyvault and return derived lock-args / address. */
  unlockDerive: "keyvault:unlock-derive",
  /** Build and sign a CKB transaction inside the vault (security-critical). */
  signTx: "keyvault:sign-tx",
  /** Show recovery words in a native dialog; return status only. */
  export: "keyvault:export",
  /** Re-encrypt the keyvault blob under a new password. */
  changePassword: "keyvault:change-password",
  /** Permanently delete the keyvault blob from disk. */
  delete: "keyvault:delete",
} as const);

export type KeyvaultChannels = typeof KEYVAULT_CHANNELS;
