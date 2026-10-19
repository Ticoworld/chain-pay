import { beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { handlers, showMessageBox, readText, clear } = vi.hoisted(() => ({
  handlers: new Map<string, (_event: unknown, request?: unknown) => unknown>(),
  showMessageBox: vi.fn(async (_options: { message: string }) => ({ response: 0, checkboxChecked: false })),
  readText: vi.fn(async () => ""),
  clear: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, handler: (_event: unknown, request?: unknown) => unknown) => {
    handlers.set(channel, handler);
  } },
  dialog: { showMessageBox },
  clipboard: { readText, clear },
}));

import * as wasm from "../../../../packages/ckb-keyvault-wasm/pkg/ckb_keyvault_wasm.js";
import { KEYVAULT_CHANNELS } from "@shared/keyvault-ipc";
import { KeyvaultStore } from "./keyvault-store";
import { registerKeyvaultHost } from "./keyvault-host";

beforeEach(() => {
  handlers.clear();
  showMessageBox.mockClear();
  readText.mockReset();
  clear.mockClear();
});

it("shows new recovery words in a native dialog and returns only public vault data", async () => {
  const store = new KeyvaultStore(mkdtempSync(join(tmpdir(), "kv-recovery-")));
  registerKeyvaultHost({ store, wasm });
  const create = handlers.get(KEYVAULT_CHANNELS.create)!;

  const result = await create({}, { password: "DisposableSmoke!2026" }) as Record<string, unknown>;

  expect(Object.keys(result).sort()).toEqual(["id", "lockArgs"]);
  expect(result.lockArgs).toEqual(expect.stringMatching(/^0x[0-9a-f]{40}$/));
  expect(showMessageBox).toHaveBeenCalledOnce();
  const options = showMessageBox.mock.calls[0]?.[0] as { message: string };
  expect(options.message.trim().split(/\s+/)).toHaveLength(12);
});

it("shows exported recovery words in a native dialog without returning them over IPC", async () => {
  const store = new KeyvaultStore(mkdtempSync(join(tmpdir(), "kv-recovery-")));
  registerKeyvaultHost({ store, wasm });
  const create = handlers.get(KEYVAULT_CHANNELS.create)!;
  const exportWords = handlers.get(KEYVAULT_CHANNELS.export)!;
  await create({}, { password: "DisposableSmoke!2026" });

  const result = await exportWords({}, { keyvaultId: "main", password: "DisposableSmoke!2026" });

  expect(result).toEqual({ ok: true });
  expect(showMessageBox).toHaveBeenCalledTimes(2);
  const createOptions = showMessageBox.mock.calls[0]?.[0] as { message: string };
  const exportOptions = showMessageBox.mock.calls[1]?.[0] as { message: string };
  expect(exportOptions.message).toBe(createOptions.message);
});

it("imports recovery words from the main-process clipboard and clears it before deriving", async () => {
  const store = new KeyvaultStore(mkdtempSync(join(tmpdir(), "kv-recovery-")));
  readText.mockResolvedValue("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about");
  registerKeyvaultHost({ store, wasm });
  const importWords = handlers.get(KEYVAULT_CHANNELS.import)!;

  await expect(importWords({}, {
    password: "DisposableSmoke!2026",
    mnemonic: "renderer must not send words",
  })).rejects.toThrow();
  expect(readText).not.toHaveBeenCalled();

  const result = await importWords({}, { password: "DisposableSmoke!2026" }) as Record<string, unknown>;

  expect(Object.keys(result).sort()).toEqual(["id", "lockArgs"]);
  expect(clear).toHaveBeenCalledOnce();
  expect(store.has("main")).toBe(true);
});

it("clears invalid recovery words before rejecting the import", async () => {
  const store = new KeyvaultStore(mkdtempSync(join(tmpdir(), "kv-recovery-")));
  readText.mockResolvedValue("invalid recovery words");
  registerKeyvaultHost({ store, wasm });

  await expect(handlers.get(KEYVAULT_CHANNELS.import)!({}, {
    password: "DisposableSmoke!2026",
  })).rejects.toThrow(/invalid BIP39 mnemonic/i);

  expect(clear).toHaveBeenCalledOnce();
  expect(store.has("main")).toBe(false);
});

it("clears the clipboard when reading it fails", async () => {
  const store = new KeyvaultStore(mkdtempSync(join(tmpdir(), "kv-recovery-")));
  readText.mockRejectedValue(new Error("clipboard unavailable"));
  registerKeyvaultHost({ store, wasm });

  await expect(handlers.get(KEYVAULT_CHANNELS.import)!({}, {
    password: "DisposableSmoke!2026",
  })).rejects.toThrow("clipboard unavailable");

  expect(clear).toHaveBeenCalledOnce();
  expect(store.has("main")).toBe(false);
});

it("refuses to replace an existing encrypted vault through create or import", async () => {
  const store = new KeyvaultStore(mkdtempSync(join(tmpdir(), "kv-recovery-")));
  registerKeyvaultHost({ store, wasm });
  const create = handlers.get(KEYVAULT_CHANNELS.create)!;
  const importWords = handlers.get(KEYVAULT_CHANNELS.import)!;
  const original = await create({}, { password: "DisposableSmoke!2026" }) as { lockArgs: string };

  await expect(create({}, { password: "DisposableSmoke!2027" })).rejects.toThrow(/already exists/i);
  await expect(importWords({}, { password: "DisposableSmoke!2027" })).rejects.toThrow(/already exists/i);
  expect(showMessageBox).toHaveBeenCalledOnce();
  expect(readText).not.toHaveBeenCalled();
  expect(store.has("main")).toBe(true);
  expect(original.lockArgs).toMatch(/^0x[0-9a-f]{40}$/);
});

it("requires the vault password before deleting its encrypted blob", async () => {
  const store = new KeyvaultStore(mkdtempSync(join(tmpdir(), "kv-recovery-")));
  registerKeyvaultHost({ store, wasm });
  const create = handlers.get(KEYVAULT_CHANNELS.create)!;
  const remove = handlers.get(KEYVAULT_CHANNELS.delete)!;
  await create({}, { password: "DisposableSmoke!2026" });

  expect(() => remove({}, { keyvaultId: "main", password: "wrong" })).toThrow();
  expect(store.has("main")).toBe(true);
  expect(await remove({}, { keyvaultId: "main", password: "DisposableSmoke!2026" })).toEqual({ ok: true });
  expect(store.has("main")).toBe(false);
});
