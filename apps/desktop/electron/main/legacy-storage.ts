import { app, BrowserWindow } from "electron";
import { join } from "node:path";

const MARKER = "chain-pay:file-origin-import-v1";
const LEGACY_PREFIXES = ["chain-pay:", "chainpay.ckb.lc.secret-key."];

function assertLegacyEntries(value: unknown): [string, string][] {
  if (!Array.isArray(value)) throw new Error("Legacy storage response is invalid");
  return value.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2 ||
        typeof entry[0] !== "string" || typeof entry[1] !== "string" ||
        entry[0] === MARKER || !LEGACY_PREFIXES.some((prefix) => entry[0].startsWith(prefix))) {
      throw new Error("Legacy storage entry is invalid");
    }
    return [entry[0], entry[1]];
  });
}

function hiddenWindow(): BrowserWindow {
  return new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
}

/** Copy app state from Electron 33's file origin before the localhost app hydrates. */
export async function migrateLegacyFileStorage(origin: string): Promise<number> {
  const destination = hiddenWindow();
  try {
    await destination.loadURL(`${origin}/__storage_migration__`);
    const done = await destination.webContents.executeJavaScript(
      `localStorage.getItem(${JSON.stringify(MARKER)}) === "done"`,
    ) as boolean;
    if (done) return 0;

    const source = hiddenWindow();
    let entries: [string, string][];
    try {
      await source.loadFile(join(app.getAppPath(), "resources/legacy-storage.html"));
      const raw = await source.webContents.executeJavaScript(`
        Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
          .filter((key) => key && key !== "${MARKER}" && ${JSON.stringify(LEGACY_PREFIXES)}.some((prefix) => key.startsWith(prefix)))
          .map((key) => [key, localStorage.getItem(key)])
      `) as unknown;
      entries = assertLegacyEntries(raw);
    } finally {
      source.destroy();
    }

    const payload = Buffer.from(JSON.stringify(entries), "utf8").toString("base64");
    const copied = await destination.webContents.executeJavaScript(`(() => {
      const bytes = Uint8Array.from(atob("${payload}"), (character) => character.charCodeAt(0));
      const entries = JSON.parse(new TextDecoder().decode(bytes));
      let copied = 0;
      for (const [key, value] of entries) {
        if (localStorage.getItem(key) !== null) continue;
        localStorage.setItem(key, value);
        if (localStorage.getItem(key) !== value) throw new Error("Storage migration verification failed");
        copied += 1;
      }
      localStorage.setItem("${MARKER}", "done");
      return copied;
    })()`) as number;
    return copied;
  } finally {
    destination.destroy();
  }
}
