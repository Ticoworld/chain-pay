import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Bridge mock shape aligned to window.chainpay.keyvault surface.
function makeMockBridge(overrides?: {
  statusExists?: boolean;
  lockArgs?: string;
}) {
  const lockArgs = overrides?.lockArgs ?? "0x" + "ab".repeat(20);

  return {
    status: vi.fn().mockResolvedValue({ exists: overrides?.statusExists ?? false }),
    create: vi.fn().mockResolvedValue({ id: "main", lockArgs }),
    import: vi.fn().mockResolvedValue({ id: "main", lockArgs }),
    delete: vi.fn().mockResolvedValue({ ok: true }),
  };
}

function mountBridge(bridge: ReturnType<typeof makeMockBridge>): void {
  // Match the pattern used in file-storage.test.ts and CommChannelSection.test.tsx
  (
    globalThis as unknown as {
      window: { chainpay: { keyvault: ReturnType<typeof makeMockBridge> } };
    }
  ).window = {
    chainpay: { keyvault: bridge },
  };
}

// Reset the Zustand store and clear the module so each test starts clean.
beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  // Remove the window stub so it doesn't bleed into other test files.
  delete (globalThis as { window?: unknown }).window;
});

describe("useKeyvaultStore", () => {
  it("starts with exists=false and null lockArgs / address", async () => {
    mountBridge(makeMockBridge());
    const { useKeyvaultStore } = await import("./keyvault-store");
    const s = useKeyvaultStore.getState();
    expect(s.exists).toBe(false);
    expect(s.lockArgs).toBeNull();
    expect(s.address).toBeNull();
  });

  describe("refreshStatus", () => {
    it("sets exists=true when vault is present on disk", async () => {
      mountBridge(makeMockBridge({ statusExists: true }));
      const { useKeyvaultStore } = await import("./keyvault-store");
      await useKeyvaultStore.getState().refreshStatus();
      expect(useKeyvaultStore.getState().exists).toBe(true);
    });

    it("clears lockArgs and address when vault is absent", async () => {
      mountBridge(makeMockBridge({ statusExists: false }));
      const { useKeyvaultStore } = await import("./keyvault-store");
      // Pre-seed with some lockArgs to verify they are cleared.
      useKeyvaultStore.setState({ exists: true, lockArgs: "0x" + "cc".repeat(20) });
      await useKeyvaultStore.getState().refreshStatus();
      expect(useKeyvaultStore.getState().exists).toBe(false);
      expect(useKeyvaultStore.getState().lockArgs).toBeNull();
    });
  });

  describe("importMnemonic", () => {
    it("marks exists=true and sets lockArgs after import", async () => {
      const lockArgs = "0x" + "ab".repeat(20);
      mountBridge(makeMockBridge({ lockArgs }));
      const { useKeyvaultStore } = await import("./keyvault-store");

      await useKeyvaultStore.getState().importMnemonic("password123");

      const s = useKeyvaultStore.getState();
      expect(s.exists).toBe(true);
      expect(s.lockArgs).toBe(lockArgs);
    });

    it("delegates only the password to the bridge", async () => {
      const bridge = makeMockBridge();
      mountBridge(bridge);
      const { useKeyvaultStore } = await import("./keyvault-store");

      await useKeyvaultStore.getState().importMnemonic("mypassword");

      expect(bridge.import).toHaveBeenCalledOnce();
      expect(bridge.import).toHaveBeenCalledWith("mypassword");
    });
  });

  describe("createNew", () => {
    it("marks exists=true and sets lockArgs after creation", async () => {
      const lockArgs = "0x" + "cd".repeat(20);
      mountBridge(makeMockBridge({ lockArgs }));
      const { useKeyvaultStore } = await import("./keyvault-store");

      await useKeyvaultStore.getState().createNew("strongPassword!");

      const s = useKeyvaultStore.getState();
      expect(s.exists).toBe(true);
      expect(s.lockArgs).toBe(lockArgs);
    });

    it("returns no recovery material to the caller or store", async () => {
      mountBridge(makeMockBridge());
      const { useKeyvaultStore } = await import("./keyvault-store");

      const result = await useKeyvaultStore.getState().createNew("pw");

      expect(result).toBeUndefined();
      expect(Object.keys(useKeyvaultStore.getState())).not.toContain("mnemonic");
    });
  });

  describe("deleteVault", () => {
    it("clears exists, lockArgs, and address after delete", async () => {
      const bridge = makeMockBridge();
      mountBridge(bridge);
      const { useKeyvaultStore } = await import("./keyvault-store");

      // Pre-seed as if a vault exists.
      useKeyvaultStore.setState({
        exists: true,
        lockArgs: "0x" + "dd".repeat(20),
        address: "ckt1someaddress",
      });

      await useKeyvaultStore.getState().deleteVault("walletPassword");

      const s = useKeyvaultStore.getState();
      expect(s.exists).toBe(false);
      expect(s.lockArgs).toBeNull();
      expect(s.address).toBeNull();
    });

    it("calls the bridge delete with the vault id and password", async () => {
      const bridge = makeMockBridge();
      mountBridge(bridge);
      const { useKeyvaultStore } = await import("./keyvault-store");

      await useKeyvaultStore.getState().deleteVault("walletPassword");

      expect(bridge.delete).toHaveBeenCalledOnce();
      expect(bridge.delete).toHaveBeenCalledWith("main", "walletPassword");
    });
  });
});
