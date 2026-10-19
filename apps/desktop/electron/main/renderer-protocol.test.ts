import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rendererPortForProfile, resolveRendererFile, startRendererServer } from "./renderer-protocol";

const root = "/app/renderer";
const origin = "http://127.0.0.1:8234";

it("keeps the renderer origin stable for each user-data profile", () => {
  const first = rendererPortForProfile("/profiles/one");
  expect(first).toBe(rendererPortForProfile("/profiles/one"));
  expect(first).toBeGreaterThanOrEqual(20000);
  expect(first).toBeLessThan(50000);
  expect(first).not.toBe(rendererPortForProfile("/profiles/two"));
});

describe("resolveRendererFile", () => {
  it("serves the app shell for root and client-side routes", () => {
    expect(resolveRendererFile(root, `${origin}/`, origin)).toBe("/app/renderer/index.html");
    expect(resolveRendererFile(root, `${origin}/payroll/batches`, origin)).toBe("/app/renderer/index.html");
  });

  it("serves only assets inside the renderer output", () => {
    expect(resolveRendererFile(root, `${origin}/assets/main.js`, origin)).toBe("/app/renderer/assets/main.js");
    expect(resolveRendererFile(root, "http://localhost:8234/assets/main.js", origin)).toBeNull();
    expect(resolveRendererFile(root, `${origin}/assets/%2e%2e/%2e%2e/secret`, origin)).toBeNull();
  });
});

it("serves the built page and assets with isolation headers from loopback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chainpay-renderer-"));
  await mkdir(join(dir, "assets"));
  await writeFile(join(dir, "index.html"), "<title>ChainPay test</title>");
  await writeFile(join(dir, "assets", "app.js"), "export const ready = true;");
  const server = await startRendererServer(dir);
  try {
    const page = await fetch(`${server.origin}/payroll/batches`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("ChainPay test");
    expect(page.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(page.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    expect(page.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    const asset = await fetch(`${server.origin}/assets/app.js`);
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(await asset.text()).toContain("ready = true");
    const migration = await fetch(`${server.origin}/__storage_migration__`);
    expect(migration.status).toBe(200);
    expect(await migration.text()).toBe("<!doctype html><title>ChainPay storage migration</title>");
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
