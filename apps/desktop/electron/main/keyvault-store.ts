import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Regex for valid keyvault identifiers.
 * Restricted to lowercase alphanumeric + hyphen, 1–64 chars, to prevent
 * path traversal attacks (no dots, slashes, uppercase, or empty strings).
 */
const ID_RE = /^[a-z0-9-]{1,64}$/;

/**
 * Persists encrypted vault blobs as `<dir>/<id>.vault` files.
 * The `id` must match `^[a-z0-9-]{1,64}$` — any other value throws, which
 * blocks path traversal before a filesystem call is ever made.
 * Files are written with mode 0o600 (owner read/write only).
 */
export class KeyvaultStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private vaultPath(id: string): string {
    if (!ID_RE.test(id)) throw new Error(`invalid keyvault id: ${id}`);
    return join(this.dir, `${id}.vault`);
  }

  has(id: string): boolean {
    return existsSync(this.vaultPath(id));
  }

  read(id: string): Buffer {
    return readFileSync(this.vaultPath(id));
  }

  create(id: string, blob: Buffer): void {
    writeFileSync(this.vaultPath(id), blob, { flag: "wx", mode: 0o600 });
  }

  write(id: string, blob: Buffer): void {
    writeFileSync(this.vaultPath(id), blob, { mode: 0o600 });
  }

  delete(id: string): void {
    if (this.has(id)) unlinkSync(this.vaultPath(id));
  }

  list(): string[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".vault"))
      .map((f) => f.slice(0, -6));
  }
}
