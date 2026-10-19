import { useEffect, useState } from "react";
import { useKeyvaultStore } from "./keyvault-store";
import { ReceivePanel } from "./ReceivePanel";
import { buildKeystoreSource } from "./keystore-source";
import { useNetworkConfigStore } from "@/stores/network-config";
import { useSourcesStore } from "@/stores/sources";
import { resolveSecp256k1ScriptInfo } from "@/lib/chains/ckb/secp256k1-lock";
import { lightClient } from "@/lib/light-client/client";

// ---------------------------------------------------------------------------
// Password entropy meter (client-side heuristic — no IPC)
// ---------------------------------------------------------------------------

function estimateEntropyBits(password: string): number {
  if (password.length === 0) return 0;
  let charset = 0;
  if (/[a-z]/.test(password)) charset += 26;
  if (/[A-Z]/.test(password)) charset += 26;
  if (/[0-9]/.test(password)) charset += 10;
  if (/[^a-zA-Z0-9]/.test(password)) charset += 33;
  return Math.floor(password.length * Math.log2(Math.max(charset, 1)));
}

function entropyLabel(bits: number): { label: string; color: string } {
  if (bits < 40) return { label: "Weak", color: "text-danger" };
  if (bits < 60) return { label: "Moderate", color: "text-warn" };
  return { label: "Strong", color: "text-green-400" };
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface PasswordFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
}

function PasswordField({ id, label, value, onChange, autoFocus }: PasswordFieldProps) {
  const bits = estimateEntropyBits(value);
  const { label: strengthLabel, color } = entropyLabel(bits);
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm text-fg-muted">
        {label}
      </label>
      <input
        id={id}
        type="password"
        autoComplete="new-password"
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-surface-hi bg-bg px-3 py-2 text-sm font-mono outline-none focus:border-accent"
      />
      {value.length > 0 && (
        <p className={`text-xs ${color}`}>
          Strength: {strengthLabel} ({bits} bits)
        </p>
      )}
    </div>
  );
}

interface ErrorBannerProps {
  message: string;
}

function ErrorBanner({ message }: ErrorBannerProps) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-danger/40 bg-danger/5 p-3 text-sm text-danger"
    >
      {message}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel modes
// ---------------------------------------------------------------------------

type PanelMode = "idle" | "creating" | "importing" | "active";

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

/**
 * Keyvault setup panel: create a new local keystore, import an existing
 * mnemonic, or manage an existing vault.
 *
 * Recovery words are displayed by Electron main in a native dialog and never
 * enter this component, the Zustand store, or the app renderer's IPC bridge.
 */
export function KeyvaultSetupPanel() {
  const { exists, lockArgs, refreshStatus, createNew, importMnemonic, deleteVault } =
    useKeyvaultStore();

  const [mode, setMode] = useState<PanelMode>(exists ? "active" : "idle");
  const [password, setPassword] = useState("");
  const [exportPassword, setExportPassword] = useState("");
  const [showExport, setShowExport] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [addingSource, setAddingSource] = useState(false);
  const [addedSource, setAddedSource] = useState(false);
  const network = useNetworkConfigStore((s) => s.network);

  // Sync mode when `exists` changes (e.g. after refreshStatus on mount).
  useEffect(() => {
    if (exists) {
      setMode("active");
    }
    if (!exists && mode === "active") {
      setMode("idle");
    }
  }, [exists, mode]);

  // Refresh vault status on mount so the panel reflects disk state.
  useEffect(() => {
    void refreshStatus().catch(() => {
      // Non-fatal: IPC unavailable in test/dev; start state is already `false`.
    });
  }, [refreshStatus]);

  // ---------------------------------------------------------------------------
  // Action handlers
  // ---------------------------------------------------------------------------

  function clearFormState(): void {
    setPassword("");
    setError(null);
    setLoading(false);
  }

  async function handleCreate(): Promise<void> {
    setError(null);
    setLoading(true);
    try {
      await createNew(password);
      setPassword("");
      setMode("active");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Wallet creation failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleImport(): Promise<void> {
    setError(null);
    setLoading(true);
    try {
      await importMnemonic(password);
      clearFormState();
      setMode("active");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Mnemonic import failed");
      setLoading(false);
    }
  }

  async function handleExport(): Promise<void> {
    setError(null);
    setExporting(true);
    try {
      await window.chainpay.keyvault.export("main", exportPassword);
      setExportPassword("");
      setShowExport(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Recovery word export failed");
    } finally {
      setExporting(false);
    }
  }

  async function handleDelete(): Promise<void> {
    setError(null);
    try {
      await deleteVault(deletePassword);
      setDeletePassword("");
      setDeleteConfirm(false);
      setMode("idle");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  }

  /**
   * Promote this keystore into a secp256k1 send source: build the Source from
   * the derived lock-args, register it, and tell the light client to sync the
   * lock (so SendPanel sees its balance and can spend its cells).
   */
  async function handleUseAsSource(): Promise<void> {
    if (!lockArgs) return;
    setError(null);
    setAddingSource(true);
    try {
      const scriptInfo = await resolveSecp256k1ScriptInfo(network);
      const { source, lock } = buildKeystoreSource(lockArgs, network, scriptInfo);
      useSourcesStore.getState().addSource(source);
      // Fresh wallet → watch from near the tip, not genesis, so the funded
      // balance is found quickly (SendPanel's affordability reads it).
      await lightClient().watchLockScriptFromRecent(lock);
      setAddedSource(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add source");
    } finally {
      setAddingSource(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const wrapper = (children: React.ReactNode): React.ReactElement => (
    <section className="rounded-lg border border-surface-hi bg-surface p-5">
      <h2 className="mb-4 text-lg font-semibold">Local wallet</h2>
      {children}
    </section>
  );

  // — Idle: no wallet yet —
  if (mode === "idle") {
    return wrapper(
      <div className="space-y-4">
        <p className="text-sm text-fg-muted">
          Create a password-protected BIP39 secp256k1 wallet stored on this device. The seed is
          encrypted by the Electron main process — your private key never touches the renderer.
        </p>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => { clearFormState(); setMode("creating"); }}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:opacity-90"
          >
            Create new wallet
          </button>
          <button
            type="button"
            onClick={() => { clearFormState(); setMode("importing"); }}
            className="rounded-md border border-surface-hi bg-bg px-4 py-2 text-sm font-medium hover:opacity-90"
          >
            Import mnemonic
          </button>
        </div>
        {error && <ErrorBanner message={error} />}
      </div>,
    );
  }

  // — Create flow: password entry —
  if (mode === "creating") {
    return wrapper(
      <div className="space-y-4">
        <p className="text-sm text-fg-muted">
          Choose a strong password. This encrypts your seed — you will need it every time you
          sign a transaction.
        </p>
        <PasswordField
          id="kv-create-password"
          label="Wallet password"
          value={password}
          onChange={setPassword}
          autoFocus
        />
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={loading || password.length < 8}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:opacity-90 disabled:opacity-50"
          >
            {loading ? "Creating…" : "Create wallet"}
          </button>
          <button
            type="button"
            onClick={() => { clearFormState(); setMode("idle"); }}
            className="rounded-md border border-surface-hi bg-bg px-4 py-2 text-sm font-medium hover:opacity-90"
          >
            Cancel
          </button>
        </div>
        {error && <ErrorBanner message={error} />}
      </div>,
    );
  }

  // — Import flow —
  if (mode === "importing") {
    return wrapper(
      <div className="space-y-4">
        <p className="text-sm text-fg-muted">
          Copy your 12- or 24-word recovery phrase, then choose a password. ChainPay reads
          and clears the current clipboard in the Electron main process when you import.
          Clipboard history maintained by your operating system may retain an earlier copy.
        </p>
        <PasswordField
          id="kv-import-password"
          label="Wallet password"
          value={password}
          onChange={setPassword}
        />
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => void handleImport()}
            disabled={loading || password.length < 8}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:opacity-90 disabled:opacity-50"
          >
            {loading ? "Importing…" : "Import from clipboard"}
          </button>
          <button
            type="button"
            onClick={() => { clearFormState(); setMode("idle"); }}
            className="rounded-md border border-surface-hi bg-bg px-4 py-2 text-sm font-medium hover:opacity-90"
          >
            Cancel
          </button>
        </div>
        {error && <ErrorBanner message={error} />}
      </div>,
    );
  }

  // — Active: wallet exists —
  return wrapper(
    <div className="space-y-4">
      {/* Receive / Fund panel: address + QR + live balance */}
      {lockArgs && <ReceivePanel lockArgs={lockArgs} />}

      {/* Lock args (technical detail, below the user-facing panel) */}
      <div className="rounded-lg border border-surface-hi bg-bg p-4 text-sm">
        <div className="text-xs uppercase tracking-wide text-fg-muted">Lock args (blake160)</div>
        <div className="mt-1 break-all font-mono text-xs text-accent">
          {lockArgs ?? "—"}
        </div>
      </div>

      {error && <ErrorBanner message={error} />}

      {showExport ? (
        <div className="space-y-3 rounded-lg border border-surface-hi bg-bg p-4">
          <p className="text-sm text-fg-muted">
            Enter your wallet password to show recovery words in a native dialog.
          </p>
          <PasswordField
            id="kv-export-password"
            label="Wallet password"
            value={exportPassword}
            onChange={setExportPassword}
          />
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => void handleExport()}
              disabled={exporting || exportPassword.length === 0}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:opacity-90 disabled:opacity-50"
            >
              {exporting ? "Opening…" : "Show recovery words"}
            </button>
            <button
              type="button"
              onClick={() => { setExportPassword(""); setShowExport(false); }}
              className="rounded-md border border-surface-hi px-4 py-2 text-sm font-medium hover:opacity-90"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setShowExport(true)}
          className="rounded-md border border-surface-hi bg-bg px-4 py-2 text-sm font-medium hover:opacity-90"
        >
          Back up recovery words
        </button>
      )}

      {/* Promote this keystore into a send source wallet */}
      {addedSource ? (
        <div
          role="status"
          className="rounded-lg border border-green-500/40 bg-green-500/5 p-3 text-sm text-green-400"
        >
          ✓ Added to your source wallets. Open the <strong>Send</strong> page to pay from it.
        </div>
      ) : (
        <button
          type="button"
          onClick={() => void handleUseAsSource()}
          disabled={!lockArgs || addingSource}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:opacity-90 disabled:opacity-50"
        >
          {addingSource ? "Adding…" : "Use as send source"}
        </button>
      )}

      {!deleteConfirm ? (
        <button
          type="button"
          onClick={() => setDeleteConfirm(true)}
          className="rounded-md border border-danger/40 bg-danger/5 px-3 py-1 text-xs text-danger hover:opacity-90"
        >
          Delete wallet
        </button>
      ) : (
        <div className="space-y-2 rounded-lg border border-danger/40 bg-danger/5 p-3 text-sm">
          <p className="text-danger">
            This permanently deletes the encrypted vault from disk. The seed cannot be recovered
            without your mnemonic backup.
          </p>
          <PasswordField
            id="kv-delete-password"
            label="Wallet password"
            value={deletePassword}
            onChange={setDeletePassword}
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void handleDelete()}
              disabled={deletePassword.length === 0}
              className="rounded-md bg-danger px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
            >
              Yes, delete
            </button>
            <button
              type="button"
              onClick={() => { setDeletePassword(""); setDeleteConfirm(false); }}
              className="rounded-md border border-surface-hi bg-bg px-3 py-1 text-xs"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>,
  );
}
