// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ScriptInfo } from "@ckb-ccc/core";
import { KeyvaultSetupPanel } from "./KeyvaultSetupPanel";
import { useKeyvaultStore } from "./keyvault-store";
import { useNetworkConfigStore } from "@/stores/network-config";
import { useSourcesStore } from "@/stores/sources";
import { lightClient } from "@/lib/light-client/client";

// ---------------------------------------------------------------------------
// Mock heavy async dependencies used by ReceivePanel when rendered in active mode.
// ---------------------------------------------------------------------------

vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,mockqr") },
}));

vi.mock("@/lib/chains/ckb/secp256k1-lock", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/chains/ckb/secp256k1-lock")>();
  return {
    ...original,
    resolveSecp256k1ScriptInfo: vi.fn().mockResolvedValue(
      ScriptInfo.from({
        // secp256k1_blake160_sighash_all code hash (testnet / mainnet same)
        codeHash: "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8",
        hashType: "type",
        cellDeps: [
          {
            cellDep: {
              outPoint: {
                txHash:
                  "0xf8de3bb47d055cdf460d93a2a6e1b05f7432f9777c8c474abf4eec1d4aee5d37",
                index: 0,
              },
              depType: "depGroup",
            },
          },
        ],
      }),
    ),
  };
});

// Stub the light-client so balance fetches don't hit real IPC.
vi.mock("@/lib/light-client/client", () => ({
  lightClient: vi.fn().mockReturnValue({
    watchLockScript: vi.fn().mockResolvedValue(undefined),
    watchLockScriptFromRecent: vi.fn().mockResolvedValue(undefined),
    getLockBalance: vi.fn().mockResolvedValue(0n),
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LOCK_ARGS = "0x" + "ab".repeat(20);
function makeMockBridge(opts?: {
  statusExists?: boolean;
  createLockArgs?: string;
  importLockArgs?: string;
  createReject?: Error;
  importReject?: Error;
}) {
  return {
    status: vi.fn().mockResolvedValue({ exists: opts?.statusExists ?? false }),
    create: opts?.createReject
      ? vi.fn().mockRejectedValue(opts.createReject)
      : vi.fn().mockResolvedValue({
          id: "main",
          lockArgs: opts?.createLockArgs ?? LOCK_ARGS,
        }),
    import: opts?.importReject
      ? vi.fn().mockRejectedValue(opts.importReject)
      : vi.fn().mockResolvedValue({ id: "main", lockArgs: opts?.importLockArgs ?? LOCK_ARGS }),
    export: vi.fn().mockResolvedValue({ ok: true }),
    delete: vi.fn().mockResolvedValue({ ok: true }),
  };
}

function mountBridge(bridge: ReturnType<typeof makeMockBridge>): void {
  // In jsdom the global IS window — patch chainpay directly rather than
  // replacing the entire window object (which would break document / waitFor).
  (globalThis as Record<string, unknown>)["chainpay"] = { keyvault: bridge };
}

function resetStore(): void {
  useKeyvaultStore.setState({ exists: false, lockArgs: null, address: null });
}

function seedActiveStore(): void {
  useKeyvaultStore.setState({ exists: true, lockArgs: LOCK_ARGS, address: null });
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  mountBridge(makeMockBridge());
  resetStore();
});

afterEach(() => {
  cleanup();
  resetStore();
  delete (globalThis as Record<string, unknown>)["chainpay"];
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("KeyvaultSetupPanel — idle state (no wallet)", () => {
  it("shows Create and Import buttons when no vault exists", () => {
    render(<KeyvaultSetupPanel />);
    expect(screen.getByRole("button", { name: /create new wallet/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /import mnemonic/i })).toBeInTheDocument();
  });

  it("does NOT show the lock-args box in idle state", () => {
    render(<KeyvaultSetupPanel />);
    expect(screen.queryByText(/lock args/i)).not.toBeInTheDocument();
  });
});

describe("KeyvaultSetupPanel — create flow", () => {
  it("transitions to password form on Create click", () => {
    render(<KeyvaultSetupPanel />);
    fireEvent.click(screen.getByRole("button", { name: /create new wallet/i }));
    expect(screen.getByLabelText(/wallet password/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create wallet/i })).toBeInTheDocument();
  });

  it("disables Create wallet button until password is ≥8 chars", () => {
    render(<KeyvaultSetupPanel />);
    fireEvent.click(screen.getByRole("button", { name: /create new wallet/i }));
    const createBtn = screen.getByRole("button", { name: /create wallet/i });

    fireEvent.change(screen.getByLabelText(/wallet password/i), { target: { value: "short" } });
    expect(createBtn).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/wallet password/i), {
      target: { value: "longenough!" },
    });
    expect(createBtn).not.toBeDisabled();
  });

  it("shows entropy strength label as the user types", () => {
    render(<KeyvaultSetupPanel />);
    fireEvent.click(screen.getByRole("button", { name: /create new wallet/i }));
    fireEvent.change(screen.getByLabelText(/wallet password/i), {
      target: { value: "abc" },
    });
    // Strength label should be visible
    expect(screen.getByText(/strength:/i)).toBeInTheDocument();
  });

  it("transitions to active without placing recovery words in the renderer", async () => {
    render(<KeyvaultSetupPanel />);
    fireEvent.click(screen.getByRole("button", { name: /create new wallet/i }));
    fireEvent.change(screen.getByLabelText(/wallet password/i), {
      target: { value: "strongPass!1" },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /create wallet/i }));
    });

    await waitFor(() => expect(screen.getByText(/lock args/i)).toBeInTheDocument());
    expect(screen.queryByRole("list", { name: /recovery mnemonic/i })).not.toBeInTheDocument();
  });

  it("keeps the wallet password and recovery words out of the active panel", async () => {
    render(<KeyvaultSetupPanel />);
    fireEvent.click(screen.getByRole("button", { name: /create new wallet/i }));
    fireEvent.change(screen.getByLabelText(/wallet password/i), {
      target: { value: "strongPass!1" },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /create wallet/i }));
    });

    await waitFor(() => expect(screen.getByText(/lock args/i)).toBeInTheDocument());
    expect(screen.queryByRole("list", { name: /recovery mnemonic/i })).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("strongPass!1")).not.toBeInTheDocument();
  });

  it("shows an error banner when createNew rejects", async () => {
    const bridge = makeMockBridge({ createReject: new Error("wrong password format") });
    mountBridge(bridge);
    render(<KeyvaultSetupPanel />);
    fireEvent.click(screen.getByRole("button", { name: /create new wallet/i }));
    fireEvent.change(screen.getByLabelText(/wallet password/i), {
      target: { value: "strongPass!1" },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /create wallet/i }));
    });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(screen.getByText(/wrong password format/i)).toBeInTheDocument();
    });
  });
});

describe("KeyvaultSetupPanel — import flow", () => {
  it("transitions to import form on Import click", () => {
    render(<KeyvaultSetupPanel />);
    fireEvent.click(screen.getByRole("button", { name: /import mnemonic/i }));
    expect(screen.getByText(/clears the current clipboard/i)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByLabelText(/wallet password/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /import from clipboard/i })).toBeInTheDocument();
  });

  it("disables Import button until the password is filled", () => {
    render(<KeyvaultSetupPanel />);
    fireEvent.click(screen.getByRole("button", { name: /import mnemonic/i }));
    const importBtn = screen.getByRole("button", { name: /import from clipboard/i });
    expect(importBtn).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/wallet password/i), {
      target: { value: "myPassword1!" },
    });
    expect(importBtn).not.toBeDisabled();
  });

  it("calls importMnemonic on the store and transitions to active", async () => {
    render(<KeyvaultSetupPanel />);
    fireEvent.click(screen.getByRole("button", { name: /import mnemonic/i }));
    fireEvent.change(screen.getByLabelText(/wallet password/i), {
      target: { value: "myPassword1!" },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /import from clipboard/i }));
    });

    await waitFor(() => {
      expect(screen.getByText(/lock args/i)).toBeInTheDocument();
    });
    expect(useKeyvaultStore.getState().exists).toBe(true);
    expect(useKeyvaultStore.getState().lockArgs).toBe(LOCK_ARGS);
  });

  it("shows an error banner when import rejects", async () => {
    const bridge = makeMockBridge({ importReject: new Error("invalid mnemonic") });
    mountBridge(bridge);
    render(<KeyvaultSetupPanel />);
    fireEvent.click(screen.getByRole("button", { name: /import mnemonic/i }));
    fireEvent.change(screen.getByLabelText(/wallet password/i), {
      target: { value: "myPassword1!" },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /import from clipboard/i }));
    });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(screen.getByText(/invalid mnemonic/i)).toBeInTheDocument();
    });
  });

  it("Cancel returns to idle from import flow", () => {
    render(<KeyvaultSetupPanel />);
    fireEvent.click(screen.getByRole("button", { name: /import mnemonic/i }));
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(screen.getByRole("button", { name: /create new wallet/i })).toBeInTheDocument();
  });
});

describe("KeyvaultSetupPanel — active state", () => {
  it("renders lock-args when vault exists in store", () => {
    seedActiveStore();
    render(<KeyvaultSetupPanel />);
    expect(screen.getByText(/lock args/i)).toBeInTheDocument();
    expect(screen.getByText(LOCK_ARGS)).toBeInTheDocument();
  });

  it("opens recovery words through the main-process bridge without rendering them", async () => {
    const bridge = makeMockBridge();
    mountBridge(bridge);
    seedActiveStore();
    render(<KeyvaultSetupPanel />);
    fireEvent.click(screen.getByRole("button", { name: /back up recovery words/i }));
    fireEvent.change(screen.getByLabelText(/wallet password/i), {
      target: { value: "strongPass!1" },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /show recovery words/i }));
    });

    expect(bridge.export).toHaveBeenCalledWith("main", "strongPass!1");
    expect(screen.queryByRole("list", { name: /recovery mnemonic/i })).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("strongPass!1")).not.toBeInTheDocument();
  });

  it("shows delete confirmation flow", async () => {
    seedActiveStore();
    render(<KeyvaultSetupPanel />);
    fireEvent.click(screen.getByRole("button", { name: /delete wallet/i }));
    expect(screen.getByRole("button", { name: /yes, delete/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /yes, delete/i })).toBeDisabled();
    expect(screen.getByLabelText(/wallet password/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
  });

  it("calls deleteVault and returns to idle on confirm", async () => {
    seedActiveStore();
    render(<KeyvaultSetupPanel />);
    fireEvent.click(screen.getByRole("button", { name: /delete wallet/i }));
    fireEvent.change(screen.getByLabelText(/wallet password/i), {
      target: { value: "walletPassword" },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /yes, delete/i }));
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /create new wallet/i })).toBeInTheDocument();
    });
    expect(useKeyvaultStore.getState().exists).toBe(false);
  });

  it("Cancel from delete confirmation stays in active state", () => {
    seedActiveStore();
    render(<KeyvaultSetupPanel />);
    fireEvent.click(screen.getByRole("button", { name: /delete wallet/i }));
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    // Still on active view
    expect(screen.getByText(/lock args/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /yes, delete/i })).not.toBeInTheDocument();
  });

  it("renders ReceivePanel (Fund this wallet heading) once the wallet is active", async () => {
    useNetworkConfigStore.setState({ network: "testnet", broadcastRpcUrl: "" });
    // Bridge must confirm exists:true so refreshStatus() doesn't reset the store.
    mountBridge(makeMockBridge({ statusExists: true, createLockArgs: LOCK_ARGS }));
    seedActiveStore();
    render(<KeyvaultSetupPanel />);

    // ReceivePanel should resolve scriptInfo (mocked) and render its heading.
    await waitFor(() => {
      expect(screen.getByText(/fund this wallet/i)).toBeInTheDocument();
    });
  });

  it("renders the Copy address button once ReceivePanel has resolved the address", async () => {
    useNetworkConfigStore.setState({ network: "testnet", broadcastRpcUrl: "" });
    mountBridge(makeMockBridge({ statusExists: true, createLockArgs: LOCK_ARGS }));
    seedActiveStore();
    render(<KeyvaultSetupPanel />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /copy address/i })).toBeInTheDocument();
    });
  });
});

describe("KeyvaultSetupPanel — use as send source", () => {
  beforeEach(() => {
    useSourcesStore.setState({ sources: [], activeSourceId: null });
    useNetworkConfigStore.setState({ network: "testnet", broadcastRpcUrl: "" });
    vi.clearAllMocks();
  });
  afterEach(() => {
    useSourcesStore.setState({ sources: [], activeSourceId: null });
  });

  it("adds a secp256k1 source and watches its lock when clicked", async () => {
    mountBridge(makeMockBridge({ statusExists: true, createLockArgs: LOCK_ARGS }));
    seedActiveStore();
    render(<KeyvaultSetupPanel />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /use as send source/i }));
    });

    await waitFor(() => {
      expect(useSourcesStore.getState().sources).toHaveLength(1);
    });
    const src = useSourcesStore.getState().sources[0]!;
    expect(src.lockKind).toBe("secp256k1");
    expect(src.keyvaultId).toBe("main");
    expect(src.derivationIndex).toBe(0);
    expect(src.joyidLockArgs).toBe(LOCK_ARGS);
    expect(src.address).toMatch(/^ckt1/);

    // The light client must be told to sync the new source's lock (fixes the
    // affordability false-"insufficient" bug — SendPanel reads its balance).
    // A fresh wallet watches from near the tip (recent), not genesis, so the
    // just-funded balance appears quickly. (ReceivePanel also watches the same
    // lock, so we assert on the lock that was watched, not an exact call count.)
    expect(lightClient().watchLockScriptFromRecent).toHaveBeenCalledWith(
      expect.objectContaining({ args: LOCK_ARGS }),
    );
    // A fresh wallet must NEVER be watched from genesis (the slow path that
    // left balances stuck at 0) — not by the panel, not by the source action.
    expect(lightClient().watchLockScript).not.toHaveBeenCalled();
  });

  it("shows a confirmation once the source has been added", async () => {
    mountBridge(makeMockBridge({ statusExists: true, createLockArgs: LOCK_ARGS }));
    seedActiveStore();
    render(<KeyvaultSetupPanel />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /use as send source/i }));
    });

    await waitFor(() => {
      expect(screen.getByText(/added to your source wallets/i)).toBeInTheDocument();
    });
  });
});
