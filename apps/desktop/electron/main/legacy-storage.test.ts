import { beforeEach, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import { MemoryStorage } from "@/stores/test-utils/memory-storage";

const { windows, FakeBrowserWindow } = vi.hoisted(() => {
  const windows: object[] = [];
  class FakeBrowserWindow {
    constructor() { Object.assign(this, windows.shift()); }
  }
  return { windows, FakeBrowserWindow };
});
vi.mock("electron", () => ({
  app: { getAppPath: () => "/bundled-app" },
  BrowserWindow: FakeBrowserWindow,
}));

function fakeWindow(storage: Storage) {
  return {
    loadURL: vi.fn().mockResolvedValue(undefined),
    loadFile: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn(),
    webContents: {
      executeJavaScript: vi.fn(async (code: string) => runInNewContext(code, {
        localStorage: storage,
        atob,
        TextDecoder,
        Uint8Array,
      })),
    },
  };
}

beforeEach(() => { windows.length = 0; });

it("copies only ChainPay file-origin values before the new renderer hydrates", async () => {
  const oldStorage = new MemoryStorage();
  oldStorage.setItem("chain-pay:treasuries", "old-treasury");
  oldStorage.setItem("chainpay.ckb.lc.secret-key.testnet", "old-light-client-key");
  oldStorage.setItem("chain-pay:file-origin-import-v1", "done");
  oldStorage.setItem("unrelated", "do-not-copy");
  const newStorage = new MemoryStorage();
  newStorage.setItem("chain-pay:treasuries", "newer-treasury");
  const destination = fakeWindow(newStorage);
  const source = fakeWindow(oldStorage);
  windows.push(destination, source);

  const { migrateLegacyFileStorage } = await import("./legacy-storage");
  expect(await migrateLegacyFileStorage("http://127.0.0.1:30303")).toBe(1);
  expect(destination.loadURL).toHaveBeenCalledWith("http://127.0.0.1:30303/__storage_migration__");
  expect(source.loadFile).toHaveBeenCalledWith("/bundled-app/resources/legacy-storage.html");
  expect(newStorage.getItem("chain-pay:treasuries")).toBe("newer-treasury");
  expect(newStorage.getItem("chainpay.ckb.lc.secret-key.testnet")).toBe("old-light-client-key");
  expect(newStorage.getItem("unrelated")).toBeNull();
  expect(newStorage.getItem("chain-pay:file-origin-import-v1")).toBe("done");
  expect(source.destroy).toHaveBeenCalled();
  expect(destination.destroy).toHaveBeenCalled();
});

it("skips the legacy file window after a completed migration", async () => {
  const storage = new MemoryStorage();
  storage.setItem("chain-pay:file-origin-import-v1", "done");
  const destination = fakeWindow(storage);
  windows.push(destination);

  const { migrateLegacyFileStorage } = await import("./legacy-storage");
  expect(await migrateLegacyFileStorage("http://127.0.0.1:30303")).toBe(0);
  expect(windows).toHaveLength(0);
  expect(destination.destroy).toHaveBeenCalled();
});
