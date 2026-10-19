import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface StorageAdapter {
  put(buffer: Buffer, extension: string): Promise<string>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

/**
 * Dev-only local-disk storage. Real functionality (actually reads/writes files),
 * not a mock — just not cloud storage. Swap for an S3-compatible adapter
 * (Vercel Blob / R2 / S3) before any production deployment. See
 * docs/PROVIDER_INTEGRATIONS.md and docs/KNOWN_LIMITATIONS.md.
 */
export class LocalDiskStorageAdapter implements StorageAdapter {
  constructor(private readonly rootDir: string = join(process.cwd(), ".uploads")) {}

  async put(buffer: Buffer, extension: string): Promise<string> {
    await mkdir(this.rootDir, { recursive: true });
    const key = `${randomUUID()}.${extension.replace(/^\./, "")}`;
    // turbopackIgnore: rootDir is a dev-only local path (see class doc comment), not a
    // production asset — without this, Turbopack traces and bundles the whole project.
    await writeFile(join(/* turbopackIgnore: true */ this.rootDir, key), buffer);
    return key;
  }

  async get(key: string): Promise<Buffer> {
    return readFile(join(/* turbopackIgnore: true */ this.rootDir, key));
  }

  async delete(key: string): Promise<void> {
    await unlink(join(/* turbopackIgnore: true */ this.rootDir, key)).catch(() => {});
  }
}

export function getStorageAdapter(): StorageAdapter {
  return new LocalDiskStorageAdapter();
}
