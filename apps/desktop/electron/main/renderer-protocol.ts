import { resolve, sep } from "node:path";
import { extname } from "node:path";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/** IndexedDB/OPFS origin must stay constant across restarts of this profile. */
export function rendererPortForProfile(userDataPath: string): number {
  const hash = createHash("sha256").update(userDataPath).digest();
  return 20_000 + (hash.readUInt32BE(0) % 30_000);
}

/** Map only this loopback origin's bundled assets and SPA routes into the app bundle. */
export function resolveRendererFile(root: string, requestUrl: string, expectedOrigin: string): string | null {
  if (/\/\.\.(?:\/|$)|%2e|%2f|%5c/i.test(requestUrl)) return null;
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.origin !== expectedOrigin || url.username || url.password) return null;
  const base = resolve(root);
  if (!url.pathname.startsWith("/assets/")) return resolve(base, "index.html");
  const file = resolve(base, `.${url.pathname}`);
  return file.startsWith(`${base}${sep}`) ? file : null;
}

async function serveRendererRequest(
  request: IncomingMessage,
  response: ServerResponse,
  root: string,
  origin: string,
  csp: string,
): Promise<void> {
  let url: string;
  try {
    url = new URL(request.url ?? "/", origin).toString();
  } catch {
    response.writeHead(404).end();
    return;
  }
  const file = resolveRendererFile(root, url, origin);
  if (request.headers.host !== new URL(origin).host || !file || !["GET", "HEAD"].includes(request.method ?? "")) {
    response.writeHead(404).end();
    return;
  }
  try {
    const migrationPage = new URL(url).pathname === "/__storage_migration__";
    const body = migrationPage
      ? Buffer.from("<!doctype html><title>ChainPay storage migration</title>")
      : await readFile(file);
    response.writeHead(200, {
      "Content-Type": migrationPage ? MIME[".html"] : MIME[extname(file)] ?? "application/octet-stream",
      "Content-Security-Policy": csp,
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch {
    response.writeHead(404).end();
  }
}

export async function startRendererServer(root: string, csp = "default-src 'self'", port = 0) {
  let origin = "";
  const server = createServer((request, response) => {
    void serveRendererRequest(request, response, root, origin, csp);
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    close: () => new Promise<void>((resolveClose, reject) => {
      server.close((error) => error ? reject(error) : resolveClose());
    }),
  };
}
