import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyvaultStore } from "./keyvault-store";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kv-"));
});

describe("KeyvaultStore", () => {
  it("round-trips a blob", () => {
    const s = new KeyvaultStore(dir);
    expect(s.has("main")).toBe(false);
    s.write("main", Buffer.from([1, 2, 3]));
    expect(s.has("main")).toBe(true);
    expect([...s.read("main")]).toEqual([1, 2, 3]);
  });

  it("creates a vault exclusively so a second process cannot replace it", () => {
    const s = new KeyvaultStore(dir);
    s.create("main", Buffer.from([1, 2, 3]));
    expect(() => s.create("main", Buffer.from([9, 9, 9]))).toThrow();
    expect([...s.read("main")]).toEqual([1, 2, 3]);
  });

  it("rejects path-traversal ids", () => {
    const s = new KeyvaultStore(dir);
    expect(() => s.write("../evil", Buffer.from([0]))).toThrow();
  });

  it("rejects ids with uppercase letters", () => {
    const s = new KeyvaultStore(dir);
    expect(() => s.has("Main")).toThrow(/invalid keyvault id/);
    expect(() => s.write("UPPER", Buffer.from([0]))).toThrow(/invalid keyvault id/);
  });

  it("rejects ids containing a forward slash", () => {
    const s = new KeyvaultStore(dir);
    expect(() => s.has("a/b")).toThrow(/invalid keyvault id/);
  });

  it("rejects ids containing only dots", () => {
    const s = new KeyvaultStore(dir);
    expect(() => s.has("..")).toThrow(/invalid keyvault id/);
  });

  it("rejects empty ids", () => {
    const s = new KeyvaultStore(dir);
    expect(() => s.has("")).toThrow(/invalid keyvault id/);
  });

  it("rejects ids longer than 64 characters", () => {
    const s = new KeyvaultStore(dir);
    expect(() => s.has("a".repeat(65))).toThrow(/invalid keyvault id/);
  });

  it("writes the vault file with mode 0o600", () => {
    const s = new KeyvaultStore(dir);
    s.write("main", Buffer.from([0xde, 0xad]));
    const stat = statSync(join(dir, "main.vault"));
    // On Linux, stat.mode includes file type bits; mask to permission bits only.
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("delete removes the file", () => {
    const s = new KeyvaultStore(dir);
    s.write("main", Buffer.from([7]));
    expect(s.has("main")).toBe(true);
    s.delete("main");
    expect(s.has("main")).toBe(false);
  });

  it("delete on non-existent id is a no-op", () => {
    const s = new KeyvaultStore(dir);
    expect(() => s.delete("missing")).not.toThrow();
  });

  it("list returns vault ids", () => {
    const s = new KeyvaultStore(dir);
    s.write("alpha", Buffer.from([1]));
    s.write("beta", Buffer.from([2]));
    expect(s.list().sort()).toEqual(["alpha", "beta"]);
  });

  it("list returns empty array when no vaults exist", () => {
    const s = new KeyvaultStore(dir);
    expect(s.list()).toEqual([]);
  });
});
