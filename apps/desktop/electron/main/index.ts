import { app, BrowserWindow, ipcMain, session, shell } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
import {
  exists as commExists,
  publicInfo as commPublicInfo,
  generateIdentity,
  deleteIdentity,
  publishProfile,
  sendMessage,
  decryptIncoming,
  resolveProfile,
  setCurrentNetwork,
} from "./comm-transport-service";
import { registerAccountingIpc } from "./accounting-host";
import { registerInvoiceFilesIpc } from "./invoice-files-host";
import { loadNetworkState, saveNetworkState } from "./network-state-store";
import {
  initBiscuit,
  generateRootKeypair,
  issueCaptureV1Token,
  type RootKeypair,
} from "./pair-server-biscuit";
import { restartWithCert, startPairServer, stopPairServer } from "./pair-server";
import { loadOrCreateTlsCert, rotateTlsCert } from "./tls-cert-store";
import { addDevice, listDevices, revokeDevice } from "./pair-store";
import { getSafeStorage } from "./safe-storage";
import { KeyvaultStore } from "./keyvault-store";
import { registerKeyvaultHost } from "./keyvault-host";
import { registerBitcoinIpc } from "./bitcoin-host";
import { registerSolanaIpc } from "./solana-host";
import type { CkbNetwork } from "@/lib/light-client/network-configs";
import { rendererPortForProfile, startRendererServer } from "./renderer-protocol";

const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;
let rendererServer: Awaited<ReturnType<typeof startRendererServer>> | null = null;

let rootKeypairCache: RootKeypair | null = null;
let rootKeypairPromise: Promise<RootKeypair> | null = null;
let serverInfoCache: { certFingerprint: string; port: number } | null = null;

const PAIR_TOKEN_LIFETIME_MS = 30 * 86400_000;

async function loadOrCreateRootKeypair(): Promise<RootKeypair> {
  if (rootKeypairCache) return rootKeypairCache;
  if (rootKeypairPromise) return rootKeypairPromise;
  rootKeypairPromise = (async () => {
    const file = path.join(app.getPath("userData"), "biscuit-root.enc");
    const safe = getSafeStorage();
    try {
      const buf = await fs.readFile(file);
      const loaded = JSON.parse(safe.decrypt(buf)) as RootKeypair;
      rootKeypairCache = loaded;
      return loaded;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const kp = generateRootKeypair();
      await fs.writeFile(file, safe.encrypt(JSON.stringify(kp)));
      rootKeypairCache = kp;
      return kp;
    }
  })();
  try {
    return await rootKeypairPromise;
  } finally {
    rootKeypairPromise = null;
  }
}

async function bootPairServer(webContents: Electron.WebContents): Promise<void> {
  await initBiscuit();
  const root = await loadOrCreateRootKeypair();
  // publicInfo() returns PublicIdentity { mlDsaPub, mlKemPub, ... } | null.
  // The "comm pubkey" exposed for CEMP-PQ (future v2 path) is the ML-KEM key.
  const info = await commPublicInfo();
  const tlsCert = await loadOrCreateTlsCert();
  const started = await startPairServer({
    port: 8233,
    rootKeypair: root,
    appVersion: app.getVersion(),
    sendToRenderer: webContents,
    mdns: true,
    commPubkey: info?.mlKemPub ?? "0x" + "00".repeat(32),
    tlsCert: { key: tlsCert.key, cert: tlsCert.cert },
  });
  serverInfoCache = { certFingerprint: started.certFingerprint, port: started.port };
}

// 'wasm-unsafe-eval' is needed for WebAssembly.instantiate.
// blob: for the ckb-light-client-js workers, which esbuild inlines and spawns via blob URLs.
// In dev, 'unsafe-inline' is needed for Vite's HMR preamble script. Stripped in prod.
const scriptSrc = isDev
  ? "script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline' blob:"
  : "script-src 'self' 'wasm-unsafe-eval' blob:";

// connect-src needs `http:` because ChainPay points at user-configured local /
// LAN CKB nodes (e.g. http://192.168.68.134:8114 in dev, or a self-hosted
// full-node on the same machine). A desktop wallet's threat model differs
// from a browser-served page — there's no XSS surface that could exfil to an
// attacker-controlled HTTP endpoint. `https:` / `wss:` / `ws:` stay allowed
// for public testnet/mainnet RPCs.
const CSP = [
  "default-src 'self'",
  scriptSrc,
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' http: https: wss: ws: blob:",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
].join("; ");

function applyResponseHeaders(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Cross-Origin-Embedder-Policy": ["require-corp"],
        "Cross-Origin-Opener-Policy": ["same-origin"],
        "Content-Security-Policy": [CSP],
      },
    });
  });
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: "#0a0a0a",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const destination = new URL(url);
      if (destination.protocol === "https:" || destination.protocol === "http:") {
        void shell.openExternal(url).catch(() => undefined);
      }
    } catch {
      // Reject malformed destinations from the untrusted renderer.
    }
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowedOrigin = isDev && process.env.ELECTRON_RENDERER_URL
      ? new URL(process.env.ELECTRON_RENDERER_URL).origin
      : rendererServer?.origin;
    try {
      if (new URL(url).origin !== allowedOrigin) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());

  if (isDev) {
    mainWindow.webContents.on("console-message", (details) => {
      process.stdout.write(`[renderer ${details.level.toUpperCase()}] ${details.message} (${details.sourceId}:${details.lineNumber})\n`);
    });
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    rendererServer ??= await startRendererServer(
      join(__dirname, "../renderer"),
      CSP,
      rendererPortForProfile(app.getPath("userData")),
    );
    await mainWindow.loadURL(`${rendererServer.origin}/`);
  }
}

app.whenReady().then(async () => {
  applyResponseHeaders();

  // Load persisted network selection BEFORE creating the window or any
  // comm-transport call. setCurrentNetwork pins the module-level network
  // used by comm-transport for getClient(), MLDSASigner, and tx-builder.
  const bootNetwork = loadNetworkState();
  setCurrentNetwork(bootNetwork);

  await createWindow();

  // network handlers
  ipcMain.handle("network:get", (): CkbNetwork => loadNetworkState());
  ipcMain.handle("network:set", (_e, network: CkbNetwork): void => {
    saveNetworkState(network);
    // Don't update setCurrentNetwork here — renderer is committing to a
    // restart, so the in-memory client cache stays consistent until quit.
  });
  ipcMain.handle("lcStorage:clear", async (): Promise<void> => {
    await session.defaultSession.clearStorageData({ storages: ["indexdb"] });
  });
  ipcMain.handle("app:quit", (): void => {
    app.quit();
  });

  // comm-identity handlers
  ipcMain.handle("commIdentity:exists", () => commExists());
  ipcMain.handle("commIdentity:publicInfo", () => commPublicInfo());
  ipcMain.handle("commIdentity:generate", () => generateIdentity());
  ipcMain.handle("commIdentity:delete", () => deleteIdentity());

  // comm-transport handlers
  // Renderer currently sends the bare metadata object (legacy shape from Phase 2.7a/b).
  // Wrap into {metadata} so publishProfile receives the correct args shape.
  // Task 5/6 will later update the renderer to pass {metadata, network} explicitly.
  ipcMain.handle("commTransport:publishProfile", (_e, metadata) => publishProfile({ metadata }));
  ipcMain.handle(
    "commTransport:sendMessage",
    (_e, recipientAddress: string, envelopeBytesHex: string) => {
      const envelopeBytes = Uint8Array.from(Buffer.from(envelopeBytesHex.slice(2), "hex"));
      return sendMessage(recipientAddress, envelopeBytes);
    },
  );
  ipcMain.handle(
    "commTransport:decryptIncoming",
    (_e, messageOutPoint: { txHash: string; index: number }) => decryptIncoming(messageOutPoint),
  );
  ipcMain.handle("commTransport:resolveProfile", (_e, address: string) =>
    resolveProfile(address),
  );

  // accounting handlers (Frappe Slice C bridge — credentials stay in main process)
  registerAccountingIpc();
  registerBitcoinIpc();
  registerSolanaIpc();

  // keyvault host — encrypted BIP39 signer (single-sig SMB send path only).
  // The WASM pkg is a synchronous CJS module (wasm-pack --target nodejs).
  // In development the pkg lives in the workspace. The packaged app copies
  // it into resources so the main process can load the JS and adjacent WASM.
  {
    const kvStore = new KeyvaultStore(
      path.join(app.getPath("userData"), "keyvault"),
    );
    const _require = createRequire(import.meta.url);
    const wasmPath = app.isPackaged
      ? join(process.resourcesPath, "ckb-keyvault-wasm", "ckb_keyvault_wasm.js")
      : join(__dirname, "../../../../packages/ckb-keyvault-wasm/pkg/ckb_keyvault_wasm.js");
    const keyvaultWasm = _require(wasmPath) as Parameters<typeof registerKeyvaultHost>[0]["wasm"];
    registerKeyvaultHost({ store: kvStore, wasm: keyvaultWasm });
  }

  // invoice-files handlers
  registerInvoiceFilesIpc();

  // pair-server handlers
  ipcMain.handle("pair:list", async () => listDevices());
  ipcMain.handle("pair:revoke", async (_e, tokenId: string) => revokeDevice(tokenId));
  ipcMain.handle("pair:issue", async (_e, deviceLabel: string) => {
    const root = await loadOrCreateRootKeypair();
    const expiresAt = new Date(Date.now() + PAIR_TOKEN_LIFETIME_MS).toISOString();
    const token = issueCaptureV1Token({ root, deviceLabel, expiresAtRfc3339: expiresAt });
    await addDevice({
      tokenId: token.tokenId,
      deviceLabel,
      commPubkey: "0x" + "00".repeat(32),
      capabilities: ['write("invoices")'],
      issuedAt: Date.now(),
      expiresAt: Date.parse(expiresAt),
    });
    return token;
  });
  ipcMain.handle(
    "pair:setCommPubkey",
    async (_e, tokenId: string, commPubkey: string): Promise<void> => {
      const devices = await listDevices();
      const d = devices.find((x) => x.tokenId === tokenId);
      if (d) await addDevice({ ...d, commPubkey });
    },
  );
  ipcMain.handle("pair:info", async () => serverInfoCache);
  // Partial-failure recovery: if rotateTlsCert succeeds but restartWithCert
  // throws (port conflict, OS error), the new cert is persisted on disk but
  // the server is down. The handler surfaces this to the renderer via
  // {ok: false, reason}; the user can quit + restart the desktop, after
  // which bootPairServer's loadOrCreateTlsCert reads the rotated cert and
  // the server comes back on the same port cleanly.
  ipcMain.handle("pair:rotateCert", async () => {
    try {
      const newCert = await rotateTlsCert();
      const started = await restartWithCert({ key: newCert.key, cert: newCert.cert });
      serverInfoCache = { certFingerprint: started.certFingerprint, port: started.port };
      return { ok: true as const, fingerprint: started.certFingerprint, port: started.port };
    } catch (e: unknown) {
      return { ok: false as const, reason: e instanceof Error ? e.message : "rotate failed" };
    }
  });

  // Fire-and-forget pair-server boot. Renderer should not block on the HTTPS
  // listener coming up; the renderer can read window.chainpay.pair.info()
  // when it needs the cert fingerprint for QR pairing.
  if (mainWindow) {
    void bootPairServer(mainWindow.webContents).catch((err: unknown) => {
      console.error("[pair-server] boot failed:", err);
    });
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

let quitting = false;
app.on("will-quit", (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  Promise.allSettled([stopPairServer(), rendererServer?.close()]).finally(() => app.quit());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
