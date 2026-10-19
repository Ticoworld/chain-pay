import { create } from "zustand";

/**
 * Narrow bridge surface that the store's actions call through.
 * Production: `window.chainpay.keyvault.*`.
 * Tests: stub `(globalThis as unknown as { window: ... }).window.chainpay.keyvault`.
 */
interface KeyvaultBridge {
  status: () => Promise<{ exists: boolean }>;
  create: (password: string) => Promise<{ id: string; lockArgs: string }>;
  import: (password: string) => Promise<{ id: string; lockArgs: string }>;
  delete: (keyvaultId: string, password: string) => Promise<{ ok: boolean }>;
}

/** Returns the live bridge — reads window.chainpay.keyvault each call so tests can swap it. */
function getBridge(): KeyvaultBridge {
  return window.chainpay.keyvault;
}

interface KeyvaultState {
  /** True when an encrypted keyvault blob exists on disk. */
  exists: boolean;
  /**
   * 0x-prefixed 20-byte blake160 lock-args of the derived key.
   * Null until the vault is created or refreshed.
   */
  lockArgs: string | null;
  /**
   * Bech32m CKB address for the derived key.
   * Null until secp256k1 address encoding is wired (Task D3).
   */
  address: string | null;
}

interface KeyvaultStore extends KeyvaultState {
  /**
   * Poll the main process for vault existence and update the store.
   * Call on mount to get the authoritative state.
   */
  refreshStatus: () => Promise<void>;
  /**
   * Generate a new BIP39 mnemonic, display it in a native dialog,
   * encrypt it, and persist it without sending words to the renderer.
   */
  createNew: (password: string) => Promise<void>;
  /**
   * Import recovery words from the main-process clipboard into the vault.
   * Sets `exists=true` and `lockArgs` on success.
   */
  importMnemonic: (password: string) => Promise<void>;
  /**
   * Permanently delete the keyvault blob from disk.
   * Clears `exists`, `lockArgs`, and `address` in the store.
   */
  deleteVault: (password: string) => Promise<void>;
}

const VAULT_ID = "main";

export const useKeyvaultStore = create<KeyvaultStore>()((set) => ({
  exists: false,
  lockArgs: null,
  address: null,

  refreshStatus: async () => {
    const { exists } = await getBridge().status();
    set(exists ? { exists } : { exists, lockArgs: null, address: null });
  },

  createNew: async (password) => {
    const result = await getBridge().create(password);
    set({ exists: true, lockArgs: result.lockArgs });
  },

  importMnemonic: async (password) => {
    const result = await getBridge().import(password);
    set({ exists: true, lockArgs: result.lockArgs });
  },

  deleteVault: async (password) => {
    await getBridge().delete(VAULT_ID, password);
    set({ exists: false, lockArgs: null, address: null });
  },
}));
